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
import { amoFetch, amoPatch, amoPost, getAmoLead, updateLeadStatus, createAmoTask, closeLeadAsLost } from "./amo-client";
import { safeStageIdForLead } from "./stage-classifier";
import { chatCompletionJSON, HELPER_MODEL } from "./ai-client";
import { logger } from "./logger";
import { db, leadsSyncTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

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
  /**
   * A commission rate THEY proposed for us, when it is not our 10%.
   *
   * Luxso answered our rate question with "we could offer 5% commission for
   * agent from rental villa rates" — a real offer, half of ours, and the card
   * auto-qualified straight past it. Whether we work at someone else's rate is a
   * commercial decision with a person in it, so a card carrying one is not ready
   * to list no matter how complete the rest of it looks.
   */
  theirCommissionPct: number | null;
  /** A phrase that disqualifies the card, quoted: "fully booked", "daily only". */
  stopSignal: string | null;
  /**
   * WHY it is disqualified, because the two answers go opposite ways.
   * "occupied" — ours to take, just let until a date. Worth keeping warm.
   * "not_our_format" — daily, per-room, someone else's villa. Never ours.
   */
  stopKind: "occupied" | "not_our_format" | null;
  /** Best-effort ISO date the villa frees up, when the thread allows one. */
  freeFromIso: string | null;
};

