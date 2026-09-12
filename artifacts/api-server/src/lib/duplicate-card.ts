/**
 * A second automatic card for someone who already has an OPEN Rental card is a
 * duplicate, and it goes to the bin (owner, 2026-09-12: "дубли нужно в корзину
 * убирать, важно только чтобы точно дубли, чтобы норм лиды случайно в корзину не
 * уходили").
 *
 * The case that asked for it: Lance filled in the catalog form at 03:26 and the
 * website form on R-YUD-048 at 03:30 — two cards, two contacts, one number
 * (23547869 / 23547879). Each card on its own looked like a new lead.
 *
 * "Exactly a duplicate" is decided in code, and every condition must hold:
 *  - the card was created by automation (created_by 0), never by a person — a
 *    broker who opens a second deal for a client meant to;
 *  - it is open in Rental and nothing has been sent on it or drafted for it;
 *  - one of its contact's phones matches, digit for digit, a phone on a contact
 *    whose card is open in Rental and was created EARLIER.
 * The newer card closes to Lost with a note naming the card kept; the kept card
 * gets a note that the client came in again. Anything unreadable on the way
 * (amoCRM hiccup, no phone, a sibling that will not load) keeps the card: a
 * duplicate left open costs a broker one look, a real lead in the bin costs the
 * lead.
 *
 * Both notes start with "Note:" so the seeding pass's housekeeping filter never
 * reads them as the client's own request.
 */
import { db, leadsSyncTable, pendingSuggestionsTable, sentMessagesTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { amoFetch, amoPost, closeLeadAsLost } from "./amo-client";
import { normalisePhone } from "./phone-dedupe";

const RENTAL_PIPELINE_ID = 11119150;
const CLOSED_STATUS_IDS = new Set([142, 143]);
/** Shorter than this is not a number anyone can be matched on. */
const MIN_PHONE_DIGITS = 9;

type AmoLead = {
  id: number;
  name?: string;
  pipeline_id?: number;
  status_id?: number;
  created_at?: number;
  created_by?: number;
  _embedded?: { contacts?: Array<{ id: number }> };
};

type AmoContact = {
  id: number;
  custom_fields_values?: Array<{ field_code?: string; values?: Array<{ value?: string }> }> | null;
  _embedded?: { leads?: Array<{ id: number }> };
};

function phonesOf(contact: AmoContact | null): string[] {
  return (contact?.custom_fields_values ?? [])
    .filter((f) => f.field_code === "PHONE")
    .flatMap((f) => f.values ?? [])
    .map((v) => normalisePhone(String(v.value ?? "")))
    .filter((p) => p.length >= MIN_PHONE_DIGITS);
}

function isOpenRental(lead: AmoLead | null): lead is AmoLead {
  return !!lead && lead.pipeline_id === RENTAL_PIPELINE_ID && !CLOSED_STATUS_IDS.has(lead.status_id ?? 0);
}

/** True when the card was closed as a duplicate of an older open card. */
export async function closeIfDuplicateCard(leadId: string): Promise<boolean> {
  try {
    const lead = await amoFetch<AmoLead>(`/api/v4/leads/${leadId}?with=contacts`);
    if (!isOpenRental(lead) || !lead.created_at) return false;
    if (lead.created_by !== 0) return false;

    const [sent] = await db
      .select({ id: sentMessagesTable.id })
      .from(sentMessagesTable)
      .where(eq(sentMessagesTable.leadId, leadId))
      .limit(1);
    if (sent) return false;
    const [drafted] = await db
      .select({ id: pendingSuggestionsTable.id })
      .from(pendingSuggestionsTable)
      .where(
        and(
          eq(pendingSuggestionsTable.leadId, leadId),
          sql`${pendingSuggestionsTable.status} IN ('pending','approved','edited')`,
        ),
      )
      .limit(1);
    if (drafted) return false;

    const contactId = lead._embedded?.contacts?.[0]?.id;
    if (!contactId) return false;
    const phones = [...new Set(phonesOf(await amoFetch<AmoContact>(`/api/v4/contacts/${contactId}`)))];
    if (phones.length === 0) return false;

    let keep: AmoLead | null = null;
    let matchedPhone = "";
    for (const phone of phones) {
      const found = await amoFetch<{ _embedded?: { contacts?: AmoContact[] } }>(
        `/api/v4/contacts?query=${encodeURIComponent(phone)}&with=leads&limit=25`,
      );
      for (const contact of found?._embedded?.contacts ?? []) {
        // The search is a substring match over the whole contact; only an exact
        // phone makes it the same person.
        if (!phonesOf(contact).includes(phone)) continue;
        for (const ref of contact._embedded?.leads ?? []) {
          if (String(ref.id) === leadId) continue;
          const sibling = await amoFetch<AmoLead>(`/api/v4/leads/${ref.id}`);
          if (sibling === null) return false; // cannot verify it — keep the card
          if (!isOpenRental(sibling) || !sibling.created_at) continue;
          if (sibling.created_at >= lead.created_at) continue;
          if (!keep || sibling.created_at < (keep.created_at ?? Number.MAX_SAFE_INTEGER)) {
            keep = sibling;
            matchedPhone = phone;
          }
        }
      }
    }
    if (!keep) return false;

    // amoCRM first: if the CRM refuses the close, the card stays active
    // everywhere rather than half-closed.
    const closed = await closeLeadAsLost(leadId);
    if (!closed) {
      logger.error({ leadId, keptLeadId: keep.id }, "duplicate card: amoCRM refused the close — card kept");
      return false;
    }
    await amoPost(`/api/v4/leads/notes`, [
      {
        entity_id: Number(leadId),
        note_type: "common",
        params: {
          text: `Note: duplicate of #${keep.id} — same phone +${matchedPhone}, and that card is open and older. Closed automatically.`,
        },
      },
      {
        entity_id: keep.id,
        note_type: "common",
        params: {
          text: `Note: the same client came in again as #${leadId} "${(lead.name ?? "").trim()}", closed as a duplicate. Their request there may add to this one.`,
        },
      },
    ]).catch(() => null);
    await db
      .update(leadsSyncTable)
      .set({ leadStage: "Closed Lost", nextFollowupAt: null, updatedAt: new Date() })
      .where(eq(leadsSyncTable.leadId, leadId));

    logger.warn(
      { leadId, keptLeadId: keep.id, phone: matchedPhone },
      "duplicate card closed to Lost — same phone as an older open Rental card",
    );
    return true;
  } catch (err) {
    logger.warn({ err, leadId }, "duplicate check failed — card kept");
    return false;
  }
}
