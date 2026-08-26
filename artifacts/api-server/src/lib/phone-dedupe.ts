/**
 * One person is one conversation, and the key is their PHONE.
 *
 * Both lead sources here manufacture duplicate cards. The Meta ad forms create
 * a fresh lead per submission, and the FB scout re-finds the same post on a
 * later sweep — so the same human arrives again under a different contact id,
 * sometimes with their name spelled in a different alphabet ("Yuliia
 * Nikonenko" on 25.08, "Юлія Ніконенко" on 26.08). Nothing about the two cards
 * looks related except the number.
 *
 * These checks used to live privately inside ad-lead-autoreply.ts, which meant
 * only the automatic welcome was protected: the scout path had no dedupe at
 * all, so a client already arranging a Sunday viewing had a second card seeded
 * and a cold "so to confirm, you're after a 3-4BR villa" draft written for her
 * (lead 23365147 beside the live 23353083, 2026-08-26). The broker read that as
 * the bot having lost the conversation. Shared module, one implementation —
 * anything that opens a conversation asks here first.
 */
import { db, leadsSyncTable, sentMessagesTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";
import { amoFetch } from "./amo-client";

/** Digits only — "+62 811 …" and "62811…" are the same person. */
export function normalisePhone(raw: string): string {
  return (raw ?? "").replace(/\D+/g, "");
}

/** The lead's contact phone, or "" when it cannot be read. */
export async function leadPhone(leadId: string): Promise<string> {
  try {
    const lead = await amoFetch<{ _embedded?: { contacts?: Array<{ id: number }> } }>(
      `/api/v4/leads/${leadId}?with=contacts`,
    );
    const contactId = lead?._embedded?.contacts?.[0]?.id;
    if (!contactId) return "";
    const contact = await amoFetch<{
      custom_fields_values?: Array<{ field_code?: string; values?: Array<{ value?: string }> }>;
    }>(`/api/v4/contacts/${contactId}`);
    const phone = (contact?.custom_fields_values ?? [])
      .find((f) => f.field_code === "PHONE")
      ?.values?.[0]?.value;
    return normalisePhone(String(phone ?? ""));
  } catch {
    return "";
  }
}

/**
 * Every OTHER lead amoCRM knows for this number.
 *
 * The search is by phone across contacts, not by contact id, because a
 * duplicate card carries a duplicate contact — matching on the id is exactly
 * what fails to spot the second card.
 */
async function siblingLeadIds(leadId: string, phone: string): Promise<string[]> {
  const found = await amoFetch<{
    _embedded?: { contacts?: Array<{ _embedded?: { leads?: Array<{ id: number }> } }> };
  }>(`/api/v4/contacts?query=${encodeURIComponent(phone)}&with=leads&limit=10`);
  return (found?._embedded?.contacts ?? [])
    .flatMap((c) => c._embedded?.leads ?? [])
    .map((l) => String(l.id))
    .filter((id) => id !== leadId);
}

/**
 * Has this PHONE already been written to?
 *
 * Larissalara and Anna Shahumyan each existed twice, with different contact ids
 * and the same number, and each received two different opening messages a
 * minute apart. With a human in the loop that was embarrassing; on the path
 * that sends itself it would be systematic.
 */
export async function phoneAlreadyMessaged(leadId: string, phone: string): Promise<boolean> {
  if (!phone) return false;
  try {
    const siblings = await siblingLeadIds(leadId, phone);
    if (siblings.length === 0) return false;

    const [row] = await db
      .select({ id: sentMessagesTable.id })
      .from(sentMessagesTable)
      .where(sql`${sentMessagesTable.leadId} IN (${sql.join(siblings.map((i) => sql`${i}`), sql`, `)})`)
      .limit(1);
    if (row) {
      logger.warn({ leadId, phone, siblings }, "skipped — this phone already received a message on another lead");
      return true;
    }
    return false;
  } catch (err) {
    // A failed lookup must not become a second message to the same person.
    logger.warn({ err, leadId }, "phone dedupe lookup failed — skipping to stay safe");
    return true;
  }
}

/**
 * Are we ALREADY talking to this person somewhere else?
 *
 * Deliberately wider than `phoneAlreadyMessaged`, and used before a card is
 * seeded rather than before a message is sent. A draft is not harmless just
 * because a human still has to tap it: it sits in the broker's inbox looking
 * like the current state of that client, so a cold opening written for someone
 * mid-viewing-arrangement does not read as a duplicate — it reads as the bot
 * having forgotten the conversation, which is exactly how it was reported.
 *
 * A CLOSED sibling does not count. Someone whose deal ended and who has posted
 * a fresh request in an FB group months later is a new enquiry, and refusing to
 * work them would be a worse failure than the duplicate.
 */
export async function phoneIsAlreadyInConversation(leadId: string, phone: string): Promise<boolean> {
  if (!phone) return false;
  try {
    const siblings = await siblingLeadIds(leadId, phone);
    if (siblings.length === 0) return false;
    const idList = sql.join(siblings.map((i) => sql`${i}`), sql`, `);

    type SiblingRow = {
      leadId: string;
      leadStage: string | null;
      lastOurMessageAt: Date | null;
    };

    const rows: SiblingRow[] = await db
      .select({
        leadId: leadsSyncTable.leadId,
        leadStage: leadsSyncTable.leadStage,
        lastOurMessageAt: leadsSyncTable.lastOurMessageAt,
      })
      .from(leadsSyncTable)
      .where(sql`${leadsSyncTable.leadId} IN (${idList})`);

    const live = rows.filter((r: SiblingRow) => !/closed/i.test(r.leadStage ?? ""));
    if (live.length === 0) return false;

    // Anything we have said to them, on any of their open cards.
    const talking = live.find((r: SiblingRow) => r.lastOurMessageAt !== null);
    if (talking) {
      logger.warn(
        { leadId, phone, siblingLeadId: talking.leadId, siblingStage: talking.leadStage },
        "seeding skipped — this phone is already in an open conversation on another lead",
      );
      return true;
    }

    const [sent] = await db
      .select({ leadId: sentMessagesTable.leadId })
      .from(sentMessagesTable)
      .where(sql`${sentMessagesTable.leadId} IN (${sql.join(live.map((r: SiblingRow) => sql`${r.leadId}`), sql`, `)})`)
      .limit(1);
    if (sent) {
      logger.warn(
        { leadId, phone, siblingLeadId: sent.leadId },
        "seeding skipped — this phone was already messaged on another open lead",
      );
      return true;
    }
    return false;
  } catch (err) {
    // Unlike the send guard, failing closed here would silently stop seeding
    // real new leads whenever amoCRM hiccups. Seeding a duplicate costs a
    // broker one confusing card; refusing to seed costs a lead entirely.
    logger.warn({ err, leadId }, "conversation dedupe lookup failed — seeding anyway");
    return false;
  }
}
