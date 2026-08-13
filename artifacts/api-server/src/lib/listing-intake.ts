import fs from "fs";
import path from "path";
import { chatCompletionJSON, WRITER_MODEL, type ChatMessage, type ChatImageBlock, type ChatTextBlock } from "./ai-client";
import { allAreaNames } from "./bali-areas";
import { logger } from "./logger";

/**
 * "Add a listing" as a CONVERSATION, not a form.
 *
 * The team used to publish listings by talking to a shared Claude account from
 * their own browsers, which collided constantly — same session, three people.
 * The fix is not a better shared chat: it is that this chat runs per broker, in
 * their own `/m` tab, and only the finished draft ever touches the database. So
 * the model here holds NO server-side state — the whole conversation and the
 * current draft arrive with every request and go back out with the answer.
 *
 * The broker pastes whatever the owner sent them (WhatsApp text, a price list,
 * photos) and corrects the draft in words: "4 bedrooms, not 3", "the yearly
 * price is 250 juta". Each turn returns the WHOLE draft again, so a correction
 * can never leave the card half-updated.
 */

export type ListingDraft = {
  title: string | null;
  area: string | null;
  type: string | null;
  listingType: "sale" | "rent" | null;
  bedrooms: number | null;
  bathrooms: number | null;
  landSize: number | null;
  buildSize: number | null;
  priceUsd: number | null;
  leaseholdPriceUsd: number | null;
  monthlyPriceUsd: number | null;
  yearlyPriceUsd: number | null;
  monthlyPriceIdr: number | null;
  yearlyPriceIdr: number | null;
  ownership: string | null;
  leaseYears: number | null;
  purpose: string | null;
  zone: string | null;
  description: string | null;
  features: string[];
  videoUrl: string | null;
};

export const EMPTY_DRAFT: ListingDraft = {
  title: null, area: null, type: null, listingType: null,
  bedrooms: null, bathrooms: null, landSize: null, buildSize: null,
  priceUsd: null, leaseholdPriceUsd: null, monthlyPriceUsd: null, yearlyPriceUsd: null,
  monthlyPriceIdr: null, yearlyPriceIdr: null,
  ownership: null, leaseYears: null, purpose: null, zone: null,
  description: null, features: [], videoUrl: null,
};

/** One turn of the intake conversation as the browser stores it. */
export type IntakeTurn = {
  role: "user" | "assistant";
  text: string;
  /** Image URLs (/api/uploads/...) the broker attached on THIS turn. */
  images?: string[];
};

export type IntakeResult = {
  /** What to say back to the broker, in their own language. */
  reply: string;
  draft: ListingDraft;
  /** Everything a listing needs is present — the publish button can light up. */
  ready: boolean;
  /** Field names still missing or uncertain, so the card can point at them. */
  missing: string[];
};

const UPLOAD_DIR = path.join(process.cwd(), "uploads");

/**
 * Photos cost ~1.5k tokens each and the conversation is re-sent on every turn,
 * so six images over a five-turn conversation would be billed thirty times.
 * They are sent ONLY on the turn they were attached; on later turns the model
 * reads what it already extracted from the draft it is handed back.
 */
const MAX_IMAGES_PER_TURN = 6;

function mediaTypeFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/jpeg";
}

/**
 * Reads an uploaded image back off disk as base64. Deliberately accepts only a
 * basename under our own upload directory: the URL travels through the browser,
 * and a path like ../../.env would otherwise read a secret straight into a
 * prompt.
 */
function imageBlock(url: string): ChatImageBlock | null {
  try {
    const base = path.basename(String(url));
    const full = path.join(UPLOAD_DIR, base);
    if (!full.startsWith(UPLOAD_DIR + path.sep)) return null;
    if (!fs.existsSync(full)) return null;
    const data = fs.readFileSync(full).toString("base64");
    return { type: "image", source: { type: "base64", media_type: mediaTypeFor(base), data } };
  } catch (err) {
    logger.warn({ err, url }, "listing intake: could not read attached image");
    return null;
  }
}

/**
 * Where the conversation is happening.
 *
 * `/m` and the extension show a listing CARD beside the chat: the broker watches
 * the fields fill in and presses Publish themselves. The assistant embedded in
 * the website has only its own reply — no card, no button — so on that surface
 * the recap and the ask-to-publish have to be part of what the model writes.
 * Same rules, same JSON, one implementation.
 */
export type IntakeSurface = { noCard?: boolean };

