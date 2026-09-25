/**
 * Unicorn OS — the website catalog, read and edited in place.
 *
 * The site's own database is the only store: every write goes to the same
 * Supabase rows the site renders, with the service key, and passes the site's
 * own triggers (published listings need Internal data and photos, quiet-area
 * and construction guards, the Listed journal). A refusal from those triggers
 * is shown to the person as it is; nothing here second-guesses them.
 * "Free from" goes through the weekly check's own writer, so there is one way
 * a date reaches the site.
 */
import { chatCompletionJSON, WRITER_MODEL } from "../ai-client";
import { invalidatePropertyCache, freeFromOf } from "../property-catalog";
import { writeAvailability, writeOccupied } from "../weekly-availability-check";
import { signedStorageUpload, isOwnStorageUrl } from "../site-storage";
import { logger } from "../logger";
import { audit, type OsUser } from "./auth";

const SITE_URL = "https://unicorn-properties.com";

function env() {
  const url = process.env["SUPABASE_URL"] ?? "";
  const key = process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? "";
  if (!url || !key) throw new Error("The site database is not configured on the server.");
  return { url, key };
}

async function site<T>(path: string, init?: RequestInit & { prefer?: string }): Promise<T> {
  const { url, key } = env();
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init?.prefer ? { Prefer: init.prefer } : {}),
    },
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 400);
    try {
      const j = JSON.parse(text) as { message?: string; hint?: string; details?: string };
      msg = [j.message, j.details, j.hint].filter(Boolean).join(" — ");
    } catch {
      /* raw text */
    }
    throw new Error(msg || `The site database answered ${res.status}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

const PUBLIC_COLS = [
  "id", "title", "area", "type", "bedrooms", "bathrooms", "land_size", "build_size", "listing_type", "is_draft", "pre_listed",
  "monthly_price_idr", "yearly_price_idr", "price_usd", "price_on_request", "min_stay_months", "rental_included", "rental_excluded",
  "tags", "features", "images", "video_url", "description", "lat", "lng", "views", "garden", "workspace", "living_room",
  "quiet_area", "no_construction_nearby", "pool_sun", "listing_source", "created_at", "updated_at", "status", "ownership", "lease_years",
];
const PRIVATE_COLS = [
  "property_id", "owner_name", "owner_phone", "owner_email", "exact_address", "google_maps_url", "drive_folder_url", "notes",
  "construction_nearby", "construction_checked_on", "red_flags", "green_flags", "updated_at",
];

export type Availability = { status: string | null; start_date: string | null; end_date: string | null; note?: string | null };

const today = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

// The catalog changes a few times a day; four Supabase reads from Germany took
// 2.8 s per open of Villas. A minute of cache, dropped on every edit made here.
const listCache = new Map<string, { at: number; value: Awaited<ReturnType<typeof loadListings>> }>();
export function clearListingsCache() {
  listCache.clear();
}
export async function listListings(opts: { type?: "rent" | "sale" | "all"; drafts?: boolean }) {
  const key = `${opts.type ?? "all"}:${opts.drafts ? 1 : 0}`;
  const hit = listCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const value = await loadListings(opts);
  listCache.set(key, { at: Date.now(), value });
  return value;
}
async function loadListings(opts: { type?: "rent" | "sale" | "all"; drafts?: boolean }) {
  const filters: string[] = [];
  if (opts.type && opts.type !== "all") filters.push(`listing_type=eq.${opts.type}`);
  if (!opts.drafts) filters.push(`is_draft=eq.false`);
  const [props, avail, priv, links] = await Promise.all([
    site<Array<Record<string, unknown>>>(`properties?select=${PUBLIC_COLS.join(",")}&${filters.join("&")}&order=updated_at.desc&limit=1000`),
    site<Array<Availability & { property_id: string }>>(`property_availability?select=property_id,status,start_date,end_date,note`),
    site<Array<Record<string, unknown>>>(`property_private?select=${PRIVATE_COLS.join(",")}`).catch(() => []),
    site<Array<{ property_id: string; amo_lead_id: number }>>(`listing_crm_link?select=property_id,amo_lead_id`).catch(() => []),
  ]);
  const availBy = new Map<string, Availability[]>();
  for (const a of avail) availBy.set(a.property_id, [...(availBy.get(a.property_id) ?? []), a]);
  const privBy = new Map(priv.map((p) => [String(p["property_id"]), p]));
  const linkBy = new Map(links.map((l) => [l.property_id, String(l.amo_lead_id)]));
  const t = today();
  return props.map((p) => {
    const id = String(p["id"]);
    const periods = availBy.get(id) ?? [];
    return {
      ...p,
      url: `${SITE_URL}/property/${encodeURIComponent(id)}`,
      freeFrom: freeFromOf(periods as never, t),
      availability: periods,
      private: privBy.get(id) ?? null,
      crmLeadId: linkBy.get(id) ?? null,
    };
  });
}

export async function getListing(id: string) {
  const rows = await site<Array<Record<string, unknown>>>(`properties?select=${PUBLIC_COLS.join(",")}&id=eq.${encodeURIComponent(id)}`);
  if (!rows[0]) return null;
  const [avail, priv, links] = await Promise.all([
    site<Array<Availability>>(`property_availability?select=id,status,start_date,end_date,note&property_id=eq.${encodeURIComponent(id)}`),
    site<Array<Record<string, unknown>>>(`property_private?select=${PRIVATE_COLS.join(",")}&property_id=eq.${encodeURIComponent(id)}`).catch(() => []),
    site<Array<{ amo_lead_id: number }>>(`listing_crm_link?select=amo_lead_id&property_id=eq.${encodeURIComponent(id)}`).catch(() => []),
  ]);
  return {
    ...rows[0],
    url: `${SITE_URL}/property/${encodeURIComponent(id)}`,
    freeFrom: freeFromOf(avail as never, today()),
    availability: avail,
    private: priv[0] ?? null,
    crmLeadId: links[0] ? String(links[0].amo_lead_id) : null,
  };
}

// ── What may be written, and how each value is checked ──────────────────────

type Rule = (v: unknown) => unknown;
const str = (max: number): Rule => (v) => {
  if (v === null) return null;
  if (typeof v !== "string") throw new Error("text expected");
  if (v.length > max) throw new Error(`at most ${max} characters`);
  return v;
};
const int = (min: number, max: number, nullable = true): Rule => (v) => {
  if (v === null || v === "") { if (nullable) return null; throw new Error("required"); }
  const n = Number(v);
  if (!Number.isFinite(n) || Math.round(n) !== n || n < min || n > max) throw new Error(`a whole number ${min}–${max}`);
  return n;
};
const money: Rule = (v) => {
  if (v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100_000_000_000) throw new Error("a price in rupiah");
  return Math.round(n);
};
const oneOf = (vals: string[]): Rule => (v) => {
  if (v === null || v === "") return null;
  if (!vals.includes(String(v))) throw new Error(`one of: ${vals.join(", ")}`);
  return String(v);
};
const bool: Rule = (v) => (v === null ? null : Boolean(v));
const strList = (max: number): Rule => (v) => {
  if (!Array.isArray(v)) throw new Error("a list expected");
  const out = v.map((x) => String(x).trim()).filter(Boolean);
  if (out.length > max) throw new Error(`at most ${max} items`);
  return out;
};

const PUBLIC_RULES: Record<string, Rule> = {
  title: str(200),
  description: str(12000),
  area: str(80),
  bedrooms: int(0, 30, false),
  bathrooms: int(0, 30),
  land_size: int(0, 1_000_000),
  build_size: int(0, 1_000_000),
  monthly_price_idr: money,
  yearly_price_idr: money,
  min_stay_months: int(0, 120),
  rental_included: str(2000),
  rental_excluded: str(2000),
  tags: strList(30),
  features: strList(60),
  video_url: str(1000),
  garden: oneOf(["none", "small", "large"]),
  workspace: oneOf(["none", "desk", "office_room"]),
  living_room: oneOf(["open", "enclosed"]),
  quiet_area: bool,
  pool_sun: str(200),
  price_on_request: bool,
  pre_listed: bool,
};
const PRIVATE_RULES: Record<string, Rule> = {
  owner_name: str(200),
  owner_phone: str(200),
  owner_email: str(200),
  exact_address: str(500),
  google_maps_url: str(1000),
  drive_folder_url: str(1000),
  notes: str(8000),
  red_flags: str(4000),
  green_flags: str(4000),
  construction_nearby: bool,
  construction_checked_on: (v) => {
    if (v === null || v === "") return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new Error("a date YYYY-MM-DD");
    return String(v);
  },
};

export function describeFields() {
  return { public: Object.keys(PUBLIC_RULES), private: Object.keys(PRIVATE_RULES) };
}

function clean(patch: Record<string, unknown>, rules: Record<string, Rule>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch ?? {})) {
    const rule = rules[k];
    if (!rule) throw new Error(`“${k}” cannot be edited here`);
    try {
      out[k] = rule(v);
    } catch (e) {
      throw new Error(`${k}: ${(e as Error).message}`);
    }
  }
  return out;
}

export async function updateListing(user: OsUser, id: string, patch: Record<string, unknown>) {
  const current = await getListing(id);
  if (!current) throw new Error("No such listing.");
  const body = clean(patch, { ...PUBLIC_RULES, images: (v) => v });
  if ("images" in body) {
    // Reorder or remove only: a photo that is not already the listing's own
    // (or a fresh upload into our own bucket) never reaches the site this way.
    const list = strList(80)(body["images"]) as string[];
    const cur = current as unknown as Record<string, unknown>;
    const own = new Set((cur["images"] as string[] | null) ?? []);
    for (const u of list) if (!own.has(u) && !isOwnStorageUrl(u)) throw new Error("images: only this listing's photos or new uploads");
    if (!cur["is_draft"] && list.length < 5) throw new Error("images: a published listing keeps at least 5 photos");
    body["images"] = list;
  }
  if (!Object.keys(body).length) return current;
  const back = await site<Array<Record<string, unknown>>>(`properties?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    prefer: "return=representation",
  });
  const row = back?.[0];
  if (!row) throw new Error("The site did not return the listing — NOT saved.");
  for (const [k, v] of Object.entries(body)) {
    if (JSON.stringify(row[k] ?? null) !== JSON.stringify(v ?? null) && !(typeof v === "number" && Number(row[k]) === v)) {
      throw new Error(`${k}: the site stored a different value — check the listing on the site.`);
    }
  }
  invalidatePropertyCache();
  clearListingsCache();
  await audit(user, "listing.update", id, body);
  return getListing(id);
}

