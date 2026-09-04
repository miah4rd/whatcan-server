import { logger } from "./logger";
import { conversationWindow } from "./dialog-parser";
import { chatCompletionJSON, HELPER_MODEL } from "./ai-client";
import { getTopPicksForBroker } from "./broker-picks-tracker";
import { allAreaNames, areaMatches, areaNamesInText, parentAreaOf, neighbourAreas } from "./bali-areas";
import { publicBaseUrl } from "./public-url";

const SUPABASE_URL = process.env["SUPABASE_URL"] ?? "";
const SUPABASE_ANON_KEY = process.env["SUPABASE_ANON_KEY"] ?? "";

/**
 * Where a HUMAN ends up: the real public site. The old workers.dev host was
 * only ever a 301 to this, and the redirect is exactly what broke WhatsApp
 * previews — the crawler followed it to a client-rendered SPA and read the
 * site's one generic Open Graph block for every villa.
 */
const SITE_HUMAN_BASE = "https://unicorn-properties.com/property";

/**
 * Where the LINK points: our own share page (routes/property-share.ts), which
 * renders this villa's real title, price and photo for the crawler and then
 * hops the human to SITE_HUMAN_BASE.
 *
 * The "/property/<ID>" path is deliberate and load-bearing — it is the shape
 * every "which listings has this lead already seen" regex reads out of
 * conversation text. Only the host changed.
 */
function shareBase(): string {
  // PROPERTY_LINK_BASE_URL is deliberately its OWN setting, not PUBLIC_BASE_URL.
  // PUBLIC_BASE_URL also makes uploaded listing PHOTOS absolute for Supabase
  // (listing-publish.ts) — those files are served by THIS server, so pointing it
  // at another host to move the share links would 404 every published photo.
  // Set this one to move only where a client's property link goes.
  const configured = (process.env["PROPERTY_LINK_BASE_URL"] ?? "").trim().replace(/\/+$/, "");
  return `${configured || publicBaseUrl()}/property`;
}

export type ListingType = "sale" | "rent";

export type SupabaseProperty = {
  id: string;
  title: string;
  /** ISO timestamp; the freshness tie-break in rankForShortlist. */
  created_at?: string | null;
  area: string | null;
  type: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  price_usd: number | null;
  leasehold_price_usd: number | null;
  monthly_price_usd: number | null;
  yearly_price_usd: number | null;
  // Rentals on Bali are priced IN rupiah — this is the real number, not a
  // conversion of the dollar one. Reading only the *_usd columns is why the bot
  // quoted dollars for a rupiah listing and treated rupiah-priced villas as
  // having no price at all.
  monthly_price_idr: number | null;
  yearly_price_idr: number | null;
  ownership: string | null;
  status: string | null;
  zone: string | null;
  views: number | null;
  purpose: string | null;
  listing_type: ListingType | null;
  // Style and character. A lead saying "modern / luxury" had nothing to match
  // against while these went unread: the matcher only ever saw area, bedrooms
  // and price, so it judged the request far more shallowly than it needed to.
  features: string[] | null;
  description: string | null;
  /** Set when the villa is occupied today: the first date it is free again.
   *  Null means free now. Filled from property_availability, never from Supabase. */
  free_from?: string | null;
};

export type PropertyMatch = {
  id: string;
  title: string;
  area: string | null;
  type: string | null;
  bedrooms: number | null;
  priceUsd: number | null;
  ownership: string | null;
  zone: string | null;
  url: string;
};

// ── Simple in-memory cache (10 min TTL) ───────────────────────────────────
let _cache: SupabaseProperty[] | null = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Drops the catalog cache. Called on every broker revision: "у нас новые
 * листинги, посмотри на сайте" hit a 10-minute-old cache, so the very listings
 * the broker had just added were invisible and the bot fell back to
 * re-qualifying the client instead of offering them.
 */
/**
 * The rentals that are actually on the site — published, not drafts.
 *
 * `fetchAllProperties` already filters `is_draft=false`, so membership here is
 * the answer to "do we really carry this villa?". Anything relying on an
 * amoCRM stage to answer that is trusting a field a human moves by hand.
 */
export async function publishedRentals(): Promise<SupabaseProperty[]> {
  const all = await fetchAllProperties();
  return all.filter((p) => p.listing_type === "rent");
}

export function invalidatePropertyCache(): void {
  _cacheAt = 0;
}

async function fetchAllProperties(): Promise<SupabaseProperty[]> {
  const now = Date.now();
  if (_cache && now - _cacheAt < CACHE_TTL_MS) return _cache;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    logger.warn("SUPABASE_URL or SUPABASE_ANON_KEY not set — property catalog unavailable");
    return [];
  }

  const url =
    `${SUPABASE_URL}/rest/v1/properties` +
    `?select=id,title,area,type,bedrooms,bathrooms,price_usd,leasehold_price_usd,monthly_price_usd,yearly_price_usd,monthly_price_idr,yearly_price_idr,ownership,status,zone,views,purpose,listing_type,features,description,created_at` +
    `&is_draft=eq.false` +
    `&status=neq.sold` +
    `&order=created_at.desc`;

  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
  });

  if (!res.ok) {
    logger.error({ status: res.status }, "Supabase properties fetch failed");
    return _cache ?? [];
  }

  const data = (await res.json()) as SupabaseProperty[];
  const withAvailability = await applyAvailability(data);
  _cache = withAvailability;
  _cacheAt = now;
  logger.info({ count: withAvailability.length }, "property catalog refreshed from Supabase");
  return withAvailability;
}

/**
 * How far ahead a villa that is busy today still counts as an option.
 *
 * The brokers' own model (Yudi, 2026-08-18): a villa is either free, or free
 * from a date. Within three months that is a real option a client will wait
 * for; beyond it, it is effectively rented and must not be offered — a lead
 * looking to move in next week was shown villas taken until August 2027.
 */
const FREE_FROM_HORIZON_DAYS = 92;

/**
 * Attach "free from" dates from property_availability, and drop the villas
 * whose date is beyond the horizon.
 *
 * The site hides those in its own UI, but that is a front-end filter: the
 * database still hands every non-draft villa to anyone reading it, and the bot
 * reads the database. So the same rule has to live here too, or the bot keeps
 * offering what the website already refuses to show.
 */
