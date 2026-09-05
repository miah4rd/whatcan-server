/**
 * The dated availability check on a "long term" card.
 *
 * A villa let for six or twelve months is parked, not lost — and the whole
 * value of parking it is being FIRST when it frees up. The parking used to
 * leave only an amoCRM task fourteen days before the date; the broker saw a
 * task and an empty Copilot, and wrote the message himself or not at all. The
 * owner's rule (2026-09-05): about two weeks before the date, an update on
 * availability, as a ready draft.
 *
 * No AI: the question is the same every time. It carries whatever the card is
 * still missing (price with our commission, bedrooms), so a "yes, still free"
 * can arrive with the facts that let it go straight to Details.
 *
 * One draft per free date. The stamp on the draft is both what makes the inbox
 * show it on a suppressed stage and this pass's memory that it was written.
 */
import { db, leadsSyncTable, pendingSuggestionsTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { villaFromLeadName, fetchLeadTitle, fetchOwnerName } from "./weekly-availability-check";
import { qualificationVerdictForLead } from "./listing-card-fields";

export const AVAILABILITY_CHECK_VERDICT = "availability check due";
const LEAD_DAYS = 14;
const BATCH_LIMIT = 10;

export function composeAvailabilityCheck(owner: string, villa: string, freeFrom: Date, missing: string[]): string {
  const who = owner ? ` ${owner}` : "";
  const what = villa || "the villa";
  const when = freeFrom.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "Asia/Makassar" });
  const asks: string[] = [];
  if (missing.includes("bedrooms")) asks.push("how many bedrooms it has");
  if (missing.includes("price")) asks.push("the monthly and yearly rate including our 10% agency commission");
  else if (missing.includes("commission position")) asks.push("whether that rate already includes our 10% agency commission");
  const tail =
    asks.length === 0
      ? `If so, could you send a few photos and the exact location, so we can have it ready to list the day it frees up?`
      : `If so, could you send ${asks.length === 1 ? asks[0] : `${asks.slice(0, -1).join(", ")} and ${asks[asks.length - 1]}`}, plus a few photos, so we can have it ready to list the day it frees up?`;
  return `Hi${who}, when we spoke you mentioned ${what} would be free from around ${when}. Is that still the plan? ${tail}`;
}

export async function processLongTermAvailabilityChecks(): Promise<number> {
  let queued = 0;
  try {
    const due = await db
      .select({
        leadId: leadsSyncTable.leadId,
        responsibleUser: leadsSyncTable.responsibleUser,
        freeFrom: leadsSyncTable.listingFreeFrom,
      })
      .from(leadsSyncTable)
      .where(
        and(
          sql`lower(${leadsSyncTable.pipeline}) = 'rental listings'`,
          sql`lower(coalesce(${leadsSyncTable.leadStage},'')) LIKE '%long term%'`,
          sql`${leadsSyncTable.botExcluded} IS NOT TRUE`,
          sql`${leadsSyncTable.listingFreeFrom} IS NOT NULL`,
          sql`${leadsSyncTable.listingFreeFrom} - make_interval(days => ${LEAD_DAYS}) <= now()`,
          // Not already written for this date, and nothing else pending.
          sql`NOT EXISTS (SELECT 1 FROM pending_suggestions p WHERE p.lead_id = ${leadsSyncTable.leadId}
                 AND (p.status = 'pending'
                      OR (p.autopilot_skipped_reason = ${AVAILABILITY_CHECK_VERDICT}
                          AND p.autopilot_skipped_at >= ${leadsSyncTable.listingFreeFrom} - make_interval(days => ${LEAD_DAYS + 1}))))`,
        ),
      )
      .limit(BATCH_LIMIT);

    for (const lead of due) {
      try {
        const title = await fetchLeadTitle(lead.leadId);
        const villa = villaFromLeadName(title);
        const owner = await fetchOwnerName(lead.leadId, villa);
        const missing = (await qualificationVerdictForLead(lead.leadId))?.missing ?? [];
        const text = composeAvailabilityCheck(owner, villa, lead.freeFrom!, missing);
        await db.insert(pendingSuggestionsTable).values({
          leadId: lead.leadId,
          responsibleUser: lead.responsibleUser,
          kind: "push",
          suggestionText: text,
          status: "pending",
          autopilotSkippedReason: AVAILABILITY_CHECK_VERDICT,
          autopilotSkippedAt: new Date(),
        });
        queued++;
        logger.info({ leadId: lead.leadId, villa, freeFrom: lead.freeFrom }, "long-term check: availability draft written for the broker");
      } catch (err) {
        logger.error({ err, leadId: lead.leadId }, "long-term check: failed for this card");
      }
    }
  } catch (err) {
    logger.error({ err }, "long-term check pass failed");
  }
  if (queued > 0) logger.info({ queued }, "long-term check pass complete");
  return queued;
}
