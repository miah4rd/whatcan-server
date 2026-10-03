/**
 * A Rental client who is still interested is never closed (owner, 03.10.2026, skills/rental.md §2):
 * before a close goes through the Copilot, the client's last words are read — a question, "keep
 * sending", "I'll get back to you", a move-in months away → the card stays open and a reminder is set
 * for their date instead.
 *
 * The two-month read found Lance (move-in January) and Jesica (February) closed after 3 days, Mahya
 * closed 2 days after "we'll contact you when my husband is back", Luke closed after "keep sending
 * options also please".
 *
 * Fail-open toward the broker: an unreadable conversation, or a client who declined, lets her close.
 */
import { db, leadMessagesTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { chatCompletionJSON, HELPER_MODEL } from "./ai-client";
import { logger } from "./logger";

export type StillInterested = { interested: boolean; quote: string; remindAt: Date };

const DAY = 24 * 3600_000;

export async function stillInterested(leadId: string): Promise<StillInterested | null> {
  const rows = await db
    .select({ senderType: leadMessagesTable.senderType, text: leadMessagesTable.text, sentAt: leadMessagesTable.sentAt })
    .from(leadMessagesTable)
    .where(eq(leadMessagesTable.leadId, leadId))
    .orderBy(desc(leadMessagesTable.sentAt))
    .limit(14);
  const thread = rows.reverse().filter((r) => (r.text ?? "").trim());
  if (!thread.some((r) => r.senderType === "lead")) return null;

  const today = new Date().toISOString().slice(0, 10);
  const transcript = thread
    .map((r) => `${(r.sentAt ?? new Date()).toISOString().slice(0, 10)} ${r.senderType === "lead" ? "CLIENT" : "US"}: ${(r.text ?? "").replace(/\s+/g, " ").slice(0, 400)}`)
    .join("\n");
  try {
    const out = await chatCompletionJSON<{ interested?: boolean; quote?: string; remind_on?: string | null }>({
      model: HELPER_MODEL,
      label: "close-guard",
      system: `A villa-rental broker is about to close this client's card as lost. Today is ${today}.
Read the conversation and decide whether the CLIENT is still interested. Interested = their latest messages (after anything we sent) ask a question, ask for more options ("keep sending"), say they will get back / are deciding / are waiting for someone, or name a move-in weeks or months away without saying they found a place.
NOT interested = they declined, found a place, stopped looking, asked us to stop, or only ever replied with a bare "ok/thanks" long ago and went silent.
Return {"interested": true|false, "quote": "<the client's own words that show it, max 120 chars>", "remind_on": "YYYY-MM-DD" | null}.
remind_on: when we should write again — about 3–4 weeks before a move-in they named, or the day they said they would be back; null if they named nothing.`,
      messages: [{ role: "user", content: transcript }],
      max_tokens: 200,
    });
    if (!out?.interested) return { interested: false, quote: "", remindAt: new Date() };
    let remindAt = out.remind_on ? new Date(`${out.remind_on}T02:00:00Z`) : new Date(Date.now() + 3 * DAY);
    if (!Number.isFinite(remindAt.getTime()) || remindAt.getTime() < Date.now() + DAY) remindAt = new Date(Date.now() + 3 * DAY);
    if (remindAt.getTime() > Date.now() + 180 * DAY) remindAt = new Date(Date.now() + 180 * DAY);
    return { interested: true, quote: String(out.quote ?? "").slice(0, 120), remindAt };
  } catch (err) {
    logger.warn({ err, leadId }, "close guard: could not read the conversation — the close goes through");
    return null;
  }
}