export async function updatePrivate(user: OsUser, id: string, patch: Record<string, unknown>) {
  clearListingsCache();
  const body = clean(patch, PRIVATE_RULES);
  if (!Object.keys(body).length) return getListing(id);
  const exists = await site<Array<{ property_id: string }>>(`property_private?select=property_id&property_id=eq.${encodeURIComponent(id)}`);
  if (exists.length) {
    await site(`property_private?property_id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body), prefer: "return=minimal" });
  } else {
    await site(`property_private`, { method: "POST", body: JSON.stringify([{ property_id: id, ...body }]), prefer: "return=minimal" });
  }
  await audit(user, "listing.private", id, Object.keys(body));
  return getListing(id);
}

export async function setAvailability(user: OsUser, id: string, input: { freeFrom?: string | null; occupiedNoDate?: boolean }) {
  clearListingsCache();
  const t = today();
  let res: { written: boolean; detail: string };
  if (input.occupiedNoDate) {
    res = await (writeOccupied as unknown as (p: string, note: string, today: string, apply: boolean) => Promise<{ written: boolean; detail: string }>)(
      id, `Set in Unicorn OS by ${user.name}`, t, true,
    );
  } else {
    const ff = input.freeFrom ?? null;
    if (ff !== null && !/^\d{4}-\d{2}-\d{2}$/.test(ff)) throw new Error("Pick a date.");
    res = await writeAvailability(id, ff && ff > t ? ff : null, `Set in Unicorn OS by ${user.name}`, t, true);
  }
  await audit(user, "listing.availability", id, { ...input, result: res.detail });
  return { ...res, listing: await getListing(id) };
}

export async function photoUploadUrl(id: string, fileName: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("bad listing id");
  return signedStorageUpload(id, "photo", fileName, "os");
}

// ── Edit by instruction (typed or dictated) ─────────────────────────────────

export async function proposeEdit(user: OsUser, id: string, instruction: string) {
  const listing = await getListing(id);
  if (!listing) throw new Error("No such listing.");
  const editable: Record<string, unknown> = {};
  for (const k of Object.keys(PUBLIC_RULES)) editable[k] = listing[k as keyof typeof listing] ?? null;
  const priv: Record<string, unknown> = {};
  for (const k of Object.keys(PRIVATE_RULES)) priv[k] = (listing.private as Record<string, unknown> | null)?.[k] ?? null;

  const system = `You edit one villa listing of Unicorn Property (Bali) on request of a broker.
You get the listing's current editable fields and an instruction (often dictated, may be Russian, Indonesian or English).
Return JSON only:
{"changes": {field: newValue}, "private_changes": {field: newValue}, "free_from": "YYYY-MM-DD" | "now" | null, "summary": "one English sentence of what changes", "questions": ["what you could not do or need to know"]}
Rules:
- Change ONLY what the instruction asks. Never touch other fields. Never invent facts (prices, sizes, dates) the instruction does not state.
- Public website text (title, description, tags, features) is ENGLISH, plain and factual. Titles follow the catalog style "3BR Villa with Private Pool in Pererenan".
- Prices are rupiah integers: "45 million" / "45 juta" / "45jt" = 45000000. monthly_price_idr / yearly_price_idr.
- garden: none|small|large; workspace: none|desk|office_room; living_room: open|enclosed.
- "free from" / "available from" a date goes to free_from (use the next future occurrence of a date given without a year; today is ${today()}). "free now" = "now". Otherwise null.
- Internal data (owner_name, owner_phone, exact_address, google_maps_url, drive_folder_url, notes, red_flags, green_flags, construction_nearby, construction_checked_on) goes to private_changes. red_flags / green_flags are one item per line; append to the existing text unless told to replace.
- Photos cannot be changed by instruction; say so in questions if asked.
Editable public fields: ${Object.keys(PUBLIC_RULES).join(", ")}.
Editable internal fields: ${Object.keys(PRIVATE_RULES).join(", ")}.`;

  const raw = await chatCompletionJSON<{ changes?: Record<string, unknown>; private_changes?: Record<string, unknown>; free_from?: string | null; summary?: string; questions?: string[] }>({
    model: WRITER_MODEL,
    system,
    messages: [{ role: "user", content: `CURRENT PUBLIC FIELDS:\n${JSON.stringify(editable, null, 1)}\n\nCURRENT INTERNAL DATA:\n${JSON.stringify(priv, null, 1)}\n\nINSTRUCTION:\n${instruction}` }],
    max_tokens: 3000,
    label: "os-listing-edit",
  });

  // The model proposes; the rules decide. Anything outside them is dropped and said.
  const dropped: string[] = [];
  const changes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw.changes ?? {})) {
    try {
      changes[k] = clean({ [k]: v }, PUBLIC_RULES)[k];
    } catch (e) {
      dropped.push(`${k}: ${(e as Error).message}`);
    }
  }
  const privateChanges: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw.private_changes ?? {})) {
    try {
      privateChanges[k] = clean({ [k]: v }, PRIVATE_RULES)[k];
    } catch (e) {
      dropped.push(`${k}: ${(e as Error).message}`);
    }
  }
  const diff = [
    ...Object.entries(changes).map(([k, v]) => ({ scope: "public", field: k, from: editable[k] ?? null, to: v })),
    ...Object.entries(privateChanges).map(([k, v]) => ({ scope: "private", field: k, from: priv[k] ?? null, to: v })),
  ].filter((d) => JSON.stringify(d.from) !== JSON.stringify(d.to));
  const freeFrom = raw.free_from === "now" ? "now" : raw.free_from && /^\d{4}-\d{2}-\d{2}$/.test(raw.free_from) ? raw.free_from : null;
  logger.info({ id, by: user.login, fields: diff.map((d) => d.field), freeFrom }, "os: listing edit proposed");
  return {
    summary: String(raw.summary ?? ""),
    questions: [...(Array.isArray(raw.questions) ? raw.questions.map(String) : []), ...dropped],
    diff,
    changes: Object.fromEntries(diff.filter((d) => d.scope === "public").map((d) => [d.field, d.to])),
    privateChanges: Object.fromEntries(diff.filter((d) => d.scope === "private").map((d) => [d.field, d.to])),
    freeFrom,
  };
}
