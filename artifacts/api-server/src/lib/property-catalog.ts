import { logger } from "./logger";
import { conversationWindow } from "./dialog-parser";
import { chatCompletionJSON, HELPER_MODEL } from "./ai-client";
import { listingQualityById, type ListingQuality } from "./property-flags";
import { allAreaNames, areaMatches, areaNamesInText, parentAreaOf, neighbourAreas, fuzzyAreaNamesInText, landmarkAreasInText } from "./bali-areas";
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
  /** ISO timestamp — when the listing went on the site (rankShortlistFits: new is never a penalty). */
  created_at?: string | null;
  /** false once we inspected the villa ("Listed"); true while it is Pre-listed. */
  pre_listed?: boolean | null;
  video_url?: string | null;
  /** How many photos the listing has on the site (the image URLs themselves are not kept). */
  image_count?: number;
  /** When a property_availability row was last written — someone confirmed the dates then. */
  availability_checked_at?: string | null;
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
  /** The listing's own minimum stay (site field). */
  min_stay_months?: number | null;
  /** Occupied / rented periods that have not ended yet (ISO dates, inclusive). */
  busy?: Array<{ start: string; end: string }>;
  // Key features from the site (owner, 16.09.2026): what clients choose a villa by. null = nobody
  // checked, never "no" — an unchecked villa is neither rewarded nor punished for it.
  garden?: "none" | "small" | "large" | null;
  workspace?: "none" | "desk" | "office_room" | null;
  living_room?: "open" | "enclosed" | null;
  quiet_area?: boolean | null;
  /** Derived on the site from Internal data: true only once a person checked there is no construction next door. */
  no_construction_nearby?: boolean | null;
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
    `?select=id,title,area,type,bedrooms,bathrooms,price_usd,leasehold_price_usd,monthly_price_usd,yearly_price_usd,monthly_price_idr,yearly_price_idr,ownership,status,zone,views,purpose,listing_type,features,description,created_at,min_stay_months,pre_listed,video_url,images,garden,workspace,living_room,quiet_area,no_construction_nearby` +
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

  const raw = (await res.json()) as Array<SupabaseProperty & { images?: unknown }>;
  const data: SupabaseProperty[] = raw.map(({ images, ...row }) => ({ ...row, image_count: Array.isArray(images) ? images.length : 0 }));
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
type AvailabilityRow = { property_id: string; status: string | null; start_date: string | null; end_date: string | null; created_at?: string | null };

/**
 * A villa's first free day (ISO date), or null when it is free today.
 *
 * The SAME reading as the website's `getFreeFrom`
 * (bali-villa-rentals/src/lib/rental-availability.ts) — keep the two in step:
 * - `occupied` / `rented`: busy start..end inclusive; a period covering today
 *   frees the villa the day after it ends;
 * - `available`: free from `start_date` on (`end_date` is a 2099 sentinel).
 *
 * Until 11.09.2026 every row was read as "busy until end_date", so the site's
 * "Available from <date>" (status available, end 2099-12-31) came out as "free
 * in 2100": 17 villas free within the horizon — every new listing entered with
 * a date, R-YUD-088…098 — never reached a single shortlist.
 */
