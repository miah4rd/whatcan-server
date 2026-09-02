/**
 * Fills a Rental Listings card with what the owner already told us.
 *
 * The problem this solves: a listing card arrives holding a villa name and
 * nothing else. Everything a listing agent needs to decide "can this go on the
 * site" — bedrooms, a price we may quote, when it frees up, where it is, who we
 * are talking to — sits in the WhatsApp thread, and nobody transcribes it. So
 * the funnel's list view shows 244 rows of villa names, QUALIFIED means "someone
 * replied politely", and the only way to answer "what have we actually got" is
 * to read every conversation by hand. This is `amo-request-fields.ts` for the
 * other funnel: same shape, same rules, different columns.
 *
 * The extraction is a Haiku call and not a regex, because the source is two
 * languages of free text: "our two bedroom is IDR 50.000.000", "harga bulanan
 * 45 juta", "450jt/year net", "available from 20th of september". A regex that
 * survives that does not exist; a cheap model reads it in one pass.
 */
import { amoFetch, amoPatch, amoPost } from "./amo-client";
import { chatCompletionJSON, HELPER_MODEL } from "./ai-client";
import { logger } from "./logger";

/**
 * Field ids are resolved BY NAME at runtime rather than hardcoded.
 *
 * The three listing fields were created in the amoCRM UI by the listing agent,
 * not by this code, so their ids were never written down anywhere here — and
 * the next person to add a column would have had to read the id out of the UI
 * and hope they typed it correctly. Resolving by name means a field created in
 * the UI simply starts working.
 */
const FIELD_NAMES = {
  bedrooms: "Request: bedrooms",
  area: "Request: area",
  price: "Listing price incl commission",
  maps: "Google Maps link",
  ownerVerified: "Owner contact verified",
  availableFrom: "Listing: available from",
  photos: "Listing: photos",
} as const;

/** Fields this module may create when they are missing. The three above them
 *  already exist in the CRM and are never created here. */
const CREATABLE: Partial<Record<keyof typeof FIELD_NAMES, "text" | "url">> = {
  availableFrom: "text",
  photos: "url",
};

type FieldMap = Partial<Record<keyof typeof FIELD_NAMES, number>>;
let _ids: FieldMap | null = null;

type AmoField = { id: number; name: string; type: string };

async function loadFieldIds(): Promise<FieldMap> {
  const data = await amoFetch<{ _embedded?: { custom_fields?: AmoField[] } }>(
    "/api/v4/leads/custom_fields?limit=250",
  );
  const byName = new Map<string, number>();
  for (const f of data?._embedded?.custom_fields ?? []) byName.set(f.name.trim().toLowerCase(), f.id);
  const out: FieldMap = {};
  for (const [key, name] of Object.entries(FIELD_NAMES)) {
    const id = byName.get(name.toLowerCase());
    if (id) out[key as keyof typeof FIELD_NAMES] = id;
  }
  return out;
}

export async function listingFieldIds(): Promise<FieldMap> {
  if (_ids) return _ids;
  _ids = await loadFieldIds();
  return _ids;
}

/**
 * Create the fields this module needs and the CRM does not have yet.
 *
 * Deliberately explicit and never called on boot: a custom field appears on
 * EVERY lead card in the account, for every user, and that is the owner's CRM
 * to shape — not something a restart should quietly do.
 */
export async function ensureListingFields(): Promise<{ created: string[]; ids: FieldMap }> {
  _ids = await loadFieldIds();
  const created: string[] = [];
  for (const [key, type] of Object.entries(CREATABLE) as Array<[keyof typeof FIELD_NAMES, "text" | "url"]>) {
    if (_ids[key]) continue;
    const name = FIELD_NAMES[key];
    const res = await amoPost<{ _embedded?: { custom_fields?: AmoField[] } }>(
      "/api/v4/leads/custom_fields",
      [{ name, type }],
    );
    const id = res?._embedded?.custom_fields?.[0]?.id;
    if (id) {
      _ids[key] = id;
      created.push(`${name} (${id})`);
      logger.info({ name, id, type }, "listing fields: created a custom field in amoCRM");
    } else {
      logger.warn({ name, type }, "listing fields: amoCRM refused to create the field");
    }
  }
  return { created, ids: _ids };
}

