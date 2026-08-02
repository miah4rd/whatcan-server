(() => {
  // Guard: bail out silently if chrome extension context is no longer valid
  // (happens when the extension is reloaded while AmoCRM tab is still open)
  try { if (!chrome?.runtime?.id) return; } catch { return; }

  // Suppress unhandled promise rejections so Chrome never shows
  // the extension Errors badge from network/API failures.
  window.addEventListener("unhandledrejection", (e) => e.preventDefault());

  if (window.__copilotInjected) return;
  window.__copilotInjected = true;

  const DEFAULT_GUIDE = `You are a senior Bali real estate broker working directly with international clients on behalf of Unicorn Property, a real estate agency in Bali.
You do not speak as "Robert's assistant" or "the assistant of the broker". You speak as the broker directly.
You represent yourself as a real person in the sales process, not as an AI. You communicate with clients mainly through WhatsApp, sometimes email, and your goal is to guide qualified buyers through the Bali real estate market, understand their needs, build trust, handle objections, and move them toward a call, meeting, viewing, reservation, or next clear step.
Your role is not to simply send listings. Your role is to act as a market advisor, investment consultant, and deal guide.

You help clients understand:
- The Bali market: villas, land, off-plan, developer projects, private sellers
- Legal structures: leasehold vs freehold, PT PMA, nominee arrangements
- Realistic ROI and rental yield (honest, not inflated)
- Due diligence, which developers to trust, and pitfalls to avoid

MESSAGE RULES:
- Address the lead by first name. Always.
- Be warm, concise, confident. No corporate fluff.
- Reference the last thing the lead said — continuity matters.
- One clear question or CTA per message. Never two.
- Under 100 words unless the situation genuinely requires more.
- Sign off as Robert (first name only).

DO NOT:
- Claim guaranteed ROI, occupancy rates, or resale values.
- Push apartments — Bali is a villa and land market.
- Apologize for following up or sound desperate.
- Send "just checking in" or any generic filler.
- Sound like a bot or paste a template unchanged.
- Repeat the same angle or question twice in a row.

GOAL OF EACH MESSAGE:
Move the lead one step closer to: a call -> a viewing -> a reservation.
If the lead mentions budget, timeline, location preference, or competitors -> suggest a short call immediately.`;
  const DEFAULT_API =
    "https://copilot.globalapplab.ru/api/public/suggest";

  // The extension starts with an empty queue. Items are added only by explicit
  // CRM trigger messages, so page refresh can never create a fake suggestion.

  let settings = { guide: DEFAULT_GUIDE, urlFilter: "unicornproperty.amocrm.ru", brokerName: "Robert", apiUrl: DEFAULT_API, outputLanguage: "English" };
  // Live theme & labels — fetched from server, overrides built-in defaults.
  // Lets cosmetic changes (CSS, button labels) ship without re-installing the extension.
  let theme = { css: null, labels: {} };
  const L = (key, fallback) => (theme.labels && theme.labels[key]) || fallback;

  // Channel icon for display in inbox and card header
  function channelIcon(ch) {
    if (!ch) return "";
    const c = ch.toLowerCase();
    if (c.includes("whatsapp")) return "🟢";
    if (c.includes("telegram")) return "✈️";
    if (c.includes("instagram")) return "📸";
    if (c.includes("email") || c.includes("mail")) return "✉️";
    if (c.includes("amocrm") || c.includes("amo")) return "🔷";
    if (c.includes("viber")) return "💜";
    return "💬";
  }
  function channelLabel(ch) {
    if (!ch) return "";
    const display = ch === "amocrm" ? "AmoCRM"
      : ch === "whatsapp" ? "WhatsApp"
      : ch.charAt(0).toUpperCase() + ch.slice(1);
    return channelIcon(ch) + " " + display;
  }
  function taskStatusBadge(nextFollowupAt) {
    if (!nextFollowupAt) {
      return `<span style="font-size:10px;font-weight:700;color:#94a3b8;background:rgba(148,163,184,.12);border-radius:3px;padding:1px 6px;margin-right:4px">No task</span>`;
    }
    const due = new Date(nextFollowupAt);
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dueStart = new Date(due.getFullYear(), due.getMonth(), due.getDate());
    const diffDays = Math.round((dueStart - todayStart) / (1000 * 60 * 60 * 24));
    if (diffDays < 0) {
      return `<span style="font-size:10px;font-weight:700;color:#f87171;background:rgba(248,113,113,.15);border-radius:3px;padding:1px 6px;margin-right:4px">Overdue ${Math.abs(diffDays)}d</span>`;
    }
    if (diffDays === 0) {
      return `<span style="font-size:10px;font-weight:700;color:#34d399;background:rgba(52,211,153,.15);border-radius:3px;padding:1px 6px;margin-right:4px">Today</span>`;
    }
    return `<span style="font-size:10px;font-weight:700;color:#94a3b8;background:rgba(148,163,184,.12);border-radius:3px;padding:1px 6px;margin-right:4px">In ${diffDays}d</span>`;
  }

  // ── Temperature control (broker can correct the bot's read) ────────────────
  function tempMeta(t) {
    if (t === "hot") return { icon: "🔥", label: "Hot", cls: "hot" };
    if (t === "warm") return { icon: "🌤", label: "Warm", cls: "warm" };
    if (t === "cold") return { icon: "❄️", label: "Cold", cls: "cold" };
    return null;
  }
  function tempChipHtml(it) {
    const m = tempMeta(it.profile_temperature);
    const brokerSet = it.profile_temperature_source === "broker";
    if (!m) {
      return `<button class="li-temp" data-tempchip style="cursor:pointer;border:none;background:rgba(148,163,184,.14);color:#cbd5e1" title="Set the lead temperature">🌡 Set temp</button>`;
    }
    return `<button class="li-temp li-temp-${m.cls}" data-tempchip style="cursor:pointer;border:none" title="${brokerSet ? "Set by you — tap to change" : "Bot estimate — tap to correct"}">${m.icon} ${m.label}${brokerSet ? " ✎" : ""}</button>`;
  }
  function tempPickerHtml(it) {
    const cur = it.profile_temperature;
    const btn = (t, icon, label) => `<button class="mini" data-tempset="${t}" style="${cur === t ? "outline:2px solid #60a5fa;" : ""}">${icon} ${label}</button>`;
    return `<div style="display:flex;gap:6px;align-items:center;padding:2px 14px 8px;flex-wrap:wrap">
      <span style="font-size:11px;color:#8a96a8">Set temperature:</span>
      ${btn("hot", "🔥", "Hot")}${btn("warm", "🌤", "Warm")}${btn("cold", "❄️", "Cold")}
    </div>`;
  }

  // ── Reschedule-task popover (change the follow-up date straight from the chip) ─
  function _fmtDateShort(d) { return d.toLocaleDateString([], { month: "short", day: "numeric" }); }
  function reschedulePopoverHtml(it) {
    const now = new Date();
    const mk = (days) => { const d = new Date(now.getTime() + days * 86400000); d.setHours(12, 0, 0, 0); return d; };
    const presets = [
      { label: "Tomorrow", d: mk(1) },
      { label: "In 3d", d: mk(3) },
      { label: "1 week", d: mk(7) },
      { label: "2 weeks", d: mk(14) },
      { label: "1 month", d: mk(30) },
    ];
    let suggestedBtn = "";
    if (it.suggested_followup_at) {
      const sd = new Date(it.suggested_followup_at);
      if (!isNaN(sd.getTime())) {
        suggestedBtn = `<button class="mini" data-reschedule="${sd.toISOString()}" style="background:rgba(96,165,250,.18);color:#93c5fd;font-weight:700" title="Adaptive: fresh/hot sooner, cold+old later">🤖 Suggested · ${_fmtDateShort(sd)}</button>`;
      }
    }
    const presetBtns = presets.map((p) => `<button class="mini" data-reschedule="${p.d.toISOString()}">${p.label} · ${_fmtDateShort(p.d)}</button>`).join("");
    return `<div style="padding:6px 14px 10px;border-top:1px solid #2a3a50;background:rgba(251,191,36,.05)">
      <div style="font-size:11px;color:#8a96a8;margin-bottom:6px">📅 Reschedule follow-up — closes the current task, sets the next${it.busy ? " …" : ""}:</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">${suggestedBtn}${presetBtns}</div>
      <div style="display:flex;gap:6px;align-items:center;margin-top:8px">
        <input type="date" data-reschedcustom style="background:#0f1826;color:#e6e8ee;border:1px solid #2a3a50;border-radius:6px;padding:5px 8px;font-size:12px;font-family:inherit">
        <button class="mini" data-reschedcustombtn>Set date</button>
        <button class="mini" data-reschedcancel style="margin-left:auto">✕ Close</button>
      </div>
    </div>`;
  }

  // Each item: { lead, dueAt, suggestion, rationale, loading, error, generated }
  let queue = [];
  // Panel starts closed. When a follow-up becomes due, the bubble pulses with a
  // red notification dot; the panel only opens when the user clicks it.
  let collapsed = true;
  let manuallyOpen = false;    // user opened bubble while nothing is due
  let editing = false;
  let editValue = "";

  // Server-backed inbox (Live + Push). Polled from /api/public/suggestions.
  let inbox = { live: [], reach: [], push: [] };
  let activeTab = "live"; // 'live' | 'reach' | 'push'
  // When a server suggestion is opened for review, this holds its state.
  // { id, lead_id, kind, followup_level, responsible_user, text, original, busy, error }
  let openServerItem = null;
  let autoLeadId = null; // leadId currently open in CRM (for URL-based auto-detect)
  let panelToast = null;
  let panelSize = null;  // { w, h } — user-resized window size, persisted
  let convSplit = 0.55;  // fraction of the detail height given to the conversation
                         // pane (vs the suggestion pane); draggable divider, persisted

  let PIPELINE_STAGES = [
    "NEW LEAD","IN PROGRESS","1ST FOLLOW UP (NEXT DAY)","2ND FOLLOW UP (3 DAYS AFTER)",
    "FINAL FOLLOW UP (1 WEEK AFTER)","Shanti 5th msg (after 5 days)","LEAD ASSIGNED",
    "TAKEN TO WORK","Contact established","Mailing","Long-Term Cycle","Needs Assessed",
    "Options Sent","Zoom Call scheduled","Viewing Scheduled",
    "Feedback / Handling Objections","Reservation","Negotiations",
    "Contract signed","Closed - won","Closed - lost",
  ];
  // PIPELINE_STAGES may be [{name,id}] objects (after fetchStageOptions) or plain strings.
  // Always normalise to the .name string so downstream code gets a simple string array.
  function stageName(s) { return typeof s === "object" && s !== null ? (s.name || "") : String(s || ""); }
  function stagesAfterCurrent(currentStage) {
    const idx = PIPELINE_STAGES.findIndex(s => stageName(s).toLowerCase() === (currentStage||"").toLowerCase());
    const slice = idx === -1 ? PIPELINE_STAGES : PIPELINE_STAGES.slice(idx + 1);
    return slice.map(s => stageName(s));
  }
  function stageIdForName(name) {
    const s = PIPELINE_STAGES.find(s => stageName(s).toLowerCase() === (name||"").toLowerCase());
    return (s && typeof s === "object") ? (s.id || null) : null;
  }
  function detectStageTransition(text) {
    if (!text) return false;
    const t = text.toLowerCase();
    return ["viewing","zoom call","video call","meet on","call on","просмотр",
      "зум","созвон","встрет","запишем","запланируем","забронируем",
      "reservation","резерв","schedule a"].some(kw => t.includes(kw));
  }

  const host = document.createElement("div");
  host.id = "__copilot_host";
  host.style.cssText = "all: initial; position: fixed; bottom: 24px; right: 24px; z-index: 2147483647; transform-origin: bottom right;";
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: "open" });

  // Keep widget at a constant on-screen size regardless of page zoom (Cmd +/-).
  window.__copilotBaseDpr = window.__copilotBaseDpr || window.devicePixelRatio;
  let __lastScale = 1;
  function applyZoomCompensation() {
    const zoom = window.devicePixelRatio / window.__copilotBaseDpr;
    if (!isFinite(zoom) || zoom <= 0) return;
    const s = 1 / zoom;
    if (Math.abs(s - __lastScale) < 0.01) return;
    __lastScale = s;
    host.style.transform = `scale(${s})`;
  }
  applyZoomCompensation();
  window.addEventListener("resize", applyZoomCompensation, { passive: true });

  const style = document.createElement("style");
  style.textContent = `
    :host, * { box-sizing: border-box; }
    .wrap { font-family: Roboto, -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif; color: #e6e8ee; }
    .panel { position: relative; width: 624px; max-width: calc(100vw - 24px); max-height: calc(100vh - 24px); display:flex; flex-direction:column; background: #273444; border: 1px solid #3a4a5e; border-radius: 8px; box-shadow: 0 18px 48px rgba(0,0,0,.55); overflow: hidden; animation: in .25s ease-out; }
    .resize-grip { position:absolute; top:0; left:0; width:18px; height:18px; cursor:nwse-resize; z-index:20; }
    .resize-grip::before { content:""; position:absolute; top:4px; left:4px; width:8px; height:8px; border-top:2px solid #6b7d92; border-left:2px solid #6b7d92; border-radius:3px 0 0 0; opacity:.7; }
    .resize-grip:hover::before { opacity:1; border-color:#90caf9; }
    .panel > .hd, .panel > .reason, .panel > .actions { flex: 0 0 auto; }
    .panel > .body { flex: 1 1 auto; overflow-y: auto; min-height: 0; scrollbar-width: thin; scrollbar-color: #3a4a5e transparent; }
    .panel > .body::-webkit-scrollbar { width: 6px; }
    .panel > .body::-webkit-scrollbar-thumb { background: #3a4a5e; border-radius: 3px; }
    @keyframes in { from { transform: translateY(8px); opacity: 0 } to { transform: none; opacity: 1 } }
    .hd { padding: 9px 12px; border-bottom: 1px solid #3a4a5e; background: #2c3e50; }
    .hdtop { display:flex; align-items:center; justify-content:space-between; gap:8px; }
    .badge { display:flex; align-items:center; gap: 8px; min-width: 0; flex:1; }
    .spark { width:26px; height:26px; border-radius:5px; background:#2196f3; display:grid; place-items:center; color:#fff; font-weight:900; font-size:14px; flex:none; }
    .who { font-size: 11.5px; font-weight: 800; color: #ffffff; line-height: 1.2; text-transform: uppercase; letter-spacing: .12em; }
    .who .arr { color: #5e6680; font-weight: 400; margin-left: 4px; font-size: 11px; }
    .sub { font-size: 12px; color: #8a96a8; margin-top: 3px; white-space: nowrap; overflow:hidden; text-overflow:ellipsis; max-width:240px; }
    .icons { display:flex; gap:1px; }
    .ib { width:26px; height:26px; border-radius:4px; background:transparent; border:0; color:#8a96a8; cursor:pointer; display:grid; place-items:center; font-size:15px; }
    .ib:hover { background:rgba(255,255,255,.08); color:#fff; }
    .leadbtn { width:100%; margin-top:8px; height:28px; border-radius:5px; border:1px solid #3a4a5e; background:transparent; color:#90caf9; cursor:pointer; font-size:11px; font-weight:700; display:flex; align-items:center; justify-content:center; gap:6px; }
    .leadbtn:hover { background:rgba(33,150,243,.1); border-color:#2196f3; color:#bbdefb; }
    .reason { padding: 9px 12px; background: rgba(33,150,243,.08); border-bottom: 1px solid #3a4a5e; border-left: 3px solid #2196f3; display:flex; gap:8px; align-items:flex-start; }
    .reason .icon { color:#64b5f6; font-size:15px; flex:none; margin-top:1px; }
    .reason .txt { font-size: 13px; line-height: 1.5; color:#e6e8ee; font-weight:500; }
    .reason .lbl { display:block; font-size: 10px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; color:#64b5f6; margin-bottom: 5px; }
    .body { padding: 10px 12px 8px; background:#273444; }
    .label { font-size: 10px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; color:#8a96a8; margin-bottom:6px; }
    .msg { font-size: 13.5px; line-height: 1.55; color:#e6e8ee; white-space: pre-wrap; min-height: 60px; }
    .skel { display:flex; flex-direction:column; gap:6px; padding: 3px 0 6px; }
    .skel div { height:9px; background:rgba(255,255,255,.07); border-radius:4px; animation: p 1.2s ease-in-out infinite; }
    @keyframes p { 0%,100% {opacity:.5} 50% {opacity:1} }
    .err { color: #fca5a5; font-size: 12px; padding: 5px 0; }
    .ta { width:100%; background:#1a2535; color:#e6e8ee; border:1px solid rgba(255,255,255,.1); border-radius:14px; padding:12px 14px; font-size:14px; font-family:inherit; resize:none; min-height:90px; line-height:1.65; outline:none; cursor:text; box-sizing:border-box; transition:border-color .2s; }
    .ta:focus { border-color:rgba(33,150,243,.4); }
    .voice-bar { display:flex; align-items:center; gap:8px; margin:6px 0 2px; }
    .voice-ed-btn { border:1px solid #3a4a5e; background:transparent; color:#8a96a8; border-radius:6px; padding:4px 12px; font-size:12px; cursor:pointer; transition:all .2s; white-space:nowrap; }
    .voice-ed-btn:hover { border-color:#2196f3; color:#cfd5e3; }
    .voice-ed-btn.recording { background:#ef4444; border-color:#ef4444; color:#fff; animation:pulse-rec 1.2s ease-in-out infinite; }
    @keyframes pulse-rec { 0%,100%{opacity:1} 50%{opacity:.6} }
    .voice-hint { font-size:11px; color:#ef4444; }
    .hint { font-size: 11px; color:#8a96a8; margin-top: 6px; }
    
    .aiinput { width:100%; background:#1a2535; color:#e6e8ee; border:1px solid #2a3a50; border-radius:8px; outline:none; padding:7px 10px; font-size:13px; font-family:inherit; line-height:1.55; resize:none; max-height:120px; overflow-y:auto; }
    .ai-input-wrap { display:flex; flex-direction:column; width:100%; background:#1d2a3a; border:1px solid #3a4a5e; border-radius:8px; padding:8px 10px; gap:7px; box-sizing:border-box; }
    .ai-input-wrap:focus-within { background:rgba(33,150,243,.06); border-color:#2196f3; }
    .ai-mic-btn { width:32px; height:32px; border-radius:50%; border:none; background:transparent; color:#8a96a8; cursor:pointer; font-size:17px; display:grid; place-items:center; flex:none; transition:background .15s,color .15s; }
    .ai-mic-btn:hover { background:rgba(255,255,255,.1); color:#cfd5e3; }
    .ai-mic-btn.recording { background:#ef4444; color:#fff; animation:pulse-rec 1.2s ease-in-out infinite; }
    .ai-send-btn { width:36px; height:36px; border-radius:50%; border:none; background:#2196f3; color:#fff; cursor:pointer; font-size:18px; font-weight:700; display:grid; place-items:center; flex:none; transition:background .15s; }
    .ai-send-btn:hover:not(:disabled) { background:#1e88e5; }
    .ai-send-btn:disabled { opacity:.35; cursor:default; }
    .ai-btn-row { display:flex; align-items:center; justify-content:flex-end; gap:6px; }
    .ai-btn-row .ai-mic-btn { width:auto; border-radius:6px; padding:0 10px; font-size:12.5px; font-weight:600; color:#8a96a8; background:transparent; border:1px solid #3a4a5e; height:30px; }
    .ai-btn-row .ai-mic-btn:hover { background:rgba(255,255,255,.08); color:#cfd5e3; }
    .ai-btn-row .ai-mic-btn.recording { background:#ef4444; border-color:#ef4444; color:#fff; }
    .ai-btn-row .ai-send-btn { width:auto; border-radius:6px; padding:0 14px; font-size:12.5px; font-weight:700; height:30px; letter-spacing:.04em; }
    .edittools { margin-top:8px; padding:0 10px; }    .mini { height:32px; border-radius:5px; border:1px solid #3a4a5e; background:transparent; color:#cfd5e3; cursor:pointer; padding:0 10px; font-size:12px; font-weight:700; }
    .mini:hover:not(:disabled) { background:rgba(255,255,255,.08); color:#fff; }
    .mini:disabled { opacity:.4; cursor:default; }
    .actions { padding: 8px 10px; border-top: 1px solid #3a4a5e; background: #2c3e50; display:grid; grid-template-columns:1fr 1fr 1fr; gap:6px; }
    .actions.editing { display:flex!important; justify-content:flex-end; gap:8px; padding:8px 12px 10px; background:transparent; border-top:none; }
    .edit-x { width:34px; height:34px; border-radius:8px; border:1px solid rgba(255,255,255,.18); background:rgba(255,255,255,.05); color:#9aa5b4; cursor:pointer; font-size:15px; display:grid; place-items:center; flex:none; }
    .edit-x:hover { background:rgba(255,255,255,.12); color:#fff; }
    .edit-ok { width:34px; height:34px; border-radius:8px; border:none; background:#2196f3; color:#fff; cursor:pointer; font-size:19px; font-weight:700; display:grid; place-items:center; flex:none; }
    .edit-ok:hover { background:#1976d2; }
    .edit-ok:disabled { opacity:.4; cursor:default; }
    .primary { height:34px; border:0; border-radius:4px; background:#2196f3; color:#fff; font-weight:700; font-size:12.5px; cursor:pointer; text-transform:uppercase; letter-spacing:.06em; }
    .primary:hover:not(:disabled) { background:#1e88e5; }
    .primary:disabled { opacity:.4; cursor:default; }
    .secondary { height:34px; border-radius:4px; border:1px solid #3a4a5e; background:transparent; color:#cfd5e3; cursor:pointer; font-size:12.5px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; }
    .secondary:hover:not(:disabled) { background:rgba(255,255,255,.08); color:#fff; }
    .secondary:disabled { opacity:.4; cursor:default; }
    .bubble { width:48px; height:48px; border-radius:50%; background:#2196f3; color:#fff; display:grid; place-items:center; box-shadow: 0 8px 24px rgba(33,150,243,.4); cursor:pointer; border:0; font-weight:900; font-size:20px; position: relative; }
    .bubble.sleep { opacity: .55; }
    .bubble.sleep:hover { opacity: 1; }
    .bubble .dot { position:absolute; top:-2px; right:-2px; background:#ef4444; color:#fff; font-size:9px; font-weight:700; min-width:16px; height:16px; border-radius:8px; display:grid; place-items:center; padding:0 3px; border: 2px solid #273444; animation: pulse 2s infinite; }
    @keyframes pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(239,68,68,.6) } 50% { box-shadow: 0 0 0 6px rgba(239,68,68,0) } }
    .detail { padding: 8px 12px 10px; border-top: 1px solid #3a4a5e; background:#1d2a3a; max-height: 180px; overflow:auto; }
    .detail .row { display:flex; gap:8px; margin-bottom: 6px; font-size: 11.5px; }
    .detail .k { color:#8a96a8; min-width: 58px; }
    .detail .v { color:#e6e8ee; }
    .detail .msgs { margin-top: 8px; padding-top: 8px; border-top: 1px dashed #3a4a5e; }
    .detail .m { font-size: 11px; line-height: 1.45; margin-bottom: 5px; color:#cfd5e3; }
    .detail .tag { display:inline-block; font-size: 9px; font-weight: 700; padding: 1px 4px; border-radius: 3px; margin-right: 5px; text-transform: uppercase; letter-spacing: .06em; }
    .tag.b { background:#3a4a5e; color:#cfd5e3; }
    .tag.l { background: rgba(33,150,243,.2); color:#64b5f6; }
    .empty { padding: 14px; text-align:center; font-size:11.5px; color:#8a96a8; }
    .rate { display:flex; gap:5px; margin-top:7px; align-items:center; font-size:11px; color:#8a96a8; }
    .rate .lbl { letter-spacing:.1em; text-transform:uppercase; font-weight:700; }
    .rate .rb { height:24px; padding:0 8px; border-radius:4px; border:1px solid #3a4a5e; background:transparent; color:#cfd5e3; cursor:pointer; font-size:12px; }
    .rate .rb:hover { background:rgba(255,255,255,.08); color:#fff; }
    .rate .rb.on { background:#2196f3; border-color:#2196f3; color:#fff; }
    .rate .thanks { color:#a7f3d0; font-weight:700; }
    .tabs { display:flex; gap:4px; padding: 8px 10px; background:#273444; border-bottom:1px solid #3a4a5e; flex:0 0 auto; position:relative; }
    .tabwrap { display:flex; gap:3px; padding:3px; border-radius:999px; background:rgba(33,150,243,.06); border:1px solid rgba(33,150,243,.12); width:100%; }
    .tab { flex:1; position:relative; background:transparent; border:0; color:#8a96a8; cursor:pointer; padding:5px 10px; font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:.08em; display:flex; align-items:center; justify-content:center; gap:6px; border-radius:999px; transition: color .18s ease, background .18s ease, box-shadow .18s ease; }
    .tab .dot { width:5px; height:5px; border-radius:50%; background:var(--mark,#8a96a8); flex:none; }
    .tab:hover { color:#cfd5e3; }
    .tab.on { color:#fff; background:linear-gradient(135deg,#2196f3,#22d3ee); box-shadow:0 4px 14px -5px rgba(33,150,243,.7), inset 0 1px 0 rgba(255,255,255,.18); }
    .tab.on .dot { background:#fff; box-shadow:0 0 5px rgba(255,255,255,.7); }
    .tab.live { --mark:#34d399; }
    .tab.push { --mark:#fbbf24; }
    .tab.reach { --mark:#a78bfa; }
    .tab.drafts { --mark:#60a5fa; }
    .tab .cnt { background:rgba(255,255,255,.08); color:#cfd5e3; font-size:9.5px; min-width:16px; padding:1px 5px; border-radius:999px; font-weight:700; text-align:center; line-height:1.4; }
    .tab.on .cnt { background:rgba(255,255,255,.22); color:#fff; }
    .tab .pulse { width:5px; height:5px; border-radius:50%; background:#34d399; box-shadow:0 0 0 0 rgba(52,211,153,.55); animation: tabpulse 1.8s ease-out infinite; flex:none; }
    .tab.on .pulse { background:#fff; box-shadow:0 0 0 0 rgba(255,255,255,.55); }
    @keyframes tabpulse { 0% { box-shadow:0 0 0 0 rgba(52,211,153,.55) } 70% { box-shadow:0 0 0 5px rgba(52,211,153,0) } 100% { box-shadow:0 0 0 0 rgba(52,211,153,0) } }
    .list { padding: 6px 8px; display:flex; flex-direction:column; gap:6px; }
    .li { position:relative; padding:9px 11px 9px 14px; background:#1d2a3a; border:1px solid #3a4a5e; border-radius:7px; cursor:pointer; transition: border-color .15s ease, background .15s ease, transform .15s ease; overflow:hidden; }
    .li::before { content:""; position:absolute; left:0; top:0; bottom:0; width:3px; background:var(--accent,#2196f3); opacity:.7; }
    .li.live { --accent:#34d399; }
    .li.push { --accent:#fbbf24; }
    .li.reach { --accent:#a78bfa; }
    .li:hover { border-color:var(--accent,#2196f3); background:#22324a; transform: translateX(1px); }
    .li .top { display:flex; justify-content:space-between; align-items:center; gap:8px; font-size:10.5px; color:#8a96a8; margin-bottom:5px; }
    .li .top .lead { font-weight:700; color:#cfd5e3; letter-spacing:.02em; }
    .li .top .lead-info { display:flex; flex-direction:column; gap:2px; min-width:0; }
    .li .top .li-notes { font-size:9.5px; color:#8a96a8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:200px; opacity:.85; }.lead-hdr{display:flex;align-items:center;gap:7px;padding:8px 14px 2px;flex-wrap:wrap}.lead-hdr-name{font-size:13px;font-weight:600;color:#e2e8f0;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.stage-tag{display:inline-flex;align-items:center;gap:3px;padding:2px 9px;border-radius:10px;font-size:10px;font-weight:600;background:rgba(139,92,246,.2);color:#a78bfa;cursor:pointer;letter-spacing:.3px;transition:background .15s;white-space:nowrap}.stage-tag:hover{background:rgba(139,92,246,.35)}.stage-tag--empty{background:rgba(255,255,255,.07);color:#64748b}.stage-select{background:#1a2535;border:1px solid rgba(139,92,246,.5);border-radius:8px;color:#e2e8f0;font-size:11px;padding:3px 8px;outline:none;cursor:pointer;max-width:180px}.li-stage{display:inline-block;margin-top:3px;padding:1px 7px;border-radius:10px;font-size:10px;font-weight:600;background:rgba(139,92,246,.18);color:#a78bfa;letter-spacing:.3px}.li-temp{display:inline-block;margin-top:3px;margin-left:5px;padding:1px 7px;border-radius:10px;font-size:10px;font-weight:700;letter-spacing:.3px;vertical-align:middle}.li-temp-hot{background:rgba(239,68,68,.16);color:#fca5a5}.li-temp-warm{background:rgba(251,146,60,.16);color:#fdba74}.li-temp-cold{background:rgba(96,165,250,.14);color:#93c5fd}.li-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:5px 12px 2px}.li-chips>*{margin:0!important}.last-msg-date{display:inline-flex;align-items:center;gap:3px;margin-top:3px;font-size:9.5px;color:#56687e;letter-spacing:.02em}.last-msg-date .lmd-icon{opacity:.6}
    .li .top .meta { display:flex; align-items:center; gap:5px; }
    .li .top .lvl { background:rgba(251,191,36,.15); color:#fcd34d; padding:1px 5px; border-radius:999px; font-weight:700; font-size:9.5px; letter-spacing:.04em; }
    .li .prv { font-size:12.5px; color:#e6e8ee; line-height:1.45; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
    .li .foot { margin-top:6px; display:flex; align-items:center; gap:5px; font-size:10px; color:#7a8699; font-weight:600; letter-spacing:.06em; text-transform:uppercase; }
    .li .foot .arrow { margin-left:auto; color:var(--accent,#2196f3); font-size:13px; opacity:.7; }
    .back { background:transparent; border:0; color:#8a96a8; cursor:pointer; font-size:11.5px; padding:0; display:flex; align-items:center; gap:4px; }
    .back:hover { color:#fff; }
    .cardtop { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:6px 12px 4px; position:sticky; top:0; z-index:10; background:#16202e; border-bottom:1px solid #2a3a50; }
    .openlead { display:inline-flex; align-items:center; gap:4px; font-size:10.5px; font-weight:700; color:#90caf9; text-decoration:none; background:rgba(33,150,243,.1); border:1px solid rgba(33,150,243,.2); border-radius:4px; padding:3px 8px; letter-spacing:.04em; }
    .openlead:hover { background:rgba(33,150,243,.22); color:#bbdefb; }
    .thread { padding:8px 10px 10px; background:#1c2a3a; border-bottom:2px solid #3a4a5e; display:flex; flex-direction:column; gap:7px; flex:1 1 auto; min-height:140px; overflow-y:auto; scrollbar-width:thin; scrollbar-color:#3a4a5e transparent; }
    .thread::-webkit-scrollbar { width:5px; }
    .thread::-webkit-scrollbar-thumb { background:#3a4a5e; border-radius:3px; }
    .thread-lbl { font-size:9px; font-weight:800; letter-spacing:.16em; text-transform:uppercase; color:#5e7a96; margin-bottom:1px; flex:0 0 auto; }
    .tmsg { display:flex; flex-direction:column; gap:4px; width:100%; }
    .tmsg-hdr { display:flex; align-items:center; justify-content:space-between; gap:6px; padding:0 2px; }
    .tmsg .tsender { font-size:10px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; }
    .tmsg.us .tsender { color:#64b5f6; }
    .tmsg.lead .tsender { color:#34d399; }
    .tmsg .tat { font-size:10px; color:#5e7a96; }
    .tmsg .tbubble { padding:8px 12px; border-radius:6px; font-size:13px; line-height:1.52; white-space:pre-wrap; word-break:break-word; width:100%; box-sizing:border-box; }
    .tmsg.us .tbubble { background:#1e3d6b; border:1px solid #2a5498; border-left:3px solid #2196f3; color:#d4eaff; }
    .tmsg.lead .tbubble { background:#1c3d2d; border:1px solid #2a5e40; border-left:3px solid #34d399; color:#c8f5e0; }
    .panel-toast { padding:6px 12px 7px; background:rgba(52,211,153,.12); color:#34d399; font-size:11.5px; font-weight:600; border-bottom:1px solid rgba(52,211,153,.2); flex:none; }
    .panel-toast.err { background:rgba(239,68,68,.1); color:#f87171; border-color:rgba(239,68,68,.2); }
    .action-row { display:flex; align-items:center; gap:7px; padding:6px 12px; border-top:1px solid #3a4a5e; background:#1f2e3f; min-height:36px; }
    .action-row-lbl { font-size:11px; color:#8a96a8; font-weight:600; white-space:nowrap; }
    .ext-cb { width:14px; height:14px; accent-color:#2196f3; cursor:pointer; flex:none; margin:0; }
    .ext-select { flex:1; background:#1a2535; border:1px solid #3a4a5e; border-radius:5px; color:#e2e8f0; font-size:11px; padding:3px 7px; outline:none; cursor:pointer; min-width:0; transition:border-color .2s; }
    .ext-select:focus { border-color:rgba(33,150,243,.6); }
    .ext-select:disabled { opacity:.38; cursor:default; }
    .ext-date { width:118px; flex:none; background:#1a2535; border:1px solid #3a4a5e; border-radius:5px; color:#e2e8f0; font-size:11px; padding:3px 7px; outline:none; transition:border-color .2s; color-scheme:dark; }
    .ext-date:focus { border-color:rgba(33,150,243,.6); }
    .ext-date:disabled { opacity:.38; cursor:default; }
    .ext-tinput { flex:1; background:#1a2535; border:1px solid #3a4a5e; border-radius:5px; color:#e2e8f0; font-size:11px; padding:3px 7px; outline:none; min-width:0; transition:border-color .2s; }
    .ext-tinput:focus { border-color:rgba(33,150,243,.6); }
    .ext-tinput:disabled { opacity:.38; cursor:default; }
    .ext-tinput::placeholder { color:#3d5068; }
  
    /* === ISOLATION: prevent AmoCRM page CSS from bleeding into extension === */
    .wrap input, .wrap textarea, .wrap select, .wrap button {
      font-family: Roboto, -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif !important;
      box-sizing: border-box !important;
      line-height: normal !important;
    }
    .wrap textarea { background: transparent !important; color: #e6e8ee !important; resize: none !important; }
    .wrap input[type="text"], .wrap input[type="date"] {
      background: #1a2333 !important; color: #e6e8ee !important;
      border: 1px solid #3a4a5e !important; border-radius: 6px !important;
      padding: 5px 10px !important; font-size: 12.5px !important; outline: none !important;
    }
    .wrap input[type="text"]:focus, .wrap input[type="date"]:focus { border-color: #2196f3 !important; }
    .wrap input[type="checkbox"] {
      width: 15px !important; height: 15px !important; accent-color: #2196f3 !important;
      cursor: pointer !important; flex: none !important; margin: 0 !important;
    }
    .wrap select {
      background: #1a2333 !important; color: #e6e8ee !important;
      border: 1px solid #3a4a5e !important; border-radius: 6px !important;
      padding: 4px 8px !important; font-size: 12px !important; outline: none !important; cursor: pointer !important;
    }
    .wrap select:focus { border-color: #2196f3 !important; }
    .wrap select option { background: #1a2333; color: #e6e8ee; }
    .wrap a { color: #90caf9 !important; text-decoration: none !important; }
    .wrap a:hover { color: #bbdefb !important; text-decoration: underline !important; }
    /* === ATTACHMENTS === */
    .atts { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
    .att { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: rgba(255,255,255,.04); border: 1px solid #2a3a50; border-radius: 8px; font-size: 12px; color: #cfd5e3; }
    .att.reminder { border-color: rgba(251,191,36,.3); background: rgba(251,191,36,.06); color: #fde68a; }
    .att.img img { max-width: 120px; max-height: 80px; border-radius: 6px; display: block; }
    .att.file a { color: #90caf9; font-size: 12px; word-break: break-all; }
    .attlbl { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: #cfd5e3; }
    .attrm { width: 20px; height: 20px; border-radius: 4px; border: none; background: rgba(239,68,68,.15); color: #fca5a5; cursor: pointer; font-size: 13px; display: grid; place-items: center; flex: none; padding: 0; line-height: 1; }
    .attrm:hover { background: rgba(239,68,68,.35); color: #fff; }
    /* === LINK === */
    .link { color: #90caf9; cursor: pointer; text-decoration: underline; font-size: inherit; }
    .link:hover { color: #bbdefb; }
  `;
  root.appendChild(style);

  const mount = document.createElement("div");
  mount.className = "wrap";
  root.appendChild(mount);

  function load() {
    try { if (!chrome?.runtime?.id) return; } catch { return; }
    chrome.storage.local.get(["guide", "urlFilter", "brokerName", "apiUrl", "outputLanguage", "dictationLang", "copilotPanelSize", "copilotConvSplit"], async (data) => {
      settings = {
        guide: data.guide || DEFAULT_GUIDE,
        urlFilter: data.urlFilter || "unicornproperty.amocrm.ru",
        brokerName: data.brokerName || "",
        apiUrl: data.apiUrl || DEFAULT_API,
        outputLanguage: data.outputLanguage || "English",
        dictationLang: data.dictationLang || "",
      };
      if (data.copilotPanelSize && data.copilotPanelSize.w) panelSize = data.copilotPanelSize;
      if (typeof data.copilotConvSplit === "number" && data.copilotConvSplit > 0.1 && data.copilotConvSplit < 0.9) convSplit = data.copilotConvSplit;
      if (!matchesUrl()) { host.style.display = "none"; return; }

      // Auto-detect broker from the amoCRM logged-in user. Detection is
      // authoritative — it reflects whoever is actually logged in, so it
      // overrides any stored/stale name. amoCRM is a SPA that may still be
      // loading on first paint, so retry a few times before giving up.
      let detectedUser = await detectAmoCRMUser();
      for (let i = 0; i < 5 && !detectedUser; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        detectedUser = await detectAmoCRMUser();
      }
      if (detectedUser) {
        settings.brokerName = detectedUser;
        chrome.storage.local.set({ brokerName: detectedUser });
      }
      // Keep re-checking in the background — if the broker logs in later or the
      // SPA finishes loading, pick up their real name (never silently show
      // another broker's leads because detection missed once).
      if (!settings.brokerName) {
        const _reDetect = setInterval(async () => {
          const u = await detectAmoCRMUser();
          if (u) {
            clearInterval(_reDetect);
            settings.brokerName = u;
            chrome.storage.local.set({ brokerName: u });
            pollInbox();
          }
        }, 5000);
      }

      host.style.display = "block";
      fetchTheme();
      fetchStageOptions();
      queue = [];
      tick();
      setInterval(tick, 1000);
      pollInbox();
      setInterval(pollInbox, 45000);

      // Detect SPA navigation (AmoCRM is a single-page app — URL changes without reload).
      // When broker opens a lead page that has a pending LIVE, try auto-sync.
      let _lastHref = location.href;
      setInterval(() => {
        if (location.href !== _lastHref) {
          _lastHref = location.href;
          setTimeout(tryAutoSync, 1800); // wait for AmoCRM DOM to render
          setTimeout(onLeadNavigation, 600); // auto-detect lead on navigation
        }
      }, 600);
      // Also auto-detect on initial page load (e.g. user opens a lead directly)
      setTimeout(onLeadNavigation, 1500);
    });
  }

  function apiBase() {
    return settings.apiUrl.replace(/\/suggest(\/)?$/, "");
  }

  async function detectAmoCRMUser() {
    // 1. PRIMARY: amoCRM API — authoritative, matches the DB responsible_user
    //    name exactly. account.current_user_id → find that user in the list.
    //    (Verified: /api/v4/account returns current_user_id and users list has
    //    the broker's first name, e.g. "Amelia".) Logs each failure step so a
    //    broker who still sees nothing can send the console output.
    // account.current_user_id is readable by ANY broker; the name lookup
    // (/api/v4/users) is admin-only (403 for regular brokers), so our server
    // resolves the id -> name via /whoami using its admin token.
    try {
      const accResp = await fetch("/api/v4/account", { credentials: "include" });
      if (accResp.ok) {
        const accData = await accResp.json();
        const userId = accData.current_user_id;
        if (userId) {
          const r = await fetch(`${apiBase()}/whoami?userId=${encodeURIComponent(userId)}`, { cache: "no-cache" });
          if (r.ok) {
            const d = await r.json();
            if (d && d.name) { console.log("[copilot] broker detected:", d.name); return d.name; }
            console.warn("[copilot] detect: whoami returned no name for id", userId);
          } else { console.warn("[copilot] detect: /whoami ->", r.status); }
        } else { console.warn("[copilot] detect: /api/v4/account has no current_user_id"); }
      } else { console.warn("[copilot] detect: /api/v4/account ->", accResp.status); }
    } catch (e) { console.warn("[copilot] detect: API error", e && e.message); }

    // 2. Fallback: amoCRM JS global
    try {
      const u = window.AMOCRM?.constant?.("currentUser") || window.AMOCRM?.data?.currentUser;
      if (u?.name) { console.log("[copilot] broker via global:", u.name); return u.name.split(/\s+/)[0].trim(); }
    } catch {}

    // 3. Fallback: DOM selectors — reads exactly what the user sees in the header
    const domSelectors = [
      ".user-widget__name",
      ".user__name",
      ".profile-card__name",
      ".header__user-name",
      "[data-testid='user-name']",
    ];
    for (const sel of domSelectors) {
      const el = document.querySelector(sel);
      const txt = el?.textContent?.trim();
      if (txt) { console.log("[copilot] broker via DOM:", txt); return txt.split(/\s+/)[0]; }
    }

    console.warn("[copilot] broker NOT detected by any method");
    return null;
  }


  async function pollInbox() {
    try {
      // Never fetch without a resolved broker — an empty responsibleUser makes
      // the server return EVERY broker's leads, which would show one broker
      // another's pipeline. Show nothing until detection resolves the name.
      if (!settings.brokerName) {
        inbox = { live: [], reach: [], push: [] };
        render();
        return;
      }
      const url = `${apiBase()}/suggestions?responsibleUser=${encodeURIComponent(settings.brokerName)}`;
      const res = await fetch(url, { cache: "no-cache" });
      if (!res.ok) return;
      const json = await res.json();
      const items = Array.isArray(json.items) ? json.items : [];
      inbox = {
        live:  items.filter((i) => i.kind === "live"),
        reach: items.filter((i) => i.kind === "push" && isReachStageName(i.lead_stage)),
        push:  items.filter((i) => i.kind === "push" && !isReachStageName(i.lead_stage)),
      };
      // If user has the panel open, refresh; otherwise just refresh badge.
      if (!editing) render(); // never reset UI while broker is actively editing
      // Auto-sync: if broker is viewing a lead with a pending LIVE, detect DOM state
      if (!editing) setTimeout(tryAutoSync, 800);
    } catch (e) {
      // network hiccup — keep last snapshot
    }
  }

  // Save revision chain instructions as broker corrections so the AI learns from them.
  // Called after approve when the broker edited the message.
  async function saveCorrections(revisionChain, situationContext) {
    if (!revisionChain || revisionChain.length === 0) return;
    const instructions = revisionChain.map((s) => s.feedback).filter(Boolean).join(" | ");
    if (!instructions) return;
    try {
      const corrUrl = settings.apiUrl.replace(/\/suggest(\/)?$/, "/correction");
      await fetch(corrUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brokerId: settings.brokerName || "anon",
          instruction: instructions,
          situationContext: situationContext || "",
        }),
      });
    } catch {}
  }

  async function approveServer(item, finalText) {
    item.busy = true; render();
    // Save corrections before approve — fire-and-forget
    if (item.revisionChain && item.revisionChain.length > 0) {
      saveCorrections(item.revisionChain, item.lead_stage || item.kind || "");
    }
    try {
      // On-demand (auto-detected) items have no DB suggestion — send directly via send-message
      if (item._autoDetect) {
        const res = await fetch(`${apiBase()}/send-message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ leadId: String(item.lead_id), message: finalText }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.ok) {
          item.error = `Send error (${json.hookStatus ?? res.status})`;
          item.busy = false; render();
          return;
        }
        openServerItem = null;
        autoLeadId = null; // reset so re-navigation re-triggers
        render();
        return;
      }

      const res = await fetch(`${apiBase()}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          suggestionId: item.id,
          message: finalText,
          edited: finalText.trim() !== (item.original || "").trim(),
          originalText: item.original || "",
          brokerId: settings.brokerName || "anon",
          // Current attachment list — the broker may have removed or added
          // property links while editing. The server sends each link as its own
          // WhatsApp message so every listing gets its own preview banner.
          attachments: (item.attachments || []).filter((a) => a.type === "link" && a.url),
          attachmentsCurated: !!item._attachmentsCurated,
          newStage: (item.lead_stage && item.lead_stage !== item._originalStage) ? item.lead_stage : undefined,
          stageId: (item.lead_stage && item.lead_stage !== item._originalStage) ? (stageIdForName(item.lead_stage) || item.lead_stage_id || undefined) : (item.lead_stage_id || undefined),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) {
        item.error = `Webhook ${json.hookStatus ?? res.status}`;
        item.busy = false; render();
        return;
      }
      // Schedule custom task if broker set one in the task row
      if (item && item._taskChecked && item._taskText?.trim()) {
        const tomorrow = new Date(Date.now() + 24*60*60*1000).toISOString();
        fetch(`${apiBase()}/schedule-task`, {
          method: "POST",
          headers: {"Content-Type":"application/json"},
          body: JSON.stringify({ leadId: String(item.lead_id), taskDate: tomorrow, taskText: item._taskText.trim() })
        }).catch(() => {});
      }
      openServerItem = null;
      await pollInbox();
    } catch (e) {
      item.error = String(e?.message || e);
      item.busy = false;
      item._approving = false; // allow retry on error
      render();
    }
  }

  async function approveServerSeries(item, blocks) {
    item.busy = true; render();
    try {
      const res = await fetch(`${apiBase()}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          suggestionId: item.id,
          message: blocks[0],
          edited: blocks[0].trim() !== (item.original || "").trim(),
          originalText: item.original || "",
          brokerId: settings.brokerName || "anon",
          // Current attachment list — the broker may have removed or added
          // property links while editing. The server sends each link as its own
          // WhatsApp message so every listing gets its own preview banner.
          attachments: (item.attachments || []).filter((a) => a.type === "link" && a.url),
          attachmentsCurated: !!item._attachmentsCurated,
          newStage: (item.lead_stage && item.lead_stage !== item._originalStage) ? item.lead_stage : undefined,
          stageId: (item.lead_stage && item.lead_stage !== item._originalStage) ? (stageIdForName(item.lead_stage) || item.lead_stage_id || undefined) : (item.lead_stage_id || undefined),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) {
        item.error = `Webhook ${json.hookStatus ?? res.status}`;
        item.busy = false; item._approving = false; render();
        return;
      }
      for (let i = 1; i < blocks.length; i++) {
        await fetch(`${apiBase()}/send-message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ leadId: String(item.lead_id), message: blocks[i] }),
        }).catch(() => {});
      }
      openServerItem = null;
      await pollInbox();
    } catch (e) {
      item.error = String(e?.message || e);
      item.busy = false; item._approving = false;
      render();
    }
  }

  async function skipServer(item) {
    item.busy = true; render();
    try {
      await fetch(`${apiBase()}/skip`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suggestionId: item.id }),
      });
    } catch {}
    openServerItem = null;
    await pollInbox();
  }

  // Mark a lead as "broker already replied" — clears the LIVE suggestion.
  async function brokerReplied(item) {
    item.busy = true; render();
    try {
      await fetch(`${apiBase()}/broker-replied`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadId: item.lead_id }),
      });
    } catch {}
    openServerItem = null;
    await pollInbox();
  }

  // "No reply needed": the lead's last message was a closer (bye / thanks / 👍).
  // Drop it from LIVE but keep it in the bot — the server schedules an adaptive
  // follow-up so it re-surfaces in PUSH later when the lulled thread needs a nudge.
  async function noReplyNeeded(item) {
    item.busy = true; render();
    try {
      await fetch(`${apiBase()}/no-reply-needed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadId: String(item.lead_id), brokerId: settings.brokerName || "anon" }),
      });
    } catch {}
    openServerItem = null;
    await pollInbox();
  }

  // Extract the leadId from AmoCRM URL e.g. /leads/detail/22497375
  function detectLeadIdFromUrl() {
    const m = location.pathname.match(/\/leads\/detail\/(\d+)/);
    return m ? m[1] : null;
  }

  // Try to detect an outgoing (broker) message in AmoCRM conversation DOM.
  // Returns true if we can confirm broker replied after lead's last message.
  function detectOutgoingInDom() {
    const selectors = [
      ".amoCRM-private-eventfeed__item--outgoing",
      ".feed-note--outgoing",
      "[data-note-type='outgoing_message']",
      ".amocrm-messenger__message--outgoing",
      ".messenger-dialog__message--outgoing",
      ".amoCRM-inner-panel .feed-note.outgoing",
      // Generic: any element whose class contains "outgoing"
    ];
    for (const sel of selectors) {
      try {
        if (document.querySelectorAll(sel).length > 0) return true;
      } catch {}
    }
    // Fallback: scan all .feed-note elements for WAhelp/broker sender pattern
    const notes = document.querySelectorAll(".feed-note, .amoCRM-Private-EventItem");
    for (const n of notes) {
      const cls = (n.className || "").toLowerCase();
      if (cls.includes("outgoing") || cls.includes("sent")) return true;
    }
    return false;
  }

  // Which inbox tab a server item belongs to — the SINGLE source of truth shared
  // by pollInbox bucketing, the detail-render guard, and auto-open. REACH =
  // qualification follow-up stages (they are kind=push but live in their own
  // tab); LIVE = kind live; everything else = push. Before this existed, an
  // auto-opened reach lead had activeTab="reach" while its card was kind="push",
  // so the detail guard (openServerItem.kind === activeTab) failed and the lead
  // fell back to the LIST with just an "Open now" chip instead of expanding.
  const _REACH_STAGE_KEYS = ["1st follow up", "2nd follow up", "final follow up"];
  function isReachStageName(stage) {
    if (!stage) return false;
    const s = String(stage).toLowerCase();
    return _REACH_STAGE_KEYS.some((q) => s.includes(q));
  }
  function tabForItem(item) {
    if (!item) return "live";
    if (item.kind === "live") return "live";
    return isReachStageName(item.lead_stage) ? "reach" : "push";
  }

  // ── Auto-detect: when broker opens a lead URL in CRM, auto-open its suggestion
  // or generate a fresh on-demand one if the lead isn't queued yet.
  async function onLeadNavigation() {
    const leadId = detectLeadIdFromUrl();
    // Already viewing THIS lead in the bot → keep the detail open. Fixes the
    // bot "falling off" to the general list when the broker opens, in amoCRM,
    // the same lead they're already looking at in the copilot.
    if (leadId && openServerItem && String(openServerItem.lead_id) === String(leadId)) {
      autoLeadId = leadId;
      return;
    }
    if (leadId === autoLeadId) return; // same lead, nothing to do
    autoLeadId = leadId;

    if (!leadId) {
      // Navigated away from a lead page — clear on-demand item if it was auto-opened
      if (openServerItem?._autoDetect) { openServerItem = null; render(); }
      return;
    }

    // Refresh inbox first so we have the latest pending suggestions
    await pollInbox();
    if (autoLeadId !== leadId) return; // navigated again while awaiting

    // Check if there's already a pending suggestion for this lead
    const live  = inbox.live.find(i => String(i.lead_id) === String(leadId));
    const reach = inbox.reach.find(i => String(i.lead_id) === String(leadId));
    const push  = inbox.push.find(i => String(i.lead_id) === String(leadId));
    if (live || reach || push) {
      const row = live || reach || push;
      // Map raw API row to the same structure as li.onclick so it.text is populated.
      // The raw row uses suggestion_text; the render reads it.text — without this mapping
      // the text is empty and only attachments (Blueprint/Podcast) render.
      const _termStage = row.suggested_stage_terminal ? (row.suggested_stage || "") : "";
      const _initStageChecked = _termStage
        ? true
        : (typeof detectStageTransition === "function" ? detectStageTransition(row.suggestion_text) : false);
      const _initNextStages = typeof stagesAfterCurrent === "function" ? stagesAfterCurrent(row.lead_stage || "") : [];
      openServerItem = {
        id: row.id,
        lead_id: row.lead_id,
        kind: row.kind,
        followup_level: row.followup_level,
        responsible_user: row.responsible_user,
        lead_name: row.lead_name || null,
        lead_stage: row.lead_stage || null,
        last_message_at: row.last_message_at || null,
          next_followup_at: row.next_followup_at || null,
        last_lead_channel: row.last_lead_channel || null,
        next_followup_at: row.next_followup_at || null,
        suggested_followup_at: row.suggested_followup_at || null,
        profile_temperature: row.profile_temperature || null,
        profile_temperature_source: row.profile_temperature_source || null,
        lead_stage_id: row.lead_stage_id || null,
        objection_category: row.objection_category || null,
        text: row.suggestion_text || "",
        original: row.suggestion_text || "",
        lastLeadText: row.last_lead_text || "",
        recentMessages: Array.isArray(row.recent_messages) ? row.recent_messages : [],
        recent_messages: row.recent_messages || [],
        task_hint: row.task_hint || null,
        attachments: Array.isArray(row.attachments) ? row.attachments : [],
        rated: null,
        loading: false,
        busy: false,
        error: "",
        _stageChecked: _initStageChecked,
        _selectedStage: _termStage || (_initStageChecked && _initNextStages.length > 0 ? _initNextStages[0] : ""),
        _skipExpanded: false,
        _skipTaskMode: false,
        _skipTaskVoice: "",
        _originalStage: row.lead_stage || null,
        suggested_stage: row.suggested_stage || null,
        suggested_stage_reason: row.suggested_stage_reason || null,
        suggested_stage_terminal: !!row.suggested_stage_terminal,
        _stageExpanded: false,
      };
      activeTab = tabForItem(openServerItem);
      collapsed = false;
      manuallyOpen = true;
      render();
      return;
    }

    // No pending suggestion in inbox — call suggest endpoint.
    // For push stages: server returns script template (no OpenAI needed).
    // For live stages: server calls OpenAI.
    const placeholder = {
      _autoDetect: true,
      id: null,
      lead_id: leadId,
      lead_name: null,
      kind: "live",
      loading: true,
      text: "",
      suggestion: "",
      original: "",
      busy: false,
      error: "",
      revisionChain: [],
      recentMessages: [],
      recent_messages: [],
    };
    openServerItem = placeholder;
    activeTab = "live";
    collapsed = false;
    manuallyOpen = true;
    render();

    try {
      const r = await fetch(settings.apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          guide: settings.guide,
          // leadId MUST be top-level — the server reads body.leadId to pull the
          // lead's full conversation from the DB. Without it the AI gets no
          // history and writes a generic "I don't have any details yet" reply.
          leadId,
          lead: { name: `Lead ${leadId}`, company: "", stage: "", leadId },
          messages: [],
          brokerName: settings.brokerName || "",
          brokerId: settings.brokerName || "anon",
          outputLanguage: settings.outputLanguage || "English",
          includeFullContext: true,
        }),
      });
      if (autoLeadId !== leadId) return;
      if (r.ok) {
        const d = await r.json();
        // Set conversation history from server response
        if (d.recent_messages?.length) {
          placeholder.recentMessages = d.recent_messages;
          placeholder.recent_messages = d.recent_messages;
        }
        // Re-check inbox — in case a real pending suggestion was created
        await pollInbox();
        if (autoLeadId !== leadId) return;
        const freshLive  = inbox.live.find(i => String(i.lead_id) === String(leadId));
        const freshReach = inbox.reach.find(i => String(i.lead_id) === String(leadId));
        const freshPush  = inbox.push.find(i => String(i.lead_id) === String(leadId));
        if (freshLive || freshReach || freshPush) {
          openServerItem = freshLive || freshReach || freshPush;
          activeTab = tabForItem(openServerItem);
        } else if (openServerItem?._autoDetect) {
          placeholder.loading = false;
          placeholder.text = d.text || "";
          placeholder.suggestion = d.text || "";
          placeholder.original = d.text || "";
          if (d.lead_stage) placeholder.lead_stage = d.lead_stage;
          // Frame by WHO SPOKE LAST: if we already replied, this is a follow-up
          // (push), not a fresh incoming (live) — otherwise an already-answered
          // lead you just opened in the CRM wrongly appears under LIVE. Fall back
          // to the server's kind when the lead genuinely wrote last.
          const _msgs = Array.isArray(placeholder.recent_messages) ? placeholder.recent_messages : [];
          const _last = _msgs[_msgs.length - 1];
          const _weWroteLast = !!_last && _last.from === "us";
          placeholder.kind = _weWroteLast ? "push" : (d.kind || "live");
          activeTab = tabForItem(placeholder);
        }
      } else {
        if (openServerItem?._autoDetect) {
          placeholder.loading = false;
          placeholder.error = `AI error (HTTP ${r.status})`;
        }
      }
    } catch (e) {
      if (autoLeadId === leadId && openServerItem?._autoDetect) {
        placeholder.loading = false;
        placeholder.error = String(e?.message || e).slice(0, 120);
      }
    }
    render();
  }

  // Auto-sync: when broker opens a lead in AmoCRM, detect if they already replied
  // and clear any stale LIVE or PUSH suggestions without manual interaction.
  async function tryAutoSync() {
    if (editing) return; // never interrupt while broker is actively editing
    const leadId = detectLeadIdFromUrl();
    if (!leadId) return;
    // Check both LIVE and PUSH — broker may have replied to either
    const hasPending =
      inbox.live.some((i) => String(i.lead_id) === String(leadId)) ||
      inbox.reach.some((i) => String(i.lead_id) === String(leadId)) ||
      inbox.push.some((i) => String(i.lead_id) === String(leadId));
    if (!hasPending) return;
    // Only try DOM detection if message nodes are loaded
    const anyNotes = document.querySelectorAll(".feed-note, .amoCRM-Private-EventItem");
    if (anyNotes.length === 0) return; // page not ready yet
    if (detectOutgoingInDom()) {
      try {
        await fetch(`${apiBase()}/broker-replied`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ leadId }),
        });
        if (openServerItem && String(openServerItem.lead_id) === String(leadId)) {
          openServerItem = null;
        }
        await pollInbox();
      } catch {}
    }
  }

  // AI rewrite for server-side suggestions (Live tab).
  // Uses multi-turn revisionChain so the AI sees every previous draft+feedback step,
  // and sends the full recent_messages conversation for proper context.
  async function rewriteServer(item, feedback) {
    // Build revision chain: each step = {draft, feedback} as produced+requested
    if (!item.revisionChain) item.revisionChain = [];
    // The current item.text is the draft we're revising
    item.revisionChain.push({ draft: item.text, feedback: feedback.trim() });

    // Use full conversation context from polling (recent_messages), not just lastLeadText
    const conversationMsgs = (item.recent_messages || []).map(m => ({
      from: m.from === "us" ? "broker" : "lead",
      text: m.text,
    }));
    // Fallback: if no recent_messages, use lastLeadText as single lead message
    const messages = conversationMsgs.length > 0
      ? conversationMsgs
      : (item.last_lead_text ? [{ from: "lead", text: item.last_lead_text }] : []);

    item.loading = true; item.error = ""; render();
    try {
      const res = await fetch(settings.apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          guide: settings.guide,
          lead: {
            name: item.lead_name ? item.lead_name : `Lead ${item.lead_id}`,
            company: "",
            stage: item.lead_stage || item.kind || "",
          },
          messages,
          brokerName: settings.brokerName,
          brokerId: settings.brokerName,
          leadId: item.lead_id,
          revisionChain: item.revisionChain,
          outputLanguage: settings.outputLanguage || "English",
          // Broker-pasted screenshot of the real amoCRM chat → ground-truth
          // context so the bot re-reads the situation, not just tweaks wording.
          image: item._aiImage || undefined,
          // Send current links so the server can re-pick them when the revision
          // is about the listings (merged from Nikita's ext71 fix).
          attachments: (item.attachments || []).filter((a) => a.type === "link" && a.url),
          attachmentsCurated: !!item._attachmentsCurated,
        }),
      });
      if (!res.ok) throw new Error(`API ${res.status}`);
      const json = await res.json();
      if (json?.text) item.text = json.text;
      // A revision about the listings re-picks them server-side; a wording-only
      // revision leaves them alone (server returns null then). Links the broker
      // added by hand stay — they overrode the bot on purpose. (Nikita's ext71 fix.)
      if (Array.isArray(json?.attachments)) {
        const keep = (item.attachments || []).filter((a) => a._broker);
        item.attachments = json.attachments.concat(keep);
      }
      // Screenshot may reveal the real temperature — apply the bot's re-assessment.
      if (json?.reassessed_temperature) {
        item.profile_temperature = json.reassessed_temperature;
        item.profile_temperature_source = "broker";
        try {
          fetch(`${apiBase()}/set-temperature`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ leadId: String(item.lead_id), temperature: json.reassessed_temperature, brokerId: settings.brokerName || "anon" }) });
        } catch {}
        panelToast = `🌡 Temperature re-read → ${json.reassessed_temperature}`;
        setTimeout(() => { panelToast = null; render(); }, 2600);
      }
      item._aiImage = null; // consumed
    } catch (e) {
      item.error = e?.message || "AI rewrite failed";
    } finally {
      item.loading = false; render();
    }
  }

  async function rateServer(item, verdict) {
    if (item.rated) return;
    item.rated = verdict;
    try {
      const feedbackUrl = settings.apiUrl.replace(/\/suggest(\/)?$/, "/feedback");
      await fetch(feedbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          suggestionId: item.id,
          brokerId: settings.brokerName,
          brokerName: settings.brokerName,
          verdict,
          finalText: item.text,
        }),
      });
    } catch {}
    render();
  }

  // Fetch live theme (CSS + labels) from the server. Same origin as the suggest API.
  async function fetchTheme() {
    try {
      const themeUrl = settings.apiUrl.replace(/\/suggest(\/)?$/, "/theme");
      const res = await fetch(themeUrl, { cache: "no-cache" });
      if (!res.ok) return;
      const json = await res.json();
      // CSS is managed in the extension bundle; server CSS override is disabled
      // so the built-in design is never replaced by a stale server stylesheet.
      if (json?.labels && typeof json.labels === "object") {
        theme.labels = json.labels;
      }
      render();
    } catch { /* keep built-in defaults */ }
  }

  async function fetchStageOptions() {
    try {
      const url = `${apiBase()}/stage-options`;
      const res = await fetch(url, { cache: "no-cache" });
      if (!res.ok) return;
      const json = await res.json();
      if (Array.isArray(json.stages) && json.stages.length > 0) {
        PIPELINE_STAGES = json.stages;
      }
    } catch { /* keep built-in defaults */ }
  }

  function matchesUrl() {
    const filter = settings.urlFilter?.trim();
    if (!filter) return true;
    const parts = filter.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const href = location.href.toLowerCase();
    return parts.some((p) => href.includes(p));
  }

  function activeItem() {
    return queue.find((q) => Date.now() >= q.dueAt) || null;
  }
  function nextDueInSec() {
    const upcoming = queue.filter((q) => Date.now() < q.dueAt).sort((a, b) => a.dueAt - b.dueAt)[0];
    return upcoming ? Math.max(0, Math.ceil((upcoming.dueAt - Date.now()) / 1000)) : null;
  }

  let lastRenderKey = "";
  function currentKey() {
    const it = activeItem();
    const waitPart = !it && manuallyOpen ? `|${Math.ceil((nextDueInSec() ?? -1) / 10)}` : "";
    const inboxPart = `|${inbox.live.length}-${inbox.reach.length}-${inbox.push.length}|${activeTab}|${openServerItem?.id || "_"}|${openServerItem?.busy ? 1 : 0}|${openServerItem?.error || ""}`;
    return `${it?.lead.id || "_"}|${collapsed}|${manuallyOpen}|${editing}|${it?.loading ? 1 : 0}|${it?.suggestion?.length || 0}|${it?.error || ""}${waitPart}${inboxPart}`;
  }
  function tick() {
    if (editing) return; // never re-render while broker is actively editing
    const it = activeItem();
    if (it && !it.generated && !it.loading) {
      it.generated = true;
      generate(it);
      return;
    }
    const key = currentKey();
    if (key !== lastRenderKey) {
      render();
    }
  }

  async function generate(item, refine) {
    // If this is a revision, push step into chain; first call initialises
    if (refine?.feedback) {
      if (!item.revisionChain) item.revisionChain = [];
      item.revisionChain.push({ draft: refine.previous || item.suggestion, feedback: refine.feedback });
    }

    item.loading = true; item.error = ""; render();
    try {
      const payload = {
        guide: settings.guide,
        lead: { name: item.lead.name, company: item.lead.company, stage: item.lead.stage },
        messages: item.lead.messages.map((m) => ({ from: m.from, text: m.text })),
        brokerName: settings.brokerName,
        brokerId: settings.brokerName,
        leadId: item.lead.id,
      };
      // Use multi-turn revisionChain when revisions exist; otherwise fresh generation
      if (item.revisionChain && item.revisionChain.length > 0) {
        payload.revisionChain = item.revisionChain;
      }
      const res = await fetch(settings.apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`API ${res.status}`);
      const json = await res.json();
      item.suggestion = json.text || "";
      item.rationale = json.rationale || "";
      item.suggestionId = json.suggestionId || null;
    } catch (e) {
      item.error = e?.message || "Failed to reach copilot API";
      item.suggestion = ""; item.rationale = "";
    } finally {
      item.loading = false; render();
    }
  }

  async function sendFeedback(item, verdict, finalText) {
    if (!item.suggestionId) return;
    try {
      const feedbackUrl = settings.apiUrl.replace(/\/suggest(\/)?$/, "/feedback");
      await fetch(feedbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          suggestionId: item.suggestionId,
          brokerId: settings.brokerName,
          brokerName: settings.brokerName,
          verdict,
          finalText: finalText || null,
        }),
      });
    } catch (e) {
      console.log("feedback failed", e);
    }
  }

  function approve(item) {
    if (!item.suggestion) return;
    // Save revision chain as corrections if broker edited before approving
    if (item.revisionChain && item.revisionChain.length > 0) {
      saveCorrections(item.revisionChain, item.lead?.stage || "");
    }
    const links = (item.attachments || []).filter((a) => a.type === "link").map((a) => `${a.label}: ${a.url}`).join("\n");
    const text = links ? `${item.suggestion}\n\n${links}` : item.suggestion;
    navigator.clipboard.writeText(text).catch(() => {});
    sendFeedback(item, "approved", item.suggestion);
    removeFromQueue(item);
  }
  function skip(item) { sendFeedback(item, "skipped"); removeFromQueue(item); }
  function removeFromQueue(item) {
    queue = queue.filter((q) => q !== item);
    editing = false; manuallyOpen = false;
    // Next due item (if any) should also surface as a bubble, not auto-open.
    collapsed = true;
    render();
  }

  function enqueueFollowUp(lead, delayMs = 0) {
    if (!lead?.id || !lead?.name) return;
    const existing = queue.find((q) => q.lead.id === lead.id);
    const target = existing || {
      lead,
      dueAt: Date.now() + Math.max(0, delayMs),
      suggestion: "",
      rationale: "",
      suggestionId: null,
      attachments: [],
      loading: false,
      error: "",
      generated: false,
    };
    target.lead = { ...target.lead, ...lead };
    target.dueAt = Date.now() + Math.max(0, delayMs);
    if (!existing) queue.push(target);
    collapsed = true;
    manuallyOpen = false;
    render();
  }

  function render() {
    lastRenderKey = currentKey();
    mount.innerHTML = "";
    const item = activeItem();
    const total = inbox.live.length + inbox.reach.length + inbox.push.length + activeCount();

    // Collapsed bubble — always visible (sleep state when nothing pending).
    if (collapsed && !manuallyOpen) {
      const cls = total === 0 ? "bubble sleep" : "bubble";
      const dot = total > 0 ? `<span class="dot">${total}</span>` : "";
      const b = el(`<button class="${cls}" title="Open copilot">✦${dot}</button>`);
      b.onclick = () => {
        collapsed = false;
        manuallyOpen = true;
        if (inbox.live.length > 0) activeTab = "live";
        else if (inbox.reach.length > 0) activeTab = "reach";
        else if (inbox.push.length > 0) activeTab = "push";
        else activeTab = "live";
        render();
      };
      mount.appendChild(b);
      return;
    }

    // Expanded panel — always wrap with tab bar.
    const panel = el(`<div class="panel"></div>`);

    // ── Resizable window: drag the top-left grip to grow up/left. Persisted. ──
    if (panelSize && panelSize.w) panel.style.width = panelSize.w + "px";
    // Height: the broker's resized height if they set one, otherwise a comfortable
    // EXPANDED default on first install. Without an explicit height the flex body
    // collapses the conversation/suggestion panes to a sliver — new brokers opened
    // the bot squished and didn't know it could be resized. They can still drag the
    // grip to change it; this is only the starting size.
    {
      const _defaultH = Math.min(760, Math.max(480, (window.innerHeight || 900) - 40));
      const _h = (panelSize && panelSize.h) ? panelSize.h : _defaultH;
      panel.style.height = _h + "px";
      panel.style.maxHeight = "none";
    }
    const grip = el(`<div class="resize-grip" title="Drag to resize"></div>`);
    grip.addEventListener("mousedown", (e) => {
      e.preventDefault(); e.stopPropagation();
      const rect = panel.getBoundingClientRect();
      const scale = __lastScale || 1;
      const startX = e.clientX, startY = e.clientY;
      const startW = rect.width / scale, startH = rect.height / scale;
      const onMove = (ev) => {
        let w = startW + (startX - ev.clientX) / scale;   // anchored bottom-right → left grows width
        let h = startH + (startY - ev.clientY) / scale;   // up grows height
        w = Math.max(340, Math.min(w, (window.innerWidth - 24) / scale));
        h = Math.max(300, Math.min(h, (window.innerHeight - 24) / scale));
        panel.style.width = w + "px";
        panel.style.height = h + "px";
        panel.style.maxHeight = "none";
        panelSize = { w: Math.round(w), h: Math.round(h) };
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.userSelect = "";
        try { chrome.storage.local.set({ copilotPanelSize: panelSize }); } catch {}
      };
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
    panel.appendChild(grip);

    // Header
    const hd = el(`
      <div class="hd">
        <div class="hdtop">
          <div class="badge">
            <div class="spark">✦</div>
            <div style="min-width:0">
              <div class="who">Copilot inbox</div>
              <div class="sub">${esc(settings.brokerName || "")}</div>
            </div>
          </div>
          <div class="icons">
            <button class="ib" data-refresh title="Refresh">⟳</button>
            <button class="ib" data-opts title="Settings">⚙</button>
            <button class="ib" data-min title="Hide">−</button>
          </div>
        </div>
      </div>
    `);
    panel.appendChild(hd);

    // Tabs
    const liveCnt  = inbox.live.length;
    const reachCnt = inbox.reach.length;
    const pushCnt  = inbox.push.length;
    const draftCnt = activeCount();
    const tabs = el(`
      <div class="tabs">
        <div class="tabwrap">
          <button class="tab live ${activeTab === "live" ? "on" : ""}" data-tab="live" title="Live replies — lead just answered">
            ${liveCnt > 0 ? '<span class="pulse"></span>' : '<span class="dot"></span>'}
            Live<span class="cnt">${liveCnt}</span>
          </button>
          <button class="tab reach ${activeTab === "reach" ? "on" : ""}" data-tab="reach" title="Reach — квалификация (1st/2nd/Final Follow Up)">
            <span class="dot"></span>
            Reach<span class="cnt">${reachCnt}</span>
          </button>
          <button class="tab push ${activeTab === "push" ? "on" : ""}" data-tab="push" title="Push — активный пайплайн">
            <span class="dot"></span>
            Push<span class="cnt">${pushCnt}</span>
          </button>
        </div>
      </div>
    `);
    panel.appendChild(tabs);

    // Panel-level toast (task / stage feedback)
    const toastEl = el(`<div class="panel-toast${panelToast ? (panelToast.startsWith("⚠") ? " err" : "") : ""}" style="display:${panelToast ? "block" : "none"}">${panelToast ? esc(panelToast) : ""}</div>`);
    panel.appendChild(toastEl);

    // Body wrapper (scroll)
    const body = el(`<div class="body" style="padding:0; background:#273444"></div>`);
    panel.appendChild(body);

    renderServerTab(body, activeTab);

    // When a card is open, auto-scroll to bottom so suggestion is visible first;
    // user can scroll UP to see conversation context above.
    if (openServerItem) {
      requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
    }

    // Header wiring
    hd.querySelector("[data-opts]")?.addEventListener("click", (e) => { e.stopPropagation(); try { chrome.runtime.openOptionsPage?.(); } catch {} });
    hd.querySelector("[data-min]")?.addEventListener("click", (e) => { e.stopPropagation(); collapsed = true; manuallyOpen = false; openServerItem = null; render(); });
    hd.querySelector("[data-refresh]")?.addEventListener("click", (e) => { e.stopPropagation(); pollInbox(); });
    tabs.querySelectorAll("[data-tab]").forEach((b) => {
      b.addEventListener("click", () => {
        activeTab = b.getAttribute("data-tab");
        openServerItem = null;
        render();
      });
    });

    mount.appendChild(panel);
  }

  // ----- Live / Push tab -----
  function renderServerTab(container, kind) {
    const rawList = inbox[kind] || [];
    // Sort helpers for PUSH tab
    const _PUSH_STAGE_ORDER = ['contact established', 'needs assessed', 'options sent', 'option send'];
    function _pushTaskScore(row) {
      const nfa = row.next_followup_at;
      if (!nfa) return 1e9; // no task → bottom
      const due = new Date(nfa);
      const n = new Date();
      const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
      const todayDay = new Date(n.getFullYear(), n.getMonth(), n.getDate());
      const diff = Math.round((dueDay - todayDay) / 864e5);
      return Math.max(0, -diff); // today=0, overdue1d=1, overdue2d=2 ...
    }
    function _pushStageScore(row) {
      const s = (row.lead_stage || '').toLowerCase();
      const idx = _PUSH_STAGE_ORDER.findIndex(q => s.includes(q));
      return idx === -1 ? 999 : idx;
    }
    const list = [...rawList].sort((a, b) => {
      // Pin the lead currently open in amoCRM to the very top
      const aPin = autoLeadId && String(a.lead_id) === String(autoLeadId) ? 0 : 1;
      const bPin = autoLeadId && String(b.lead_id) === String(autoLeadId) ? 0 : 1;
      if (aPin !== bPin) return aPin - bPin;
      // PUSH tab: the server (suggestions.ts) now ranks PUSH by the adaptive
      // priority score (stage → temperature/potential → task urgency → warmth →
      // aging). Preserve that server order verbatim instead of re-sorting here.
      if (kind === 'push') {
        return 0;
      }
      return 0;
    });

    // Editor view if a card is open — mirrors the Drafts card structure.
    // Match by the item's TAB (not raw kind): a reach lead is kind=push but
    // belongs to the "reach" tab, so keying on kind hid its detail there.
    if (openServerItem && tabForItem(openServerItem) === kind) {
      const it = openServerItem;
      // Make the scroll container a flex column so the detail view fills the
      // panel height (flex:1 resolves reliably; percentage heights did not) —
      // this is what removes the dead space below the buttons.
      container.style.display = "flex";
      container.style.flexDirection = "column";
      // The detail container itself NEVER scrolls — the header (chips) stays
      // pinned at the top and the action buttons stay pinned at the bottom.
      // Only the two middle blocks (conversation / suggestion) scroll & resize.
      container.style.overflowY = "hidden";
      const reason = kind === "live"
        ? `Lead ${it.lead_id} just replied${it.responsible_user ? ` (owner: ${it.responsible_user})` : ""} — keep the thread warm and reference what they said.`
        : `Silent lead ${it.lead_id} — follow-up #${it.followup_level || 1}. Soft nudge with a new angle, don't repeat your last message.`;
      const accent = kind === "live" ? "#34d399" : "#fbbf24";
      const bgTint = kind === "live" ? "rgba(52,211,153,.08)" : "rgba(251,191,36,.08)";
      const icon = "✦";
      const lbl = L("reasonLabel","Why this follow-up now");
      // Build conversation thread HTML
      const msgs = it.recentMessages || (Array.isArray(it.recent_messages) ? it.recent_messages : []);
      const threadHtml = msgs.length > 0
        ? msgs.map((m) => {
            const isUs = m.from === "us";
            const senderLabel = isUs ? "You" : "Lead";
            const senderColor = isUs ? "#64b5f6" : "#34d399";
            const bubbleBg = isUs ? "rgba(33,150,243,0.18)" : "rgba(52,211,153,0.15)";
            const bubbleBorder = isUs ? "rgba(33,150,243,0.45)" : "rgba(52,211,153,0.4)";
            const bubbleAccent = isUs ? "#2196f3" : "#34d399";
            const bubbleColor = isUs ? "#daeeff" : "#c8f5e0";
            const timeStr = m.at ? (() => { const d = new Date(m.at); return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " · " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); })() : "";
            return `<div style="display:flex;flex-direction:column;gap:4px;width:100%">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;padding:0 3px">
                <span style="font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:${senderColor}">${esc(senderLabel)}</span>
                ${timeStr ? `<span style="font-size:10px;color:#6e8099">${esc(timeStr)}</span>` : ""}
              </div>
              <div style="padding:8px 11px;border-radius:6px;font-size:13px;line-height:1.52;white-space:pre-wrap;word-break:break-word;width:100%;box-sizing:border-box;background:${bubbleBg};border:1px solid ${bubbleBorder};border-left:3px solid ${bubbleAccent};color:${bubbleColor}">${linkify(esc(m.text))}</div>
            </div>`;
          }).join("")
        : `<div style="font-size:12px;color:#5e6e82;text-align:center;padding:8px 0">No conversation history yet</div>`;

      // Reuse the exact Drafts rating helper. Force suggestionId so rating renders for server rows.
      const ratingHtml = renderRating({ suggestionId: it.id, rated: it.rated });
      const amoUrl = `https://unicornproperty.amocrm.ru/leads/detail/${esc(it.lead_id)}`;
      // Conversation vs suggestion split — both panes grow to fill the panel (no
      // dead space), and the divider between them is draggable (persisted).
      const _cg = Math.max(10, Math.round(convSplit * 100));
      const _lg = Math.max(10, Math.round((1 - convSplit) * 100));
      const view = el(`
        <div style="display:flex;flex-direction:column;flex:1 1 auto;min-height:0">
          <div class="cardtop">
            <button class="back" data-back>← Back to ${kind === "live" ? "Live" : kind === "reach" ? "Reach" : "Push"}</button>
            <button class="openlead" data-openlead="${amoUrl}">↗ Open Lead</button>
          </div>
          <div class="lead-hdr">
            <span class="lead-hdr-name">${it.lead_name ? esc(it.lead_name) : "Lead " + esc(it.lead_id)}</span>
            ${it.kind !== "live" ? `<button data-taskchip style="border:none;background:none;padding:0;cursor:pointer" title="Reschedule follow-up">${taskStatusBadge(it.next_followup_at) || '<span style="font-size:10px;font-weight:700;color:#94a3b8;background:rgba(148,163,184,.12);border-radius:3px;padding:1px 6px">📅 Set task</span>'}</button>` : ""}
            ${tempChipHtml(it)}
          </div>
          ${it._tempEdit ? tempPickerHtml(it) : ""}
          ${it._taskReschedule ? reschedulePopoverHtml(it) : ""}
          <div class="thread" style="flex:${_cg} 1 0;min-height:0">
            <div class="thread-lbl">💬 Conversation</div>
            ${threadHtml}
          </div>
          <div class="conv-divider" data-convdiv title="Drag to resize" style="flex:0 0 auto;height:11px;cursor:row-resize;display:flex;align-items:center;justify-content:center;background:#16202e;border-top:1px solid #2a3a50;border-bottom:1px solid #2a3a50">
            <span style="width:44px;height:3px;border-radius:2px;background:#4a5a70"></span>
          </div>
          <div class="lowerpane" style="flex:${_lg} 1 0;min-height:0;overflow-y:auto;display:flex;flex-direction:column;scrollbar-width:thin;scrollbar-color:#3a4a5e transparent">
          <div class="body" style="flex:0 0 auto;background:transparent;padding:12px 14px 10px;${editing ? 'display:flex;flex-direction:column;gap:10px;' : ''}">
            ${!editing ? `<div class="label">${esc(L("suggestedLabel","Suggested message"))}</div>` : ""}
            ${it.loading
              ? `<div class="skel"><div style="width:100%"></div><div style="width:92%"></div><div style="width:80%"></div><div style="width:60%"></div></div>`
              : editing
                ? `<textarea class="ta" data-ed placeholder="Edit message…">${esc(editValue)}</textarea>
                   ${renderAttachments(it, true)}
                   <div style="display:flex;flex-direction:column;gap:6px;margin-top:8px">
                     <button data-attpick style="background:rgba(96,165,250,.14);color:#60a5fa;border:1px solid rgba(96,165,250,.35);border-radius:6px;padding:8px 11px;font-size:12px;font-weight:700;cursor:pointer;width:100%">🌐 Choose on site</button>
                     <div class="att-add-row" style="display:flex;gap:6px"><input class="att-add-input" data-attaddurl placeholder="…or paste a property link" style="flex:1;min-width:0;background:#0f1826;color:#e6e8ee;border:1px solid #2a3a50;border-radius:6px;padding:7px 9px;font-size:12px;font-family:inherit"><button class="att-add-btn" data-attadd style="background:#1b2740;color:#b6bccd;border:1px solid #2a3a50;border-radius:6px;padding:7px 11px;font-size:12px;font-weight:600;cursor:pointer;flex:none">+ Add</button></div>
                   </div>
                   <input type="file" data-fileinput accept="image/*" style="display:none">
                   <div class="ai-input-wrap" style="border-top:1px solid #2a3a50;padding-top:10px;margin:0 -2px;"><textarea class="aiinput" data-ai placeholder="Tell AI what to change — or paste a screenshot…" rows="2" style="resize:none;line-height:1.4;"></textarea><div class="ai-btn-row"><button class="ai-mic-btn" data-voice title="Voice input">🎤 Dictate</button><button class="ai-send-btn" data-rewrite ${it.loading ? "disabled" : ""} title="Send">↑ Send</button></div></div>
                   `
                : `<div class="msg">${esc(it.text)}</div>${renderAttachments(it, false)}${ratingHtml}`}
            ${it.error ? `<div class="err" style="margin-top:8px">${esc(it.error)}</div>` : ""}
          </div>

          ${!editing ? (() => {
            const nextStages = stagesAfterCurrent(it.lead_stage);
            const stageChecked = !!it._stageChecked;
            const taskChecked = !!it._taskChecked;
            // The stage now follows the conversation on its own (server-side
            // classification applied on send), so the manual picker is collapsed
            // out of the way. It stays one tap away for the cases the bot won't
            // do itself: confirming a close, setting an administrative stage
            // (Mailing, Long-Term Cycle), or overriding a misjudged call.
            const stageOpen = !!(it._stageExpanded || it.suggested_stage_terminal || stageChecked);
            const _stageAhead = it.suggested_stage && !it.suggested_stage_terminal
              && it.suggested_stage.toLowerCase() !== String(it.lead_stage || "").toLowerCase();
            const stageHint = it.suggested_stage
              ? `<div class="stage-hint" style="font-size:11.5px;color:#7dd3fc;background:rgba(45,212,191,.08);border:1px solid rgba(45,212,191,.2);border-radius:6px;padding:6px 9px;margin:0 14px 8px">${
                  it.suggested_stage_terminal
                    ? `⚠️ Confirm to close: &ldquo;${esc(it.suggested_stage)}&rdquo;`
                    : _stageAhead
                    ? `📈 This lead looks further along — move to &ldquo;${esc(it.suggested_stage)}&rdquo;?`
                    : `✓ Stage moves to &ldquo;${esc(it.suggested_stage)}&rdquo; on send`
                }${it.suggested_stage_reason ? ` <span style="color:#6b7488">(${esc(it.suggested_stage_reason)})</span>` : ""}${
                  _stageAhead ? ` <button data-movestage style="margin-left:6px;background:rgba(45,212,191,.28);color:#c7f9ee;border:none;border-radius:5px;padding:2px 9px;font-size:11px;font-weight:700;cursor:pointer">→ Move now</button>` : ""
                }</div>`
              : "";
            return `
              ${stageHint}
              ${!stageOpen ? `<button data-stagetoggle style="background:none;border:none;color:#6b7488;font-size:12px;padding:4px 14px 8px;cursor:pointer;text-decoration:underline">Change stage ⌄</button>` : ""}
              <div class="action-row" data-stagerow ${stageOpen ? "" : 'style="display:none"'}>
                <input type="checkbox" class="ext-cb" data-stagecb ${stageChecked ? "checked" : ""}>
                <span class="action-row-lbl">${esc(L("nextStepLabel","Next step:"))}</span>
                <select class="ext-select" data-stageselect ${!stageChecked ? "disabled" : ""}>
                  <option value="">${esc(L("selectOption","— select —"))}</option>
                  ${nextStages.map(s => `<option value="${esc(s)}" ${it._selectedStage === s ? "selected" : ""}>${esc(s)}</option>`).join("")}
                </select>
              </div>

            `;
          })() : ""}
          </div>

          <div class="actions ${editing ? "editing" : ""}">
            ${editing
              ? `<button class="edit-ok" data-savedit title="Save">✓</button>
                 <button class="edit-x" data-canceledit title="Cancel">✕</button>`
              : it._stageConfirm
              ? `<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding:2px 0">
                   <span style="font-size:11px;color:#8a96a8;flex:0 0 100%;margin-bottom:3px">> Move to &ldquo;${esc(it._stageConfirm.newStage)}&rdquo;:</span>
                   <button class="primary" data-confirm-send-move ${it.busy ? "disabled" : ""}>✓ Send + Move</button>
                   <button class="secondary" data-confirm-move-only ${it.busy ? "disabled" : ""}>> Only Move</button>
                   <button class="secondary" data-confirm-cancel>✕ Cancel</button>
                 </div>`
              : `<button class="primary" data-approve ${it.busy || it.loading ? "disabled" : ""}>${it.busy ? "Sending…" : esc(L("approveBtn","✓ Approve"))}</button>
                 ${it.kind === 'live' ? `<button class="secondary" data-noreply ${it.busy ? "disabled" : ""}>${esc(L("noReplyBtn","🚫 No reply needed"))}</button>` : `<button class="secondary" data-skip ${it.busy ? "disabled" : ""}>${esc(L("skipBtn","✕ Skip"))}</button>`}
                 <button class="secondary" data-edit ${it.busy || it.loading ? "disabled" : ""}>${esc(L("editBtn","✎ Edit"))}</button>`}
          </div>
          ${it._skipExpanded && it.kind !== 'live' ? `
            <div style="padding:8px 12px 10px;border-top:1px solid #2a3a50">
              ${!it._skipTaskMode ? `
                <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                  <span style="font-size:12px;color:#8a96a8">Skip:</span>
                  <button class="mini" data-skipauto>✕ Continue auto schedule</button>
                  <button class="mini" data-skiptaskmode>📅 Set manual task</button>
                  <button class="mini" data-botexclude style="color:#e57373">⊘ Remove from bot</button>
                </div>
              ` : `
                <textarea class="aiinput" data-skiptaskvoice placeholder="Describe task by voice or text…" rows="2" style="resize:none;line-height:1.4;width:100%">${esc(it._skipTaskVoice||"")}</textarea>
                <div class="ai-btn-row" style="margin-top:4px">
                  <button class="ai-mic-btn" data-skiptaskvbtn title="Voice input">🎙 Dictate</button>
                  <button class="ai-send-btn" data-skiptaskconfirm ${it.busy ? "disabled" : ""}>✓ Set Task</button>
                </div>
              `}
            </div>
          ` : ""}
        </div>
      `);
      view.querySelector("[data-back]").onclick = () => { openServerItem = null; editing = false; render(); };

      // ── Draggable divider: resize conversation vs suggestion panes ───────────
      {
        const _div = view.querySelector("[data-convdiv]");
        const _threadEl = view.querySelector(".thread");
        const _lowerEl = view.querySelector(".lowerpane");
        if (_div && _threadEl && _lowerEl) {
          _div.addEventListener("mousedown", (e) => {
            e.preventDefault(); e.stopPropagation();
            const combined = _threadEl.getBoundingClientRect().height + _lowerEl.getBoundingClientRect().height;
            const startY = e.clientY;
            const startThread = _threadEl.getBoundingClientRect().height;
            const onMove = (ev) => {
              let nt = startThread + (ev.clientY - startY);
              nt = Math.max(48, Math.min(nt, combined - 48));
              const frac = nt / combined;
              _threadEl.style.flexGrow = Math.round(frac * 100);
              _lowerEl.style.flexGrow = Math.round((1 - frac) * 100);
              convSplit = frac;
            };
            const onUp = () => {
              document.removeEventListener("mousemove", onMove);
              document.removeEventListener("mouseup", onUp);
              document.body.style.userSelect = "";
              try { chrome.storage.local.set({ copilotConvSplit: convSplit }); } catch {}
            };
            document.body.style.userSelect = "none";
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
          });
        }
        // Show the newest message first: scroll the conversation pane to bottom.
        if (_threadEl) requestAnimationFrame(() => { _threadEl.scrollTop = _threadEl.scrollHeight; });
      }

      // ── Temperature: broker corrects the bot's read (sticky + bot learns) ────
      view.querySelector("[data-tempchip]")?.addEventListener("click", () => {
        it._tempEdit = !it._tempEdit; it._taskReschedule = false; render();
      });
      view.querySelectorAll("[data-tempset]").forEach((b) => b.addEventListener("click", async () => {
        const t = b.getAttribute("data-tempset");
        it.profile_temperature = t;
        it.profile_temperature_source = "broker";
        it._tempEdit = false;
        render();
        try {
          await fetch(`${apiBase()}/set-temperature`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ leadId: String(it.lead_id), temperature: t, brokerId: settings.brokerName || "anon" }),
          });
        } catch {}
        pollInbox();
      }));

      // ── Reschedule follow-up task straight from the chip (independent of skip/approve) ──
      view.querySelector("[data-taskchip]")?.addEventListener("click", () => {
        it._taskReschedule = !it._taskReschedule; it._tempEdit = false; render();
      });
      view.querySelector("[data-reschedcancel]")?.addEventListener("click", () => { it._taskReschedule = false; render(); });
      async function _doReschedule(iso) {
        if (!iso || it.busy) return;
        it.busy = true; render();
        try {
          const r = await fetch(`${apiBase()}/reschedule-task`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ leadId: String(it.lead_id), taskDate: iso }),
          });
          const j = await r.json().catch(() => ({}));
          if (r.ok) {
            const when = new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
            panelToast = j.amoOk === false ? `✓ Snoozed to ${when} (check amoCRM task)` : `✓ Task moved to ${when}`;
            openServerItem = null;
            await pollInbox();
            setTimeout(() => { panelToast = null; render(); }, 3500);
          } else {
            it.busy = false; panelToast = "⚠️ Reschedule failed"; render();
            setTimeout(() => { panelToast = null; render(); }, 3500);
          }
        } catch (e) {
          it.busy = false; panelToast = "⚠️ " + String(e?.message || e).slice(0, 50); render();
          setTimeout(() => { panelToast = null; render(); }, 3500);
        }
      }
      view.querySelectorAll("[data-reschedule]").forEach((b) => b.addEventListener("click", () => _doReschedule(b.getAttribute("data-reschedule"))));
      view.querySelector("[data-reschedcustombtn]")?.addEventListener("click", () => {
        const v = view.querySelector("[data-reschedcustom]")?.value;
        if (!v) return;
        const d = new Date(v + "T12:00:00");
        if (isNaN(d.getTime())) return;
        _doReschedule(d.toISOString());
      });

      // Stage checkbox + dropdown wiring
      if (it._originalStage === undefined) it._originalStage = it.lead_stage ?? null;
      view.querySelector("[data-stagetoggle]")?.addEventListener("click", () => {
        it._stageExpanded = true;
        render();
      });

      const _stageCb = view.querySelector("[data-stagecb]");
      const _stageSelect = view.querySelector("[data-stageselect]");
      if (_stageCb && _stageSelect) {
        _stageCb.addEventListener("change", () => {
          it._stageChecked = _stageCb.checked;
          _stageSelect.disabled = !_stageCb.checked;
          if (!_stageCb.checked) { it._selectedStage = ""; _stageSelect.value = ""; }
        });
        _stageSelect.addEventListener("change", () => { it._selectedStage = _stageSelect.value; });
      }

      // ── Task row wiring ────────────────────────────────────────────────
      const _taskCb = view.querySelector("[data-taskcb]");
      const _taskInput = view.querySelector("[data-taskinput]");
      if (_taskCb && _taskInput) {
        _taskInput.addEventListener("keydown", e => e.stopPropagation());
        _taskInput.addEventListener("keypress", e => e.stopPropagation());
        _taskInput.addEventListener("keyup", e => e.stopPropagation());
        _taskInput.addEventListener("input", () => { it._taskText = _taskInput.value; });
        _taskCb.addEventListener("change", () => {
          it._taskChecked = _taskCb.checked;
          _taskInput.disabled = !_taskCb.checked;
        });
      }



      view.querySelector("[data-openlead]")?.addEventListener("click", (e) => {
        e.stopPropagation();
        const url = e.currentTarget.getAttribute("data-openlead");
        if (url) window.open(url, "_blank");
      });
      view.querySelector("[data-approve]")?.addEventListener("click", async () => {
        if (it.busy || it._approving) return;

        // Capture DOM state before any async calls clear openServerItem
        const shouldChangeStage = !!(_stageCb?.checked && _stageSelect?.value);
        const newStageVal = _stageSelect?.value || "";

        // Property links are NOT appended to the text — the server sends each
        // one as its own follow-up message so each gets its own link preview.
        const _fullText = it.text;

        // If stage is being changed: show inline confirmation instead of sending immediately
        if (shouldChangeStage && newStageVal) {
          it._stageConfirm = { text: _fullText, newStage: newStageVal };
          render();
          return;
        }

        // No stage change: send message immediately (always as one piece — no newline splitting)
        it._approving = true;
        await approveServer(it, _fullText);
      });

      // Stage confirm: Send message + move stage
      view.querySelector("[data-confirm-send-move]")?.addEventListener("click", async () => {
        if (!it._stageConfirm || it.busy) return;
        const { text, newStage } = it._stageConfirm;
        it._stageConfirm = null;
        it._approving = true;
        it.lead_stage = newStage;
        it._selectedStage = newStage;
        await approveServer(it, text);
      });

      // Stage confirm: Only move stage, no message sent
      // Proactive stage nudge: move the lead to the bot-suggested stage in one
      // tap, WITHOUT sending a message (the conversation is ahead of the card).
      view.querySelector("[data-movestage]")?.addEventListener("click", async () => {
        if (it.busy || !it.suggested_stage) return;
        const newStage = it.suggested_stage;
        it.lead_stage = newStage; it._selectedStage = newStage; it.busy = true; render();
        try {
          await fetch(`${apiBase()}/approve`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              suggestionId: it.id,
              message: it.text || "",
              brokerId: settings.brokerName || "anon",
              newStage,
              stageId: stageIdForName(newStage) || undefined,
              skipMessage: true,
            }),
          });
          panelToast = `✓ Moved to ${newStage}`;
          openServerItem = null; await pollInbox();
          setTimeout(() => { panelToast = null; render(); }, 2500);
        } catch (e) { it.error = String(e); it.busy = false; render(); }
      });

      view.querySelector("[data-confirm-move-only]")?.addEventListener("click", async () => {
        if (!it._stageConfirm || it.busy) return;
        const { text, newStage } = it._stageConfirm;
        it._stageConfirm = null;
        it.lead_stage = newStage;
        it._selectedStage = newStage;
        it.busy = true; render();
        try {
          await fetch(`${apiBase()}/approve`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              suggestionId: it.id,
              message: text,
              brokerId: settings.brokerName || "anon",
              newStage,
              skipMessage: true,
            }),
          });
          openServerItem = null;
          await pollInbox();
        } catch(e) {
          it.error = String(e);
          it.busy = false; render();
        }
      });

      // Stage confirm: Cancel
      view.querySelector("[data-confirm-cancel]")?.addEventListener("click", () => {
        it._stageConfirm = null;
        it._approving = false;
        render();
      });
      view.querySelector("[data-skip]")?.addEventListener("click", () => { it._skipExpanded = !it._skipExpanded; it._skipTaskMode = false; render(); });
      view.querySelector("[data-skipauto]")?.addEventListener("click", () => skipServer(it));
      view.querySelector("[data-botexclude]")?.addEventListener("click", async () => {
        if (!confirm("Remove this lead from the bot? It will no longer appear in Push or Live. The lead stays in CRM.")) return;
        it.busy = true; render();
        try {
          await fetch(`${apiBase()}/bot-exclude`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ leadId: String(it.lead_id) }) });
          openServerItem = null; await pollInbox();
        } catch (e) {
          panelToast = "\u26a0\ufe0f " + String(e?.message || e).slice(0, 60);
          it.busy = false; render();
          setTimeout(() => { panelToast = null; render(); }, 4000);
        }
      });
      view.querySelector("[data-skiptaskmode]")?.addEventListener("click", () => { it._skipTaskMode = true; render(); });
      const _skipTaEl = view.querySelector("[data-skiptaskvoice]");
      const _skipTaBtn = view.querySelector("[data-skiptaskvbtn]");
      if (_skipTaEl) { for (const ev of ["keydown","keypress","keyup","input"]) _skipTaEl.addEventListener(ev, (e) => { e.stopPropagation(); it._skipTaskVoice = _skipTaEl.value; }); }
      if (_skipTaBtn) { _skipTaBtn.addEventListener("click", function() { startVoiceEd(_skipTaEl, this, null); }); }
      view.querySelector("[data-skiptaskconfirm]")?.addEventListener("click", async () => {
        const voiceText = it._skipTaskVoice?.trim();
        if (!voiceText) return;
        it.busy = true; render();
        try {
          panelToast = "⏳ Parsing task…"; render();
          const pr = await fetch(`${apiBase()}/parse-task`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ text: voiceText }) });
          const pj = await pr.json().catch(() => ({}));
          if (!pr.ok || !pj.taskDate) throw new Error(pj.error || "parse failed");
          panelToast = "⏳ Scheduling task…"; render();
          await fetch(`${apiBase()}/schedule-task`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ leadId: String(it.lead_id), taskDate: pj.taskDate, taskText: pj.taskText }) });
          await fetch(`${apiBase()}/skip`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ suggestionId: it.id }) });
          panelToast = `✓ Task set: ${pj.taskDate} — ${pj.taskText}`;
          openServerItem = null; await pollInbox();
        } catch (e) {
          panelToast = "⚠️ " + String(e?.message || e).slice(0, 60);
          it.busy = false; render();
          setTimeout(() => { panelToast = null; render(); }, 4000);
        }
      });
      view.querySelector("[data-noreply]")?.addEventListener("click", () => noReplyNeeded(it));
      view.querySelector("[data-edit]")?.addEventListener("click", () => { editing = true; editValue = it.text; render(); });
      view.querySelector("[data-savedit]")?.addEventListener("click", () => { stopVoiceEd();
        // ✓ ALWAYS saves the broker's manual edit verbatim. AI rewriting is a
        // separate, explicit action — the "↑ Send" button (data-rewrite) in the
        // AI box, or Enter inside it. The save checkmark must NEVER regenerate
        // the message: a stray word left in the AI box (from dictation or the
        // broker typing in the wrong field) would otherwise silently throw away
        // everything she just typed. That was the reported bug.
        it.text = editValue; editing = false; render();
      });
      view.querySelector("[data-canceledit]")?.addEventListener("click", () => { stopVoiceEd(); editing = false; render(); });
      view.querySelector("[data-voice]")?.addEventListener("click", function() { startVoiceEd(view.querySelector("[data-ai]"), this, null); });
      const aiField = view.querySelector("[data-ai]");
      if (aiField) {
        for (const ev of ["keydown","keypress","keyup"])
          aiField.addEventListener(ev, (e) => e.stopPropagation());
        // Paste a screenshot of the real amoCRM chat as ground-truth context.
        // Stored on the item and sent with the next rewrite; no re-render here so
        // the broker's typed feedback survives. Green border = attached.
        aiField.addEventListener("paste", (e) => {
          const items = (e.clipboardData || window.clipboardData)?.items || [];
          for (const cb of items) {
            if (cb.type && cb.type.indexOf("image") === 0) {
              const file = cb.getAsFile();
              if (file) {
                e.preventDefault();
                const reader = new FileReader();
                reader.onload = () => {
                  it._aiImage = reader.result;
                  aiField.style.border = "1px solid #34d399";
                  aiField.setAttribute("placeholder", "📎 Screenshot attached — say what's wrong, then Send");
                };
                reader.readAsDataURL(file);
              }
              break;
            }
          }
        });
      }
      view.querySelector("[data-ai]")?.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          const fb = view.querySelector("[data-ai]")?.value?.trim() || "Rewrite this draft using the manual edits as guidance.";
          if (editValue && editValue !== it.text) it.text = editValue;
          rewriteServer(it, fb);
          editing = false; editValue = "";
        }
      });
      view.querySelector("[data-rewrite]")?.addEventListener("click", () => {
        const fb = view.querySelector("[data-ai]")?.value?.trim() || "Rewrite this draft using the manual edits as guidance.";
        if (editValue && editValue !== it.text) it.text = editValue;
        rewriteServer(it, fb);
        editing = false; editValue = "";
      });
      const fileInput = view.querySelector("[data-fileinput]");
      fileInput?.addEventListener("change", (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          it.attachments = it.attachments || [];
          it.attachments.push({ type: "image", url: reader.result, name: file.name });
          render();
        };
        reader.readAsDataURL(file);
      });
      view.querySelectorAll("[data-rmattach]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const idx = Number(btn.getAttribute("data-rmattach"));
          it.attachments.splice(idx, 1);
          it._attachmentsCurated = true;
          render();
        });
      });
      view.querySelector("[data-attadd]")?.addEventListener("click", () => {
        const _inp = view.querySelector("[data-attaddurl]");
        const _url = (_inp?.value || "").trim();
        if (!_url) return;
        if (!/^https?:\/\//i.test(_url)) { alert("Needs to be a full link (https://…)"); return; }
        addAttachmentLink(it, _url);
        if (_inp) _inp.value = "";
        render();
      });
      view.querySelector("[data-attpick]")?.addEventListener("click", () => {
        openPropertyPicker((urls) => {
          urls.forEach((u) => addAttachmentLink(it, u));
          render();
        });
      });

      view.querySelectorAll("[data-rate]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const v = btn.getAttribute("data-rate");
          if (v === "good" || v === "bad") rateServer(it, v);
        });
      });
      const ed = view.querySelector("[data-ed]");
      if (ed) {
        ed.addEventListener("input", (e) => { editValue = e.target.value; });
        // Stop AmoCRM's global keydown/keypress handlers from swallowing our keystrokes
        ed.addEventListener("keydown",  (e) => e.stopPropagation());
        ed.addEventListener("keypress", (e) => e.stopPropagation());
        ed.addEventListener("keyup",    (e) => e.stopPropagation());
        // Auto-focus and place cursor at end so broker can type immediately
        requestAnimationFrame(() => {
          ed.focus();
          const len = ed.value.length;
          ed.setSelectionRange(len, len);
        });
      }
      // Wire dictate button — speaks directly into the edit textarea
      // Enter key in AI input triggers rewrite (like ChatGPT send)
      const aiInput = view.querySelector("[data-ai]");
      if (aiInput) {
        for (const ev of ["keydown","keypress","keyup"])
          aiInput.addEventListener(ev, (e) => e.stopPropagation());
        aiInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            view.querySelector("[data-rewrite]")?.click();
          }
        });
      }
      container.appendChild(view);
      return;
    }

    if (list.length === 0) {
      const empty = kind === "live"
        ? "All live replies handled. New ones will appear here as leads respond."
        : kind === "reach"
          ? "No qualification follow-ups due right now. They appear when amoCRM tasks are due."
          : "No active pipeline follow-ups right now.";
      const icon  = kind === "live" ? "⚡" : kind === "reach" ? "🎯" : "⏰";
      const clr   = kind === "live" ? "#34d399" : kind === "reach" ? "#a78bfa" : "#fbbf24";
      const clrBg = kind === "live" ? "rgba(52,211,153,.12)" : kind === "reach" ? "rgba(167,139,250,.12)" : "rgba(251,191,36,.12)";
      container.appendChild(el(`
        <div class="empty" style="padding:36px 18px;display:flex;flex-direction:column;align-items:center;gap:10px">
          <div style="width:44px;height:44px;border-radius:50%;display:grid;place-items:center;font-size:20px;background:${clrBg};color:${clr}">${icon}</div>
          <div style="color:#cfd5e3;font-weight:600;font-size:13px">All caught up</div>
          <div style="font-size:12px;line-height:1.5;max-width:240px">${empty}</div>
        </div>
      `));
      return;
    }

    const ul = el(`<div class="list"></div>`);
    for (const row of list) {
      // All status chips on ONE aligned row (task → stage → temperature) instead
      // of each on its own line — fixes the "scattered chips" clutter.
      const _taskB = taskStatusBadge(row.next_followup_at);
      const _stageB = row.lead_stage ? `<span class="li-stage">${esc(row.lead_stage)}</span>` : "";
      const _tempB = row.profile_temperature ? `<span class="li-temp li-temp-${esc(row.profile_temperature)}">${row.profile_temperature === "hot" ? "🔥 Hot" : row.profile_temperature === "warm" ? "🌤 Warm" : "❄️ Cold"}</span>` : "";
      const _chipsRow = (_taskB || _stageB || _tempB) ? `<div class="li-chips">${_taskB}${_stageB}${_tempB}</div>` : "";
      const li = el(`
        <div class="li ${kind}" data-id="${esc(row.id)}" ${String(row.lead_id) === String(autoLeadId) ? 'data-pinned="1" style="border-left:2px solid #60a5fa;background:rgba(96,165,250,.06)"' : ''}>
          ${String(row.lead_id) === String(autoLeadId) ? '<div style="font-size:10px;font-weight:700;color:#60a5fa;letter-spacing:.06em;padding:4px 12px 0;text-transform:uppercase">📍 Open now</div>' : ''}
          <div class="top">
            <div class="lead-info">
            <a class="lead" href="https://unicornproperty.amocrm.ru/leads/detail/${esc(row.lead_id)}" style="color:#90caf9;text-decoration:none;cursor:pointer" onclick="event.stopPropagation();event.preventDefault();window.location.href=this.href;">${row.lead_name ? esc(row.lead_name) + ` <span style="font-weight:400;opacity:.55">#${esc(row.lead_id)}</span>` : "Lead " + esc(row.lead_id)}</a>
            ${row.lead_notes ? `<div class="li-notes">${esc(row.lead_notes.split("\n")[0].trim().slice(0,80))}</div>` : ""}
          </div>
            <span class="meta">
              <span>${esc(fmtAgo(row.created_at))}</span>
            </span>
          </div>
          ${_chipsRow}
          <div class="prv">${esc(row.suggestion_text || "")}</div>
          <div class="foot">
            <span>${row.responsible_user ? esc(row.responsible_user) : (kind === "live" ? "Live reply" : kind === "reach" ? "Reach follow-up" : "Push follow-up")}</span>
            <span class="arrow">›</span>
          </div>
        </div>
      `);
      li.onclick = () => {
        const _initStageChecked = detectStageTransition(row.suggestion_text);
        const _initNextStages = stagesAfterCurrent(row.lead_stage || "");
        const _initTaskHint = row.task_hint || null;
        openServerItem = {
          id: row.id,
          lead_id: row.lead_id,
          kind: kind,  // tab kind (not API row.kind) — fixes REACH card opening
          followup_level: row.followup_level,
          responsible_user: row.responsible_user,
          lead_name: row.lead_name || null,
          lead_stage: row.lead_stage || null,
          lead_stage_id: row.lead_stage_id || null,
          last_message_at: row.last_message_at || null,
          next_followup_at: row.next_followup_at || null,
          suggested_followup_at: row.suggested_followup_at || null,
          profile_temperature: row.profile_temperature || null,
          profile_temperature_source: row.profile_temperature_source || null,
          text: row.suggestion_text || "",
          original: row.suggestion_text || "",
          lastLeadText: row.last_lead_text || "",
          recentMessages: Array.isArray(row.recent_messages) ? row.recent_messages : [],
          task_hint: _initTaskHint,
          attachments: [],
          rated: null,
          loading: false,
          busy: false,
          error: "",
          // Stage row state
          _stageChecked: _initStageChecked,
          _selectedStage: _initStageChecked && _initNextStages.length > 0 ? _initNextStages[0] : "",
          // Task row state (pre-populate from task_hint)
          _skipExpanded: false,
          _skipTaskMode: false,
          _skipTaskVoice: "",
        };
        editing = false;
        render();
      };
      ul.appendChild(li);
    }
    container.appendChild(ul);
  }

  // ----- Drafts tab (legacy local-queue flow) -----
  function renderDraftsTab(container, item) {
    if (!item) {
      const wait = nextDueInSec();
      const next = [...queue].sort((a,b)=>a.dueAt-b.dueAt)[0];
      container.appendChild(el(`<div class="empty" style="padding:32px 14px">${next ? `Next draft: ${esc(next.lead.name)} in ${fmtWait(wait || 0)}` : "No local drafts from the CRM yet."}</div>`));
      return;
    }
    container.appendChild(renderDraftCard(item));
  }

  function renderDraftCard(item) {
    const { lead } = item;
    const lastLead = [...lead.messages].reverse().find((m) => m.from === "lead");
    const reason = item.rationale || `${lead.trigger || ""} Playbook says: reference the lead's last point and use one clear CTA.`;
    const panel = el(`
      <div style="width:100%;box-sizing:border-box;">
        <div class="reason">
          <span class="icon">✦</span>
          <div class="txt">
            <span class="lbl">${esc(L("reasonLabel","Why this follow-up now"))}</span>
            ${esc(reason)}
            ${lastLead ? `<div style="margin-top:6px;color:#a7f3d0;font-style:italic">Lead: "${esc(lastLead.text.slice(0,120))}${lastLead.text.length>120?"…":""}"</div>` : ""}
          </div>
        </div>

        <div class="body" style="flex:0 0 auto;background:transparent;padding:12px 14px 10px;${editing ? 'display:flex;flex-direction:column;gap:10px;' : ''}">
          ${!editing ? `<div class="label">${esc(L("suggestedLabel","Suggested message"))}</div>` : ""}
          ${item.loading && !item.suggestion ? `<div class="skel"><div style="width:100%"></div><div style="width:92%"></div><div style="width:80%"></div><div style="width:60%"></div></div>` :
            item.error ? `<div class="err">${esc(item.error)}</div>` :
            editing ? `<textarea class="ta" data-ed placeholder="Edit message…">${esc(editValue)}</textarea>${renderAttachments(item, true)}<div style="display:flex;flex-direction:column;gap:6px;margin-top:8px"><button data-attpick style="background:rgba(96,165,250,.14);color:#60a5fa;border:1px solid rgba(96,165,250,.35);border-radius:6px;padding:8px 11px;font-size:12px;font-weight:700;cursor:pointer;width:100%">🌐 Choose on site</button><div class="att-add-row" style="display:flex;gap:6px"><input class="att-add-input" data-attaddurl placeholder="…or paste a property link" style="flex:1;min-width:0;background:#0f1826;color:#e6e8ee;border:1px solid #2a3a50;border-radius:6px;padding:7px 9px;font-size:12px;font-family:inherit"><button class="att-add-btn" data-attadd style="background:#1b2740;color:#b6bccd;border:1px solid #2a3a50;border-radius:6px;padding:7px 11px;font-size:12px;font-weight:600;cursor:pointer;flex:none">+ Add</button></div></div><input type="file" data-fileinput accept="image/*" style="display:none"><div class="ai-input-wrap" style="border-top:1px solid #2a3a50;padding-top:10px;"><textarea class="aiinput" data-ai placeholder="Tell AI what to change — or paste a screenshot…" rows="2" style="resize:none;line-height:1.4;"></textarea><div class="ai-btn-row"><button class="ai-mic-btn" data-voice title="Voice input">🎤 Dictate</button><button class="ai-send-btn" data-rewrite ${item.loading ? "disabled" : ""} title="Send">↑ Send</button></div></div>` :
            `<div class="msg">${esc(item.suggestion)}</div>${renderAttachments(item, false)}${renderRating(item)}`}
        </div>

        <div class="actions ${editing ? "editing" : ""}">
          ${editing ? `
            <button class="primary" data-savedit>${esc(L("saveBtn","✓ Save"))}</button>
            <button class="secondary" data-canceledit>${esc(L("cancelBtn","Cancel"))}</button>
          ` : `
            <button class="primary" data-approve ${!item.suggestion || item.loading ? "disabled" : ""}>${esc(L("approveBtn","✓ Approve"))}</button>
            ${item.kind === 'live' ? `<button class="secondary" data-noreply>${esc(L("noReplyBtn","🚫 No reply needed"))}</button>` : `<button class="secondary" data-skip>${esc(L("skipBtn","✕ Skip"))}</button>`}
            <button class="secondary" data-edit ${!item.suggestion ? "disabled" : ""}>${esc(L("editBtn","✎ Edit"))}</button>
          `}
        </div>
      </div>`);

    panel.querySelector("[data-openlead]")?.addEventListener("click", (e) => { e.stopPropagation(); /* link handles navigation */ });
    panel.querySelector("[data-approve]")?.addEventListener("click", () => { if (item._approving) return; item._approving = true; approve(item); });
    panel.querySelector("[data-skip]")?.addEventListener("click", () => skip(item));
    panel.querySelector("[data-noreply]")?.addEventListener("click", () => noReplyNeeded(item));
    panel.querySelector("[data-edit]")?.addEventListener("click", () => { editing = true; editValue = item.suggestion; render(); });
    panel.querySelector("[data-savedit]")?.addEventListener("click", () => { stopVoiceEd();
      // ✓ ALWAYS saves the broker's manual edit verbatim. AI rewriting is a
      // separate, explicit action — the "↑ Send" button (data-rewrite) in the
      // AI box, or Enter inside it. The save checkmark must NEVER regenerate the
      // message (see the list-card handler above for the bug this fixes).
      item.suggestion = editValue; editing = false; render();
    });
    panel.querySelector("[data-canceledit]")?.addEventListener("click", () => { stopVoiceEd(); editing = false; render(); });
    panel.querySelectorAll("[data-rate]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const v = btn.getAttribute("data-rate");
        if (v !== "good" && v !== "bad") return;
        item.rated = v;
        sendFeedback(item, v, item.suggestion);
        render();
      });
    });
    panel.querySelector("[data-rewrite]")?.addEventListener("click", () => {
      const fb = panel.querySelector("[data-ai]")?.value?.trim() || "Rewrite this draft using the manual edits as guidance.";
      if (!fb) return;
      generate(item, { previous: item.suggestion, feedback: fb });
      editing = false; editValue = "";
    });
    const aiField2 = panel.querySelector("[data-ai]");
    if (aiField2) {
      for (const ev of ["keydown","keypress","keyup"])
        aiField2.addEventListener(ev, (e) => e.stopPropagation());
    }
    panel.querySelector("[data-ai]")?.addEventListener("keydown", (e2) => {
      if (e2.key === "Enter" && !e2.shiftKey) {
        e2.preventDefault();
        const fb2 = panel.querySelector("[data-ai]")?.value?.trim() || "Rewrite using manual edits as guidance.";
        if (editValue && editValue !== item.suggestion) item.suggestion = editValue;
        generate(item, { previous: item.suggestion, feedback: fb2 });
        editing = false; editValue = "";
      }
    });
    panel.querySelector("[data-voice]")?.addEventListener("click", function() { startVoiceEd(panel.querySelector("[data-ai]"), this, null); });
    const fileInput = panel.querySelector("[data-fileinput]");
    fileInput?.addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        item.attachments = item.attachments || [];
        item.attachments.push({ type: "image", url: reader.result, name: file.name });
        render();
      };
      reader.readAsDataURL(file);
    });
    panel.querySelectorAll("[data-rmattach]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.getAttribute("data-rmattach"));
        item.attachments.splice(idx, 1);
        item._attachmentsCurated = true;
        render();
      });
    });
      panel.querySelector("[data-attadd]")?.addEventListener("click", () => {
        const _inp = panel.querySelector("[data-attaddurl]");
        const _url = (_inp?.value || "").trim();
        if (!_url) return;
        if (!/^https?:\/\//i.test(_url)) { alert("Needs to be a full link (https://…)"); return; }
        addAttachmentLink(item, _url);
        if (_inp) _inp.value = "";
        render();
      });
      panel.querySelector("[data-attpick]")?.addEventListener("click", () => {
        openPropertyPicker((urls) => {
          urls.forEach((u) => addAttachmentLink(item, u));
          render();
        });
      });

    const ed = panel.querySelector("[data-ed]");
    if (ed) {
      ed.addEventListener("input", (e) => { editValue = e.target.value; });
      // Stop AmoCRM's global keydown/keypress handlers from swallowing our keystrokes
      ed.addEventListener("keydown",  (e) => e.stopPropagation());
      ed.addEventListener("keypress", (e) => e.stopPropagation());
      ed.addEventListener("keyup",    (e) => e.stopPropagation());
      requestAnimationFrame(() => {
        ed.focus();
        const len = ed.value.length;
        ed.setSelectionRange(len, len);
      });
    }
    // Wire dictate button — speaks directly into the edit textarea
    // Enter key in AI input triggers rewrite
    const aiInput = panel.querySelector("[data-ai]");
    if (aiInput) {
      for (const ev of ["keydown","keypress","keyup"])
        aiInput.addEventListener(ev, (e) => e.stopPropagation());
      aiInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          panel.querySelector("[data-rewrite]")?.click();
        }
      });
    }

    return panel;
  }

  function renderDetail(lead) {
    return `<div class="detail">
      <div class="row"><div class="k">Stage</div><div class="v">${esc(lead.stage)}</div></div>
      <div class="row"><div class="k">Company</div><div class="v">${esc(lead.company)}</div></div>
      <div class="row"><div class="k">Silent</div><div class="v">${lead.lastContactDays} day(s)</div></div>
      <div class="msgs">
        <div class="label" style="margin-bottom:6px">Recent thread</div>
        ${lead.messages.slice(-5).map((m) => `<div class="m"><span class="tag ${m.from === "broker" ? "b" : "l"}">${m.from === "broker" ? "You" : "Lead"}</span>${esc(m.text)}</div>`).join("")}
      </div>
    </div>`;
  }

  function activeCount() { return queue.filter((q) => Date.now() >= q.dueAt).length; }
  // `removable` is only true in edit mode, where the × buttons get wired up.
  // Bot-picked property links are removable too: the broker needs to be able to
  // drop or swap a listing they disagree with, not just ones they added.
  function renderAttachments(item, removable) {
    if (!item.attachments?.length) return "";
    return `<div class="atts">${item.attachments.map((a, i) => {
      const rm = removable ? `<button class="attrm" data-rmattach="${i}" title="Remove">×</button>` : "";
      if (a.type === "reminder") {
        return `<div class="att reminder"><span>📌</span><span class="attlbl">${esc(a.label)}</span></div>`;
      }
      if (a.type === "image" && a.url) {
        return `<div class="att img"><a href="${esc(a.url)}" target="_blank" rel="noopener"><img src="${esc(a.url)}" alt="${esc(a.label||"")}" style="max-width:120px;max-height:80px;border-radius:4px;border:1px solid #ddd"></a><span class="attlbl">${esc(a.label||"")}</span>${rm}</div>`;
      }
      if (a.type === "image" && !a.url) {
        return `<div class="att reminder"><span>🖼</span><span class="attlbl">${esc(a.label)} — <em style="color:#dc2626">not uploaded yet</em></span></div>`;
      }
      if (a.type === "link") {
        return `<div class="att link"><span>🔗</span><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.label||a.url)}</a>${rm}</div>`;
      }
      return "";
    }).join("")}</div>`;
  }

  // Shared by the manual "+ Add" paste box and the site picker below, so both
  // paths dedupe and label a link the same way.
  function addAttachmentLink(entity, url) {
    entity.attachments = entity.attachments || [];
    if (entity.attachments.some((a) => a.type === "link" && a.url === url)) return false;
    const m = url.match(/\/property\/([A-Za-z0-9-]+)/i);
    entity.attachments.push({ type: "link", label: m ? m[1] : url, url, _broker: true });
    entity._attachmentsCurated = true;
    return true;
  }

  const PICKER_ORIGIN = "https://unicorn-properties.com";

  // Opens unicorn-properties.com in a full-screen overlay so the broker can
  // click listings there instead of copy-pasting links. The site renders a
  // "picker mode" (only active behind ?copilotPicker=1 + being framed) that
  // posts the chosen bare property URLs back via postMessage on "Send to
  // Copilot". Appended to document.body (not the shadow-DOM panel) so it can
  // actually cover the full viewport regardless of the panel's own box.
  function openPropertyPicker(onSelect) {
    const overlay = el(`
      <div style="position:fixed;inset:0;z-index:2147483647;background:rgba(10,14,20,.72);display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;font-family:inherit">
        <div style="width:100%;max-width:1100px;height:100%;max-height:860px;background:#273444;border:1px solid #3a4a5e;border-radius:10px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.55)">
          <div style="flex:none;display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#2c3e50;border-bottom:1px solid #3a4a5e">
            <span style="font-size:12.5px;font-weight:700;color:#e6e8ee">🌐 Choose listings — unicorn-properties.com</span>
            <button data-pickerclose style="background:none;border:none;color:#94a3b8;font-size:20px;line-height:1;cursor:pointer;padding:2px 6px;border-radius:4px">×</button>
          </div>
          <iframe src="${PICKER_ORIGIN}/" style="flex:1 1 auto;border:none;width:100%;background:#0f1826"></iframe>
        </div>
      </div>
    `);
    document.body.appendChild(overlay);
    const iframe = overlay.querySelector("iframe");

    function close() {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("keydown", onKey);
      overlay.remove();
    }
    // The site itself may rewrite its own URL on load (route-sync effects
    // reset the query string / hash), so a URL flag isn't reliable. Instead
    // the site announces "ready" once mounted and we reply "activate" —
    // a handshake immune to whatever the site's own router does afterwards.
    function onMessage(e) {
      if (e.origin !== PICKER_ORIGIN) return;
      if (e.source !== iframe.contentWindow) return;
      const d = e.data;
      if (!d) return;
      if (d.source === "unicorn-site" && d.type === "ready") {
        iframe.contentWindow.postMessage({ source: "unicorn-picker-host", type: "activate" }, PICKER_ORIGIN);
        return;
      }
      if (d.source === "unicorn-picker" && d.type === "selection" && Array.isArray(d.urls)) {
        onSelect(d.urls);
        close();
      }
    }
    function onKey(e) { if (e.key === "Escape") close(); }
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    overlay.querySelector("[data-pickerclose]")?.addEventListener("click", close);
    window.addEventListener("message", onMessage);
    window.addEventListener("keydown", onKey);
  }
  function renderRating(_item) {
    // Removed the manual 👍/👎 "Train AI" row — brokers won't spend the extra
    // click. The bot learns IMPLICITLY instead: a clean Approve = the suggestion
    // was good (behaviour reinforced), and an Edit is analysed on the server
    // (learnFromManualEdit → broker_corrections, applied per broker on the next
    // generation). No explicit rating needed.
    return "";
  }
  let _voiceRec    = false;
  let _voiceEdEl   = null;   // active edit textarea (null = not recording)
  let _voiceEdBtn  = null;
  let _voiceEdHint = null;
  let _directSR    = null;   // active SpeechRecognition instance

  // Stop dictation (called on Save / Cancel / Back)
  function stopVoiceEd() {
    if (_voiceEdEl) {
      if (_directSR) { try { _directSR.stop(); } catch {} _directSR = null; }
      _voiceEdEl = null;
      if (_voiceEdBtn) { _voiceEdBtn.textContent = "🎤 Dictate"; _voiceEdBtn.classList.remove("recording"); }
      if (_voiceEdHint) _voiceEdHint.style.display = "none";
      _voiceEdBtn = null; _voiceEdHint = null;
    }
  }

  // Voice dictation — Chrome built-in SpeechRecognition, tab context (amocrm.ru).
  // Real-time interim results appear in the field while speaking; lang = English.
  function startVoiceEd(edEl, btnEl, hintEl) {
    if (!edEl) return;
    // Toggle: click while recording → stop
    if (_voiceEdEl) {
      if (_directSR) { try { _directSR.stop(); } catch {} _directSR = null; }
      return;  // onend cleans up UI
    }

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      if (btnEl) { btnEl.textContent = "🚫 Not supported"; setTimeout(() => { btnEl.textContent = "🎤 Dictate"; }, 3000); }
      return;
    }

    _voiceEdEl  = edEl;
    _voiceEdBtn = btnEl;
    _voiceEdHint = hintEl;
    // Dictating means the on-screen keyboard is dead weight — on a phone it eats
    // half the screen, hiding the very draft being corrected. Harmless on desktop.
    try { edEl.blur(); if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch {}
    if (btnEl) { btnEl.textContent = "⏳"; btnEl.title = "Starting microphone…"; }

    const sr = new SR();
    sr.lang = settings.dictationLang || chrome.i18n.getUILanguage() || navigator.language || "ru-RU";
    sr.continuous = true;
    sr.interimResults = true;
    _directSR = sr;

    let lastFinal = edEl.value;   // preserve any existing text

    sr.onstart = () => {
      if (_voiceEdBtn) {
        _voiceEdBtn.textContent = "⏹";
        _voiceEdBtn.title = "Recording… click to stop";
        _voiceEdBtn.classList.add("recording");
      }
      if (_voiceEdHint) _voiceEdHint.style.display = "";
    };

    sr.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          lastFinal += (lastFinal && !lastFinal.endsWith(" ") ? " " : "") + t.trim();
        } else {
          interim += t;
        }
      }
      if (_voiceEdEl) {
        _voiceEdEl.value = lastFinal + (interim ? (lastFinal && !lastFinal.endsWith(" ") ? " " : "") + interim : "");
        _voiceEdEl.dispatchEvent(new Event("input", { bubbles: true }));
      }
    };

    sr.onerror = (event) => {
      _directSR = null;
      if (_voiceEdHint) _voiceEdHint.style.display = "none";
      if (_voiceEdBtn) {
        _voiceEdBtn.classList.remove("recording");
        const denied = event.error === "not-allowed" || event.error === "audio-capture";
        _voiceEdBtn.textContent = "🚫 Mic blocked";
        _voiceEdBtn.title = denied
          ? "Mic blocked — allow microphone for amocrm.ru in Chrome"
          : "Mic error: " + event.error;
        const b = _voiceEdBtn;
        setTimeout(() => { b.textContent = "🎤 Dictate"; b.title = "Dictate your instruction"; }, 4000);
      }
      _voiceEdEl = null; _voiceEdBtn = null; _voiceEdHint = null;
    };

    sr.onend = () => {
      _directSR = null;
      if (_voiceEdEl) {
        _voiceEdEl.value = lastFinal.trim();
        _voiceEdEl.dispatchEvent(new Event("input", { bubbles: true }));
      }
      if (_voiceEdBtn) {
        _voiceEdBtn.textContent = "🎤 Dictate";
        _voiceEdBtn.title = "Dictate your instruction";
        _voiceEdBtn.classList.remove("recording");
      }
      if (_voiceEdHint) _voiceEdHint.style.display = "none";
      _voiceEdEl = null; _voiceEdBtn = null; _voiceEdHint = null;
    };

    sr.start();
  }

  function startVoice(panel) {
    const btn   = panel.querySelector("[data-voice]");
    const input = panel.querySelector("[data-ai]");

    function setUI(state) {
      if (!btn) return;
      const em = { idle: "🎤", recording: "⏹", thinking: "⏳", error: "🚫" };
      btn.textContent = em[state] || "🎤";
      btn.classList.toggle("recording", state === "recording");
      btn.title = state === "recording" ? "Done — press ↑ to send to AI" : "Dictate your instruction";
      if (state === "error") setTimeout(() => setUI("idle"), 3000);
    }

    if (input) {
      for (const ev of ["keydown","keypress","keyup"])
        input.addEventListener(ev, e => e.stopPropagation());
    }

    // Toggle: already recording → stop
    if (_voiceRec) {
      if (_directSR) { try { _directSR.stop(); } catch {} _directSR = null; }
      _voiceRec = false;
      setUI("thinking");
      return;
    }

    const SR2 = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR2) { setUI("error"); return; }

    const sr2 = new SR2();
    sr2.lang = settings.dictationLang || chrome.i18n.getUILanguage() || navigator.language || "ru-RU";
    sr2.continuous = true;
    sr2.interimResults = true;
    _directSR = sr2;
    setUI("thinking");

    let lastFinal2 = input ? input.value.trim() : "";

    sr2.onstart = () => { _voiceRec = true; setUI("recording"); };

    sr2.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          lastFinal2 += (lastFinal2 && !lastFinal2.endsWith(" ") ? " " : "") + t.trim();
        } else {
          interim += t;
        }
      }
      if (input) {
        input.value = lastFinal2 + (interim ? (lastFinal2 && !lastFinal2.endsWith(" ") ? " " : "") + interim : "");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    };

    sr2.onerror = () => { _directSR = null; _voiceRec = false; setUI("error"); };

    sr2.onend = () => {
      _directSR = null;
      _voiceRec = false;
      if (input) {
        input.value = lastFinal2.trim();
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      setUI("idle");
    };

    sr2.start();
  }
  function fmtWait(s) { if (s < 60) return `${s}s`; const m = Math.floor(s/60); return `${m}m`; }
  function fmtAgo(iso) {
    if (!iso) return "";
    const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }
  function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  // URLs in conversation bubbles are tappable (client-quoted villa links were
  // dead text). Applied AFTER esc(), so nothing unescaped renders.
  function linkify(escaped) {
    return escaped.replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${u}" target="_blank" rel="noopener" style="color:#7dd3fc;text-decoration:underline;word-break:break-all">${u}</a>`);
  }
  function el(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; }

  try {
    chrome.runtime.onMessage.addListener((m) => {
      if (m?.type === "COPILOT_TOGGLE") {
      if (activeItem()) { collapsed = !collapsed; } else { manuallyOpen = !manuallyOpen; }
      render();
    }
      if (m?.type === "COPILOT_FOLLOW_UP_DUE") {
        enqueueFollowUp(m.lead, Number(m.delayMs || 0));
      }
      // Voice UI handled inline by SpeechRecognition callbacks (no message-passing needed)
    });
  } catch { /* extension context invalidated — ignore */ }

  load();
})();
