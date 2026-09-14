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
 * the three callers. Whether the card is then CLOSED is decided by
 * undeliverableVerdict — the same verdict the stage sync uses, so a notice
 * that arrives as an echo of our own send closes the card too.
 */
import { db, leadMessagesTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { isUndeliverableNotice, closeUndeliverable, undeliverableVerdict } from "./undeliverable";

const timers = new Map<string, NodeJS.Timeout>();
/** Leads whose LIVE generation has fired and not finished yet. */
const running = new Set<string>();

/**
 * A LIVE reply for this lead is waiting on its debounce or being written right
 * now. The quick poll's "known message, never answered" safety net reads this
 * so it never starts a second generation on top of the webhook's.
 */
export function liveReplyInFlight(leadId: string): boolean {
  return timers.has(leadId) || running.has(leadId);
}

/**
 * Is the newest thing "the lead said" the integration reporting an unreachable
 * number (answering it produces a message nobody can receive), and does the
 * shared verdict close the card?
 */
async function undeliverableState(leadId: string): Promise<{ lastIsNotice: boolean; close: boolean }> {
  try {
    const rows = await db
      .select({ senderType: leadMessagesTable.senderType, text: leadMessagesTable.text, sentAt: leadMessagesTable.sentAt })
      .from(leadMessagesTable)
      .where(eq(leadMessagesTable.leadId, leadId))
      .orderBy(desc(leadMessagesTable.sentAt))
      .limit(200);
    const lastFromLead = rows.find((m) => m.senderType === "lead");
    return { lastIsNotice: isUndeliverableNotice(lastFromLead?.text), close: undeliverableVerdict(rows.reverse()).close };
  } catch {
    // Fail OPEN: a failed lookup must not silence a real conversation.
    return { lastIsNotice: false, close: false };
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
    running.add(leadId);
    void (async () => {
      try {
        const u = await undeliverableState(leadId);
        if (u.lastIsNotice) {
          if (u.close) await closeUndeliverable(leadId);
          return;
        }
        await Promise.resolve(run()).catch(() => {});
      } finally {
        running.delete(leadId);
      }
    })().catch(() => {});
  }, delayMs);
  timers.set(leadId, timer);
}
