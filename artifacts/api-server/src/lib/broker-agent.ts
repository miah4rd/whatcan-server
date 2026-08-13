import fs from "fs";
import path from "path";
import { pool } from "@workspace/db";
import { chatCompletionJSON, HELPER_MODEL } from "./ai-client";
import { logger } from "./logger";
import { EMPTY_DRAFT, type ListingDraft } from "./listing-intake";

/**
 * The listing assistant as the WEBSITE talks to it.
 *
 * unicorn-property.com shows logged-in brokers an "Add a listing" bubble. Its
 * Supabase edge function (`broker-assistant`) checks the broker is really a
 * broker and then forwards the conversation here — one POST per message, reply
 * as plain text. This file holds everything that is specific to that surface:
 * the per-session memory, the photos, and the "did they just say publish?"
 * decision. The listing logic itself is the SAME `runListingIntakeTurn` the /m
 * chat uses, and publishing is the same `publishListingDraft`.
 *
 * Why a session table and not memory: the browser sends the transcript on every
 * turn but NOT the draft, and never re-sends a photo it already uploaded. A
 * `pm2 restart` — i.e. any deploy — in the middle of a broker's conversation
 * would otherwise drop the six pictures they had attached and the villa would
 * publish with none. The row is small, keyed by the tab's own session id, and
 * cleared the moment the listing goes live.
 */

const UPLOAD_DIR = path.join(process.cwd(), "uploads");

export type BrokerAgentSession = {
  sessionId: string;
  broker: string | null;
  draft: ListingDraft;
  /** Local URLs ("/api/uploads/x.jpg") of every photo attached so far. */
  images: string[];
  /** Set once the draft is complete and the broker has been asked to confirm. */
  pendingCode: string | null;
};

function emptySession(sessionId: string, broker: string | null): BrokerAgentSession {
  return { sessionId, broker, draft: { ...EMPTY_DRAFT }, images: [], pendingCode: null };
}

export async function loadSession(sessionId: string, broker: string | null): Promise<BrokerAgentSession> {
  try {
    const { rows } = await pool.query(
      `SELECT broker, draft, images, pending_code FROM broker_agent_sessions WHERE session_id = $1`,
      [sessionId],
    );
    const row = rows[0] as
      | { broker: string | null; draft: unknown; images: unknown; pending_code: string | null }
      | undefined;
    if (!row) return emptySession(sessionId, broker);
    return {
      sessionId,
      broker: broker ?? row.broker,
      draft: { ...EMPTY_DRAFT, ...((row.draft ?? {}) as Partial<ListingDraft>) },
      images: Array.isArray(row.images) ? (row.images as unknown[]).map(String) : [],
      pendingCode: row.pending_code,
    };
  } catch (err) {
    // A lost session is a re-asked question, not a failed request: the model
    // still has the whole transcript and rebuilds the draft from it.
    logger.warn({ err, sessionId }, "broker agent: session load failed");
    return emptySession(sessionId, broker);
  }
}

