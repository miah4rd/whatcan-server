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
 */
const timers = new Map<string, NodeJS.Timeout>();

export function scheduleLiveReply(
  leadId: string,
  run: () => void | Promise<void>,
  delayMs = 5000,
): void {
  const existing = timers.get(leadId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    timers.delete(leadId);
    Promise.resolve(run()).catch(() => {});
  }, delayMs);
  timers.set(leadId, timer);
}