const EXTRACT_SYSTEM = `You read a WhatsApp thread between a Bali rental agency and a villa owner (or the villa's manager), and pull out what the agency needs to put the villa on its website.

The thread may be in English, Indonesian, or both. Prices are Indonesian rupiah and appear as "45 juta", "45jt", "IDR 45.000.000", "45 million", "45 mio". "juta"/"jt"/"mio"/"million" all mean million.

WHO SAID IT MATTERS. Every line is prefixed with its speaker: "lead:" is the owner or their manager, "broker:" and "bot:" are US, the agency.

A "lead:" line that begins with ">>" is a QUOTE of an earlier message, usually ours, pasted back when they reply to it. The words inside it are not theirs — attribute them to whoever said them first, which for a ">>" block is almost always us. Ignore quoted text entirely when deciding what the owner told you: a card that qualified on our own words quoted back is worse than one that never qualified.

Take bedrooms, prices and availability ONLY from "lead:" lines. We open these conversations by quoting the price from the seller's public ad ("I came across the 2BR villa listed at IDR 38jt/month") — that number is the ad's, not the owner's, and putting it on the card as their price is exactly the mistake this field exists to prevent. If a figure appears only in our own lines and the owner never repeated or confirmed it, report null.

Report ONLY what was actually said. Never infer a price from another villa, never convert a yearly price into a monthly one yourself, never guess a bedroom count from the villa's name.

Fields:
- bedrooms: integer, the villa's own bedroom count. If the thread offers several unit types (a 2BR and a 3BR), report the SMALLEST, and put the rest in nothing — the agency lists units separately.
- monthly_idr / yearly_idr: full rupiah integers (45 juta -> 45000000). null when not stated.
- commission: "included" if someone said the price already contains the agency's commission; "net" if the owner said the price is net / the fee is added on top; "unknown" otherwise. This is the field the agency cares about most — do not guess it.
- available_from: the owner's own words about when it frees up — a date or a clear period ("20 September", "now", "from November", "1 October", "after Nov 2026"). A fragment that is not an answer about timing ("Masih", "yes", "August" with no year or context) is null, not a guess.
- area: the district or village the villa is in (Pererenan, Umalas, Seseh...). Not the whole address.
- maps_link: a Google Maps / goo.gl / maps.app link if one was shared, else null.
- photos_link: a Google Drive, Dropbox, WeTransfer or photo-gallery link if one was shared, else null.
- counterpart: THE TEST IS NOT THEIR JOB TITLE. "Villa manager" is said both by a salaried employee of the owner and by a management company — the same words, opposite answers. What separates them is whether the person is ON THE OWNER'S PAYROLL or is a SEPARATE BUSINESS working this villa under its own contract, with its own brand and its own commission. The second one is another agency exactly like us.

  "owner" — they own it; OR they answered "do you handle this yourself?" with themselves ("saya kelola sendiri", "I manage it myself", "it's my own villa"); OR they are the OWNER'S OWN STAFF: a personal assistant, secretary, family member, house manager or villa staff the owner employs and pays. The tells: they speak about the owner as a person they work for ("the owner decides", "I'll ask the owner", "I'm the owner's assistant"), they carry no company name of their own, and they have nothing to negotiate with us because the terms are the owner's to set. "I'm Adel the owner's assistant, the villa is still managed directly by the owner" is an owner contact. Treat them exactly as you would the owner.

  A COMPANY IS NOT AUTOMATICALLY A MIDDLEMAN. The question is whose company it is. A villa's OWN operation is still the owner: the DEVELOPER that built it and its sales staff ("I'm the developer's sales manager"), the villa's OWN reception, front desk or guest services ("thank you for contacting Ersanea Villas, we are guest services"), a resort answering about its own units. The tell is that the brand IS the villa's: Ersanea guest services answering about Ersanea Villas, "Villa X by Y Group" answered by Y Group. These people are the owner side. Report "owner".
  The same goes for an IN-HOUSE team described as working WITH the owner and carrying no separate company name of its own: "the villa is managed directly by our management team together with the owner", "we handle it in-house with the owner", "I do the marketing for the villa, we work directly with the owner". The tells are "directly", "together with the owner", "our own team" — and, decisively, that NO second business is named. A third-party manager names itself, because its name is what it is paid under. Report "owner".

  "manager" — a THIRD-PARTY management company: a different business that took someone else's villa under contract, with a name of its own that is not the villa's. "Luxso Villa & Resort Management" answering about "Nila Residence" is the shape: two unrelated names, an office of their own, their own commission to protect, agent rates they set. They are on the villa's side, but as a business we would share the fee with.

  "agent" — a third-party broker or catalogue with no mandate of its own, or a company that wants a cut on top of ours.

  REQUIRE EVIDENCE. "I manage this villa" / "saya manage villa uma" on its own decides nothing — it is precisely the sentence both a salaried assistant and a management company say. Without a company name, a "we" that means an organisation, or an office/admin/contract behind it, report "unclear" and let the draft ask. This field decides whether we split a commission; a guess here is worse than a question. "agent" for anyone standing between us and the villa's side: a third-party broker, a catalogue, or a management company that wants a cut of its own — "we work with agents through a rate contract", "we don't work on a commission basis", "our published rate less 10% for agents", "the owner is our client too". They are commercially the same thing whatever they call themselves: a second commission on the same villa, and terms we cannot agree with them. "unclear" otherwise.
- their_commission_pct: if THEY proposed a commission rate for the agent ("we could offer 5% commission for agent", "we give agents 10% off the published rate", "our agent rate is 7"), report that number. null if they never named a rate, and null if they simply accepted ours.
- stop_kind: "occupied" when the villa IS lettable long term and is simply taken for MORE THAN ABOUT THREE MONTHS (rented for a year, booked out for six months, tenant in place until a date well ahead). A villa free within roughly three months is NOT a stop signal at all: that is a real option we can offer now, so leave stop_kind null and just report free_from_iso. "not_our_format" ONLY when monthly AND yearly letting of the WHOLE villa are both ruled out for good: daily only with no monthly offered, rented by the room rather than whole, they no longer look after the property, they refuse to work with agencies at all. It now CLOSES the card, so the bar is a plain refusal, not a difficulty. Three things are NOT "not_our_format", and each was closed wrongly before this line existed: (1) "daily AND monthly" or any answer that includes monthly — monthly is exactly our format, report null; (2) a villa still being BUILT or renovated ("still in progress", "two units left, finishing soon") — nothing is refused, it is simply not ready, report null and let free_from_iso carry the date if one was given; (3) a period they cannot do right now for a reason that passes, such as events or bookings already in the calendar — that is "occupied", not a refusal. When in doubt report null: a wrong "occupied" costs a wait, a wrong "not_our_format" bins a live owner. null when there is no stop signal. These go opposite ways: the first is a contact worth keeping warm until a date, the second is not.
- free_from_iso: if the thread lets you work out WHEN it frees up, give it as YYYY-MM-DD, resolving relative wording against the newest message's date ("available in 3 months", "rented for a year from June"). null when nobody said, or when it cannot be pinned to a month.
- stop_signal: quote the phrase that means this villa CANNOT be offered for long-term rental now — fully booked, already rented out for the year, daily rental only, short term only. null if there is none. Being occupied until a stated date is NOT a stop signal on its own; that is availability.

Respond with JSON only:
{"bedrooms":n|null,"monthly_idr":n|null,"yearly_idr":n|null,"commission":"included"|"net"|"unknown","available_from":s|null,"area":s|null,"maps_link":s|null,"photos_link":s|null,"counterpart":"owner"|"manager"|"agent"|"unclear","their_commission_pct":n|null,"stop_kind":"occupied"|"not_our_format"|null,"free_from_iso":s|null,"stop_signal":s|null}`;

