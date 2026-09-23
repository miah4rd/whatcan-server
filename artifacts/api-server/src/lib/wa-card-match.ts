/**
 * The owner's rule for the WhatsApp bridge (17.09.2026): a conversation reaches
 * amoCRM ONLY when that person already has a card there. A number is a broker's
 * or the owner's own phone; friends, agents chatting privately, family — none of
 * it is business and none of it may land in the CRM. The bridge never creates a
 * lead from WhatsApp: cards come from forms, ads and the scout.
 *
 * Before this the bridge mirrored every chat like Wahelp does, and on 16–17.09
 * the owner's personal chats became 14 leads in Amelia's Rental funnel.
 */
import { amoFetch } from "./amo-client";
import { logger } from "./logger";

export interface CardMatch { contactId: number; leadId: number; responsibleId: number | null }

const cache = new Map<string, { at: number; value: CardMatch | null }>();
const HIT_TTL = 10 * 60 * 1000;
// A card created a minute ago must be picked up quickly.
const MISS_TTL = 2 * 60 * 1000;
const CLOSED = new Set([142, 143]);
// Owner, 23.09.2026: "только рентал, бизнес продажи пока не трогай". A chat reaches
// amoCRM only through a rental card; a sales (UNICORN) card of the same person is not
// a reason to put their WhatsApp into the CRM.
const RENTAL_PIPELINES = new Set([11119150, 11180334]);

const digits = (s: string) => String(s ?? "").replace(/\D+/g, "");
/** Same person when the last 9 digits agree ("+62 812…", "0812…", "62812…"). */
const samePhone = (a: string, b: string) => a.length >= 8 && b.length >= 8 && a.slice(-9) === b.slice(-9);

type AmoContact = {
  id: number;
  custom_fields_values?: Array<{ field_code?: string; values?: Array<{ value?: string }> }> | null;
  _embedded?: { leads?: Array<{ id: number }> };
};

/**
 * The open card of the person behind this phone WHOSE RESPONSIBLE USER OWNS THE
 * NUMBER, or null. The owner's model (17.09.2026), the same as Wahelp: a card
 * exists, its responsible's number is tied to it, the work on that card goes
 * through that number. A card of another broker, a stale card on a colleague's
 * number, a number with no responsible set: nothing reaches the CRM.
 * Anything unreadable is null — a chat missing from the CRM costs a look on the
 * phone, a private chat in the CRM is the incident this exists to prevent.
 */
export async function cardForPhone(phone: string | null, responsibleId: number | null): Promise<CardMatch | null> {
  const p = digits(phone ?? "");
  if (p.length < 8 || !responsibleId) return null;
  const key = `${p.slice(-9)}:${responsibleId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.value ? HIT_TTL : MISS_TTL)) return hit.value;

  let value: CardMatch | null = null;
  try {
    const found = await amoFetch<{ _embedded?: { contacts?: AmoContact[] } }>(
      `/api/v4/contacts?query=${encodeURIComponent(p.slice(-9))}&with=leads&limit=25`,
    );
    const candidates: Array<{ contactId: number; leadId: number }> = [];
    for (const c of found?._embedded?.contacts ?? []) {
      // The search is a substring match over the whole contact: only an exact
      // phone makes it the same person.
      const phones = (c.custom_fields_values ?? [])
        .filter((f) => f.field_code === "PHONE")
        .flatMap((f) => (f.values ?? []).map((v) => digits(v.value ?? "")));
      if (!phones.some((x) => samePhone(x, p))) continue;
      for (const l of c._embedded?.leads ?? []) candidates.push({ contactId: c.id, leadId: l.id });
    }
    let best: { m: CardMatch; updated: number } | null = null;
    for (const cand of candidates.slice(0, 10)) {
      const lead = await amoFetch<{ id: number; status_id: number; pipeline_id: number; responsible_user_id: number; updated_at: number; is_deleted?: boolean }>(
        `/api/v4/leads/${cand.leadId}`,
      );
      if (!lead || CLOSED.has(lead.status_id) || lead.is_deleted) continue;
      if (!RENTAL_PIPELINES.has(lead.pipeline_id)) continue;
      if (lead.responsible_user_id !== responsibleId) continue;
      if (!best || lead.updated_at > best.updated) {
        best = { m: { contactId: cand.contactId, leadId: lead.id, responsibleId }, updated: lead.updated_at };
      }
    }
    value = best?.m ?? null;
    if (!found && !value) return null; // empty or unreadable search: do not remember a miss
  } catch (err) {
    logger.warn({ err: String(err) }, "wa-card-match: amoCRM lookup failed — treated as no card");
    value = null;
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}
