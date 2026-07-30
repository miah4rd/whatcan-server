import { logger } from "./logger";
import { chatCompletionJSON } from "./ai-client";
import { getTopPicksForBroker } from "./broker-picks-tracker";
import { allAreaNames, areaMatches } from "./bali-areas";

const SUPABASE_URL = process.env["SUPABASE_URL"] ?? "";
const SUPABASE_ANON_KEY = process.env["SUPABASE_ANON_KEY"] ?? "";
const SITE_BASE = "https://unicorn-property.broad-union-b9f4.workers.dev/property";

export type ListingType = "sale" | "rent";

export type SupabaseProperty = {
  id: string;
  title: string;
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

async function fetchAllProperties(): Promise<SupabaseProperty[]> {
  const now = Date.now();
  if (_cache && now - _cacheAt < CACHE_TTL_MS) return _cache;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    logger.warn("SUPABASE_URL or SUPABASE_ANON_KEY not set — property catalog unavailable");
    return [];
  }

  const url =
    `${SUPABASE_URL}/rest/v1/properties` +
    `?select=id,title,area,type,bedrooms,bathrooms,price_usd,leasehold_price_usd,monthly_price_usd,yearly_price_usd,monthly_price_idr,yearly_price_idr,ownership,status,zone,views,purpose,listing_type` +
    `&is_draft=eq.false` +
    `&status=neq.sold` +
    `&order=views.desc`;

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
  _cache = data;
  _cacheAt = now;
  logger.info({ count: data.length }, "property catalog refreshed from Supabase");
  return data;
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

function summaryLine(p: SupabaseProperty): string {
  const freePrice = p.price_usd && p.price_usd > 1000 ? `freehold $${Math.round(p.price_usd / 1000)}K` : null;
  const leasePrice = p.leasehold_price_usd && p.leasehold_price_usd > 1000 ? `leasehold $${Math.round(p.leasehold_price_usd / 1000)}K` : null;
  // Rentals are quoted in rupiah — the same number the site and the owner use.
  const jt = (v: number) => `Rp ${(v / 1_000_000).toFixed(v >= 100_000_000 ? 0 : 1)} jt`;
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
  const priceStr =
    (p.listing_type === "rent"
      ? [monthlyPrice, yearlyPrice]
      : [freePrice, leasePrice, monthlyPrice, yearlyPrice]
    )
      .filter(Boolean)
      .join(" / ") || null;
  const parts: string[] = [
    `[${p.id}]`,
    p.area ?? "",
    p.bedrooms ? `${p.bedrooms}BR` : "",
    p.ownership ?? "",
    priceStr ?? "",
    p.purpose ? `(${p.purpose})` : "",
    p.views ? `${p.views} views` : "",
    `${SITE_BASE}/${p.id}`,
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
  return `${SITE_BASE}/${p.id}`;
}

function toPick(p: SupabaseProperty): PropertyPick {
  const priceBit = summaryLine(p).split(" | ").slice(1, -1).join(", ");
  return { id: p.id, title: p.title, url: propertyUrl(p), label: `${p.title} (${priceBit})`.slice(0, 140) };
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
 * Pull the lead's CURRENT area / bedroom requirements out of their own recent
 * messages, newest first, so a mid-conversation change wins outright.
 *
 * This is deliberately code and not a prompt instruction: the matching model was
 * told twice, in increasingly explicit terms, that the newest message overrides
 * the rest — and both times it still attached 2BR Pererenan listings to a lead
 * who had just asked for 3 bedrooms in Uluwatu, because the old criteria fill
 * most of the transcript. Filtering the candidate list before the model ever
 * sees it removes the chance to get this wrong.
 */
function extractLeadCriteria(
  recentLeadMessages: string[],
  pool: SupabaseProperty[],
): { areas: string[]; bedrooms: number | null } {
  // Vocabulary is the site's own area list (parents AND sub-areas), not just the
  // strings that happen to appear in the catalog — a lead saying "Uluwatu" must
  // be understood even when every Uluwatu listing is tagged Pecatu or Bingin.
  // Longest first so "Uluwatu / Suluban" wins over a bare "Uluwatu" substring.
  const areaVocab = [...new Set([...allAreaNames(), ...pool.map((p) => (p.area ?? "").trim())])]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const areas: string[] = [];
  let bedrooms: number | null = null;

  for (const raw of recentLeadMessages) {
    const lower = (raw ?? "").toLowerCase();
    if (!lower) continue;

    for (const a of areaVocab) {
      if (lower.includes(a.toLowerCase()) && !areas.some((x) => x.toLowerCase() === a.toLowerCase())) {
        areas.push(a);
      }
    }

    if (bedrooms === null) {
      const digit = lower.match(/(\d+)\s*-?\s*(?:bed\b|beds\b|br\b|bedroom|bedrooms|спал)/);
      if (digit?.[1]) {
        bedrooms = parseInt(digit[1], 10);
      } else {
        // No \b here: JS word boundaries are ASCII-only, so \bтри never matched.
        const word = lower.match(/(one|two|three|four|five|six|один|одна|две|два|три|четыре|пять)\s+(?:bed|bedroom|спал)/);
        if (word?.[1]) bedrooms = WORD_NUMBERS[word[1]] ?? null;
      }
    }

    // Stop at the newest message that pinned both — older ones are superseded.
    if (areas.length > 0 && bedrooms !== null) break;
  }

  return { areas, bedrooms };
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
  const pool = all.filter((p) => p.listing_type === opts.listingType);
  if (pool.length === 0) return null;

  const { areas, bedrooms } = extractLeadCriteria(opts.recentLeadMessages, pool);
  if (areas.length === 0 && bedrooms === null) return null;

  let matching = pool;
  if (areas.length > 0) {
    // Hierarchy-aware: "Uluwatu" must count listings tagged Pecatu, Bingin, etc.
    matching = matching.filter((p) => areaMatches(p.area, areas));
  }
  if (bedrooms !== null) {
    matching = matching.filter((p) => p.bedrooms === bedrooms);
  }

  // What we could honestly offer instead when their area comes up empty.
  const nearby =
    matching.length === 0 && bedrooms !== null
      ? [...new Set(pool.filter((p) => p.bedrooms === bedrooms).map((p) => p.area ?? "").filter(Boolean))]
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
function priceOf(p: SupabaseProperty): number {
  if (p.listing_type === "rent") {
    // Rupiah only — every rental that carries a dollar figure carries the rupiah
    // one too, so the tiers compare like with like and nothing is converted.
    if ((p.monthly_price_idr ?? 0) > 0) return p.monthly_price_idr!;
    if ((p.yearly_price_idr ?? 0) > 0) return Math.round(p.yearly_price_idr! / 12);
    return 0;
  }
  return p.price_usd || p.leasehold_price_usd || 0;
}

/** Priced first, then what other clients actually look at. */
function rankForShortlist(a: SupabaseProperty, b: SupabaseProperty): number {
  const byPrice = (hasPrice(a) ? 0 : 1) - (hasPrice(b) ? 0 : 1);
  if (byPrice !== 0) return byPrice;
  return (b.views ?? 0) - (a.views ?? 0);
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

  for (const raw of messages) {
    const m = raw.toLowerCase();
    const perYear = PER_YEAR.test(m);
    const toMonthly = (n: number) => Math.round(perYear ? n / 12 : n);

    // "30 million" / "750mill" / "30jt" / "30 juta" / "40 млн"
    const short = m.match(/(\d[\d.,]*)\s*(jt\b|juta|mio\b|mln\b|mill(?:ion)?s?\b|млн|миллион)/);
    if (short?.[1]) {
      const n = parseFloat(short[1].replace(/[.,](?=\d{3}\b)/g, "").replace(",", "."));
      if (n > 0 && n < 100000) return toMonthly(n * 1_000_000);
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

/** A shortlist of one is a take-it-or-leave-it, not a choice. Never send fewer. */
const MIN_SHORTLIST = 2;

function bedroomDistance(p: SupabaseProperty, wanted: number | null): number {
  if (wanted === null || p.bedrooms === null) return 99;
  return Math.abs(p.bedrooms - wanted);
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
}): Promise<PropertyPick[]> {
  // A shortlist of one isn't a choice, and two is thin. Three is what a broker
  // would actually send; the matcher may still return fewer if stock is short.
  const limit = opts.limit ?? 3;
  const all = await fetchAllProperties();
  const exclude = new Set((opts.excludeIds ?? []).map((id) => id.toUpperCase()));
  const pool = all.filter((p) => p.listing_type === opts.listingType && !exclude.has(p.id.toUpperCase()));
  if (pool.length === 0) return [];

  // 1. Anchor listing — the lead arrived FROM a specific listing (clicked its ad)
  // or named one themselves. Read only from what the LEAD wrote: matching any
  // mention in the whole conversation meant our own previously sent links came
  // straight back as "the answer". Anything already sent is out of `pool`, so a
  // lead quoting a link we sent cannot become an anchor either.
  const anchorIds = opts.brokerInstruction ? new Set<string>() : new Set(
    (opts.recentLeadMessages ?? [])
      .flatMap((m) => Array.from(m.matchAll(PROPERTY_ID_REGEX)).map((x) => x[1].toUpperCase())),
  );
  const anchors = anchorIds.size > 0 ? pool.filter((p) => anchorIds.has(p.id.toUpperCase())) : [];
  if (anchors.length > 0) {
    // Their own pick tells us the criteria better than any question would. Send
    // it back WITH comparable alternatives, so they still get a real choice.
    const anchor = anchors[0]!;
    const similar = pool
      .filter(
        (p) =>
          !anchorIds.has(p.id.toUpperCase()) &&
          (anchor.bedrooms === null || p.bedrooms === null || Math.abs((p.bedrooms ?? 0) - anchor.bedrooms) <= 1),
      )
      .sort((a, b) => {
        const sameArea = (x: SupabaseProperty) => (areaMatches(x.area, [anchor.area ?? ""]) ? 0 : 1);
        const byArea = sameArea(a) - sameArea(b);
        return byArea !== 0 ? byArea : rankForShortlist(a, b);
      });
    const shortlist = dedupeByTitle([...anchors, ...similar]).slice(0, limit);
    logger.info(
      { anchor: anchor.id, total: shortlist.length },
      "matchProperties: built the shortlist around the listing the lead came in on",
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
  const criteria = extractLeadCriteria(criteriaSource, pool);
  let candidates = pool;
  if (criteria.areas.length > 0) {
    const byArea = candidates.filter((p) => areaMatches(p.area, criteria.areas));
    if (byArea.length > 0) candidates = byArea;
  }
  if (criteria.bedrooms !== null) {
    const exact = candidates.filter((p) => p.bedrooms === criteria.bedrooms);
    // A filter that leaves a single survivor makes a shortlist impossible — and
    // the broker asked for two or three options every time. Widen by one bedroom
    // (a 3BR seeker will happily look at a 4BR) before accepting a pool of one.
    if (exact.length >= MIN_SHORTLIST) {
      candidates = exact;
    } else {
      const near = candidates.filter(
        (p) => p.bedrooms !== null && Math.abs(p.bedrooms - criteria.bedrooms!) <= 1,
      );
      if (near.length >= MIN_SHORTLIST) candidates = near;
      else if (exact.length > 0) candidates = exact;
    }
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
  const budgetIdr = opts.listingType === "rent" ? extractBudgetIdr(criteriaSource) : null;
  const budgetCeiling = budgetIdr ? Math.round(budgetIdr * 1.15) : null;
  let withinBudgetCount = 0;
  if (budgetCeiling) {
    const within = candidates.filter((p) => priceOf(p) > 0 && priceOf(p) <= budgetCeiling);
    const above = candidates
      .filter((p) => !(priceOf(p) > 0 && priceOf(p) <= budgetCeiling))
      .sort((a, b) => priceOf(a) - priceOf(b));
    withinBudgetCount = within.length;
    // Affordable first, then the closest above. Requiring TWO within budget
    // before honouring it at all threw the budget away whenever exactly one
    // fitted — and the model then freely picked villas at double the number.
    candidates = [...within.sort(rankForShortlist), ...above];
    logger.info(
      { budgetIdr, within: within.length, of: candidates.length },
      within.length > 0
        ? "matchProperties: ordered the shortlist by the lead's budget"
        : "matchProperties: nothing inside the budget, offering the closest",
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
    const catalogBlock = candidates.slice(0, 60).map(summaryLine).join("\n");
    // Deliberately weak wording: this hint kept resurfacing the same two
    // listings regardless of what the lead asked for.
    const brokerBlock = brokerTop.length > 0 ? `\n\nFYI, this broker has used these before: ${brokerTop.join(", ")}. Only pick one if it fits the lead's CURRENT criteria as well as any other candidate — never as a tie-breaker against a better fit.` : "";

    const budgetBlock = budgetCeiling
      ? `\n\nTHEIR BUDGET IS ${Math.round(budgetIdr! / 1_000_000)} MILLION RUPIAH PER MONTH. The catalog below is ordered affordable-first. ${
          withinBudgetCount >= MIN_SHORTLIST
            ? "Pick only listings at or under that figure — there are enough of them, so going over it is never necessary."
            : withinBudgetCount > 0
              ? "Only a few fit it: take those first, then the closest above so there is still a choice."
              : "Nothing fits it, so pick the CHEAPEST available — the reply says openly that they are above the budget."
        }`
      : "";

    const brokerRevision = opts.brokerInstruction
      ? `\n\nTHE BROKER IS REVISING THIS DRAFT AND SAID: "${opts.brokerInstruction.slice(0, 400)}"\nThis outranks everything else. It is feedback on the listings currently attached${
          opts.currentAttachmentIds?.length ? ` (${opts.currentAttachmentIds.join(", ")})` : ""
        }, so change the selection to match what they asked for — drop the ones they objected to, keep only those that still fit. If their instruction says nothing about which listings to send, keep the current selection.`
      : "";

    const result = await chatCompletionJSON<{ ids?: string[] }>({
      model: "claude-sonnet-5",
      system: `You decide whether to attach property listings to a broker's next reply, and if so which ones.

Return an EMPTY list when sending listings would be the wrong move:
- The lead has just expressed interest in a SPECIFIC listing they were already shown ("I like this one", "this looks good", quoting one link approvingly). The conversation should now move toward a viewing or the practical next step on THAT property — pushing a fresh batch talks over them.
- The lead is arranging a viewing, negotiating terms, or discussing a property they've already chosen.
- The conversation gives truly nothing to go on (e.g. only a greeting).

CRITERIA CAN CHANGE MID-CONVERSATION. When the lead revises what they want ("actually", "I wanna change my request", a new area, a different bedroom count), their NEWEST statement is the only one that counts — match against that and treat the earlier criteria as void, however much of the conversation was spent on them.

Otherwise pick ${limit} listing IDs that fit what the lead described — ${MIN_SHORTLIST} is the absolute minimum. A single link is not a shortlist: it reads as take-it-or-leave-it and gives the lead nothing to compare, so only ever return one ID if the catalog below genuinely contains only one plausible fit. If their exact area has no stock, pick the closest areas instead of returning nothing — the reply text says honestly where these actually are. You do NOT need every detail (area, budget, bedrooms, purpose, style) — one or two known criteria are enough to make a reasonable first pass. This is a shortlist for the lead to react to and refine, so approximate is fine.${
        (opts.seenCount ?? 0) > 0
          ? `\n\nThis lead has already been shown ${opts.seenCount} listing(s) and those are excluded from the catalog below. Anything you pick is new to them — favour genuine variety (different areas, price points, layouts) over near-duplicates of what they already saw.`
          : ""
      }${brokerBlock}

${
        budgetKnown
          ? ""
          : `\n\nTHE LEAD HAS NOT NAMED A BUDGET. Deliberately spread the shortlist across clearly different price points — one affordable, one mid, one premium — so their reaction tells us the budget without having to ask. The catalog is ordered best-first (priced and most viewed first); everything in it is a reasonable fit.`
      }

Respond with JSON only: {"ids": ["ID1", "ID2"]}`,
      messages: [
        {
          role: "user",
          content: `${
            opts.latestLeadMessage
              ? `LEAD'S LATEST MESSAGE — their current criteria, this overrides anything older:\n"${opts.latestLeadMessage.slice(0, 500)}"\n\n`
              : ""
          }Conversation (background):\n${opts.conversationText.slice(-3000)}\n\nCatalog:\n${catalogBlock}`,
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
      // Their exact area may simply not hold two priced villas of that size.
      // Widening the map beats both alternatives: a listing with no price can't
      // be judged, and a shortlist of one isn't a shortlist. The reply names the
      // area each villa is actually in, so nothing is passed off as local.
      const chosenTitles = new Set(picked.map((p) => (p.title ?? p.id).trim().toLowerCase()));
      const rest = dedupeByTitle([...candidates, ...pool.filter(hasPrice).sort(rankForShortlist)])
        .filter(
          (p) => !ids.has(p.id.toUpperCase()) && !chosenTitles.has((p.title ?? p.id).trim().toLowerCase()),
        )
        .sort((a, b) => {
          const byArea =
            (areaMatches(a.area, criteria.areas) ? 0 : 1) - (areaMatches(b.area, criteria.areas) ? 0 : 1);
          if (criteria.areas.length > 0 && byArea !== 0) return byArea;
          const byBeds = bedroomDistance(a, criteria.bedrooms) - bedroomDistance(b, criteria.bedrooms);
          return byBeds !== 0 ? byBeds : rankForShortlist(a, b);
        });
      picked.push(...rest.slice(0, MIN_SHORTLIST - picked.length));
      logger.info(
        { requested: ids.size, final: picked.length },
        "matchProperties: topped the shortlist up to the minimum — one link is not a choice",
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
