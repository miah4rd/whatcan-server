import { logger } from "./logger";

/**
 * The broker's red flag on a villa, read from the website's Internal data
 * (property_private).
 *
 * Brokers tick "Construction nearby" on the site after an inspection or a bad
 * viewing (owner, 2026-09-10 — Amelia in Unicorn Rental: "please flag options with
 * construction nearby"). "Red flag" is the team's word for any important detail;
 * everything else is written in Internal notes, so construction is the one flag with
 * a field. The Copilot shows it on any draft that attaches such a villa, so the
 * broker sees it before sending. It is never put into anything a client reads.
 *
 * Service key on purpose: property_private is admin/agent-only by RLS, and the anon
 * key this app uses for the catalog reads nothing there. Only flagged rows and only
 * the flag column are fetched — no owner contacts leave the site database through
 * this.
 */
export type PropertyFlags = {
  constructionNearby: boolean;
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
      `${url}/rest/v1/property_private?select=property_id,construction_nearby&construction_nearby=eq.true`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) {
      logger.warn({ status: res.status }, "property flags fetch failed — drafts show no flag warnings");
      return cache?.byId ?? new Map();
    }
    const rows = (await res.json()) as Array<{ property_id: string; construction_nearby: boolean | null }>;
    const byId = new Map<string, PropertyFlags>();
    for (const r of rows) {
      if (r.construction_nearby === true) {
        byId.set(String(r.property_id).toUpperCase(), { constructionNearby: true });
      }
    }
    cache = { at: Date.now(), byId };
    return byId;
  } catch (err) {
    logger.warn({ err }, "property flags fetch threw — drafts show no flag warnings");
    return cache?.byId ?? new Map();
  }
}

/**
 * The last nine digits of every villa-side phone the site's Internal data
 * holds (`property_private.owner_phone`: the owner, or whoever the broker
 * recorded as the villa's contact).
 *
 * A Rental card whose number is one of these is the villa talking, not a
 * client: Amelia writes to the villa from her phone to book a client's
 * viewing, sends it its own link, and amoCRM opens a Rental card on the reply
 * (23528767 Bu Nia / R-YUD-054, 23543021 Mireia / R-YUD-065, 14.09 — both
 * numbers are exactly the listing's owner_phone). Such a thread must not be
 * pushed toward a viewing ("are you currently in Bali?" to the villa's staff).
 *
 * Only digit keys are kept, in memory; nothing here is logged or returned to a
 * surface. A failed read keeps the last good set (empty on a cold start:
 * nothing is recognised, so the push behaves as before rather than stopping).
 */
const VILLA_PHONES_TTL_MS = 10 * 60 * 1000;
let villaPhones: { at: number; keys: Set<string> } | null = null;

export function phoneKey(raw: string | null | undefined): string {
  const digits = String(raw ?? "").replace(/\D+/g, "");
  return digits.length >= 9 ? digits.slice(-9) : "";
}

export async function villaContactPhoneKeys(): Promise<Set<string>> {
  if (villaPhones && Date.now() - villaPhones.at < VILLA_PHONES_TTL_MS) return villaPhones.keys;
  const url = process.env["SUPABASE_URL"] ?? "";
  const key = process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? "";
  if (!url || !key) return villaPhones?.keys ?? new Set();
  try {
    const res = await fetch(`${url}/rest/v1/property_private?select=owner_phone&owner_phone=not.is.null`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "villa contact phones fetch failed — villa-side threads not recognised");
      return villaPhones?.keys ?? new Set();
    }
    const rows = (await res.json()) as Array<{ owner_phone: string | null }>;
    const keys = new Set<string>();
    for (const r of rows) {
      // A field can hold two numbers ("+62 811… / +62 812…").
      for (const part of String(r.owner_phone ?? "").split(/[\/,;]| or /i)) {
        const k = phoneKey(part);
        if (k) keys.add(k);
      }
    }
    villaPhones = { at: Date.now(), keys };
    return keys;
  } catch (err) {
    logger.warn({ err }, "villa contact phones fetch threw — villa-side threads not recognised");
    return villaPhones?.keys ?? new Set();
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
