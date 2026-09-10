import { logger } from "./logger";

/**
 * Broker flags on villas, read from the website's Internal data (property_private).
 *
 * Brokers tick "Construction nearby" or "Red flag" on the site after an inspection
 * or a bad viewing (owner, 2026-09-10 — Amelia in Unicorn Rental: "please flag
 * options with construction nearby", "R-YUD-054 is a major red flag, the client left
 * immediately"). The Copilot shows the warning on any draft that attaches such a
 * villa, so the broker sees it before sending. It is never put into anything a
 * client reads.
 *
 * Service key on purpose: property_private is admin/agent-only by RLS, and the anon
 * key this app uses for the catalog reads nothing there. Only flagged rows and only
 * the three flag columns are fetched — no owner contacts leave the site database
 * through this.
 */
export type PropertyFlags = {
  constructionNearby: boolean;
  redFlag: boolean;
  redFlagReason: string;
};

/** Short enough that a flag ticked on the site shows up on the next inbox refresh or two. */
const TTL_MS = 3 * 60 * 1000;
let cache: { at: number; byId: Map<string, PropertyFlags> } | null = null;

/** Flagged villas keyed by UPPER-CASED property id. A failed read keeps the last good map. */
export async function propertyFlagsById(): Promise<Map<string, PropertyFlags>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.byId;
  const url = process.env["SUPABASE_URL"] ?? "";
  const key = process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? "";
  if (!url || !key) return cache?.byId ?? new Map();
  try {
    const res = await fetch(
      `${url}/rest/v1/property_private` +
        `?select=property_id,construction_nearby,red_flag,red_flag_reason` +
        `&or=(construction_nearby.eq.true,red_flag.eq.true)`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) {
      logger.warn({ status: res.status }, "property flags fetch failed — drafts show no flag warnings");
      return cache?.byId ?? new Map();
    }
    const rows = (await res.json()) as Array<{
      property_id: string;
      construction_nearby: boolean | null;
      red_flag: boolean | null;
      red_flag_reason: string | null;
    }>;
    const byId = new Map<string, PropertyFlags>();
    for (const r of rows) {
      byId.set(String(r.property_id).toUpperCase(), {
        constructionNearby: r.construction_nearby === true,
        redFlag: r.red_flag === true,
        redFlagReason: (r.red_flag_reason ?? "").trim(),
      });
    }
    cache = { at: Date.now(), byId };
    return byId;
  } catch (err) {
    logger.warn({ err }, "property flags fetch threw — drafts show no flag warnings");
    return cache?.byId ?? new Map();
  }
}

/** "https://…/property/R-YUD-054?x=1" → "R-YUD-054" (upper-cased), or null. */
export function propertyIdFromUrl(url: string | null | undefined): string | null {
  const m = /\/property\/([^/?#\s]+)/i.exec(url ?? "");
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!).toUpperCase();
  } catch {
    return m[1]!.toUpperCase();
  }
}

/**
 * The flags for the villas a draft attaches, keyed by the attachment's own URL, so the
 * inbox can look a warning up without the flags ever riding inside `attachments`
 * (those are posted back on approve and must stay exactly what is sent).
 */
export async function flagsForAttachments(
  attachments: ReadonlyArray<{ type?: string; url?: string | null }> | null | undefined,
): Promise<Record<string, PropertyFlags>> {
  const links = (attachments ?? []).filter((a) => a && a.url && (a.type ?? "link") === "link");
  if (links.length === 0) return {};
  const byId = await propertyFlagsById();
  if (byId.size === 0) return {};
  const out: Record<string, PropertyFlags> = {};
  for (const a of links) {
    const id = propertyIdFromUrl(a.url);
    const flags = id ? byId.get(id) : undefined;
    if (flags) out[a.url!] = flags;
  }
  return out;
}
