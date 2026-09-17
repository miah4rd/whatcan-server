// wa-gateway — keeps the brokers' WhatsApp numbers linked (Baileys, the same
// library WAHA's NOWEB engine wraps; WAHA itself is a 3.5 GB image and did not
// fit this VPS) and exposes a tiny HTTP API on 127.0.0.1 only.
//
// It knows nothing about amoCRM. Every event (incoming message, message the
// broker typed on the phone, delivery/read ack, session state) is pushed to
// whatcan's POST /api/wa/inbound, which decides what reaches amoCRM.
//
// Why a separate PM2 process: deploy.sh restarts whatcan on every deploy, and a
// restart here re-handshakes every linked number. This one changes rarely.

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  getContentType,
  isJidBroadcast,
  isJidGroup,
  jidNormalizedUser,
  normalizeMessageContent,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import pino from "pino";
import QRCode from "qrcode";

const PORT = Number(process.env.WA_GATEWAY_PORT ?? 3100);
const SECRET = process.env.WA_GATEWAY_SECRET ?? "";
const DATA_DIR = process.env.WA_DATA_DIR ?? "/opt/wa-gateway-data";
const INBOUND_URL = process.env.WA_INBOUND_URL ?? "http://127.0.0.1:5000/api/wa/inbound";
const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
const MEDIA_DIR = path.join(DATA_DIR, "media");
const OUTBOX_FILE = path.join(DATA_DIR, "outbox.json");

if (!SECRET) {
  console.error("WA_GATEWAY_SECRET is not set — refusing to start");
  process.exit(1);
}
fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });

const log = pino({ level: process.env.WA_LOG_LEVEL ?? "info" });
const baileysLog = pino({ level: "warn" });

// ── Outbox to whatcan ────────────────────────────────────────────────────────
// whatcan restarts on every deploy (up to ~30 s). An event that cannot be
// delivered is kept and retried — a lost inbound message is a lost lead.

let outbox = [];
try { outbox = JSON.parse(fs.readFileSync(OUTBOX_FILE, "utf8")); } catch {}
let flushing = false;

function persistOutbox() {
  try { fs.writeFileSync(OUTBOX_FILE, JSON.stringify(outbox)); } catch (err) { log.error({ err }, "outbox persist failed"); }
}

function emit(event) {
  outbox.push({ ...event, emittedAt: Date.now() });
  persistOutbox();
  void flush();
}

async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    while (outbox.length) {
      const ev = outbox[0];
      let ok = false;
      try {
        const res = await fetch(INBOUND_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-wa-secret": SECRET },
          body: JSON.stringify(ev),
          signal: AbortSignal.timeout(20000),
        });
        // 4xx other than 408/429 means whatcan rejected the event itself;
        // retrying forever would block every event behind it.
        ok = res.ok || (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429);
        if (!res.ok) log.warn({ status: res.status, kind: ev.kind, id: ev.id }, "inbound rejected");
      } catch (err) {
        log.warn({ err: String(err), kind: ev.kind }, "whatcan unreachable, will retry");
      }
      if (!ok) break;
      outbox.shift();
      persistOutbox();
    }
  } finally {
    flushing = false;
  }
}
setInterval(() => void flush(), 5000);

// ── Sessions ─────────────────────────────────────────────────────────────────

/** @type {Map<string, {sock: any, status: string, qr: string|null, me: string|null, pairingPhone: string|null, pairingCode: string|null, stopped: boolean, retries: number}>} */
const sessions = new Map();
// Ids of messages this gateway sent, so their echo (fromMe upsert) is not
// reported back as "the broker typed this on the phone".
const sentIds = new Map();
const SENT_TTL = 10 * 60 * 1000;

function rememberSent(id) {
  sentIds.set(id, Date.now());
  if (sentIds.size > 5000) {
    const cutoff = Date.now() - SENT_TTL;
    for (const [k, t] of sentIds) if (t < cutoff) sentIds.delete(k);
  }
}

const validName = (n) => /^[a-z0-9_-]{2,40}$/.test(n);

