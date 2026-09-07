/**
 * Re-reads the stage of leads whose broker replied by hand recently.
 *
 * The classifier never ran on those replies before 2026-09-07, so viewings
 * confirmed from the phone left cards on "Options sent". Dry by default
 * (?apply=1 to move) — it changes stages in the owner's live CRM.
 */
import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../../lib/logger";
import { classifyAndApplyStage, extractViewingAt } from "../../lib/stage-on-reply";
import { processViewingOutcomes } from "../../lib/viewing-outcome";

const router = Router();

router.post("/admin/reclassify-manual", async (req, res) => {
  const apply = String(req.query["apply"] ?? "") === "1";
  const days = Math.min(Number(req.query["days"]) || 14, 60);
  const pipeline = String(req.query["pipeline"] ?? "rental").trim().toLowerCase();

  const rows = await db.execute(sql`
    SELECT DISTINCT l.lead_id
      FROM leads_sync l
      JOIN lead_messages m ON m.lead_id = l.lead_id
     WHERE lower(l.pipeline) = ${pipeline}
       AND m.sender_type = 'broker'
       AND m.sent_at > now() - make_interval(days => ${days})
       AND lower(coalesce(l.lead_stage,'')) NOT LIKE '%lost%'
       AND lower(coalesce(l.lead_stage,'')) NOT LIKE '%closed%'
       AND lower(coalesce(l.lead_stage,'')) NOT LIKE '%won%'
       AND l.bot_excluded IS NOT TRUE
  `);
  const ids = ((rows.rows ?? []) as Array<{ lead_id: string }>).map((r) => r.lead_id);

  const out: Array<Record<string, unknown>> = [];
  for (const leadId of ids) {
    try {
      const r = await classifyAndApplyStage(leadId, { source: "backfill", apply });
      if (r.to && (r.moved || !apply)) out.push({ lead: leadId, from: r.from ?? null, to: r.to, moved: r.moved, viewingAt: r.viewingAt ?? null, reason: r.reason });
    } catch (err) {
      logger.warn({ err, leadId }, "reclassify-manual: lead failed");
    }
  }
  // Cards already on "Viewing scheduled" from before viewing_at existed: read
  // the slot from the thread so the outcome pass can do its job.
  let datesFilled = 0;
  if (apply) {
    const missing = await db.execute(sql`
      SELECT lead_id FROM leads_sync
       WHERE lower(coalesce(lead_stage,'')) LIKE 'viewing scheduled%' AND viewing_at IS NULL AND bot_excluded IS NOT TRUE
    `);
    for (const r of (missing.rows ?? []) as Array<{ lead_id: string }>) {
      const rows = await db.execute(sql`
        SELECT to_char(sent_at AT TIME ZONE 'Asia/Makassar','DD/MM HH24:MI') AS at, sender_type AS who, text
          FROM lead_messages WHERE lead_id = ${r.lead_id} AND text IS NOT NULL ORDER BY sent_at DESC LIMIT 30
      `);
      const text = ((rows.rows ?? []) as Array<{ at: string; who: string; text: string }>)
        .reverse()
        .map((m) => `${m.at} ${m.who === "lead" ? "Client" : "Broker"}: ${(m.text ?? "").replace(/\s+/g, " ")}`)
        .join("\n");
      const when = await extractViewingAt(text);
      if (when) {
        await db.execute(sql`UPDATE leads_sync SET viewing_at = ${when} WHERE lead_id = ${r.lead_id}`);
        datesFilled++;
      }
    }
  }
  const outcomes = apply ? await processViewingOutcomes() : null;
  logger.info({ scanned: ids.length, changes: out.length, apply }, "reclassify-manual finished");
  res.json({ dry: !apply, scanned: ids.length, changes: out, viewingDatesFilled: datesFilled, viewingOutcomes: outcomes });
});

export default router;
