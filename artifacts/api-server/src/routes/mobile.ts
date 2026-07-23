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
  .card-lead-link { font-weight: 700; font-size: 14.5px; color: #7dd3fc; text-decoration: none; }
  .card-lead-link .dim { opacity: .55; font-weight: 400; }
  .card-time { font-size: 11px; color: #6b7488; white-space: nowrap; }
  .card-notes { font-size: 11px; color: #6b7488; margin-bottom: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badges { display: flex; gap: 6px; margin-bottom: 8px; flex-wrap: wrap; }
  .badge { font-size: 10.5px; padding: 2px 8px; border-radius: 6px; font-weight: 600; }
  .badge.stage { background: #2a3146; color: #b6bccd; }
  .badge.stagepill { background: rgba(139,92,246,.18); color: #a78bfa; }
  .badge.overdue { background: #4a1f24; color: #f87171; }
  .badge.today { background: #1f3a2e; color: #4ade80; }
  .badge.notask { background: #23293b; color: #6b7488; }
  .card-preview { font-size: 13px; color: #b6bccd; line-height: 1.5; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .card-foot { display: flex; align-items: center; gap: 6px; margin-top: 8px; font-size: 10px; color: #7a8699; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; }
  .card-arrow { margin-left: auto; color: #2dd4bf; font-size: 13px; }
  /* Detail view */
  .detail-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 14px; }
  .back-btn { background: #181d2e; border: 1px solid #2a3146; color: #e6e8ee; border-radius: 8px; padding: 7px 12px; font-size: 13px; cursor: pointer; }
  .openlead-btn { font-size: 11px; font-weight: 700; color: #7dd3fc; text-decoration: none; background: rgba(45,212,191,.1); border: 1px solid rgba(45,212,191,.25); border-radius: 8px; padding: 7px 10px; white-space: nowrap; }
  .lead-hdr { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
  .lead-hdr-name { font-size: 16px; font-weight: 700; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .thread-lbl { font-size: 10px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; color: #5e7a96; margin-bottom: 6px; }
  .conv { background: #141827; border: 1px solid #2a3146; border-radius: 10px; padding: 10px; margin-bottom: 14px; max-height: 260px; overflow-y: auto; }
  .tmsg { margin-bottom: 10px; }
  .tmsg:last-child { margin-bottom: 0; }
  .tmsg-hdr { margin-bottom: 3px; display: flex; justify-content: space-between; }
  .tsender { font-size: 10px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }
  .tmsg.us .tsender { color: #64b5f6; }
  .tmsg.lead .tsender { color: #34d399; }
  .tat { font-size: 10px; color: #5e7a99; }
  .tbubble { padding: 9px 12px; border-radius: 8px; font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
  .tmsg.us .tbubble { background: rgba(33,150,243,.15); border: 1px solid rgba(33,150,243,.3); border-left: 3px solid #2196f3; color: #d4eaff; }
  .tmsg.lead .tbubble { background: rgba(52,211,153,.12); border: 1px solid rgba(52,211,153,.3); border-left: 3px solid #34d399; color: #c8f5e0; }
  .no-conv { color: #6b7488; font-size: 13px; text-align: center; padding: 10px; }
  label.section { display: block; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #8a93a8; margin: 0 0 6px; }
  .body-block { margin: 0 0 14px; }
  .msg-text { font-size: 14.5px; line-height: 1.6; white-space: pre-wrap; }
  .err-text { color: #fca5a5; font-size: 12px; margin-top: 8px; }
  .skel { display: flex; flex-direction: column; gap: 8px; padding: 4px 0; }
  .skel div { height: 11px; background: rgba(255,255,255,.06); border-radius: 5px; animation: pulseskel 1.2s ease-in-out infinite; }
  .skel div:nth-child(1) { width: 100%; } .skel div:nth-child(2) { width: 92%; } .skel div:nth-child(3) { width: 80%; } .skel div:nth-child(4) { width: 60%; }
  @keyframes pulseskel { 0%,100% { opacity: .5 } 50% { opacity: 1 } }
  textarea {
    width: 100%; min-height: 140px; background: #141827; color: #e6e8ee; border: 1px solid #2a3146;
    border-radius: 10px; padding: 12px; font-size: 14.5px; line-height: 1.55; font-family: inherit;
    resize: vertical;
  }
  textarea:focus { outline: none; border-color: #2dd4bf; }
  .ai-input-wrap { display: flex; flex-direction: column; gap: 8px; background: #141827; border: 1px solid #2a3146; border-radius: 10px; padding: 10px; margin-top: 10px; }
  .aiinput { width: 100%; min-height: 44px; background: transparent; color: #e6e8ee; border: none; outline: none; font-size: 13px; font-family: inherit; resize: none; padding: 0; }
  .ai-btn-row { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
  .ai-mic-btn { border: 1px solid #2a3146; background: transparent; color: #8a93a8; border-radius: 8px; padding: 6px 12px; font-size: 12.5px; cursor: pointer; }
  .ai-mic-btn.recording { background: #ef4444; border-color: #ef4444; color: #fff; }
  .ai-send-btn { border: none; background: #2dd4bf; color: #06121a; border-radius: 8px; padding: 6px 14px; font-size: 12.5px; font-weight: 700; cursor: pointer; }
  .ai-send-btn:disabled { opacity: .5; }
  .action-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; padding: 10px; background: #141827; border: 1px solid #2a3146; border-radius: 10px; flex-wrap: wrap; }
  .action-row-lbl { font-size: 12px; color: #8a93a8; font-weight: 600; }
  .ext-cb { width: 16px; height: 16px; accent-color: #2dd4bf; }
  .ext-select { flex: 1; min-width: 120px; background: #181d2e; border: 1px solid #2a3146; border-radius: 6px; color: #e6e8ee; font-size: 12px; padding: 5px 8px; }
  .ext-select:disabled { opacity: .4; }
  .actions { display: flex; gap: 8px; margin-top: 6px; flex-wrap: wrap; }
  button.act { flex: 1; min-width: 100px; border: none; border-radius: 10px; padding: 13px 10px; font-size: 14px; font-weight: 700; cursor: pointer; }
  button.approve { background: #2dd4bf; color: #06121a; }
  button.skip { background: #181d2e; color: #b6bccd; border: 1px solid #2a3146; }
  button.replied { background: #181d2e; color: #b6bccd; border: 1px solid #2a3146; }
  button.edit { background: #181d2e; color: #b6bccd; border: 1px solid #2a3146; }
  button.act:disabled { opacity: .5; }
  .edit-ok, .edit-x { width: 48px; height: 48px; border-radius: 10px; font-size: 19px; cursor: pointer; flex: none; }
  .edit-ok { border: none; background: #2dd4bf; color: #06121a; }
  .edit-x { border: 1px solid #2a3146; background: #181d2e; color: #b6bccd; }
  .stage-confirm { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; width: 100%; }
  .stage-confirm-lbl { font-size: 12px; color: #8a93a8; flex: 0 0 100%; }
  .skip-panel { margin-top: 10px; padding: 10px; background: #141827; border: 1px solid #2a3146; border-radius: 10px; }
  .skip-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .skip-lbl { font-size: 12px; color: #8a93a8; }
  .mini { height: 34px; border-radius: 8px; border: 1px solid #2a3146; background: transparent; color: #cfd5e3; cursor: pointer; padding: 0 10px; font-size: 12px; font-weight: 700; }
  .mini-danger { color: #f87171; }
  .atts { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
  .att { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: rgba(255,255,255,.04); border: 1px solid #2a3146; border-radius: 8px; font-size: 12px; color: #cfd5e3; }
  .att-reminder { border-color: rgba(251,191,36,.3); background: rgba(251,191,36,.06); color: #fde68a; }
  .att-img img { max-width: 140px; max-height: 100px; border-radius: 6px; display: block; }
  .attlbl { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .attrm { width: 22px; height: 22px; border-radius: 6px; border: none; background: rgba(239,68,68,.15); color: #fca5a5; cursor: pointer; flex: none; }
  .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: #181d2e; border: 1px solid #2a3146; color: #e6e8ee; padding: 10px 18px; border-radius: 10px; font-size: 13px; z-index: 20; max-width: 90vw; text-align: center; }
  .setup { max-width: 340px; margin: 80px auto; padding: 24px; text-align: center; }
  .setup input { width: 100%; background: #181d2e; color: #e6e8ee; border: 1px solid #2a3146; border-radius: 8px; padding: 12px; font-size: 15px; margin: 14px 0; }
  .setup button { width: 100%; background: #2dd4bf; color: #06121a; border: none; border-radius: 8px; padding: 12px; font-size: 15px; font-weight: 700; cursor: pointer; }
</style>
</head>
<body>
<div id="app"></div>
<script>
(function () {
  var API = location.origin + "/api/public";
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var app = $("#app");

  var DEFAULT_GUIDE = [
    'You are a senior Bali real estate broker working directly with international clients on behalf of Unicorn Property, a real estate agency in Bali.',
    'You do not speak as "Robert\\'s assistant" or "the assistant of the broker". You speak as the broker directly.',
    'You represent yourself as a real person in the sales process, not as an AI. You communicate with clients mainly through WhatsApp, sometimes email, and your goal is to guide qualified buyers through the Bali real estate market, understand their needs, build trust, handle objections, and move them toward a call, meeting, viewing, reservation, or next clear step.',
    'Your role is not to simply send listings. Your role is to act as a market advisor, investment consultant, and deal guide.',
    '',
    'You help clients understand:',
    '- The Bali market: villas, land, off-plan, developer projects, private sellers',
    '- Legal structures: leasehold vs freehold, PT PMA, nominee arrangements',
    '- Realistic ROI and rental yield (honest, not inflated)',
    '- Due diligence, which developers to trust, and pitfalls to avoid',
    '',
    'MESSAGE RULES:',
    '- Address the lead by first name. Always.',
    '- Be warm, concise, confident. No corporate fluff.',
    '- Reference the last thing the lead said — continuity matters.',
    '- One clear question or CTA per message. Never two.',
    '- Under 100 words unless the situation genuinely requires more.',
    '- Sign off as Robert (first name only).',
    '',
    'DO NOT:',
    '- Claim guaranteed ROI, occupancy rates, or resale values.',
    '- Push apartments — Bali is a villa and land market.',
    '- Apologize for following up or sound desperate.',
    '- Send "just checking in" or any generic filler.',
    '- Sound like a bot or paste a template unchanged.',
    '- Repeat the same angle or question twice in a row.',
    '',
    'GOAL OF EACH MESSAGE:',
    'Move the lead one step closer to: a call -> a viewing -> a reservation.',
    'If the lead mentions budget, timeline, location preference, or competitors -> suggest a short call immediately.'
  ].join('\\n');

  var brokerName = localStorage.getItem("copilot_broker") || "";
  var activeTab = "live";
  var items = { live: [], push: [], reach: [] };
  var openItem = null;
  var editing = false;
  var editValue = "";
  var toastMsg = "";
  var toastTimer = null;

  var PIPELINE_STAGES = [
    "NEW LEAD","IN PROGRESS","1ST FOLLOW UP (NEXT DAY)","2ND FOLLOW UP (3 DAYS AFTER)",
    "FINAL FOLLOW UP (1 WEEK AFTER)","Shanti 5th msg (after 5 days)","LEAD ASSIGNED",
    "TAKEN TO WORK","Contact established","Mailing","Long-Term Cycle","Needs Assessed",
    "Options Sent","Zoom Call scheduled","Viewing Scheduled",
    "Feedback / Handling Objections","Reservation","Negotiations",
    "Contract signed","Closed - won","Closed - lost"
  ];

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function showToast(msg) {
    toastMsg = msg;
    render();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastMsg = ""; render(); }, 2500);
  }

  function taskStatusBadge(nextFollowupAt) {
    if (!nextFollowupAt) return '<span class="badge notask">No task</span>';
    var due = new Date(nextFollowupAt);
    var now = new Date();
    var todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var dueStart = new Date(due.getFullYear(), due.getMonth(), due.getDate());
    var diffDays = Math.round((dueStart - todayStart) / (1000 * 60 * 60 * 24));
    if (diffDays < 0) return '<span class="badge overdue">Overdue ' + Math.abs(diffDays) + 'd</span>';
    if (diffDays === 0) return '<span class="badge today">Today</span>';
    return '<span class="badge notask">In ' + diffDays + 'd</span>';
  }
  function cardBadges(item) {
    var html = taskStatusBadge(item.next_followup_at);
    if (item.lead_stage) html += '<span class="badge stagepill">' + esc(item.lead_stage) + '</span>';
    return html;
  }

  function fmtAgo(iso) {
    if (!iso) return "";
    var s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return s + "s ago";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    return Math.floor(h / 24) + "d ago";
  }

  // ── Stage helpers (mirrors extension's PIPELINE_STAGES logic) ──────────────
  function stageName(s) { return (typeof s === "object" && s !== null) ? (s.name || "") : String(s || ""); }
  function stagesAfterCurrent(currentStage) {
    var idx = -1;
    for (var i = 0; i < PIPELINE_STAGES.length; i++) {
      if (stageName(PIPELINE_STAGES[i]).toLowerCase() === String(currentStage || "").toLowerCase()) { idx = i; break; }
    }
    var slice = idx === -1 ? PIPELINE_STAGES : PIPELINE_STAGES.slice(idx + 1);
    return slice.map(stageName);
  }
  function stageIdForName(name) {
    for (var i = 0; i < PIPELINE_STAGES.length; i++) {
      var s = PIPELINE_STAGES[i];
      if (stageName(s).toLowerCase() === String(name || "").toLowerCase()) {
        return (typeof s === "object" && s !== null) ? (s.id || null) : null;
      }
    }
    return null;
  }
  function detectStageTransition(text) {
    if (!text) return false;
    var t = text.toLowerCase();
    var kws = ["viewing","zoom call","video call","meet on","call on","просмотр","зум","созвон","встрет","запишем","запланируем","забронируем","reservation","резерв","schedule a"];
    for (var i = 0; i < kws.length; i++) { if (t.indexOf(kws[i]) !== -1) return true; }
    return false;
  }
  async function fetchStageOptions() {
    try {
      var res = await fetch(API + "/stage-options", { cache: "no-cache" });
      if (!res.ok) return;
      var json = await res.json();
      if (Array.isArray(json.stages) && json.stages.length > 0) PIPELINE_STAGES = json.stages;
    } catch (e) { /* keep built-in defaults */ }
  }

  // ── PUSH tab sort: task urgency, then funnel-stage order (mirrors extension) ─
  var PUSH_STAGE_ORDER = ['contact established', 'needs assessed', 'options sent', 'option send'];
  function pushTaskScore(row) {
    var nfa = row.next_followup_at;
    if (!nfa) return 1e9;
    var due = new Date(nfa);
    var n = new Date();
    var dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
    var todayDay = new Date(n.getFullYear(), n.getMonth(), n.getDate());
    var diff = Math.round((dueDay - todayDay) / 864e5);
    return Math.max(0, -diff);
  }
  function pushStageScore(row) {
    var s = (row.lead_stage || '').toLowerCase();
    for (var i = 0; i < PUSH_STAGE_ORDER.length; i++) { if (s.indexOf(PUSH_STAGE_ORDER[i]) !== -1) return i; }
    return 999;
  }
  function sortedList(kind) {
    var raw = (items[kind] || []).slice();
    if (kind !== 'push') return raw;
    raw.sort(function (a, b) {
      var at = pushTaskScore(a), bt = pushTaskScore(b);
      if (at !== bt) return at - bt;
      return pushStageScore(a) - pushStageScore(b);
    });
    return raw;
  }

  function renderAttachments(item) {
    if (!item.attachments || !item.attachments.length) return "";
    var html = '<div class="atts">';
    for (var i = 0; i < item.attachments.length; i++) {
      var a = item.attachments[i];
      var rm = a._broker ? '<button class="attrm" data-rmattach="' + i + '" title="Remove">\\u00d7</button>' : "";
      if (a.type === "reminder") {
        html += '<div class="att att-reminder"><span>\\ud83d\\udccc</span><span class="attlbl">' + esc(a.label) + '</span></div>';
      } else if (a.type === "image" && a.url) {
        html += '<div class="att att-img"><a href="' + esc(a.url) + '" target="_blank" rel="noopener"><img src="' + esc(a.url) + '" alt="' + esc(a.label || "") + '"></a><span class="attlbl">' + esc(a.label || "") + '</span>' + rm + '</div>';
      } else if (a.type === "image" && !a.url) {
        html += '<div class="att att-reminder"><span>\\ud83d\\uddbc</span><span class="attlbl">' + esc(a.label) + ' \\u2014 not uploaded yet</span></div>';
      } else if (a.type === "link") {
        html += '<div class="att att-link"><span>\\ud83d\\udd17</span><a href="' + esc(a.url) + '" target="_blank" rel="noopener">' + esc(a.label || a.url) + '</a>' + rm + '</div>';
      }
    }
    html += '</div>';
    return html;
  }
  // ── Voice dictation (Web Speech API — same as extension; gracefully absent on iOS Safari) ─
  var _voiceEl = null, _voiceBtn = null, _directSR = null;
  function stopVoiceDictation() {
    if (_voiceEl) {
      if (_directSR) { try { _directSR.stop(); } catch (e) {} _directSR = null; }
      if (_voiceBtn) { _voiceBtn.textContent = "\\ud83c\\udfa4 Dictate"; _voiceBtn.classList.remove("recording"); }
      _voiceEl = null; _voiceBtn = null;
    }
  }
  function startVoiceDictation(edEl, btnEl) {
    if (!edEl) return;
    if (_voiceEl) {
      if (_directSR) { try { _directSR.stop(); } catch (e) {} _directSR = null; }
      return;
    }
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      if (btnEl) { btnEl.textContent = "\\ud83d\\udeab Not supported"; setTimeout(function () { btnEl.textContent = "\\ud83c\\udfa4 Dictate"; }, 3000); }
      return;
    }
    _voiceEl = edEl; _voiceBtn = btnEl;
    if (btnEl) { btnEl.textContent = "\\u23f3"; btnEl.title = "Starting microphone…"; }
    var sr = new SR();
    sr.lang = navigator.language || "ru-RU";
    sr.continuous = true; sr.interimResults = true;
    _directSR = sr;
    var lastFinal = edEl.value;
    sr.onstart = function () {
      if (_voiceBtn) { _voiceBtn.textContent = "\\u23f9"; _voiceBtn.title = "Recording… click to stop"; _voiceBtn.classList.add("recording"); }
    };
    sr.onresult = function (event) {
      var interim = "";
      for (var i = event.resultIndex; i < event.results.length; i++) {
        var t = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          lastFinal += (lastFinal && lastFinal.slice(-1) !== " " ? " " : "") + t.trim();
        } else { interim += t; }
      }
      if (_voiceEl) {
        _voiceEl.value = lastFinal + (interim ? (lastFinal && lastFinal.slice(-1) !== " " ? " " : "") + interim : "");
        _voiceEl.dispatchEvent(new Event("input", { bubbles: true }));
      }
    };
    sr.onerror = function (event) {
      _directSR = null;
      if (_voiceBtn) {
        _voiceBtn.classList.remove("recording");
        var denied = event.error === "not-allowed" || event.error === "audio-capture";
        _voiceBtn.textContent = "\\ud83d\\udeab Mic blocked";
        _voiceBtn.title = denied ? "Mic blocked — allow microphone access for this site" : "Mic error: " + event.error;
        var b = _voiceBtn;
        setTimeout(function () { b.textContent = "\\ud83c\\udfa4 Dictate"; b.title = "Dictate your instruction"; }, 4000);
      }
      _voiceEl = null; _voiceBtn = null;
    };
    sr.onend = function () {
      _directSR = null;
      if (_voiceEl) { _voiceEl.value = lastFinal.trim(); _voiceEl.dispatchEvent(new Event("input", { bubbles: true })); }
      if (_voiceBtn) { _voiceBtn.textContent = "\\ud83c\\udfa4 Dictate"; _voiceBtn.title = "Dictate your instruction"; _voiceBtn.classList.remove("recording"); }
      _voiceEl = null; _voiceBtn = null;
    };
    sr.start();
  }

  async function fetchInbox() {
    if (!brokerName) return;
    try {
      var res = await fetch(API + "/suggestions?responsibleUser=" + encodeURIComponent(brokerName), { cache: "no-store" });
      var data = await res.json();
      var all = data.items || [];
      var REACH_STAGES = ["1st follow up", "2nd follow up", "final follow up"];
      var isReachStage = function (stage) {
        if (!stage) return false;
        var s = stage.toLowerCase();
        return REACH_STAGES.some(function (q) { return s.indexOf(q) !== -1; });
      };
      items = {
        live: all.filter(function (i) { return i.kind === "live"; }),
        reach: all.filter(function (i) { return i.kind === "push" && isReachStage(i.lead_stage); }),
        push: all.filter(function (i) { return i.kind === "push" && !isReachStage(i.lead_stage); }),
      };
      render();
    } catch (e) { /* network hiccup — keep last snapshot */ }
  }

  async function approveServer(item, finalText) {
    item.busy = true; render();
    try {
      var res = await fetch(API + "/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          suggestionId: item.id,
          message: finalText,
          edited: finalText.trim() !== (item.original || "").trim(),
          originalText: item.original || "",
          brokerId: brokerName,
          newStage: (item.lead_stage && item.lead_stage !== item._originalStage) ? item.lead_stage : undefined,
          stageId: (item.lead_stage && item.lead_stage !== item._originalStage) ? (stageIdForName(item.lead_stage) || item.lead_stage_id || undefined) : (item.lead_stage_id || undefined),
        }),
      });
      var json = await res.json().catch(function () { return {}; });
      if (!res.ok || !json.ok) {
        item.error = "Webhook " + (json.hookStatus != null ? json.hookStatus : res.status);
        item.busy = false; item._approving = false; render();
        return;
      }
      openItem = null; editing = false;
      showToast("Sent");
      await fetchInbox();
    } catch (e) {
      item.error = String((e && e.message) || e);
      item.busy = false; item._approving = false;
      render();
    }
  }

  async function skipServer(item) {
    item.busy = true; render();
    try {
      await fetch(API + "/skip", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ suggestionId: item.id }) });
    } catch (e) {}
    openItem = null; editing = false;
    showToast("Skipped");
    await fetchInbox();
  }

  async function brokerReplied(item) {
    item.busy = true; render();
    try {
      await fetch(API + "/broker-replied", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ leadId: item.lead_id }) });
    } catch (e) {}
    openItem = null; editing = false;
    showToast("Marked as replied");
    await fetchInbox();
  }

  async function rewriteServer(item, feedback) {
    if (!item.revisionChain) item.revisionChain = [];
    item.revisionChain.push({ draft: item.text, feedback: feedback.trim() });
    var messages = (item.recent_messages || []).map(function (m) {
      return { from: m.from === "us" ? "broker" : "lead", text: m.text };
    });
    item.loading = true; item.error = ""; render();
    try {
      var res = await fetch(API + "/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          guide: DEFAULT_GUIDE,
          lead: { name: item.lead_name || ("Lead " + item.lead_id), company: "", stage: item.lead_stage || item.kind || "" },
          messages: messages,
          brokerName: brokerName,
          brokerId: brokerName,
          leadId: item.lead_id,
          revisionChain: item.revisionChain,
          outputLanguage: "English",
        }),
      });
      if (!res.ok) throw new Error("API " + res.status);
      var json = await res.json();
      if (json && json.text) item.text = json.text;
    } catch (e) {
      item.error = (e && e.message) || "AI rewrite failed";
    } finally {
      item.loading = false; render();
    }
  }

  function openDetail(item, tabKind) {
    var stageChecked = detectStageTransition(item.suggestion_text);
    var nextStages = stagesAfterCurrent(item.lead_stage || "");
    openItem = {
      id: item.id,
      lead_id: item.lead_id,
      kind: tabKind,
      followup_level: item.followup_level,
      responsible_user: item.responsible_user,
      lead_name: item.lead_name || null,
      lead_stage: item.lead_stage || null,
      lead_stage_id: item.lead_stage_id || null,
      next_followup_at: item.next_followup_at || null,
      text: item.suggestion_text || "",
      original: item.suggestion_text || "",
      recent_messages: Array.isArray(item.recent_messages) ? item.recent_messages : [],
      attachments: Array.isArray(item.attachments) ? item.attachments.slice() : [],
      loading: false,
      busy: false,
      error: "",
      revisionChain: [],
      _stageChecked: stageChecked,
      _selectedStage: stageChecked && nextStages.length > 0 ? nextStages[0] : "",
      _originalStage: item.lead_stage || null,
      _skipExpanded: false,
      _skipTaskMode: false,
      _skipTaskVoice: "",
      _stageConfirm: null,
      _approving: false,
    };
    editing = false;
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
    $("#broker-save").onclick = function () {
      var v = $("#broker-input").value.trim();
      if (!v) return;
      brokerName = v;
      localStorage.setItem("copilot_broker", v);
      render();
      fetchInbox();
    };
  }

  function renderList() {
    var list = sortedList(activeTab);
    var tabDef = [["live", "Live"], ["reach", "Reach"], ["push", "Push"]];
    var html = "";
    html += '<header>';
    html += '<div class="top-row">';
    html += '<div class="brand"><span class="dot"></span> Copilot Inbox</div>';
    html += '<div style="display:flex;align-items:center;gap:6px">';
    html += '<span class="broker-chip">\\ud83d\\udc64 <b>' + esc(brokerName) + '</b></span>';
    html += '<button class="refresh-btn" id="refresh-btn" title="Refresh">\\u27f3</button>';
    html += "</div></div>";
    html += '<div class="tabs">';
    for (var i = 0; i < tabDef.length; i++) {
      var key = tabDef[i][0], label = tabDef[i][1];
      var n = (items[key] || []).length;
      html += '<div class="tab ' + (activeTab === key ? "active" : "") + '" data-tab="' + key + '">' + label + '<span class="count">' + n + "</span></div>";
    }
    html += "</div></header><main>";

    if (list.length === 0) {
      var emptyText = activeTab === "live"
        ? "All live replies handled. New ones will appear here as leads respond."
        : activeTab === "reach"
          ? "No qualification follow-ups due right now. They appear when amoCRM tasks are due."
          : "No active pipeline follow-ups right now.";
      html += '<div class="empty">All caught up \\ud83c\\udf89<br>' + emptyText + '</div>';
    } else {
      for (var j = 0; j < list.length; j++) {
        var item = list[j];
        var leadUrl = "https://unicornproperty.amocrm.ru/leads/detail/" + encodeURIComponent(item.lead_id);
        html += '<div class="card" data-id="' + esc(item.id) + '">';
        html += '<div class="card-top">';
        html += '<a class="card-lead-link" data-leadlink href="' + leadUrl + '">' + (item.lead_name ? esc(item.lead_name) + ' <span class="dim">#' + esc(item.lead_id) + '</span>' : "Lead " + esc(item.lead_id)) + '</a>';
        html += '<span class="card-time">' + fmtAgo(item.created_at) + "</span>";
        html += "</div>";
        if (item.lead_notes) {
          html += '<div class="card-notes">' + esc(String(item.lead_notes).split("\\n")[0].trim().slice(0, 80)) + '</div>';
        }
        html += '<div class="badges">' + cardBadges(item) + "</div>";
        html += '<div class="card-preview">' + esc((item.suggestion_text || "").slice(0, 160)) + "</div>";
        var footLabel = item.responsible_user ? item.responsible_user : (activeTab === "live" ? "Live reply" : activeTab === "reach" ? "Reach follow-up" : "Push follow-up");
        html += '<div class="card-foot"><span>' + esc(footLabel) + '</span><span class="card-arrow">\\u203a</span></div>';
        html += "</div>";
      }
    }
    html += "</main>";
    app.innerHTML = html;

    $("#refresh-btn").onclick = fetchInbox;
    document.querySelectorAll(".tab").forEach(function (el) {
      el.onclick = function () { activeTab = el.getAttribute("data-tab"); render(); };
    });
    document.querySelectorAll(".card").forEach(function (el) {
      el.onclick = function () {
        var id = el.getAttribute("data-id");
        var found = list.find(function (i) { return i.id === id; });
        if (found) openDetail(found, activeTab);
      };
      var link = el.querySelector("[data-leadlink]");
      if (link) link.addEventListener("click", function (e) { e.stopPropagation(); });
    });
  }

  function renderDetail() {
    var it = openItem;
    var leadUrl = "https://unicornproperty.amocrm.ru/leads/detail/" + encodeURIComponent(it.lead_id);
    var html = "";
    html += '<header><div class="detail-header">';
    html += '<button class="back-btn" id="back-btn">\\u2190 Back</button>';
    html += '<a class="openlead-btn" href="' + leadUrl + '" target="_blank" rel="noopener">\\u2197 Open Lead</a>';
    html += "</div>";
    html += '<div class="lead-hdr"><span class="lead-hdr-name">' + (it.lead_name ? esc(it.lead_name) : "Lead " + esc(it.lead_id)) + '</span>' + taskStatusBadge(it.next_followup_at) + '</div>';
    html += "</header><main>";

    var msgs = it.recent_messages || [];
    html += '<div class="thread-lbl">\\ud83d\\udcac Conversation</div>';
    html += '<div class="conv">';
    if (msgs.length === 0) {
      html += '<div class="no-conv">No conversation history yet</div>';
    } else {
      for (var i = 0; i < msgs.length; i++) {
        var m = msgs[i];
        var isUs = m.from === "us";
        html += '<div class="tmsg ' + (isUs ? "us" : "lead") + '">';
        html += '<div class="tmsg-hdr"><span class="tsender">' + (isUs ? "You" : "Lead") + '</span></div>';
        html += '<div class="tbubble">' + esc(m.text) + '</div>';
        html += '</div>';
      }
    }
    html += '</div>';

    html += '<div class="body-block">';
    if (editing) {
      html += '<label class="section">Edit message</label>';
      html += '<textarea id="msg-text" placeholder="Edit message…">' + esc(editValue) + '</textarea>';
      html += renderAttachments(it);
      html += '<input type="file" id="file-input" accept="image/*" style="display:none">';
      html += '<div class="ai-input-wrap">';
      html += '<textarea class="aiinput" id="ai-input" placeholder="Tell AI what to change…" rows="2"></textarea>';
      html += '<div class="ai-btn-row"><button class="ai-mic-btn" id="voice-btn" title="Voice input">\\ud83c\\udfa4 Dictate</button><button class="ai-send-btn" id="rewrite-btn" title="Send"' + (it.loading ? " disabled" : "") + '>\\u2191 Send</button></div>';
      html += '</div>';
    } else if (it.loading) {
      html += '<label class="section">Suggested message</label>';
      html += '<div class="skel"><div></div><div></div><div></div><div></div></div>';
    } else {
      html += '<label class="section">Suggested message</label>';
      html += '<div class="msg-text">' + esc(it.text) + '</div>';
      html += renderAttachments(it);
    }
    if (it.error) html += '<div class="err-text">' + esc(it.error) + '</div>';
    html += '</div>';

    if (!editing) {
      var nextStages = stagesAfterCurrent(it.lead_stage);
      html += '<div class="action-row">';
      html += '<input type="checkbox" class="ext-cb" id="stage-cb" ' + (it._stageChecked ? "checked" : "") + '>';
      html += '<span class="action-row-lbl">Next step:</span>';
      html += '<select class="ext-select" id="stage-select" ' + (!it._stageChecked ? "disabled" : "") + '>';
      html += '<option value="">— select —</option>';
      for (var s = 0; s < nextStages.length; s++) {
        var sName = nextStages[s];
        html += '<option value="' + esc(sName) + '"' + (it._selectedStage === sName ? " selected" : "") + '>' + esc(sName) + '</option>';
      }
      html += '</select></div>';
    }

    html += '<div class="actions">';
    if (editing) {
      html += '<button class="edit-ok" id="save-edit-btn" title="Save">\\u2713</button>';
      html += '<button class="edit-x" id="cancel-edit-btn" title="Cancel">\\u2715</button>';
    } else if (it._stageConfirm) {
      html += '<div class="stage-confirm">';
      html += '<span class="stage-confirm-lbl">Move to \\u201c' + esc(it._stageConfirm.newStage) + '\\u201d:</span>';
      html += '<button class="act approve" id="confirm-send-move" ' + (it.busy ? "disabled" : "") + '>\\u2713 Send + Move</button>';
      html += '<button class="act skip" id="confirm-move-only" ' + (it.busy ? "disabled" : "") + '>\\u203a Only Move</button>';
      html += '<button class="act skip" id="confirm-cancel">\\u2715 Cancel</button>';
      html += '</div>';
    } else {
      html += '<button class="act approve" id="approve-btn" ' + ((it.busy || it.loading) ? "disabled" : "") + '>' + (it.busy ? "Sending…" : "\\u2713 Approve &amp; Send") + '</button>';
      if (it.kind === "live") {
        html += '<button class="act replied" id="replied-btn" ' + (it.busy ? "disabled" : "") + '>\\u2713 Already replied</button>';
      } else {
        html += '<button class="act skip" id="skip-btn" ' + (it.busy ? "disabled" : "") + '>\\u2715 Skip</button>';
      }
      html += '<button class="act edit" id="edit-btn" ' + ((it.busy || it.loading) ? "disabled" : "") + '>\\u270e Edit</button>';
    }
    html += '</div>';

    if (it._skipExpanded && it.kind !== "live") {
      html += '<div class="skip-panel">';
      if (!it._skipTaskMode) {
        html += '<div class="skip-row">';
        html += '<span class="skip-lbl">Skip:</span>';
        html += '<button class="mini" id="skip-auto-btn">\\u2715 Continue auto schedule</button>';
        html += '<button class="mini" id="skip-taskmode-btn">\\ud83d\\udcc5 Set manual task</button>';
        html += '<button class="mini mini-danger" id="bot-exclude-btn">\\u2298 Remove from bot</button>';
        html += '</div>';
      } else {
        html += '<textarea class="aiinput" id="skip-task-voice" placeholder="Describe task by voice or text…" rows="2" style="background:#141827;border:1px solid #2a3146;border-radius:8px;padding:10px">' + esc(it._skipTaskVoice || "") + '</textarea>';
        html += '<div class="ai-btn-row" style="margin-top:6px">';
        html += '<button class="ai-mic-btn" id="skip-task-voice-btn" title="Voice input">\\ud83c\\udf99 Dictate</button>';
        html += '<button class="ai-send-btn" id="skip-task-confirm-btn" ' + (it.busy ? "disabled" : "") + '>\\u2713 Set Task</button>';
        html += '</div>';
      }
      html += '</div>';
    }

    html += "</main>";
    app.innerHTML = html;

    $("#back-btn").onclick = function () { openItem = null; editing = false; render(); };

    var stageCb = $("#stage-cb");
    var stageSelect = $("#stage-select");
    if (stageCb && stageSelect) {
      stageCb.onchange = function () {
        it._stageChecked = stageCb.checked;
        stageSelect.disabled = !stageCb.checked;
        if (!stageCb.checked) { it._selectedStage = ""; stageSelect.value = ""; }
      };
      stageSelect.onchange = function () { it._selectedStage = stageSelect.value; };
    }

    if (editing) {
      var ta = $("#msg-text");
      ta.oninput = function () { editValue = ta.value; };
      requestAnimationFrame(function () {
        ta.focus();
        var len = ta.value.length;
        ta.setSelectionRange(len, len);
      });
      document.querySelectorAll("[data-rmattach]").forEach(function (btn) {
        btn.onclick = function () {
          var idx = Number(btn.getAttribute("data-rmattach"));
          it.attachments.splice(idx, 1);
          renderDetail();
        };
      });
      var fileInput = $("#file-input");
      fileInput.onchange = function (e) {
        var file = e.target.files && e.target.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function () {
          it.attachments = it.attachments || [];
          it.attachments.push({ type: "image", url: reader.result, name: file.name, _broker: true });
          renderDetail();
        };
        reader.readAsDataURL(file);
      };
      $("#voice-btn").onclick = function () { startVoiceDictation($("#ai-input"), $("#voice-btn")); };
      $("#save-edit-btn").onclick = function () {
        stopVoiceDictation();
        var aiInstr = $("#ai-input").value.trim();
        if (aiInstr) {
          if (editValue && editValue !== it.text) it.text = editValue;
          rewriteServer(it, aiInstr);
          editing = false; editValue = "";
        } else {
          it.text = editValue; editing = false; render();
        }
      };
      $("#cancel-edit-btn").onclick = function () { stopVoiceDictation(); editing = false; render(); };
      $("#ai-input").onkeydown = function (e) {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          $("#rewrite-btn").click();
        }
      };
      $("#rewrite-btn").onclick = function () {
        var fb = $("#ai-input").value.trim() || "Rewrite this draft using the manual edits as guidance.";
        if (editValue && editValue !== it.text) it.text = editValue;
        rewriteServer(it, fb);
        editing = false; editValue = "";
      };
      return;
    }


    if (it._stageConfirm) {
      $("#confirm-send-move").onclick = async function () {
        if (it.busy) return;
        var text = it._stageConfirm.text, newStage = it._stageConfirm.newStage;
        it._stageConfirm = null; it._approving = true;
        it.lead_stage = newStage; it._selectedStage = newStage;
        await approveServer(it, text);
      };
      $("#confirm-move-only").onclick = async function () {
        if (it.busy) return;
        var text = it._stageConfirm.text, newStage = it._stageConfirm.newStage;
        it._stageConfirm = null;
        it.lead_stage = newStage; it._selectedStage = newStage;
        it.busy = true; render();
        try {
          await fetch(API + "/approve", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              suggestionId: it.id, message: text, brokerId: brokerName, newStage: newStage,
              stageId: stageIdForName(newStage) || it.lead_stage_id || undefined, skipMessage: true,
            }),
          });
          openItem = null;
          await fetchInbox();
        } catch (e) {
          it.error = String((e && e.message) || e);
          it.busy = false; render();
        }
      };
      $("#confirm-cancel").onclick = function () { it._stageConfirm = null; it._approving = false; render(); };
      return;
    }

    $("#approve-btn").onclick = async function () {
      if (it.busy || it._approving) return;
      var shouldChangeStage = !!(stageCb && stageCb.checked && stageSelect.value);
      var newStageVal = stageSelect ? stageSelect.value : "";
      var links = (it.attachments || []).filter(function (a) { return a.type === "link"; }).map(function (a) { return a.label + ": " + a.url; }).join("\\n");
      var fullText = links ? (it.text + "\\n\\n" + links) : it.text;
      if (shouldChangeStage && newStageVal) {
        it._stageConfirm = { text: fullText, newStage: newStageVal };
        render();
        return;
      }
      it._approving = true;
      await approveServer(it, fullText);
    };
    if (it.kind === "live") {
      $("#replied-btn").onclick = function () { brokerReplied(it); };
    } else {
      $("#skip-btn").onclick = function () { it._skipExpanded = !it._skipExpanded; it._skipTaskMode = false; render(); };
    }
    $("#edit-btn").onclick = function () { editing = true; editValue = it.text; render(); };

    if (it._skipExpanded && it.kind !== "live") {
      if (!it._skipTaskMode) {
        $("#skip-auto-btn").onclick = function () { skipServer(it); };
        $("#skip-taskmode-btn").onclick = function () { it._skipTaskMode = true; render(); };
        $("#bot-exclude-btn").onclick = async function () {
          if (!confirm("Remove this lead from the bot? It will no longer appear in Push or Live. The lead stays in CRM.")) return;
          it.busy = true; render();
          try {
            await fetch(API + "/bot-exclude", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ leadId: String(it.lead_id) }) });
            openItem = null;
            await fetchInbox();
          } catch (e) {
            showToast("Error: " + ((e && e.message) || e));
            it.busy = false; render();
          }
        };
      } else {
        var voiceTa = $("#skip-task-voice");
        voiceTa.oninput = function () { it._skipTaskVoice = voiceTa.value; };
        $("#skip-task-voice-btn").onclick = function () { startVoiceDictation(voiceTa, $("#skip-task-voice-btn")); };
        $("#skip-task-confirm-btn").onclick = async function () {
          var voiceText = (it._skipTaskVoice || "").trim();
          if (!voiceText) return;
          it.busy = true; render();
          try {
            showToast("Parsing task…");
            var pr = await fetch(API + "/parse-task", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: voiceText }) });
            var pj = await pr.json().catch(function () { return {}; });
            if (!pr.ok || !pj.taskDate) throw new Error(pj.error || "parse failed");
            showToast("Scheduling task…");
            await fetch(API + "/schedule-task", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ leadId: String(it.lead_id), taskDate: pj.taskDate, taskText: pj.taskText }) });
            await fetch(API + "/skip", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ suggestionId: it.id }) });
            showToast("Task set: " + pj.taskDate + " — " + pj.taskText);
            openItem = null;
            await fetchInbox();
          } catch (e) {
            showToast("Error: " + String((e && e.message) || e).slice(0, 60));
            it.busy = false; render();
          }
        };
      }
    }
  }

  function render() {
    if (!brokerName) { renderSetup(); return; }
    if (openItem) renderDetail();
    else renderList();

    if (toastMsg) {
      var t = document.createElement("div");
      t.className = "toast";
      t.textContent = toastMsg;
      document.body.appendChild(t);
    }
  }

  render();
  fetchStageOptions();
  if (brokerName) fetchInbox();
  setInterval(function () { if (!openItem) fetchInbox(); }, 20000);
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