async function applyAvailability(rows: SupabaseProperty[]): Promise<SupabaseProperty[]> {
  let periods: Array<{ property_id: string; end_date: string | null }> = [];
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/property_availability?select=property_id,status,start_date,end_date`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } },
    );
    if (res.ok) periods = (await res.json()) as typeof periods;
    else logger.warn({ status: res.status }, "availability fetch failed — treating every villa as free");
  } catch (err) {
    // Never let this break the catalog: a villa wrongly offered is a bad day,
    // an empty shortlist is a broker with nothing to send at all.
    logger.warn({ err }, "availability fetch threw — treating every villa as free");
    return rows;
  }
  if (periods.length === 0) return rows;

  const today = new Date();
  const todayMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());

  // Latest end date per villa among periods still running today.
  const freeFrom = new Map<string, number>();
  for (const p of periods) {
    if (!p.end_date) continue;
    const end = Date.parse(`${p.end_date}T00:00:00Z`);
    if (Number.isNaN(end) || end < todayMs) continue;
    const cur = freeFrom.get(p.property_id);
    if (cur === undefined || end > cur) freeFrom.set(p.property_id, end);
  }
  if (freeFrom.size === 0) return rows;

  // Stamped, never dropped. The site shows every listing now and marks the
  // far-out ones red rather than hiding them, so a lead CAN be looking at one
  // and ask about it — and a catalog that had deleted it could not even say
  // when it frees up. Offerability is decided per shortlist instead
  // (offerableNow), which is the only place it actually matters.
  return rows.map((row) => {
    const end = freeFrom.get(row.id);
    if (end === undefined) return row;
    // Free the day AFTER the occupancy ends.
    return { ...row, free_from: new Date(end + 24 * 60 * 60 * 1000).toISOString().slice(0, 10) };
  });
}

/**
 * May this villa be put in a shortlist TODAY?
 *
 * Free now, or free within the horizon. Beyond it the villa is effectively
 * rented: the website marks it red precisely as a signal not to offer it, and a
 * client looking to move in this month will not wait a year. It stays in the
 * catalog so the bot can still answer a direct question about it.
 */
export function offerableNow(p: SupabaseProperty, now: Date = new Date()): boolean {
  if (!p.free_from) return true;
  const free = Date.parse(`${p.free_from}T00:00:00Z`);
  if (Number.isNaN(free)) return true;
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return free <= todayMs + FREE_FROM_HORIZON_DAYS * 24 * 60 * 60 * 1000;
}

function effectivePriceUsd(p: SupabaseProperty): number | null {
  const v = p.price_usd && p.price_usd > 1000 ? p.price_usd : null;
  const lv = p.leasehold_price_usd && p.leasehold_price_usd > 1000 ? p.leasehold_price_usd : null;
  return v ?? lv;
}

function formatPrice(p: SupabaseProperty): string | null {
  const price = effectivePriceUsd(p);
  if (!price) return null;
  if (price >= 1_000_000) return `$${(price / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (price >= 1_000) return `$${Math.round(price / 1_000)}K`;
  return `$${price}`;
}

/**
 * A short, style-bearing summary so the matcher can honour "modern", "luxury",
 * "minimalist", "jungle" and the like. Features first (they are already short
 * labels like "Contemporary Tropical Design"), then a slice of the description.
 */
function styleHint(p: SupabaseProperty): string {
  const feats = (p.features ?? []).filter((f) => typeof f === "string").slice(0, 5).join(", ");
  const descr = (p.description ?? "").replace(/\s+/g, " ").trim().slice(0, 130);
  const parts = [feats, descr].filter(Boolean);
  return parts.length ? `style: ${parts.join(" — ")}` : "";
}

/**
 * The price exactly as a client should read it. Shared by the catalog line the
 * matcher sees and by the share page a client sees on WhatsApp — the two must
 * never disagree about what a villa costs.
 */
export function priceLabel(p: SupabaseProperty): string | null {
  const freePrice = p.price_usd && p.price_usd > 1000 ? `freehold $${Math.round(p.price_usd / 1000)}K` : null;
  const leasePrice = p.leasehold_price_usd && p.leasehold_price_usd > 1000 ? `leasehold $${Math.round(p.leasehold_price_usd / 1000)}K` : null;
  // Rentals are quoted in rupiah — the same number the site and the owner use.
  // Spelled out, not as "jt": that is Indonesian "juta" (million) and it goes
  // straight into the message an international client reads, where it means
  // nothing. The broker had to ask what it stood for.
  const jt = (v: number) => {
    if (v >= 1_000_000_000) {
      const b = v / 1_000_000_000;
      return `Rp ${b % 1 === 0 ? b.toFixed(0) : b.toFixed(1)} billion`;
    }
    const m = v / 1_000_000;
    return `Rp ${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)} million`;
  };
  const monthlyPrice =
    p.monthly_price_idr && p.monthly_price_idr > 0
      ? `${jt(p.monthly_price_idr)}/mo`
      : p.monthly_price_usd && p.monthly_price_usd > 0
        ? `$${Math.round(p.monthly_price_usd)}/mo`
        : null;
  const yearlyPrice =
    p.yearly_price_idr && p.yearly_price_idr > 0
      ? `${jt(p.yearly_price_idr)}/yr`
      : p.yearly_price_usd && p.yearly_price_usd > 0
        ? `$${Math.round(p.yearly_price_usd)}/yr`
        : null;
  // A rental listing may also carry its SALE price. Quoting "$250K" to someone
  // renting for a year is both irrelevant and in the wrong currency.
  return (
    (p.listing_type === "rent"
      ? [monthlyPrice, yearlyPrice]
      : [freePrice, leasePrice, monthlyPrice, yearlyPrice]
    )
      .filter(Boolean)
      .join(" / ") || null
  );
}

function summaryLine(p: SupabaseProperty): string {
  const priceStr = priceLabel(p);
  const parts: string[] = [
    `[${p.id}]`,
    p.area ?? "",
    p.bedrooms ? `${p.bedrooms}BR` : "",
    p.ownership ?? "",
    priceStr ?? "",
    p.purpose ? `(${p.purpose})` : "",
    p.views ? `${p.views} views` : "",
    propertyUrlById(p.id),
  ].filter(Boolean);
  return parts.join(" | ");
}

export async function getPropertyCatalogSummary(limit = 50, listingType?: ListingType): Promise<string> {
  const all = await fetchAllProperties();
  if (all.length === 0) return "";

  const filtered = listingType ? all.filter((p) => p.listing_type === listingType) : all;
  // Pass only the top N by views — keeps the AI prompt focused and filtering reliable
  const props = filtered.slice(0, limit);

  return props.map(summaryLine).join("\n");
}

// ── Signal-based property matching ──────────────────────────────────────────

export type PropertyPick = { id: string; title: string; url: string; label: string };

// Matches known catalog ID formats seen in production: "UP-1001", "R-SAI-023", "R-YUD-2026"
const PROPERTY_ID_REGEX = /\b([A-Z]{1,4}-[A-Z0-9-]+)\b/g;

/**
 * The site already shows every listing in rupiah by default — that is the
 * currency Bali rents in, and it's what the page renders with no parameter at
 * all (verified: R-CGU-002 shows "Rp 88M / month" on a bare URL). The bot used
 * to append ?currency=IDR, which was noise; the dollars the broker saw came
 * from OUR OWN label, built from the *_usd columns, not from the site.
 */
function propertyUrl(p: SupabaseProperty): string {
  return propertyUrlById(p.id);
}

/**
 * The same link by bare id, for a listing we have only just created and which
 * is therefore not in any cached catalog yet. Exported so nothing has to
 * hardcode SITE_BASE a second time — the base has already moved once.
 */
export function propertyUrlById(id: string): string {
  return `${shareBase()}/${id}`;
}

/** Where the share page sends a human. */
export function humanPropertyUrl(id: string): string {
  return `${SITE_HUMAN_BASE}/${encodeURIComponent(id)}`;
}

// ── Share card ──────────────────────────────────────────────────────────────

export type PropertyShareCard = {
  id: string;
  title: string;
  area: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  priceLabel: string | null;
  description: string | null;
  image: string | null;
};

const shareCache = new Map<string, { at: number; card: PropertyShareCard | null }>();
const SHARE_TTL_MS = 5 * 60 * 1000;

/**
 * One listing, WITH its photo, for the WhatsApp preview card.
 *
 * Deliberately not served from the main catalog cache: that one omits `images`
 * (twenty URLs per row would bloat every prompt it feeds) and it excludes
 * drafts and sold stock. A link already sent to a client must keep rendering
 * a real card even after the villa goes off-market — a blank preview on an old
 * message reads as a dead link.
 */
export async function fetchPropertyForShare(id: string): Promise<PropertyShareCard | null> {
  const key = id.trim().toUpperCase();
  if (!key) return null;

  const hit = shareCache.get(key);
  if (hit && Date.now() - hit.at < SHARE_TTL_MS) return hit.card;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;

  const url =
    `${SUPABASE_URL}/rest/v1/properties` +
    `?select=id,title,area,type,bedrooms,bathrooms,price_usd,leasehold_price_usd,monthly_price_usd,yearly_price_usd,monthly_price_idr,yearly_price_idr,ownership,status,zone,views,purpose,listing_type,features,description,images,created_at` +
    `&id=eq.${encodeURIComponent(key)}&limit=1`;

  const res = await fetch(url, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  if (!res.ok) {
    logger.error({ status: res.status, id: key }, "share card fetch failed");
    return null;
  }

  const rows = (await res.json()) as (SupabaseProperty & { images: string[] | null })[];
  const row = rows[0];
  const card: PropertyShareCard | null = row
    ? {
        id: row.id,
        title: row.title,
        area: row.area,
        bedrooms: row.bedrooms,
        bathrooms: row.bathrooms,
        priceLabel: priceLabel(row),
        description: row.description,
        image: (row.images ?? []).find((u) => typeof u === "string" && u.trim()) ?? null,
      }
    : null;

  shareCache.set(key, { at: Date.now(), card });
  return card;
}

/** "free from 30 Aug" — what the client must be told about a villa still occupied. */
export function freeFromLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `free from ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}

function toPick(p: SupabaseProperty): PropertyPick {
  const priceBit = summaryLine(p).split(" | ").slice(1, -1).join(", ");
  // Spelled out on the label, because everything downstream reads the label and
  // silence about the price is what let a figure be invented for it.
  const noPrice = priceOf(p) === 0 ? ", price on request" : "";
  // Same reasoning for the move-in date: the label is what the writer sees, so
  // a villa that is still occupied has to say so there, or the reply offers it
  // as if the client could move in tomorrow.
  const free = freeFromLabel(p.free_from);
  const freeBit = free ? `, ${free}` : "";
  return {
    id: p.id,
    title: p.title,
    url: propertyUrl(p),
    label: `${p.title} (${priceBit}${noPrice}${freeBit})`.slice(0, 180),
  };
}

/** Public wrapper — the route needs a pick built the same way the matcher builds them. */
export function toPickPublic(p: SupabaseProperty): PropertyPick {
  return toPick(p);
}

/**
 * Picks 0-limit best-fitting properties for a lead, in priority order:
 * 1. A specific listing already mentioned in the conversation (explicit signal — no AI needed).
 * 2. AI-assisted semantic match against the lead's stated needs, softly boosted by
 *    this broker's historically frequent picks (personalization, not a hard override).
 * Never mixes listing_type — sale and rent are filtered apart before any matching.
 */

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  один: 1, одна: 1, две: 2, два: 2, три: 3, четыре: 4, пять: 5,
};

/**
 * Regex fallback for extractLeadCriteria — used only when the AI extraction
 * call itself fails (network/API error), so a shortlist can still be built
 * instead of falling over completely. Kept deliberately dumb: it only needs
 * to not crash, not to be right about every phrasing — that's the AI path's
 * job now.
 */
function extractLeadCriteriaRegex(
  recentLeadMessages: string[],
  pool: SupabaseProperty[],
): { areas: string[]; bedrooms: number | null; bedroomsMax: number | null } {
  const areaVocab = [...new Set([...allAreaNames(), ...pool.map((p) => (p.area ?? "").trim())])]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const areas: string[] = [];
  let bedrooms: number | null = null;
  let bedroomsMax: number | null = null;

  for (const raw of recentLeadMessages) {
    const lower = (raw ?? "").toLowerCase();
    if (!lower) continue;

    for (const a of areaVocab) {
      if (lower.includes(a.toLowerCase()) && !areas.some((x) => x.toLowerCase() === a.toLowerCase())) {
        areas.push(a);
      }
    }
    for (const a of areaNamesInText(lower)) {
      if (!areas.some((x) => x.toLowerCase() === a.toLowerCase())) areas.push(a);
    }

    if (bedrooms === null) {
      const range = lower.match(/(\d+)\s*(?:bed\b|beds\b|br\b|bedroom|bedrooms|спал)?\s*(?:-|–|to|or|или|до)\s*(\d+)\s*(?:bed\b|beds\b|br\b|bedroom|bedrooms|спал)/);
      if (range?.[1] && range?.[2]) {
        const a = parseInt(range[1], 10);
        const b = parseInt(range[2], 10);
        bedrooms = Math.min(a, b);
        bedroomsMax = Math.max(a, b);
      }
    }
    if (bedrooms === null) {
      const digit = lower.match(/(\d+)\s*-?\s*(?:bed\b|beds\b|br\b|bedroom|bedrooms|спал)/);
      if (digit?.[1]) {
        bedrooms = parseInt(digit[1], 10);
      } else {
        const word = lower.match(/(one|two|three|four|five|six|один|одна|две|два|три|четыре|пять)\s+(?:bed|bedroom|спал)/);
        if (word?.[1]) bedrooms = WORD_NUMBERS[word[1]] ?? null;
      }
    }

    if (areas.length > 0 && bedrooms !== null) break;
  }

  return { areas, bedrooms, bedroomsMax };
}

/**
 * Pull the lead's CURRENT area / bedroom requirements out of their own recent
 * messages, newest first, so a mid-conversation change wins outright.
 *
 * Reading what someone asked for is exactly the kind of thing a model is good
 * at — this used to be regex, and every new way of phrasing a range ("1BR or
 * 2BR" vs "3 or 4 bedrooms" vs "1-2 bedroom") needed its own pattern added by
 * hand, forever. What stays code is what happens AFTER extraction: the
 * min/max filter, the budget ceiling/floor, never inventing a price — the
 * places this codebase has repeatedly found the model can understand a rule
 * correctly and still not apply it. Reading intent and enforcing a limit are
 * different jobs; only the second one needs to be code.
 */
async function extractLeadCriteria(
  recentLeadMessages: string[],
  pool: SupabaseProperty[],
): Promise<{ areas: string[]; bedrooms: number | null; bedroomsMax: number | null }> {
  const nonEmpty = recentLeadMessages.filter((m) => (m ?? "").trim());
  if (nonEmpty.length === 0) return { areas: [], bedrooms: null, bedroomsMax: null };

  // Vocabulary is the site's own area list (parents AND sub-areas), not just the
  // strings that happen to appear in the catalog — a lead saying "Uluwatu" must
  // be understood even when every Uluwatu listing is tagged Pecatu or Bingin.
  const areaVocab = [...new Set([...allAreaNames(), ...pool.map((p) => (p.area ?? "").trim())])].filter(Boolean);

  try {
    const result = await chatCompletionJSON<{
      areas?: string[];
      bedrooms_min?: number | null;
      bedrooms_max?: number | null;
    }>({
      model: HELPER_MODEL,
      label: "lead-criteria",
      system: `You read a real-estate client's own messages (or a broker's instruction about them) and extract what property they're asking for. Messages are listed NEWEST FIRST — if the requirement changed partway through the conversation ("actually, let's look at Uluwatu instead"), the newest statement wins outright over anything said earlier.

Valid area names (use these spellings, nothing else — map whatever the client said to the closest match, or omit if nothing matches):
${areaVocab.join(", ")}

Return JSON with exactly these keys:
- "areas": array of area names from the list above the client wants, newest statement wins. Empty if none mentioned.
- "bedrooms_min": the bedroom count they asked for. If they gave a range ("1-2BR", "1BR or 2BR", "one to two bedrooms", "studio to 1BR" → 0), this is the LOWER end. If they gave one number, this is that number. Null if no bedroom count was stated.
- "bedrooms_max": the UPPER end of a stated range. Null when they gave a single number, not a range.

Be literal — do not infer a count or area the client didn't actually say.`,
      messages: [{ role: "user", content: nonEmpty.slice(0, 10).join("\n---\n").slice(0, 3000) }],
      max_tokens: 200,
      temperature: 0,
    });

    const areas = (result.areas ?? [])
      .map((a) => areaVocab.find((k) => k.toLowerCase() === String(a).toLowerCase()))
      .filter((a): a is string => !!a);
    const min =
      typeof result.bedrooms_min === "number" && result.bedrooms_min > 0 ? Math.round(result.bedrooms_min) : null;
    const max =
      typeof result.bedrooms_max === "number" && result.bedrooms_max > 0 ? Math.round(result.bedrooms_max) : null;

    return {
      areas,
      bedrooms: min,
      // A max below the min, or a max with no min, isn't a valid range — treat
      // it as if only one number was given rather than passing along garbage.
      bedroomsMax: min !== null && max !== null && max > min ? max : null,
    };
  } catch (err) {
    logger.warn({ err }, "extractLeadCriteria: AI extraction failed, falling back to pattern matching");
    return extractLeadCriteriaRegex(recentLeadMessages, pool);
  }
}

