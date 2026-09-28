/**
 * Fills a rental listing's deep-request features from what is already written about it — our own
 * listing text and Internal-data notes, and its Airbnb / Booking page — for villas nobody has
 * inspected with the new report yet (owner, 28.09.2026):
 *
 * "In Pre-listed mode we don't have an inspection yet, but when we get a listing … our bot gets the
 * specific details about the property on the website, checks Airbnb, checks Booking … it's not 100%
 * reliable information, but it's something … Copilot can use it as Pre-listed with the features."
 * "Double check that all the rental listings on the website have those features; if we don't have
 * the information, ask our bot to check Booking and Airbnb to fill them out."
 *
 * Only EMPTY columns are filled, and only with what a source actually says (null otherwise — "not
 * checked" is not "no"). A listing whose features came from Yudi's inspection report
 * (features_source = inspection) is never touched. What this fills is marked features_source =
 * online. Every listing it has looked at gets features_checked_at, so the background pass reads each
 * new listing once instead of paying for the same empty answer every run.
 */
import { logger } from "./logger";
import { chatCompletionJSON, HELPER_MODEL } from "./ai-client";
import { siteGet } from "./listing-status-week";

type Row = {
  id: string;
  title: string | null;
  description: string | null;
  features: string[] | null;
  tags: string[] | null;
  rental_included: string | null;
  garden: string | null;
  living_room: string | null;
  kitchen: string | null;
  pets_policy: string | null;
  kid_friendly: boolean | null;
  style: string | null;
  street: string | null;
  quiet_area: boolean | null;
  workspace: string | null;
  features_source: string | null;
  features_checked_at: string | null;
};
type Priv = { property_id: string; notes: string | null; green_flags: string | null; red_flags: string | null };

const KEYS = ["garden", "living_room", "kitchen", "pets_policy", "kid_friendly", "style", "street", "workspace"] as const;
type Key = (typeof KEYS)[number];
const ALLOWED: Record<Key, unknown[]> = {
  garden: ["none", "small", "large"],
  living_room: ["enclosed", "open"],
  kitchen: ["enclosed", "open"],
  pets_policy: ["allowed", "small_only", "not_allowed"],
  kid_friendly: [true, false],
  style: ["modern", "traditional", "mixed"],
  street: ["quiet", "some_traffic", "busy"],
  workspace: ["none", "desk", "office_room"],
};

function siteDb(): { url: string; key: string } {
  const url = process.env["SUPABASE_URL"] ?? "";
  const key = process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? "";
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
  return { url, key };
}
async function sitePatch(id: string, patch: Record<string, unknown>): Promise<void> {
  const { url, key } = siteDb();
  const res = await fetch(`${url}/rest/v1/properties?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`site PATCH ${id} → ${res.status} ${(await res.text()).slice(0, 200)}`);
}

/** Airbnb / Booking links in the listing's notes: a full URL, or an Airbnb "rooms/<id>" mention. */
export function onlineLinks(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/[^\s)"'<>]*(?:airbnb|booking)\.[^\s)"'<>]*/gi)) out.add(m[0]!.replace(/[.,;]+$/, ""));
  for (const m of text.matchAll(/rooms\/(\d{6,})/gi)) out.add(`https://www.airbnb.com/rooms/${m[1]}`);
  return [...out].slice(0, 2);
}

/** A page's readable facts: Airbnb's amenity and rule titles live in the page JSON, the rest in text. */
async function pageFacts(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) return "";
    const html = await res.text();
    const titles = [...html.matchAll(/"title":"([^"]{3,80})"/g)].map((m) => m[1]!);
    const rules = [...html.matchAll(/"(?:subtitle|text|html)":"([^"]{3,160})"/g)].map((m) => m[1]!).filter((t) => /pet|child|kid|infant|smok|quiet|noise|garden|kitchen|workspace|desk/i.test(t));
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .slice(0, 4000);
    return [...new Set([...titles, ...rules])].slice(0, 220).join(" | ") + "\n" + text;
  } catch {
    return "";
  }
}

type Found = Partial<Record<Key, unknown>>;

