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
import { generateSuggestion } from "./generate-suggestion";
import { logger } from "./logger";

export async function refreshQueuedDrafts(opts: { broker: string; pipeline: string | null; leadStage: string | null; exceptId: string }): Promise<number> {
  if (!opts.pipeline || !opts.leadStage) return 0;
  await pool.query(`ALTER TABLE pending_suggestions ADD COLUMN IF NOT EXISTS original_text text`).catch(() => undefined);
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
  let done = 0;
  for (const r of rows) {
    try {
      const last = (
        await pool.query(`SELECT text FROM lead_messages WHERE lead_id = $1 AND sender_type = 'lead' AND coalesce(text,'') <> '' ORDER BY sent_at DESC LIMIT 1`, [r.lead_id])
      ).rows[0]?.text as string | undefined;
      if (!last) continue;
      const { text } = await generateSuggestion({
        leadId: String(r.lead_id),
        responsibleUser: r.responsible_user,
        kind: "live",
        lastLeadMessage: last,
        contentSnippet: String(r.content ?? ""),
        leadNotes: r.lead_notes,
        leadStage: r.lead_stage,
        pipeline: r.pipeline,
      });
      if (!text?.trim()) continue;
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
