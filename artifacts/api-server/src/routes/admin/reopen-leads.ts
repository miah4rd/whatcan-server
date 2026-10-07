/**
 * Puts named cards back into TAKEN TO WORK.
 *
 * Exists because an automatic close is easy to get wrong in a way a person sees
 * instantly and a rule does not: "still in progress" (two units of a
 * development still being built, said by the owner himself) and "disewakan
 * daily dan monthly" (monthly IS our format) were both read as "not a format we
 * can list" and closed. Reversing that has to be one call, not eight.
 */
import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../../lib/logger";
import { getAmoLead, updateLeadStatus } from "../../lib/amo-client";
import { safeStageIdForLead } from "../../lib/stage-classifier";

const router = Router();
const BACK_TO = "TAKEN TO WORK";

router.post("/admin/reopen-leads", async (req, res) => {
  // ?to=<stage name> for funnels without TAKEN TO WORK (Rental: "New LEAD").
  const backTo = String(req.query["to"] ?? "").trim() || BACK_TO;
  const ids = String(req.query["leads"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    res.status(400).json({ error: "pass ?leads=id,id,id" });
    return;
  }

  const done: Array<Record<string, unknown>> = [];
  for (const leadId of ids) {
    const lead = await getAmoLead(leadId);
    if (!lead?.pipeline_id) {
      done.push({ lead: leadId, ok: false, why: "amoCRM did not return the lead" });
      continue;
    }
    const { id } = await safeStageIdForLead({
      pipelineId: lead.pipeline_id,
      stageId: null,
      stageName: backTo,
    });
    if (!id) {
      done.push({ lead: leadId, ok: false, why: `no "${backTo}" in this funnel` });
      continue;
    }
    const ok = await updateLeadStatus(leadId, Number(id));
    if (ok) {
      await db.execute(
        sql`UPDATE leads_sync SET lead_stage = ${backTo}, lead_stage_id = ${id}, updated_at = now()
             WHERE lead_id = ${leadId}`,
      );
    }
    done.push({ lead: leadId, ok });
  }
  logger.info({ ids, reopened: done.filter((d) => d["ok"]).length }, "reopen-leads finished");
  res.json({ reopened: done.filter((d) => d["ok"]).length, cards: done });
});

export default router;
