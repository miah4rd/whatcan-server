/**
 * A WhatsApp send that never reached a person.
 *
 * WAhelp answers an unreachable number by writing a line INTO the conversation,
 * and amoCRM stores it exactly like an incoming message from the counterpart:
 * same sender, same shape, no flag anywhere saying it came from the integration
 * rather than from a human. Three things followed from that, on 79 cards before
 * this module existed:
 *
 *   1. the bot read it as a reply and answered it — politely, in English, to a
 *      number with no WhatsApp on it ("Thanks for letting me know, I'll give
 *      the landline a call instead");
 *   2. the send counted against the day's nine cold contacts, though nothing
 *      was delivered. The owner's words: "была попытка связаться, но связи не
 *      было";
 *   3. the card sat in the funnel looking like a live conversation.
 *
 * Matching on the text is not a shortcut here, it is the only signal available.
 * The wording is a fixed string from the integration, not something a person
 * types: 279 occurrences in this database, all byte-identical. Keep the match
 * narrow for that reason — a loose pattern would start eating real replies from
 * owners who genuinely write about WhatsApp.
 */
import { db, leadsSyncTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { updateLeadStatus } from "./amo-client";

/**
 * amoCRM's universal terminal ids: 142 is won, 143 is lost, in every funnel.
 * Used directly rather than by stage NAME because the name differs per funnel
 * ("Closed - lost", "Closed Lost", "CLOSED / NOT SUITABLE") and resolving it
 * would fail on exactly the funnels this is most likely to fire in.
 */
const CLOSED_LOST_STATUS_ID = 143;

const NOTICE_PATTERNS: RegExp[] = [
  /на\s+данном\s+номере\s+не\s+установлен\s+what'?s?app/i,
  /на\s+данном\s+номере\s+не\s+установлен\s+ватсап/i,
  /whatsapp\s+is\s+not\s+installed\s+on\s+this\s+number/i,
];

/** Is this "message" the integration telling us the number is unreachable? */
export function isUndeliverableNotice(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  return NOTICE_PATTERNS.some((re) => re.test(t));
}

/**
 * SQL fragment: leads whose conversation carries such a notice.
 *
 * Exported so the new-contact budget and any future counter can subtract them
 * with the same definition rather than each inventing its own.
 */
export const UNDELIVERABLE_LEAD_IDS = sql`(
  SELECT DISTINCT lead_id FROM lead_messages
   WHERE text ~* 'на данном номере не установлен (what''?s?app|ватсап)'
      OR text ~* 'whatsapp is not installed on this number'
)`;

/**
 * Close a card we could not reach and stop everything scheduled against it.
 *
 * Deliberately NOT the usual "terminal stages are the broker's tap" rule: that
 * rule protects a JUDGEMENT about a live human ("did this client really walk
 * away?"). This is not a judgement, it is a delivery failure the integration
 * reported — there is no conversation to end, and nothing a broker could add by
 * confirming it card by card.
 */
export async function closeUndeliverable(leadId: string): Promise<boolean> {
  try {
    const ok = await updateLeadStatus(leadId, CLOSED_LOST_STATUS_ID);
    await db
      .update(leadsSyncTable)
      .set({ nextFollowupAt: null, updatedAt: new Date() })
      .where(eq(leadsSyncTable.leadId, leadId));
    logger.info({ leadId, moved: ok }, "undeliverable: no WhatsApp on this number, card closed");
    return ok;
  } catch (err) {
    logger.error({ err, leadId }, "undeliverable: failed to close the card");
    return false;
  }
}
