/**
 * Whose job is the owner's reply to a weekly availability check? The autopilot's (owner, 15.09.2026:
 * "пуши не должны уходить Юди вообще, это же автопилот").
 *
 * On 14–15.09 the check itself worked, but every answer still landed on Yudi. The LIVE reply path
 * drafted a reply and pushed him within a minute of the owner's "hallo masih kosong kak" (two pushes,
 * one per detector); processAnswers then retired that draft once the answer was on the site; five
 * minutes later the unanswered-live pass saw "the owner wrote last, nothing pending" and wrote the
 * draft again, with another push (Villa Lani 17:15 → 17:16, Bumbak Dream Villa 09:28 → 09:33, the
 * second one asking a live villa's owner for the minimum stay).
 *
 * Every LIVE writer asks this one question before it drafts or pushes:
 * - "none": not an answer to a weekly check — the ordinary path;
 * - "awaiting": nothing of ours followed the newest check (sent less than 10 days ago) and the pass
 *   has not read the answer yet — it does after ten quiet minutes: no draft, no push;
 * - "handled": the pass read the answer and the site shows it: no draft, no push;
 * - "needs_person": the pass could not use it (unclear, no longer for rent, availability rows it will
 *   not guess over): the reply draft stays in the inbox, still without a push.
 * Anything of ours after the check (Copilot or the phone), or anything the owner writes after the
 * pass read the answer, makes it a conversation again: "none".
 *
 * Only the database is imported: amocrm-webhook, followup-scheduler and weekly-availability-check
 * all read this, and the last one already imports the timeline sync that imports the webhook.
 */
import { db, sentMessagesTable, leadMessagesTable, brokerSettingsTable } from "@workspace/db";
import { and, desc, eq, gt, ne } from "drizzle-orm";

export const WEEKLY_CHECK_KIND = "weekly-availability";
/** processAnswers reads answers to checks this recent; an older check nobody read is nobody's. */
export const WEEKLY_ANSWER_WINDOW_DAYS = 10;
/** Our own check lands in lead_messages a second or two after it leaves — that echo is not "ours after". */
const OWN_ECHO_MS = 90_000;
const CLEAR_ANSWERS = new Set(["free_now", "free_from", "occupied_until"]);

export type WeeklyReplyState = "none" | "awaiting" | "handled" | "needs_person";

export const weeklyAnswerKey = (checkId: string) => `weekly_check:answer:${checkId}`;

/** What processAnswers stores under weeklyAnswerKey. `handled` is absent on markers from 14–15.09. */
export type WeeklyAnswerMarker = { at: string; answer: string; date: string | null; result: string; moved: boolean; handled?: boolean };

export async function weeklyCheckReplyState(leadId: string): Promise<WeeklyReplyState> {
  const [check] = await db
    .select({ id: sentMessagesTable.id, at: sentMessagesTable.createdAt })
    .from(sentMessagesTable)
    .where(and(eq(sentMessagesTable.leadId, leadId), eq(sentMessagesTable.kind, WEEKLY_CHECK_KIND), eq(sentMessagesTable.webhookStatus, 200)))
    .orderBy(desc(sentMessagesTable.createdAt))
    .limit(1);
  if (!check) return "none";

  const [oursSent] = await db
    .select({ at: sentMessagesTable.createdAt })
    .from(sentMessagesTable)
    .where(
      and(
        eq(sentMessagesTable.leadId, leadId),
        eq(sentMessagesTable.webhookStatus, 200),
        gt(sentMessagesTable.createdAt, check.at),
        ne(sentMessagesTable.id, check.id),
      ),
    )
    .limit(1);
  if (oursSent) return "none";
  const [oursThread] = await db
    .select({ at: leadMessagesTable.sentAt })
    .from(leadMessagesTable)
    .where(
      and(
        eq(leadMessagesTable.leadId, leadId),
        ne(leadMessagesTable.direction, "inbound"),
        gt(leadMessagesTable.sentAt, new Date(check.at.getTime() + OWN_ECHO_MS)),
      ),
    )
    .limit(1);
  if (oursThread) return "none";

  const [marker] = await db
    .select({ value: brokerSettingsTable.value })
    .from(brokerSettingsTable)
    .where(eq(brokerSettingsTable.key, weeklyAnswerKey(check.id)))
    .limit(1);
  // No reading yet. A LIVE writer only runs because the owner wrote, and the webhook can run before
  // the message reaches lead_messages — so the owner's message is not looked for here.
  if (!marker) {
    return Date.now() - check.at.getTime() < WEEKLY_ANSWER_WINDOW_DAYS * 86400_000 ? "awaiting" : "none";
  }

  let read: Partial<WeeklyAnswerMarker> = {};
  try {
    read = JSON.parse(marker.value) as Partial<WeeklyAnswerMarker>;
  } catch {
    return "needs_person";
  }
  const readAt = read.at ? new Date(read.at) : null;
  if (readAt && !Number.isNaN(readAt.getTime())) {
    const [later] = await db
      .select({ at: leadMessagesTable.sentAt })
      .from(leadMessagesTable)
      .where(and(eq(leadMessagesTable.leadId, leadId), eq(leadMessagesTable.direction, "inbound"), gt(leadMessagesTable.sentAt, readAt)))
      .limit(1);
    if (later) return "none";
  }
  const handled = read.handled ?? CLEAR_ANSWERS.has(read.answer ?? "");
  return handled ? "handled" : "needs_person";
}