/**
 * Remove quoted text before the model ever sees it.
 *
 * WhatsApp replies carry the message they answer, and our sync writes it inline
 * behind ">>". So our own words arrive attributed to the owner: Nila Residence
 * qualified on a commission position that was our question quoted back, and a
 * draft went on to tell that owner "5% works on our side" — a rate said by
 * nobody. Asking the model to ignore ">>" was not enough; it kept reading them.
 * Deleting the quote is deterministic, and a quote never carries a fact the
 * original speaker did not already say somewhere else in the thread.
 */
export function stripQuotedText(conversation: string): string {
  return conversation
    .split("\n")
    .map((line) => line.replace(/>>.*$/s, "").trimEnd())
    .filter((line) => line.trim() !== "" && !/^\s*(lead|broker|bot)\s*:\s*$/i.test(line))
    .join("\n");
}

export async function extractListingFacts(conversation: string): Promise<ListingFacts | null> {
  const text = stripQuotedText(conversation).trim();
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
      theirCommissionPct: int(raw["their_commission_pct"]),
      stopSignal: str(raw["stop_signal"]),
      stopKind: (["occupied", "not_our_format"] as const).includes(String(raw["stop_kind"]) as never)
        ? (String(raw["stop_kind"]) as "occupied" | "not_our_format")
        : null,
      freeFromIso: /^\d{4}-\d{2}-\d{2}$/.test(String(raw["free_from_iso"] ?? "")) ? String(raw["free_from_iso"]) : null,
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

/**
 * Two buckets, and the line between them is the commission — the owner's rule:
 *
 *   "Owner confirmed"    the owner, or the owner's own person (assistant, staff,
 *                        family). We deal directly and split nothing.
 *   "Manager or agency"  a management company or another agency. Workable, but
 *                        the commission is shared, so it is a different deal.
 *
 * "Not verified" is kept for exactly one thing: we genuinely do not know yet.
 * It is never an opinion about who they are.
 *
 * Qualification still separates `manager` from `agent` internally (the funnel's
 * own rule), so the card being coarser than the model here is deliberate: this
 * field answers "do we split?", and the commission-rate gate in meetsQualified
 * answers "on what terms?".
 */
function verifiedLabel(c: ListingFacts["counterpart"]): string | null {
  if (c === "owner") return "Owner confirmed";
  if (c === "manager" || c === "agent") return "Manager or agency";
  return null; // "unclear" leaves the field alone rather than asserting anything
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

// ── Automatic promotion to QUALIFIED ────────────────────────────────────────

/**
 * The regulation, in code.
 *
 * QUALIFIED means "this villa can go on the site", not "someone replied
 * politely" — so it needs the two facts a listing cannot be published without,
 * from someone entitled to let the villa.
 *
 * A price whose commission position is unknown does NOT qualify. It is a number
 * nobody may quote a client, and a card promoted on it sends the agent to
 * publish a figure that has to be corrected in front of the customer.
 */
/**
 * The cheapest listing worth carrying, in rupiah a month, as the CLIENT sees it.
 *
 * The 30M floor has always existed on the client side: a rental lead whose own
 * budget is under it is closed before a single token is spent. Nothing enforced
 * the other half, so a villa at 18M a month qualified and went to Details —
 * stock for which our funnel has, by our own rule, no buyer at all.
 *
 * 30M WITH our commission in it, the owner's own wording (2026-09-04) — so the
 * comparison is against the QUOTED price, net plus 10%, never against the net
 * figure the villa side names. A villa at 27.3M net quotes at 30M and stays; one
 * at 25M net quotes at 27.5M and goes. A villa whose commission position is
 * still unknown is read as net, the reading that bins the fewest.
 */
const MIN_LISTING_MONTHLY_IDR = 30_000_000;

/** What a client would be quoted, from whatever we know about the price. */
export function clientFacingMonthlyIdr(f: ListingFacts): number | null {
  /**
   * A MONTHLY figure only. A yearly rate divided by twelve is not the monthly
   * rate — it is the yearly discount, and every villa here quotes the two
   * differently. 300jt a year works out at 25M a month and would be binned by
   * the floor below, while the same villa's actual monthly ask is comfortably
   * over it. Binning on that arithmetic is a guess, and the whole point of this
   * check is that it is not one: no monthly price, no verdict.
   */
  const monthly = f.monthlyIdr;
  if (!monthly) return null;
  // "included" already carries our fee; "net" and "unknown" are both treated as
  // net here, which is the reading that makes the villa look most expensive and
  // therefore bins the fewest.
  return f.commission === "included" ? monthly : Math.round(monthly * 1.1);
}

export function meetsQualified(f: ListingFacts): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  const quoted = clientFacingMonthlyIdr(f);
  if (quoted !== null && quoted < MIN_LISTING_MONTHLY_IDR) {
    missing.push(
      `below our floor: ${Math.round(quoted / 1_000_000)}M quoted, minimum ${MIN_LISTING_MONTHLY_IDR / 1_000_000}M`,
    );
  }
  if (!f.bedrooms) missing.push("bedrooms");
  if (!f.monthlyIdr && !f.yearlyIdr) missing.push("price");
  else if (f.commission === "unknown") missing.push("commission position");
  // WHO we are talking to is the BASIS of qualification, not one field among
  // several. A management company or another agency means not qualified however
  // complete the listing details are: we would be sharing the fee with a
  // business that already holds the villa. Only the owner, or the staff he pays,
  // can put it on our site on our terms.
  if (f.counterpart !== "owner") missing.push("not the owner or his own staff");
  // They named a rate that is not ours. Working at someone else's commission is
  // a decision with a person in it — never something a card walks past because
  // every other box is ticked.
  if (f.theirCommissionPct !== null && f.theirCommissionPct !== 10) {
    missing.push(`commission terms to agree (they offer ${f.theirCommissionPct}%)`);
  }
  if (f.stopSignal) missing.push(`stop signal: ${f.stopSignal}`);
  return { ok: missing.length === 0, missing };
}

/**
 * Stages a card may be promoted FROM.
 *
 * Deliberately a whitelist. Everything past QUALIFIED is a person's judgement
 * about a listing already in flight, and a bot that moved a card back from
 * `agreement` because this round's extraction came out thinner would undo work
 * nobody asked it to touch. Promotion only moves forward, and never touches a
 * closed card.
 */
const PROMOTABLE_FROM = ["incoming leads", "initial contact", "taken to work"];
const QUALIFIED_STAGE = "QUALIFIED (Pre-listed)";

async function stageIdByName(pipelineId: number, name: string): Promise<string | null> {
  const { id } = await safeStageIdForLead({ pipelineId, stageId: null, stageName: name });
  return id;
}

/**
 * Move a card to QUALIFIED once the conversation has earned it.
 *
 * Never closes anything: a stop signal withholds promotion, it does not bin the
 * card. Deciding a villa is dead stays a person's tap, like every other terminal
 * stage in this system.
 */
export async function promoteIfQualified(
  leadId: string,
  f: ListingFacts,
): Promise<{ moved: boolean; reason: string }> {
  const verdict = meetsQualified(f);
  if (!verdict.ok) return { moved: false, reason: `not yet: ${verdict.missing.join(", ")}` };

  const lead = await getAmoLead(leadId);
  if (!lead?.pipeline_id) return { moved: false, reason: "amoCRM did not return the lead's funnel" };

  // Resolved against the funnel amoCRM says the lead is in, never our own
  // `pipeline` column — that column is exactly what lags when a human moves a
  // card, and a status id from the wrong funnel RELOCATES the lead.
  const target = await stageIdByName(lead.pipeline_id, QUALIFIED_STAGE);
  if (!target) return { moved: false, reason: `no "${QUALIFIED_STAGE}" stage in this funnel` };
  if (String(lead.status_id ?? "") === target) return { moved: false, reason: "already qualified" };

  const promotable: string[] = [];
  for (const name of PROMOTABLE_FROM) {
    const id = await stageIdByName(lead.pipeline_id, name);
    if (id) promotable.push(id);
  }
  if (!promotable.includes(String(lead.status_id ?? ""))) {
    return { moved: false, reason: `stage ${lead.status_id} is at or past QUALIFIED — left alone` };
  }

  const ok = await updateLeadStatus(leadId, Number(target));
  if (!ok) return { moved: false, reason: "amoCRM refused the stage change" };
  logger.info({ leadId, from: lead.status_id, to: target }, "listing card auto-qualified");
  return { moved: true, reason: "qualified" };
}

/**
 * Does this card's own conversation earn QUALIFIED right now?
 *
 * Exists because TWO mechanisms could put a card on that stage and only one of
 * them knew the rule. `promoteIfQualified` checks bedrooms, a price with its
 * commission position, and that we are talking to the owner. The general stage
 * classifier, applied on every send, reads the thread and picks whatever stage
 * the conversation "feels" like — and it moved two cards to QUALIFIED on the
 * strength of an owner offering to jump on a call, with no price named at all
 * and one of them renting daily only. The owner found both by opening them.
 *
 * So the funnel's own bar is enforced wherever the stage is set, not only on
 * the path that happens to know about it.
 */
export async function qualificationVerdictForLead(
  leadId: string,
): Promise<{ ok: boolean; missing: string[] } | null> {
  const res = await db.execute(sql`
    SELECT string_agg(m.sender_type || ': ' || m.text, E'\n' ORDER BY m.sent_at) AS convo
      FROM lead_messages m
     WHERE m.lead_id = ${leadId} AND m.text IS NOT NULL
  `);
  const convo = (res.rows?.[0] as { convo?: string } | undefined)?.convo ?? "";
  if (!convo.trim()) return null;
  const facts = await extractListingFacts(convo);
  if (!facts) return null;
  return meetsQualified(facts);
}

/**
 * A second opinion before a card is binned, asked as ONE question.
 *
 * `stop_kind` is one field among twelve in the extraction, and on that job the
 * model is unreliable in the direction that costs most: it read "still in
 * progress" (an owner whose last two units are being finished) and "disewakan
 * daily dan monthly" (monthly is our format) as formats we can never list, and
 * both were closed. Tightening the wording inside the big prompt did not move
 * it — re-run, same verdict.
 *
 * So the close is gated on a call that asks nothing else. A focused yes/no with
 * its counterexamples in front of it is a different, much easier task than the
 * same judgement buried in a twelve-field extraction, and it fails CLOSED: any
 * error, any unparseable answer, and the card simply stays open.
 */
async function confirmsNotOurFormat(leadId: string): Promise<boolean> {
  const res = await db.execute(sql`
    SELECT string_agg(m.sender_type || ': ' || m.text, E'\n' ORDER BY m.sent_at) AS convo
      FROM lead_messages m
     WHERE m.lead_id = ${leadId} AND m.text IS NOT NULL
  `);
  const convo = (res.rows?.[0] as { convo?: string } | undefined)?.convo ?? "";
  if (!convo.trim()) return false;

  const out = await chatCompletionJSON<{ rules_out: boolean; why: string }>({
    model: HELPER_MODEL,
    label: "listing:not-our-format-check",
    max_tokens: 200,
    temperature: 0,
    system: `We rent whole villas monthly or yearly. Answer ONE question about the conversation: has the villa side ruled out BOTH monthly AND yearly letting of the WHOLE villa, permanently?

true ONLY for a permanent, stated refusal: daily/short-stay only with no monthly offered, let by the room rather than as a whole villa, they no longer look after the property, they will not work with agencies at all.

false for everything else, including these, each of which was wrongly answered true before:
- any answer that includes monthly ("daily dan monthly", "monthly and long term") — monthly IS what we do
- a villa still being built or renovated ("still in progress", "two units left") — nothing is refused, it is not ready yet
- a period blocked by bookings or events — that passes
- "we can't do yearly" alone, when monthly was never ruled out
- anything you are unsure about

Reply with JSON only: {"rules_out": true|false, "why": "<8 words>"}`,
    messages: [{ role: "user", content: convo.slice(-6000) }],
  }).catch(() => null);

  if (!out || typeof out.rules_out !== "boolean") return false;
  logger.info({ leadId, rulesOut: out.rules_out, why: out.why }, "not-our-format second opinion");
  return out.rules_out;
}

/**
 * A parked "long term" card whose owner now says the villa is free (or free
 * within the ~3 months we treat as offerable) leaves the parking stage.
 *
 * The owner's rule (2026-09-05): "мы перешли от лонг терм к сбору деталей".
 * Everything known → Details, the stage where photos and the map pin are
 * collected. Free but still missing a fact (price, commission position) →
 * back to TAKEN TO WORK, where the bot asks for it. Nothing here moves a card
 * that is still occupied: that is what the parking stage is for.
 */
export async function releaseFromLongTerm(
  leadId: string,
  f: ListingFacts,
): Promise<{ moved: boolean; to?: string; reason: string }> {
  const res = await db.execute(
    sql`SELECT lead_stage FROM leads_sync WHERE lead_id = ${leadId}`,
  );
  const stage = String((res.rows?.[0] as { lead_stage?: string } | undefined)?.lead_stage ?? "").toLowerCase();
  if (!stage.includes("long term")) return { moved: false, reason: "not parked" };
  if (f.stopKind === "occupied") return { moved: false, reason: "still occupied" };

  const lead = await getAmoLead(leadId);
  if (!lead?.pipeline_id) return { moved: false, reason: "amoCRM did not return the lead's funnel" };
  const verdict = meetsQualified(f);
  const target = verdict.ok ? "Details" : "TAKEN TO WORK";
  const id = await stageIdByName(lead.pipeline_id, target);
  if (!id) return { moved: false, reason: `no "${target}" stage in this funnel` };
  const ok = await updateLeadStatus(leadId, Number(id));
  if (ok) {
    await db
      .update(leadsSyncTable)
      .set({ leadStage: target, leadStageId: id, listingFreeFrom: null, updatedAt: new Date() })
      .where(eq(leadsSyncTable.leadId, leadId))
      .catch(() => undefined);
    logger.info({ leadId, to: target, missing: verdict.missing }, "long term released: villa is free again");
  }
  return { moved: ok, to: target, reason: verdict.ok ? "free and qualified" : `free, still missing: ${verdict.missing.join(", ")}` };
}

// ── Where a card belongs when it is NOT going to QUALIFIED ──────────────────

const CO_BROKE_STAGE = "co-broke Agents";
const LONG_TERM_STAGE = "long term";

/** How far ahead of the free date we want to be talking again. A villa is
 *  re-let before it empties, so landing on the day itself is landing late.
 *  Two weeks is the owner's call: close enough that the conversation is about
 *  the actual handover, early enough to be first. */
const REMIND_BEFORE_DAYS = 14;

/**
 * Route a card the qualification rule turned down.
 *
 * The owner's two parking stages, and the reasoning behind each:
 *
 *   co-broke Agents — a management company or another agency holds this villa.
 *   Not thrown away, because the contact may matter later, but not worked
 *   either: the stage suppresses drafts and no task is set. Nothing to say
 *   until something changes on their side.
 *
 *   long term — the villa IS ours to take, it is simply let for six or twelve
 *   months. This is the opposite of a dead card: we thank them, we say when we
 *   will be back, and we set the task that makes that true. The stage suppresses
 *   routine chasing precisely so the ONLY thing that happens is that task.
 *
 * A card that still qualifies is never parked — a management company we have
 * agreed terms with is a listing, not a filing cabinet.
 */
export async function routeUnqualified(
  leadId: string,
  f: ListingFacts,
): Promise<{ moved: boolean; to?: string; reason: string }> {
  const lead = await getAmoLead(leadId);
  if (!lead?.pipeline_id) return { moved: false, reason: "amoCRM did not return the lead's funnel" };

  const move = async (stageName: string): Promise<boolean> => {
    const { id } = await safeStageIdForLead({ pipelineId: lead.pipeline_id!, stageId: null, stageName });
    if (!id) {
      logger.warn({ leadId, stageName }, "listing routing: stage not found in this funnel");
      return false;
    }
    if (String(lead.status_id ?? "") === id) return false;
    return updateLeadStatus(leadId, Number(id));
  };

  // WHO first. A management company or another agency holds the villa, so the
  // listing details do not change the answer: we are not taking it on our terms.
  if (f.counterpart === "manager" || f.counterpart === "agent") {
    const ok = await move(CO_BROKE_STAGE);
    return { moved: ok, to: CO_BROKE_STAGE, reason: `counterpart is ${f.counterpart}` };
  }

  // Ours, just let for a long stretch: keep it warm, and make "we'll come back"
  // a real thing rather than a polite sentence.
  if (f.stopKind === "occupied") {
    const ok = await move(LONG_TERM_STAGE);
    if (ok && f.freeFromIso) {
      // Remembered on the card so the availability-check pass can time its
      // draft from it without re-reading the whole thread. Only a date that can
      // be true: the extractor once returned 2024 for a villa "free from
      // September" — a past year, or one absurdly far out, would have produced
      // a draft telling the owner his villa frees up two years ago.
      const freeAt = new Date(`${f.freeFromIso}T09:00:00+08:00`);
      const plausible =
        freeAt.getTime() > Date.now() && freeAt.getTime() < Date.now() + 548 * 86_400_000;
      if (plausible) {
        await db
          .update(leadsSyncTable)
          .set({ listingFreeFrom: freeAt })
          .where(eq(leadsSyncTable.leadId, leadId))
          .catch(() => undefined);
      } else {
        logger.warn({ leadId, freeFromIso: f.freeFromIso }, "long term: free date implausible — not stored, no dated check");
      }
      const free = new Date(`${f.freeFromIso}T09:00:00+08:00`);
      const due = new Date(free.getTime() - REMIND_BEFORE_DAYS * 86_400_000);
      const soonest = new Date(Date.now() + 7 * 86_400_000);
      await createAmoTask(
        leadId,
        `Villa frees up around ${f.freeFromIso}. Get back in touch now, before it is re-let.`,
        due > soonest ? due : soonest,
      );
    }
    return { moved: ok, to: LONG_TERM_STAGE, reason: f.freeFromIso ? `free from ${f.freeFromIso}` : "occupied, date unknown" };
  }

  // Not a villa we can ever list on our terms, said by the owner in plain words:
  // leasehold only, daily only, three months maximum, rooms rather than the
  // whole villa, booked out with events, "we don't look after that property
  // anymore". Nothing here changes with time, so there is nothing to park and
  // nothing to chase — the ladder would spend three more messages asking for a
  // monthly rate that does not exist.
  //
  // A deliberate exception to "Closed - lost is never automatic": that rule
  // protects a JUDGEMENT about a live negotiation. This is the counterpart
  // stating the format, and the owner asked for it explicitly (04.09.2026).
  // Too cheap for any client we take. A deterministic number, not a judgement,
  // so it closes without the second opinion the format check needs.
  const quoted = clientFacingMonthlyIdr(f);
  if (quoted !== null && quoted < MIN_LISTING_MONTHLY_IDR) {
    const ok = await closeLeadAsLost(leadId);
    logger.info({ leadId, quotedIdr: quoted }, "listing closed: below the minimum we can place");
    return {
      moved: ok,
      to: "Closed - lost",
      reason: `below our floor: ${Math.round(quoted / 1_000_000)}M quoted`,
    };
  }

  if (f.stopKind === "not_our_format") {
    /**
     * Hard vetoes, decided in code, before any model is asked.
     *
     * The second opinion below makes a wrong close rare. These make the three
     * kinds of wrong close that actually happened impossible, without anyone
     * watching:
     *
     *   a price on the table  — a villa side that named a monthly or yearly
     *                           figure is negotiating, whatever else was said;
     *   a date on the table   — "available from" is an offer, not a refusal;
     *   not built yet         — "still in progress", "two units left" is a
     *                           villa that is not ready, not one being refused.
     *
     * Each of these binned a live owner on the first run of the close. A card
     * held back costs a card sitting where it already sat; a card closed wrongly
     * costs the listing.
     */
    const hasOffer = !!(f.monthlyIdr || f.yearlyIdr);
    const hasDate = !!(f.availableFrom || f.freeFromIso);
    const notReadyYet =
      /still in progress|in progress|under construction|being built|not (yet )?(finished|ready)|renovat|finishing|belum selesai|masih dibangun|sedang dibangun|proses pembangunan/i.test(
        f.stopSignal ?? "",
      );
    if (hasOffer || hasDate || notReadyYet) {
      logger.warn(
        { leadId, stopSignal: f.stopSignal, hasOffer, hasDate, notReadyYet },
        "not-our-format overruled in code: this card carries a live offer, a date, or a villa still being finished",
      );
      return { moved: false, reason: "not_our_format overruled: the card is still live" };
    }
  }
  if (f.stopKind === "not_our_format" && (await confirmsNotOurFormat(leadId))) {
    const ok = await closeLeadAsLost(leadId);
    logger.info({ leadId, stopSignal: f.stopSignal }, "listing closed: not a format we can list");
    return { moved: ok, to: "Closed - lost", reason: `not our format: ${f.stopSignal ?? "stated by the counterpart"}` };
  }

  return { moved: false, reason: "nothing to route on yet" };
}