/**
 * How much stock actually exists for what the lead just asked for.
 *
 * Deterministic and cheap (cached catalog, no AI), so the reply can be written
 * KNOWING the answer instead of promising a shortlist that doesn't exist. A
 * lead asking for "Seminyak only" got "I've got a few in mind" while the
 * catalog held zero Seminyak listings — the matcher knew, the message didn't,
 * because the two run in parallel.
 */
export async function availabilityForCriteria(opts: {
  listingType: ListingType;
  recentLeadMessages: string[];
}): Promise<{ areas: string[]; bedrooms: number | null; matching: number; nearbyAreas: string[] } | null> {
  const all = await fetchAllProperties();
  // The stock line tells the client what we can offer them, so it must count
  // only what is actually offerable — a villa free in a year is not stock.
  const pool = all.filter((p) => p.listing_type === opts.listingType && offerableNow(p));
  if (pool.length === 0) return null;

  const { areas, bedrooms, bedroomsMax } = await extractLeadCriteria(opts.recentLeadMessages, pool);
  if (areas.length === 0 && bedrooms === null) return null;

  let matching = pool;
  if (areas.length > 0) {
    // Hierarchy-aware: "Uluwatu" must count listings tagged Pecatu, Bingin, etc.
    matching = matching.filter((p) => areaMatches(p.area, areas));
  }
  if (bedrooms !== null) {
    // A stated range ("1-2BR") counts stock across the whole range — exact-match
    // here undercounted a range down to just its floor, so the prompt told the
    // model "not much stock" while the shortlist below it (matchProperties,
    // which does read the range) filled fine.
    matching =
      bedroomsMax !== null
        ? matching.filter((p) => p.bedrooms !== null && p.bedrooms >= bedrooms && p.bedrooms <= bedroomsMax)
        : matching.filter((p) => p.bedrooms === bedrooms);
  }

  // What we could honestly OFFER instead when their area comes up empty: the
  // same size in a genuinely adjacent district. Offered in words only — the
  // shortlist stays empty, nothing from another area rides along unasked.
  const sizeFits = (p: SupabaseProperty) =>
    bedrooms === null ||
    (bedroomsMax !== null
      ? p.bedrooms !== null && p.bedrooms >= bedrooms && p.bedrooms <= bedroomsMax
      : p.bedrooms === bedrooms);
  const nearby =
    matching.length === 0 && areas.length > 0
      ? [...new Set(areas.flatMap((a) => neighbourAreas(a)))].filter((n) =>
          pool.some((p) => areaMatches(p.area, [n]) && sizeFits(p)),
        )
      : [];

  return { areas, bedrooms, matching: matching.length, nearbyAreas: nearby.slice(0, 6) };
}

/**
 * A listing with no price can't be judged by the client and can't answer the
 * question a shortlist exists to answer. It's held back from the first
 * shortlist entirely — priced stock goes out first, and an unpriced villa only
 * appears when there genuinely isn't enough priced stock to offer a choice.
 */
function hasPrice(p: SupabaseProperty): boolean {
  return p.listing_type === "rent"
    ? (p.monthly_price_idr ?? 0) > 0 ||
        (p.yearly_price_idr ?? 0) > 0 ||
        (p.monthly_price_usd ?? 0) > 0 ||
        (p.yearly_price_usd ?? 0) > 0
    : (p.price_usd ?? 0) > 0 || (p.leasehold_price_usd ?? 0) > 0;
}

/** Comparable monthly figure for rentals, headline price for sales. */
export function priceOf(p: SupabaseProperty): number {
  if (p.listing_type === "rent") {
    // Rupiah only — every rental that carries a dollar figure carries the rupiah
    // one too, so the tiers compare like with like and nothing is converted.
    if ((p.monthly_price_idr ?? 0) > 0) return p.monthly_price_idr!;
    if ((p.yearly_price_idr ?? 0) > 0) return Math.round(p.yearly_price_idr! / 12);
    return 0;
  }
  return p.price_usd || p.leasehold_price_usd || 0;
}

/**
 * Priced first, then cheapest first, then newest first. NOT by views.
 *
 * Views used to be the tie-break, and it turned the catalog into a closed
 * loop: a villa gets sent, gets viewed, ranks higher, gets sent again. Eleven
 * 2BR villas in Pererenan and Seseh went live on 2026-09-02 — the exact brief
 * thirteen leads gave that week — and the matcher put them at the bottom of
 * every shortlist while a 3BR in Balangan at Rp 77M (814 views) went out ten
 * times to people who had asked for Pererenan under 50. Popularity is not fit.
 * By the time this ranks, candidates are already filtered to the client's
 * area, bedrooms and budget, so price order is the honest order: the cheapest
 * fit first, and among equals the villa the client has not been shown yet.
 */
function rankForShortlist(a: SupabaseProperty, b: SupabaseProperty): number {
  const byPrice = (hasPrice(a) ? 0 : 1) - (hasPrice(b) ? 0 : 1);
  if (byPrice !== 0) return byPrice;
  const pa = priceOf(a), pb = priceOf(b);
  if (pa > 0 && pb > 0 && pa !== pb) return pa - pb;
  return (b.created_at ?? "").localeCompare(a.created_at ?? "");
}

/**
 * The lead's monthly budget in rupiah, from how people actually write it:
 * "30 million", "30jt", "30 juta", "Rp 30.000.000", "30 млн". Only meaningful
 * for rentals, and only now that the catalog carries the rupiah price — before
 * that there was nothing to compare a budget against, which is how a client who
 * said 30 million was shown villas at 55.
 */
export function extractBudgetIdr(messages: string[]): number | null {
  // "750mill / year" is a yearly figure — read as monthly it became a 750M/month
  // ceiling, which let anything through. Bali quotes both, so the period matters.
  const PER_YEAR = /\/\s*year|per\s*year|a\s*year|\/\s*yr\b|yearly|annual|в\s*год|годов/i;
  // "15-18mln per month. Yearly contract" — PER_YEAR alone matched "Yearly"
  // and divided an already-monthly rate by 12 (18M -> 1.5M), because "yearly"
  // described the CONTRACT LENGTH, not the price's period; the same message
  // also says "per month" outright. An explicit monthly marker in the same
  // message always wins over a bare "yearly"/"annual" elsewhere in it.
  const PER_MONTH = /\/\s*month|per\s*month|a\s*month|\/\s*mo\b|monthly|в\s*месяц|ежемесячно/i;

  for (const raw of messages) {
    const m = raw.toLowerCase();
    const perYear = PER_YEAR.test(m) && !PER_MONTH.test(m);
    // People quoting a yearly figure often drop the "per year": Lukass wrote
    // "anything around 700 million or less" about a 3-year lease and the parser
    // read it as 700M PER MONTH — a ceiling that passes the entire island, so
    // villas at 900M/yr led his "within budget" shortlist. No Bali monthly rent
    // is 200M+; a figure that size without a period marker is a yearly one.
    const toMonthly = (n: number) =>
      Math.round(perYear ? n / 12 : n > 200_000_000 ? n / 12 : n);

    // "30 million" / "750mill" / "30jt" / "30 juta" / "40 млн" — plus the ad
    // form's bare-M shorthand ("Budget: 20-50M IDR/month"), which parsed to
    // NOTHING, so Alex's 20-50M ceiling was invisible and villas at 55 and 88
    // led his shortlist. The bare M only counts in a money context, so "500m
    // from the beach" stays a distance.
    const moneyContext = /idr|rp\b|rupiah|budget|бюджет|price|цен/i.test(m);
    const short =
      m.match(/(\d[\d.,]*)\s*(jt\b|juta|mio\b|mln\b|mill(?:ion)?s?\b|млн|миллион)/) ??
      (moneyContext ? m.match(/(\d[\d.,]*)\s*(m)\b/) : null);
    if (short?.[1]) {
      const n = parseFloat(short[1].replace(/[.,](?=\d{3}\b)/g, "").replace(",", "."));
      if (n > 0 && n < 100000) return toMonthly(n * 1_000_000);
    }

    // "30,000,000-50,000,000 IDR/mo" — a dash-separated range written in raw
    // digits, not "30-50 million" words. The word-range above reads as the
    // ceiling by accident (only the second number sits next to "million"),
    // but the single-number match below stops at the dash and silently
    // returned the FLOOR: a lead who stated 30-50 million got budget=30M,
    // read as under a 40M threshold, and the rental budget gate auto-closed
    // her — reopened by the broker, then closed again on the next pass,
    // because nothing about the (wrong) parse ever changed. Take the larger
    // side, same as the word-based range does.
    if (/rp|idr|rupiah/.test(m)) {
      const range = m.match(/(\d[\d\s.,]{6,})\s*(?:-|–|—|to|до)\s*(\d[\d\s.,]{6,})/);
      if (range?.[1] && range[2]) {
        const a = parseInt(range[1].replace(/[^\d]/g, ""), 10);
        const b = parseInt(range[2].replace(/[^\d]/g, ""), 10);
        if (a >= 1_000_000 && a < 100_000_000_000 && b >= 1_000_000 && b < 100_000_000_000) {
          return toMonthly(Math.max(a, b));
        }
      }
    }

    // "Rp 30.000.000" / "30 000 000 idr"
    const full = m.match(/(?:rp\.?\s*|idr\s*)?(\d[\d\s.,]{6,})\s*(?:idr|rupiah|rp\b)?/);
    if (full?.[1] && /rp|idr|rupiah/.test(m)) {
      const n = parseInt(full[1].replace(/[^\d]/g, ""), 10);
      if (n >= 1_000_000 && n < 100_000_000_000) return toMonthly(n);
    }
  }
  return null;
}