function buildSystemPrompt(surface: IntakeSurface = {}): string {
  const noCardBlock = surface.noCard
    ? [
        "",
        "THIS SURFACE HAS NO LISTING CARD",
        "- The broker sees ONLY your reply. There is no form beside it showing what you filled in, so anything you do not name in words is invisible to them.",
        "- After each of their messages, name in one compact list what you now hold and what is still missing. Keep it short — a list, not a paragraph.",
        "- When everything needed is present, recap the whole listing (title, area, type, bedrooms, price, photos) and ask the broker to confirm publishing it to the site.",
        "- The system assigns the next free property code by itself and appends it in square brackets at the very end of your reply. Tell the broker they can name a different code when they confirm.",
        "- NEVER say the listing is published, live, or added. Publishing happens only after the broker confirms, and the system says so, not you.",
      ]
    : [];
  return [
    "You are the listing intake assistant for Unicorn Property, a Bali real-estate agency.",
    "A broker gives you raw material about ONE property — a message from the owner, a price list, photos, notes — and your job is to turn it into a catalog listing and to ask about whatever is genuinely missing.",
    "",
    "HOW TO BEHAVE",
    "- Answer in the SAME language the broker writes to you in (they mostly write Russian).",
    "- Be brief. One or two sentences, then the specific question that unblocks publishing.",
    "- Ask about at most two missing things at a time, most important first.",
    "- The broker's latest message always wins over anything inferred earlier, including from photos.",
    "- When the broker corrects a field, change that field and leave the rest exactly as it was.",
    "",
    "NEVER INVENT",
    "- Do not invent a price, a size, a lease term, or an ownership type. If it was not stated, leave it null and ask.",
    "- Photos are evidence of style, condition, view and the room count you can literally see. They are not evidence of price or land size.",
    "- Do not convert currencies. Ever. If the owner said rupiah, it is a rupiah field; if they said dollars, it is a dollar field.",
    "",
    "PRICES",
    "- Rentals on Bali are quoted in RUPIAH. 'juta' / 'jt' / 'M' means million rupiah: 88 juta per month is monthlyPriceIdr = 88000000.",
    "- Use monthlyPriceIdr / yearlyPriceIdr for rentals priced in rupiah, monthlyPriceUsd / yearlyPriceUsd only when the owner genuinely quoted dollars.",
    "- Use priceUsd for a freehold sale price and leaseholdPriceUsd for a leasehold sale price.",
    "",
    "FIELDS",
    "- listingType is 'rent' or 'sale'. If the material is ambiguous, ask; do not guess.",
    "- area MUST be one of these exact names: " + allAreaNames().join(", ") + ".",
    "  If the owner names a place not on that list, pick the closest area on the list and say in your reply which one you chose and why.",
    "- type is one of: villa, apartment, land, townhouse, hotel.",
    "- ownership is 'freehold' or 'leasehold'. leaseYears is the remaining lease in years.",
    "- landSize and buildSize are in square metres, as plain integers.",
    "- features is a short list of concrete selling points in English (e.g. 'Private pool', 'Ocean view', 'Fully furnished'). Maximum eight. No invented amenities.",
    "- title is a short English name a client will see, e.g. '3BR Modern Villa in Pererenan'. No property codes, no agency name, no ALL CAPS.",
    "- description is the copy shown on the website: English, 2-4 sentences, factual, warm, no emoji, no phone numbers, no URLs, no invented rental yields or demand claims.",
    "- videoUrl only if the broker actually gave a video link.",
    "",
    "WHEN IS IT READY",
    "Set ready = true only when ALL of these are filled: title, area, listingType, type, bedrooms, description, and at least one price field appropriate to the listing type.",
    "List anything still missing or uncertain in 'missing', using the field names above.",
    "",
    "OUTPUT",
    "Return JSON with exactly these keys: reply (string), draft (object with every field below), ready (boolean), missing (array of strings).",
    "The draft object must ALWAYS contain every one of these keys, using null for unknown and [] for empty features:",
    "title, area, type, listingType, bedrooms, bathrooms, landSize, buildSize, priceUsd, leaseholdPriceUsd, monthlyPriceUsd, yearlyPriceUsd, monthlyPriceIdr, yearlyPriceIdr, ownership, leaseYears, purpose, zone, description, features, videoUrl.",
    "Never drop a field that already has a value just because this turn did not mention it — carry it through unchanged.",
    ...noCardBlock,
  ].join("\n");
}

function toIntOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseInt(String(v).replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function toStrOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

/**
 * The model is asked for every key every time, but a JSON answer is still
 * untrusted input: a missing key must read as "unknown", never as a crash, and
 * a stray type must not reach a Postgres integer column.
 */
function normaliseDraft(raw: unknown): ListingDraft {
  const r = (raw ?? {}) as Record<string, unknown>;
  const lt = toStrOrNull(r["listingType"])?.toLowerCase();
  const feats = Array.isArray(r["features"])
    ? (r["features"] as unknown[]).map((f) => String(f).trim()).filter(Boolean).slice(0, 8)
    : [];
  return {
    title: toStrOrNull(r["title"]),
    area: toStrOrNull(r["area"]),
    type: toStrOrNull(r["type"])?.toLowerCase() ?? null,
    listingType: lt === "rent" || lt === "sale" ? lt : null,
    bedrooms: toIntOrNull(r["bedrooms"]),
    bathrooms: toIntOrNull(r["bathrooms"]),
    landSize: toIntOrNull(r["landSize"]),
    buildSize: toIntOrNull(r["buildSize"]),
    priceUsd: toIntOrNull(r["priceUsd"]),
    leaseholdPriceUsd: toIntOrNull(r["leaseholdPriceUsd"]),
    monthlyPriceUsd: toIntOrNull(r["monthlyPriceUsd"]),
    yearlyPriceUsd: toIntOrNull(r["yearlyPriceUsd"]),
    monthlyPriceIdr: toIntOrNull(r["monthlyPriceIdr"]),
    yearlyPriceIdr: toIntOrNull(r["yearlyPriceIdr"]),
    ownership: toStrOrNull(r["ownership"])?.toLowerCase() ?? null,
    leaseYears: toIntOrNull(r["leaseYears"]),
    purpose: toStrOrNull(r["purpose"]),
    zone: toStrOrNull(r["zone"]),
    description: toStrOrNull(r["description"]),
    features: feats,
    videoUrl: toStrOrNull(r["videoUrl"]),
  };
}

/** Has this listing a price the client can actually judge it by? */
export function hasUsablePrice(d: ListingDraft): boolean {
  if (d.listingType === "rent") {
    return Boolean(d.monthlyPriceIdr || d.yearlyPriceIdr || d.monthlyPriceUsd || d.yearlyPriceUsd);
  }
  if (d.listingType === "sale") {
    return Boolean(d.priceUsd || d.leaseholdPriceUsd);
  }
  return false;
}

/**
 * The same completeness rule the model is given, applied in code as well.
 * A listing that reaches the catalog without a price or a bedroom count is
 * invisible to the matcher's hard filters — it would sit on the site and never
 * be offered to anybody, which looks exactly like the bot ignoring it.
 */
export function missingFields(d: ListingDraft): string[] {
  const out: string[] = [];
  if (!d.title) out.push("title");
  if (!d.area) out.push("area");
  if (!d.listingType) out.push("listingType");
  if (!d.type) out.push("type");
  if (d.bedrooms === null && d.type !== "land") out.push("bedrooms");
  if (!d.description) out.push("description");
  if (!hasUsablePrice(d)) out.push("price");
  return out;
}

/**
 * Runs one turn of the intake conversation.
 *
 * `turns` is the whole history as the browser holds it, oldest first, ending
 * with the broker's newest message. `draft` is what the card currently shows —
 * including any field the broker typed over by hand, which is why it is sent
 * back to the model rather than rebuilt from the conversation.
 */
export async function runListingIntakeTurn(
  turns: IntakeTurn[],
  draft: ListingDraft,
  surface: IntakeSurface = {},
): Promise<IntakeResult> {
  const messages: ChatMessage[] = [];
  const lastIdx = turns.length - 1;

  turns.forEach((t, i) => {
    if (t.role === "assistant") {
      messages.push({ role: "assistant", content: t.text || "(no answer)" });
      return;
    }
    const imgs = t.images ?? [];
    // Only the newest turn pays for its pictures; earlier ones become a note,
    // because whatever they showed is already carried in the draft below.
    if (imgs.length && i === lastIdx) {
      const blocks: Array<ChatTextBlock | ChatImageBlock> = [];
      for (const u of imgs.slice(0, MAX_IMAGES_PER_TURN)) {
        const b = imageBlock(u);
        if (b) blocks.push(b);
      }
      blocks.push({ type: "text", text: t.text || "Here are the photos of the property." });
      messages.push({ role: "user", content: blocks });
    } else {
      const note = imgs.length ? " [" + imgs.length + " photo(s) attached earlier, already reflected in the draft]" : "";
      messages.push({ role: "user", content: (t.text || "(no text)") + note });
    }
  });

  if (!messages.length) {
    messages.push({ role: "user", content: "(no message)" });
  }

  // The current card, appended as its own turn rather than folded into the
  // system prompt: it changes on every request, and the system prompt is where
  // the stable rules live.
  messages.push({
    role: "user",
    content:
      "This is the listing card as it stands right now, including any field the broker edited by hand. " +
      "Treat it as the truth to build on, and return the FULL updated version of it:\n" +
      JSON.stringify(draft),
  });

  const raw = await chatCompletionJSON<{
    reply?: unknown;
    draft?: unknown;
    ready?: unknown;
    missing?: unknown;
  }>({
    model: WRITER_MODEL,
    system: buildSystemPrompt(surface),
    messages,
    max_tokens: 1600,
    label: "listing-intake",
  });

  const next = normaliseDraft(raw.draft);
  const gaps = missingFields(next);

  return {
    reply: toStrOrNull(raw.reply) ?? "Draft updated.",
    draft: next,
    // The model's own verdict is accepted only when the code agrees. It called
    // a listing ready with no price more than once during testing, and such a
    // listing is unreachable by the matcher's budget filter.
    ready: gaps.length === 0,
    missing: gaps.length ? gaps : (Array.isArray(raw.missing) ? (raw.missing as unknown[]).map(String) : []),
  };
}

const SUPABASE_URL = process.env["SUPABASE_URL"] ?? "";
const SUPABASE_ANON_KEY = process.env["SUPABASE_ANON_KEY"] ?? "";

/**
 * Suggests the next free property code.
 *
 * Codes follow a manual convention the team owns (SAI-029, R-YUD-039), so this
 * only ever CONTINUES a series that already exists — it counts the numbers in
 * use under each prefix and offers the next one. It never invents a new prefix:
 * getting that wrong would quietly fork the naming scheme, and the broker can
 * always type the code themselves.
 *
 * Reads ids straight from Supabase rather than through the catalog cache on
 * purpose: the cache excludes drafts and sold units, and a code belonging to a
 * sold villa is still taken.
 */
export async function suggestPropertyCode(listingType: "sale" | "rent" | null): Promise<{
  suggestion: string | null;
  prefixes: string[];
  taken: string[];
}> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return { suggestion: null, prefixes: [], taken: [] };

  let ids: string[] = [];
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/properties?select=id,listing_type`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "listing intake: could not read property ids for code suggestion");
      return { suggestion: null, prefixes: [], taken: [] };
    }
    const rows = (await res.json()) as Array<{ id?: string; listing_type?: string | null }>;
    ids = rows.map((r) => String(r.id ?? "")).filter(Boolean);
    // Prefer the series used by listings of this same kind — rentals and sales
    // are numbered separately in this catalog.
    if (listingType) {
      const sameKind = rows.filter((r) => r.listing_type === listingType).map((r) => String(r.id ?? "")).filter(Boolean);
      if (sameKind.length >= 3) ids = sameKind;
    }
  } catch (err) {
    logger.warn({ err }, "listing intake: property id fetch failed");
    return { suggestion: null, prefixes: [], taken: [] };
  }

  // Split "R-YUD-039" into prefix "R-YUD-" and number 39.
  const byPrefix = new Map<string, { max: number; count: number; width: number }>();
  for (const id of ids) {
    const m = /^(.*[^0-9])(\d+)$/.exec(id);
    if (!m) continue;
    const prefix = m[1]!;
    const digits = m[2]!;
    const n = parseInt(digits, 10);
    const cur = byPrefix.get(prefix);
    if (cur) {
      cur.max = Math.max(cur.max, n);
      cur.count += 1;
      cur.width = Math.max(cur.width, digits.length);
    } else {
      byPrefix.set(prefix, { max: n, count: 1, width: digits.length });
    }
  }
  if (!byPrefix.size) return { suggestion: null, prefixes: [], taken: ids };

  const ranked = [...byPrefix.entries()].sort((a, b) => b[1].count - a[1].count);
  const [prefix, info] = ranked[0]!;
  const next = String(info.max + 1).padStart(info.width, "0");

  return {
    suggestion: prefix + next,
    prefixes: ranked.map(([p]) => p),
    taken: ids,
  };
}
