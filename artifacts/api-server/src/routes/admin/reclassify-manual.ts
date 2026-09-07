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
import { classifyAndApplyStage } from "../../lib/stage-on-reply";
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
  const outcomes = apply ? await processViewingOutcomes() : null;
  logger.info({ scanned: ids.length, changes: out.length, apply }, "reclassify-manual finished");
  res.json({ dry: !apply, scanned: ids.length, changes: out, viewingOutcomes: outcomes });
});

export default router;
