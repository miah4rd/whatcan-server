/**
 * Sends back every acquisition card sitting on a stage it has not earned.
 *
 * A stage is a claim. "QUALIFIED (Pre-listed)" says bedrooms, a price with its
 * commission position, and the owner are all known — the broker reads it that
 * way and works the card accordingly. Cards reached it on the general
 * classifier's looser reading, which is now fixed at the source; this clears
 * what that left behind, on that stage alone.
 *
 * Back to TAKEN TO WORK on purpose, not to Closed: nothing is wrong with these
 * leads, we simply have not asked the remaining question yet. That stage is
 * before the autopilot handover, so the bot picks them up and asks.
 *
 * Dry by default (?apply=1 to move) — it moves cards in the owner's live CRM.
 */
import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../../lib/logger";
import { getAmoLead, updateLeadStatus } from "../../lib/amo-client";
import { safeStageIdForLead } from "../../lib/stage-classifier";
import { qualificationVerdictForLead } from "../../lib/listing-card-fields";

const router = Router();

/**
 * QUALIFIED only, and deliberately nothing beyond it.
 *
 * Details and agreement are past the autopilot handover, which means a person
 * is already working those cards — the owner's instruction: "не трогай всё что
 * дальше qualified, там уже человек работает". Pulling a card out from under a
 * broker mid-conversation is worse than a stage label that overstates what we
 * know. The classifier fix stops new cards landing there unearned; what is
 * already there stays the broker's.
 */
// A single value, compared with `=`. Passing a JS array to `= ANY(...)` makes
// drizzle inline it as a bare parameter Postgres rejects — the same 500 this
// project has already produced once, on the inbox query.
const CLAIMING_STAGE = "qualified (pre-listed)";
const BACK_TO = "TAKEN TO WORK";

router.post("/admin/demote-unqualified", async (req, res) => {
  const apply = String(req.query["apply"] ?? "") === "1";

  const rows = await db.execute(sql`
    SELECT lead_id, lead_stage FROM leads_sync
     WHERE pipeline = 'Rental Listings'
       AND lower(coalesce(lead_stage,'')) = ${CLAIMING_STAGE}
       AND bot_excluded IS NOT TRUE
  `);
  const cards = (rows.rows ?? []) as unknown as Array<{ lead_id: string; lead_stage: string }>;

  const checked: Array<Record<string, unknown>> = [];
  let moved = 0;
  for (const c of cards) {
    const verdict = await qualificationVerdictForLead(c.lead_id);
    // No conversation to judge means no grounds to demote — leave it alone.
    if (!verdict || verdict.ok) continue;

    let didMove = false;
    if (apply) {
      const lead = await getAmoLead(c.lead_id);
      if (lead?.pipeline_id) {
        const { id } = await safeStageIdForLead({
          pipelineId: lead.pipeline_id,
          stageId: null,
          stageName: BACK_TO,
        });
        if (id && String(lead.status_id ?? "") !== id) {
          didMove = await updateLeadStatus(c.lead_id, Number(id));
          if (didMove) {
            moved++;
            await db.execute(
              sql`UPDATE leads_sync SET lead_stage = ${BACK_TO}, lead_stage_id = ${id}, updated_at = now()
                   WHERE lead_id = ${c.lead_id}`,
            );
          }
        }
      }
    }
    checked.push({ lead: c.lead_id, from: c.lead_stage, missing: verdict.missing, moved: didMove });
  }

  logger.info({ scanned: cards.length, failing: checked.length, moved, apply }, "demote-unqualified finished");
  res.json({ dry: !apply, scanned: cards.length, failing: checked.length, moved, cards: checked });
});

export default router;
