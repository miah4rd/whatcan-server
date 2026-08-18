/**
 * A broker answered the client BY HAND — WhatsApp on the phone, or amoCRM's own
 * chat, never our Salesbot — and that reply has to move the amoCRM TASK, not
 * just leads_sync.nextFollowupAt.
 *
 * Why: nextFollowupAt is NOT the scheduling source of truth. amo-sync's
 * syncTaskSchedule reads every open amoCRM task back into nextFollowupAt on a
 * 5-minute cycle. So a path that resets only the clock while an overdue task
 * stays open gets undone within 5 minutes, forever — the lead sits pinned at
 * "Overdue Nd" no matter how many times the broker replies on WhatsApp. That is
 * exactly what Amelia reported (2026-08-18): "in overdue for 2 days but I been
 * talking with her on WA and sent her a msg on WA this morning".
 *
 * The FAST path for manual replies is the amoCRM webhook (brokerRepliedFresh in
 * routes/amocrm-webhook.ts): it clears the stale LIVE draft, records the touch,
 * and for Rental advances the follow-up (closing the old task, creating the
 * next). But that webhook demonstrably does not fire for every manual reply,
 * and the v4 events poll (syncOutgoingEvents) has returned ZERO outgoing events
 * since at least 2026-07-24 — the only detector guaranteed to see a manual
 * reply is the 30-minute timeline sweep. This module gives that backstop the
 * same task handling the webhook has. Keep the two in step.
 *
 * Guard against double-handling: if the lead already has an open task due in
 * the FUTURE, the reply was already handled (by the webhook, by approve, or by
 * the broker planning their own task) — close any leftover stale tasks and
 * change nothing else. This is what makes the backstop safe to run after the
 * webhook already did its job, and it is why bot-sent messages must never be
 * routed here: approve.ts creates the next task itself, sometimes on an
 * adaptive cadence a flat reschedule would destroy.
 */
import { db, pendingSuggestionsTable, contactEventsTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { getOpenAmoTasks, closeAmoTasksForLead, createAmoTask, getAmoLead } from "./amo-client";
import { advanceRentalFollowup, rentalStageToFollowupLevel, followupClockAfterReply } from "./rental-followup";
import { logger } from "./logger";

export interface ManualReplyReconcileResult {
  action: "already-handled" | "advanced" | "rescheduled" | "no-op";
  /** The new chase date, when this call created the task itself. */
  due?: Date;
}

export async function reconcileTasksAfterManualReply(opts: {
  leadId: string;
  /** When the broker's own message left (timeline event time). */
  sentAt: Date;
  pipeline: string | null;
  leadStage: string | null;
  responsibleUser: string | null;
  /**
   * "live"   — a fresh manual reply the timeline backstop just detected:
   *            full webhook parity, including the Rental stage advance.
   * "repair" — one-time sweep over leads already pinned by a stale task:
   *            swap the task and the clock only, never move a stage in bulk.
   */
  mode: "live" | "repair";
}): Promise<ManualReplyReconcileResult> {
  const { leadId, sentAt, pipeline, leadStage, responsibleUser, mode } = opts;
  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);

  const open = await getOpenAmoTasks(leadId);
  const stale = open.filter((t) => (t.complete_till ?? 0) <= nowSec);
  const future = open.filter((t) => (t.complete_till ?? 0) > nowSec);

  if (future.length > 0) {
    // Already handled — but a stale task alongside the future one would still
    // pin the clock (syncTaskSchedule prioritises the overdue one), so it goes.
    if (stale.length > 0) await closeAmoTasksForLead(leadId, { onlyDueBefore: now });
    return { action: "already-handled" };
  }

  // From here WE are the ones processing this reply. Drafts written for the
  // pre-reply world are stale: the LIVE answer to a message the broker already
  // answered, and the queued follow-up composed while the lead looked ignored.
  // requestedAt stays protected — never delete a draft the broker asked for.
  await db
    .delete(pendingSuggestionsTable)
    .where(and(
      eq(pendingSuggestionsTable.leadId, leadId),
      eq(pendingSuggestionsTable.status, "pending"),
      eq(pendingSuggestionsTable.kind, "live"),
    ));
  await db
    .delete(pendingSuggestionsTable)
    .where(and(
      eq(pendingSuggestionsTable.leadId, leadId),
      eq(pendingSuggestionsTable.status, "pending"),
      eq(pendingSuggestionsTable.kind, "push"),
      isNull(pendingSuggestionsTable.requestedAt),
    ));

  if (mode === "live") {
    // The webhook records this touch when IT handles the reply; here only when
    // it missed, so the report never counts the same touch twice.
    await db
      .insert(contactEventsTable)
      .values({ leadId, responsibleUser: responsibleUser ?? undefined, source: "direct" })
      .catch(() => {});

    if ((pipeline ?? "").trim().toLowerCase() === "rental") {
      const amoLead = await getAmoLead(leadId);
      if (amoLead?.status_id) {
        await advanceRentalFollowup(leadId, amoLead.status_id, rentalStageToFollowupLevel(leadStage), sentAt);
        return { action: "advanced" };
      }
      return { action: "no-op" };
    }
  }

  // Non-Rental live reply, or any repair: every open task is stale — the broker
  // has touched the client since. Close them and chase from THIS reply on the
  // funnel's own cadence. For repaired backlog leads that date is already past;
  // "due now" is the honest state (the client has been silent since the reply).
  await closeAmoTasksForLead(leadId);
  let due = followupClockAfterReply(sentAt, pipeline);
  if (!due) return { action: "no-op" };
  if (due.getTime() < now.getTime()) due = now;
  const ok = await createAmoTask(
    leadId,
    "Ручной ответ клиенту в WhatsApp — если тишина, follow-up.",
    due,
    (await getAmoLead(leadId))?.responsible_user_id,
  );
  if (!ok) logger.warn({ leadId, due }, "manual-reply reconcile: createAmoTask failed");
  return { action: "rescheduled", due };
}