async function readFeatures(row: Row, priv: Priv | undefined, online: string): Promise<Found> {
  const own = [
    `Title: ${row.title ?? ""}`,
    `Description: ${(row.description ?? "").slice(0, 3000)}`,
    `Feature chips: ${(row.features ?? []).join(", ")}`,
    `Tags: ${(row.tags ?? []).join(", ")}`,
    row.rental_included ? `Included: ${row.rental_included}` : "",
    priv?.notes ? `Our team's notes: ${priv.notes.slice(0, 2500)}` : "",
    priv?.green_flags ? `Green flags from our inspection: ${priv.green_flags}` : "",
    priv?.red_flags ? `Red flags from our inspection: ${priv.red_flags}` : "",
  ].filter(Boolean).join("\n");
  const out = await chatCompletionJSON<Record<string, unknown>>({
    model: HELPER_MODEL,
    label: "listing-features-fill",
    max_tokens: 300,
    temperature: 0,
    system: `You read what is written about ONE rental villa in Bali and return its features. Answer a field only when the text actually says it or makes it plain; otherwise null. Never guess from what is typical.
- "garden": "large" (large/big/lush garden, big lawn), "small" (a garden, small garden, garden terrace), "none" (explicitly no garden), else null.
- "living_room": "enclosed" (enclosed / closed / air-conditioned living room), "open" (open living, open-plan, open-air living, joglo/gazebo living), else null.
- "kitchen": "enclosed" (closed / indoor kitchen), "open" (open kitchen, open-plan kitchen), else null.
- "pets_policy": "allowed" (pet friendly, pets allowed), "small_only" (small pets only), "not_allowed" (no pets, pets not allowed). An amenity list without pets is NOT "not_allowed" — null.
- "kid_friendly": true when the text says family/kid friendly, crib, children welcome, fenced pool; false when it says not suitable for children, infants not allowed, or names a danger for kids (unfenced drop, steep stairs); else null.
- "style": "modern" (modern, contemporary, minimalist, brand-new modern build), "traditional" (joglo, Balinese traditional, antique, rustic wooden), "mixed" (modern with traditional touches), else null.
- "street": "quiet" (quiet lane, quiet gang, peaceful, secluded), "busy" (main road, busy road, road noise), "some_traffic" (close to a road but not busy), else null.
- "workspace": "office_room" (separate office / study room), "desk" (dedicated workspace, desk, work area), "none" (explicitly no workspace), else null.
Return JSON with exactly these keys: garden, living_room, kitchen, pets_policy, kid_friendly, style, street, workspace.`,
    messages: [{ role: "user", content: `OUR LISTING\n${own}\n\n${online ? `ONLINE PAGE (Airbnb / Booking)\n${online.slice(0, 9000)}` : "No online page."}` }],
  });
  const found: Found = {};
  for (const k of KEYS) if (ALLOWED[k].includes(out?.[k])) found[k] = out[k];
  return found;
}

export type FillResult = { id: string; filled: Partial<Record<Key, unknown>>; online: boolean; skipped?: string };

export async function runFeatureFill(opts: { apply?: boolean; ids?: string[]; onlyUnchecked?: boolean; limit?: number } = {}): Promise<FillResult[]> {
  const filter = opts.ids?.length ? `&id=in.(${opts.ids.map((i) => encodeURIComponent(i)).join(",")})` : "";
  const rows = await siteGet<Row[]>(
    `properties?select=id,title,description,features,tags,rental_included,garden,living_room,kitchen,pets_policy,kid_friendly,style,street,quiet_area,workspace,features_source,features_checked_at&listing_type=eq.rent&is_draft=eq.false${filter}&order=id`,
  );
  const privs = await siteGet<Priv[]>(`property_private?select=property_id,notes,green_flags,red_flags`).catch(() => [] as Priv[]);
  const privOf = new Map(privs.map((p) => [p.property_id.toUpperCase(), p]));
  const out: FillResult[] = [];
  let n = 0;
  for (const row of rows) {
    if (opts.limit && n >= opts.limit) break;
    if (row.features_source === "inspection") { out.push({ id: row.id, filled: {}, online: false, skipped: "features from Yudi's inspection" }); continue; }
    if (opts.onlyUnchecked && row.features_checked_at) continue;
    const empty = KEYS.filter((k) => row[k] === null || row[k] === undefined);
    if (!empty.length) { out.push({ id: row.id, filled: {}, online: false, skipped: "nothing empty" }); continue; }
    n++;
    const priv = privOf.get(row.id.toUpperCase());
    const links = onlineLinks(`${priv?.notes ?? ""} ${row.description ?? ""}`);
    let online = "";
    for (const u of links) online += `${u}\n${await pageFacts(u)}\n`;
    try {
      const found = await readFeatures(row, priv, online.trim());
      const patch: Record<string, unknown> = {};
      for (const k of empty) if (found[k] !== undefined) patch[k] = found[k];
      // street and the older quiet_area column say the same thing: keep them in step.
      if (patch["street"] === "quiet" && row.quiet_area === null) patch["quiet_area"] = true;
      if (patch["street"] === "busy" && row.quiet_area === null) patch["quiet_area"] = false;
      if (Object.keys(patch).length && !row.features_source) patch["features_source"] = "online";
      patch["features_checked_at"] = new Date().toISOString();
      if (opts.apply) await sitePatch(row.id, patch);
      const { features_checked_at: _t, features_source: _s, ...filled } = patch;
      out.push({ id: row.id, filled, online: !!online });
    } catch (err) {
      logger.warn({ err, id: row.id }, "listing-features-fill: failed");
      out.push({ id: row.id, filled: {}, online: !!online, skipped: `error: ${String(err).slice(0, 120)}` });
    }
  }
  logger.info({ apply: !!opts.apply, looked: n, filled: out.filter((r) => Object.keys(r.filled).length).length }, "listing-features-fill: pass complete");
  return out;
}

/** New listings get read once, a few hours after they appear. */
export function startListingFeatureFill(): void {
  const tick = () => runFeatureFill({ apply: true, onlyUnchecked: true, limit: 20 }).catch((err) => logger.warn({ err }, "listing-features-fill: pass failed"));
  setTimeout(tick, 10 * 60_000);
  setInterval(tick, 6 * 3600_000);
}
