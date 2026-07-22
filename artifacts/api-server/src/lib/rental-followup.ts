/**
 * Shared Rental-pipeline follow-up automation — stage IDs, cadence, and the
 * "advance to the next touch" action. Used by both approve.ts (bot sends a
 * touch) and amocrm-webhook.ts (broker replies directly via WhatsApp,
 * bypassing the extension) — either way counts as "this touch is done".
 */
import { closeAmoTasksForLead, createAmoTask, updateLeadStatus } from "./amo-client";
import { nextFollowupDate } from "./dialog-parser";
import { logger } from "./logger";

// amoCRM status IDs for the Rental pipeline (PIPELINE 11119150).
export const FOLLOWUP_STAGE_ADVANCE_RENTAL: Record<number, number> = {
  87301078: 87318450, // New LEAD -> 1 foolow up
  87318450: 87318706, // 1 foolow up -> 2 foolow up
  87318706: 87318710, // 2 foolow up -> 3 foolow up
  // 3 foolow up (87318710) is the final step in the qualification track —
  // no further auto-advance from here.
};

// Rental qualification touches are spaced 1 calendar day apart (vs Unicorn's 1/3/5).
export const FOLLOWUP_DELAY_DAYS_RENTAL = [1, 1, 1];

/** Map a Rental lead's current stage name to its touch-sequence level (0 = New LEAD / touch 0). */
export function rentalStageToFollowupLevel(stage: string | null | undefined): number {
  const s = (stage ?? "").toLowerCase();
  if (s.includes("3 foolow up") || s.includes("final")) return 3;
  if (s.includes("2 foolow up")) return 2;
  if (s.includes("1 foolow up")) return 1;
  return 0;
}

/**
 * Close the lead's open amoCRM task(s), advance the stage to the next touch
 * (if there is one), and create a task for that next touch. Does NOT handle
 * the "final touch + never replied -> close as Lost" case — that's specific
 * to the bot's own send flow (approve.ts), since this function is also used
 * when the broker DID reply, which is never a "give up" situation.
 */
export async function advanceRentalFollowup(
  leadId: string,
  currentStatusId: number,
  followupLevel: number,
  now: Date = new Date(),
): Promise<void> {
  try {
    await closeAmoTasksForLead(leadId);
  } catch (err) {
    logger.error({ err, leadId }, "advanceRentalFollowup: closeAmoTasksForLead failed");
  }

  const nextStatusId = FOLLOWUP_STAGE_ADVANCE_RENTAL[currentStatusId];
  if (nextStatusId) {
    try {
      await updateLeadStatus(leadId, nextStatusId);
    } catch (err) {
      logger.error({ err, leadId }, "advanceRentalFollowup: updateLeadStatus failed");
    }
  }

  const level = Math.max(0, followupLevel);
  const nextDate = nextFollowupDate(now, level, FOLLOWUP_DELAY_DAYS_RENTAL);
  if (nextDate) {
    try {
      await createAmoTask(leadId, `Follow-up #${level + 1} due.`, nextDate);
    } catch (err) {
      logger.error({ err, leadId }, "advanceRentalFollowup: createAmoTask failed");
    }
  }
}
