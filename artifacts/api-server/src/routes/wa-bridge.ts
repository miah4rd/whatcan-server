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
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";
import {
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
<div class="card">
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
 if(s.status==='open'){st.innerHTML='<span class="ok">Linked: +'+(s.me||'')+'</span>. You can close this page.';document.getElementById('qrcard').style.display='none';return;}
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
  const r = await pool.query(`UPDATE wa_sessions SET mode = $2, updated_at = now() WHERE name = $1 RETURNING *`, [req.params.name, mode]);
  res.json(r.rows[0] ?? { error: "no such session" });
});

router.post("/admin/wa/sessions/:name/logout", async (req, res) => {
  const r = await gateway("POST", `/sessions/${req.params.name}/logout`).catch((err) => ({ status: 503, data: { error: String(err) } }));
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

export default router;