async function startSession(name, { pairingPhone = null } = {}) {
  const existing = sessions.get(name);
  if (existing && !existing.stopped && existing.status !== "closed") {
    if (pairingPhone && existing.status !== "open") await requestPairing(existing, pairingPhone);
    return existing;
  }

  const dir = path.join(SESSIONS_DIR, name);
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  const sock = makeWASocket({
    version,
    auth: state,
    logger: baileysLog,
    browser: Browsers.macOS("Unicorn CRM"),
    // The broker keeps using WhatsApp on the phone: do not mark them online.
    // History sync stays ON (Baileys needs it for the LID↔phone mapping and
    // warns the session becomes unstable without it); old messages never reach
    // amoCRM because only messages.upsert is forwarded, see below.
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: true,
  });

  const s = existing ?? { sock: null, status: "connecting", qr: null, me: null, pairingPhone: null, pairingCode: null, stopped: false, retries: 0 };
  s.sock = sock;
  s.status = "connecting";
  s.stopped = false;
  sessions.set(name, s);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (u) => {
    if (u.qr) {
      s.qr = u.qr;
      s.status = "qr";
      if (pairingPhone && !state.creds.registered && !s.pairingCode) await requestPairing(s, pairingPhone);
    }
    if (u.connection === "open") {
      s.status = "open";
      s.qr = null;
      s.pairingCode = null;
      s.retries = 0;
      s.me = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
      log.info({ name, me: s.me }, "session open");
      emit({ kind: "session", session: name, status: "open", me: phoneOf(s.me) });
    }
    if (u.connection === "close") {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      log.warn({ name, code, loggedOut }, "session closed");
      s.status = "closed";
      if (loggedOut) {
        // Unlinked from the phone (or banned): the stored keys are dead.
        fs.rmSync(dir, { recursive: true, force: true });
        s.me = null;
        emit({ kind: "session", session: name, status: "logged_out", code });
        return;
      }
      if (s.stopped) return;
      s.retries += 1;
      const delay = Math.min(60000, 2000 * s.retries);
      emit({ kind: "session", session: name, status: "reconnecting", code, retries: s.retries });
      setTimeout(() => void startSession(name).catch((err) => log.error({ err, name }, "restart failed")), delay);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify" && type !== "append") return;
    for (const m of messages) {
      // "append" also replays recent history right after linking; only keep
      // fresh ones (a message the broker typed on the phone a moment ago).
      if (type === "append" && Date.now() / 1000 - Number(m.messageTimestamp ?? 0) > 600) continue;
      try { await onMessage(name, sock, m); } catch (err) { log.error({ err, name, id: m.key?.id }, "message handling failed"); }
    }
  });

  sock.ev.on("messages.update", (updates) => {
    for (const { key, update } of updates) {
      if (!key?.fromMe || update?.status == null) continue;
      emit({ kind: "ack", session: name, id: key.id, status: update.status });
    }
  });

  return s;
}

async function requestPairing(s, phone) {
  try {
    s.pairingPhone = phone;
    s.pairingCode = await s.sock.requestPairingCode(phone);
  } catch (err) {
    log.error({ err: String(err) }, "pairing code request failed");
  }
}

function phoneOf(jid) {
  if (!jid || !jid.endsWith("@s.whatsapp.net")) return null;
  return jid.split("@")[0].split(":")[0];
}

async function resolvePhone(sock, key) {
  for (const j of [key.remoteJid, key.remoteJidAlt, key.senderPn]) {
    const p = phoneOf(j);
    if (p) return p;
  }
  if (key.remoteJid?.endsWith("@lid")) {
    const pn = await sock.signalRepository?.lidMapping?.getPNForLID(key.remoteJid).catch(() => null);
    const p = phoneOf(pn ? jidNormalizedUser(pn) : null);
    if (p) return p;
  }
  return null;
}

const MEDIA_KINDS = {
  imageMessage: "picture",
  videoMessage: "video",
  audioMessage: "audio",
  documentMessage: "file",
  stickerMessage: "sticker",
};

