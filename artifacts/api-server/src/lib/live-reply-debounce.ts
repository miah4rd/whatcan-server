/**
 * Coalesces a burst of incoming messages from the same lead into a single
 * LIVE-reply generation.
 *
 * Two independent paths can each detect "this lead has a new incoming
 * message" for what is effectively the same burst of WhatsApp texts: the
 * real-time amoCRM webhook, and the ~45s timeline quick-poll (a safety net
 * for messages the webhook missed). When a lead sends several messages close
 * together, both paths can fire their own generation, producing near-duplicate
 * replies a couple minutes apart — from the lead's side it looks like the bot
 * is answering something they said two messages ago.
 *
 * Call scheduleLiveReply() instead of generating immediately. Each call for
 * the same leadId resets the wait — the actual generation only runs once
 * that lead has been quiet (across BOTH detection paths) for `delayMs`, and
 * by then it reads the freshest conversation state rather than a snapshot
 * from whenever the first message in the burst arrived.
 *
 * It is also the one place every live reply passes through, which is why the
 * "there is no WhatsApp on this number" check lives HERE rather than in each of
 * the three callers. Put it in the callers and it lands in two of them, which
 * is how every drift bug in this project has started.
 */
import { db, leadMessagesTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { isUndeliverableNotice, closeUndeliverable } from "./undeliverable";

const timers = new Map<string, NodeJS.Timeout>();

/**
 * True when the newest thing "the lead said" is the integration reporting an
 * unreachable number. Answering that produces a message nobody can receive.
 */
async function lastIncomingIsUndeliverable(leadId: string): Promise<boolean> {
  try {
    const [newest] = await db
      .select({ text: leadMessagesTable.text })
      .from(leadMessagesTable)
      .where(and(eq(leadMessagesTable.leadId, leadId), eq(leadMessagesTable.senderType, "lead")))
      .orderBy(desc(leadMessagesTable.sentAt))
      .limit(1);
    return isUndeliverableNotice(newest?.text);
  } catch {
    // Fail OPEN: a failed lookup must not silence a real conversation.
    return false;
  }
}

export function scheduleLiveReply(
  leadId: string,
  run: () => void | Promise<void>,
  delayMs = 5000,
): void {
  const existing = timers.get(leadId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    timers.delete(leadId);
    void (async () => {
      if (await lastIncomingIsUndeliverable(leadId)) {
        await closeUndeliverable(leadId);
        return;
      }
      await Promise.resolve(run()).catch(() => {});
    })().catch(() => {});
  }, delayMs);
  timers.set(leadId, timer);
}