export function freeFromOf(periods: AvailabilityRow[], todayIso: string): string | null {
  const busyToday = periods
    .filter((p) => (p.status === "occupied" || p.status === "rented")
      && p.start_date && p.end_date && p.start_date <= todayIso && p.end_date >= todayIso)
    .map((p) => p.end_date as string)
    .sort();
  if (busyToday.length) {
    const d = new Date(`${busyToday[busyToday.length - 1]}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  const available = periods.filter((p) => p.status === "available" && p.start_date);
  if (available.some((p) => (p.start_date as string) <= todayIso)) return null;
  return available.map((p) => p.start_date as string).sort()[0] ?? null;
}

async function applyAvailability(rows: SupabaseProperty[]): Promise<SupabaseProperty[]> {
  let periods: AvailabilityRow[] = [];
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/property_availability?select=property_id,status,start_date,end_date,created_at`,
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

  const todayIso = new Date().toISOString().slice(0, 10);
  const byVilla = new Map<string, AvailabilityRow[]>();
  for (const p of periods) {
    const list = byVilla.get(p.property_id);
    if (list) list.push(p);
    else byVilla.set(p.property_id, [p]);
  }

  // Stamped, never dropped. The site shows every listing now and marks the
  // far-out ones red rather than hiding them, so a lead CAN be looking at one
  // and ask about it — and a catalog that had deleted it could not even say
  // when it frees up. Offerability is decided per shortlist instead
  // (offerableNow), which is the only place it actually matters.
  return rows.map((row) => {
    const periods = byVilla.get(row.id) ?? [];
    const free = freeFromOf(periods, todayIso);
    const busy = periods
      .filter((p) => (p.status === "occupied" || p.status === "rented") && p.start_date && p.end_date && (p.end_date as string) >= todayIso)
      .map((p) => ({ start: p.start_date as string, end: p.end_date as string }));
    const checked = periods.map((p) => p.created_at ?? "").filter(Boolean).sort().pop() ?? null;
    return { ...row, ...(free ? { free_from: free } : {}), ...(busy.length ? { busy } : {}), availability_checked_at: checked };
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
  const checked = keyFeatureBits(p, true);
  return [checked.length ? `checked: ${checked.join(", ")}` : "", parts.length ? `style: ${parts.join(" — ")}` : ""]
    .filter(Boolean)
    .join(" | ");
}

/**
 * The key features someone verified on the site (owner, 16.09.2026) — garden, living room,
 * workspace, quiet street, construction checked clear. A villa's description may say "lush garden"
 * as marketing; these are the checked facts. `withNegatives` adds what it is known to lack
 * (matcher and composer lines), without it only what a client may be told it has (the pick label).
 */
export function keyFeatureBits(p: SupabaseProperty, withNegatives = false): string[] {
  const out: string[] = [];
  if (p.garden === "large") out.push("large garden");
  else if (p.garden === "small") out.push("garden");
  else if (p.garden === "none" && withNegatives) out.push("no garden");
  if (p.living_room === "enclosed") out.push("enclosed living room");
  else if (p.living_room === "open") out.push("open-plan living");
  if (p.workspace === "office_room") out.push("separate office room");
  else if (p.workspace === "desk") out.push("workspace");
  else if (p.workspace === "none" && withNegatives) out.push("no workspace");
  if (p.quiet_area === true) out.push("quiet street");
  else if (p.quiet_area === false && withNegatives) out.push("busy street");
  if (p.no_construction_nearby === true) out.push("no construction next door");
  return out;
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
    // No view count: popularity is not fit, and on a matcher line it was read as one.
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

/** The site's admin page for a listing — where Internal data is filled in before it can go live. */
export function adminPropertyUrl(id: string): string {
  return `${new URL(SITE_HUMAN_BASE).origin}/admin/property/${encodeURIComponent(id)}`;
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
  // Checked key features last, and only whole ones: a label cut at "separate" told the writer
  // half a fact. The writer may mention them, and nothing it was not told.
  let featureBit = "";
  for (const f of keyFeatureBits(p)) {
    if (`${p.title} (${priceBit}${noPrice}${freeBit}${featureBit}, ${f})`.length > 180) break;
    featureBit += `, ${f}`;
  }
  return {
    id: p.id,
    title: p.title,
    url: propertyUrl(p),
    label: `${p.title} (${priceBit}${noPrice}${freeBit}${featureBit})`.slice(0, 180),
  };
}

/** Public wrapper — the route needs a pick built the same way the matcher builds them. */
export function toPickPublic(p: SupabaseProperty): PropertyPick {
  return toPick(p);
}

/**
 * Picks 0-limit best-fitting properties for a lead, in priority order:
 * 1. A specific listing already mentioned in the conversation (explicit signal — no AI needed).
 * 2. AI-assisted choice among the ranked fits (rankShortlistFits) — never by
 *    views or by how often a broker approved a villa before.
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
 * Once villas FIT the request, which goes first — THE order every shortlist
 * path shows (strictShortlistPool → matchPropertiesDetailed for every bot
 * draft and follow-up, candidatesForLead for the edit composer).
 *
 * The owner's order (14.09.2026, evening): the request is the base of
 * everything, and old and new villas mix freely — "у нас аренда, они сдаются,
 * потом опять свободные". Compared in this order, each step only between
 * villas equal on the steps before it:
 *   1. an area the client named over a neighbour they only allowed;
 *   2. fit (`score`): a price close to their budget (a 50M client sees 45-50
 *      first), free on their dates, a minimum stay that suits them;
 *   3. not already skipped by the broker in a draft for this lead;
 *   4. what we know about the villa (`quality`): red and green flags from the
 *      inspection, construction nearby, Listed, video, photos, dates confirmed
 *      recently — it never lifts a villa that fits worse;
 *   5. a turn per lead: villas equal on everything alternate between leads
 *      instead of one always going to all of them.
 * How long a listing has been on the site plays no part, and neither do views
 * or how often a villa was sent before.
 *
 * History. Views were the tie-break until 02.09 and made a closed loop (a villa
 * gets sent, viewed, ranks higher, gets sent again: a 3BR in Balangan with 814
 * views went to ten Pererenan-under-50 leads). Its replacement, "cheapest
 * first, newest among equals", made a second loop with the same effect
 * (Amelia, 14.09.2026: "the bot only sends earliest options added while there
 * is a better option added"): among 2BR fits the cheapest were the oldest
 * stock — R-YUD-074 at 22.5M (7 photos, yearly only), R-DESTI-003 at 24.2M
 * (minimum 12 months), R-MER-040 at 28.6M — so they topped every list for a
 * 40-50M client, while each matcher line still said "N views" and the prompt
 * added "this broker has used these before" (broker_property_picks, bumped by
 * every approve of the bot's own picks). Over 01-14.09 Rental bot drafts
 * attached villas with a median age of 11 (push) / 17 (live) days; Amelia's own
 * phone links, 7. 23485903 (Canggu/Berawa, 35M): the bot drafted R-AME-003 +
 * R-DESTI-003, she sent R-YUD-071/075/076 by hand.
 *
 * The first replacement (f359a54, 14.09 morning) summed fit and quality into
 * one score and gave +1 to a listing 14 days old or less: quality could outrank
 * fit, and "new" became the next bias. It also read the retired `red_flag`
 * column, so no red flag ever counted. Replaced the same evening by the order
 * above.
 */
export type RankContext = {
  quality?: Map<string, ListingQuality>;
  /** Villas this lead was already offered in a draft the broker SKIPPED. */
  proposedIds?: string[];
  /** The lead id — villas equal on everything take turns between leads. */
  rotationKey?: string | null;
  now?: Date;
};
/**
 * `score` is fit to the request, `quality` what we know about the villa.
 * `why` is for the matcher (internal facts); `whyClient` only what a client may hear.
 */
export type RankedFit = {
  p: SupabaseProperty;
  namedArea: boolean;
  score: number;
  skipped: boolean;
  quality: number;
  why: string[];
  whyClient: string[];
};

const RANK_DAY_MS = 24 * 60 * 60 * 1000;

/** A stable per-lead shuffle position (FNV-1a) — the same lead always sees the same order. */
function rotationTurn(key: string, id: string): number {
  const s = `${key}|${id.toUpperCase()}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function rankShortlistFits(fits: SupabaseProperty[], r: ClientRequest, ctx: RankContext = {}): RankedFit[] {
  const now = (ctx.now ?? new Date()).getTime();
  const proposed = new Set((ctx.proposedIds ?? []).map((i) => i.toUpperCase()));
  const named = r.releaseArea ? [] : r.areas;
  const out = fits.map((p): RankedFit => {
    let score = 0;
    let quality = 0;
    const why: string[] = [];
    const whyClient: string[] = [];
    const note = (text: string, clientSafe = false) => {
      why.push(text);
      if (clientSafe) whyClient.push(text);
    };

    // ── Fit: how closely the villa matches what the client asked for ──
    const namedArea = named.length === 0 || areaMatches(p.area, named);
    if (!namedArea) note(`nearby ${p.area ?? "area"}`, true);
    const price = priceOf(p);
    if (price <= 0) {
      score -= 3;
      note("no published price");
    } else if (r.budgetMaxIdr) {
      // Close to what they said they would spend, never over it (the filter
      // refused over): a 50M client sees 45-50 first (owner, 14.09).
      const use = price / r.budgetMaxIdr;
      // A narrow range the client gave ("35 to 40 million") is close all the
      // way through: 35 is what they said too.
      const inNarrowRange = r.budgetMinIdr !== null && r.budgetMinIdr >= 0.8 * r.budgetMaxIdr && price >= r.budgetMinIdr;
      score += use >= 0.9 || inNarrowRange ? 3 : use >= 0.8 ? 2 : use >= 0.65 ? 1 : 0;
      note(`${millions(price)} of their ${millions(r.budgetMaxIdr)}${use < 0.5 ? " (far under it)" : ""}`, true);
    }
    // No move-in date stated: free now beats free from a date.
    if (!p.free_from) note("free now", true);
    else if (!r.moveIn) {
      score -= 1;
      note(`free only from ${dayLabel(p.free_from)}`, true);
    }
    // No stay length stated: a long minimum is a likely no.
    if (r.stayMonths === null) {
      const minStay = Number(p.min_stay_months ?? 0);
      const monthly = (p.monthly_price_idr ?? 0) > 0 || (p.monthly_price_usd ?? 0) > 0;
      if (price > 0 && !monthly) {
        score -= 1;
        note("yearly contract only", true);
      } else if (minStay >= 12) {
        score -= 0.5;
        note(`minimum stay ${minStay} months`, true);
      } else if (minStay >= 6) {
        score -= 0.25;
        note(`minimum stay ${minStay} months`, true);
      }
    }

    // ── Key features the client asked for (owner, 16.09.2026) ──
    // A villa that has it moves up, one known to lack it moves down, one nobody checked stays put:
    // "not checked" is not "no". Across the 358 rental leads of 19.07–16.09 clients turned villas
    // down over exactly these ("concrete boxes", "don't like open living rooms", "construction
    // right next door so we decided no").
    const w = r.wants;
    if (w?.garden) {
      if (p.garden === "large") {
        score += 2;
        note("large garden (they asked for a garden)", true);
      } else if (p.garden === "small") {
        score += 1.5;
        note("has a garden (they asked for one)", true);
      } else if (p.garden === "none") {
        score -= 2;
        note("no garden, and they asked for one");
      }
    }
    if (w?.workspace) {
      if (p.workspace === "office_room") {
        score += 2;
        note("separate office room (they need to work)", true);
      } else if (p.workspace === "desk") {
        score += 1;
        note("has a workspace (they need to work)", true);
      } else if (p.workspace === "none") {
        score -= 1.5;
        note("no workspace, and they need one");
      }
    }
    if (w?.enclosedLiving) {
      if (p.living_room === "enclosed") {
        score += 2;
        note("enclosed living room (they asked for one)", true);
      } else if (p.living_room === "open") {
        score -= 2;
        note("open-plan living, and they want it enclosed");
      }
    }
    if (w?.quiet) {
      const construction = ctx.quality?.get(p.id.toUpperCase())?.constructionNearby === true;
      if (construction) {
        score -= 3;
        note("construction nearby, and they asked for quiet");
      } else {
        if (p.no_construction_nearby === true) {
          score += 1;
          note("no construction next door, checked (they asked for quiet)", true);
        }
        if (p.quiet_area === true) {
          score += 1.5;
          note("quiet street (they asked for quiet)", true);
        } else if (p.quiet_area === false) {
          score -= 1.5;
          note("busy street, and they asked for quiet");
        }
      }
    }

    // ── Variety: what the broker already skipped for this lead goes down, not out ──
    const skipped = proposed.has(p.id.toUpperCase());
    if (skipped) note("already proposed to this lead in a draft the broker skipped");

    // ── Quality: what we know about the villa, only between equal fits ──
    const q = ctx.quality?.get(p.id.toUpperCase());
    if (q?.constructionNearby) {
      quality -= 1.5;
      note("construction nearby");
    }
    if (q?.redFlags) {
      quality -= Math.min(q.redFlags, 3);
      note(`${q.redFlags} red flag${q.redFlags === 1 ? "" : "s"} from the inspection`);
    }
    if (q?.greenFlags) {
      quality += Math.min(q.greenFlags, 3) * 0.5;
      note(`${q.greenFlags} green flag${q.greenFlags === 1 ? "" : "s"} from the inspection`);
    }
    if (p.pre_listed === false) {
      quality += 1;
      note("inspected (Listed)");
    }
    if (p.video_url) {
      quality += 1;
      note("video tour", true);
    }
    const photos = p.image_count ?? 0;
    if (photos > 0 && photos < 8) {
      quality -= 1;
      note(`only ${photos} photos`);
    } else if (q?.photosTemporary) {
      quality -= 0.5;
      note("temporary photos from its booking page");
    } else if (photos >= 10) {
      quality += 0.5;
      note("full photo set");
    }
    const checked = Date.parse(p.availability_checked_at ?? "");
    if (!Number.isNaN(checked) && (now - checked) / RANK_DAY_MS <= 21) {
      quality += 0.5;
      note(`dates confirmed ${dayLabel(p.availability_checked_at!.slice(0, 10))}`);
    }

    return { p, namedArea, score, skipped, quality, why, whyClient };
  });
  const key = ctx.rotationKey ?? "";
  return out.sort(
    (a, b) =>
      Number(b.namedArea) - Number(a.namedArea) ||
      b.score - a.score ||
      Number(a.skipped) - Number(b.skipped) ||
      b.quality - a.quality ||
      (key ? rotationTurn(key, a.p.id) - rotationTurn(key, b.p.id) : 0) ||
      a.p.id.localeCompare(b.p.id),
  );
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
  // "no more than 100 million for the year" (Karen, 08.09.2026) carried none
  // of the markers below, read as 100M a MONTH, and cleared three villas at
  // 270-290M a year through the budget filter.
  const PER_YEAR = /\/\s*year|per\s*year|a\s*year|for\s*(?:the|a|one|1)?\s*year|the\s*year|per\s*annum|\bp\.?a\.?\b|for\s*12\s*months|\/\s*yr\b|yearly|annual|в\s*год|годов/i;
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
      m.match(/(\d[\d.,]*)\s*(jt\b|juta|mio\b|mln\b|mill(?:ion)?s?\b|mil\b|млн|миллион)/) ??
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
      String.raw`(\d[\d.,]*)${RANGE_SEP.source}(\d[\d.,]*)\s*(jt\b|juta|mio\b|mln\b|mill(?:ion)?s?\b|mil\b|млн|миллион)`,
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
  // Candidates arrive ranked (rankShortlistFits): the best-ranked villa of the tier swaps in.
  const swapIn =
    candidates.find((p) => priceOf(p) > 0 && !chosen.has(p.id) && tierOf(p) === farthest) ??
    candidates.find((p) => priceOf(p) > 0 && !chosen.has(p.id) && tierOf(p) === 1);
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

/** A shortlist of one is a take-it-or-leave-it, not a choice. Never send fewer. */
const MIN_SHORTLIST = 2;

// ── The client's request: ONE definition, ONE filter (owner, 2026-09-14) ─────
//
// «Почему наш бот всё ещё отправляет не по запросу? Количество комнат, бюджет
// и район — это основа запроса, и предлагать нужно только в нём.»
//
// Every path that puts a villa in front of a client reads the request from
// resolveClientRequest and judges each villa with requestMisfits — the
// shortlist builders below (matchProperties for every bot draft,
// candidatesForLead for the edit path's composer), the prompt's inventory
// line, and the final check on a finished draft (enforceRequestOnDraft in
// generate-suggestion.ts). Before this the same idea lived in five copies
// that disagreed: extractLeadCriteria + matchProperties (a +15% budget
// "headroom", anchor alternatives at ±1 bedroom and any area),
// candidatesForLead (its own filter), availabilityForCriteria (a third count
// for the prompt), criteriaFromListing (a budget INVENTED as the clicked
// villa's price × 1.15) and pickPropertyAttachments (the clicked villa
// attached "fit or not", including one let until October 2027). Nothing read
// the move-in date, the stay length or a listing's minimum stay, and a
// client's "minimum 3 bedrooms" was read as exactly 3.

export type RequestSource = "broker" | "client" | "form" | "notes" | "clicked" | null;

export type ClientRequest = {
  bedroomsMin: number | null;
  /** Upper end of a stated range; null for a single count or an open "minimum N". */
  bedroomsMax: number | null;
  /** "minimum 3", "3+", "at least 3" — and the size of a clicked villa, which is a floor. */
  bedroomsAtLeast: boolean;
  /** Areas as the client named them — the site's names, or the client's own spelling for a place the site does not list (it then matches nothing). */
  areas: string[];
  /** The client (or broker) said nearby areas also work. Only then do neighbours count. */
  nearbyOk: boolean;
  /** The broker lifted the area filter on an edit ("look elsewhere"). */
  releaseArea: boolean;
  /** Client-facing monthly price ceiling, rupiah. No headroom is ever added. */
  budgetMaxIdr: number | null;
  budgetMinIdr: number | null;
  /** "Around 30 million": the figure itself — the ceiling and floor above are read 15% either way of it. */
  budgetAroundIdr?: number | null;
  /** ISO date. */
  moveIn: string | null;
  stayMonths: number | null;
  /**
   * Key features the client asked for (owner, 16.09.2026): a garden, a place to work, an enclosed
   * living room, a quiet street. They RANK villas inside the request (rankShortlistFits) and never
   * filter it — the request itself stays bedrooms, area, budget and dates.
   */
  wants: ClientWants;
  sources: { bedrooms: RequestSource; areas: RequestSource; budget: RequestSource; moveIn: RequestSource; stay: RequestSource };
};

export type ClientWants = { garden: boolean; workspace: boolean; enclosedLiving: boolean; quiet: boolean };

/** Words a wish must stand on in what a person wrote; the AI decides whether it IS a wish. */
const WANT_EVIDENCE: Record<keyof ClientWants, RegExp> = {
  garden: /garden|green|lawn|yard|taman|сад|зелен/i,
  workspace: /office|work ?space|work(?:ing)? from home|\bwfh\b|\bdesk\b|\bstudy\b|кабинет|рабоч/i,
  enclosedLiving: /living|lounge|open[- ]?plan|гостин/i,
  quiet: /quiet|calm|peaceful|nois|construct|building site|тих|шум|строй/i,
};

export type RequestInputs = {
  listingType: ListingType;
  /** The CLIENT's own messages, newest first. Never ours. */
  leadMessages: string[];
  /** What WE sent in this thread — a quoted message of ours is cut out of the client's reply (clientOwnWords). */
  ourMessages?: string[];
  /** The broker's instructions while editing a draft, newest first. */
  brokerInstructions?: string[];
  /** Parsed answers from the ad form on the amoCRM card. */
  cardCriteria?: { bedrooms: number | null; areas: string[]; budgetIdrMonthly: number | null } | null;
  /** The same answers as the client typed them. */
  cardAnswers?: { bedrooms: string | null; areas: string | null; budget: string | null; moveIn: string | null; notes: string | null } | null;
  cardBudgetTexts?: string[];
  /** Card notes — the scout's summary of the client's own post lives here. */
  leadNotes?: string | null;
  /** The villa an ad lead clicked: fills bedrooms (as a floor) and area only when nobody stated them. Never a budget. */
  clickedListingId?: string | null;
};

export function requestHasCore(r: ClientRequest | null | undefined): boolean {
  return !!r && (r.bedroomsMin !== null || r.areas.length > 0 || r.budgetMaxIdr !== null);
}

function millions(v: number): string {
  const m = v / 1_000_000;
  return `Rp ${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)} million`;
}

function dayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}

function baliTodayIso(): string {
  return new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * A move-in date the reader placed in the past. "I need to move in February",
 * said in September, is next February — Chloé's became "today", and a villa
 * free from 4 October was refused as too late for a client moving in five
 * months later. A date only weeks behind ("from 1 September" on the 14th) means now.
 */
export function nextOccurrenceIso(iso: string, today: string): string {
  if (iso >= today) return iso;
  const behindDays = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${iso}T00:00:00Z`)) / 86_400_000;
  if (!(behindDays > 45)) return today;
  const d = new Date(`${iso}T00:00:00Z`);
  while (d.toISOString().slice(0, 10) < today) d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

function addMonthsIso(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + Math.max(1, Math.round(months)));
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** The request in one line — for logs, the broker and the writer's prompt. */
export function describeRequest(r: ClientRequest): string {
  const parts: string[] = [];
  if (r.bedroomsMin !== null) {
    parts.push(
      r.bedroomsAtLeast
        ? `${r.bedroomsMin}+ bedrooms`
        : r.bedroomsMax !== null
          ? `${r.bedroomsMin}-${r.bedroomsMax} bedrooms`
          : `${r.bedroomsMin} bedroom${r.bedroomsMin === 1 ? "" : "s"}`,
    );
  }
  if (r.areas.length > 0) parts.push(`${r.areas.join(" / ")}${r.nearbyOk ? " or nearby" : ""}${r.releaseArea ? " (area released by the broker)" : ""}`);
  if (r.budgetAroundIdr) {
    parts.push(`around ${millions(r.budgetAroundIdr)} a month`);
  } else if (r.budgetMaxIdr !== null) {
    parts.push(
      r.budgetMinIdr
        ? `${millions(r.budgetMinIdr)} to ${millions(r.budgetMaxIdr).replace(/^Rp /, "")} a month`
        : `up to ${millions(r.budgetMaxIdr)} a month`,
    );
  }
  if (r.moveIn) parts.push(`move-in ${dayLabel(r.moveIn)}`);
  if (r.stayMonths) parts.push(`${r.stayMonths}-month stay`);
  const wants = [
    r.wants?.garden ? "a garden" : "",
    r.wants?.workspace ? "a place to work" : "",
    r.wants?.enclosedLiving ? "an enclosed living room" : "",
    r.wants?.quiet ? "a quiet street" : "",
  ].filter(Boolean);
  if (wants.length) parts.push(`wants ${wants.join(", ")}`);
  return parts.join(", ") || "no stated criteria";
}

const PROPERTY_URL = /https?:\/\/\S*\/property\/[A-Za-z0-9-]+\S*/gi;

function normWs(s: string): string {
  return String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** What follows the first `normLen` characters of `original`, counted the way normWs counts them. */
function afterNormalizedPrefix(original: string, normLen: number): string {
  const s = original.replace(/^\s+/, "");
  let n = 0;
  let i = 0;
  let inSpace = false;
  for (; i < s.length && n < normLen; i++) {
    if (/\s/.test(s[i]!)) {
      if (!inSpace) n++;
      inSpace = true;
    } else {
      n++;
      inSpace = false;
    }
  }
  return s.slice(i);
}

/**
 * The client's OWN words in one message — our quoted text is never the
 * client's (owner, 14.09.2026). A WhatsApp reply arrives as ">> <our message>
 * <their reply>". The quote is cut by matching it against what WE actually
 * sent, so it works whether or not the line breaks survived: content renders
 * every message on one line, and the old "after the last line break" rule then
 * dropped the client's reply whole, or — on a multi-line reply — kept only its
 * last line. With no matching message of ours the old rule stays; reading the
 * message whole turned our own "Rp 66 million/month" into the client's budget
 * (23335045). Links are removed.
 */
export function clientOwnWords(text: string, ourMessages: string[] = []): string {
  let t = String(text ?? "");
  if (t.startsWith(">>")) {
    const body = t.replace(/^>>\s*/, "");
    const nb = normWs(body);
    let cut = -1;
    for (const ours of ourMessages) {
      const no = normWs(ours);
      if (no.length >= 8 && no.length > cut && nb.startsWith(no)) cut = no.length;
    }
    if (cut >= 0) {
      t = afterNormalizedPrefix(body, cut);
    } else {
      const nl = t.lastIndexOf("\n");
      if (nl < 0) return "";
      t = t.slice(nl + 1);
    }
  }
  return t.replace(PROPERTY_URL, " ").replace(/\s+/g, " ").trim();
}

/** Card notes minus our own markers ("Ad enquiry: R-X — <villa title>" carries a size and an area that are the villa's, not the client's). */
function requestNotes(notes: string | null | undefined): string {
  const t = String(notes ?? "")
    .replace(/Ad enquiry:[^\n]*/gi, " ")
    .replace(/Link to the villa:[^\n]*/gi, " ")
    .replace(PROPERTY_URL, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length >= 12 ? t : "";
}

const BEDROOM_WORDS = /\d\s*\+?\s*(?:-|–|to|or|или|\/)?\s*\d?\s*(?:br\b|bed|bdr|bedroom|kamar|спал)|bedroom|спальн|kamar tidur/i;
const MONEY_WORDS = /budget|бюджет|harga|\$\s?\d|usd|idr|\brp\b|rupiah|juta|\bjt\b|million|\bmill?\b|\bmio\b|\bmln\b|млн|\d\s*m\b|per month|a month|\/mo\b|per year|\/year|в месяц/i;
const NEARBY_WORDS = /nearby|near by|around there|surrounding|neighbou?r|flexible on (the )?(area|location)|any area|рядом|поблизости|окрестност|sekitar/i;
/** A budget said as a target: "around 30", "ideally 30mil", "~30jt", "30ish". */
const APPROXIMATE_BUDGET = /\b(?:around|about|approx(?:imately)?|roughly|ideally|circa|something like|more or less|sekitar|kisaran)\s+(?:of\s+|is\s+|be\s+)?(?:rp\.?\s*|idr\s*|\$\s*)?\d|~\s*(?:rp\.?\s*)?\d|\d[\d.,]*\s*(?:m|mil|million|jt|juta|k)?\s*(?:-?ish\b|or so\b|give or take\b)|(?:около|примерно|в районе)\s*\d/i;
/** A budget said as a limit — never read with any headroom. */
const HARD_BUDGET_CEILING = /\b(?:max(?:imum)?|up to|no more than|not more than|under|below|less than|at most|top|limit|ceiling|maks(?:imal)?)\b|не больше|не более|максимум/i;
const BROKER_RELEASES_AREA_WIDE = /whole island|anywhere|по всему острову|другие районы|других районах/i;

function titleCaseWords(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

const requestCache = new Map<string, { at: number; value: ClientRequest }>();
const REQUEST_TTL_MS = 10 * 60 * 1000;

function copyRequest(r: ClientRequest): ClientRequest {
  return { ...r, areas: [...r.areas], wants: { ...r.wants }, sources: { ...r.sources } };
}

/**
 * What this client asked for — bedrooms, area, budget, move-in, stay — from the
 * sources a person actually stated it in, most authoritative first: the broker's
 * edit instruction, the client's own messages (newest statement wins), the ad
 * form, the scout's summary of their post, and only then — for size and area,
 * never money — the villa they clicked. Never from a villa or a price WE sent.
 */
export async function resolveClientRequest(inp: RequestInputs): Promise<ClientRequest> {
  const broker = (inp.brokerInstructions ?? [])
    .map((t) => String(t ?? "").replace(PROPERTY_URL, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 6);
  const ourSent = (inp.ourMessages ?? []).map(String);
  const client = (inp.leadMessages ?? []).map((t) => clientOwnWords(t, ourSent)).filter(Boolean).slice(0, 25);
  const answers = inp.cardAnswers ?? null;
  const formLines = answers
    ? ([
        ["bedrooms", answers.bedrooms],
        ["area", answers.areas],
        ["budget", answers.budget],
        ["move-in", answers.moveIn],
        ["notes", answers.notes],
      ] as Array<[string, string | null]>)
        .filter(([, v]) => v && String(v).trim())
        .map(([k, v]) => `${k}: ${String(v).trim()}`)
    : [];
  const notes = requestNotes(inp.leadNotes);
  const today = baliTodayIso();
  const key = JSON.stringify([inp.listingType, broker, client, formLines, inp.cardCriteria ?? null, inp.cardBudgetTexts ?? [], notes, inp.clickedListingId ?? null, today]);
  const hit = requestCache.get(key);
  if (hit && Date.now() - hit.at < REQUEST_TTL_MS) return copyRequest(hit.value);

  const all = await fetchAllProperties().catch(() => [] as SupabaseProperty[]);
  const vocab = [...new Set([...allAreaNames(), ...all.map((p) => (p.area ?? "").trim())])].filter(Boolean);

  const r: ClientRequest = {
    bedroomsMin: null,
    bedroomsMax: null,
    bedroomsAtLeast: false,
    areas: [],
    nearbyOk: false,
    releaseArea: broker.some((t) => BROKER_RELEASES_AREA.test(t) || BROKER_RELEASES_AREA_WIDE.test(t)),
    budgetMaxIdr: null,
    budgetMinIdr: null,
    budgetAroundIdr: null,
    moveIn: null,
    stayMonths: null,
    wants: { garden: false, workspace: false, enclosedLiving: false, quiet: false },
    sources: { bedrooms: null, areas: null, budget: null, moveIn: null, stay: null },
  };

  const sections = [
    broker.length ? `BROKER (edit instruction, newest first):\n${broker.map((t) => `- ${t}`).join("\n")}` : "",
    client.length ? `CLIENT (their own messages, newest first):\n${client.map((t) => `- ${t.slice(0, 600)}`).join("\n")}` : "",
    formLines.length ? `FORM (what the client typed into the ad form):\n${formLines.join("\n")}` : "",
    notes ? `NOTES (our scout's summary of the client's own post):\n${notes.slice(0, 1200)}` : "",
  ].filter(Boolean);
  const allText = [...broker, ...client, ...formLines, notes].join("\n");
  const lowerAll = allText.toLowerCase();
  const src = (v: unknown): RequestSource =>
    v === "broker" || v === "client" || v === "form" || v === "notes" ? v : null;

  type AiRequest = {
    bedrooms_min?: number | null;
    bedrooms_max?: number | null;
    bedrooms_at_least?: boolean;
    bedrooms_source?: string | null;
    areas?: string[];
    other_places?: string[];
    areas_source?: string | null;
    nearby_ok?: boolean;
    budget_max_idr_monthly?: number | null;
    budget_min_idr_monthly?: number | null;
    budget_source?: string | null;
    move_in?: string | null;
    move_in_source?: string | null;
    stay_months?: number | null;
    stay_source?: string | null;
    wants_garden?: boolean;
    wants_workspace?: boolean;
    wants_enclosed_living?: boolean;
    wants_quiet?: boolean;
  };
  let ai: AiRequest | null = null;
  if (sections.length > 0) {
    try {
      ai = await chatCompletionJSON<AiRequest>({
        model: HELPER_MODEL,
        label: "client-request",
        system: `You read what a client of a Bali villa agency (rental or purchase) has asked for, and return it as a filter. Today is ${today}.

Sources, most authoritative first. For EACH field take the value from the most authoritative source that states it; inside one source the NEWEST statement wins ("actually 3 bedrooms" overrides an earlier "2 bedrooms"):
1. BROKER — the broker's instruction while editing a draft (only when present).
2. CLIENT — the client's own messages, newest first. A line starting with ">>" quotes OUR earlier message: use what that quote says only when the client's reply after it confirms it ("Yes", "correct"). A question about what we have ("maybe you have a one bedroom villa with a little garden?", "do you have something near Nuanu?") states what they want NOW — it is their newest statement for every field it names.
3. FORM — the client's answers in the ad form. "Other", "-", "No", "Any" or a lone symbol are no answer.
4. NOTES — our scout's summary of the client's own post.
Never take a value from a villa WE described or offered, from a listing's title, or from a link the client clicked. Never fill in a typical value — null when nobody stated it.

Valid area names (use exactly these spellings in "areas"):
${vocab.join(", ")}

Return JSON with exactly these keys:
- "bedrooms_min": integer or null. A range ("2-3BR", "2 or 3 bedrooms") -> the lower end. "minimum 3", "3+", "at least 3", "3 or more" -> 3.
- "bedrooms_max": the upper end of a stated range ("also open to 4-5BR" after "minimum 3" -> 5); null for a single number or an open-ended minimum.
- "bedrooms_at_least": true only for an open-ended minimum with no upper end.
- "bedrooms_source": "broker" | "client" | "form" | "notes" | null.
- "areas": names from the list above that the request names — every area they would accept ("Canggu, also open to Uluwatu" -> both). Names are often misspelled or voice-typed: "berewa" is Berawa, "pad on an" is Padonan, "cannot" inside a list of areas is Canggu — return the valid spelling.
- "other_places": places the request names that are NOT on the list, spelled as written (e.g. "Kedungu"). A place named only as a limit or a landmark ("no further inland than X", "near Y beach", "close to Z cafe") is not an area. [] when none.
- "areas_source": as above.
- "nearby_ok": true only when they say nearby / surrounding areas / anywhere around also work.
- "budget_max_idr_monthly": monthly ceiling in rupiah as an integer. "40 million"/"40jt"/"40mil" -> 40000000; "ideally around 30 million" -> 30000000; a yearly figure divided by 12; USD x 16000; a range -> its upper end; different budgets for different sizes -> the largest. Null when no budget was stated.
- "budget_min_idr_monthly": the lower end of a stated range, else null.
- "budget_source": as above.
- "move_in": the move-in date as YYYY-MM-DD. "asap", "now", "immediately" -> today; "tomorrow" -> tomorrow; "this month" -> the last day of this month; "next month" -> the 1st of next month; "in 1-2 months" -> today plus one month; a month name -> the 1st of its NEXT occurrence, never a past date (said in September, "February" is February of next year); a range of dates -> its start. Null when unstated.
- "move_in_source": as above.
- "stay_months": integer. "3 months" -> 3; "21 Sep - 18 Dec" -> 3; "a year", "yearly contract", "12 months" -> 12; "6-12 months" -> 6. "long term" alone -> null. Null when unstated.
- "stay_source": as above.
- "wants_garden": true only when a person asks for a garden, a lawn, green outdoor space, or "something greener" in the place they want. A school, cafe or other place whose NAME has "garden" in it is not a wish.
- "wants_workspace": true when they need an office, a study, a desk or a room to work from home.
- "wants_enclosed_living": true when they want an enclosed / closed / proper living room, or say they do not like open-plan or open living rooms.
- "wants_quiet": true when they want a quiet or calm place, or no construction or noise next to it.
The four "wants_" keys are false when nobody asked; a feature of a villa WE described is never their wish.`,
        messages: [{ role: "user", content: sections.join("\n\n").slice(0, 6000) }],
        max_tokens: 400,
        temperature: 0,
      });
    } catch (err) {
      logger.warn({ err }, "resolveClientRequest: AI read failed — falling back to patterns and the form");
      ai = null;
    }
  }

  // Bedrooms — evidence required: a count nobody wrote next to a bedroom word is a guess.
  if (ai && typeof ai.bedrooms_min === "number" && ai.bedrooms_min > 0 && ai.bedrooms_min < 15 && BEDROOM_WORDS.test(allText)) {
    r.bedroomsMin = Math.round(ai.bedrooms_min);
    const max = typeof ai.bedrooms_max === "number" ? Math.round(ai.bedrooms_max) : null;
    r.bedroomsMax = max !== null && max > r.bedroomsMin ? max : null;
    r.bedroomsAtLeast = r.bedroomsMax === null && ai.bedrooms_at_least === true;
    r.sources.bedrooms = src(ai.bedrooms_source) ?? "client";
  } else if (!ai) {
    for (const [s, texts] of [["broker", broker], ["client", client], ["notes", notes ? [notes] : []]] as Array<[RequestSource, string[]]>) {
      if (!texts.length) continue;
      const found = extractLeadCriteriaRegex(texts, all);
      if (found.bedrooms !== null) {
        r.bedroomsMin = found.bedrooms;
        r.bedroomsMax = found.bedroomsMax;
        r.sources.bedrooms = s;
        break;
      }
    }
  }
  if (r.bedroomsMin === null && inp.cardCriteria?.bedrooms) {
    r.bedroomsMin = inp.cardCriteria.bedrooms;
    r.sources.bedrooms = "form";
  }

  // Areas — every name must be in what a person wrote: literally, or misspelled
  // inside a list of places (fuzzyAreaNamesInText: "berewa", "pad on an").
  if (ai) {
    const named = new Set([...areaNamesInText(allText), ...fuzzyAreaNamesInText(allText, vocab)].map((a) => a.toLowerCase()));
    const fromList = (ai.areas ?? [])
      .map((a) => vocab.find((k) => k.toLowerCase() === String(a).trim().toLowerCase()))
      .filter((a): a is string => !!a && (lowerAll.includes(a.toLowerCase()) || named.has(a.toLowerCase())));
    const others = (ai.other_places ?? [])
      .map((p) => String(p ?? "").trim())
      .filter((p) => p.length > 2 && lowerAll.includes(p.toLowerCase()))
      .map((p) => vocab.find((k) => k.toLowerCase() === p.toLowerCase()) ?? titleCaseWords(p));
    const areas = [...new Set([...fromList, ...others])];
    // A dictated list of places is the client's request even when the model
    // kept only the form's area or dropped the misspelled items (Luke, 14.09:
    // "also cannot, berewa, pad on an, seseh are also suitable" became Umalas
    // / Seseh). Only a client message that lists two or more places with at
    // least one misspelling is read this way, and a place it says NO to stays out.
    for (const msg of client) {
      const fuzzy = fuzzyAreaNamesInText(msg, vocab);
      if (fuzzy.length === 0) continue;
      const exact = areaNamesInText(msg).filter((a) => {
        const esc = a.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return !new RegExp(`\\b(not|no|avoid|except|without|never|don'?t want|rather than|instead of)\\b[^,.;!?]{0,20}\\b${esc}\\b`, "i").test(msg);
      });
      const listed = [...new Set([...exact, ...fuzzy])];
      if (listed.length < 2) continue;
      const modelReadThisList = listed.some((a) => areas.some((x) => x.toLowerCase() === a.toLowerCase()));
      if (!modelReadThisList && src(ai.areas_source) === "client") continue;
      for (const a of listed) if (!areas.some((x) => x.toLowerCase() === a.toLowerCase())) areas.push(a);
    }
    if (areas.length > 0) {
      r.areas = areas;
      r.sources.areas = src(ai.areas_source) ?? "client";
    }
    r.nearbyOk = ai.nearby_ok === true && NEARBY_WORDS.test(allText);
  } else {
    for (const [s, texts] of [["broker", broker], ["client", client], ["notes", notes ? [notes] : []]] as Array<[RequestSource, string[]]>) {
      if (!texts.length) continue;
      const found = extractLeadCriteriaRegex(texts, all);
      if (found.areas.length > 0) {
        r.areas = found.areas;
        r.sources.areas = s;
        break;
      }
    }
  }
  // A landmark stands for the areas around it (Sophie 12.09, "something near
  // the Nuanu?": Nuanu matched no villa and Seseh/Cemagi/Tabanan stayed shut).
  const landmarks = landmarkAreasInText([...broker, ...client, notes].join("\n"));
  if (landmarks.length > 0) {
    const known = new Map(vocab.map((v) => [v.toLowerCase(), v]));
    const near = [...new Set(landmarks.flatMap((l) => l.areas).map((a) => known.get(a.toLowerCase())).filter((a): a is string => !!a))];
    if (near.length > 0) {
      const markWords = landmarks.map((l) => l.landmark.toLowerCase().split(" ")[0]!);
      const kept = r.areas.filter((a) => !markWords.some((w) => a.toLowerCase().includes(w)));
      r.areas = [...new Set([...kept, ...near])];
      if (!r.sources.areas) r.sources.areas = broker.length ? "broker" : "client";
      logger.info({ landmarks: landmarks.map((l) => l.landmark), areas: near }, "client request: a landmark read as the areas around it");
    }
  }

  if (r.areas.length === 0 && (inp.cardCriteria?.areas?.length ?? 0) > 0) {
    r.areas = [...inp.cardCriteria!.areas];
    r.sources.areas = "form";
  }

  // Budget — rentals only. The deterministic parser reads each source in order
  // of authority (it has years of phrasing fixes: yearly figures, raw digits,
  // "M" shorthand); the model's reading is the fallback, and only when money
  // was actually mentioned. Never a price of a villa, never with headroom.
  if (inp.listingType === "rent") {
    const formTexts = (inp.cardBudgetTexts ?? []).map((t) => (/^\s*\d{1,4}([.,]\d+)?\s*$/.test(t) ? `${t.trim()} million` : t));
    for (const [s, texts] of [["broker", broker], ["client", client], ["form", formTexts], ["notes", notes ? [notes] : []]] as Array<[RequestSource, string[]]>) {
      if (!texts.length) continue;
      const max = extractBudgetIdr(texts);
      if (!max) continue;
      r.budgetMaxIdr = max;
      const floor = extractBudgetFloorIdr(texts);
      r.budgetMinIdr = floor && floor < max ? floor : null;
      r.sources.budget = s;
      break;
    }
    if (r.budgetMaxIdr === null && inp.cardCriteria?.budgetIdrMonthly) {
      r.budgetMaxIdr = inp.cardCriteria.budgetIdrMonthly;
      r.sources.budget = "form";
    }
    // "Ideally around 30mil" is a target, not a ceiling (Lance, 12.09): read as
    // "up to 30" it shut out the 33M villa that fit everything else. A figure
    // the client gives with around / ideally / roughly is read 15% either
    // way; a stated ceiling ("max", "up to", "under") never gets headroom.
    if (r.sources.budget === "client" && r.budgetMaxIdr !== null) {
      const said = client.find((t) => extractBudgetIdr([t]) === r.budgetMaxIdr);
      if (said && APPROXIMATE_BUDGET.test(said) && !HARD_BUDGET_CEILING.test(said)) {
        r.budgetAroundIdr = r.budgetMaxIdr;
        r.budgetMaxIdr = Math.round((r.budgetAroundIdr * 1.15) / 100_000) * 100_000;
        r.budgetMinIdr = Math.round((r.budgetAroundIdr * 0.85) / 100_000) * 100_000;
      }
    }
    const aiMax = Number(ai?.budget_max_idr_monthly);
    if (r.budgetMaxIdr === null && Number.isFinite(aiMax) && aiMax >= 1_000_000 && aiMax < 2_000_000_000 && MONEY_WORDS.test(allText)) {
      r.budgetMaxIdr = Math.round(aiMax);
      const aiMin = Number(ai?.budget_min_idr_monthly);
      r.budgetMinIdr = Number.isFinite(aiMin) && aiMin >= 1_000_000 && aiMin < aiMax ? Math.round(aiMin) : null;
      r.sources.budget = src(ai?.budget_source) ?? "client";
    }

    if (ai?.move_in && /^\d{4}-\d{2}-\d{2}$/.test(ai.move_in) && !Number.isNaN(Date.parse(ai.move_in))) {
      r.moveIn = nextOccurrenceIso(ai.move_in, today);
      r.sources.moveIn = src(ai.move_in_source) ?? "client";
    }
    const stay = Number(ai?.stay_months);
    if (Number.isFinite(stay) && stay >= 1 && stay <= 60) {
      r.stayMonths = Math.round(stay);
      r.sources.stay = src(ai?.stay_source) ?? "client";
    }
  }

  // The villa an ad lead clicked: what they have shown us without words. Size
  // as a floor, its district — and nothing about money.
  const clicked = inp.clickedListingId
    ? all.find((p) => p.id.toUpperCase() === inp.clickedListingId!.trim().toUpperCase())
    : undefined;
  if (clicked) {
    if (r.bedroomsMin === null && clicked.bedrooms) {
      r.bedroomsMin = clicked.bedrooms;
      r.bedroomsAtLeast = true;
      r.sources.bedrooms = "clicked";
    }
    if (r.areas.length === 0 && clicked.area) {
      const parent = parentAreaOf(clicked.area.split(",")[0]);
      if (parent) {
        r.areas = [parent];
        r.sources.areas = "clicked";
      }
    }
  }

  // Key features: a wish counts only when the AI read one AND its words are in what a person wrote.
  if (ai) {
    const said = (k: keyof ClientWants, v: unknown) => v === true && WANT_EVIDENCE[k].test(allText);
    r.wants = {
      garden: said("garden", ai.wants_garden),
      workspace: said("workspace", ai.wants_workspace),
      enclosedLiving: said("enclosedLiving", ai.wants_enclosed_living),
      quiet: said("quiet", ai.wants_quiet),
    };
  }

  if (requestCache.size > 300) requestCache.clear();
  requestCache.set(key, { at: Date.now(), value: copyRequest(r) });
  logger.info({ request: describeRequest(r), sources: r.sources }, "client request resolved");
  return r;
}

export type Misfit = { dim: "bedrooms" | "area" | "budget" | "dates"; why: string };

function requestAreaSet(r: ClientRequest): string[] {
  if (r.releaseArea || r.areas.length === 0) return [];
  return r.nearbyOk ? [...new Set([...r.areas, ...r.areas.flatMap((a) => neighbourAreas(a))])] : r.areas;
}

/**
 * Why this villa is NOT inside the request — empty when it is. The one judge:
 * bedrooms exactly as asked (a range / "at least" as stated, never ±1), the
 * named areas only (neighbours only when the client said nearby is fine), the
 * published monthly price at or under the ceiling with no headroom, free on the
 * move-in date and for the whole stay, a minimum stay no longer than theirs.
 */
export function requestMisfitDims(p: SupabaseProperty, r: ClientRequest, now: Date = new Date()): Misfit[] {
  const out: Misfit[] = [];
  if (r.bedroomsMin !== null) {
    const b = p.bedrooms;
    const ok =
      typeof b === "number" &&
      (r.bedroomsAtLeast
        ? b >= r.bedroomsMin
        : r.bedroomsMax !== null
          ? b >= r.bedroomsMin && b <= r.bedroomsMax
          : b === r.bedroomsMin);
    if (!ok) out.push({ dim: "bedrooms", why: typeof b === "number" ? `${b}BR` : "bedrooms unknown" });
  }
  const areas = requestAreaSet(r);
  if (areas.length > 0 && !areaMatches(p.area, areas)) out.push({ dim: "area", why: `in ${p.area ?? "an unknown area"}` });
  if (p.listing_type === "rent") {
    const price = priceOf(p);
    if (r.budgetMaxIdr !== null) {
      if (price <= 0) out.push({ dim: "budget", why: "no published price" });
      else if (price > r.budgetMaxIdr) out.push({ dim: "budget", why: `${millions(price)} is over ${millions(r.budgetMaxIdr)}` });
    }
    if (r.budgetMinIdr !== null && price > 0 && price < Math.round(r.budgetMinIdr * 0.85)) {
      out.push({ dim: "budget", why: `${millions(price)} is well below their range` });
    }
    if (r.stayMonths !== null) {
      const minStay = Number(p.min_stay_months ?? 0);
      const monthly = Number(p.monthly_price_idr ?? 0) > 0 || Number(p.monthly_price_usd ?? 0) > 0;
      const yearly = Number(p.yearly_price_idr ?? 0) > 0 || Number(p.yearly_price_usd ?? 0) > 0;
      if (minStay > r.stayMonths) out.push({ dim: "dates", why: `minimum stay ${minStay} months` });
      else if (!monthly && yearly && r.stayMonths < 12) out.push({ dim: "dates", why: "yearly contract only" });
    }
    if (r.moveIn) {
      if (p.free_from && p.free_from > r.moveIn) {
        out.push({ dim: "dates", why: `free only from ${p.free_from}` });
      } else {
        const end = addMonthsIso(r.moveIn, r.stayMonths ?? 1);
        const clash = (p.busy ?? []).find((b) => b.start <= end && b.end >= r.moveIn!);
        if (clash) out.push({ dim: "dates", why: `booked ${clash.start}..${clash.end}` });
      }
      return out;
    }
  }
  if (!offerableNow(p, now)) out.push({ dim: "dates", why: `free only from ${p.free_from}` });
  return out;
}

export function requestMisfits(p: SupabaseProperty, r: ClientRequest, now: Date = new Date()): string[] {
  return requestMisfitDims(p, r, now).map((m) => m.why);
}

/** The closest real villa behind a relax hint — described to a client in plain words, never by its code. */
export type RelaxExample = { id: string; title: string; bedrooms: number | null; area: string | null; priceIdr: number; freeFrom: string | null };

/** The one dimension whose loosening would open the most villas — the question to ask when nothing fits. */
export type RelaxHint = {
  dim: "area" | "budget" | "bedrooms" | "dates";
  count: number;
  suggestion: string;
  example?: RelaxExample | null;
  /** dim "area": the area names the suggestion offers (the edit path draws from them when the broker asks for options). */
  areas?: string[];
};

function relaxationHint(r: ClientRequest, judged: Array<{ p: SupabaseProperty; m: Misfit[] }>): RelaxHint | null {
  const byDim = new Map<Misfit["dim"], SupabaseProperty[]>();
  for (const j of judged) {
    const dims = new Set(j.m.map((x) => x.dim));
    if (dims.size !== 1) continue;
    const d = j.m[0]!.dim;
    byDim.set(d, [...(byDim.get(d) ?? []), j.p]);
  }
  const hints: RelaxHint[] = [];
  const mostCommon = (vals: string[]): string[] => {
    const counts = new Map<string, number>();
    for (const v of vals) counts.set(v, (counts.get(v) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
  };
  // "Ask ONE concrete question naming the nearest real option" (owner,
  // 14.09.2026): not "could the area flex?" and never "I'll come back with a
  // shortlist" — "there is a 1-bedroom in Pererenan at Rp 30 million, would
  // Pererenan work?". The example is the priced villa closest to their money.
  const target = r.budgetAroundIdr ?? r.budgetMaxIdr;
  const exampleOf = (ps: SupabaseProperty[]): RelaxExample | null => {
    const priced = ps.filter((p) => priceOf(p) > 0);
    const pool = priced.length > 0 ? priced : ps;
    const best = [...pool].sort((a, b) =>
      target ? Math.abs(priceOf(a) - target) - Math.abs(priceOf(b) - target) : priceOf(a) - priceOf(b),
    )[0];
    return best
      ? { id: best.id, title: best.title, bedrooms: best.bedrooms ?? null, area: parentAreaOf((best.area ?? "").split(",")[0]) ?? best.area ?? null, priceIdr: priceOf(best), freeFrom: best.free_from ?? null }
      : null;
  };
  const areaOnly = byDim.get("area") ?? [];
  const near = areaOnly.filter((p) => r.areas.some((a) => neighbourAreas(a).some((n) => areaMatches(p.area, [n]))));
  const areaPool = near.length > 0 ? near : areaOnly;
  if (areaPool.length > 0) {
    const names = mostCommon(areaPool.map((p) => parentAreaOf((p.area ?? "").split(",")[0]) ?? p.area ?? "")).filter(Boolean).slice(0, near.length > 0 ? 2 : 1);
    const inNamed = areaPool.filter((p) => names.includes(parentAreaOf((p.area ?? "").split(",")[0]) ?? p.area ?? ""));
    hints.push({ dim: "area", count: areaPool.length, suggestion: near.length > 0 ? `nearby ${names.join(" or ")}` : names.join(" or "), example: exampleOf(inNamed), areas: names });
  }
  const over = (byDim.get("budget") ?? []).filter((p) => r.budgetMaxIdr !== null && priceOf(p) > r.budgetMaxIdr && priceOf(p) <= r.budgetMaxIdr * 1.3);
  if (over.length > 0) {
    const cheapest = Math.min(...over.map(priceOf));
    hints.push({ dim: "budget", count: over.length, suggestion: `a budget of about ${millions(cheapest)} a month`, example: exampleOf(over.filter((p) => priceOf(p) === cheapest)) });
  }
  const beds = byDim.get("bedrooms") ?? [];
  if (beds.length > 0 && r.bedroomsMin !== null) {
    const bedTarget = r.bedroomsMin;
    const nearest = [...new Set(beds.map((p) => p.bedrooms).filter((b): b is number => typeof b === "number"))]
      .sort((a, b) => Math.abs(a - bedTarget) - Math.abs(b - bedTarget) || a - b)[0];
    // Only an adjacent size is a fair question — a 1BR client is not asked about 3 bedrooms.
    if (nearest !== undefined && Math.abs(nearest - bedTarget) <= 1) {
      const sized = beds.filter((p) => p.bedrooms === nearest);
      hints.push({ dim: "bedrooms", count: sized.length, suggestion: `${nearest} bedroom${nearest === 1 ? "" : "s"}`, example: exampleOf(sized) });
    }
  }
  const dates = byDim.get("dates") ?? [];
  if (dates.length > 0) {
    const earliest = dates.map((p) => p.free_from).filter((d): d is string => !!d).sort()[0];
    hints.push({
      dim: "dates",
      count: dates.length,
      suggestion: earliest && (!r.moveIn || earliest > r.moveIn) ? `moving in from ${dayLabel(earliest)}` : "a longer contract",
      example: exampleOf(earliest ? dates.filter((p) => p.free_from === earliest) : dates),
    });
  }
  hints.sort((a, b) => b.count - a.count);
  return hints[0] ?? null;
}

/**
 * Every villa inside the request, best first — the ONLY candidate list any
 * shortlist is drawn from. `fitsInclSent` counts fits the client already has,
 * so an empty list can tell "nothing exists" from "you have seen it all".
 */
export async function strictShortlistPool(
  r: ClientRequest,
  opts: { listingType: ListingType; excludeIds?: string[]; proposedIds?: string[]; rotationKey?: string | null },
): Promise<{ fits: SupabaseProperty[]; ranked: RankedFit[]; fitsInclSent: number; poolSize: number; hint: RelaxHint | null }> {
  const all = await fetchAllProperties();
  const exclude = new Set((opts.excludeIds ?? []).map((id) => id.toUpperCase()));
  const typed = all.filter((p) => p.listing_type === opts.listingType);
  const now = new Date();
  const judged = typed.map((p) => ({ p, m: requestMisfitDims(p, r, now) }));
  const fitAll = judged.filter((j) => j.m.length === 0).map((j) => j.p);
  let fits = fitAll.filter((p) => !exclude.has(p.id.toUpperCase()));
  // Priced stock first — an unpriced villa can't be judged by the client; it
  // only appears when there is no real choice without it (never when a budget
  // was stated: requestMisfits already refused it).
  const priced = fits.filter(hasPrice);
  if (priced.length >= MIN_SHORTLIST) fits = priced;
  // Ranked BEFORE anything is cut or shown (rankShortlistFits). A stated
  // range's floor still comes first; the stable sort keeps the rank inside.
  const quality = await listingQualityById().catch(() => new Map<string, ListingQuality>());
  const floor = r.budgetMinIdr;
  const scored = rankShortlistFits(fits, r, { quality, proposedIds: opts.proposedIds, rotationKey: opts.rotationKey, now });
  if (floor) scored.sort((a, b) => (priceOf(a.p) >= floor ? 0 : 1) - (priceOf(b.p) >= floor ? 0 : 1));
  const keep = new Set(dedupeByTitle(scored.map((x) => x.p)).map((p) => p.id));
  const ranked = scored.filter((x) => keep.has(x.p.id));
  fits = ranked.map((x) => x.p);
  const hint = fits.length === 0 ? relaxationHint(r, judged.filter((j) => !exclude.has(j.p.id.toUpperCase()))) : null;
  return { fits, ranked, fitsInclSent: fitAll.length, poolSize: typed.length, hint };
}

/** What a shortlist decision knew — handed to the writer's prompt and to the final check on the draft. */
export type ShortlistOutcome = {
  request: ClientRequest;
  hasCore: boolean;
  /** Villas inside the request the client has NOT been sent yet. */
  fitCount: number;
  fitCountInclSent: number;
  hint: RelaxHint | null;
  /** Everything already sent to this lead. */
  excludeIds: string[];
  /** Villas fit, but the matcher decided this message carries none (the lead is on a viewing, etc.). */
  declined: boolean;
  /** Villas already sent that are outside the request, with the reasons — never to be called a match. */
  sentOutside: OutsideVilla[];
  /** The villa the client named or clicked, when it is outside their own request. */
  namedOutside: OutsideVilla[];
};

export type OutsideVilla = { id: string; title: string; why: string[] };

/**
 * The request's outcome without any AI choice: the strict pool, the question
 * to ask when it is empty, and which villas the client already has (or asked
 * about) that are outside it. Used by the matcher and by drafts that carry no
 * new links by design, so the writer never calls an outside villa a match.
 */
export async function shortlistOutcomeFor(
  request: ClientRequest,
  opts: { listingType: ListingType; excludeIds?: string[]; namedIds?: string[]; proposedIds?: string[]; rotationKey?: string | null },
): Promise<{ outcome: ShortlistOutcome; fits: SupabaseProperty[]; ranked: RankedFit[] }> {
  const excludeIds = opts.excludeIds ?? [];
  const pool = await strictShortlistPool(request, {
    listingType: opts.listingType,
    excludeIds,
    proposedIds: opts.proposedIds,
    rotationKey: opts.rotationKey,
  });
  const hasCore = requestHasCore(request);
  const all = await fetchAllProperties();
  const byId = new Map(all.map((p) => [p.id.toUpperCase(), p]));
  const sent = new Set(excludeIds.map((i) => i.toUpperCase()));
  const outside = (ids: string[]): OutsideVilla[] =>
    [...new Set(ids.map((i) => i.toUpperCase()))]
      .map((id) => byId.get(id))
      .filter((p): p is SupabaseProperty => !!p && p.listing_type === opts.listingType)
      .map((p) => ({ id: p.id, title: p.title, why: requestMisfits(p, request) }))
      .filter((v) => v.why.length > 0);
  return {
    fits: pool.fits,
    ranked: pool.ranked,
    outcome: {
      request,
      hasCore,
      fitCount: pool.fits.length,
      fitCountInclSent: pool.fitsInclSent,
      hint: pool.hint,
      excludeIds,
      declined: false,
      sentOutside: hasCore ? outside(excludeIds).slice(0, 6) : [],
      namedOutside: hasCore ? outside((opts.namedIds ?? []).filter((i) => !sent.has(i.toUpperCase()))).slice(0, 3) : [],
    },
  };
}



/**
 * The candidate list and the money facts for the EDIT path's composer, drawn
 * from the same strict pool as every bot draft (strictShortlistPool). The
 * broker's instructions of this editing session are the most authoritative
 * source of the request; a hand-curated panel or a villa the broker names is
 * handled by the caller and never comes from here.
 */
export async function candidatesForLead(opts: {
  listingType: ListingType;
  excludeIds?: string[];
  recentLeadMessages?: string[];
  brokerInstruction?: string | null;
  /** Earlier instructions from the same editing session, NEWEST FIRST. The
   * pool used to be built from the latest instruction alone: "attach the
   * options too", given right after "2BR in Berawa or Umalas under 50M", fell
   * back to the card's 1BR-in-Canggu and came back EMPTY under a text that
   * described two villas (Githaa, 08.09.2026). */
  priorInstructions?: string[];
  cardCriteria?: { bedrooms: number | null; areas: string[]; budgetIdrMonthly: number | null } | null;
  cardAnswers?: RequestInputs["cardAnswers"];
  cardBudgetTexts?: string[];
  leadNotes?: string | null;
  clickedListingId?: string | null;
  /** Villas equal on everything take turns between leads (rankShortlistFits). */
  leadId?: string | null;
  /** What WE sent — a quoted message of ours is not the client's words. */
  ourMessages?: string[];
  /** The broker asked for options: when only the client's area stands in the way, draw from the nearest area that has them. */
  widenAreaWhenEmpty?: boolean;
}): Promise<{
  candidates: SupabaseProperty[];
  request: ClientRequest;
  /** Set when the client's own area held nothing and the pool comes from the nearest area instead. */
  widenedArea: { asked: string[]; used: string[] } | null;
  /** With an empty pool: the one question worth asking, with the closest real option. */
  hint: RelaxHint | null;
  /** Fits including the ones already sent — tells "nothing exists" from "they have it all". */
  fitsInclSent: number;
  /** The stated ceiling — no headroom (kept under the old names for the callers). */
  budgetIdr: number | null;
  budgetCeiling: number | null;
  budgetFloorIdr: number | null;
  lines: Array<{ id: string; line: string }>;
  /** Priced candidates, in shortlist order — every one inside the request. */
  affordableIds: string[];
}> {
  const instructions = [opts.brokerInstruction ?? "", ...(opts.priorInstructions ?? [])].filter((t) => (t ?? "").trim());
  const request = await resolveClientRequest({
    listingType: opts.listingType,
    leadMessages: opts.recentLeadMessages ?? [],
    ourMessages: opts.ourMessages ?? [],
    brokerInstructions: instructions,
    cardCriteria: opts.cardCriteria ?? null,
    cardAnswers: opts.cardAnswers ?? null,
    cardBudgetTexts: opts.cardBudgetTexts ?? [],
    leadNotes: opts.leadNotes ?? null,
    clickedListingId: opts.clickedListingId ?? null,
  });
  let pool = await strictShortlistPool(request, {
    listingType: opts.listingType,
    excludeIds: opts.excludeIds,
    rotationKey: opts.leadId,
  });
  // Owner, 15.09.2026. Amelia on 23534609: "send her last follow up with options
  // of 3 bedrooms under 70 million" for a client whose form says Denpasar Barat,
  // where we have no villa — five edits, five empty pools, and a question about
  // Canggu instead of the options she asked for. When the BROKER asks for
  // options and only the client's area stands in the way, the pool comes from
  // the nearest area that has them, and the composer is told to say where they
  // are. Never when the broker named the area himself, and never on the bot's
  // own drafts: there the client is asked first (relaxQuestion).
  let widenedArea: { asked: string[]; used: string[] } | null = null;
  if (
    pool.fits.length === 0 &&
    opts.widenAreaWhenEmpty &&
    !request.releaseArea &&
    request.sources.areas !== "broker" &&
    pool.hint?.dim === "area" &&
    (pool.hint.areas ?? []).length > 0
  ) {
    const used = pool.hint.areas!;
    const widened = await strictShortlistPool(
      { ...request, areas: used, nearbyOk: false },
      { listingType: opts.listingType, excludeIds: opts.excludeIds, rotationKey: opts.leadId },
    );
    if (widened.fits.length > 0) {
      logger.info(
        { request: describeRequest(request), asked: request.areas, used, fits: widened.fits.length },
        "candidatesForLead: nothing in the client's area — the broker asked for options, drawn from the nearest area",
      );
      widenedArea = { asked: [...request.areas], used };
      pool = widened;
    }
  }
  const candidates = pool.fits;
  if (candidates.length === 0) {
    logger.warn(
      { request: describeRequest(request), sources: request.sources, poolSize: pool.poolSize, fitsInclSent: pool.fitsInclSent, hint: pool.hint },
      "candidatesForLead: pool is EMPTY after filters",
    );
  }
  return {
    candidates,
    request,
    budgetIdr: request.budgetMaxIdr,
    budgetCeiling: request.budgetMaxIdr,
    budgetFloorIdr: request.budgetMinIdr,
    affordableIds: candidates.filter((p) => priceOf(p) > 0).map((p) => p.id),
    widenedArea,
    hint: pool.hint,
    fitsInclSent: pool.fitsInclSent,
    // Ranked best first (rankShortlistFits). Only reasons a client may hear:
    // the composer writes the client's text from these lines.
    lines: pool.ranked.slice(0, 20).map(({ p, whyClient }) => {
      const style = styleHint(p);
      const why = whyClient.length ? ` | why: ${whyClient.join("; ")}` : "";
      return { id: p.id, line: `${summaryLine(p)}${why}${style ? ` | ${style}` : ""}` };
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
  if (budgetCeiling) picked = picked.filter((p) => priceOf(p) > 0 && priceOf(p) <= budgetCeiling);
  return dedupeByTitle(picked).slice(0, limit).map(toPick);
}

export type MatchOptions = {
  listingType: ListingType;
  conversationText: string;
  brokerId?: string | null;
  limit?: number;
  /** Property IDs already sent to this lead — never offered again. */
  excludeIds?: string[];
  seenCount?: number;
  /** The lead's most recent message, weighted above the rest of the history. */
  latestLeadMessage?: string | null;
  /** The lead's own recent messages, NEWEST FIRST. */
  recentLeadMessages?: string[];
  /** What the BROKER just said while revising the draft. */
  brokerInstruction?: string | null;
  currentAttachmentIds?: string[];
  brokerIntent?: BrokerIntent | null;
  cardCriteria?: { bedrooms: number | null; areas: string[]; budgetIdrMonthly: number | null } | null;
  cardAnswers?: RequestInputs["cardAnswers"];
  cardBudgetTexts?: string[];
  leadNotes?: string | null;
  clickedListingId?: string | null;
  /** Villas offered to this lead in drafts the broker skipped — ranked lower, not removed. */
  proposedIds?: string[];
  /** Villas equal on everything take turns between leads (rankShortlistFits). */
  leadId?: string | null;
  /** What WE sent — a quoted message of ours is not the client's words. */
  ourMessages?: string[];
  /**
   * The shortlist gate already decided this message carries options
   * (decideShortlistGate). The model then only chooses AMONG the fits; an
   * empty choice or a failed call falls back to the top ranked ones — the
   * owner's "when unsure, send the shortlist" (14.09.2026).
   */
  mustAttach?: boolean;
};

const DECLINE_RULES = `Return an EMPTY list when sending listings would be the wrong move:
- The lead has just expressed interest in a SPECIFIC listing they were already shown ("I like this one", "this looks good", quoting one link approvingly). The conversation should now move toward a viewing or the practical next step on THAT property — pushing a fresh batch talks over them.
- The lead is arranging a viewing, negotiating terms, or discussing a property they've already chosen.
- The conversation gives truly nothing to go on (e.g. only a greeting).`;

const MUST_ATTACH_RULE = `THIS MESSAGE CARRIES OPTIONS — that is already decided in code: the client asked for more, turned down what they have, gave new criteria, or is still choosing. People rarely say "I don't like it"; "let's see more", "I've seen these", "keep sending", "hopefully something comes up" mean exactly that. Do not return an empty list. Pick the best fits for what the client said most recently.`;

/** How many ranked fits the matching model sees. Enough for choice, short enough to read the reasons. */
const SHOWN_TO_MATCHER = 12;

export async function matchProperties(opts: MatchOptions): Promise<PropertyPick[]> {
  return (await matchPropertiesDetailed(opts)).picks;
}

/**
 * The bot's shortlist for one draft. The request decides what is eligible
 * (strictShortlistPool — nothing outside bedrooms, area, budget, dates); the
 * model only chooses AMONG eligible villas on style and fit, or decides the
 * message carries none. Nothing is ever added to make up numbers.
 */
export async function matchPropertiesDetailed(opts: MatchOptions): Promise<{ picks: PropertyPick[]; outcome: ShortlistOutcome }> {
  const limit = opts.limit ?? 3;
  const excludeIds = opts.excludeIds ?? [];
  const exclude = new Set(excludeIds.map((id) => id.toUpperCase()));

  let brokerIntent: BrokerIntent | null = opts.brokerIntent ?? null;
  if (!brokerIntent && opts.brokerInstruction) {
    brokerIntent = await parseBrokerIntent(opts.brokerInstruction, await allAreaVocabulary());
  }
  const request = await resolveClientRequest({
    listingType: opts.listingType,
    leadMessages: opts.recentLeadMessages ?? [],
    ourMessages: opts.ourMessages ?? [],
    brokerInstructions: opts.brokerInstruction ? [opts.brokerInstruction] : [],
    cardCriteria: opts.cardCriteria ?? null,
    cardAnswers: opts.cardAnswers ?? null,
    cardBudgetTexts: opts.cardBudgetTexts ?? [],
    leadNotes: opts.leadNotes ?? null,
    clickedListingId: opts.clickedListingId ?? null,
  });
  if (brokerIntent?.releaseArea) request.releaseArea = true;

  const namedInThread = (opts.recentLeadMessages ?? []).flatMap((m) =>
    Array.from(m.matchAll(PROPERTY_ID_REGEX)).map((x) => x[1]!.toUpperCase()),
  );
  const { outcome, fits: poolFits, ranked } = await shortlistOutcomeFor(request, {
    listingType: opts.listingType,
    excludeIds,
    proposedIds: opts.proposedIds ?? [],
    rotationKey: opts.leadId,
    namedIds: [...namedInThread, ...(opts.clickedListingId ? [opts.clickedListingId.toUpperCase()] : [])],
  });
  const done = (picks: SupabaseProperty[]) => ({ picks: picks.map(toPick), outcome });

  // 1. The villa the lead named themselves — answered alone, but ONLY when it
  // is inside their own request. A villa they clicked that is over their
  // budget, the wrong size, the wrong area or let past their move-in is not
  // attached (owner, 14.09: offer only inside the request) — the strict
  // shortlist answers instead.
  const revisionMovesSearch =
    !!brokerIntent && (brokerIntent.releaseArea || brokerIntent.areas.length > 0 || !!brokerIntent.bedrooms);
  if (!revisionMovesSearch) {
    const anchorIds = new Set(
      (opts.recentLeadMessages ?? []).flatMap((m) => Array.from(m.matchAll(PROPERTY_ID_REGEX)).map((x) => x[1]!.toUpperCase())),
    );
    if (anchorIds.size > 0) {
      const all = await fetchAllProperties();
      const anchor = all.find(
        (p) => p.listing_type === opts.listingType && anchorIds.has(p.id.toUpperCase()) && !exclude.has(p.id.toUpperCase()),
      );
      if (anchor) {
        const misfits = requestMisfits(anchor, request);
        if (misfits.length === 0) {
          logger.info({ anchor: anchor.id, request: describeRequest(request) }, "matchProperties: the lead named one villa inside their request — answering about that villa alone");
          return done([anchor]);
        }
        logger.info(
          { anchor: anchor.id, misfits, request: describeRequest(request) },
          "matchProperties: the villa the lead named is outside their own request — not attached",
        );
      }
    }
  }

  const candidates = poolFits;
  if (candidates.length === 0) {
    logger.info(
      { request: describeRequest(request), sources: request.sources, fitsInclSent: outcome.fitCountInclSent, hint: outcome.hint },
      "matchProperties: nothing inside the client's request — attaching nothing",
    );
    return done([]);
  }
  // Too little conversation to know anything, and no stated request either.
  if (!outcome.hasCore && opts.conversationText.trim().length < 20) return done([]);

  logger.info(
    { request: describeRequest(request), sources: request.sources, fitting: candidates.length, ranked: ranked.slice(0, 8).map((x) => `${x.p.id}:${x.namedArea ? "" : "near/"}${x.score}/${x.quality}${x.skipped ? "/skipped" : ""}`) },
    "matchProperties: shortlist drawn only from villas inside the request",
  );

  const budgetKnown = request.budgetMaxIdr !== null;
  try {
    // The top of the ranked pool, each with its reasons. No "this broker has used
    // these before" block any more: broker_property_picks is bumped by every
    // approve of the bot's OWN picks, so it fed the oldest villas back in.
    const whyOf = new Map(ranked.map((x) => [x.p.id, x.why]));
    const catalogBlock = candidates
      .slice(0, SHOWN_TO_MATCHER)
      .map((p, i) => {
        const style = styleHint(p);
        const why = (whyOf.get(p.id) ?? []).join("; ");
        return `${i + 1}. ${summaryLine(p)}${why ? ` | why: ${why}` : ""}${style ? ` | ${style}` : ""}`;
      })
      .join("\n");
    const brokerRevision = opts.brokerInstruction
      ? `\n\nTHE BROKER IS REVISING THIS DRAFT AND SAID: "${opts.brokerInstruction.slice(0, 400)}"\nThis outranks everything else. It is feedback on the listings currently attached${
          opts.currentAttachmentIds?.length ? ` (${opts.currentAttachmentIds.join(", ")})` : ""
        }, so change the selection to match what they asked for — drop the ones they objected to, keep only those that still fit. If their instruction says nothing about which listings to send, keep the current selection.`
      : "";

    const result = await chatCompletionJSON<{ ids?: string[] }>({
      model: "claude-sonnet-5",
      label: "listing-match",
      system: `You decide whether to attach property listings to a broker's next reply, and if so which ones.

${opts.mustAttach ? MUST_ATTACH_RULE : DECLINE_RULES}

EVERY listing in the catalog below is already inside the client's request — ${describeRequest(request)} — the code filtered it; nothing else exists for you. The catalog is RANKED best first: first by how closely the villa matches the request (an area they named over a neighbour, a price close to their budget without going over it, free on their dates, a minimum stay that suits them, and the key features they asked for — a garden, a place to work, an enclosed living room, a quiet street), then, only between villas that match equally, by what we know about the villa (red and green flags from our inspection, construction nearby, inspected (Listed), a video tour, a full photo set, dates confirmed recently). How long a listing has been on the site plays no part: rentals come free again and again. Each line gives its reasons after "why:". Prefer the top of the list; take a lower one only when the lead's own words (style, features, a specific wish) make it the better fit, never because it is cheaper, older, newer or better known. STYLE COUNTS: each line carries a "style:" part; when the lead describes how they want it to look or feel (modern, luxury, minimalist, jungle, quiet, family), match that seriously. A "checked:" part lists key features a person verified (garden, living room, workspace, quiet street, no construction next door); a feature missing from it is UNKNOWN, not absent.

Pick up to ${limit} listing IDs, preferring ${MIN_SHORTLIST}-${limit} so the lead has something to compare. Never pad: if only one genuinely fits, return one.${
        (opts.seenCount ?? 0) > 0
          ? `\n\nThis lead has already been shown ${opts.seenCount} listing(s) and those are excluded from the catalog below.`
          : ""
      }${brokerRevision}${
        budgetKnown
          ? ""
          : `\n\nTHE LEAD HAS NOT NAMED A BUDGET. Spread the shortlist across clearly different price points so their reaction tells us the budget.`
      }

Respond with JSON only: {"ids": ["ID1", "ID2"]}`,
      messages: [
        {
          role: "user",
          content: `${
            opts.latestLeadMessage
              ? `LEAD'S LATEST MESSAGE:\n"${opts.latestLeadMessage.slice(0, 500)}"\n\n`
              : ""
          }Conversation (background):\n${conversationWindow(opts.conversationText)}\n\nCatalog:\n${catalogBlock}`,
        },
      ],
      max_tokens: 400,
      temperature: 0,
    });

    const ids = new Set((result.ids ?? []).map((id) => id.toUpperCase()));
    const picked = candidates.filter((p) => ids.has(p.id.toUpperCase()));
    if (picked.length === 0) {
      if (!opts.mustAttach) {
        outcome.declined = true;
        logger.info({ fitting: candidates.length }, "matchProperties: the model chose to attach nothing to this message");
        return done([]);
      }
      picked.push(...candidates.slice(0, Math.min(limit, candidates.length)));
      logger.info({ fitting: candidates.length, attached: picked.map((p) => p.id) }, "matchProperties: the model chose none, but this message carries options — the top ranked fits go");
    }
    // Top up to two from the SAME strict pool — every candidate is inside the request.
    if (picked.length < MIN_SHORTLIST) {
      const chosenTitles = new Set(picked.map((p) => (p.title ?? p.id).trim().toLowerCase()));
      const rest = candidates.filter(
        (p) => !ids.has(p.id.toUpperCase()) && !chosenTitles.has((p.title ?? p.id).trim().toLowerCase()),
      );
      picked.push(...rest.slice(0, MIN_SHORTLIST - picked.length));
    }
    const final = budgetKnown ? picked : spreadByPrice(picked.slice(0, limit), candidates);
    return done(final.slice(0, limit));
  } catch (err) {
    logger.error({ err, mustAttach: !!opts.mustAttach }, "matchProperties: AI matching failed (non-fatal)");
    // Fail toward sending: the gate already decided this message carries options.
    return done(opts.mustAttach ? candidates.slice(0, limit) : []);
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