/**
 * The FLOOR of a stated range, e.g. "40-50 million" — extractBudgetIdr reads
 * that same sentence and returns 50 (the ceiling), which is the right number
 * for "don't show anything over budget". But it silently drops the 40: Ani
 * Vit's form said "Budget: IDR 40-50 million/month" and the shortlist filled
 * two of three slots with villas at 23 and 28.6 million — correctly UNDER the
 * ceiling, so nothing rejected them, and a broker's own edit repeating "stay
 * in that range" still didn't move them, because the code had nowhere to hold
 * a floor at all. Returns null when the lead gave a single figure, not a
 * range — a bare ceiling is not a promise they won't accept cheaper.
 */
export function extractBudgetFloorIdr(messages: string[]): number | null {
  const PER_YEAR = /\/\s*year|per\s*year|a\s*year|\/\s*yr\b|yearly|annual|в\s*год|годов/i;
  // "15-18mln per month. Yearly contract" — PER_YEAR alone matched "Yearly"
  // and divided an already-monthly rate by 12 (18M -> 1.5M), because "yearly"
  // described the CONTRACT LENGTH, not the price's period; the same message
  // also says "per month" outright. An explicit monthly marker in the same
  // message always wins over a bare "yearly"/"annual" elsewhere in it.
  const PER_MONTH = /\/\s*month|per\s*month|a\s*month|\/\s*mo\b|monthly|в\s*месяц|ежемесячно/i;
  const RANGE_SEP = /\s*(?:-|–|—|to|до)\s*/;

  for (const raw of messages) {
    const m = raw.toLowerCase();
    const perYear = PER_YEAR.test(m) && !PER_MONTH.test(m);
    const toMonthly = (n: number) =>
      Math.round(perYear ? n / 12 : n > 200_000_000 ? n / 12 : n);

    const moneyContext = /idr|rp\b|rupiah|budget|бюджет|price|цен/i.test(m);
    const range = new RegExp(
      String.raw`(\d[\d.,]*)${RANGE_SEP.source}(\d[\d.,]*)\s*(jt\b|juta|mio\b|mln\b|mill(?:ion)?s?\b|млн|миллион)`,
    ).exec(m) ??
      (moneyContext
        ? new RegExp(String.raw`(\d[\d.,]*)${RANGE_SEP.source}(\d[\d.,]*)\s*(m)\b`).exec(m)
        : null);
    if (range?.[1] && range[2]) {
      const parse = (raw: string) => parseFloat(raw.replace(/[.,](?=\d{3}\b)/g, "").replace(",", "."));
      const a = parse(range[1]);
      const b = parse(range[2]);
      if (a > 0 && b > 0 && a < 100000 && b < 100000) {
        // The period that counts is the one written NEXT TO the range, not
        // anywhere in the message. "Rp 200-400 million/year (up to ~33 jt/month)"
        // carries both markers; judged per message, "per month" won and the
        // yearly range became a 200M MONTHLY floor — above every villa on the
        // island, so the pool came back empty and a broker's "attach the links"
        // shipped a text describing villas with no links six times in a row.
        const tail = m.slice((range.index ?? 0) + range[0].length, (range.index ?? 0) + range[0].length + 14);
        const rangeIsYearly = PER_YEAR.test(tail) || perYear;
        const low = Math.min(a, b) * 1_000_000;
        return Math.round(rangeIsYearly ? low / 12 : low > 200_000_000 ? low / 12 : low);
      }
    }
  }
  return null;
}

/**
 * The broker asking us to stop restricting the search.
 *
 * A broker instruction could previously only ADD a criterion, never lift one:
 * the area filter took "Uluwatu" from the lead's own messages and narrowed the
 * candidates before the model saw anything, so "there is nothing in her budget
 * there, look in other areas" changed nothing — the model was still choosing
 * from Uluwatu alone. Being ignored on a direct instruction is worse than a bad
 * shortlist, so this is read deterministically and releases the filter.
 */
const BROKER_RELEASES_AREA =
  /(other|another|different|wider|any)\s+(area|areas|location|locations|zone)|elsewhere|anywhere else|(drop|forget|ignore|beyond|outside)[^.]{0,20}(area|location)|не фокусируйся|в других районах|другие районы|другой район|другом районе|не важен район|шире по район|расширь.{0,15}район|посмотри.{0,20}других/i;

/**
 * Reads the broker's revision into a structured intent.
 *
 * Every phrasing used to be matched by regex, which meant a command only worked
 * if the broker happened to use the expected words: "look in other areas" was
 * honoured, "don't focus on this area" was silently ignored. That reads as the
 * bot refusing to listen, and no amount of added patterns fixes the next
 * phrasing. So the instruction is PARSED, and the code then applies it — the
 * broker's own words outrank the criteria derived from the lead.
 *
 * Falls back to the regexes when the call fails; a broken parse must not mean a
 * broken shortlist.
 */
export type BrokerIntent = {
  releaseArea: boolean;
  areas: string[];
  bedrooms: number | null;
  /** Upper end of a stated range ("1-2BR" -> 2), null when the broker named a
   * single count. Without this, a broker restating a range during an edit
   * ("client wants 1 to 2 bedrooms") collapsed straight back to one number —
   * this field only exists so that can't happen again. */
  bedroomsMax: number | null;
  budgetIdrMonthly: number | null;
  listingsUnchanged: boolean;
  /** The broker wants this message to go out with NO property links at all —
   * they are asking the client for something first ("tell me your budget and
   * I'll find suitable options"). Keeping the links attached made the reply
   * present villas in the very message that says it cannot pick them yet. */
  sendNoListings: boolean;
};

/** Area names the classifier may choose from — the site's list plus whatever the catalog actually uses. */
export async function allAreaVocabulary(): Promise<string[]> {
  const all = await fetchAllProperties().catch(() => [] as SupabaseProperty[]);
  return [...new Set([...allAreaNames(), ...all.map((p) => (p.area ?? "").trim())])].filter(Boolean);
}

export async function parseBrokerIntent(
  instruction: string,
  knownAreas: string[],
): Promise<BrokerIntent | null> {
  try {
    const result = await chatCompletionJSON<{
      release_area?: boolean;
      send_no_listings?: boolean;
      areas?: string[];
      bedrooms?: number | null;
      bedrooms_max?: number | null;
      budget_idr_monthly?: number | null;
      listings_unchanged?: boolean;
    }>({
      model: HELPER_MODEL,
      label: "broker-intent",
      system: `You read one instruction a real-estate broker just gave about the property links attached to a draft message, and turn it into a filter. The instruction may be in any language, often dictated by voice, and may be untidy.

Valid area names (use these spellings, nothing else):
${knownAreas.join(", ")}

Return JSON with exactly these keys:
- "release_area": true when the broker wants the search to STOP being restricted to the area the client named (e.g. "don't focus on this area", "nothing fits there, look elsewhere", "widen the search"). False otherwise.
- "areas": the areas they want searched, as an array of names from the list above. Empty when they named none.
- "bedrooms": the bedroom count they asked for. If they named a RANGE ("1-2BR", "1 to 2 bedrooms"), this is the LOWER end.
- "bedrooms_max": the UPPER end of a stated range. Null when they named a single count, not a range.
- "budget_idr_monthly": a budget the broker is telling you to FILTER BY, in rupiah, as a plain number ("show her something around 40 million" → 40000000). A yearly figure divided by 12. Never a dollar amount. Null when the broker is telling you to ASK the client what their budget is — a budget nobody has stated yet is not a filter.
- "send_no_listings": true whenever this message should carry NO new property links. That covers every case where the point of the message is something other than offering properties:
  · asking the client for something first, options to follow ("get their budget so we can find suitable ones");
  · asking what they thought of options ALREADY sent ("let's just get feedback on the villas we sent yesterday") — a feedback request that arrives with a fresh batch talks straight over the question;
  · arranging or confirming a viewing;
  · a nudge to someone who has gone quiet.
  Sending nothing is a normal, frequent answer. Only leave this false when the broker actually wants properties in this message.
- "listings_unchanged": true whenever the instruction is about what the message SAYS or ASKS rather than which properties go out. Wording changes (shorter, warmer, fix the grammar) and added questions ("ask when they want to move in", "ask what their budget is and say we can find better matches once we know") are all listings_unchanged: true. Only set it false when the broker actually wants different properties attached.

Read the tense. "Ask her budget so we can match better" is a request to ASK — the properties do not change. "Her budget is 40 million, match that" is a filter.

Be literal. Do not infer a preference the broker did not express.`,
      messages: [{ role: "user", content: instruction.slice(0, 500) }],
      max_tokens: 200,
      temperature: 0,
    });

    const areas = (result.areas ?? [])
      .map((a) => knownAreas.find((k) => k.toLowerCase() === String(a).toLowerCase()))
      .filter((a): a is string => !!a);
    const budget = Number(result.budget_idr_monthly);

    return {
      sendNoListings: (result as { send_no_listings?: boolean }).send_no_listings === true,
      releaseArea: result.release_area === true,
      areas,
      bedrooms: typeof result.bedrooms === "number" && result.bedrooms > 0 ? result.bedrooms : null,
      bedroomsMax:
        typeof result.bedrooms === "number" &&
        result.bedrooms > 0 &&
        typeof result.bedrooms_max === "number" &&
        result.bedrooms_max > result.bedrooms
          ? result.bedrooms_max
          : null,
      budgetIdrMonthly: Number.isFinite(budget) && budget >= 1_000_000 ? Math.round(budget) : null,
      listingsUnchanged: result.listings_unchanged === true,
    };
  } catch (err) {
    logger.warn({ err }, "parseBrokerIntent failed — falling back to pattern matching");
    return null;
  }
}

