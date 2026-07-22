import { Router } from "express";
import { db, leadsSyncTable, pendingSuggestionsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { isStageWhitelisted, PUSH_STAGE_WHITELIST } from "../../lib/stage-routing";

const router = Router();

// ── Admin HTML page ─────────────────────────────────────────────────────────
router.get("/admin/sync-stages", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bulk Stage Sync — Unicorn Copilot</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0f1117; color: #e0e0e0; padding: 32px; max-width: 800px; margin: 0 auto; }
    h1 { font-size: 22px; margin-bottom: 6px; color: #fff; }
    .sub { font-size: 13px; color: #888; margin-bottom: 24px; line-height: 1.6; }
    label { font-size: 13px; color: #aaa; display: block; margin-bottom: 6px; margin-top: 16px; }
    textarea { width: 100%; height: 280px; background: #1a1d26; border: 1px solid #333; border-radius: 8px; color: #e0e0e0; font-family: monospace; font-size: 12px; padding: 12px; resize: vertical; }
    .hint { font-size: 12px; color: #666; margin-top: 6px; margin-bottom: 20px; line-height: 1.5; }
    code { background: #1a1d26; padding: 1px 5px; border-radius: 3px; font-size: 12px; color: #a8b5c8; }
    .whitelist { background: #1a2030; border: 1px solid #2a4070; border-radius: 8px; padding: 12px 16px; margin-bottom: 20px; font-size: 13px; }
    .whitelist strong { color: #60a5fa; }
    .whitelist ul { margin: 6px 0 0 18px; color: #93c5fd; }
    .row { display: flex; gap: 12px; margin-bottom: 16px; align-items: center; }
    input[type=checkbox] { width: 16px; height: 16px; accent-color: #6c47ff; cursor: pointer; }
    input[type=checkbox] + label { margin: 0; cursor: pointer; font-size: 13px; color: #ccc; }
    button { background: #6c47ff; color: #fff; border: none; border-radius: 6px; padding: 10px 28px; font-size: 14px; font-weight: 600; cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    #results { margin-top: 24px; background: #1a1d26; border: 1px solid #333; border-radius: 8px; padding: 16px; display: none; font-family: monospace; font-size: 13px; line-height: 1.7; white-space: pre-wrap; max-height: 400px; overflow-y: auto; }
    .ok { color: #4ade80; }
    .warn { color: #facc15; }
    .err { color: #f87171; }
    .info { color: #60a5fa; }
  </style>
</head>
<body>
  <h1>📋 Bulk Stage Sync</h1>
  <p class="sub">
    Загрузи список лидов с их стадиями из AmoCRM.<br>
    Формат каждой строки: <code>leadId, stage, responsibleUser, pipeline</code> (разделитель — запятая или Tab).<br>
    <code>responsibleUser</code> и <code>pipeline</code> — опциональны.
  </p>

  <div class="whitelist">
    <strong>Whitelist стадий (активен):</strong>
    <ul>
      ${PUSH_STAGE_WHITELIST.map((s) => `<li>${s}</li>`).join("\n      ")}
    </ul>
    Лиды из других стадий будут обновлены в базе, но <em>не попадут в Push-очередь</em>.
  </div>

  <label>Вставь данные лидов (одна строка = один лид):</label>
  <textarea id="csv" placeholder="22406779, Lead Assigned, Robert, Main Pipeline
22381657, Taken to Work, Robert
22381645, Contact Established, Yudi, Main Pipeline
22420811, Lead Assigned"></textarea>
  <p class="hint">
    Пример из AmoCRM триггера:<br>
    <code>{{lead.id}}, {{lead.status}}, {{lead.responsible.name}}, {{lead.pipeline}}</code>
  </p>

  <div class="row">
    <input type="checkbox" id="clearPush" checked>
    <label for="clearPush">Очистить текущую Push-очередь перед загрузкой</label>
  </div>

  <button id="btn" onclick="runSync()">Загрузить стадии</button>
  <div id="results"></div>

  <script>
    async function runSync() {
      const raw = document.getElementById('csv').value.trim();
      const clearPush = document.getElementById('clearPush').checked;
      const btn = document.getElementById('btn');
      const out = document.getElementById('results');
      if (!raw) return;

      const lines = raw.split('\\n').map(l => l.trim()).filter(Boolean);
      const leads = lines.map(line => {
        // Support both comma and tab separators
        const parts = line.split(/\\t|,/).map(p => p.trim());
        return {
          leadId: parts[0],
          stage: parts[1] || null,
          responsibleUser: parts[2] || null,
          pipeline: parts[3] || null,
        };
      }).filter(l => l.leadId);

      if (leads.length === 0) { out.style.display = 'block'; out.textContent = 'Нет данных для загрузки.'; return; }

      btn.disabled = true;
      btn.textContent = \`Загружаю \${leads.length} лидов...\`;
      out.style.display = 'block';
      out.textContent = \`Отправляю \${leads.length} лидов...\\n\`;

      try {
        const res = await fetch('/api/admin/sync-stages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ leads, clearPush }),
        });
        const data = await res.json();
        let text = \`\\n\`;
        text += \`<span class="info">✓ Обновлено стадий: \${data.updated}</span>\\n\`;
        text += \`<span class="ok">✓ В whitelist (будут в Push): \${data.whitelisted}</span>\\n\`;
        text += \`<span class="warn">⚠ Вне whitelist (Push заблокирован): \${data.suppressed}</span>\\n\`;
        if (data.cleared !== undefined) text += \`<span class="info">✓ Очищено Push-саджестов: \${data.cleared}</span>\\n\`;
        text += \`\\n\${data.message}\\n\`;
        out.innerHTML = out.textContent + text;
      } catch (e) {
        out.textContent += '\\nОшибка: ' + e.message;
      }

      btn.disabled = false;
      btn.textContent = 'Загрузить стадии';
    }
  </script>
</body>
</html>`);
});

// ── POST: bulk stage update ─────────────────────────────────────────────────
router.post("/admin/sync-stages", async (req, res) => {
  const { leads, clearPush } = req.body as {
    leads: Array<{
      leadId: string;
      stage: string | null;
      responsibleUser: string | null;
      pipeline: string | null;
    }>;
    clearPush?: boolean;
  };

  if (!Array.isArray(leads) || leads.length === 0) {
    return void res.status(400).json({ error: "leads array required" });
  }

  let updated = 0;
  let whitelisted = 0;
  let suppressed = 0;
  let cleared = 0;

  // 1. Optionally clear the existing push queue
  if (clearPush) {
    const deleted = await db
      .update(pendingSuggestionsTable)
      .set({ status: "skipped" })
      .where(eq(pendingSuggestionsTable.status, "pending"));
    cleared = (deleted as unknown as { rowCount?: number }).rowCount ?? 0;
  }

  // 2. Upsert each lead's stage into leads_sync
  for (const lead of leads) {
    const leadId = String(lead.leadId ?? "").trim();
    if (!leadId) continue;

    const stage = lead.stage?.trim() || null;
    const responsibleUser = lead.responsibleUser?.trim() || null;
    const pipeline = lead.pipeline?.trim() || null;

    try {
      await db
        .insert(leadsSyncTable)
        .values({
          leadId,
          ...(responsibleUser ? { responsibleUser } : {}),
          ...(stage ? { leadStage: stage } : {}),
          ...(pipeline ? { pipeline } : {}),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: leadsSyncTable.leadId,
          set: {
            ...(stage ? { leadStage: stage } : {}),
            ...(pipeline ? { pipeline } : {}),
            ...(responsibleUser ? { responsibleUser } : {}),
            updatedAt: new Date(),
          },
        });

      updated++;

      // If stage is in whitelist → mark for scheduling; if outside → suppress
      if (isStageWhitelisted(stage)) {
        whitelisted++;
        // Reset nextFollowupAt so scheduler picks it up
        await db
          .update(leadsSyncTable)
          .set({ nextFollowupAt: new Date(), followupLevel: 0 })
          .where(eq(leadsSyncTable.leadId, leadId));
      } else {
        suppressed++;
        await db
          .update(leadsSyncTable)
          .set({ nextFollowupAt: null })
          .where(eq(leadsSyncTable.leadId, leadId));
      }
    } catch (err) {
      // continue on individual errors
    }
  }

  res.json({
    ok: true,
    updated,
    whitelisted,
    suppressed,
    cleared: clearPush ? cleared : undefined,
    message: `Готово. ${whitelisted} лидов встанут в Push-очередь, ${suppressed} пропущено (не в whitelist).`,
  });
});

export default router;
