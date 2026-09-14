/**
 * Re-reads recent cards through the ONE stage decision (lib/thread-stage-sync.ts)
 * — the audit and repair tool for the funnel.
 *
 *   POST /api/admin/reclassify-manual?pipeline=rental&days=14          dry: every decision, nothing written
 *   POST /api/admin/reclassify-manual?...&apply=1&forward=1            applies FORWARD moves only
 *   POST /api/admin/reclassify-manual?...&apply=1&forward=1&slots=1    also records the viewing slots found
 *   POST /api/admin/reclassify-manual?lead=<id>                        one card
 *
 * Dry by default: it moves cards in the owner's live CRM, and amoCRM runs its
 * own automations on a status change. A bulk run should apply forward moves
 * only; backward, new-cycle and closing verdicts are printed so a person reads
 * the thread first (no demotion without reading the conversation).
 */
import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../../lib/logger";
import { syncStageFromThread } from "../../lib/thread-stage-sync";
import { processViewingOutcomes } from "../../lib/viewing-outcome";

const router = Router();

router.post("/admin/reclassify-manual", async (req, res) => {
  const apply = String(req.query["apply"] ?? "") === "1";
  const forwardOnly = String(req.query["forward"] ?? "") === "1";
  const recordSlots = String(req.query["slots"] ?? "") === "1";
  const days = Math.min(Number(req.query["days"]) || 14, 60);
  const pipeline = String(req.query["pipeline"] ?? "rental").trim().toLowerCase();
  const single = String(req.query["lead"] ?? "").trim();

  let ids: string[];
  if (/^\d+$/.test(single)) {
    ids = [single];
  } else {
    const rows = await db.execute(sql`
      SELECT DISTINCT l.lead_id
        FROM leads_sync l
        JOIN lead_messages m ON m.lead_id = l.lead_id
       WHERE lower(l.pipeline) = ${pipeline}
         AND m.sent_at > now() - make_interval(days => ${days})
         AND lower(coalesce(l.lead_stage,'')) NOT LIKE '%lost%'
         AND lower(coalesce(l.lead_stage,'')) NOT LIKE '%closed%'
         AND lower(coalesce(l.lead_stage,'')) NOT LIKE '%won%'
         AND l.bot_excluded IS NOT TRUE
    `);
    ids = ((rows.rows ?? []) as Array<{ lead_id: string }>).map((r) => r.lead_id);
  }

  const decisions: Array<Record<string, unknown>> = [];
  for (const leadId of ids) {
    try {
      const r = await syncStageFromThread(leadId, { sources: ["backfill"], apply, forwardOnly, recordSlots: apply && recordSlots });
      decisions.push({
        lead: leadId,
        from: r.from,
        to: r.to,
        action: r.action,
        direction: r.direction,
        moved: r.moved,
        applied: r.applied,
        reason: r.reason,
        viewingAt: r.viewingAt ?? null,
        slot: r.slot,
      });
    } catch (err) {
      logger.warn({ err, leadId }, "reclassify-manual: lead failed");
      decisions.push({ lead: leadId, error: String(err).slice(0, 200) });
    }
  }
  const outcomes = apply && recordSlots ? await processViewingOutcomes() : null;
  logger.info({ scanned: ids.length, apply, forwardOnly, moved: decisions.filter((d) => d["moved"]).length }, "reclassify-manual finished");
  res.json({ dry: !apply, forwardOnly, scanned: ids.length, decisions, viewingOutcomes: outcomes });
});

export default router;