/** Has the lead said anything about money at all? */
function mentionsBudget(messages: string[]): boolean {
  return messages.some((m) =>
    /budget|бюджет|\$\s?\d|\d[\d\s.,]*\s*(k\b|jt\b|juta|mil|million|млн|idr|rp\b|usd)|per month|a month|в месяц|per year/i.test(m),
  );
}

/**
 * When the budget is unknown, three villas at the same price tell us nothing.
 * Three at clearly different price points do: the client reacts to one of them
 * and the budget answers itself, without an interrogating question. So if every
 * pick landed in the same third of the price range, the last one is swapped for
 * the best-ranked candidate from the furthest tier.
 */
function spreadByPrice(
  picked: SupabaseProperty[],
  candidates: SupabaseProperty[],
): SupabaseProperty[] {
  if (picked.length < 2) return picked;
  const priced = candidates.filter((p) => priceOf(p) > 0).sort((a, b) => priceOf(a) - priceOf(b));
  if (priced.length < picked.length + 1) return picked;

  const tierOf = (p: SupabaseProperty): number => {
    const idx = priced.findIndex((c) => c.id === p.id);
    if (idx === -1) return -1;
    return Math.min(2, Math.floor((idx / priced.length) * 3));
  };
  const tiers = new Set(picked.map(tierOf).filter((t) => t >= 0));
  if (tiers.size !== 1) return picked;

  const only = [...tiers][0]!;
  const chosen = new Set(picked.map((p) => p.id));
  const farthest = only === 0 ? 2 : 0; // cheapest picks → show a premium one, and vice versa
  const swapIn =
    priced.filter((p) => !chosen.has(p.id) && tierOf(p) === farthest).sort(rankForShortlist)[0] ??
    priced.filter((p) => !chosen.has(p.id) && tierOf(p) === 1).sort(rankForShortlist)[0];
  if (!swapIn) return picked;

  logger.info(
    { swappedOut: picked[picked.length - 1]!.id, swappedIn: swapIn.id },
    "matchProperties: budget unknown — spread the shortlist across price points to read the reaction",
  );
  return [...picked.slice(0, -1), swapIn];
}

/**
 * Two listings with the same title are not a choice — the client sees the same
 * villa twice at two prices and reads it as a mistake. The catalog genuinely
 * holds same-named units (different units in one complex), so the best-ranked
 * one represents them and the rest step aside.
 */
