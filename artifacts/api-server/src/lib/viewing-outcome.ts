/**
 * What happened after the viewing?
 *
 * Every viewing slot agreed in a thread is a row in viewing_slots — written by
 * the stage sync for any message (the bot's, the client's, the broker's own
 * phone), by the broker's explicit stage pick, and by a "rescheduled" report.
 * Half an hour after a slot:
 *   - the report goes due (task, push, the placeholder card that carries the
 *     form) — on the client's OPEN card even when the slot was agreed in a
 *     closed card's thread (see ensureSlotReport);
 *   - nothing else: the stage moves when the broker files that form, not
 *     because time passed or because the thread sounds like it happened.
 *
 * Until 14.09 this pass selected cards on "Viewing scheduled" by
 * leads_sync.viewing_at: one slot per card, and only when the stage had been
 * set. A second viewing overwrote the first, a viewing agreed from the phone
 * never had a slot, a viewing held on a closed duplicate card was invisible —
 * 2 of 5 held viewings got a report in the week of 07.09.
 */
import { db, viewingSlotsTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { ensureSlotReport } from "./viewing-report";

export { VIEWING_FOLLOWUP_VERDICT } from "./viewing-report";
/** The form goes out half an hour after the slot, with a push — owner,
 *  16.09.2026: "анкету можно подгружать сразу, не ждать 3 часа, через 30 мин
 *  с уведомлением обязательно". The stage waits for that form, so the wait
 *  before asking for it is the wait before the card can move. */
const GRACE_MINUTES = 30;

export async function processViewingOutcomes(): Promise<{ reported: number; moved: number }> {
  let reported = 0;
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
          sql`${viewingSlotsTable.viewingAt} + make_interval(mins => ${GRACE_MINUTES}) <= now()`,
          sql`${viewingSlotsTable.viewingAt} > now() - interval '14 days'`,
        ),
      )
      .orderBy(viewingSlotsTable.viewingAt)
      .limit(20);

    for (const slot of due) {
      try {
        const r = await ensureSlotReport(slot.leadId, slot.viewingAt, slot.propertyCode, "viewing-outcome");
        if (r.created) reported++;

        // The stage is NOT set here. "Viewing done" means the broker held the
        // viewing and took the feedback, and the form is where they hand that
        // in — so the filed report moves the card (viewing-report.ts) and an
        // unfilled form leaves it honestly on "Viewing scheduled". Until
        // 16.09.2026 this pass read the thread instead: a viewing both sides
        // went quiet about never moved, and a second slot whose time did not
        // match leads_sync.viewing_at moved nothing at all.
      } catch (err) {
        logger.error({ err, leadId: slot.leadId, viewingAt: slot.viewingAt }, "viewing outcome: failed for this slot");
      }
    }
  } catch (err) {
    logger.error({ err }, "viewing outcome pass failed");
  }
  if (reported > 0) logger.info({ reported }, "viewing outcome pass complete");
  // `moved` stays in the shape for the admin endpoints that read it; the pass
  // no longer moves anything by itself.
  return { reported, moved: 0 };
}
