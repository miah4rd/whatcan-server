/**
 * Our own WhatsApp ↔ amoCRM bridge (replaces the paid Wahelp channel).
 *
 *   broker's phone ⇄ wa-gateway (Baileys, 127.0.0.1:3100) ⇄ this module ⇄ amoCRM Chats API (amojo)
 *
 * The amojo channel is the one registered for whatcan in July 2026
 * (AMO_CHAT_CHANNEL_ID / _SECRET / _BOT_ID); scope_id = `${channel}_${amojo account}`.
 *
 * Every number starts in `shadow` mode: its messages are only recorded in
 * wa_messages, nothing reaches amoCRM. That is how a number is run next to
 * Wahelp without every inbound message landing in amoCRM twice. Switching a
 * number to `live` is the cutover, done after it is unlinked from Wahelp.
 *
 * amoCRM sends each outgoing-message hook exactly once, with no retry, so the
 * hook route answers 200 right away and the send runs in the background.
 */
import * as crypto from "crypto";
import { pool } from "@workspace/db";
import { logger } from "./logger";

const AMOJO_BASE = "https://amojo.amocrm.ru";
const clean = (v: string | undefined) => (v ?? "").replace(/["\r]/g, "").trim();
const CHANNEL_ID = clean(process.env.AMO_CHAT_CHANNEL_ID);
const CHANNEL_SECRET = clean(process.env.AMO_CHAT_CHANNEL_SECRET);
const BOT_ID = clean(process.env.AMO_CHAT_BOT_ID);
const AMOJO_ACCOUNT_ID = clean(process.env.AMO_CHAT_AMOJO_ID);

export const WA_GATEWAY_URL = process.env.WA_GATEWAY_URL ?? "http://127.0.0.1:3100";
export const WA_GATEWAY_SECRET = process.env.WA_GATEWAY_SECRET ?? "";
const PUBLIC_BASE = process.env.WA_PUBLIC_BASE ?? "https://copilot.globalapplab.ru";

export const SCOPE_ID = CHANNEL_ID && AMOJO_ACCOUNT_ID ? `${CHANNEL_ID}_${AMOJO_ACCOUNT_ID}` : "";

export type WaMode = "shadow" | "live";

// ── Tables ────────────────────────────────────────────────────────────────────

export async function ensureWaTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wa_sessions (
      name        text PRIMARY KEY,
      mode        text NOT NULL DEFAULT 'shadow' CHECK (mode IN ('shadow','live')),
      label       text,
      phone       text,
      status      text,
      updated_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS wa_messages (
      id                  bigserial PRIMARY KEY,
      session             text NOT NULL,
      wa_id               text,
      direction           text NOT NULL,           -- in | out_phone | out_amo
      phone               text,
      type                text,
      text                text,
      media_file          text,
      amo_msg_id          text,
      mirrored            boolean NOT NULL DEFAULT false,
      status              text,
      error               text,
      created_at          timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS wa_messages_session_wa_id ON wa_messages (session, wa_id) WHERE wa_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS wa_messages_created ON wa_messages (created_at DESC);
    CREATE TABLE IF NOT EXISTS wa_conversations (
      session              text NOT NULL,
      phone                text NOT NULL,
      amo_conversation_id  text,
      linked               boolean NOT NULL DEFAULT false,
      PRIMARY KEY (session, phone)
    );
    CREATE TABLE IF NOT EXISTS wa_link_tokens (
      token       text PRIMARY KEY,
      session     text NOT NULL,
      expires_at  timestamptz NOT NULL
    );
  `);
}

export async function sessionMode(name: string): Promise<WaMode> {
  const r = await pool.query(`SELECT mode FROM wa_sessions WHERE name = $1`, [name]);
  return (r.rows[0]?.mode as WaMode) ?? "shadow";
}

// ── amojo (Chats API) ─────────────────────────────────────────────────────────

async function amojo(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const date = new Date().toUTCString();
  const contentType = "application/json";
  const md5 = crypto.createHash("md5").update(raw).digest("hex");
  const sig = crypto
    .createHmac("sha1", CHANNEL_SECRET)
    .update([method, md5, contentType, date, path].join("\n"))
    .digest("hex");
  const res = await fetch(`${AMOJO_BASE}${path}`, {
    method,
    headers: { Date: date, "Content-Type": contentType, "Content-MD5": md5, "X-Signature": sig },
    body: method === "GET" ? undefined : raw,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let data: any = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* plain text error */ }
  return { status: res.status, data };
}

/** Connecting is idempotent; amoCRM drops the link when the integration is reinstalled. */
export async function connectChannel(): Promise<boolean> {
  if (!CHANNEL_ID || !CHANNEL_SECRET || !AMOJO_ACCOUNT_ID) {
    logger.error("wa-bridge: AMO_CHAT_* env is missing, channel not connected");
    return false;
  }
  const r = await amojo("POST", `/v2/origin/custom/${CHANNEL_ID}/connect`, {
    account_id: AMOJO_ACCOUNT_ID,
    title: "WhatsApp",
    hook_api_version: "v2",
    is_time_window_disabled: true,
  });
  if (r.status !== 200) logger.error({ status: r.status, data: r.data }, "wa-bridge: amojo connect failed");
  return r.status === 200;
}

export function verifyAmojoHook(
  rawBody: Buffer | undefined,
  signature: string | undefined,
  headers: Record<string, string | string[] | undefined> = {},
  path = "",
): boolean {
  if (!rawBody || !signature || !CHANNEL_SECRET) return false;
  const got = String(signature).toLowerCase();
  const same = (hex: string) => hex.length === got.length && crypto.timingSafeEqual(Buffer.from(hex), Buffer.from(got));
  const hmac = (data: string | Buffer) => crypto.createHmac("sha1", CHANNEL_SECRET).update(data).digest("hex");
  if (same(hmac(rawBody))) return true;
  // Diagnostics for a mismatch: which known signing scheme would have matched.
  const h = (k: string) => String(headers[k] ?? "");
  const variants: Record<string, string> = {
    trimmed: hmac(rawBody.toString("utf8").trim()),
    headerString: hmac(["POST", h("content-md5"), h("content-type"), h("date"), path].join("\n")),
    headerStringMd5Body: hmac(["POST", crypto.createHash("md5").update(rawBody).digest("hex"), h("content-type"), h("date"), path].join("\n")),
  };
  const matched = Object.entries(variants).find(([, v]) => same(v))?.[0] ?? null;
  logger.warn(
    { matched, sigLen: got.length, bodyLen: rawBody.length, contentType: h("content-type"), hasDate: Boolean(h("date")), hasMd5: Boolean(h("content-md5")), path },
    "wa-bridge: amojo hook signature mismatch",
  );
  return matched !== null;
}

async function deliveryStatus(amoMsgId: string, statusCode: 1 | 2 | -1, errorCode?: number, error?: string) {
  const body: Record<string, unknown> = { status_code: statusCode };
  if (statusCode === -1) Object.assign(body, { error_code: errorCode ?? 905, error: error ?? "Not delivered" });
  const r = await amojo("POST", `/v2/origin/custom/${SCOPE_ID}/${amoMsgId}/delivery_status`, body);
  if (r.status !== 200) logger.warn({ status: r.status, data: r.data, amoMsgId, statusCode }, "wa-bridge: delivery_status failed");
}

// ── Gateway ───────────────────────────────────────────────────────────────────

export async function gateway(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(`${WA_GATEWAY_URL}${path}`, {
    method,
    headers: { "x-wa-secret": WA_GATEWAY_SECRET, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const ct = res.headers.get("content-type") ?? "";
  const data = ct.includes("application/json") ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, data };
}

// ── Inbound events from the gateway ───────────────────────────────────────────

type GatewayEvent =
  | { kind: "session"; session: string; status: string; me?: string | null }
  | { kind: "ack"; session: string; id: string; status: number }
  | {
      kind: "message"; session: string; id: string; fromMe: boolean; chatJid: string; phone: string | null;
      pushName: string | null; timestamp: number; type: string; text: string; quotedId: string | null;
      media?: { file: string; mimetype: string; fileName: string; size: number; seconds: number | null } | null;
      location?: { lat: number; lon: number }; contact?: { name: string; phone: string };
    };

export function mediaUrl(file: string): string {
  const sig = crypto.createHmac("sha256", WA_GATEWAY_SECRET).update(file).digest("hex").slice(0, 32);
  return `${PUBLIC_BASE}/api/wa/media/${encodeURIComponent(file)}?s=${sig}`;
}

export function verifyMediaSig(file: string, sig: string | undefined): boolean {
  const expected = crypto.createHmac("sha256", WA_GATEWAY_SECRET).update(file).digest("hex").slice(0, 32);
  return typeof sig === "string" && sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

const conversationId = (session: string, key: string) => `wa-${session}-${key}`;

function amoMessage(ev: Extract<GatewayEvent, { kind: "message" }>): Record<string, unknown> {
  if (ev.type === "location" && ev.location) return { type: "location", location: ev.location };
  if (ev.type === "contact" && ev.contact) return { type: "contact", contact: ev.contact };
  if (ev.type !== "text") {
    if (!ev.media) return { type: "text", text: `${ev.text ? ev.text + "\n" : ""}[${ev.type} could not be downloaded from WhatsApp]` };
    return {
      type: ev.type,
      text: ev.text ?? "",
      media: mediaUrl(ev.media.file),
      file_name: ev.media.fileName,
      file_size: ev.media.size,
      ...(ev.media.seconds ? { media_duration: ev.media.seconds } : {}),
    };
  }
  return { type: "text", text: ev.text || " " };
}

export async function handleGatewayEvent(ev: GatewayEvent): Promise<void> {
  if (ev.kind === "session") {
    await pool.query(
      `INSERT INTO wa_sessions (name, status, phone, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (name) DO UPDATE SET status = EXCLUDED.status, phone = COALESCE(EXCLUDED.phone, wa_sessions.phone), updated_at = now()`,
      [ev.session, ev.status, ev.me ?? null],
    );
    if (ev.status === "logged_out") logger.error({ session: ev.session }, "wa-bridge: number unlinked or banned — relink required");
    return;
  }

  if (ev.kind === "ack") {
    const r = await pool.query(
      `UPDATE wa_messages SET status = $3 WHERE session = $1 AND wa_id = $2 RETURNING amo_msg_id`,
      [ev.session, ev.id, String(ev.status)],
    );
    const amoMsgId = r.rows[0]?.amo_msg_id as string | undefined;
    if (!amoMsgId) return;
    if (ev.status === 3) await deliveryStatus(amoMsgId, 1);
    else if (ev.status >= 4) await deliveryStatus(amoMsgId, 2);
    return;
  }

  // message
  const direction = ev.fromMe ? "out_phone" : "in";
  // On a retried event the row already exists: carry on unless it already
  // reached amoCRM (a failed import must be retried, not skipped).
  const ins = await pool.query(
    `INSERT INTO wa_messages (session, wa_id, direction, phone, type, text, media_file)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (session, wa_id) WHERE wa_id IS NOT NULL DO UPDATE SET error = wa_messages.error
     RETURNING id, mirrored`,
    [ev.session, ev.id, direction, ev.phone, ev.type, ev.text, ev.media?.file ?? null],
  );
  if (!ins.rows.length || ins.rows[0].mirrored) return;

  if ((await sessionMode(ev.session)) !== "live") return;
  if (ev.type === "reaction") return; // recorded only; not mirrored yet

  const clientKey = ev.phone ?? ev.chatJid.split("@")[0];
  const convId = conversationId(ev.session, clientKey);
  const client = {
    id: `wa-${clientKey}`,
    name: ev.pushName || (ev.phone ? `+${ev.phone}` : "WhatsApp"),
    ...(ev.phone ? { profile: { phone: `+${ev.phone}` } } : {}),
  };

  const conv = ev.phone
    ? (await pool.query(`SELECT amo_conversation_id, linked FROM wa_conversations WHERE session = $1 AND phone = $2`, [ev.session, ev.phone])).rows[0]
    : undefined;

  let replyTo: Record<string, unknown> | undefined;
  if (ev.quotedId) {
    const q = await pool.query(`SELECT 1 FROM wa_messages WHERE session = $1 AND wa_id = $2 AND mirrored`, [ev.session, ev.quotedId]);
    if (q.rows.length) replyTo = { message: { msgid: `${ev.session}:${ev.quotedId}` } };
  }

  const payload: Record<string, unknown> = {
    timestamp: ev.timestamp,
    msec_timestamp: ev.timestamp * 1000,
    msgid: `${ev.session}:${ev.id}`,
    conversation_id: convId,
    ...(conv?.amo_conversation_id && !conv.linked ? { conversation_ref_id: conv.amo_conversation_id } : {}),
    // A message the broker typed on the phone is history, not a new lead.
    silent: ev.fromMe,
    message: amoMessage(ev),
    ...(replyTo ? { reply_to: replyTo } : {}),
  };
  if (ev.fromMe) {
    payload.sender = { id: `wa-bot-${ev.session}`, ref_id: BOT_ID, name: "WhatsApp" };
    payload.receiver = client;
  } else {
    payload.sender = client;
  }

  const r = await amojo("POST", `/v2/origin/custom/${SCOPE_ID}`, { event_type: "new_message", payload });
  if (r.status === 200) {
    await pool.query(`UPDATE wa_messages SET mirrored = true, amo_msg_id = $2 WHERE id = $1`, [ins.rows[0].id, r.data?.new_message?.msgid ?? null]);
    if (conv?.amo_conversation_id && !conv.linked) {
      await pool.query(`UPDATE wa_conversations SET linked = true WHERE session = $1 AND phone = $2`, [ev.session, ev.phone]);
    }
  } else {
    await pool.query(`UPDATE wa_messages SET error = $2 WHERE id = $1`, [ins.rows[0].id, `amojo ${r.status}: ${JSON.stringify(r.data).slice(0, 500)}`]);
    logger.error({ status: r.status, data: r.data, session: ev.session, waId: ev.id }, "wa-bridge: import into amoCRM failed");
    throw new Error(`amojo ${r.status}`); // gateway keeps the event and retries
  }
}

// ── Outgoing hook from amoCRM ─────────────────────────────────────────────────

async function pickSession(explicit: string | null): Promise<string | null> {
  if (explicit) return explicit;
  const envDefault = process.env.WA_DEFAULT_SESSION;
  if (envDefault) return envDefault;
  const r = await pool.query(`SELECT name FROM wa_sessions WHERE mode = 'live' AND status = 'open' ORDER BY updated_at DESC`);
  return r.rows.length === 1 ? (r.rows[0].name as string) : null;
}

export async function handleAmoOutgoing(hook: any): Promise<void> {
  const m = hook?.message;
  const msg = m?.message;
  if (!msg?.id) return;
  const amoMsgId: string = msg.id;

  const clientId: string = m?.conversation?.client_id ?? "";
  const parsed = /^wa-([a-z0-9_-]+?)-(\d{7,15})$/.exec(clientId);
  const phone = parsed?.[2] ?? String(m?.receiver?.phone ?? "").replace(/\D/g, "");
  const session = await pickSession(parsed?.[1] ?? null);

  if (!session || !phone) {
    await deliveryStatus(amoMsgId, -1, 905, !phone ? "No phone number for this chat" : "Several WhatsApp numbers are live — pick the chat of a specific number");
    return;
  }

  // "Write first" creates the chat on amoCRM's side; remember its id so the
  // client's reply is threaded into that same chat.
  if (!parsed && m?.conversation?.id) {
    await pool.query(
      `INSERT INTO wa_conversations (session, phone, amo_conversation_id, linked) VALUES ($1, $2, $3, false)
       ON CONFLICT (session, phone) DO UPDATE SET amo_conversation_id = EXCLUDED.amo_conversation_id, linked = false`,
      [session, phone, m.conversation.id],
    );
  }

  let quotedId: string | undefined;
  const quotedMsgid: string | undefined = msg.reply_to?.message?.msgid;
  if (quotedMsgid?.startsWith(`${session}:`)) quotedId = quotedMsgid.slice(session.length + 1);

  const kind: string = msg.type ?? "text";
  const body = {
    session,
    to: phone,
    text: msg.text ?? "",
    ...(kind !== "text" && msg.media ? { media: { url: msg.media, kind, fileName: msg.file_name } } : {}),
    ...(quotedId ? { quotedId } : {}),
  };

  let result: { status: number; data: any };
  try {
    result = await gateway("POST", "/send", body);
  } catch (err) {
    result = { status: 503, data: { error: String(err) } };
  }

  const ok = result.status === 200 && result.data?.ok;
  await pool.query(
    `INSERT INTO wa_messages (session, wa_id, direction, phone, type, text, amo_msg_id, mirrored, status, error)
     VALUES ($1, $2, 'out_amo', $3, $4, $5, $6, true, $7, $8)
     ON CONFLICT (session, wa_id) WHERE wa_id IS NOT NULL DO NOTHING`,
    [session, ok ? result.data.id : null, phone, kind, msg.text ?? "", amoMsgId, ok ? "sent" : "error", ok ? null : JSON.stringify(result.data).slice(0, 500)],
  );

  if (!ok) {
    const code = Number(result.data?.code) || (result.status === 503 ? 903 : 905);
    const reason: Record<string, string> = {
      not_on_whatsapp: "This number is not on WhatsApp",
      session_not_open: `WhatsApp number "${session}" is disconnected`,
    };
    await deliveryStatus(amoMsgId, -1, code, reason[result.data?.error] ?? `Not sent: ${result.data?.error ?? result.status}`);
  }
}

export async function newLinkToken(session: string, hours = 2): Promise<string> {
  const token = crypto.randomBytes(18).toString("base64url");
  await pool.query(`INSERT INTO wa_link_tokens (token, session, expires_at) VALUES ($1, $2, now() + ($3 || ' hours')::interval)`, [token, session, String(hours)]);
  return `${PUBLIC_BASE}/api/wa/link/${token}`;
}

export async function sessionForToken(token: string): Promise<string | null> {
  const r = await pool.query(`SELECT session FROM wa_link_tokens WHERE token = $1 AND expires_at > now()`, [token]);
  return (r.rows[0]?.session as string) ?? null;
}
