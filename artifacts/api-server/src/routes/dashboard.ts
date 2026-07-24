import { Router } from "express";
import { db, pendingSuggestionsTable, aiSuggestionsTable, sentMessagesTable, leadsSyncTable } from "@workspace/db";
import { desc, sql, eq, inArray } from "drizzle-orm";
import { getKnowledgeBase, setKnowledgeBase } from "../lib/knowledge-base";
import { chatCompletion } from "../lib/ai-client";
import { parseDialogContent, formatDialogForAI } from "../lib/dialog-parser";
import { sanitizeSuggestion, AVOID_PHRASES_REMINDER } from "../lib/sanitize-suggestion";

const router = Router();

router.get("/dashboard", async (req, res) => {
  const tab = (req.query["tab"] as string | undefined) ?? "suggestions";

  const [pending, recent, sent, kb] = await Promise.all([
    db.select().from(pendingSuggestionsTable).orderBy(desc(pendingSuggestionsTable.createdAt)).limit(50),
    db.select().from(aiSuggestionsTable).orderBy(desc(aiSuggestionsTable.createdAt)).limit(50),
    db.select().from(sentMessagesTable).orderBy(desc(sentMessagesTable.createdAt)).limit(20),
    getKnowledgeBase(),
  ]);

  const tabNav = (id: string, label: string) =>
    `<a href="/api/dashboard?tab=${id}" class="tab-link${tab === id ? " active" : ""}">${label}</a>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CRM Copilot — Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f1923; color: #e6e8ee; min-height: 100vh; }
  .topbar { background: #1a2636; border-bottom: 1px solid #2a3a4e; padding: 14px 24px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .topbar .logo { width: 32px; height: 32px; background: #2196f3; border-radius: 8px; display: grid; place-items: center; font-weight: 900; font-size: 16px; color: #fff; flex-shrink: 0; }
  .topbar h1 { font-size: 16px; font-weight: 700; color: #fff; }
  .topbar .sub { font-size: 12px; color: #8a96a8; margin-left: auto; }
  .topbar .refresh { background: #1e3a5f; border: 1px solid #2a4a6e; color: #90caf9; padding: 6px 14px; border-radius: 6px; font-size: 12px; font-weight: 700; cursor: pointer; text-decoration: none; }
  .topbar .refresh:hover { background: #2196f3; color: #fff; }
  .tabs { display: flex; gap: 4px; padding: 16px 24px 0; border-bottom: 1px solid #2a3a4e; background: #0f1923; }
  .tab-link { padding: 8px 18px; border-radius: 8px 8px 0 0; font-size: 13px; font-weight: 600; color: #8a96a8; text-decoration: none; border: 1px solid transparent; border-bottom: none; transition: all .15s; }
  .tab-link:hover { color: #e6e8ee; background: #1a2636; }
  .tab-link.active { color: #fff; background: #1a2636; border-color: #2a3a4e; border-bottom-color: #1a2636; margin-bottom: -1px; }
  .tab-content { display: none; }
  .tab-content.active { display: block; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; padding: 20px 24px 0; }
  .stat { background: #1a2636; border: 1px solid #2a3a4e; border-radius: 10px; padding: 16px 20px; }
  .stat .num { font-size: 28px; font-weight: 800; color: #fff; }
  .stat .lbl { font-size: 11px; color: #8a96a8; text-transform: uppercase; letter-spacing: .1em; margin-top: 4px; }
  .stat.blue .num { color: #2196f3; }
  .stat.green .num { color: #34d399; }
  .stat.yellow .num { color: #fbbf24; }
  .stat.red .num { color: #f87171; }
  .section { padding: 20px 24px; }
  .section h2 { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: .1em; color: #8a96a8; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; background: #1a2636; border-radius: 10px; overflow: hidden; border: 1px solid #2a3a4e; }
  th { text-align: left; padding: 10px 14px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: #8a96a8; border-bottom: 1px solid #2a3a4e; background: #1e2f42; }
  td { padding: 10px 14px; font-size: 13px; border-bottom: 1px solid #1e2d3d; vertical-align: top; max-width: 320px; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: rgba(33,150,243,.04); }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; }
  .badge.pending { background: rgba(251,191,36,.15); color: #fcd34d; }
  .badge.approved { background: rgba(52,211,153,.15); color: #34d399; }
  .badge.skipped { background: rgba(148,163,184,.1); color: #94a3b8; }
  .badge.edited { background: rgba(96,165,250,.15); color: #60a5fa; }
  .badge.live { background: rgba(52,211,153,.12); color: #34d399; border: 1px solid rgba(52,211,153,.25); }
  .badge.push { background: rgba(251,191,36,.12); color: #fbbf24; border: 1px solid rgba(251,191,36,.25); }
  .msg { color: #cfd5e3; line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .time { color: #8a96a8; font-size: 12px; white-space: nowrap; }
  .lead-id { font-family: monospace; font-size: 12px; color: #90caf9; }
  .broker { font-weight: 600; color: #e6e8ee; }
  .empty { text-align: center; padding: 40px; color: #8a96a8; font-size: 13px; }
  /* KB styles */
  .kb-wrap { padding: 20px 24px; }
  .kb-wrap p { font-size: 13px; color: #8a96a8; margin-bottom: 14px; line-height: 1.6; }
  .kb-wrap textarea { width: 100%; min-height: 520px; background: #1a2636; border: 1px solid #2a3a4e; border-radius: 10px; color: #e6e8ee; font-family: "SF Mono", "Fira Code", monospace; font-size: 13px; line-height: 1.7; padding: 16px; resize: vertical; outline: none; }
  .kb-wrap textarea:focus { border-color: #2196f3; }
  .kb-actions { display: flex; gap: 10px; margin-top: 14px; align-items: center; }
  .btn-save { background: #2196f3; border: none; color: #fff; padding: 9px 22px; border-radius: 8px; font-size: 13px; font-weight: 700; cursor: pointer; }
  .btn-save:hover { background: #1976d2; }
  .btn-reset { background: transparent; border: 1px solid #2a3a4e; color: #8a96a8; padding: 9px 18px; border-radius: 8px; font-size: 13px; cursor: pointer; }
  .btn-reset:hover { border-color: #f87171; color: #f87171; }
  .kb-hint { font-size: 12px; color: #8a96a8; }
  .saved-msg { display: none; font-size: 12px; color: #34d399; font-weight: 600; }
  @media (max-width: 700px) { .stats { grid-template-columns: 1fr 1fr; } }
</style>
</head>
<body>
<div class="topbar">
  <div class="logo">⚡</div>
  <h1>CRM Copilot</h1>
  <span class="sub">Auto-refreshes every 30s on Suggestions tab</span>
  <a class="refresh" href="/api/dashboard?tab=${tab}">↻ Refresh</a>
  <form method="POST" action="/api/dashboard/clear" onsubmit="return confirm('Clear ALL suggestions data? Knowledge Base is kept.')">
    <button type="submit" style="background:#7f1d1d;border:1px solid #991b1b;color:#fca5a5;padding:6px 14px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer">🗑 Clear All</button>
  </form>
</div>

<div class="tabs">
  ${tabNav("suggestions", "📥 Suggestions")}
  ${tabNav("sent", "✅ Sent")}
  ${tabNav("kb", "🧠 Knowledge Base")}
</div>

<!-- SUGGESTIONS TAB -->
<div class="tab-content${tab === "suggestions" ? " active" : ""}">
  <div class="stats">
    <div class="stat blue"><div class="num">${pending.filter(r => r.status === "pending").length}</div><div class="lbl">Pending</div></div>
    <div class="stat green"><div class="num">${pending.filter(r => r.status === "approved" || r.status === "edited").length}</div><div class="lbl">Approved</div></div>
    <div class="stat yellow"><div class="num">${pending.filter(r => r.status === "skipped").length}</div><div class="lbl">Skipped</div></div>
    <div class="stat red"><div class="num">${recent.length}</div><div class="lbl">Total Generated</div></div>
  </div>
  <div class="section">
    <h2>Incoming Requests & AI Suggestions</h2>
    ${pending.length === 0 ? '<div class="empty">No requests yet. Trigger a webhook from Ф5 to see data here.</div>' : `
    <table>
      <thead><tr><th>Lead ID</th><th>Broker</th><th>Type</th><th>Status</th><th>Suggested Message</th><th>Time</th></tr></thead>
      <tbody>
        ${pending.map(r => `
        <tr>
          <td class="lead-id">#${r.leadId}</td>
          <td class="broker">${r.responsibleUser ?? "—"}</td>
          <td><span class="badge ${r.kind}">${r.kind.toUpperCase()}</span></td>
          <td><span class="badge ${r.status}">${r.status}</span></td>
          <td><div class="msg">${escHtml(r.suggestionText)}</div></td>
          <td class="time">${formatTime(r.createdAt)}</td>
        </tr>`).join("")}
      </tbody>
    </table>`}
  </div>
</div>

<!-- SENT TAB -->
<div class="tab-content${tab === "sent" ? " active" : ""}">
  <div class="section">
    <h2>Sent Messages</h2>
    ${sent.length === 0 ? '<div class="empty">No approved messages yet.</div>' : `
    <table>
      <thead><tr><th>Lead ID</th><th>Broker</th><th>Message</th><th>Webhook</th><th>Time</th></tr></thead>
      <tbody>
        ${sent.map(r => `
        <tr>
          <td class="lead-id">#${r.leadId}</td>
          <td class="broker">${r.responsibleUser ?? "—"}</td>
          <td><div class="msg">${escHtml(r.messageText)}</div></td>
          <td><span class="badge ${(r.webhookStatus ?? 0) >= 200 && (r.webhookStatus ?? 0) < 300 ? "approved" : "skipped"}">${r.webhookStatus ?? "—"}</span></td>
          <td class="time">${formatTime(r.createdAt)}</td>
        </tr>`).join("")}
      </tbody>
    </table>`}
  </div>
</div>

<!-- KNOWLEDGE BASE TAB -->
<div class="tab-content${tab === "kb" ? " active" : ""}">
  <div class="kb-wrap">
    <p>
      This text is injected into every AI prompt as a knowledge base. Add scripts, objection-handling playbooks, product info, links — anything the AI should know to generate better replies.<br>
      Changes take effect within 60 seconds (cached). The Google Doc content is pre-loaded as a starting point.
    </p>
    <form id="kbForm" method="POST" action="/api/dashboard/knowledge-base">
      <textarea name="value" id="kbText">${escHtml(kb)}</textarea>
      <div class="kb-actions">
        <button type="submit" class="btn-save">💾 Save Knowledge Base</button>
        <span class="saved-msg" id="savedMsg">✓ Saved!</span>
        <span class="kb-hint">~${Math.round(kb.length / 1000)}k chars · refreshes in the AI within 60s</span>
      </div>
    </form>
  </div>
</div>

<script>
  ${tab === "suggestions" ? "setTimeout(() => location.reload(), 30000);" : ""}

  const form = document.getElementById('kbForm');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const textarea = document.getElementById('kbText');
      const res = await fetch('/api/dashboard/knowledge-base', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: textarea.value })
      });
      if (res.ok) {
        const msg = document.getElementById('savedMsg');
        msg.style.display = 'inline';
        setTimeout(() => { msg.style.display = 'none'; }, 3000);
      }
    });
  }
</script>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

router.post("/dashboard/knowledge-base", async (req, res) => {
  let value: string | undefined;

  if (typeof req.body === "object" && req.body !== null && typeof (req.body as Record<string, unknown>)["value"] === "string") {
    value = (req.body as Record<string, string>)["value"];
  }

  if (!value || value.trim().length === 0) {
    res.status(400).json({ error: "value is required" });
    return;
  }

  await setKnowledgeBase(value.trim());
  res.json({ ok: true, length: value.trim().length });
});

router.post("/dashboard/clear", async (_req, res) => {
  await db.execute(sql`TRUNCATE TABLE pending_suggestions, ai_suggestions, sent_messages RESTART IDENTITY CASCADE`);
  res.redirect("/api/dashboard");
});

// One-shot endpoint: regenerate all (or specific) pending suggestion texts
router.post("/admin/regenerate-suggestions", async (req, res) => {
  const filterLeadIds: string[] | undefined = Array.isArray(req.body?.leadIds)
    ? (req.body.leadIds as string[])
    : undefined;

  const allPending = await db
    .select()
    .from(pendingSuggestionsTable)
    .where(eq(pendingSuggestionsTable.status, "pending"));

  const pending = filterLeadIds
    ? allPending.filter((r) => filterLeadIds.includes(r.leadId))
    : allPending;

  if (pending.length === 0) {
    res.json({ regenerated: 0, message: "No pending suggestions found." });
    return;
  }

  const leadIds = [...new Set(pending.map((r) => r.leadId))];
  const syncRows = await db
    .select({ leadId: leadsSyncTable.leadId, content: leadsSyncTable.content })
    .from(leadsSyncTable)
    .where(inArray(leadsSyncTable.leadId, leadIds));

  const contentMap = new Map(syncRows.map((r) => [r.leadId, r.content ?? ""]));
  const kb = await getKnowledgeBase();

  const systemPrompt =
`You are a senior Bali real estate broker working directly with international clients for Unicorn Property, Bali.

LANGUAGE RULE (absolute, highest priority):
- Detect the language the lead is writing in from their messages.
- Write your ENTIRE response in that exact same language. Zero exceptions.
- English lead → 100% English response. Russian lead → 100% Russian response.
- Never mix languages in a single message. Not even one word.
- If the lead's language is unclear, default to English.

IDENTITY:
- You speak as the broker directly. Never as "the assistant" or "AI".
- You represent yourself as a real person — confident, warm, direct, slightly sales-driven.
- You work with the full Bali market: developer projects, villas, off-plan, land, private sellers.
- You are free of charge for buyers (seller/developer pays commission).

MAIN MISSION:
- Move the conversation forward. Every reply must do at least one of: clarify client intent, add market insight, create reason to continue, push toward call/meeting/viewing/shortlist.
- Do NOT let conversations die with "let me know". Control the next step.

WHATSAPP STYLE RULES (critical):
- Short to medium length. Separate distinct thoughts with a blank line — like a real WhatsApp message.
- FORMATTING: Use line breaks between paragraphs. Each paragraph = 1-2 sentences max. Never write a wall of text as one block.
- Example structure: first thought\n\nsecond thought\n\nquestion or CTA
- Natural, direct, human. No corporate language. No brochure tone.
- Do NOT use bullet points unless needed. No long dashes (—).
- Do NOT overuse: "Got it", "Makes sense", "Just checking in", "Hope you're well".
- Do NOT start with "Good". Do NOT sound like a junior assistant.
- Adapt length to client energy.

SALES PHILOSOPHY:
- Do NOT send random listings without understanding: investment vs lifestyle, budget, timing.
- Ask 1-2 questions max. Position yourself as market filter, not listing dumper.

MESSAGE ENDINGS — strong CTAs:
- "What timing works best for a quick call?"
- "Is this more investment or personal use?"
- "Send me what you're considering and I'll give you my honest view."
- Avoid "let me know" or "happy to help" as sole CTA.

CRITICAL DO-NOT:
- No guaranteed ROI, occupancy, or resale claims.
- Do not attack other agents. Do not sound desperate.
- Return ONLY the message body — plain text, ready to send via WhatsApp.

KNOWLEDGE BASE:
${kb}`;

  let regenerated = 0;
  const errors: string[] = [];

  async function regenOne(row: typeof pending[number]): Promise<void> {
    try {
      const content = contentMap.get(row.leadId) ?? "";
      let lastLeadMsg = "";
      if (content) {
        try {
          const dialog = parseDialogContent(content);
          lastLeadMsg = dialog.lastLeadMessage?.text ?? "";
        } catch { /* ignore */ }
      }

      const parsedDlg = parseDialogContent(content);
      const lastLeadText = lastLeadMsg || parsedDlg.lastLeadMessage?.text || "";
      const lastBrokerText = parsedDlg.lastOurMessage?.text ?? "";

      const userPrompt = row.kind === "live"
        ? `FULL CONVERSATION (oldest → newest):
${formatDialogForAI(parsedDlg.messages)}

SITUATION: The lead just replied. Their latest message:
"${lastLeadText}"

Broker: ${row.responsibleUser ?? "Broker"}

Task: Write the broker's next WhatsApp reply. React directly to what the lead just said. Do NOT repeat questions already asked above. Move the conversation forward. Under 90 words.${AVOID_PHRASES_REMINDER}`
        : `FULL CONVERSATION (oldest → newest):
${formatDialogForAI(parsedDlg.messages)}

SITUATION: The broker's last message was:
"${lastBrokerText.slice(0, 400)}"
The lead has NOT replied. This is follow-up #${row.followupLevel ?? 1}.

Broker: ${row.responsibleUser ?? "Broker"}

Task: Write a follow-up WhatsApp message. The lead went silent — re-engage from a fresh angle. Do NOT repeat what the broker already said. Under 80 words.${AVOID_PHRASES_REMINDER}`;

      const completion = await chatCompletion({
        model: "claude-haiku-4-5-20251001",
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        max_tokens: 220,
      });

      const newText = sanitizeSuggestion(completion.content);
      if (newText) {
        await db
          .update(pendingSuggestionsTable)
          .set({ suggestionText: newText })
          .where(eq(pendingSuggestionsTable.id, row.id));
        regenerated++;
      }
    } catch (err) {
      errors.push(`lead ${row.leadId}: ${String(err)}`);
    }
  }

  // Process in parallel batches of 8 to stay within rate limits
  const BATCH = 8;
  for (let i = 0; i < pending.length; i += BATCH) {
    await Promise.all(pending.slice(i, i + BATCH).map(regenOne));
  }

  res.json({ regenerated, total: pending.length, errors });
});

function escHtml(str: string) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatTime(d: Date | null) {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export default router;
