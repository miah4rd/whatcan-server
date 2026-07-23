import { Router } from "express";
import { db, leadsSyncTable, pendingSuggestionsTable, leadCrmTasksTable } from "@workspace/db";
import { eq, and, inArray, isNotNull, gte, or, like, sql, isNull } from "drizzle-orm";
import { generateSuggestion, queueSuggestion } from "../amocrm-webhook";
import { shouldSuppressPush, isStageWhitelisted } from "../../lib/stage-routing";
import { parseDialogContent, formatDialogForAI } from "../../lib/dialog-parser";
import { updateLeadStatus } from "../../lib/amo-client.js";

const router = Router();

// ── Admin HTML page ────────────────────────────────────────────────────────
router.get("/admin/import", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bulk Lead Import — Unicorn Copilot</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0f1117; color: #e0e0e0; padding: 32px; max-width: 800px; margin: 0 auto; }
    h1 { font-size: 22px; margin-bottom: 6px; color: #fff; }
    .sub { font-size: 13px; color: #888; margin-bottom: 24px; }
    label { font-size: 13px; color: #aaa; display: block; margin-bottom: 6px; }
    textarea { width: 100%; height: 220px; background: #1a1d26; border: 1px solid #333; border-radius: 8px; color: #e0e0e0; font-family: monospace; font-size: 13px; padding: 12px; resize: vertical; }
    .hint { font-size: 12px; color: #666; margin-top: 6px; margin-bottom: 20px; }
    .row { display: flex; gap: 12px; margin-bottom: 16px; }
    input[type=text] { flex: 1; background: #1a1d26; border: 1px solid #333; border-radius: 6px; color: #e0e0e0; font-size: 13px; padding: 8px 12px; }
    button { background: #6c47ff; color: #fff; border: none; border-radius: 6px; padding: 10px 24px; font-size: 14px; font-weight: 600; cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    #results { margin-top: 24px; background: #1a1d26; border: 1px solid #333; border-radius: 8px; padding: 16px; display: none; font-family: monospace; font-size: 13px; line-height: 1.6; white-space: pre-wrap; max-height: 400px; overflow-y: auto; }
    .ok { color: #4ade80; }
    .err { color: #f87171; }
    .skip { color: #facc15; }
    .stage-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; }
    .tag { background: #1e2130; border: 1px solid #333; border-radius: 4px; padding: 4px 10px; font-size: 12px; color: #aaa; cursor: pointer; user-select: none; }
    .tag:hover { border-color: #6c47ff; color: #fff; }
  </style>
</head>
<body>
  <h1>📥 Bulk Lead Import</h1>
  <p class="sub">Load existing AmoCRM leads into the Copilot without waiting for webhooks.</p>

  <div class="stage-tags">
    <span style="font-size:12px;color:#666;align-self:center;margin-right:4px">Pipeline stages:</span>
    <span class="tag">Contact Established</span>
    <span class="tag">Mailing</span>
    <span class="tag">Long-Term Cycle</span>
    <span class="tag">Needs Assessed</span>
    <span class="tag">Options Sent</span>
    <span class="tag">Zoom Call Scheduled</span>
    <span class="tag">Viewing Scheduled</span>
    <span class="tag">Feedback / Handling Objections</span>
  </div>

  <div class="row">
    <input type="text" id="broker" placeholder="Default responsible user (e.g. Robert)" value="Robert">
  </div>

  <label>Paste lead IDs — one per line. Optionally: <code>leadId, responsibleUser, lead notes</code></label>
  <textarea id="csv" placeholder="22420811
22381657, Robert, Budget $200K, interested in Canggu
21339263
22381645, Yudi, Looking for investment villa"></textarea>
  <p class="hint">Fields: leadId (required), responsibleUser (optional — falls back to default above), notes (optional)</p>

  <button id="btn" onclick="runImport()">Import Leads</button>
  <div id="results"></div>

  <script>
    async function runImport() {
      const raw = document.getElementById('csv').value.trim();
      const defaultBroker = document.getElementById('broker').value.trim() || 'Robert';
      const btn = document.getElementById('btn');
      const out = document.getElementById('results');
      if (!raw) return;

      const lines = raw.split('\\n').map(l => l.trim()).filter(Boolean);
      const leads = lines.map(line => {
        const parts = line.split(',').map(p => p.trim());
        return {
          leadId: parts[0],
          responsibleUser: parts[1] || defaultBroker,
          leadNotes: parts.slice(2).join(', ') || null,
        };
      }).filter(l => l.leadId);

      btn.disabled = true;
      btn.textContent = \`Importing \${leads.length} leads...\`;
      out.style.display = 'block';
      out.textContent = \`Starting import of \${leads.length} leads...\\n\`;

      try {
        const res = await fetch('/api/admin/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ leads }),
        });
        const data = await res.json();

        let text = \`\\nDone: \${data.imported} imported, \${data.skipped} skipped, \${data.errors?.length ?? 0} errors\\n\\n\`;
        for (const r of (data.results ?? [])) {
          const icon = r.status === 'ok' ? '✓' : r.status === 'skipped' ? '⚠' : '✗';
          const cls = r.status === 'ok' ? 'ok' : r.status === 'skipped' ? 'skip' : 'err';
          text += \`<span class="\${cls}">\${icon} \${r.leadId} (\${r.responsibleUser}) — \${r.message}</span>\\n\`;
        }
        out.innerHTML = out.textContent + text;
      } catch (e) {
        out.textContent += '\\nNetwork error: ' + e.message;
      }

      btn.disabled = false;
      btn.textContent = 'Import Leads';
    }
  </script>
</body>
</html>`);
});

// ── Bulk import POST endpoint ──────────────────────────────────────────────
router.post("/admin/import", async (req, res) => {
  const { leads } = req.body as {
    leads: Array<{
      leadId: string;
      responsibleUser?: string | null;
      leadNotes?: string | null;
      leadStage?: string | null;
    }>;
  };

  if (!Array.isArray(leads) || leads.length === 0) {
    return void res.status(400).json({ error: "leads array required" });
  }

  const results: Array<{
    leadId: string;
    responsibleUser: string;
    status: "ok" | "skipped" | "error";
    message: string;
  }> = [];

  let imported = 0;
  let skipped = 0;

  for (const lead of leads) {
    const leadId = String(lead.leadId ?? "").trim();
    const responsibleUser = lead.responsibleUser?.trim() || "Robert";
    const leadNotes = lead.leadNotes?.trim() || null;
    const leadStage = lead.leadStage?.trim() || null;

    if (!leadId) continue;

    try {
      const [existing] = await db
        .select({ id: leadsSyncTable.leadId })
        .from(leadsSyncTable)
        .where(eq(leadsSyncTable.leadId, leadId))
        .limit(1);

      const [existingPending] = await db
        .select({ id: pendingSuggestionsTable.id })
        .from(pendingSuggestionsTable)
        .where(eq(pendingSuggestionsTable.leadId, leadId))
        .limit(1);

      if (existingPending) {
        skipped++;
        results.push({ leadId, responsibleUser, status: "skipped", message: "already has pending suggestion" });
        continue;
      }

      if (!existing) {
        await db.insert(leadsSyncTable).values({
          leadId,
          responsibleUser,
          content: "",
          leadNotes,
          leadStage: leadStage ?? undefined,
          lastMessageAt: null,
          lastMessageFrom: null,
          lastOurMessageAt: null,
          followupLevel: 0,
          nextFollowupAt: null,
        });
      } else {
        const updateFields: Record<string, unknown> = { responsibleUser };
        if (leadNotes) updateFields.leadNotes = leadNotes;
        if (leadStage) updateFields.leadStage = leadStage;
        await db
          .update(leadsSyncTable)
          .set(updateFields)
          .where(eq(leadsSyncTable.leadId, leadId));
      }

      const { text, attachments } = await generateSuggestion({
        leadId,
        responsibleUser,
        kind: "push",
        lastLeadMessage: "",
        contentSnippet: "",
        leadNotes,
        isFirstContact: true,
      });

      if (text) {
        await queueSuggestion({ leadId, responsibleUser, kind: "push", text, attachments });
        imported++;
        results.push({ leadId, responsibleUser, status: "ok", message: "queued first-contact suggestion" });
      } else {
        results.push({ leadId, responsibleUser, status: "error", message: "AI returned empty response" });
      }

      // Small delay to avoid rate-limiting OpenAI on large batches
      await new Promise((r) => setTimeout(r, 300));
    } catch (err) {
      results.push({ leadId, responsibleUser, status: "error", message: String((err as Error).message ?? err) });
    }
  }

  res.json({ imported, skipped, errors: results.filter((r) => r.status === "error"), results });
});

// ── One-time push refresh ──────────────────────────────────────────────────
// Clears all pending push suggestions and resets lead followup timers so the
// scheduler regenerates them with the new stage-aware logic.
router.post("/admin/reset-push", async (_req, res) => {
  try {
    const pending = await db
      .select({
        id: pendingSuggestionsTable.id,
        leadId: pendingSuggestionsTable.leadId,
        leadStage: leadsSyncTable.leadStage,
      })
      .from(pendingSuggestionsTable)
      .leftJoin(leadsSyncTable, eq(pendingSuggestionsTable.leadId, leadsSyncTable.leadId))
      .where(and(eq(pendingSuggestionsTable.status, "pending"), eq(pendingSuggestionsTable.kind, "push")));

    const suppressedLeadIds = new Set<string>();
    const activeLeadIds = new Set<string>();
    for (const row of pending) {
      const stage = row.leadStage ?? "";
      if (stage && shouldSuppressPush(stage)) {
        suppressedLeadIds.add(row.leadId);
      } else {
        activeLeadIds.add(row.leadId);
      }
    }

    const allIds = pending.map((r) => r.id);
    if (allIds.length > 0) {
      await db.delete(pendingSuggestionsTable).where(inArray(pendingSuggestionsTable.id, allIds));
    }

    for (const leadId of suppressedLeadIds) {
      await db.update(leadsSyncTable).set({ nextFollowupAt: null }).where(eq(leadsSyncTable.leadId, leadId));
    }

    // Set nextFollowupAt = null for active leads — amo-sync will repopulate
    // only the leads whose AmoCRM task is actually due today.
    for (const leadId of activeLeadIds) {
      await db.update(leadsSyncTable).set({ nextFollowupAt: null, followupLevel: 0 }).where(eq(leadsSyncTable.leadId, leadId));
    }

    res.json({
      ok: true,
      deleted: allIds.length,
      suppressedLeads: suppressedLeadIds.size,
      activeLeads: activeLeadIds.size,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

/**
 * POST /api/admin/reset-schedule
 * Clears nextFollowupAt for ALL leads so amo-sync can repopulate based on
 * actual AmoCRM task due dates. Use this after deploying webhook scheduling fixes.
 */
router.post("/admin/reset-schedule", async (_req, res) => {
  try {
    // 1. Delete all pending push suggestions
    const deleted = await db
      .delete(pendingSuggestionsTable)
      .where(and(eq(pendingSuggestionsTable.status, "pending"), eq(pendingSuggestionsTable.kind, "push")))
      .returning({ id: pendingSuggestionsTable.id });

    // 2. Clear nextFollowupAt for ALL leads — amo-sync will repopulate only
    //    leads whose AmoCRM task is actually due today.
    const cleared = await db
      .update(leadsSyncTable)
      .set({ nextFollowupAt: null })
      .where(isNotNull(leadsSyncTable.nextFollowupAt))
      .returning({ leadId: leadsSyncTable.leadId });

    res.json({ ok: true, deletedSuggestions: deleted.length, clearedLeads: cleared.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

/**
 * POST /api/admin/bulk-sync-stages
 * Updates stage in amoCRM for every lead in leads_sync that has a numeric stageId.
 * Rate-limited to 3 req/s to stay within amoCRM limits.
 */
router.post("/admin/bulk-sync-stages", async (req, res) => {
  try {
    const leads = await db
      .select({
        leadId: leadsSyncTable.leadId,
        leadStage: leadsSyncTable.leadStage,
        leadStageId: leadsSyncTable.leadStageId,
      })
      .from(leadsSyncTable)
      .where(isNotNull(leadsSyncTable.leadStageId));

    let ok = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const lead of leads) {
      if (!lead.leadStageId) continue;
      try {
        const success = await updateLeadStatus(lead.leadId, Number(lead.leadStageId));
        if (success) { ok++; } else { failed++; errors.push(`${lead.leadId}:failed`); }
        await new Promise(r => setTimeout(r, 350));
      } catch (e) {
        failed++;
        errors.push(`${lead.leadId}:${String(e)}`);
      }
    }

    req.log.info({ total: leads.length, ok, failed }, "bulk-sync-stages completed");
    res.json({ ok: true, total: leads.length, sent: ok, failed, errors: errors.slice(0, 20) });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

router.delete("/admin/tasks", async (req, res) => {
  try {
    const { leadId } = req.query as Record<string, string>;
    const deleted = leadId
      ? await db.delete(leadCrmTasksTable).where(eq(leadCrmTasksTable.leadId, leadId)).returning({ id: leadCrmTasksTable.id })
      : await db.delete(leadCrmTasksTable).returning({ id: leadCrmTasksTable.id });
    req.log.info({ deleted: deleted.length, leadId: leadId ?? "all" }, "admin: tasks cleared");
    res.json({ ok: true, deleted: deleted.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

router.post("/admin/reset-live", async (_req, res) => {
  try {
    const deleted = await db
      .delete(pendingSuggestionsTable)
      .where(and(eq(pendingSuggestionsTable.status, "pending"), eq(pendingSuggestionsTable.kind, "live")))
      .returning({ id: pendingSuggestionsTable.id });
    res.json({ ok: true, deleted: deleted.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// Regenerate live suggestions for leads that replied but have no pending live suggestion
router.post("/admin/regen-live", async (_req, res) => {
  try {
    const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000); // 60 days
    const candidates = await db
      .select({
        leadId: leadsSyncTable.leadId,
        responsibleUser: leadsSyncTable.responsibleUser,
        content: leadsSyncTable.content,
        leadNotes: leadsSyncTable.leadNotes,
        leadStage: leadsSyncTable.leadStage,
        pipeline: leadsSyncTable.pipeline,
      })
      .from(leadsSyncTable)
      .where(
        and(
          eq(leadsSyncTable.lastMessageFrom, "lead"),
          isNotNull(leadsSyncTable.lastMessageAt),
          gte(leadsSyncTable.lastMessageAt, since),
        ),
      );

    // Find which leads already have a pending live suggestion
    const allLeadIds = candidates.map((c) => c.leadId);
    const existing =
      allLeadIds.length > 0
        ? await db
            .select({ leadId: pendingSuggestionsTable.leadId })
            .from(pendingSuggestionsTable)
            .where(
              and(
                inArray(pendingSuggestionsTable.leadId, allLeadIds),
                eq(pendingSuggestionsTable.status, "pending"),
                eq(pendingSuggestionsTable.kind, "live"),
              ),
            )
        : [];
    const alreadyHas = new Set(existing.map((r) => r.leadId));

    const toRegen = candidates.filter((c) => !alreadyHas.has(c.leadId) && isStageWhitelisted(c.leadStage ?? null));

    let queued = 0;
    let failed = 0;
    for (const lead of toRegen) {
      try {
        const parsed = lead.content ? parseDialogContent(lead.content) : null;
        const lastLeadMessage = parsed?.lastLeadMessage?.text ?? "";
        const contentSnippet = parsed ? formatDialogForAI(parsed.messages) : "";

        const { text, attachments } = await generateSuggestion({
          leadId: lead.leadId,
          responsibleUser: lead.responsibleUser ?? null,
          kind: "live",
          lastLeadMessage,
          contentSnippet,
          leadNotes: lead.leadNotes ?? null,
          leadStage: lead.leadStage ?? null,
          pipeline: lead.pipeline,
        });

        await db.insert(pendingSuggestionsTable).values({
          leadId: lead.leadId,
          responsibleUser: lead.responsibleUser ?? null,
          kind: "live",
          followupLevel: null,
          suggestionText: text,
          status: "pending",
          attachments,
        });
        queued++;
      } catch {
        failed++;
      }
    }

    res.json({ ok: true, queued, failed, skipped: alreadyHas.size });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

/**
 * POST /api/admin/bulk-schedule
 * Sets next_followup_at = NOW() for a list of lead IDs so the scheduler
 * picks them up on the next tick and generates push suggestions.
 * Skips leads in suppressed stages.
 *
 * Body: { leadIds: string[] }
 */
router.post("/admin/bulk-schedule", async (req, res) => {
  const { leadIds } = req.body as { leadIds?: string[] };
  if (!Array.isArray(leadIds) || leadIds.length === 0) {
    return void res.status(400).json({ error: "leadIds array required" });
  }

  let scheduled = 0;
  let suppressed = 0;
  let alreadyHasPending = 0;
  let notFound = 0;

  const now = new Date();

  for (const rawId of leadIds) {
    const leadId = String(rawId).trim();
    if (!leadId) continue;

    try {
      const [lead] = await db
        .select({ leadId: leadsSyncTable.leadId, leadStage: leadsSyncTable.leadStage, nextFollowupAt: leadsSyncTable.nextFollowupAt })
        .from(leadsSyncTable)
        .where(eq(leadsSyncTable.leadId, leadId))
        .limit(1);

      if (!lead) { notFound++; continue; }

      if (lead.leadStage && shouldSuppressPush(lead.leadStage)) { suppressed++; continue; }

      const [existingPending] = await db
        .select({ id: pendingSuggestionsTable.id })
        .from(pendingSuggestionsTable)
        .where(and(eq(pendingSuggestionsTable.leadId, leadId), eq(pendingSuggestionsTable.status, "pending")))
        .limit(1);

      if (existingPending) { alreadyHasPending++; continue; }

      await db
        .update(leadsSyncTable)
        .set({ nextFollowupAt: now })
        .where(eq(leadsSyncTable.leadId, leadId));

      scheduled++;
    } catch {
      // continue
    }
  }

  res.json({ ok: true, scheduled, suppressed, alreadyHasPending, notFound, total: leadIds.length });
});

/**
 * POST /admin/bot-include
 * Re-include a bot-excluded lead: clear botExcluded flag and re-queue for push scheduler.
 * Body: { leadId: string }
 */
router.post("/admin/bot-include", async (req, res) => {
  const { leadId } = req.body as { leadId?: string };
  if (!leadId) {
    return void res.status(400).json({ error: "leadId required" });
  }
  const id = String(leadId).trim();
  const now = new Date();

  await db
    .update(leadsSyncTable)
    .set({ botExcluded: false, nextFollowupAt: now })
    .where(eq(leadsSyncTable.leadId, id));

  await db
    .update(pendingSuggestionsTable)
    .set({ status: "pending" })
    .where(
      and(
        eq(pendingSuggestionsTable.leadId, id),
        eq(pendingSuggestionsTable.status, "skipped"),
      ),
    );

  res.json({ ok: true, leadId: id });
});

/**
 * POST /api/admin/fix-wrong-suggestions
 *
 * One-time cleanup: finds all pending push suggestions where the text contains
 * Final Follow-up keywords ("file warm", "close your file", "put it to rest")
 * but the lead is NOT in a FINAL stage — i.e. suggestions generated by the
 * old buggy qualStepIndexForStage function that indexed into the wrong position.
 *
 * Deletes those wrong suggestions and sets nextFollowupAt=NOW() so the
 * scheduler regenerates them with the correct qualScriptIndexForStage logic.
 */
router.post("/admin/fix-wrong-suggestions", async (req, res) => {
  try {
    // Find all pending push suggestions with Final Follow-up text
    const wrongSuggestions = await db
      .select({
        id: pendingSuggestionsTable.id,
        leadId: pendingSuggestionsTable.leadId,
        suggestionText: pendingSuggestionsTable.suggestionText,
      })
      .from(pendingSuggestionsTable)
      .where(
        and(
          eq(pendingSuggestionsTable.status, "pending"),
          eq(pendingSuggestionsTable.kind, "push"),
          or(
            like(pendingSuggestionsTable.suggestionText, "%file warm%"),
            like(pendingSuggestionsTable.suggestionText, "%close your file%"),
            like(pendingSuggestionsTable.suggestionText, "%put it to rest%"),
            like(pendingSuggestionsTable.suggestionText, "%keep your file open%"),
          ),
        ),
      );

    if (wrongSuggestions.length === 0) {
      return void res.json({ ok: true, deleted: 0, requeued: 0, message: "No wrong suggestions found — all clean." });
    }

    // For each wrong suggestion: check if lead is in FINAL stage (those are actually correct)
    const leadIds = wrongSuggestions.map((s) => s.leadId);
    const leads = await db
      .select({ leadId: leadsSyncTable.leadId, leadStage: leadsSyncTable.leadStage })
      .from(leadsSyncTable)
      .where(inArray(leadsSyncTable.leadId, leadIds));

    const stageMap = new Map(leads.map((l) => [l.leadId, l.leadStage ?? ""]));

    const toDelete = wrongSuggestions.filter((s) => {
      const stage = stageMap.get(s.leadId) ?? "";
      return !stage.toLowerCase().includes("final");
    });

    if (toDelete.length === 0) {
      return void res.json({ ok: true, deleted: 0, requeued: 0, message: "All matching suggestions are for FINAL stage leads — correct, nothing to fix." });
    }

    const toDeleteIds = toDelete.map((s) => s.id);
    const toDeleteLeadIds = [...new Set(toDelete.map((s) => s.leadId))];

    // Delete wrong suggestions
    await db
      .delete(pendingSuggestionsTable)
      .where(inArray(pendingSuggestionsTable.id, toDeleteIds));

    // Set nextFollowupAt=NOW() for affected leads so scheduler picks them up
    const now = new Date();
    await db
      .update(leadsSyncTable)
      .set({ nextFollowupAt: now })
      .where(inArray(leadsSyncTable.leadId, toDeleteLeadIds));

    req.log.info({ deleted: toDelete.length, requeued: toDeleteLeadIds.length }, "fix-wrong-suggestions: cleanup complete");

    res.json({
      ok: true,
      deleted: toDelete.length,
      requeued: toDeleteLeadIds.length,
      affectedLeads: toDelete.map((s) => ({ leadId: s.leadId, stage: stageMap.get(s.leadId), preview: s.suggestionText.slice(0, 60) })),
    });
  } catch (err) {
    req.log.error({ err }, "fix-wrong-suggestions error");
    res.status(500).json({ ok: false, error: String(err) });
  }
});

export default router;
