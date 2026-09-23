/**
 * Routes of the own WhatsApp bridge — see lib/wa-bridge.ts for the design.
 *
 *   POST /wa/inbound              wa-gateway → here (loopback + shared secret)
 *   GET  /wa/media/:file?s=       media files for amoCRM to fetch (HMAC-signed link)
 *   GET  /wa/link/:token          page a broker opens to link their number (QR or pairing code)
 *   /admin/wa/*                   sessions, modes, link tokens (ADMIN_TOKEN)
 */
import { Router, type Request } from "express";
import fs from "node:fs";
import path from "node:path";
import { db, pool, sentMessagesTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { brokerLines } from "../lib/amo-messenger-field";
import { isOwnLine } from "../lib/wa-own-line-ids";
import { deliverViaOwnLine } from "../lib/wa-own-send";
import { sendAttachmentLinks } from "../lib/outbound-send";
import crypto from "node:crypto";
import { listPipelines, listUsers } from "../lib/wa-routing";
import {
  OWNER_SESSION,
  WA_GATEWAY_SECRET,
  gateway,
  handleGatewayEvent,
  newLinkToken,
  sessionForToken,
  verifyMediaSig,
} from "../lib/wa-bridge";

const router = Router();
const MEDIA_DIR = process.env.WA_MEDIA_DIR ?? "/opt/wa-gateway-data/media";
const SESSION_RE = /^[a-z0-9_-]{2,40}$/;

function isLoopback(req: Request): boolean {
  const ip = req.socket.remoteAddress ?? "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

router.post("/wa/inbound", async (req, res) => {
  if (!WA_GATEWAY_SECRET || !isLoopback(req) || req.headers["x-wa-secret"] !== WA_GATEWAY_SECRET) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  try {
    await handleGatewayEvent(req.body);
    res.json({ ok: true });
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    // amojo 400 = the payload itself is wrong; retrying would block the queue.
    const permanent = /amojo 4\d\d/.test(msg) && !/amojo 429/.test(msg);
    logger.error({ err: msg, kind: req.body?.kind, id: req.body?.id }, "wa inbound failed");
    res.status(permanent ? 422 : 503).json({ error: msg });
  }
});

router.get("/wa/media/:file", (req, res) => {
  const file = req.params.file;
  if (!/^[0-9a-f-]{36}\.[a-z0-9]{1,5}$/.test(file) || !verifyMediaSig(file, req.query.s as string | undefined)) {
    res.status(404).end();
    return;
  }
  const full = path.join(MEDIA_DIR, file);
  if (!fs.existsSync(full)) {
    res.status(404).end();
    return;
  }
  res.sendFile(full, { maxAge: "7d" });
});

// ── Linking a number ──────────────────────────────────────────────────────────

router.get("/wa/link/:token", async (req, res) => {
  const session = await sessionForToken(req.params.token);
  if (!session) {
    res.status(410).send("This link has expired. Ask for a new one.");
    return;
  }
  await gateway("POST", `/sessions/${session}/start`, {}).catch(() => null);
  const t = encodeURIComponent(req.params.token);
  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Link WhatsApp</title>
<style>
body{font:16px/1.45 -apple-system,system-ui,sans-serif;margin:0;padding:24px 16px;background:#0f1a24;color:#e8eef3}
main{max-width:420px;margin:0 auto}
h1{font-size:22px;margin:0 0 8px}
.card{background:#182634;border-radius:14px;padding:18px;margin:16px 0}
img{display:block;width:100%;max-width:320px;margin:8px auto;background:#fff;border-radius:10px}
.code{font:600 30px/1 ui-monospace,monospace;letter-spacing:4px;text-align:center;margin:12px 0}
input,button{font:inherit;width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:0;margin-top:8px}
button{background:#25d366;color:#07210f;font-weight:600}
.ok{color:#25d366;font-weight:600}
ol{padding-left:20px;margin:8px 0}
</style></head><body><main>
<h1>Link WhatsApp to Unicorn CRM</h1>
<div id="status">Starting…</div>
<div class="card" id="qrcard">
<b>On a computer:</b> scan this code with the phone.
<ol><li>WhatsApp → Settings → Linked devices</li><li>Link a device → scan</li></ol>
<img id="qr" alt="QR code">
</div>
<div class="card" id="paircard">
<b>On this phone:</b> get a code instead.
<input id="phone" inputmode="tel" placeholder="Your WhatsApp number, e.g. 62812…">
<button id="pair">Get code</button>
<div class="code" id="code"></div>
<ol><li>WhatsApp → Settings → Linked devices → Link a device</li><li>“Link with phone number instead” → enter the code</li></ol>
</div>
</main><script>
var T=${JSON.stringify(t)};
function poll(){fetch('/api/wa/link/'+T+'/status').then(function(r){return r.json()}).then(function(s){
 var st=document.getElementById('status');
 if(s.status==='open'){st.innerHTML='<span class="ok">Linked: +'+(s.me||'')+'</span>. You can close this page.';document.getElementById('qrcard').style.display='none';document.getElementById('paircard').style.display='none';return;}
 st.textContent=s.status==='qr'?'Waiting for the phone…':'Connecting…';
 if(s.hasQr)document.getElementById('qr').src='/api/wa/link/'+T+'/qr.png?'+Date.now();
 if(s.pairingCode)document.getElementById('code').textContent=s.pairingCode;
 setTimeout(poll,4000);
}).catch(function(){setTimeout(poll,6000)})}
document.getElementById('pair').onclick=function(){
 var p=document.getElementById('phone').value.replace(/\\D/g,'');
 if(p.length<8)return;
 fetch('/api/wa/link/'+T+'/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:p})})
 .then(function(r){return r.json()}).then(function(s){if(s.pairingCode)document.getElementById('code').textContent=s.pairingCode});
};
poll();
</script></body></html>`);
});

router.get("/wa/link/:token/status", async (req, res) => {
  const session = await sessionForToken(req.params.token);
  if (!session) { res.status(410).json({ error: "expired" }); return; }
  const r = await gateway("GET", `/sessions/${session}`).catch(() => null);
  res.json(r?.status === 200 ? r.data : { status: "connecting" });
});

router.get("/wa/link/:token/qr.png", async (req, res) => {
  const session = await sessionForToken(req.params.token);
  if (!session) { res.status(410).end(); return; }
  const r = await gateway("GET", `/sessions/${session}/qr.png`).catch(() => null);
  if (r?.status !== 200 || !Buffer.isBuffer(r.data)) { res.status(404).end(); return; }
  res.set("Cache-Control", "no-store").type("png").send(r.data);
});

router.post("/wa/link/:token/pair", async (req, res) => {
  const session = await sessionForToken(req.params.token);
  if (!session) { res.status(410).json({ error: "expired" }); return; }
  const phone = String(req.body?.phone ?? "").replace(/\D/g, "");
  const r = await gateway("POST", `/sessions/${session}/start`, { pairingPhone: phone }).catch(() => null);
  res.json(r?.data ?? { error: "gateway unavailable" });
});

// ── Admin ─────────────────────────────────────────────────────────────────────

router.get("/admin/wa/sessions", async (_req, res) => {
  const [gw, db] = await Promise.all([
    gateway("GET", "/sessions").catch((err) => ({ status: 503, data: { error: String(err) } })),
    pool.query(`SELECT name, mode, label, phone, status, updated_at FROM wa_sessions ORDER BY name`),
  ]);
  res.json({ gateway: gw.data, db: db.rows });
});

router.post("/admin/wa/sessions/:name/link", async (req, res) => {
  const name = req.params.name;
  if (!SESSION_RE.test(name)) { res.status(400).json({ error: "session name: a-z 0-9 _ -" }); return; }
  await pool.query(
    `INSERT INTO wa_sessions (name, label) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET label = COALESCE(EXCLUDED.label, wa_sessions.label)`,
    [name, req.body?.label ?? null],
  );
  res.json({ url: await newLinkToken(name, Number(req.body?.hours) || 2) });
});

router.post("/admin/wa/sessions/:name/mode", async (req, res) => {
  const mode = req.body?.mode;
  if (mode !== "shadow" && mode !== "live") { res.status(400).json({ error: "mode: shadow | live" }); return; }
  if (mode === "live" && req.params.name === OWNER_SESSION) { res.status(403).json({ error: "the owner's personal number never goes to amoCRM" }); return; }
  const r = await pool.query(`UPDATE wa_sessions SET mode = $2, updated_at = now() WHERE name = $1 RETURNING *`, [req.params.name, mode]);
  res.json(r.rows[0] ?? { error: "no such session" });
});

router.post("/admin/wa/sessions/:name/logout", async (req, res) => {
  const r = await gateway("POST", `/sessions/${req.params.name}/logout`).catch((err) => ({ status: 503, data: { error: String(err) } }));
  res.status(r.status).json(r.data);
});

// Messages a number received or sent while it was in shadow mode (linked, not yet live) never
// reached amoCRM. Replays them through the same rule as live traffic: only a person with an open
// card whose responsible owns the number. 22.09.2026: Amelia and Yudi were linked hours before
// they went live, after Wahelp had stopped delivering. Dry by default; ?apply=1 writes.
router.post("/admin/wa/backfill", async (req, res) => {
  const session = String(req.query.session ?? "");
  if (!SESSION_RE.test(session)) { res.status(400).json({ error: "session=" }); return; }
  const apply = req.query.apply === "1";
  const since = req.query.since ? new Date(String(req.query.since)) : new Date(Date.now() - 2 * 86400_000);
  const rows = (await pool.query(
    `SELECT id, wa_id, direction, phone, type, text, media_file, created_at, status, card_lead_id FROM wa_messages
      WHERE session = $1 AND NOT mirrored AND wa_id IS NOT NULL AND direction IN ('in','out_phone')
        AND phone IS NOT NULL AND created_at >= $2 ORDER BY created_at`,
    [session, since.toISOString()],
  )).rows;
  const mimeOf = (f: string) => ({ jpg: "image/jpeg", png: "image/png", webp: "image/webp", mp4: "video/mp4", ogg: "audio/ogg", mp3: "audio/mpeg", m4a: "audio/mp4", pdf: "application/pdf" } as Record<string, string>)[f.split(".").pop() ?? ""] ?? "application/octet-stream";
  let done = 0, skipped = 0, failed = 0, dup = 0;
  for (const r of rows) {
    // A past message from the phone's history may already be in the card (it
    // came through Wahelp, or Copilot sent it): same text within 5 minutes.
    if (r.status === "history" && r.card_lead_id) {
      const seen = await pool.query(
        `SELECT 1 FROM lead_messages WHERE lead_id = $1 AND left(btrim(text), 60) = left(btrim($2), 60)
            AND abs(extract(epoch FROM sent_at - $3::timestamptz)) < 300 LIMIT 1`,
        [String(r.card_lead_id), r.text ?? "", r.created_at],
      );
      if (seen.rows.length) {
        dup++;
        if (apply) await pool.query(`UPDATE wa_messages SET status = 'history_dup' WHERE id = $1`, [r.id]);
        continue;
      }
    }
    if (!apply) continue;
    let media: { file: string; mimetype: string; fileName: string; size: number; seconds: null } | null = null;
    if (r.media_file) {
      try { media = { file: r.media_file, mimetype: mimeOf(r.media_file), fileName: r.media_file, size: fs.statSync(path.join(MEDIA_DIR, r.media_file)).size, seconds: null }; } catch { media = null; }
    }
    try {
      await handleGatewayEvent({
        kind: "message", session, id: r.wa_id, fromMe: r.direction === "out_phone", chatJid: `${r.phone}@s.whatsapp.net`,
        phone: r.phone, pushName: null, timestamp: Math.floor(new Date(r.created_at).getTime() / 1000),
        type: r.type ?? "text", text: r.text ?? "", quotedId: null, media,
        silentImport: r.status === "history",
      } as Parameters<typeof handleGatewayEvent>[0]);
      const m = await pool.query(`SELECT mirrored FROM wa_messages WHERE id = $1`, [r.id]);
      if (m.rows[0]?.mirrored) done++; else skipped++;
    } catch (err) {
      failed++;
      logger.warn({ err: String(err), session, waId: r.wa_id }, "wa backfill: message not imported");
    }
  }
  res.json({ session, apply, candidates: rows.length, alreadyInCard: dup, imported: done, noCard: skipped, failed });
});

// Ask the phone for one chat's past messages (they land as status 'history',
// then /admin/wa/backfill?since=… puts them into the card silently).
// A draft the broker already answered by hand. While Wahelp carried their number, what they typed
// on the phone never reached us, so a LIVE draft could sit in the inbox for days after the client
// had been answered (Amelia, 23.09.2026: "we visited already, that is error from AI"). Our own
// record of their phone messages (wa_messages) can now settle it. Dry by default.
// Wahelp stopped delivering on 21.09.2026 at ~15:06 and said nothing: Salesbot accepted every
// send, amoCRM recorded it, and the client got nothing (delivery error 903 on the message event).
// Copilot and the cards therefore show messages the client never received. This re-sends them
// through the broker's own line and records the new send; a lead that has heard from us since is
// left alone. Dry by default.
router.post("/admin/wa/resend-failed", async (req, res) => {
  const since = new Date(String(req.query.since ?? "2026-09-21T07:00:00Z"));
  const until = new Date(String(req.query.until ?? "2026-09-22T14:00:00Z"));
  const apply = req.query.apply === "1";
  // A shortlist is text PLUS its property links. The first pass re-sent only the
  // stored message_text, so clients got villa names with nothing to open —
  // linksOnly re-sends just the links for the leads named in ?leads=.
  const linksOnly = req.query.links_only === "1";
  const onlyLeads = new Set(String(req.query.leads ?? "").split(",").map((x) => x.trim()).filter(Boolean));
  const rows = (await pool.query(
    `SELECT s.id, s.lead_id, s.message_text, s.responsible_user, s.created_at, l.pipeline,
            p.attachments
       FROM sent_messages s JOIN leads_sync l ON l.lead_id = s.lead_id
       LEFT JOIN pending_suggestions p ON p.id = s.suggestion_id
      WHERE s.created_at BETWEEN $1 AND $2
        AND (s.webhook_status BETWEEN 200 AND 299 OR s.webhook_response LIKE '%NOT DELIVERED: Wahelp%')
        AND s.source_id IN ('56811','59537') AND l.pipeline IN ('Rental','Rental Listings')
        AND s.message_text IS NOT NULL AND s.message_text <> ''
      ORDER BY s.created_at`,
    [since.toISOString(), until.toISOString()],
  )).rows;
  const out: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    if (onlyLeads.size && !onlyLeads.has(String(r.lead_id))) continue;
    if (linksOnly) {
      const links = Array.isArray(r.attachments) ? r.attachments : [];
      const line = brokerLines(r.responsible_user).find((l) => isOwnLine(l));
      if (!links.length) { out.push({ lead: r.lead_id, skipped: "no links on this message" }); continue; }
      if (!line) { out.push({ lead: r.lead_id, skipped: "no bridge line for " + r.responsible_user }); continue; }
      if (!apply) { out.push({ lead: r.lead_id, would_send_links: links.length }); continue; }
      const n = await sendAttachmentLinks(String(r.lead_id), links as any, 0, null, "links after undelivered resend", req.log as any, null, String(line));
      out.push({ lead: r.lead_id, links_sent: n, of: links.length });
      continue;
    }
    // Anything of ours that reached the client since then makes a re-send a repeat.
    const later = await pool.query(
      `SELECT 1 FROM wa_messages WHERE card_lead_id = $1::bigint AND direction IN ('out_phone','out_copilot')
         AND created_at > $2 LIMIT 1`,
      [r.lead_id, r.created_at],
    );
    if (later.rows.length) { out.push({ lead: r.lead_id, skipped: "answered since" }); continue; }
    const line = brokerLines(r.responsible_user).find((l) => isOwnLine(l));
    if (!line) { out.push({ lead: r.lead_id, skipped: "no bridge line for " + r.responsible_user }); continue; }
    if (!apply) { out.push({ lead: r.lead_id, would_resend: String(r.message_text).slice(0, 60) }); continue; }
    const sent = await deliverViaOwnLine(r.lead_id, String(line), String(r.message_text));
    await db.insert(sentMessagesTable).values({
      leadId: r.lead_id, kind: "resend-undelivered", messageText: String(r.message_text),
      responsibleUser: r.responsible_user, sourceId: String(line),
      webhookStatus: sent.hookStatus, webhookResponse: `resend of ${r.created_at.toISOString()}: ${sent.hookBody}`,
    }).catch(() => undefined);
    // A shortlist is text PLUS its links. Re-sending the stored message_text on
    // its own once left six clients with villa names and nothing to open, so the
    // links travel with every re-send from here on.
    const links = Array.isArray(r.attachments) ? r.attachments : [];
    let linksSent = 0;
    if (sent.chatSent && links.length) {
      linksSent = await sendAttachmentLinks(String(r.lead_id), links as any, 0, null, "resend", req.log as any, null, String(line));
    }
    out.push({ lead: r.lead_id, resent: sent.chatSent, links: links.length ? `${linksSent}/${links.length}` : "none", why: sent.hookBody });
    await new Promise((x) => setTimeout(x, 2500));
  }
  res.json({ apply, candidates: rows.length, result: out });
});

router.post("/admin/wa/retire-answered", async (req, res) => {
  const apply = req.query.apply === "1";
  // A shortlist is text PLUS its property links. The first pass re-sent only the
  // stored message_text, so clients got villa names with nothing to open —
  // linksOnly re-sends just the links for the leads named in ?leads=.
  const linksOnly = req.query.links_only === "1";
  const onlyLeads = new Set(String(req.query.leads ?? "").split(",").map((x) => x.trim()).filter(Boolean));
  const rows = (await pool.query(
    `SELECT p.id, p.lead_id, p.created_at, max(w.created_at) AS answered_at
       FROM pending_suggestions p
       JOIN wa_messages w ON w.card_lead_id::text = p.lead_id
      WHERE p.status = 'pending' AND p.kind = 'live'
        AND w.direction IN ('out_phone','out_copilot') AND w.created_at > p.created_at
      GROUP BY p.id, p.lead_id, p.created_at
      ORDER BY p.created_at`,
  )).rows;
  if (apply && rows.length) {
    await pool.query(
      `UPDATE pending_suggestions SET status = 'skipped',
              autopilot_skipped_reason = 'the broker answered this from their phone — draft retired',
              autopilot_skipped_at = now()
        WHERE id = ANY($1::uuid[])`,
      [rows.map((r) => r.id)],
    );
    logger.info({ count: rows.length }, "wa: stale drafts retired (answered from the phone)");
  }
  res.json({ apply, retired: rows.length, leads: [...new Set(rows.map((r) => r.lead_id))].slice(0, 40) });
});

router.post("/admin/wa/history", async (req, res) => {
  const session = String(req.query.session ?? "");
  const phone = String(req.query.phone ?? "").replace(/\D/g, "");
  if (!SESSION_RE.test(session) || phone.length < 7) { res.status(400).json({ error: "session= & phone=" }); return; }
  const r = await gateway("POST", `/sessions/${session}/history`, { phone, count: Number(req.query.count) || 100 });
  res.status(r.status).json(r.data);
});

router.get("/admin/wa/messages", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const r = await pool.query(
    `SELECT * FROM wa_messages WHERE ($1::text IS NULL OR session = $1) ORDER BY created_at DESC LIMIT $2`,
    [(req.query.session as string) ?? null, limit],
  );
  res.json(r.rows);
});

// ── Numbers page: link numbers, pick each number's funnel ─────────────────────
// A capability URL (/api/wa/numbers/<WA_SETTINGS_KEY>) so the owner can open it
// from a phone; funnels, stages and users come live from amoCRM, so a funnel
// created later shows up here on its own.

function settingsKeyOk(key: string | undefined): boolean {
  const expected = process.env.WA_SETTINGS_KEY ?? "";
  if (!expected || !key || key.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(key), Buffer.from(expected));
}

router.get("/wa/numbers/:key/data", async (req, res) => {
  if (!settingsKeyOk(req.params.key)) { res.status(404).end(); return; }
  const [gw, rows, pipelines, users] = await Promise.all([
    gateway("GET", "/sessions").catch(() => ({ status: 503, data: [] })),
    pool.query(`SELECT name, mode, label, phone, status, pipeline, stage, responsible FROM wa_sessions ORDER BY name`),
    listPipelines(true),
    listUsers(),
  ]);
  const live = new Map<string, any>((Array.isArray(gw.data) ? gw.data : []).map((g: any) => [g.name, g]));
  res.json({
    numbers: rows.rows.map((r) => ({ ...r, connection: live.get(r.name)?.status ?? "not running" })),
    pipelines: pipelines
      .filter((p) => !p.is_archive)
      .map((p) => ({ id: p.id, name: p.name, stages: p.stages.filter((s) => s.type !== 1 && s.id !== 142 && s.id !== 143).map((s) => ({ id: s.id, name: s.name })) })),
    users,
  });
});

router.post("/wa/numbers/:key/save", async (req, res) => {
  if (!settingsKeyOk(req.params.key)) { res.status(404).end(); return; }
  const { name, label, pipeline, stage, responsible, mode } = req.body ?? {};
  if (!SESSION_RE.test(String(name ?? ""))) { res.status(400).json({ error: "bad number name" }); return; }
  if (mode !== undefined && mode !== "shadow" && mode !== "live") { res.status(400).json({ error: "mode: shadow | live" }); return; }
  if (mode === "live" && name === OWNER_SESSION) { res.status(403).json({ error: "This is the owner's personal number — it never goes to amoCRM." }); return; }
  const r = await pool.query(
    `UPDATE wa_sessions SET label = COALESCE($2, label), pipeline = COALESCE($3, pipeline), stage = COALESCE($4, stage), responsible = $5,
            mode = COALESCE($6, mode), updated_at = now()
      WHERE name = $1 RETURNING name, mode, label, pipeline, stage, responsible`,
    [name, label ?? null, pipeline || null, stage || null, responsible || null, mode ?? null],
  );
  logger.info({ number: name, pipeline, stage, responsible, mode }, "wa numbers: route saved");
  res.json(r.rows[0] ?? { error: "no such number" });
});

router.post("/wa/numbers/:key/new", async (req, res) => {
  if (!settingsKeyOk(req.params.key)) { res.status(404).end(); return; }
  const label = String(req.body?.label ?? "").trim().slice(0, 60) || null;
  const base = (label ?? "number").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "number";
  let name = base.length >= 2 ? base : `n-${base}`;
  for (let i = 2; (await pool.query(`SELECT 1 FROM wa_sessions WHERE name = $1`, [name])).rows.length; i++) name = `${base}-${i}`;
  await pool.query(`INSERT INTO wa_sessions (name, label) VALUES ($1, $2)`, [name, label]);
  res.json({ name, url: await newLinkToken(name, 24) });
});

router.post("/wa/numbers/:key/relink", async (req, res) => {
  if (!settingsKeyOk(req.params.key)) { res.status(404).end(); return; }
  const name = String(req.body?.name ?? "");
  if (!SESSION_RE.test(name)) { res.status(400).json({ error: "bad number name" }); return; }
  res.json({ url: await newLinkToken(name, 24) });
});

router.get("/wa/numbers/:key", (req, res) => {
  if (!settingsKeyOk(req.params.key)) { res.status(404).end(); return; }
  const k = JSON.stringify(encodeURIComponent(req.params.key));
  res.set("Cache-Control", "no-store").type("html").send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhatsApp numbers</title>
<style>
body{font:15px/1.45 -apple-system,system-ui,sans-serif;margin:0;padding:20px 16px;background:#0f1a24;color:#e8eef3}
main{max-width:640px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}
.sub{color:#8aa0b2;margin:0 0 16px}
.card{background:#182634;border-radius:14px;padding:16px;margin:14px 0}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.title{font-weight:600;font-size:17px;flex:1;min-width:0}
.pill{font-size:12px;padding:2px 8px;border-radius:99px;background:#24384a;color:#b8c7d3}
.pill.ok{background:#12422a;color:#5ee39a}.pill.bad{background:#4a1f24;color:#ff9a9a}
label{display:block;font-size:12px;color:#8aa0b2;margin:10px 0 4px}
select,input,button{font:inherit;width:100%;box-sizing:border-box;padding:10px;border-radius:10px;border:1px solid #2c4356;background:#0f1a24;color:#e8eef3}
button{background:#25d366;color:#07210f;font-weight:600;border:0;cursor:pointer}
button.ghost{background:#24384a;color:#e8eef3}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:0 10px}
@media (max-width:480px){.grid{grid-template-columns:1fr}}
.msg{font-size:13px;color:#5ee39a;min-height:18px;margin-top:6px;word-break:break-all}
a{color:#7cc4ff}
</style></head><body><main>
<h1>WhatsApp numbers</h1>
<p class="sub">A chat reaches amoCRM only when that person has an open card whose responsible is the owner of this number. Everything else on the phone stays private. A number with no responsible sends nothing to amoCRM.</p>
<div id="list">Loading…</div>
<div class="card">
<div class="title">Connect a new number</div>
<label>Name (e.g. Amelia rental)</label>
<input id="newLabel" placeholder="Who uses this number">
<div style="height:8px"></div>
<button id="newBtn">Get link to connect</button>
<div class="msg" id="newMsg"></div>
</div>
</main><script>
var K=${k}, D=null;
function esc(t){return String(t==null?'':t).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function opts(list,sel,empty){var h='<option value="">'+esc(empty)+'</option>';list.forEach(function(x){var on=(String(x.id)===String(sel)||x.name===sel)?' selected':'';h+='<option value="'+x.id+'"'+on+'>'+esc(x.name)+'</option>'});return h}
function findPipe(v){return D.pipelines.filter(function(p){return String(p.id)===String(v)||p.name===v})[0]}
function render(){
 var h='';
 if(!D.numbers.length)h='<div class="card">No numbers yet.</div>';
 D.numbers.forEach(function(n,i){
  var p=findPipe(n.pipeline), conn=n.connection==='open';
  h+='<div class="card" data-i="'+i+'"><div class="row"><div class="title">'+esc(n.label||n.name)+(n.phone?' · +'+esc(n.phone):'')+'</div>'
   +'<span class="pill '+(conn?'ok':'bad')+'">'+(conn?'connected':esc(n.connection))+'</span>'
   +'<span class="pill">'+(n.mode==='live'?'live: card chats in amoCRM':'test (not in amoCRM)')+'</span></div>'
   +'<div class="grid"><div><label>Responsible</label><select class="resp">'+opts(D.users,n.responsible,'— not set —')+'</select></div>'
   +'<div><label>Mode</label><select class="mode"><option value="live"'+(n.mode==='live'?' selected':'')+'>Live: chats go to amoCRM</option><option value="shadow"'+(n.mode!=='live'?' selected':'')+'>Test: record only</option></select></div></div>'
   +'<div style="height:10px"></div><div class="grid"><button class="save">Save</button><button class="ghost relink">Reconnect link</button></div>'
   +'<div class="msg"></div></div>';
 });
 var list=document.getElementById('list');list.innerHTML=h;
 [].forEach.call(list.querySelectorAll('.card[data-i]'),function(c){
  var n=D.numbers[+c.dataset.i], msg=c.querySelector('.msg');
  c.querySelector('.save').onclick=function(){
   msg.textContent='Saving…';
   post('save',{name:n.name,responsible:c.querySelector('.resp').value,mode:c.querySelector('.mode').value})
   .then(function(r){msg.textContent=r.error?r.error:'Saved.';load(true)});
  };
  c.querySelector('.relink').onclick=function(){post('relink',{name:n.name}).then(function(r){msg.innerHTML=r.url?'Open on the phone: <a href="'+esc(r.url)+'" target="_blank">'+esc(r.url)+'</a>':esc(r.error)})};
 });
}
function post(path,body){return fetch('/api/wa/numbers/'+K+'/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json()})}
function load(keepMsgs){fetch('/api/wa/numbers/'+K+'/data').then(function(r){return r.json()}).then(function(d){D=d;if(!keepMsgs)render();else setTimeout(render,1500)})}
document.getElementById('newBtn').onclick=function(){
 var m=document.getElementById('newMsg');m.textContent='Creating…';
 post('new',{label:document.getElementById('newLabel').value}).then(function(r){
  m.innerHTML=r.url?'Open on the phone of that number: <a href="'+esc(r.url)+'" target="_blank">'+esc(r.url)+'</a><br>It starts in test mode; switch to Live and pick the funnel after it connects.':esc(r.error);load(true);
 });
};
load();
</script></body></html>`);
});

// ── Send API for the owner's Claude co-workers (replaces Green API) ───────────
// Writes from the owner's own WhatsApp (WA_OWNER_SESSION) to a person or a
// group. Nothing here touches amoCRM: the gateway does not echo its own sends.
//   POST /api/wa/send    {to: "628…" | "…@g.us", text, media?: {url, kind, fileName}}
//   GET  /api/wa/groups  → [{id, name, size}]
// Auth: header "x-wa-token: <WA_SEND_TOKEN>" (or ?token= for tools that cannot set headers).

function sendTokenOk(req: Request): boolean {
  const expected = process.env.WA_SEND_TOKEN ?? "";
  const got = String(req.headers["x-wa-token"] ?? req.query.token ?? "");
  return Boolean(expected) && got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}
const ownerSession = () => OWNER_SESSION;

router.post("/wa/send", async (req, res) => {
  if (!sendTokenOk(req)) { res.status(401).json({ ok: false, error: "bad token" }); return; }
  const to = String(req.body?.to ?? req.body?.chatId ?? "").trim();
  const text = String(req.body?.text ?? req.body?.message ?? "");
  const media = req.body?.media ?? (req.body?.urlFile ? { url: req.body.urlFile, kind: "file", fileName: req.body.fileName } : undefined);
  if (!to || (!text && !media?.url)) { res.status(400).json({ ok: false, error: "need to + text (or media.url)" }); return; }
  const r = await gateway("POST", "/send", { session: ownerSession(), to: to.replace(/@c\.us$/, ""), text: media?.url ? (req.body?.caption ?? text) : text, media })
    .catch((err) => ({ status: 503, data: { ok: false, error: String(err) } }));
  await pool.query(
    `INSERT INTO wa_messages (session, wa_id, direction, phone, type, text, status, error) VALUES ($1, $2, 'out_api', $3, $4, $5, $6, $7)
     ON CONFLICT (session, wa_id) WHERE wa_id IS NOT NULL DO NOTHING`,
    [ownerSession(), r.data?.id ?? null, to, media?.url ? media.kind ?? "file" : "text", text, r.data?.ok ? "sent" : "error", r.data?.ok ? null : String(r.data?.error ?? r.status)],
  ).catch(() => null);
  logger.info({ to: to.slice(-4), ok: Boolean(r.data?.ok), error: r.data?.error }, "wa send api");
  res.status(r.data?.ok ? 200 : 422).json(r.data?.ok ? { ok: true, idMessage: r.data.id } : { ok: false, error: r.data?.error ?? "not sent" });
});

// Read side for the co-workers (owner, 22.09.2026): the replies to what they
// sent. Everything the owner's number sends or receives is recorded by the
// gateway in wa_messages (since it was linked, 16.09) — groups excepted.
//   GET /api/wa/messages?chatId=6281138312020&count=20   (one chat, newest first)
//   GET /api/wa/messages?since=2026-09-22T00:00:00Z       (every chat, newest first)
router.get("/wa/messages", async (req, res) => {
  if (!sendTokenOk(req)) { res.status(401).json({ ok: false, error: "bad token" }); return; }
  const digits = String(req.query.chatId ?? req.query.phone ?? "").replace(/@.*$/, "").replace(/\D/g, "");
  const count = Math.min(Math.max(Number(req.query.count) || 20, 1), 200);
  const since = req.query.since ? new Date(String(req.query.since)) : null;
  if (!digits && !(since && !isNaN(since.getTime()))) {
    res.status(400).json({ ok: false, error: "need chatId (phone digits) or since (ISO time)" });
    return;
  }
  const r = await pool.query(
    `SELECT wa_id, direction, phone, type, text, media_file, status, created_at FROM wa_messages
      WHERE session = $1
        AND ($2::text = '' OR right(regexp_replace(coalesce(phone,''), '\\D', '', 'g'), 9) = right($2, 9))
        AND ($3::timestamptz IS NULL OR created_at >= $3)
      ORDER BY created_at DESC LIMIT $4`,
    [ownerSession(), digits, since && !isNaN(since.getTime()) ? since.toISOString() : null, count],
  );
  res.json({
    ok: true,
    messages: r.rows.map((m) => ({
      id: m.wa_id,
      chatId: m.phone,
      from: m.direction === "in" ? "them" : "me",
      via: m.direction === "out_api" ? "api" : m.direction === "out_phone" ? "phone" : m.direction === "in" ? "whatsapp" : m.direction,
      type: m.type,
      text: m.text,
      hasMedia: Boolean(m.media_file),
      at: m.created_at,
    })),
  });
});

router.get("/wa/groups", async (req, res) => {
  if (!sendTokenOk(req)) { res.status(401).json({ ok: false, error: "bad token" }); return; }
  const r = await gateway("GET", `/groups/${ownerSession()}`).catch((err) => ({ status: 503, data: { error: String(err) } }));
  res.status(r.status).json(r.data);
});

export default router;
