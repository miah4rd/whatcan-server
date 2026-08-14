/**
 * Lifecycle of a broker's own promise to come back with information they
 * don't have yet (see lib/commitment-detector.ts for the detection side).
 *
 * Deliberately does NOT touch amoCRM at all — the owner does not use the CRM
 * UI, he works entirely through the bot (push + /m), so a task sitting in
 * amoCRM would never be seen. The reminder is a push notification only, fired
 * once when it comes due, deep-linking into the same lead the same way an
 * incoming-message push does.
 */
import { db, leadCommitmentsTable, type LeadCommitment } from "@workspace/db";
import { and, eq, isNull, lte } from "drizzle-orm";
import { detectCommitment, clampToBaliWakingHours } from "./commitment-detector";
import { notifyBrokerForLead } from "./push-notifications";
import { logger } from "./logger";

const DEFAULT_HOURS_UNTIL_DUE = 4;

/**
 * Called after every approved outgoing message. First closes any commitment
 * already open on this lead — this send IS the broker following up, whatever
 * it turned out to be about — then checks whether the NEW message opens a
 * fresh one. Fire-and-forget from the caller; never throws.
 */
export async function recordCommitment(
  leadId: string,
  responsibleUser: string | null | undefined,
  messageText: string,
): Promise<void> {
  try {
    await db
      .update(leadCommitmentsTable)
      .set({ status: "done", resolvedAt: new Date() })
      .where(and(eq(leadCommitmentsTable.leadId, leadId), eq(leadCommitmentsTable.status, "open")));

    const check = await detectCommitment(messageText);
    if (!check) return;

    const hours = check.hoursUntilDue ?? DEFAULT_HOURS_UNTIL_DUE;
    const dueAt = clampToBaliWakingHours(new Date(Date.now() + hours * 60 * 60 * 1000));

    await db.insert(leadCommitmentsTable).values({
      leadId,
      responsibleUser: responsibleUser ?? null,
      promiseText: check.promiseText,
      sourceExcerpt: messageText.slice(0, 300),
      dueAt,
    });

    logger.info({ leadId, promiseText: check.promiseText, dueAt }, "commitment scheduled");
  } catch (err) {
    logger.error({ err, leadId }, "recordCommitment failed (non-fatal)");
  }
}

/**
 * How long we keep retrying a reminder nobody was there to receive. Past this
 * the promise is stale enough that a fresh ping is noise; it still shows in
 * the broker's report until it is closed by an actual reply.
 */
const RETRY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Fires the reminder for every commitment whose due time has passed.
 *
 * `notifiedAt` is stamped ONLY when a device actually took the notification.
 * It used to be stamped unconditionally, which made "reminded" and "there was
 * no one to remind" the same state: a broker with no push subscription — most
 * of them — had every promise silently marked as handled the moment it came
 * due, once, forever. That is how a client who had stated a 50 million budget
 * and asked to move in immediately sat unanswered for seven days behind a
 * message that said "I'll get back to you shortly".
 *
 * Leaving it unstamped costs nothing while the broker is dark (there is
 * nothing to send) and delivers the backlog the moment they enable
 * notifications. The report is the surface that does not depend on push at
 * all — see openCommitmentsFor in lib/daily-report.ts.
 */
export async function processCommitmentReminders(): Promise<void> {
  let due: LeadCommitment[] = [];
  try {
    due = await db
      .select()
      .from(leadCommitmentsTable)
      .where(
        and(
          eq(leadCommitmentsTable.status, "open"),
          isNull(leadCommitmentsTable.notifiedAt),
          lte(leadCommitmentsTable.dueAt, new Date()),
        ),
      );
  } catch (err) {
    logger.error({ err }, "processCommitmentReminders: query failed");
    return;
  }

  for (const row of due) {
    try {
      const delivered = await notifyBrokerForLead(
        row.responsibleUser,
        row.leadId,
        "reminder",
        `Ты обещал: ${row.promiseText} — вернись с ответом`,
      );

      if (delivered > 0) {
        await db
          .update(leadCommitmentsTable)
          .set({ notifiedAt: new Date() })
          .where(eq(leadCommitmentsTable.id, row.id));
        continue;
      }

      // Nobody took it. Keep retrying for a while, then stop pinging — but
      // never pretend it was delivered.
      if (Date.now() - row.dueAt.getTime() > RETRY_WINDOW_MS) {
        await db
          .update(leadCommitmentsTable)
          .set({ notifiedAt: new Date() })
          .where(eq(leadCommitmentsTable.id, row.id));
        logger.warn(
          { leadId: row.leadId, broker: row.responsibleUser, promiseText: row.promiseText },
          "commitment reminder undeliverable for 3 days — broker has no push subscription",
        );
      } else {
        logger.warn(
          { leadId: row.leadId, broker: row.responsibleUser },
          "commitment reminder had no device to reach — will retry",
        );
      }
    } catch (err) {
      logger.error({ err, leadId: row.leadId }, "processCommitmentReminders: notify failed for one row");
    }
  }
}

let handle: ReturnType<typeof setInterval> | null = null;

export function startCommitmentScheduler(intervalMs = 5 * 60 * 1000): void {
  if (handle) return;
  handle = setInterval(() => {
    processCommitmentReminders().catch((err) => logger.error({ err }, "processCommitmentReminders crashed"));
  }, intervalMs);
}

export function stopCommitmentScheduler(): void {
  if (handle) clearInterval(handle);
  handle = null;
}
