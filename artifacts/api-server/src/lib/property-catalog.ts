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
export async function matchProperties(opts: {
  listingType: ListingType;
  conversationText: string;
  brokerId?: string | null;
  limit?: number;
}): Promise<PropertyPick[]> {
  const limit = opts.limit ?? 2;
  const all = await fetchAllProperties();
  const pool = all.filter((p) => p.listing_type === opts.listingType);
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

  try {
    const brokerTop = opts.brokerId
      ? await getTopPicksForBroker(opts.brokerId, pool.map((p) => p.id))
      : [];
    const catalogBlock = pool.slice(0, 60).map(summaryLine).join("\n");
    const brokerBlock = brokerTop.length > 0 ? `\n\nThis broker frequently recommends: ${brokerTop.join(", ")} — prefer these when they genuinely fit too, but never at the expense of actual fit.` : "";

    const result = await chatCompletionJSON<{ ids?: string[] }>({
      model: "claude-sonnet-5",
      system: `You match a real estate lead's stated needs to the best-fitting listings from a catalog.
Read the conversation and pick at most ${limit} listing IDs from the catalog that genuinely fit what the lead described (area, budget, bedrooms, purpose, style). If nothing in the conversation gives enough to judge fit, return an empty list — do not guess.${brokerBlock}

Respond with JSON only: {"ids": ["ID1", "ID2"]}`,
      messages: [
        {
          role: "user",
          content: `Conversation:\n${opts.conversationText.slice(-3000)}\n\nCatalog:\n${catalogBlock}`,
        },
      ],
      max_tokens: 80,
      temperature: 0,
    });

    const ids = new Set((result.ids ?? []).map((id) => id.toUpperCase()));
    const picked = pool.filter((p) => ids.has(p.id.toUpperCase()));
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
