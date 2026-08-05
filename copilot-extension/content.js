(() => {
  // Guard: bail out silently if chrome extension context is no longer valid
  // (happens when the extension is reloaded while AmoCRM tab is still open)
  try { if (!chrome?.runtime?.id) return; } catch { return; }

  // Suppress unhandled promise rejections so Chrome never shows
  // the extension Errors badge from network/API failures.
  window.addEventListener("unhandledrejection", (e) => e.preventDefault());

  if (window.__copilotInjected) return;
  window.__copilotInjected = true;

  // ── This file used to be a full, separate reimplementation of the copilot
  // UI (suggestions, approve/edit, attachments, stage, everything) living
  // alongside the server's own /m PWA — the two drifted apart every single
  // time a fix landed in only one of them (this repo's whole history is full
  // of exactly that bug). This is now a thin BRIDGE: it does only the things
  // that genuinely need page-level access to amoCRM (who's logged in, which
  // lead is open, did the broker reply directly in amoCRM's own chat), and
  // embeds /m itself — the SAME PWA — in an iframe for everything else.
  // Every feature/bugfix from here on lives in mobile.ts and applies
  // instantly to both surfaces; this file should rarely need to change. ──

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
  const DEFAULT_API = "https://copilot.globalapplab.ru/api/public/suggest";
  // Origin /m is served from — both the iframe's src and the postMessage
  // trust boundary in both directions.
  const IFRAME_ORIGIN = "https://copilot.globalapplab.ru";

  let settings = { guide: DEFAULT_GUIDE, urlFilter: "unicornproperty.amocrm.ru", brokerName: "", apiUrl: DEFAULT_API, outputLanguage: "English" };

  function apiBase() {
    return settings.apiUrl.replace(/\/suggest(\/)?$/, "");
  }

  function matchesUrl() {
    const filter = settings.urlFilter?.trim();
    if (!filter) return true;
    const parts = filter.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const href = location.href.toLowerCase();
    return parts.some((p) => href.includes(p));
  }

  // Extract the leadId from AmoCRM URL e.g. /leads/detail/22497375
  function detectLeadIdFromUrl() {
    const m = location.pathname.match(/\/leads\/detail\/(\d+)/);
    return m ? m[1] : null;
  }

  // Try to detect an outgoing (broker) message in AmoCRM conversation DOM —
  // a broker who replies directly in amoCRM, bypassing the copilot, leaves a
  // stale pending suggestion behind with no other way to notice. No iframe or
  // API equivalent is possible: only page-level DOM access can see this.
  function detectOutgoingInDom() {
    const selectors = [
      ".amoCRM-private-eventfeed__item--outgoing",
      ".feed-note--outgoing",
      "[data-note-type='outgoing_message']",
      ".amocrm-messenger__message--outgoing",
      ".messenger-dialog__message--outgoing",
      ".amoCRM-inner-panel .feed-note.outgoing",
    ];
    for (const sel of selectors) {
      try {
        if (document.querySelectorAll(sel).length > 0) return true;
      } catch {}
    }
    const notes = document.querySelectorAll(".feed-note, .amoCRM-Private-EventItem");
    for (const n of notes) {
      const cls = (n.className || "").toLowerCase();
      if (cls.includes("outgoing") || cls.includes("sent")) return true;
    }
    return false;
  }

  // Auto-detect broker from the amoCRM logged-in user. Detection is
  // authoritative — it reflects whoever is actually logged in, so it
  // overrides any stored/stale name. amoCRM is a SPA that may still be
  // loading on first paint, so retry a few times before giving up.
  async function detectAmoCRMUser() {
    // 1. PRIMARY: amoCRM API — authoritative, matches the DB responsible_user
    //    name exactly. account.current_user_id → find that user in the list.
    //    account.current_user_id is readable by ANY broker; the name lookup
    //    (/api/v4/users) is admin-only (403 for regular brokers), so our
    //    server resolves the id -> name via /whoami using its admin token.
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

  // ── Panel container: fixed shadow-root host, resizable, holding one iframe
  // pointed at our own /m PWA. Nothing here renders suggestions/messages —
  // that's all inside the iframe's own document now. ──
  const host = document.createElement("div");
  host.id = "__copilot_host";
  host.style.cssText = "all: initial; position: fixed; bottom: 24px; right: 24px; z-index: 2147483647; transform-origin: bottom right; display: none;";
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
    .panel { position: relative; width: 460px; max-width: calc(100vw - 24px); max-height: calc(100vh - 24px); background: #0f1320; border: 1px solid #2a3146; border-radius: 8px; box-shadow: 0 18px 48px rgba(0,0,0,.55); overflow: hidden; animation: in .25s ease-out; }
    @keyframes in { from { transform: translateY(8px); opacity: 0 } to { transform: none; opacity: 1 } }
    .resize-grip { position:absolute; top:0; left:0; width:18px; height:18px; cursor:nwse-resize; z-index:20; }
    .resize-grip::before { content:""; position:absolute; top:4px; left:4px; width:8px; height:8px; border-top:2px solid #6b7d92; border-left:2px solid #6b7d92; border-radius:3px 0 0 0; opacity:.7; }
    .resize-grip:hover::before { opacity:1; border-color:#90caf9; }
    .copilot-embed { display:block; width: 100%; height: 100%; border: 0; }
  `;
  root.appendChild(style);

  const panel = document.createElement("div");
  panel.className = "panel";
  let panelSize = null; // { w, h } — user-resized size, persisted

  const iframeEl = document.createElement("iframe");
  iframeEl.className = "copilot-embed";
  // Notifications/Wake Lock/Microphone default to Permissions-Policy 'self'
  // for a cross-origin iframe and silently no-op without this.
  iframeEl.setAttribute("allow", "notifications; screen-wake-lock; microphone");

  const grip = document.createElement("div");
  grip.className = "resize-grip";
  grip.title = "Drag to resize";
  grip.addEventListener("mousedown", (e) => {
    e.preventDefault(); e.stopPropagation();
    const rect = panel.getBoundingClientRect();
    const scale = __lastScale || 1;
    const startX = e.clientX, startY = e.clientY;
    const startW = rect.width / scale, startH = rect.height / scale;
    const onMove = (ev) => {
      let w = startW + (startX - ev.clientX) / scale;
      let h = startH + (startY - ev.clientY) / scale;
      w = Math.max(340, Math.min(w, (window.innerWidth - 24) / scale));
      h = Math.max(300, Math.min(h, (window.innerHeight - 24) / scale));
      panel.style.width = w + "px";
      panel.style.height = h + "px";
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
  panel.appendChild(iframeEl);
  root.appendChild(panel);

  let panelOpen = false; // starts closed, toolbar icon toggles it
  let currentBroker = "";
  let currentLead = null;
  let iframeSrcSet = false;

  function applyPanelVisibility() {
    host.style.display = (matchesUrl() && panelOpen) ? "block" : "none";
  }

  function ensureIframeLoaded() {
    if (iframeSrcSet || !currentBroker) return;
    const qs = new URLSearchParams();
    qs.set("broker", currentBroker);
    if (currentLead) qs.set("lead", currentLead);
    // Only pass these when the broker actually customized them via
    // options.html — otherwise /m's own defaults (identical text) apply.
    if (settings.guide && settings.guide !== DEFAULT_GUIDE) qs.set("guide", settings.guide);
    if (settings.outputLanguage && settings.outputLanguage !== "English") qs.set("outputLanguage", settings.outputLanguage);
    iframeEl.src = `${IFRAME_ORIGIN}/m?${qs.toString()}`;
    iframeSrcSet = true;
  }

  function postToIframe(msg) {
    try {
      if (iframeEl.contentWindow) {
        iframeEl.contentWindow.postMessage(Object.assign({ source: "copilot-bridge" }, msg), IFRAME_ORIGIN);
      }
    } catch {}
  }

  // ── Bridge ↔ /m handshake. Mirrors the exact origin-and-source-checked
  // postMessage pattern /m's own openPropertyPicker() already uses to host a
  // nested cross-origin iframe — same shape, host and guest swapped: there
  // /m is the host talking to a nested picker iframe; here this bridge is
  // the host talking to /m itself. ──
  window.addEventListener("message", (e) => {
    if (e.origin !== IFRAME_ORIGIN) return;
    if (e.source !== iframeEl.contentWindow) return;
    const d = e.data;
    if (!d || d.source !== "copilot-embed") return;
    if (d.type === "ready") {
      postToIframe({ type: "init", broker: currentBroker, leadId: currentLead });
    }
  });

  async function onLeadNavigation() {
    const leadId = detectLeadIdFromUrl();
    if (leadId === currentLead) return;
    currentLead = leadId;
    if (leadId) {
      ensureIframeLoaded();
      postToIframe({ type: "lead", leadId });
    }
  }

  // A broker replying directly in amoCRM (bypassing the copilot) leaves a
  // stale pending suggestion behind — clear it server-side and tell /m to
  // refresh instead of waiting for its own next poll.
  async function tryAutoSync() {
    const leadId = detectLeadIdFromUrl();
    if (!leadId) return;
    const anyNotes = document.querySelectorAll(".feed-note, .amoCRM-Private-EventItem");
    if (anyNotes.length === 0) return; // page not ready yet
    if (detectOutgoingInDom()) {
      try {
        await fetch(`${apiBase()}/broker-replied`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ leadId }),
        });
        postToIframe({ type: "broker-replied", leadId });
      } catch {}
    }
  }

  function load() {
    try { if (!chrome?.runtime?.id) return; } catch { return; }
    chrome.storage.local.get(["guide", "urlFilter", "brokerName", "apiUrl", "outputLanguage", "copilotPanelSize"], async (data) => {
      settings = {
        guide: data.guide || DEFAULT_GUIDE,
        urlFilter: data.urlFilter || "unicornproperty.amocrm.ru",
        brokerName: data.brokerName || "",
        apiUrl: data.apiUrl || DEFAULT_API,
        outputLanguage: data.outputLanguage || "English",
      };
      if (data.copilotPanelSize && data.copilotPanelSize.w) {
        panelSize = data.copilotPanelSize;
        panel.style.width = panelSize.w + "px";
        panel.style.height = panelSize.h + "px";
      } else {
        const defaultH = Math.min(760, Math.max(480, (window.innerHeight || 900) - 40));
        panel.style.height = defaultH + "px";
      }

      if (!matchesUrl()) return;

      // Auto-detect broker from the amoCRM logged-in user. Detection is
      // authoritative — overrides any stored/stale name. Retry a few times:
      // amoCRM's SPA may still be loading on first paint.
      let detectedUser = await detectAmoCRMUser();
      for (let i = 0; i < 5 && !detectedUser; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        detectedUser = await detectAmoCRMUser();
      }
      if (detectedUser) {
        settings.brokerName = detectedUser;
        chrome.storage.local.set({ brokerName: detectedUser });
      }
      currentBroker = settings.brokerName || "";
      if (currentBroker) ensureIframeLoaded();

      // Keep re-checking in the background — if the broker logs in later or
      // the SPA finishes loading, pick up their real name (never silently
      // show another broker's leads because detection missed once).
      if (!settings.brokerName) {
        const _reDetect = setInterval(async () => {
          const u = await detectAmoCRMUser();
          if (u) {
            clearInterval(_reDetect);
            settings.brokerName = u;
            currentBroker = u;
            chrome.storage.local.set({ brokerName: u });
            ensureIframeLoaded();
            postToIframe({ type: "broker", broker: u });
          }
        }, 5000);
      }

      // Detect SPA navigation (AmoCRM is a single-page app — URL changes without reload).
      let _lastHref = location.href;
      setInterval(() => {
        if (location.href !== _lastHref) {
          _lastHref = location.href;
          setTimeout(tryAutoSync, 1800); // wait for AmoCRM DOM to render
          setTimeout(onLeadNavigation, 600);
        }
      }, 600);
      // Also auto-detect on initial page load (e.g. broker opens a lead directly)
      setTimeout(onLeadNavigation, 1500);
    });
  }

  try {
    chrome.runtime.onMessage.addListener((m) => {
      if (m?.type === "COPILOT_TOGGLE") {
        panelOpen = !panelOpen;
        applyPanelVisibility();
        if (panelOpen) ensureIframeLoaded();
      }
    });
  } catch { /* extension context invalidated — ignore */ }

  load();
})();