async function onMessage(name, sock, m) {
  const jid = m.key?.remoteJid;
  if (!jid || !m.message) return;
  if (isJidGroup(jid) || isJidBroadcast(jid) || jid === "status@broadcast" || jid.endsWith("@newsletter")) return;

  const content = normalizeMessageContent(m.message);
  const ctype = content ? getContentType(content) : null;
  if (!ctype || ctype === "protocolMessage" || ctype === "senderKeyDistributionMessage") return;

  const fromMe = Boolean(m.key.fromMe);
  if (fromMe && sentIds.has(m.key.id)) return; // our own send, already in amoCRM

  const phone = await resolvePhone(sock, m.key);
  const body = content[ctype];
  const ev = {
    kind: "message",
    session: name,
    id: m.key.id,
    fromMe,
    chatJid: jid,
    phone,
    pushName: fromMe ? null : (m.pushName ?? null),
    timestamp: Number(m.messageTimestamp ?? Math.floor(Date.now() / 1000)),
    type: "text",
    text: "",
    quotedId: body?.contextInfo?.stanzaId ?? null,
  };

  if (ctype === "conversation") {
    ev.text = content.conversation ?? "";
  } else if (ctype === "extendedTextMessage") {
    ev.text = body.text ?? "";
  } else if (ctype === "reactionMessage") {
    ev.type = "reaction";
    ev.text = body.text ?? "";
    ev.quotedId = body.key?.id ?? null;
  } else if (ctype === "locationMessage" || ctype === "liveLocationMessage") {
    ev.type = "location";
    ev.location = { lat: body.degreesLatitude, lon: body.degreesLongitude };
  } else if (ctype === "contactMessage") {
    ev.type = "contact";
    const tel = /TEL[^:]*:([+\d\s-]+)/.exec(body.vcard ?? "")?.[1]?.replace(/[^\d+]/g, "") ?? "";
    ev.contact = { name: body.displayName ?? "", phone: tel };
  } else if (MEDIA_KINDS[ctype]) {
    ev.type = ctype === "audioMessage" && body.ptt ? "voice" : MEDIA_KINDS[ctype];
    ev.text = body.caption ?? "";
    ev.media = await saveMedia(sock, m, body, ctype);
  } else {
    ev.text = `[unsupported WhatsApp message: ${ctype}]`;
  }

  emit(ev);
}

function extFor(mimetype, fallback) {
  const map = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "application/pdf": "pdf" };
  const base = (mimetype ?? "").split(";")[0].trim();
  return map[base] ?? fallback;
}

async function saveMedia(sock, m, body, ctype) {
  try {
    const buf = await downloadMediaMessage(m, "buffer", {}, { logger: baileysLog, reuploadRequest: sock.updateMediaMessage });
    const ext = extFor(body.mimetype, ctype === "documentMessage" ? "bin" : "dat");
    const file = `${crypto.randomUUID()}.${ext}`;
    fs.writeFileSync(path.join(MEDIA_DIR, file), buf);
    return {
      file,
      mimetype: body.mimetype ?? "application/octet-stream",
      fileName: body.fileName ?? file,
      size: buf.length,
      seconds: body.seconds ?? null,
    };
  } catch (err) {
    log.error({ err: String(err), id: m.key.id }, "media download failed");
    return null;
  }
}

// ── Sending ──────────────────────────────────────────────────────────────────

async function send({ session, to, text, media, quotedId }) {
  const s = sessions.get(session);
  if (!s || s.status !== "open") return { ok: false, error: "session_not_open", code: 902 };

  let jid;
  if (/@g\.us$/.test(String(to))) {
    jid = String(to); // a group the number is in
  } else {
    const digits = String(to ?? "").replace(/@.*$/, "").replace(/\D/g, "");
    if (digits.length < 7) return { ok: false, error: "bad_phone", code: 904 };
    const [exists] = await s.sock.onWhatsApp(`${digits}@s.whatsapp.net`).catch(() => [null]);
    if (!exists?.exists) return { ok: false, error: "not_on_whatsapp", code: 904 };
    jid = exists.jid;
  }

  let payload;
  if (media?.url) {
    const kind = media.kind;
    if (kind === "picture") payload = { image: { url: media.url }, caption: text || undefined };
    else if (kind === "video") payload = { video: { url: media.url }, caption: text || undefined };
    else if (kind === "voice") payload = { audio: { url: media.url }, mimetype: "audio/ogg; codecs=opus", ptt: true };
    else if (kind === "audio") payload = { audio: { url: media.url }, mimetype: media.mimetype ?? "audio/mpeg" };
    else if (kind === "sticker") payload = { sticker: { url: media.url } };
    else payload = { document: { url: media.url }, fileName: media.fileName ?? "file", mimetype: media.mimetype ?? "application/octet-stream", caption: text || undefined };
  } else {
    if (!text) return { ok: false, error: "empty_message", code: 905 };
    payload = { text };
  }

  const options = quotedId ? { quoted: { key: { remoteJid: jid, id: quotedId, fromMe: false }, message: { conversation: "" } } } : {};
  const sent = await s.sock.sendMessage(jid, payload, options);
  if (sent?.key?.id) rememberSent(sent.key.id);
  return { ok: true, id: sent?.key?.id ?? null, jid };
}

