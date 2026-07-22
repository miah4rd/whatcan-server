/**
 * POST /api/admin/amo-full-import
 *
 * Fetches ALL leads from amoCRM with extended data (contacts, custom fields),
 * upserts them into leads_sync, and returns a sample of the raw API response
 * so we can see exactly what fields are available.
 */
import { Router } from "express";
import { db, leadsSyncTable } from "@workspace/db";
import { amoFetch, getAccessToken } from "../../lib/amo-client";
import { shouldSuppressPush } from "../../lib/stage-routing";
import { logger } from "../../lib/logger";

const router = Router();

// ── Types from amoCRM API ─────────────────────────────────────────────────────

type AmoContact = {
  id: number;
  name: string;
  custom_fields_values?: Array<{
    field_code: string;
    field_name: string;
    values: Array<{ value: string; enum_code?: string }>;
  }> | null;
};

type AmoLead = {
  id: number;
  name: string;
  status_id: number;
  pipeline_id: number;
  responsible_user_id: number;
  created_at: number;
  updated_at: number;
  price: number;
  custom_fields_values?: Array<{
    field_code: string;
    field_name: string;
    values: Array<{ value: string | number; enum_code?: string }>;
  }> | null;
  _embedded?: {
    contacts?: AmoContact[];
    tags?: Array<{ id: number; name: string }>;
  };
};

type AmoStatus = { id: number; name: string };
type AmoPipeline = { id: number; name: string; _embedded: { statuses: AmoStatus[] } };
type AmoUser = { id: number; name: string };

// ── Admin HTML page ───────────────────────────────────────────────────────────

