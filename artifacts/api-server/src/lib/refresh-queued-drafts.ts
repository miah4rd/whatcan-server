/**
 * After a broker's send teaches a new preference, their other waiting drafts at the same stage of
 * the same funnel are written again with it (owner, 27.09.2026: "I fix the message in one card, open
 * the next one in the queue and it is still the old version — a broker will just approve it as is").
 *
 * Only LIVE drafts the broker has not touched (no original_text kept, i.e. never edited) are
 * rewritten, at most 15, one at a time. The generator is the same one that wrote them, so the new
 * lesson (already stored) is simply in its prompt now.
 */
import { pool } from "@workspace/db";
import { chatCompletion, WRITER_MODEL } from "./ai-client";
import { sanitizeSuggestion } from "./sanitize-suggestion";
import { logger } from "./logger";

export async function refreshQueuedDrafts(opts: { broker: string; pipeline: string | null; leadStage: string | null; exceptId: string }): Promise<number> {
  if (!opts.pipeline || !opts.leadStage) return 0;
  await pool.query(`ALTER TABLE pending_suggestions ADD COLUMN IF NOT EXISTS original_text text`).catch(() => undefined);
  await pool.query(`ALTER TABLE pending_suggestions ADD COLUMN IF NOT EXISTS sent_stage text`).catch(() => undefined);
  const rows = (
    await pool.query(
      `SELECT p.id::text AS id, p.lead_id, l.content, l.lead_notes, l.lead_stage, l.pipeline, l.responsible_user
         FROM pending_suggestions p JOIN leads_sync l ON l.lead_id = p.lead_id
        WHERE p.status = 'pending' AND p.kind = 'live' AND p.original_text IS NULL AND p.id::text <> $1
          AND lower(coalesce(l.responsible_user, '')) = lower($2)
          AND lower(coalesce(l.pipeline, '')) = lower($3) AND coalesce(l.lead_stage, '') = $4
        ORDER BY p.created_at DESC LIMIT 15`,
      [opts.exceptId, opts.broker, opts.pipeline, opts.leadStage],
    )
  ).rows;
  // The template: what the broker last sent at this stage (owner, 27.09: "the structure I kept — the same
  // questions — must be in the other drafts; only the villa changes").
  const tpl = (
    await pool.query(
      `SELECT coalesce(nullif(p.final_text, ''), p.suggestion_text) AS text
         FROM pending_suggestions p JOIN leads_sync l ON l.lead_id = p.lead_id
        WHERE p.status IN ('approved', 'edited') AND coalesce(p.auto_sent, false) = false
          AND lower(coalesce(p.responsible_user, '')) = lower($1)
          AND lower(coalesce(l.pipeline, '')) = lower($2) AND coalesce(p.sent_stage, l.lead_stage, '') = $3
        ORDER BY p.created_at DESC LIMIT 1`,
      [opts.broker, opts.pipeline, opts.leadStage],
    )
  ).rows[0]?.text as string | undefined;
  if (!tpl) return 0;
  let done = 0;
  for (const r of rows) {
    try {
      const card = (await pool.query(`SELECT name FROM os_crm_leads WHERE id::text = $1`, [r.lead_id]).catch(() => ({ rows: [] as Array<{ name?: string }> }))).rows[0]?.name;
      const facts = [card ? `Card: ${card}` : null, r.lead_notes ? `Notes: ${String(r.lead_notes).slice(0, 800)}` : null, r.content ? `Conversation:\n${String(r.content).slice(-1200)}` : null]
        .filter(Boolean)
        .join("\n\n");
      const out = await chatCompletion({
        model: WRITER_MODEL,
        label: "queue-from-template",
        system: `You adapt a WhatsApp message a broker just sent to one villa owner, for another villa owner at the same step.
Keep EVERYTHING of the template: every sentence's purpose, every question and its order, the greeting, the self-introduction, the sign-off, the tone, the line breaks and the length.
Change ONLY the facts about the villa (its name, area, bedrooms, price) to this card's facts. If this card lacks a fact the template mentions, leave that detail out rather than invent it.
Output only the message.`,
        messages: [{ role: "user", content: `TEMPLATE (what the broker sent):\n${tpl}\n\nTHIS VILLA:\n${facts}` }],
        max_tokens: 500,
      });
      const text = sanitizeSuggestion(out.content ?? "");
      if (!text.trim()) continue;
      const u = await pool.query(
        `UPDATE pending_suggestions SET suggestion_text = $2 WHERE id::text = $1 AND status = 'pending' AND original_text IS NULL`,
        [r.id, text],
      );
      done += u.rowCount ?? 0;
    } catch (err) {
      logger.warn({ err, leadId: r.lead_id }, "refresh queued drafts: one draft failed (left as it was)");
    }
  }
  logger.info({ broker: opts.broker, pipeline: opts.pipeline, stage: opts.leadStage, rewritten: done, of: rows.length }, "queued drafts rewritten with the new lesson");
  return done;
}