async function react({ session, to, messageId, fromMe, emoji }) {
  const s = sessions.get(session);
  if (!s || s.status !== "open") return { ok: false, error: "session_not_open" };
  const jid = `${String(to).replace(/\D/g, "")}@s.whatsapp.net`;
  const sent = await s.sock.sendMessage(jid, { react: { text: emoji ?? "", key: { remoteJid: jid, id: messageId, fromMe: Boolean(fromMe) } } });
  if (sent?.key?.id) rememberSent(sent.key.id);
  return { ok: true };
}

// ── HTTP API (127.0.0.1 only, shared secret) ─────────────────────────────────

function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function view(name, s) {
  return { name, status: s.status, me: phoneOf(s.me), hasQr: Boolean(s.qr), pairingCode: s.pairingCode, retries: s.retries };
}

const server = http.createServer(async (req, res) => {
  if (req.headers["x-wa-secret"] !== SECRET) return json(res, 401, { error: "unauthorized" });
  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    if (req.method === "GET" && url.pathname === "/sessions") {
      return json(res, 200, [...sessions].map(([n, s]) => view(n, s)));
    }
    if (parts[0] === "sessions" && parts[1]) {
      const name = parts[1];
      if (!validName(name)) return json(res, 400, { error: "bad session name" });
      if (req.method === "POST" && parts[2] === "start") {
        const body = await readBody(req);
        const phone = body.pairingPhone ? String(body.pairingPhone).replace(/\D/g, "") : null;
        const s = await startSession(name, { pairingPhone: phone });
        // Give Baileys a moment to produce the first QR / pairing code.
        for (let i = 0; i < 20 && s.status === "connecting"; i++) await new Promise((r) => setTimeout(r, 250));
        if (phone && !s.pairingCode && s.status === "qr") await requestPairing(s, phone);
        return json(res, 200, view(name, s));
      }
      const s = sessions.get(name);
      if (!s) return json(res, 404, { error: "no such session" });
      if (req.method === "GET" && parts[2] === "qr.png") {
        if (!s.qr) return json(res, 404, { error: "no qr", status: s.status });
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
        return res.end(await QRCode.toBuffer(s.qr, { width: 360, margin: 2 }));
      }
      if (req.method === "GET" && !parts[2]) return json(res, 200, view(name, s));
      if (req.method === "POST" && parts[2] === "logout") {
        s.stopped = true;
        await s.sock.logout().catch(() => s.sock.end(undefined));
        fs.rmSync(path.join(SESSIONS_DIR, name), { recursive: true, force: true });
        sessions.delete(name);
        return json(res, 200, { ok: true });
      }
    }
    if (req.method === "GET" && parts[0] === "groups" && parts[1]) {
      const s = sessions.get(parts[1]);
      if (!s || s.status !== "open") return json(res, 422, { error: "session_not_open" });
      const all = await s.sock.groupFetchAllParticipating();
      return json(res, 200, Object.values(all).map((g) => ({ id: g.id, name: g.subject, size: g.participants?.length ?? null })));
    }
    if (req.method === "POST" && url.pathname === "/send") {
      const r = await send(await readBody(req));
      return json(res, r.ok ? 200 : 422, r);
    }
    if (req.method === "POST" && url.pathname === "/react") {
      const r = await react(await readBody(req));
      return json(res, r.ok ? 200 : 422, r);
    }
    return json(res, 404, { error: "not found" });
  } catch (err) {
    log.error({ err: String(err), path: url.pathname }, "request failed");
    return json(res, 500, { error: String(err?.message ?? err) });
  }
});

server.listen(PORT, "127.0.0.1", async () => {
  log.info({ port: PORT }, "wa-gateway listening");
  // Resume every number that was linked before the restart.
  for (const name of fs.readdirSync(SESSIONS_DIR)) {
    if (!validName(name) || !fs.existsSync(path.join(SESSIONS_DIR, name, "creds.json"))) continue;
    startSession(name).catch((err) => log.error({ err: String(err), name }, "resume failed"));
  }
});

async function shutdown() {
  persistOutbox();
  for (const s of sessions.values()) { s.stopped = true; try { s.sock.end(undefined); } catch {} }
  server.close();
  setTimeout(() => process.exit(0), 1500);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
