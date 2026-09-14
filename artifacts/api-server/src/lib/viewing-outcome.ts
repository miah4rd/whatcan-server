/**
 * What happened after the viewing?
 *
 * Every viewing slot agreed in a thread is a row in viewing_slots — written by
 * the stage sync for any message (the bot's, the client's, the broker's own
 * phone), by the broker's explicit stage pick, and by a "rescheduled" report.
 * Three hours after a slot:
 *   - the report goes due (task, push, the placeholder card that carries the
 *     form) — on the client's OPEN card even when the slot was agreed in a
 *     closed card's thread (see ensureSlotReport);
 *   - a card still sitting on "Viewing scheduled" for that slot is read once
 *     more: the thread may already say the viewing happened.
 *
 * Until 14.09 this pass selected cards on "Viewing scheduled" by
 * leads_sync.viewing_at: one slot per card, and only when the stage had been
 * set. A second viewing overwrote the first, a viewing agreed from the phone
 * never had a slot, a viewing held on a closed duplicate card was invisible —
 * 2 of 5 held viewings got a report in the week of 07.09.
 */
import { db, leadsSyncTable, leadMessagesTable, viewingSlotsTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { syncStageFromThread } from "./thread-stage-sync";
import { ensureSlotReport } from "./viewing-report";

export { VIEWING_FOLLOWUP_VERDICT } from "./viewing-report";
const GRACE_HOURS = 3;

export async function processViewingOutcomes(): Promise<{ reported: number; moved: number }> {
  let reported = 0;
  let moved = 0;
  try {
    // A slot a card holds but the table does not (written before 14.09, or by
    // a path that only set leads_sync) is still owed its report.
    await db.execute(sql`
      INSERT INTO viewing_slots (lead_id, viewing_at, source, status)
      SELECT lead_id, viewing_at, 'leads_sync', 'scheduled' FROM leads_sync
       WHERE viewing_at IS NOT NULL
         AND viewing_at > now() - interval '14 days'
         AND lower(coalesce(lead_stage, '')) ~ '^viewing (scheduled|done)'
      ON CONFLICT (lead_id, viewing_at) DO NOTHING`);

    const due = await db
      .select({ id: viewingSlotsTable.id, leadId: viewingSlotsTable.leadId, viewingAt: viewingSlotsTable.viewingAt, propertyCode: viewingSlotsTable.propertyCode })
      .from(viewingSlotsTable)
      .where(
        and(
          eq(viewingSlotsTable.status, "scheduled"),
          sql`${viewingSlotsTable.viewingAt} + make_interval(hours => ${GRACE_HOURS}) <= now()`,
          sql`${viewingSlotsTable.viewingAt} > now() - interval '14 days'`,
        ),
      )
      .orderBy(viewingSlotsTable.viewingAt)
      .limit(20);

    for (const slot of due) {
      try {
        const r = await ensureSlotReport(slot.leadId, slot.viewingAt, slot.propertyCode, "viewing-outcome");
        if (r.created) reported++;

        // The card still waiting on THIS slot: let the thread settle it.
        const [card] = await db
          .select({ leadStage: leadsSyncTable.leadStage, viewingAt: leadsSyncTable.viewingAt })
          .from(leadsSyncTable)
          .where(eq(leadsSyncTable.leadId, slot.leadId))
          .limit(1);
        const waiting =
          !!card &&
          /^viewing\s*scheduled/i.test(card.leadStage ?? "") &&
          !!card.viewingAt &&
          Math.abs(card.viewingAt.getTime() - slot.viewingAt.getTime()) < 60_000;
        if (!waiting) continue;
        const [after] = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(leadMessagesTable)
          .where(and(eq(leadMessagesTable.leadId, slot.leadId), sql`${leadMessagesTable.sentAt} > ${slot.viewingAt}`));
        if ((after?.n ?? 0) > 0) {
          const s = await syncStageFromThread(slot.leadId, { sources: ["viewing-outcome"] });
          if (s.moved) moved++;
        }
      } catch (err) {
        logger.error({ err, leadId: slot.leadId, viewingAt: slot.viewingAt }, "viewing outcome: failed for this slot");
      }
    }
  } catch (err) {
    logger.error({ err }, "viewing outcome pass failed");
  }
  if (reported + moved > 0) logger.info({ reported, moved }, "viewing outcome pass complete");
  return { reported, moved };
}