export async function saveSession(s: BrokerAgentSession): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO broker_agent_sessions (session_id, broker, draft, images, pending_code, updated_at)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, NOW())
       ON CONFLICT (session_id) DO UPDATE SET
         broker = EXCLUDED.broker,
         draft = EXCLUDED.draft,
         images = EXCLUDED.images,
         pending_code = EXCLUDED.pending_code,
         updated_at = NOW()`,
      [s.sessionId, s.broker, JSON.stringify(s.draft), JSON.stringify(s.images), s.pendingCode],
    );
  } catch (err) {
    logger.warn({ err, sessionId: s.sessionId }, "broker agent: session save failed");
  }
}

export async function clearSession(sessionId: string): Promise<void> {
  try {
    await pool.query(`DELETE FROM broker_agent_sessions WHERE session_id = $1`, [sessionId]);
  } catch (err) {
    logger.warn({ err, sessionId }, "broker agent: session clear failed");
  }
}

// ── Attachments ─────────────────────────────────────────────────────────────

const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"]);

/**
 * The photo URLs arrive from a browser, so they are untrusted input pointed at
 * our own `fetch`. Only the storage host of the site's own Supabase project is
 * allowed: without this the endpoint would happily read anything the caller
 * named, including addresses only this server can reach.
 */
function allowedHosts(): Set<string> {
  const hosts = new Set<string>();
  const add = (raw: string) => {
    const s = raw.trim();
    if (!s) return;
    try {
      hosts.add(new URL(s.includes("://") ? s : "https://" + s).host);
    } catch {
      /* ignore a malformed entry rather than failing every upload */
    }
  };
  add(process.env["SUPABASE_URL"] ?? "");
  for (const extra of (process.env["BROKER_AGENT_ATTACHMENT_HOSTS"] ?? "").split(",")) add(extra);
  return hosts;
}

function extensionFor(contentType: string, name: string): string {
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("gif")) return ".gif";
  const ext = path.extname(name).toLowerCase();
  if (ext === ".png" || ext === ".webp" || ext === ".gif") return ext;
  return ".jpg";
}

export type Attachment = { name?: string; url?: string; type?: string; size?: number };

/**
 * Downloads what the broker attached into our own uploads directory and returns
 * local URLs for it.
 *
 * The website hands us SIGNED links into a private bucket that expire in a week
 * — fine to read now, useless in the `properties` row a client opens in a month.
 * So the bytes are copied here, exactly like a photo attached in /m, and it is
 * our permanent URL that reaches the catalog.
 */
export async function saveAttachments(
  sessionId: string,
  attachments: Attachment[],
): Promise<{ images: string[]; skipped: string[] }> {
  const images: string[] = [];
  const skipped: string[] = [];
  if (!attachments.length) return { images, skipped };

  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const hosts = allowedHosts();
  const safeSession = sessionId.replace(/[^\w-]/g, "").slice(0, 12) || "web";

  for (const att of attachments.slice(0, 20)) {
    const name = String(att?.name ?? "file");
    const url = String(att?.url ?? "");
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || !hosts.has(parsed.host)) {
        skipped.push(name);
        logger.warn({ host: parsed.host }, "broker agent: attachment host not allowed");
        continue;
      }

      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) {
        skipped.push(name);
        continue;
      }

      const contentType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
        // PDFs, HEIC from an iPhone, price lists in .docx — the model reads
        // pictures and text, nothing else. Saying which file was ignored beats
        // silently dropping it and answering as if it had been read.
        skipped.push(name);
        continue;
      }

      const declared = parseInt(res.headers.get("content-length") ?? "0", 10);
      if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) {
        skipped.push(name);
        continue;
      }

      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > MAX_ATTACHMENT_BYTES) {
        skipped.push(name);
        continue;
      }

      const file =
        "listing_web_" + safeSession + "_" + Date.now() + "_" +
        Math.random().toString(36).slice(2, 8) + extensionFor(contentType, name);
      fs.writeFileSync(path.join(UPLOAD_DIR, file), buf);
      images.push("/api/uploads/" + file);
    } catch (err) {
      logger.warn({ err, name }, "broker agent: attachment download failed");
      skipped.push(name);
    }
  }

  return { images, skipped };
}

// ── "Did they just say publish?" ────────────────────────────────────────────

export type PublishIntent = { confirm: boolean; code: string | null; lang: "ru" | "en" };

/**
 * Asked only when the draft is already complete and the broker has been shown
 * the recap — never as a way of guessing what they meant in general.
 *
 * A model rather than keywords on purpose: "да, только цену поменяй на 90 juta"
 * starts with "да" and is not an approval, and this project has been burned
 * before by a keyword layer sitting between a broker's command and its
 * execution (see CLAUDE.md, "On the edit path the broker's instruction is LAW").
 */
export async function classifyPublishIntent(lastBrokerMessage: string, pendingCode: string): Promise<PublishIntent> {
  const fallback: PublishIntent = { confirm: false, code: null, lang: "ru" };
  const text = lastBrokerMessage.trim();
  if (!text) return fallback;

  try {
    const raw = await chatCompletionJSON<{ confirm?: unknown; code?: unknown; lang?: unknown }>({
      model: HELPER_MODEL,
      system: [
        "A broker was just shown a finished property listing and asked to confirm publishing it to the website.",
        "Proposed property code: " + pendingCode + ".",
        "Decide ONE thing: is their message a clear go-ahead to publish it exactly as it stands?",
        "",
        "- confirm = true only for an unambiguous yes: 'да', 'публикуй', 'давай', 'ok', 'yes, publish', 'go ahead'.",
        "- confirm = false for anything that also changes, questions or postpones something — a correction, a new fact, a price fix, 'подожди', a question. Even if it starts with 'да'.",
        "- code: a property code the broker names in THIS message (e.g. 'R-YUD-041', 'публикуй как SAI-030'), otherwise null. Never invent one.",
        "- lang: 'ru' if they are writing in Russian, otherwise 'en'.",
        "",
        'Return JSON: {"confirm": boolean, "code": string|null, "lang": "ru"|"en"}',
      ].join("\n"),
      messages: [{ role: "user", content: text.slice(0, 2000) }],
      max_tokens: 150,
      label: "broker-agent-confirm",
    });

    const code = typeof raw.code === "string" && raw.code.trim() ? raw.code.trim().toUpperCase() : null;
    return {
      confirm: raw.confirm === true,
      code,
      lang: raw.lang === "en" ? "en" : "ru",
    };
  } catch (err) {
    // Failing closed here means one more "confirm?" round trip. Failing open
    // would mean publishing a villa to a live website on a maybe.
    logger.warn({ err }, "broker agent: publish-intent check failed");
    return fallback;
  }
}