function dedupeByTitle(list: SupabaseProperty[]): SupabaseProperty[] {
  const seen = new Set<string>();
  return list.filter((p) => {
    const key = (p.title ?? p.id).trim().toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The owner's criteria hierarchy, stated as system law: BEDROOMS, AREA, BUDGET
 * are the core — everything else (style, features, views) is secondary. A lead
 * who arrived from a listing ad has told us the core WITHOUT words: the villa
 * they clicked carries the bedrooms and the district. Those fill any criterion
 * the client has not stated themselves — their own words always override.
 */
function inheritCriteriaFromAnchor(
  criteria: { areas: string[]; bedrooms: number | null },
  recentLeadMessages: string[],
  pool: SupabaseProperty[],
): void {
  if (criteria.bedrooms !== null && criteria.areas.length > 0) return;
  const ids = new Set(
    recentLeadMessages.flatMap((m) =>
      Array.from((m ?? "").matchAll(/\/property\/([A-Za-z0-9-]+)/gi)).map((x) => x[1]!.toUpperCase()),
    ),
  );
  if (ids.size === 0) return;
  const anchor = pool.find((p) => ids.has(p.id.toUpperCase()));
  if (!anchor) return;
  if (criteria.bedrooms === null && anchor.bedrooms) {
    criteria.bedrooms = anchor.bedrooms;
  }
  if (criteria.areas.length === 0 && anchor.area) {
    const parent = parentAreaOf(anchor.area);
    if (parent) criteria.areas = [parent];
  }
  logger.info(
    { anchor: anchor.id, bedrooms: criteria.bedrooms, areas: criteria.areas },
    "criteria inherited from the villa the lead came in on",
  );
}

/** A shortlist of one is a take-it-or-leave-it, not a choice. Never send fewer. */
const MIN_SHORTLIST = 2;


/**
 * The candidate list and the money facts, without any AI in the loop.
 *
 * Split out of matchProperties so the combined "write the message AND choose the
 * links" call can work from exactly the same filtered pool — one place deciding
 * what is even eligible, instead of a second copy that drifts.
 */
export async function candidatesForLead(opts: {
  listingType: ListingType;
  excludeIds?: string[];
  recentLeadMessages?: string[];
  brokerInstruction?: string | null;
  /** Core criteria from the lead CARD (the ad form filled them) — lowest
   * precedence, they only fill what the client never said themselves. */
  cardCriteria?: { bedrooms: number | null; areas: string[]; budgetIdrMonthly: number | null } | null;
}): Promise<{
  candidates: SupabaseProperty[];
  budgetIdr: number | null;
  budgetCeiling: number | null;
  /** The bottom of a stated range ("40-50 million" -> 40M), null when the lead
   * gave a single figure. affordableIds below is ordered around it, but a
   * caller enforcing the ceiling in code needs the number itself to also
   * enforce the floor — a model picking villas UNDER it is not "over budget"
   * and slips straight past a ceiling-only check. */
  budgetFloorIdr: number | null;
  lines: Array<{ id: string; line: string }>;
  /** Priced candidates inside the ceiling (or simply priced, when no budget),
   * in shortlist order — the composer's minimum-choice top-up draws from here. */
  affordableIds: string[];
}> {
  const all = await fetchAllProperties();
  const exclude = new Set((opts.excludeIds ?? []).map((id) => id.toUpperCase()));
  // offerableNow: a villa free only beyond the horizon never enters a shortlist.
  const pool = all.filter(
    (p) => p.listing_type === opts.listingType && !exclude.has(p.id.toUpperCase()) && offerableNow(p),
  );

  const criteriaSource = [opts.brokerInstruction ?? "", ...(opts.recentLeadMessages ?? [])].filter(Boolean);
  const criteria = await extractLeadCriteria(criteriaSource, pool);
  // The owner's rule: the client's own words, then the FORM, then the villa
  // they clicked. The form used to come last, after inheritCriteriaFromAnchor,
  // and the anchor is found in the enquiry WE seeded ("I saw this villa:
  // .../R-YUD-066") — so a 2BR-in-Seseh click filled bedrooms and area before
  // the form's "3BR, Umalas" was ever consulted. Alena wrote a paragraph
  // correcting us; Dylan asked for Uluwatu three times (2026-09-03). The form
  // is what they typed with their own hands; the click is only what caught
  // their eye. Fill from the form first, let the click cover what is left.
  if (opts.cardCriteria) {
    if (criteria.bedrooms === null && opts.cardCriteria.bedrooms) {
      criteria.bedrooms = opts.cardCriteria.bedrooms;
    }
    if (criteria.areas.length === 0 && opts.cardCriteria.areas.length > 0) {
      criteria.areas = [...opts.cardCriteria.areas];
    }
  }
  inheritCriteriaFromAnchor(criteria, opts.recentLeadMessages ?? [], pool);

  let candidates = pool;
  // STRICT, same as matchProperties (owner, 2026-09-04): the request's area and
  // bedroom count are filters, not preferences. The one exception is the
  // broker's own instruction to look beyond the area — theirs to give.
  const releaseArea = /elsewhere|other areas?|another area|different area|widen|beyond|whole island|anywhere|другой район|других районах|не только|шире|по всему острову/i.test(
    opts.brokerInstruction ?? "",
  );
  if (criteria.areas.length > 0 && !releaseArea) {
    candidates = candidates.filter((p) => areaMatches(p.area, criteria.areas));
  }
  if (criteria.bedrooms !== null) {
    const min = criteria.bedrooms;
    const max = criteria.bedroomsMax ?? null;
    candidates =
      max !== null
        ? candidates.filter((p) => p.bedrooms !== null && p.bedrooms >= min && p.bedrooms <= max)
        : candidates.filter((p) => p.bedrooms === min);
  }

  const priced = candidates.filter(hasPrice);
  if (priced.length >= MIN_SHORTLIST) candidates = priced;

  const afterAreaBedrooms = candidates.length;
  const budgetIdr =
    opts.listingType === "rent"
      ? extractBudgetIdr(criteriaSource) ?? opts.cardCriteria?.budgetIdrMonthly ?? null
      : null;
  const budgetCeiling = budgetIdr ? Math.round(budgetIdr * 1.15) : null;
  // Same gap as matchProperties: a stated range's bottom half was invisible
  // here too, and this is the pool the EDIT path's composer actually sees —
  // so a broker's own "stay in that 40-50 range" instruction had nothing
  // correctly ordered to draw from.
  const budgetFloorRaw = opts.listingType === "rent" ? extractBudgetFloorIdr(criteriaSource) : null;
  // A floor above the ceiling cannot be a real range — it is a parse error
  // (a yearly range read as monthly), and enforcing it empties the pool. The
  // ceiling is the number the whole system trusts; the floor is a refinement
  // of it and never outranks it.
  const budgetFloorIdr = budgetFloorRaw && budgetIdr && budgetFloorRaw > budgetIdr ? null : budgetFloorRaw;
  if (budgetFloorRaw && budgetIdr && budgetFloorRaw > budgetIdr) {
    logger.warn({ budgetFloorRaw, budgetIdr }, "candidatesForLead: floor above ceiling — floor ignored");
  }
  // Same 15% headroom as the ceiling, mirrored downward — see matchProperties.
  const budgetFloorFloor = budgetFloorIdr ? Math.round(budgetFloorIdr * 0.85) : null;
  if (budgetCeiling) {
    // Strict: inside the ceiling and not below the floor (both with the 15%
    // headroom); no "closest above", no price-less villas.
    const within = candidates.filter(
      (p) =>
        priceOf(p) > 0 &&
        priceOf(p) <= budgetCeiling &&
        (!budgetFloorFloor || priceOf(p) >= budgetFloorFloor),
    );
    candidates = budgetFloorIdr
      ? [...within].sort((a, b) => {
          const aIn = priceOf(a) >= budgetFloorIdr ? 0 : 1;
          const bIn = priceOf(b) >= budgetFloorIdr ? 0 : 1;
          return aIn !== bIn ? aIn - bIn : rankForShortlist(a, b);
        })
      : within.sort(rankForShortlist);
  } else {
    candidates = [...candidates].sort(rankForShortlist);
  }
  candidates = dedupeByTitle(candidates);

  // Empty-pool forensics: six broker edits on one lead came back with a text
  // describing villas and zero links, because this pool was empty while the
  // catalog held three villas that fit. Which filter emptied it was invisible.
  if (candidates.length === 0) {
    logger.warn(
      {
        areas: criteria.areas, bedrooms: criteria.bedrooms, bedroomsMax: criteria.bedroomsMax ?? null,
        budgetIdr, budgetCeiling, budgetFloorIdr, budgetFloorFloor,
        poolOfferable: pool.length, afterAreaBedrooms,
        sample: criteriaSource.map((t) => t.slice(0, 80)),
      },
      "candidatesForLead: pool is EMPTY after filters",
    );
  }

  return {
    candidates,
    budgetIdr,
    budgetCeiling,
    budgetFloorIdr,
    affordableIds: candidates
      .filter((p) => priceOf(p) > 0 && (!budgetCeiling || priceOf(p) <= budgetCeiling))
      .map((p) => p.id),
    lines: candidates.slice(0, 40).map((p) => {
      const style = styleHint(p);
      return { id: p.id, line: style ? `${summaryLine(p)} | ${style}` : summaryLine(p) };
    }),
  };
}

/**
 * Turns chosen IDs into links, enforcing the things a model must not be trusted
 * with: a stated budget, and never the same villa name twice. An empty choice is
 * respected — deciding to send nothing is a real decision.
 */
export function finaliseListingIds(
  ids: string[],
  candidates: SupabaseProperty[],
  budgetCeiling: number | null,
  limit = 3,
): PropertyPick[] {
  const wanted = new Set(ids.map((i) => i.toUpperCase()));
  let picked = candidates.filter((p) => wanted.has(p.id.toUpperCase()));
  if (picked.length === 0) return [];

  if (budgetCeiling) {
    const affordable = candidates.filter((p) => priceOf(p) > 0 && priceOf(p) <= budgetCeiling);
    if (affordable.length > 0) {
      const over = picked.filter((p) => priceOf(p) > budgetCeiling);
      if (over.length > 0) {
        const keep = picked.filter((p) => priceOf(p) <= budgetCeiling);
        for (const p of affordable) {
          if (keep.length >= picked.length) break;
          if (!keep.some((k) => k.id === p.id)) keep.push(p);
        }
        logger.info(
          { dropped: over.map((p) => p.id), ceiling: budgetCeiling },
          "finaliseListingIds: enforced the budget on the chosen links",
        );
        picked = keep;
      }
    }
  }

  return dedupeByTitle(picked).slice(0, limit).map(toPick);
}

export async function matchProperties(opts: {
  listingType: ListingType;
  conversationText: string;
  brokerId?: string | null;
  limit?: number;
  /** Property IDs already sent to this lead — excluded so a re-match after an
   * objection surfaces DIFFERENT listings instead of repeating rejected ones. */
  excludeIds?: string[];
  /** How many listings this lead has already seen — drives the "give them
   * something genuinely different" instruction on follow-up shortlists. */
  seenCount?: number;
  /** The lead's most recent message, weighted above the rest of the history.
   * A revision ("actually, 3 bedrooms in Uluwatu") is one line against a long
   * conversation about the old criteria, and the matcher used to be outvoted
   * by the bulk — attaching Pererenan 2BRs to a reply that correctly said
   * "switching gears to Uluwatu, 3 bedrooms". */
  latestLeadMessage?: string | null;
  /** The lead's own recent messages, NEWEST FIRST — used to hard-filter the
   * candidate list by their current area / bedroom requirements. */
  recentLeadMessages?: string[];
  /** What the BROKER just said while revising the draft ("these are too
   * expensive, show me something around 40jt"). Editing the text used to leave
   * the links untouched, which made the broker fix them by hand. Read first, so
   * a price or area they name overrides what the lead said earlier. */
  brokerInstruction?: string | null;
  /** Listings currently attached to the draft the broker is revising. */
  currentAttachmentIds?: string[];
  /** Already-parsed instruction, when the caller has decided on it — avoids
   * classifying the same sentence twice in one request. */
  brokerIntent?: BrokerIntent | null;
  /** Core criteria taken from the lead CARD (the ad form filled them). Lowest
   * precedence: they fill only what the client never said themselves. */
  cardCriteria?: { bedrooms: number | null; areas: string[]; budgetIdrMonthly: number | null } | null;
}): Promise<PropertyPick[]> {
  // A shortlist of one isn't a choice, and two is thin. Three is what a broker
  // would actually send; the matcher may still return fewer if stock is short.
  const limit = opts.limit ?? 3;
  const all = await fetchAllProperties();
  const exclude = new Set((opts.excludeIds ?? []).map((id) => id.toUpperCase()));
  // offerableNow: a villa free only beyond the horizon never enters a shortlist.
  const pool = all.filter(
    (p) => p.listing_type === opts.listingType && !exclude.has(p.id.toUpperCase()) && offerableNow(p),
  );
  if (pool.length === 0) return [];

  // The broker's instruction is read first: whether it moves the search matters
  // to the anchor decision below, not just to the filters further down.
  let brokerIntent: BrokerIntent | null = opts.brokerIntent ?? null;
  if (!brokerIntent && opts.brokerInstruction) {
    const vocab = [...new Set([...allAreaNames(), ...pool.map((p) => (p.area ?? "").trim())])].filter(Boolean);
    brokerIntent = await parseBrokerIntent(opts.brokerInstruction, vocab);
  }
  // Only a revision that actually moves the search drops the anchor. Killing it
  // for ANY broker instruction meant a wording edit ("make it warmer") lost the
  // villa the lead had come in on — the link vanished from the draft and the bot
  // could only paste the URL into the text afterwards, never restore it.
  const revisionMovesSearch =
    !!brokerIntent && (brokerIntent.releaseArea || brokerIntent.areas.length > 0 || !!brokerIntent.bedrooms);

  // 1. Anchor listing — the lead arrived FROM a specific listing (clicked its ad)
  // or named one themselves. Read only from what the LEAD wrote: matching any
  // mention in the whole conversation meant our own previously sent links came
  // straight back as "the answer". Anything already sent is out of `pool`, so a
  // lead quoting a link we sent cannot become an anchor either.
  const anchorIds = revisionMovesSearch ? new Set<string>() : new Set(
    (opts.recentLeadMessages ?? [])
      .flatMap((m) => Array.from(m.matchAll(PROPERTY_ID_REGEX)).map((x) => x[1].toUpperCase())),
  );
  const anchors = anchorIds.size > 0 ? pool.filter((p) => anchorIds.has(p.id.toUpperCase())) : [];
  if (anchors.length > 0) {
    // Their own pick tells us the criteria better than any question would. Send
    // it back WITH comparable alternatives, so they still get a real choice.
    const anchor = anchors[0]!;

    // THE DOUBLE CHECK. Clicking an ad is one signal; the budget they typed into
    // the form is another, and they disagree more often than you'd think —
    // people click a villa they cannot actually afford. The anchor used to be
    // returned before any budget test, so a client who wrote "30 million" got
    // the 60-million villa they clicked as the answer. When the two disagree,
    // their MONEY wins: the villa they can't afford stops leading the shortlist.
    const anchorBudget =
      opts.listingType === "rent"
        ? extractBudgetIdr(
            [opts.brokerInstruction ?? "", ...(opts.recentLeadMessages ?? [])].filter(Boolean),
          ) ?? opts.cardCriteria?.budgetIdrMonthly ?? null
        : null;
    const anchorPrice = priceOf(anchor);
    const anchorTooExpensive =
      !!anchorBudget && anchorPrice > 0 && anchorPrice > Math.round(anchorBudget * 1.15);

    const affordable = (p: SupabaseProperty) =>
      !anchorBudget || priceOf(p) === 0 || priceOf(p) <= Math.round(anchorBudget * 1.15);

    const similar = pool
      .filter(
        (p) =>
          !anchorIds.has(p.id.toUpperCase()) &&
          (anchor.bedrooms === null || p.bedrooms === null || Math.abs((p.bedrooms ?? 0) - anchor.bedrooms) <= 1),
      )
      .sort((a, b) => {
        // Within budget first when the two signals disagree, then same area.
        const byMoney = (affordable(a) ? 0 : 1) - (affordable(b) ? 0 : 1);
        if (anchorTooExpensive && byMoney !== 0) return byMoney;
        const sameArea = (x: SupabaseProperty) => (areaMatches(x.area, [anchor.area ?? ""]) ? 0 : 1);
        const byArea = sameArea(a) - sameArea(b);
        return byArea !== 0 ? byArea : rankForShortlist(a, b);
      });

    // A client who names ONE villa gets an answer about THAT villa.
    //
    // This branch used to always append "comparable alternatives", on the logic
    // that everyone deserves a real choice. On an ad lead that reads as not
    // listening: "Hi! I saw your ad for R-YUD-038 — 3BR near Seseh Beach, Rp
    // 79.2M/month" came back with the villa they asked about plus a 2BR at
    // Rp 28.6M and a 3BR in Balangan — a different size and the opposite end of
    // the island — because ±1 bedroom is allowed and, with no stated budget, the
    // rest of the order falls to whatever ranks well (804 views won). The owner's
    // words: "client applied for one specific option, why suggest three?"
    // (2026-08-19, lead 23279935).
    //
    // Alternatives are for when we must move them OFF that villa — it costs more
    // than the budget they stated (the DOUBLE CHECK above), or it is not
    // offerable. Otherwise: the villa they asked about, and the reply qualifies
    // them instead of guessing. This is the deliberate exception to
    // "always 2-3 listings, never one".
    const anchorAlone = !anchorTooExpensive && offerableNow(anchor);
    if (anchorAlone) {
      logger.info(
        { anchor: anchor.id },
        "matchProperties: the lead named one villa — answering about that villa alone",
      );
      return [toPick(anchor)];
    }

    const ordered = anchorTooExpensive ? [...similar, ...anchors] : [...anchors, ...similar];
    const shortlist = dedupeByTitle(ordered).slice(0, limit);
    logger.info(
      {
        anchor: anchor.id,
        total: shortlist.length,
        budgetIdr: anchorBudget,
        anchorPrice,
        mismatch: anchorTooExpensive,
      },
      anchorTooExpensive
        ? "matchProperties: DOUBLE CHECK — the clicked villa costs more than the budget they stated, leading with what fits"
        : "matchProperties: built the shortlist around the listing the lead came in on",
    );
    return shortlist.map(toPick);
  }

  // Too little conversation to infer real criteria from — skip the AI call.
  if (opts.conversationText.trim().length < 20) return [];

  // ── Hard filter on the lead's CURRENT requirements ────────────────────────
  // Applied before the model sees anything, so an outdated area or bedroom
  // count is not even on the menu. Each filter is skipped when it would leave
  // nothing — an imperfect suggestion beats an empty one.
  // The broker's revision comes first: it is the newest and most authoritative
  // statement of what should be attached.
  const criteriaSource = [opts.brokerInstruction ?? "", ...(opts.recentLeadMessages ?? [])].filter(Boolean);
  const criteria = await extractLeadCriteria(criteriaSource, pool);
  // The ad form's answers fill whatever the conversation left unknown — never
  // override, the client's own words always win.
  //
  // This merge existed only in candidatesForLead, the OTHER shortlist builder;
  // here the card was accepted as a parameter and then read for its budget
  // alone. An ad lead states its area and size on the FORM, not in the chat, so
  // criteria.areas came out empty, the area filter below was skipped entirely,
  // and the whole island stayed in play — at which point ranking decides, and
  // ranking likes view count. One villa (3BR Balangan, Rp 77M, 813 views) was
  // therefore attached to nine of the last ten drafts that carried a Balangan
  // link, to clients asking for Pererenan, Canggu and Seminyak, several of them
  // wanting 2 bedrooms under Rp 50M. Amelia read it as the bot pushing Balangan
  // and asked for the listing to be deleted; the listing was never the problem.
  if (opts.cardCriteria) {
    if (criteria.bedrooms === null && opts.cardCriteria.bedrooms) {
      criteria.bedrooms = opts.cardCriteria.bedrooms;
    }
    if (criteria.areas.length === 0 && opts.cardCriteria.areas.length > 0) {
      criteria.areas = [...opts.cardCriteria.areas];
    }
  }

  // The broker's own instruction, parsed rather than pattern-matched, and applied
  // over the criteria taken from the lead. Their words win for this one message.
  const releaseArea = brokerIntent
    ? brokerIntent.releaseArea
    : !!opts.brokerInstruction && BROKER_RELEASES_AREA.test(opts.brokerInstruction);

  if (brokerIntent?.areas.length) {
    logger.info(
      { was: criteria.areas, now: brokerIntent.areas },
      "matchProperties: broker named the areas — replacing the lead's",
    );
    criteria.areas = brokerIntent.areas;
  } else if (releaseArea && criteria.areas.length > 0) {
    logger.info(
      { droppedAreas: criteria.areas, instruction: opts.brokerInstruction!.slice(0, 80) },
      "matchProperties: broker asked to look beyond that area — area filter released",
    );
    criteria.areas = [];
  }
  // Overwriting bedrooms alone and leaving bedroomsMax as whatever extractLeadCriteria
  // found would mismatch the two if the broker names a single count while the
  // lead had stated a range (or vice versa) — always set both together.
  if (brokerIntent?.bedrooms) {
    criteria.bedrooms = brokerIntent.bedrooms;
    criteria.bedroomsMax = brokerIntent.bedroomsMax;
  }
  let candidates = pool;
  // STRICT — the owner's rule (2026-09-04): bedrooms, area and budget must match
  // the request. Nothing from another district, another size or another price
  // rides along because the right one was missing. An empty shortlist is a real
  // answer: the reply says so and offers what is honestly nearby, in words.
  // «Человек говорит направо, ты ему даёшь налево — так не надо.»
  // (Before: an empty area silently fell back to the whole island, bedrooms
  // widened ±1, and a 1BR-in-Nusa-Dua request went out with a 2BR in Pererenan.)
  if (criteria.areas.length > 0) {
    const byArea = candidates.filter((p) => areaMatches(p.area, criteria.areas));
    if (byArea.length === 0) {
      logger.info(
        { areas: criteria.areas, poolSize: pool.length },
        "matchProperties: nothing in the client's area — attaching nothing from elsewhere",
      );
      return [];
    }
    candidates = byArea;
  }
  if (criteria.bedrooms !== null) {
    const min = criteria.bedrooms;
    const max = criteria.bedroomsMax ?? null;
    // A stated range ("3 or 4 bedrooms") filters to the range as given; a single
    // count is exact. No ±1.
    const fit =
      max !== null
        ? candidates.filter((p) => p.bedrooms !== null && p.bedrooms >= min && p.bedrooms <= max)
        : candidates.filter((p) => p.bedrooms === min);
    if (fit.length === 0) {
      logger.info(
        { areas: criteria.areas, bedrooms: min, bedroomsMax: max, inArea: candidates.length },
        "matchProperties: nothing at the client's bedroom count — attaching nothing of another size",
      );
      return [];
    }
    candidates = fit;
  }
  // Priced stock first — see hasPrice. Dropped only while a real choice remains.
  const priced = candidates.filter(hasPrice);
  if (priced.length >= MIN_SHORTLIST) {
    if (priced.length < candidates.length) {
      logger.info(
        { dropped: candidates.length - priced.length, kept: priced.length },
        "matchProperties: held back listings with no price",
      );
    }
    candidates = priced;
  }
  // Their budget, now that there is a rupiah price to hold it against. A little
  // headroom, because a villa slightly over budget is still worth showing — one
  // at double is not, and that is what went out before.
  const budgetIdr =
    opts.listingType === "rent"
      ? brokerIntent?.budgetIdrMonthly ??
        extractBudgetIdr(criteriaSource) ??
        opts.cardCriteria?.budgetIdrMonthly ??
        null
      : null;
  const budgetCeiling = budgetIdr ? Math.round(budgetIdr * 1.15) : null;
  // A stated RANGE ("40-50 million") has a bottom too. extractBudgetIdr only
  // ever reads the top of it — correct for the ceiling above, useless for
  // telling a 23-million villa apart from a 48-million one, both of which
  // pass "under the ceiling" equally. Ani Vit's request said 40-50; the
  // shortlist filled two of three slots with villas at 23 and 28.6, and a
  // broker edit repeating "stay in that range" still didn't move them,
  // because nothing downstream had ever been told where the range started.
  const budgetFloorRaw = opts.listingType === "rent" ? extractBudgetFloorIdr(criteriaSource) : null;
  // Same invariant as candidatesForLead: a floor above the ceiling is a parse
  // error, never a range, and enforcing it empties the shortlist.
  const budgetFloorIdr = budgetFloorRaw && budgetIdr && budgetFloorRaw > budgetIdr ? null : budgetFloorRaw;
  if (budgetFloorRaw && budgetIdr && budgetFloorRaw > budgetIdr) {
    logger.warn({ budgetFloorRaw, budgetIdr }, "matchProperties: floor above ceiling — floor ignored");
  }
  // Same 15% the ceiling gets, mirrored downward: a villa just under the stated
  // floor is still a real answer to "60-65 million" — the owner's own read of
  // one at 55 was "that one's right". One at 39.8 (well past the headroom) is
  // the actual complaint. Without this, only a floor-exact catalog ever
  // satisfies a range, which one thin area rarely has.
  const budgetFloorFloor = budgetFloorIdr ? Math.round(budgetFloorIdr * 0.85) : null;
  if (budgetCeiling) {
    // Strict: inside the ceiling (15% headroom) and, when they named a range,
    // not below its floor (the same 15%, mirrored). A villa with no price
    // cannot be judged against a budget, so it is not "inside" it. Nothing
    // above the budget is offered as "the closest" any more — the reply says
    // the budget holds nothing here and asks what else could work.
    const within = candidates.filter(
      (p) =>
        priceOf(p) > 0 &&
        priceOf(p) <= budgetCeiling &&
        (!budgetFloorFloor || priceOf(p) >= budgetFloorFloor),
    );
    if (within.length === 0) {
      logger.info(
        { budgetIdr, budgetFloorIdr, of: candidates.length },
        "matchProperties: nothing inside the client's budget — attaching nothing above it",
      );
      return [];
    }
    // In-range first when a floor is known, THEN the general ranking — a villa
    // just under the stated floor is still a real answer, but not a better one.
    candidates = budgetFloorIdr
      ? [...within].sort((a, b) => {
          const aIn = priceOf(a) >= budgetFloorIdr ? 0 : 1;
          const bIn = priceOf(b) >= budgetFloorIdr ? 0 : 1;
          return aIn !== bIn ? aIn - bIn : rankForShortlist(a, b);
        })
      : within.sort(rankForShortlist);
    logger.info(
      { budgetIdr, budgetFloorIdr, within: within.length },
      "matchProperties: shortlist held to the lead's budget",
    );
  }

  // Best first — priced, then most-viewed — and never the same villa name twice.
  // This line was lost in an earlier edit to the block above, which is how two
  // identically named Canggu villas at 33 and 45 jt went out as a "choice".
  candidates = dedupeByTitle(budgetCeiling ? candidates : [...candidates].sort(rankForShortlist));

  if (criteria.areas.length > 0 || criteria.bedrooms !== null) {
    logger.info(
      { areas: criteria.areas, bedrooms: criteria.bedrooms, poolSize: pool.length, candidates: candidates.length },
      "matchProperties: filtered to the lead's current criteria",
    );
  }

  const budgetKnown = mentionsBudget(criteriaSource);

  try {
    const brokerTop = opts.brokerId
      ? await getTopPicksForBroker(opts.brokerId, candidates.map((p) => p.id))
      : [];
    // Style goes to the MODEL only. Appending it inside summaryLine put it into
    // the attachment label the broker and the client see ("style: Private Pool, …").
    const catalogBlock = candidates
      .slice(0, 60)
      .map((p) => {
        const style = styleHint(p);
        return style ? `${summaryLine(p)} | ${style}` : summaryLine(p);
      })
      .join("\n");
    // Deliberately weak wording: this hint kept resurfacing the same two
    // listings regardless of what the lead asked for.
    const brokerBlock = brokerTop.length > 0 ? `\n\nFYI, this broker has used these before: ${brokerTop.join(", ")}. Only pick one if it fits the lead's CURRENT criteria as well as any other candidate — never as a tie-breaker against a better fit.` : "";

    const budgetBlock = budgetCeiling
      ? `\n\nTHEIR BUDGET IS ${Math.round(budgetIdr! / 1_000_000)} MILLION RUPIAH PER MONTH${
          budgetFloorIdr ? ` (they named a range starting at ${Math.round(budgetFloorIdr / 1_000_000)})` : ""
        }. Every listing below is already inside it, ordered affordable-first — pick from these only.`
      : "";

    const areaReleaseNote = releaseArea
      ? `\n\nThe broker has told you to look BEYOND the area the lead named — the whole island is on the table now, so choose on price and fit and name the area each villa is actually in.`
      : "";

    const brokerRevision = opts.brokerInstruction
      ? `\n\nTHE BROKER IS REVISING THIS DRAFT AND SAID: "${opts.brokerInstruction.slice(0, 400)}"\nThis outranks everything else. It is feedback on the listings currently attached${
          opts.currentAttachmentIds?.length ? ` (${opts.currentAttachmentIds.join(", ")})` : ""
        }, so change the selection to match what they asked for — drop the ones they objected to, keep only those that still fit. If their instruction says nothing about which listings to send, keep the current selection.`
      : "";

    const result = await chatCompletionJSON<{ ids?: string[] }>({
      model: "claude-sonnet-5",
      label: "listing-match",
      system: `You decide whether to attach property listings to a broker's next reply, and if so which ones.

Return an EMPTY list when sending listings would be the wrong move:
- The lead has just expressed interest in a SPECIFIC listing they were already shown ("I like this one", "this looks good", quoting one link approvingly). The conversation should now move toward a viewing or the practical next step on THAT property — pushing a fresh batch talks over them.
- The lead is arranging a viewing, negotiating terms, or discussing a property they've already chosen.
- The conversation gives truly nothing to go on (e.g. only a greeting).

CORE CRITERIA, IN PRIORITY ORDER: bedrooms, area, budget. A candidate that violates a stated core criterion is the wrong pick no matter how good it looks — style, features and views are secondary and only break ties among candidates that satisfy the core.

STYLE COUNTS AS A CRITERION. Each catalog line carries a "style:" part — the villa's features and a slice of its description. When the lead describes how they want it to look or feel (modern, luxury, minimalist, traditional, jungle, bright, quiet, family), match that against those words as seriously as you match area and bedrooms. Two villas of the right size in the right area are not interchangeable if only one is the style they asked for.

CRITERIA CAN CHANGE MID-CONVERSATION. When the lead revises what they want ("actually", "I wanna change my request", a new area, a different bedroom count), their NEWEST statement is the only one that counts — match against that and treat the earlier criteria as void, however much of the conversation was spent on them.

Otherwise pick up to ${limit} listing IDs. EVERY listing in the catalog below already satisfies the client's stated bedrooms, area and budget — the code filtered it — so choose among them on style, features and fit, and prefer ${MIN_SHORTLIST}-${limit} so the lead has something to compare. Never pad: if only one genuinely fits, return one. The code never adds a villa of another size, district or price to make up numbers, and neither do you. A missing detail (style, purpose, move-in date) is no reason to hold back — one or two known criteria are enough.${
        (opts.seenCount ?? 0) > 0
          ? `\n\nThis lead has already been shown ${opts.seenCount} listing(s) and those are excluded from the catalog below. Anything you pick is new to them — favour genuine variety (different areas, price points, layouts) over near-duplicates of what they already saw.`
          : ""
      }${brokerBlock}

${
        budgetKnown
          ? ""
          : `\n\nTHE LEAD HAS NOT NAMED A BUDGET. Deliberately spread the shortlist across clearly different price points — one affordable, one mid, one premium — so their reaction tells us the budget without having to ask. The catalog is ordered cheapest-fit first, newest listings ahead of older ones at the same price; everything in it already matches the client's area and size.`
      }

Respond with JSON only: {"ids": ["ID1", "ID2"]}`,
      messages: [
        {
          role: "user",
          content: `${
            opts.latestLeadMessage
              ? `LEAD'S LATEST MESSAGE — their current criteria, this overrides anything older:\n"${opts.latestLeadMessage.slice(0, 500)}"\n\n`
              : ""
          }Conversation (background):\n${conversationWindow(opts.conversationText)}\n\nCatalog:\n${catalogBlock}`,
        },
      ],
      // Room for three IDs plus whatever reasoning the model writes first —
      // at 80 the answer was cut off mid-array and the shortlist came back empty.
      max_tokens: 400,
      temperature: 0,
    });

    const ids = new Set((result.ids ?? []).map((id) => id.toUpperCase()));
    const picked = candidates.filter((p) => ids.has(p.id.toUpperCase()));

    // An empty list is a real decision (the lead already chose a villa, or is
    // arranging a viewing) — respect it. But once the model has decided to send
    // options at all, one is never enough: top the shortlist up to the floor
    // from the same filtered candidates, closest bedroom count first.
    if (picked.length > 0 && picked.length < MIN_SHORTLIST) {
      // Top up ONLY from the filtered candidates — every one of them fits the
      // request. The old fill reached into the whole island's priced stock,
      // which is how a 1BR-in-Nusa-Dua request went out with a 2BR in
      // Pererenan. If the fitting stock is one villa, one villa goes out.
      const chosenTitles = new Set(picked.map((p) => (p.title ?? p.id).trim().toLowerCase()));
      const rest = dedupeByTitle(candidates)
        .filter(
          (p) => !ids.has(p.id.toUpperCase()) && !chosenTitles.has((p.title ?? p.id).trim().toLowerCase()),
        )
        .sort(rankForShortlist);
      const before = picked.length;
      picked.push(...rest.slice(0, MIN_SHORTLIST - picked.length));
      logger.info(
        { requested: ids.size, final: picked.length, fittingStock: candidates.length },
        picked.length > before
          ? "matchProperties: topped the shortlist up from the fitting candidates"
          : "matchProperties: only this many fit — sending fewer than the usual minimum rather than padding",
      );
    }
    // Enforced, not requested. Two separate failures made this necessary: the
    // model was handed an affordable-first catalog and still picked villas at
    // nearly double the figure, and when told the broker objected to the current
    // links it dropped ALL of them — including the one that was cheapest. Price
    // is not a preference the model gets to trade away, so it is applied here.
    if (budgetCeiling) {
      const affordable = candidates.filter((p) => priceOf(p) > 0 && priceOf(p) <= budgetCeiling);
      const target = Math.min(limit, Math.max(MIN_SHORTLIST, picked.length));
      const keep = affordable.length > 0 ? picked.filter((p) => priceOf(p) <= budgetCeiling) : [];
      const chosen = new Set(keep.map((p) => p.id));
      // `candidates` is already ordered affordable-first, then cheapest-above, so
      // this fills with the best available answer either way.
      for (const p of affordable.length > 0 ? affordable : candidates) {
        if (keep.length >= target) break;
        if (!chosen.has(p.id)) {
          keep.push(p);
          chosen.add(p.id);
        }
      }
      // Affordable stock can run out before there is a choice to offer — then the
      // closest above budget completes it rather than the client getting a single
      // link. Enforcing the ceiling first had cut a shortlist of two back to one.
      if (keep.length < MIN_SHORTLIST) {
        for (const p of candidates) {
          if (keep.length >= MIN_SHORTLIST) break;
          if (!chosen.has(p.id)) {
            keep.push(p);
            chosen.add(p.id);
          }
        }
      }
      const changed =
        keep.length !== picked.length || keep.some((p, i) => p.id !== picked[i]?.id);
      if (keep.length > 0 && changed) {
        logger.info(
          {
            ceiling: budgetCeiling,
            affordableStock: affordable.length,
            before: picked.map((p) => `${p.id}:${priceOf(p)}`),
            after: keep.map((p) => `${p.id}:${priceOf(p)}`),
          },
          "matchProperties: enforced the budget on the final shortlist",
        );
        picked.length = 0;
        picked.push(...keep);
      }
    }

    const final = budgetKnown ? picked : spreadByPrice(picked.slice(0, limit), candidates);
    return final.slice(0, limit).map(toPick);
  } catch (err) {
    logger.error({ err }, "matchProperties: AI matching failed (non-fatal)");
    return [];
  }
}

/**
 * Human-readable details for listing IDs — used when a BROKER pastes links by
 * hand. Their label is just the ID, and handing that to the rewrite step made it
 * ask the broker for the real names instead of writing to the client.
 */
export type DescribedProperty = {
  title: string;
  /** Internal label — carries "(rent)" and the view count. For the MODEL only. */
  label: string;
  /**
   * The same villa described for a HUMAN to read: title, size, area, price.
   * `label` looks close enough to be reached for by mistake, and it would put
   * "(rent), 804 views" into a client's WhatsApp — it is written for the
   * matcher's prompt, not for a person.
   */
  clientLabel: string;
  url: string;
  priceIdr: number;
};

/**
 * What a listing tells us about the person who clicked its ad.
 *
 * A paid ad lead who never filled the Meta form has still said something by
 * clicking: this many bedrooms, this area, roughly this money. Without it the
 * matcher had nothing to search on — the only "client message" is the seeded
 * link, which carries no criteria — so the broker's opening promised a
 * shortlist and attached none (2026-08-21).
 */
export async function criteriaFromListing(
  id: string,
): Promise<{ bedrooms: number | null; areas: string[]; budgetIdrMonthly: number | null } | null> {
  const want = id.trim().toUpperCase();
  if (!want) return null;
  const all = await fetchAllProperties().catch(() => [] as SupabaseProperty[]);
  const p = all.find((x) => x.id.toUpperCase() === want);
  if (!p) return null;
  const price = priceOf(p);
  return {
    bedrooms: typeof p.bedrooms === "number" && p.bedrooms > 0 ? p.bedrooms : null,
    areas: p.area ? [p.area] : [],
    // Their ceiling is unknown; what they clicked is the one figure they have
    // shown willingness to pay, so search around it rather than under it.
    budgetIdrMonthly: price > 0 ? Math.round(price * 1.15) : null,
  };
}

export async function describePropertiesByIds(
  ids: string[],
): Promise<Map<string, DescribedProperty>> {
  const out = new Map<string, DescribedProperty>();
  if (ids.length === 0) return out;
  const wanted = new Set(ids.map((i) => i.toUpperCase()));
  const all = await fetchAllProperties().catch(() => [] as SupabaseProperty[]);
  for (const p of all) {
    if (!wanted.has(p.id.toUpperCase())) continue;
    const pick = toPick(p);
    // Titles in this catalog usually already say the size and the area
    // ("3BR Villa for Long-Term Rental in Umalas"), so repeating them reads
    // like a database row rather than a broker: "3BR Villa … in Umalas — 3BR,
    // Umalas, Rp 79.2M/month". Only add what the title does not already say.
    const titleLower = (p.title ?? "").toLowerCase();
    const bits = [
      p.bedrooms && !titleLower.includes(`${p.bedrooms}br`) ? `${p.bedrooms}BR` : "",
      p.area && !titleLower.includes(p.area.toLowerCase()) ? p.area : "",
      priceLabel(p) ?? "",
    ].filter(Boolean);
    const clientLabel = bits.length > 0 ? `${p.title} — ${bits.join(", ")}` : p.title;
    out.set(p.id.toUpperCase(), {
      title: p.title,
      label: pick.label,
      clientLabel,
      url: pick.url,
      priceIdr: priceOf(p),
    });
  }
  return out;
}

/** Lightweight fetch used only for price lookups — reuses the same cache */
export async function fetchAllPropertiesForPriceLookup(): Promise<SupabaseProperty[]> {
  return fetchAllProperties();
}

export async function getAllPropertiesForAdmin(): Promise<
  Array<SupabaseProperty & { url: string; displayPrice: string | null }>
> {
  const props = await fetchAllProperties();
  return props.map((p) => ({
    ...p,
    url: `${SITE_BASE}/${p.id}`,
    displayPrice: formatPrice(p),
  }));
}

export function invalidateCache(): void {
  _cache = null;
  _cacheAt = 0;
}