export type ListingFacts = {
  bedrooms: number | null;
  /** Monthly rate in rupiah, as the owner stated it. */
  monthlyIdr: number | null;
  /** Yearly rate in rupiah, as the owner stated it. */
  yearlyIdr: number | null;
  /** Whether the stated price already contains our 10% — the whole reason a
   *  card can or cannot be quoted to a client. */
  commission: "included" | "net" | "unknown";
  /** Free text, exactly as the owner put it: "20 September", "now", "from November". */
  availableFrom: string | null;
  area: string | null;
  mapsLink: string | null;
  photosLink: string | null;
  counterpart: "owner" | "manager" | "agent" | "unclear";
  /** A phrase that disqualifies the card, quoted: "fully booked", "daily only". */
  stopSignal: string | null;
};

const EXTRACT_SYSTEM = `You read a WhatsApp thread between a Bali rental agency and a villa owner (or the villa's manager), and pull out what the agency needs to put the villa on its website.

The thread may be in English, Indonesian, or both. Prices are Indonesian rupiah and appear as "45 juta", "45jt", "IDR 45.000.000", "45 million", "45 mio". "juta"/"jt"/"mio"/"million" all mean million.

Report ONLY what someone in the thread actually said. Never infer a price from another villa, never convert a yearly price into a monthly one yourself, never guess a bedroom count from the villa's name.

Fields:
- bedrooms: integer, the villa's own bedroom count. If the thread offers several unit types (a 2BR and a 3BR), report the SMALLEST, and put the rest in nothing — the agency lists units separately.
- monthly_idr / yearly_idr: full rupiah integers (45 juta -> 45000000). null when not stated.
- commission: "included" if someone said the price already contains the agency's commission; "net" if the owner said the price is net / the fee is added on top; "unknown" otherwise. This is the field the agency cares about most — do not guess it.
- available_from: the owner's own words about when it frees up ("20 September", "now", "from November", "1 October"). null if never discussed.
- area: the district or village the villa is in (Pererenan, Umalas, Seseh...). Not the whole address.
- maps_link: a Google Maps / goo.gl / maps.app link if one was shared, else null.
- photos_link: a Google Drive, Dropbox, WeTransfer or photo-gallery link if one was shared, else null.
- counterpart: "owner" if they said they own it; "manager" if they manage it, run its reception, or are the developer; "agent" if they are a third-party broker or a catalogue; "unclear" otherwise.
- stop_signal: quote the phrase that means this villa CANNOT be offered for long-term rental now — fully booked, already rented out for the year, daily rental only, short term only. null if there is none. Being occupied until a stated date is NOT a stop signal on its own; that is availability.

Respond with JSON only:
{"bedrooms":n|null,"monthly_idr":n|null,"yearly_idr":n|null,"commission":"included"|"net"|"unknown","available_from":s|null,"area":s|null,"maps_link":s|null,"photos_link":s|null,"counterpart":"owner"|"manager"|"agent"|"unclear","stop_signal":s|null}`;

export async function extractListingFacts(conversation: string): Promise<ListingFacts | null> {
  const text = conversation.trim();
  if (!text) return null;
  try {
    const raw = await chatCompletionJSON<Record<string, unknown>>({
      model: HELPER_MODEL,
      system: EXTRACT_SYSTEM,
      messages: [{ role: "user", content: text.slice(0, 14000) }],
      max_tokens: 500,
      temperature: 0,
      label: "listing-card-fields",
    });
    const int = (v: unknown): number | null => {
      const n = typeof v === "string" ? Number(v.replace(/[^\d]/g, "")) : Number(v);
      return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
    };
    const str = (v: unknown): string | null => {
      const s = typeof v === "string" ? v.trim() : "";
      return s && s.toLowerCase() !== "null" ? s : null;
    };
    const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
      allowed.includes(String(v) as T) ? (String(v) as T) : fallback;

    return {
      bedrooms: int(raw["bedrooms"]),
      monthlyIdr: int(raw["monthly_idr"]),
      yearlyIdr: int(raw["yearly_idr"]),
      commission: oneOf(raw["commission"], ["included", "net", "unknown"] as const, "unknown"),
      availableFrom: str(raw["available_from"]),
      area: str(raw["area"]),
      mapsLink: str(raw["maps_link"]),
      photosLink: str(raw["photos_link"]),
      counterpart: oneOf(raw["counterpart"], ["owner", "manager", "agent", "unclear"] as const, "unclear"),
      stopSignal: str(raw["stop_signal"]),
    };
  } catch (err) {
    logger.warn({ err }, "listing fields: extraction failed (non-fatal)");
    return null;
  }
}

