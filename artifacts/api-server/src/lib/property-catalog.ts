import { logger } from "./logger";
import { chatCompletionJSON } from "./ai-client";
import { getTopPicksForBroker } from "./broker-picks-tracker";

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
    `?select=id,title,area,type,bedrooms,bathrooms,price_usd,leasehold_price_usd,monthly_price_usd,yearly_price_usd,ownership,status,zone,views,purpose,listing_type` +
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
  const monthlyPrice = p.monthly_price_usd && p.monthly_price_usd > 0 ? `$${Math.round(p.monthly_price_usd)}/mo` : null;
  const yearlyPrice = p.yearly_price_usd && p.yearly_price_usd > 0 ? `$${Math.round(p.yearly_price_usd)}/yr` : null;
  const priceStr = [freePrice, leasePrice, monthlyPrice, yearlyPrice].filter(Boolean).join(" / ") || null;
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

function toPick(p: SupabaseProperty): PropertyPick {
  const priceBit = summaryLine(p).split(" | ").slice(1, -1).join(", ");
  return { id: p.id, title: p.title, url: `${SITE_BASE}/${p.id}`, label: `${p.title} (${priceBit})`.slice(0, 140) };
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
  const areaVocab = [...new Set(pool.map((p) => (p.area ?? "").trim()).filter(Boolean))];
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
}): Promise<PropertyPick[]> {
  const limit = opts.limit ?? 2;
  const all = await fetchAllProperties();
  const exclude = new Set((opts.excludeIds ?? []).map((id) => id.toUpperCase()));
  const pool = all.filter((p) => p.listing_type === opts.listingType && !exclude.has(p.id.toUpperCase()));
  if (pool.length === 0) return [];

  // 1. Explicit mention fast-path — deterministic, no AI call.
  const mentioned = new Set(
    Array.from(opts.conversationText.matchAll(PROPERTY_ID_REGEX)).map((m) => m[1].toUpperCase()),
  );
  if (mentioned.size > 0) {
    const explicit = pool.filter((p) => mentioned.has(p.id.toUpperCase()));
    if (explicit.length > 0) return explicit.slice(0, limit).map(toPick);
  }

  // Too little conversation to infer real criteria from — skip the AI call.
  if (opts.conversationText.trim().length < 20) return [];

  // ── Hard filter on the lead's CURRENT requirements ────────────────────────
  // Applied before the model sees anything, so an outdated area or bedroom
  // count is not even on the menu. Each filter is skipped when it would leave
  // nothing — an imperfect suggestion beats an empty one.
  const criteria = extractLeadCriteria(opts.recentLeadMessages ?? [], pool);
  let candidates = pool;
  if (criteria.areas.length > 0) {
    const byArea = candidates.filter((p) =>
      criteria.areas.some((a) => (p.area ?? "").toLowerCase() === a.toLowerCase()),
    );
    if (byArea.length > 0) candidates = byArea;
  }
  if (criteria.bedrooms !== null) {
    const byBeds = candidates.filter((p) => p.bedrooms === criteria.bedrooms);
    if (byBeds.length > 0) candidates = byBeds;
  }
  if (criteria.areas.length > 0 || criteria.bedrooms !== null) {
    logger.info(
      { areas: criteria.areas, bedrooms: criteria.bedrooms, poolSize: pool.length, candidates: candidates.length },
      "matchProperties: filtered to the lead's current criteria",
    );
  }

  try {
    const brokerTop = opts.brokerId
      ? await getTopPicksForBroker(opts.brokerId, candidates.map((p) => p.id))
      : [];
    const catalogBlock = candidates.slice(0, 60).map(summaryLine).join("\n");
    // Deliberately weak wording: this hint kept resurfacing the same two
    // listings regardless of what the lead asked for.
    const brokerBlock = brokerTop.length > 0 ? `\n\nFYI, this broker has used these before: ${brokerTop.join(", ")}. Only pick one if it fits the lead's CURRENT criteria as well as any other candidate — never as a tie-breaker against a better fit.` : "";

    const result = await chatCompletionJSON<{ ids?: string[] }>({
      model: "claude-sonnet-5",
      system: `You decide whether to attach property listings to a broker's next reply, and if so which ones.

Return an EMPTY list when sending listings would be the wrong move:
- The lead has just expressed interest in a SPECIFIC listing they were already shown ("I like this one", "this looks good", quoting one link approvingly). The conversation should now move toward a viewing or the practical next step on THAT property — pushing a fresh batch talks over them.
- The lead is arranging a viewing, negotiating terms, or discussing a property they've already chosen.
- The conversation gives truly nothing to go on (e.g. only a greeting).

CRITERIA CAN CHANGE MID-CONVERSATION. When the lead revises what they want ("actually", "I wanna change my request", a new area, a different bedroom count), their NEWEST statement is the only one that counts — match against that and treat the earlier criteria as void, however much of the conversation was spent on them.

Otherwise pick at most ${limit} listing IDs that fit what the lead described. You do NOT need every detail (area, budget, bedrooms, purpose, style) — one or two known criteria are enough to make a reasonable first pass. This is a shortlist for the lead to react to and refine, so approximate is fine.${
        (opts.seenCount ?? 0) > 0
          ? `\n\nThis lead has already been shown ${opts.seenCount} listing(s) and those are excluded from the catalog below. Anything you pick is new to them — favour genuine variety (different areas, price points, layouts) over near-duplicates of what they already saw.`
          : ""
      }${brokerBlock}

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
      max_tokens: 80,
      temperature: 0,
    });

    const ids = new Set((result.ids ?? []).map((id) => id.toUpperCase()));
    const picked = candidates.filter((p) => ids.has(p.id.toUpperCase()));
    return picked.slice(0, limit).map(toPick);
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
