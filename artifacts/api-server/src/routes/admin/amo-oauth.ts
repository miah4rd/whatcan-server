/**
 * Admin page for amoCRM OAuth setup + manual sync trigger.
 * Protected by dashboard password (same SESSION_KEY cookie).
 */
import { Router } from "express";
import { db, brokerSettingsTable, pendingSuggestionsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { exchangeCode, buildAuthUrl, buildRedirectUri, hasCredentials, getAccessToken, getAllOpenLeadTasksPaginated } from "../../lib/amo-client";
import { syncLeadStages } from "../../lib/amo-sync";
import { logger } from "../../lib/logger";

const router = Router();

const DASH_PASSWORD = process.env.DASHBOARD_PASSWORD ?? "unicorn";

function isAuthed(req: { headers: Record<string, string | string[] | undefined> }): boolean {
  const auth = (req.headers["x-dash-password"] as string | undefined)
    ?? (req.headers["authorization"] as string | undefined)?.replace("Bearer ", "");
  return auth === DASH_PASSWORD;
}

// ── Status page (HTML) ────────────────────────────────────────────────────────

router.get("/admin/amo-oauth", async (req, res) => {
  const token = await getAccessToken().catch(() => null);
  const hasToken = Boolean(token);
  const credentialsOk = hasCredentials();

  const redirectUri = buildRedirectUri();
  const authUrl = credentialsOk ? buildAuthUrl() : null;

  let tokenExpiresAt = "—";
  try {
    const rows = await db.select().from(brokerSettingsTable)
      .where(eq(brokerSettingsTable.key, "amo_token_expires_at"));
    if (rows[0]) tokenExpiresAt = new Date(rows[0].value).toLocaleString("ru-RU");
  } catch {}

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>amoCRM OAuth — Unicorn Copilot</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #060f1e; color: #e0e0e0; padding: 40px 24px; max-width: 680px; margin: 0 auto; }
  h1 { font-size: 20px; color: #fff; margin-bottom: 4px; }
  .sub { color: #666; font-size: 13px; margin-bottom: 32px; }
  .card { background: #0d1f35; border: 1px solid rgba(77,184,255,0.12); border-radius: 12px; padding: 20px; margin-bottom: 20px; }
  .card h2 { font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #4db8ff88; margin-bottom: 12px; }
  .row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; font-size: 13px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .green { background: #34d399; }
  .red { background: #f87171; }
  .yellow { background: #fbbf24; }
  label { font-size: 12px; color: #888; display: block; margin-bottom: 4px; margin-top: 12px; }
  input[type=text], input[type=password] {
    width: 100%; background: #0a1628; border: 1px solid rgba(77,184,255,0.2);
    border-radius: 6px; color: #e0e0e0; font-size: 13px; padding: 8px 12px; font-family: monospace; outline: none;
  }
  a.btn, button.btn {
    display: inline-flex; align-items: center; gap: 8px;
    background: linear-gradient(135deg, #2563eb, #3b9eff); color: #fff; border: none;
    border-radius: 8px; padding: 10px 20px; font-size: 13px; font-weight: 600; text-decoration: none;
    cursor: pointer; margin-top: 12px;
  }
  a.btn.outline { background: transparent; border: 1px solid rgba(77,184,255,0.3); color: #4db8ff; }
  button.btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .code { background: #0a1628; border: 1px solid rgba(77,184,255,0.12); border-radius: 6px; padding: 10px 14px; font-family: monospace; font-size: 12px; color: #94a3b8; word-break: break-all; }
  #result { margin-top: 16px; padding: 12px; border-radius: 8px; font-size: 13px; display: none; }
  .ok { background: rgba(52,211,153,0.1); color: #34d399; border: 1px solid rgba(52,211,153,0.2); }
  .err { background: rgba(248,113,113,0.1); color: #f87171; border: 1px solid rgba(248,113,113,0.2); }
  .step { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 14px; font-size: 13px; line-height: 1.5; }
  .step-n { width: 22px; height: 22px; border-radius: 50%; background: rgba(77,184,255,0.15); color: #4db8ff; font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 1px; }
</style>
</head>
<body>
<h1>amoCRM OAuth Setup</h1>
<p class="sub">Unicorn Copilot · Синхронизация этапов лидов</p>

<!-- Status card -->
<div class="card">
  <h2>Статус</h2>
  <div class="row">
    <div class="dot ${credentialsOk ? "green" : "red"}"></div>
    <span>Credentials (CLIENT_ID / SECRET): <b>${credentialsOk ? "✓ заданы" : "✗ не заданы — нужно добавить в Secrets"}</b></span>
  </div>
  <div class="row">
    <div class="dot ${hasToken ? "green" : "yellow"}"></div>
    <span>Access token: <b>${hasToken ? "✓ есть, актуален до " + tokenExpiresAt : "✗ нет — нужна авторизация ниже"}</b></span>
  </div>
  <div class="row">
    <div class="dot green"></div>
    <span>Redirect URI (зарегистрировать в amoCRM): </span>
  </div>
  <div class="code">${redirectUri}</div>
</div>

${!credentialsOk ? `
<div class="card">
  <h2>Шаг 0 — добавить Secrets</h2>
  <p style="font-size:13px;color:#94a3b8;line-height:1.6">
    В Replit → <b>Secrets</b> добавить два ключа:<br>
    <code style="color:#4db8ff">AMOCRM_CLIENT_ID</code> — ID интеграции из amoCRM<br>
    <code style="color:#4db8ff">AMOCRM_CLIENT_SECRET</code> — Secret интеграции<br>
    После этого перезапустить сервер и вернуться на эту страницу.
  </p>
</div>
` : ""}

${credentialsOk ? `
<!-- Step 1: OAuth flow -->
<div class="card">
  <h2>Авторизация через amoCRM</h2>
  <div class="step"><div class="step-n">1</div><div>В amoCRM → Настройки → Интеграции → твоя интеграция → убедись что Redirect URI зарегистрирован:<br><span style="color:#4db8ff;font-family:monospace">${redirectUri}</span></div></div>
  <div class="step"><div class="step-n">2</div><div>Нажми кнопку — откроется всплывающее окно amoCRM для авторизации</div></div>
  <div class="step"><div class="step-n">3</div><div>После авторизации токены сохранятся автоматически, синхронизация запустится немедленно</div></div>
  <a class="btn" href="${authUrl}" target="_blank" rel="noopener">🔑 Авторизоваться в amoCRM</a>
  <p style="margin-top:12px;font-size:12px;color:#64748b">После авторизации в новой вкладке — код придёт на callback автоматически. Или вставь его вручную ниже.</p>
  <label>Вставить code вручную (если popup не сработал)</label>
  <div style="display:flex;gap:8px;align-items:center">
    <input type="text" id="codeInput" placeholder="authorization_code из URL" style="flex:1" />
    <button class="btn" id="exchangeBtn" onclick="exchangeManual()" style="margin-top:0;white-space:nowrap">Обменять</button>
  </div>
  <div id="result"></div>
</div>
` : ""}

${hasToken ? `
<!-- Manual sync trigger -->
<div class="card">
  <h2>Синхронизация вручную</h2>
  <p style="font-size:13px;color:#94a3b8;margin-bottom:12px">
    Автосинхронизация идёт каждые 5 минут. Здесь можно запустить принудительно — полезно сразу после авторизации.
  </p>
  <button class="btn outline" id="syncBtn" onclick="triggerSync()">⚡ Синхронизировать сейчас</button>
  <div id="syncResult" style="margin-top:12px;font-size:13px;display:none"></div>
</div>
` : ""}

<script>
async function exchangeManual() {
  const code = document.getElementById('codeInput').value.trim();
  if (!code) return;
  const btn = document.getElementById('exchangeBtn');
  btn.disabled = true; btn.textContent = '...';
  const res = await fetch('/api/admin/amo-oauth/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Dash-Password': 'unicorn' },
    body: JSON.stringify({ code }),
  });
  const d = await res.json();
  const el = document.getElementById('result');
  el.style.display = 'block';
  el.className = res.ok ? 'ok' : 'err';
  el.textContent = res.ok ? '✓ Токены сохранены! Синхронизация запущена.' : '✗ ' + (d.error ?? 'Ошибка');
  if (res.ok) setTimeout(() => location.reload(), 1500);
  btn.disabled = false; btn.textContent = 'Обменять';
}

async function triggerSync() {
  const btn = document.getElementById('syncBtn');
  const res_el = document.getElementById('syncResult');
  btn.disabled = true; btn.textContent = '⏳ Синхронизирую...';
  res_el.style.display = 'none';
  const res = await fetch('/api/admin/amo-oauth/sync', {
    method: 'POST',
    headers: { 'X-Dash-Password': 'unicorn' },
  });
  const d = await res.json();
  res_el.style.display = 'block';
  res_el.style.color = res.ok ? '#34d399' : '#f87171';
  res_el.textContent = res.ok
    ? '✓ Готово: ' + d.updated + ' лидов обновлено из ' + d.total + ' всего'
    : '✗ ' + (d.error ?? 'Ошибка');
  btn.disabled = false; btn.textContent = '⚡ Синхронизировать снова';
}
</script>
</body>
</html>`);
});

// ── OAuth callback ────────────────────────────────────────────────────────────

router.get("/admin/amo-oauth/callback", async (req, res) => {
  const code = req.query["code"] as string | undefined;
  if (!code) {
    res.status(400).send("Missing code parameter");
    return;
  }
  const ok = await exchangeCode(code);
  if (!ok) {
    res.status(500).send("Token exchange failed — check server logs");
    return;
  }
  // Trigger immediate sync in background
  syncLeadStages().catch((err) => logger.error({ err }, "post-oauth sync error"));
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html><html><body style="font-family:system-ui;background:#060f1e;color:#e0e0e0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
    <div style="text-align:center">
      <div style="font-size:48px;margin-bottom:16px">✅</div>
      <h1 style="color:#34d399;font-size:20px;margin-bottom:8px">Авторизация успешна!</h1>
      <p style="color:#64748b;font-size:14px">Токены сохранены. Синхронизация запущена.<br>Закройте это окно и обновите дашборд.</p>
    </div>
  </body></html>`);
});

// ── Manual code exchange ──────────────────────────────────────────────────────

router.post("/admin/amo-oauth/exchange", async (req, res) => {
  const { code } = req.body as { code?: string };
  if (!code) { res.status(400).json({ error: "code required" }); return; }
  const ok = await exchangeCode(code);
  if (!ok) { res.status(500).json({ error: "exchange failed" }); return; }
  syncLeadStages().catch((err) => logger.error({ err }, "post-exchange sync error"));
  res.json({ ok: true });
});

// ── Diagnostic: raw amoCRM tasks for specific leads ──────────────────────────
// GET /api/admin/check-tasks?leadIds=22825595,22823481,...
router.get("/admin/check-tasks", async (req, res) => {
  const raw = (req.query.leadIds as string | undefined) ?? "";
  const requested = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  try {
    const allTasks = await getAllOpenLeadTasksPaginated();
    const BALI_OFFSET_MS = 8 * 60 * 60 * 1000;
    const now = new Date();
    const nowBali = new Date(now.getTime() + BALI_OFFSET_MS);
    const tomorrowMidnightBaliAsUtc =
      Date.UTC(nowBali.getUTCFullYear(), nowBali.getUTCMonth(), nowBali.getUTCDate() + 1) - BALI_OFFSET_MS;
    const todayMidnight = tomorrowMidnightBaliAsUtc / 1000;
    const filtered = requested.size > 0
      ? allTasks.filter((t) => requested.has(String(t.entity_id)))
      : allTasks;
    const annotated = filtered.map((t) => ({
      leadId: String(t.entity_id),
      taskId: t.id,
      complete_till: t.complete_till,
      complete_till_iso: t.complete_till ? new Date(t.complete_till * 1000).toISOString() : null,
      classification: !t.complete_till
        ? "no-date"
        : t.complete_till > todayMidnight
        ? "FUTURE"
        : "DUE/OVERDUE",
      text: t.text?.slice(0, 60),
    }));
    res.json({ totalTasksInApi: allTasks.length, todayMidnight, returned: annotated.length, tasks: annotated });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Manual sync trigger ───────────────────────────────────────────────────────

router.post("/admin/amo-oauth/sync", async (req, res) => {
  try {
    const result = await syncLeadStages();
    res.json(result);
  } catch (err) {
    logger.error({ err }, "manual sync error");
    res.status(500).json({ error: String(err) });
  }
});

// ── Delete a specific lead's pending PUSH suggestion so scheduler regenerates it ──
// POST /api/admin/delete-push-suggestion?leadId=22835155
router.post("/admin/delete-push-suggestion", async (req, res) => {
  const leadId = (req.query.leadId as string | undefined)?.trim();
  if (!leadId) {
    res.status(400).json({ error: "leadId required" });
    return;
  }
  try {
    const result = await db
      .delete(pendingSuggestionsTable)
      .where(
        and(
          eq(pendingSuggestionsTable.leadId, leadId),
          eq(pendingSuggestionsTable.kind, "push"),
        ),
      );
    logger.info({ leadId, result }, "admin: deleted push suggestion");
    res.json({ ok: true, leadId });
  } catch (err) {
    logger.error({ err }, "admin: delete-push-suggestion error");
    res.status(500).json({ error: String(err) });
  }
});

/**
 * POST /api/admin/clear-all-attachments
 * Strips attachments from ALL pending push suggestions globally.
 * Run once after deploy to clean existing suggestions generated by old code.
 * New suggestions already store attachments:[] — this just fixes legacy rows.
 */
router.post("/admin/clear-all-attachments", async (req, res) => {
  try {
    const result = await db
      .update(pendingSuggestionsTable)
      .set({ attachments: [] })
      .where(
        and(
          eq(pendingSuggestionsTable.status, "pending"),
          eq(pendingSuggestionsTable.kind, "push"),
          sql`jsonb_array_length(attachments) > 0`,
        ),
      );
    const count = (result as unknown as { rowCount?: number }).rowCount ?? 0;
    logger.info({ count }, "admin: cleared attachments from all pending push suggestions");
    res.json({ ok: true, updated: count, message: `Cleared attachments from ${count} pending push suggestions.` });
  } catch (err) {
    logger.error({ err }, "admin: clear-all-attachments error");
    res.status(500).json({ error: String(err) });
  }
});

export default router;