router.get("/admin/amo-full-import", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AmoCRM Full Import</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0f1117; color: #e0e0e0; padding: 32px; max-width: 960px; margin: 0 auto; }
    h1 { font-size: 22px; margin-bottom: 6px; color: #fff; }
    .sub { font-size: 13px; color: #888; margin-bottom: 24px; }
    .row { display: flex; gap: 12px; margin-bottom: 16px; align-items: center; }
    button { background: #6c47ff; color: #fff; border: none; border-radius: 6px; padding: 10px 24px; font-size: 14px; font-weight: 600; cursor: pointer; }
    button.secondary { background: #1e2130; border: 1px solid #333; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    input[type=text] { background: #1a1d26; border: 1px solid #333; border-radius: 6px; color: #e0e0e0; font-size: 13px; padding: 8px 12px; width: 200px; }
    #results { margin-top: 24px; background: #1a1d26; border: 1px solid #333; border-radius: 8px; padding: 16px; display: none; font-family: monospace; font-size: 12px; line-height: 1.6; white-space: pre-wrap; max-height: 600px; overflow-y: auto; }
    .ok { color: #4ade80; }
    .warn { color: #facc15; }
    .err { color: #f87171; }
    .info { color: #60a5fa; }
    .section { margin-top: 24px; padding: 16px; background: #1a1d26; border: 1px solid #333; border-radius: 8px; }
    .section h2 { font-size: 14px; color: #fff; margin-bottom: 12px; }
    label { font-size: 12px; color: #888; }
  </style>
</head>
<body>
  <h1>🔄 AmoCRM Full Import</h1>
  <p class="sub">Fetch all leads from amoCRM API and upsert into leads_sync. Shows what data is available.</p>

  <div class="section">
    <h2>Options</h2>
    <div class="row">
      <label>Pipeline filter (leave empty for all):</label>
      <input type="text" id="pipeline" placeholder="e.g. UNICORN">
    </div>
    <div class="row">
      <label>Max leads (0 = all):</label>
      <input type="text" id="limit" value="0" style="width:80px">
    </div>
    <div class="row">
      <label><input type="checkbox" id="dryRun"> Dry run (don't write to DB — just show what API returns)</label>
    </div>
  </div>

  <div class="row" style="margin-top:16px">
    <button id="btn" onclick="runImport()">▶ Run Import</button>
    <button class="secondary" onclick="runSample()">🔍 Sample 3 leads (raw API response)</button>
  </div>

  <div id="results"></div>

  <script>
    async function runSample() {
      const out = document.getElementById('results');
      out.style.display = 'block';
      out.textContent = 'Fetching sample...';
      try {
        const res = await fetch('/api/admin/amo-full-import/sample');
        const data = await res.json();
        out.textContent = JSON.stringify(data, null, 2);
      } catch (e) {
        out.textContent = 'Error: ' + e.message;
      }
    }

    async function runImport() {
      const btn = document.getElementById('btn');
      const out = document.getElementById('results');
      const pipeline = document.getElementById('pipeline').value.trim();
      const limit = parseInt(document.getElementById('limit').value) || 0;
      const dryRun = document.getElementById('dryRun').checked;

      btn.disabled = true;
      btn.textContent = 'Running...';
      out.style.display = 'block';
      out.textContent = 'Starting import...\\n';

      try {
        const res = await fetch('/api/admin/amo-full-import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pipeline, limit, dryRun }),
        });
        const data = await res.json();

        let text = '';
        text += \`\\n=== SUMMARY ===\\n\`;
        text += \`Total from API:  \${data.total}\\n\`;
        text += \`Upserted to DB:  \${data.upserted}\\n\`;
        text += \`Suppressed:      \${data.suppressed}\\n\`;
        text += \`Errors:          \${data.errors}\\n\`;
        text += \`Dry run:         \${data.dryRun}\\n\`;

        text += \`\\n=== FIELDS AVAILABLE IN API ===\\n\`;
        for (const [field, count] of Object.entries(data.fieldCoverage ?? {})) {
          const pct = Math.round((count as number) / data.total * 100);
          text += \`  \${field.padEnd(30)} \${String(count).padStart(4)} leads (\${pct}%)\\n\`;
        }

        if (data.customFields?.length) {
          text += \`\\n=== CUSTOM FIELDS FOUND ===\\n\`;
          for (const f of data.customFields) {
            text += \`  [\${f.field_code}] \${f.field_name}\\n\`;
          }
        }

        if (data.sampleLead) {
          text += \`\\n=== SAMPLE LEAD (raw) ===\\n\`;
          text += JSON.stringify(data.sampleLead, null, 2) + '\\n';
        }

        out.innerHTML = '<span class="info">' + text.replace(/</g,'&lt;') + '</span>';
      } catch (e) {
        out.textContent += '\\nError: ' + e.message;
      }

      btn.disabled = false;
      btn.textContent = '▶ Run Import';
    }
  </script>
</body>
</html>`);
});

// ── Sample endpoint — returns raw API response for 3 leads ────────────────────

router.get("/admin/amo-full-import/sample", async (req, res) => {
  const token = await getAccessToken();
  if (!token) return void res.status(401).json({ error: "No AmoCRM token" });

  const data = await amoFetch<{ _embedded?: { leads: AmoLead[] } }>(
    "/api/v4/leads?limit=3&with=contacts,leads_custom_fields&order[updated_at]=desc"
  );

  res.json({ leads: data?._embedded?.leads ?? [], note: "Raw API response — 3 most recently updated leads" });
});

// ── Full import POST ──────────────────────────────────────────────────────────

router.post("/admin/amo-full-import", async (req, res) => {
  const { pipeline: pipelineFilter, limit: maxLeads = 0, dryRun = false } = req.body as {
    pipeline?: string;
    limit?: number;
    dryRun?: boolean;
  };

  const token = await getAccessToken();
  if (!token) return void res.status(401).json({ error: "No AmoCRM token available" });

  // Load pipeline → stage name map
  const pipelinesData = await amoFetch<{ _embedded: { pipelines: AmoPipeline[] } }>("/api/v4/leads/pipelines?limit=50");
  const usersData = await amoFetch<{ _embedded: { users: AmoUser[] } }>("/api/v4/users?limit=50");

  const pipelineMap = new Map<number, { stageName: string; pipelineName: string }>();
  const pipelineNames = new Map<number, string>();
  for (const pl of pipelinesData?._embedded?.pipelines ?? []) {
    pipelineNames.set(pl.id, pl.name);
    for (const s of pl._embedded.statuses) {
      pipelineMap.set(s.id, { stageName: s.name, pipelineName: pl.name });
    }
  }

  const userMap = new Map<number, string>();
  for (const u of usersData?._embedded?.users ?? []) {
    userMap.set(u.id, u.name.split(" ")[0] ?? u.name);
  }

  // Track field coverage across all leads
  const fieldCoverage: Record<string, number> = {};
  const customFieldsSeen = new Map<string, string>(); // field_code → field_name

  let total = 0;
  let upserted = 0;
  let suppressed = 0;
  let errors = 0;
  let sampleLead: AmoLead | null = null;

  // Paginate through all leads
  let page = 1;
  let done = false;

  while (!done) {
    const data = await amoFetch<{ _embedded?: { leads: AmoLead[] } }>(
      `/api/v4/leads?limit=250&page=${page}&with=contacts,leads_custom_fields&order[updated_at]=desc`
    );

    const leads = data?._embedded?.leads ?? [];
    if (leads.length === 0) break;

    for (const lead of leads) {
      // Pipeline filter
      if (pipelineFilter) {
        const plName = pipelineNames.get(lead.pipeline_id) ?? "";
        if (!plName.toLowerCase().includes(pipelineFilter.toLowerCase())) continue;
      }

      total++;
      if (maxLeads > 0 && total > maxLeads) { done = true; break; }

      // Track field coverage
      if (lead.name) fieldCoverage["name"] = (fieldCoverage["name"] ?? 0) + 1;
      if (lead.price) fieldCoverage["price (budget)"] = (fieldCoverage["price (budget)"] ?? 0) + 1;
      if (lead.created_at) fieldCoverage["created_at"] = (fieldCoverage["created_at"] ?? 0) + 1;
      if (lead._embedded?.contacts?.length) fieldCoverage["contacts (embedded)"] = (fieldCoverage["contacts (embedded)"] ?? 0) + 1;
      if (lead._embedded?.tags?.length) fieldCoverage["tags"] = (fieldCoverage["tags"] ?? 0) + 1;
      if (lead.custom_fields_values?.length) {
        fieldCoverage["custom_fields"] = (fieldCoverage["custom_fields"] ?? 0) + 1;
        for (const cf of lead.custom_fields_values) {
          customFieldsSeen.set(cf.field_code ?? cf.field_name, cf.field_name);
        }
      }

      // Contact name from embedded contacts
      const contacts = lead._embedded?.contacts ?? [];
      const primaryContact = contacts[0];
      const contactPhone = primaryContact?.custom_fields_values
        ?.find(f => f.field_code === "PHONE")
        ?.values?.[0]?.value ?? null;
      if (contactPhone) fieldCoverage["contact_phone"] = (fieldCoverage["contact_phone"] ?? 0) + 1;
      const contactName = primaryContact?.name ?? null;
      if (contactName) fieldCoverage["contact_name"] = (fieldCoverage["contact_name"] ?? 0) + 1;

      if (total === 1) sampleLead = lead;

      if (dryRun) continue;

      // Upsert into leads_sync
      const stageInfo = pipelineMap.get(lead.status_id);
      if (!stageInfo) continue;

      const responsibleUser = userMap.get(lead.responsible_user_id) ?? null;
      const suppress = shouldSuppressPush(stageInfo.stageName);
      if (suppress) { suppressed++; }

      try {
        const now = new Date();
        await db
          .insert(leadsSyncTable)
          .values({
            leadId: String(lead.id),
            responsibleUser,
            leadStage: stageInfo.stageName,
            leadStageId: String(lead.status_id),
            pipeline: stageInfo.pipelineName,
            updatedAt: now,
            nextFollowupAt: suppress ? null : now,
          })
          .onConflictDoUpdate({
            target: leadsSyncTable.leadId,
            set: {
              leadStage: stageInfo.stageName,
              leadStageId: String(lead.status_id),
              pipeline: stageInfo.pipelineName,
              ...(responsibleUser ? { responsibleUser } : {}),
              updatedAt: now,
            },
          });
        upserted++;
      } catch (err) {
        errors++;
        logger.error({ err, leadId: lead.id }, "amo-full-import: upsert failed");
      }
    }

    if (leads.length < 250) break;
    page++;
    await new Promise(r => setTimeout(r, 200));
  }

  req.log.info({ total, upserted, suppressed, errors, dryRun }, "amo-full-import completed");

  res.json({
    ok: true,
    total,
    upserted,
    suppressed,
    errors,
    dryRun,
    fieldCoverage,
    customFields: Array.from(customFieldsSeen.entries()).map(([code, name]) => ({ field_code: code, field_name: name })),
    sampleLead,
  });
});

export default router;
