import { Router } from "express";

const router = Router();

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
<title>Copilot Inbox</title>
<link rel="manifest" href="data:application/manifest+json,${encodeURIComponent(JSON.stringify({
  name: "Copilot Inbox",
  short_name: "Copilot",
  start_url: "/m",
  display: "standalone",
  background_color: "#0f1320",
  theme_color: "#0f1320",
}))}" />
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body {
    margin: 0; background: #0f1320; color: #e6e8ee;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    min-height: 100vh; padding-bottom: env(safe-area-inset-bottom);
  }
  header {
    position: sticky; top: 0; z-index: 5; background: #141827; border-bottom: 1px solid #2a3146;
    padding: 12px 16px calc(10px + env(safe-area-inset-top)) 16px; padding-top: max(12px, env(safe-area-inset-top));
  }
  .top-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .brand { font-weight: 700; font-size: 15px; display: flex; align-items: center; gap: 6px; }
  .brand .dot { width: 8px; height: 8px; border-radius: 50%; background: #2dd4bf; }
  .broker-chip {
    font-size: 12px; color: #8a93a8; background: #181d2e; border: 1px solid #2a3146;
    border-radius: 20px; padding: 5px 12px; display: flex; align-items: center; gap: 6px;
  }
  .broker-chip b { color: #e6e8ee; }
  .refresh-btn { background: none; border: none; color: #8a93a8; font-size: 18px; padding: 4px 8px; cursor: pointer; }
  .tabs { display: flex; gap: 6px; margin-top: 10px; }
  .tab {
    flex: 1; text-align: center; padding: 9px 4px; border-radius: 10px; font-size: 13px; font-weight: 600;
    background: #181d2e; color: #8a93a8; border: 1px solid #2a3146; position: relative; cursor: pointer;
  }
  .tab.active { background: #2dd4bf; color: #06121a; border-color: #2dd4bf; }
  .tab .count {
    display: inline-block; margin-left: 5px; background: rgba(255,255,255,.18); border-radius: 10px;
    padding: 1px 6px; font-size: 11px;
  }
  .tab.active .count { background: rgba(0,0,0,.15); }
  main { padding: 12px; max-width: 640px; margin: 0 auto; }
  .empty { text-align: center; color: #6b7488; padding: 60px 20px; font-size: 14px; }
  .card {
    background: #181d2e; border: 1px solid #2a3146; border-radius: 12px; padding: 14px;
    margin-bottom: 10px; cursor: pointer;
  }
  .card:active { background: #1d2338; }
  .card-top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin-bottom: 6px; }
  .card-name { font-weight: 700; font-size: 14.5px; color: #e6e8ee; }
  .card-time { font-size: 11px; color: #6b7488; white-space: nowrap; }
  .badges { display: flex; gap: 6px; margin-bottom: 8px; flex-wrap: wrap; }
  .badge { font-size: 10.5px; padding: 2px 8px; border-radius: 6px; font-weight: 600; }
  .badge.stage { background: #2a3146; color: #b6bccd; }
  .badge.overdue { background: #4a1f24; color: #f87171; }
  .badge.today { background: #1f3a2e; color: #4ade80; }
  .badge.notask { background: #23293b; color: #6b7488; }
  .card-preview { font-size: 13px; color: #b6bccd; line-height: 1.5; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  /* Detail view */
  .detail-header { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
  .back-btn { background: #181d2e; border: 1px solid #2a3146; color: #e6e8ee; border-radius: 8px; padding: 7px 12px; font-size: 13px; cursor: pointer; }
  .lead-title { font-weight: 700; font-size: 15px; flex: 1; }
  .conv { background: #141827; border: 1px solid #2a3146; border-radius: 10px; padding: 10px; margin-bottom: 14px; max-height: 240px; overflow-y: auto; }
  .msg { font-size: 12.5px; margin-bottom: 8px; line-height: 1.45; }
  .msg .who { font-weight: 700; margin-right: 4px; }
  .msg.lead .who { color: #2dd4bf; }
  .msg.us .who { color: #8a93a8; }
  .no-conv { color: #6b7488; font-size: 13px; text-align: center; padding: 10px; }
  label.section { display: block; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #8a93a8; margin: 0 0 6px; }
  textarea {
    width: 100%; min-height: 140px; background: #141827; color: #e6e8ee; border: 1px solid #2a3146;
    border-radius: 10px; padding: 12px; font-size: 14.5px; line-height: 1.55; font-family: inherit;
    resize: vertical;
  }
  textarea:focus { outline: none; border-color: #2dd4bf; }
  .actions { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
  button.act { flex: 1; min-width: 100px; border: none; border-radius: 10px; padding: 13px 10px; font-size: 14px; font-weight: 700; cursor: pointer; }
  button.approve { background: #2dd4bf; color: #06121a; }
  button.skip { background: #181d2e; color: #b6bccd; border: 1px solid #2a3146; }
  button.replied { background: #181d2e; color: #b6bccd; border: 1px solid #2a3146; }
  button.act:disabled { opacity: .5; }
  .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: #181d2e; border: 1px solid #2a3146; color: #e6e8ee; padding: 10px 18px; border-radius: 10px; font-size: 13px; z-index: 20; }
  .setup { max-width: 340px; margin: 80px auto; padding: 24px; text-align: center; }
  .setup input { width: 100%; background: #181d2e; color: #e6e8ee; border: 1px solid #2a3146; border-radius: 8px; padding: 12px; font-size: 15px; margin: 14px 0; }
  .setup button { width: 100%; background: #2dd4bf; color: #06121a; border: none; border-radius: 8px; padding: 12px; font-size: 15px; font-weight: 700; cursor: pointer; }
  .spinner { text-align: center; padding: 40px; color: #6b7488; font-size: 13px; }
</style>
</head>
<body>
<div id="app"></div>
<script>
(function () {
  const API = location.origin + "/api/public";
  const $ = (sel, root) => (root || document).querySelector(sel);
  const app = $("#app");

  let brokerName = localStorage.getItem("copilot_broker") || "";
  let activeTab = "push";
  let items = { live: [], push: [], reach: [] };
  let openItem = null;
  let editing = false;
  let editValue = "";
  let busy = false;
  let toastMsg = "";
  let toastTimer = null;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function showToast(msg) {
    toastMsg = msg;
    render();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastMsg = ""; render(); }, 2500);
  }

  function stageBadges(item) {
    const parts = [];
    if (item.lead_stage) parts.push('<span class="badge stage">' + esc(item.lead_stage) + "</span>");
    if (item.kind === "push") {
      if (!item.next_followup_at) {
        parts.push('<span class="badge notask">No task</span>');
      } else {
        const d = new Date(item.next_followup_at);
        const now = new Date();
        if (d < now) parts.push('<span class="badge overdue">Overdue</span>');
        else parts.push('<span class="badge today">Today</span>');
      }
    }
    return parts.join("");
  }

  function timeAgo(iso) {
    if (!iso) return "";
    const diffMs = Date.now() - new Date(iso).getTime();
    const mins = Math.round(diffMs / 60000);
    if (mins < 1) return "now";
    if (mins < 60) return mins + "m ago";
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + "h ago";
    return Math.round(hrs / 24) + "d ago";
  }

  async function fetchInbox() {
    if (!brokerName) return;
    try {
      const res = await fetch(API + "/suggestions?responsibleUser=" + encodeURIComponent(brokerName), { cache: "no-store" });
      const data = await res.json();
      const all = data.items || [];
      const REACH_STAGES = ["1st follow up", "2nd follow up", "final follow up"];
      const isReachStage = (stage) => {
        if (!stage) return false;
        const s = stage.toLowerCase();
        return REACH_STAGES.some((q) => s.includes(q));
      };
      items = {
        live: all.filter((i) => i.kind === "live"),
        reach: all.filter((i) => i.kind === "push" && isReachStage(i.lead_stage)),
        push: all.filter((i) => i.kind === "push" && !isReachStage(i.lead_stage)),
      };
      if (openItem) {
        const fresh = all.find((i) => i.id === openItem.id);
        if (fresh) openItem = fresh;
      }
      render();
    } catch (e) { /* silent — keep last known state */ }
  }

  async function approve() {
    if (!openItem || busy) return;
    busy = true; render();
    const finalText = editValue.trim();
    const wasEdited = editing && finalText !== (openItem.suggestion_text || "").trim();
    try {
      const res = await fetch(API + "/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          suggestionId: openItem.id,
          message: finalText,
          edited: wasEdited,
          originalText: wasEdited ? openItem.suggestion_text : undefined,
          brokerId: brokerName,
        }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      showToast("Sent");
      openItem = null; editing = false;
      await fetchInbox();
    } catch (e) {
      showToast("Error: " + e.message);
    } finally {
      busy = false; render();
    }
  }

  async function skip() {
    if (!openItem || busy) return;
    busy = true; render();
    try {
      await fetch(API + "/skip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suggestionId: openItem.id }),
      });
      showToast("Skipped");
      openItem = null; editing = false;
      await fetchInbox();
    } catch (e) {
      showToast("Error: " + e.message);
    } finally {
      busy = false; render();
    }
  }

  async function alreadyReplied() {
    if (!openItem || busy) return;
    busy = true; render();
    try {
      await fetch(API + "/broker-replied", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadId: openItem.lead_id }),
      });
      showToast("Marked as replied");
      openItem = null; editing = false;
      await fetchInbox();
    } catch (e) {
      showToast("Error: " + e.message);
    } finally {
      busy = false; render();
    }
  }

  function openDetail(item) {
    openItem = item;
    editing = false;
    editValue = item.suggestion_text || "";
    render();
    window.scrollTo(0, 0);
  }

  function renderSetup() {
    app.innerHTML =
      '<div class="setup">' +
        '<div class="brand"><span class="dot"></span> Copilot Inbox</div>' +
        '<p style="color:#8a93a8;font-size:13px;margin-top:10px">Enter your broker name exactly as it appears in amoCRM (e.g. Robert, Amelia, HoS).</p>' +
        '<input id="broker-input" placeholder="Broker name" autocapitalize="words" />' +
        '<button id="broker-save">Continue</button>' +
      "</div>";
    $("#broker-save").onclick = () => {
      const v = $("#broker-input").value.trim();
      if (!v) return;
      brokerName = v;
      localStorage.setItem("copilot_broker", v);
      render();
      fetchInbox();
    };
  }

  function renderList() {
    const list = items[activeTab] || [];
    const tabDef = [
      ["live", "Live"],
      ["reach", "Reach"],
      ["push", "Push"],
    ];
    let html = "";
    html += '<header>';
    html += '<div class="top-row">';
    html += '<div class="brand"><span class="dot"></span> Copilot Inbox</div>';
    html += '<div style="display:flex;align-items:center;gap:6px">';
    html += '<span class="broker-chip">👤 <b>' + esc(brokerName) + "</b></span>";
    html += '<button class="refresh-btn" id="refresh-btn" title="Refresh">⟳</button>';
    html += "</div></div>";
    html += '<div class="tabs">';
    for (const [key, label] of tabDef) {
      const n = (items[key] || []).length;
      html += '<div class="tab ' + (activeTab === key ? "active" : "") + '" data-tab="' + key + '">' + label + '<span class="count">' + n + "</span></div>";
    }
    html += "</div></header><main>";

    if (list.length === 0) {
      html += '<div class="empty">All caught up 🎉<br>No ' + activeTab + ' items right now.</div>';
    } else {
      for (const item of list) {
        html += '<div class="card" data-id="' + esc(item.id) + '">';
        html += '<div class="card-top"><span class="card-name">' + esc(item.lead_name || "Lead " + item.lead_id) + "</span>";
        html += '<span class="card-time">' + timeAgo(item.created_at) + "</span></div>";
        html += '<div class="badges">' + stageBadges(item) + "</div>";
        html += '<div class="card-preview">' + esc((item.suggestion_text || "").slice(0, 160)) + "</div>";
        html += "</div>";
      }
    }
    html += "</main>";
    app.innerHTML = html;

    $("#refresh-btn").onclick = fetchInbox;
    document.querySelectorAll(".tab").forEach((el) => {
      el.onclick = () => { activeTab = el.getAttribute("data-tab"); render(); };
    });
    document.querySelectorAll(".card").forEach((el) => {
      el.onclick = () => {
        const id = el.getAttribute("data-id");
        const found = list.find((i) => i.id === id);
        if (found) openDetail(found);
      };
    });
  }

  function renderDetail() {
    const item = openItem;
    let html = "";
    html += '<header><div class="detail-header">';
    html += '<button class="back-btn" id="back-btn">← Back</button>';
    html += '<div class="lead-title">' + esc(item.lead_name || "Lead " + item.lead_id) + "</div>";
    html += "</div>";
    html += '<div class="badges">' + stageBadges(item) + "</div>";
    html += "</header><main>";

    const msgs = item.recent_messages || [];
    html += '<label class="section">Conversation</label>';
    html += '<div class="conv">';
    if (msgs.length === 0) {
      html += '<div class="no-conv">No conversation history yet</div>';
    } else {
      for (const m of msgs.slice(-8)) {
        html += '<div class="msg ' + (m.from === "lead" ? "lead" : "us") + '"><span class="who">' + (m.from === "lead" ? "Lead" : "You") + ":</span>" + esc(m.text) + "</div>";
      }
    }
    html += "</div>";

    html += '<label class="section">Suggested message</label>';
    html += '<textarea id="msg-text">' + esc(editValue) + "</textarea>";

    html += '<div class="actions">';
    html += '<button class="act approve" id="approve-btn" ' + (busy ? "disabled" : "") + ">✓ Approve &amp; Send</button>";
    html += '<button class="act skip" id="skip-btn" ' + (busy ? "disabled" : "") + ">✕ Skip</button>";
    html += '<button class="act replied" id="replied-btn" ' + (busy ? "disabled" : "") + ">Already Replied</button>";
    html += "</div></main>";

    app.innerHTML = html;

    $("#back-btn").onclick = () => { openItem = null; render(); };
    const ta = $("#msg-text");
    ta.oninput = () => { editValue = ta.value; editing = true; };
    $("#approve-btn").onclick = approve;
    $("#skip-btn").onclick = skip;
    $("#replied-btn").onclick = alreadyReplied;
  }

  function render() {
    if (!brokerName) { renderSetup(); return; }
    if (openItem) renderDetail();
    else renderList();

    if (toastMsg) {
      const t = document.createElement("div");
      t.className = "toast";
      t.textContent = toastMsg;
      document.body.appendChild(t);
    }
  }

  render();
  if (brokerName) fetchInbox();
  setInterval(() => { if (!openItem) fetchInbox(); }, 20000);
})();
</script>
</body>
</html>`;

router.get("/m", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.send(PAGE_HTML);
});

export default router;