/** Rupiah in, "45 jt" out — brokers read juta, not nine digits. */
function jt(idr: number | null): string | null {
  return idr && idr > 0 ? `${Math.round(idr / 1_000_000)} jt` : null;
}

/**
 * The one line a listing agent reads to answer "can I quote this?".
 *
 * It always says where the commission stands, because a number whose commission
 * position is unknown is not a price — it is a number we would have to correct
 * in front of a client.
 */
export function priceLine(f: ListingFacts): string | null {
  const m = jt(f.monthlyIdr);
  const y = jt(f.yearlyIdr);
  if (!m && !y) return null;
  const money = [m && `${m}/mo`, y && `${y}/yr`].filter(Boolean).join(" · ");
  const note =
    f.commission === "included" ? "incl. our 10%"
    : f.commission === "net" ? "NET — add our 10%"
    : "commission position NOT confirmed";
  return `${money} — ${note}`;
}

function verifiedLabel(c: ListingFacts["counterpart"]): string | null {
  if (c === "owner") return "Owner confirmed";
  if (c === "manager") return "Manager or agency";
  if (c === "agent") return "Manager or agency";
  return null; // "unclear" leaves the field alone rather than asserting "Not verified"
}

async function readCard(leadId: string, ids: FieldMap): Promise<Record<number, string>> {
  type AmoLead = { custom_fields_values?: Array<{ field_id?: number; values?: Array<{ value?: unknown }> }> };
  const lead = await amoFetch<AmoLead>(`/api/v4/leads/${encodeURIComponent(leadId)}`);
  const out: Record<number, string> = {};
  for (const f of lead?.custom_fields_values ?? []) {
    const v = f?.values?.[0]?.value;
    if (f?.field_id != null && v != null && String(v).trim() !== "") out[f.field_id] = String(v).trim();
  }
  void ids;
  return out;
}

/**
 * Write the facts onto the card, following the same two rules the rental funnel
 * settled on: never write a null (a fact not mentioned this round is "not
 * stated", not "retracted"), and send nothing when nothing differs (every PATCH
 * lands in the card's history, and a history of identical bot edits is a history
 * nobody reads).
 */
export async function syncListingFactsToCard(
  leadId: string,
  f: ListingFacts,
): Promise<{ written: number; fields: string[] }> {
  const ids = await listingFieldIds();
  let onCard: Record<number, string>;
  try {
    onCard = await readCard(leadId, ids);
  } catch (err) {
    logger.warn({ err, leadId }, "listing fields: could not read the card (non-fatal)");
    return { written: 0, fields: [] };
  }

  const values: Array<{ field_id: number; values: Array<{ value: string | number }> }> = [];
  const names: string[] = [];
  const put = (key: keyof typeof FIELD_NAMES, next: string | number | null) => {
    const id = ids[key];
    if (!id || next === null || next === "") return;
    if (String(onCard[id] ?? "") === String(next)) return;
    values.push({ field_id: id, values: [{ value: next }] });
    names.push(FIELD_NAMES[key]);
  };

  put("bedrooms", f.bedrooms);
  put("area", f.area);
  put("price", priceLine(f));
  put("maps", f.mapsLink);
  put("photos", f.photosLink);
  put("availableFrom", f.availableFrom);
  put("ownerVerified", verifiedLabel(f.counterpart));

  if (values.length === 0) return { written: 0, fields: [] };

  try {
    const res = await amoPatch(`/api/v4/leads/${encodeURIComponent(leadId)}`, {
      custom_fields_values: values,
    });
    if (!res) {
      logger.warn({ leadId, fields: names }, "listing fields: amoCRM did not accept the card update");
      return { written: 0, fields: [] };
    }
    logger.info({ leadId, fields: names }, "listing fields written to the amoCRM card");
    return { written: values.length, fields: names };
  } catch (err) {
    logger.warn({ err, leadId }, "listing fields: card update threw (non-fatal)");
    return { written: 0, fields: [] };
  }
}
