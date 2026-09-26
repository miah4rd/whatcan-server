// Unicorn OS — core: state, API, formatting, dialogs, resizing, routing registry.

export const S = {
  user: null,
  meta: null,
  route: { screen: "tasks", parts: [] },
  cache: {},
  peek: null,
  notif: { items: [], seenAt: null, open: false },
};

export const TZ = "Asia/Makassar";
/**
 * A phone layout: the same test the stylesheet uses. window.innerWidth is not: iOS Safari reports
 * the zoomed-out visual width (980 and more) when a page loads wider than the screen, and Tasks
 * then opened the card over the Copilot on phones (owner, 26.09).
 */
export const isPhone = () => matchMedia("(max-width: 860px)").matches;

// ── storage (per-viewer conveniences only) ──
export const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem("uos:" + k);
      return v == null ? d : JSON.parse(v);
    } catch (e) {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem("uos:" + k, JSON.stringify(v));
    } catch (e) {
      /* private mode */
    }
  },
};

// ── API ──
export class ApiError extends Error {
  constructor(msg, status) {
    super(msg);
    this.status = status;
  }
}
export async function api(path, opts = {}) {
  const init = { method: opts.method || (opts.body ? "POST" : "GET"), credentials: "same-origin", headers: {} };
  if (opts.body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch("/os/api" + path, init);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (e) {
    json = null;
  }
  if (res.status === 401 && !opts.allow401) {
    bus.dispatchEvent(new CustomEvent("signed-out"));
    throw new ApiError("Signed out", 401);
  }
  if (!res.ok) throw new ApiError((json && (json.error || json.message)) || `Request failed (${res.status})`, res.status);
  return json;
}
export async function cached(key, ttlMs, fn, force) {
  const c = S.cache[key];
  if (!force && c && Date.now() - c.at < ttlMs) return c.value;
  const value = await fn();
  S.cache[key] = { at: Date.now(), value };
  return value;
}
export function dropCache(prefix) {
  for (const k of Object.keys(S.cache)) if (k.startsWith(prefix)) delete S.cache[k];
}

export const bus = new EventTarget();
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));
export const onBus = (name, fn) => bus.addEventListener(name, (e) => fn(e.detail));

// ── formatting ──
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const d = (iso) => (iso ? new Date(iso) : null);
export function fmtTime(iso) {
  return iso ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ }) : "";
}
export function fmtDay(iso) {
  return iso ? new Date(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: TZ }) : "";
}
export function fmtDate(iso) {
  return iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: TZ }) : "—";
}
export const fmtDT = (iso) => (iso ? `${fmtDay(iso)} ${fmtTime(iso)}` : "—");
export function rel(iso) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const a = Math.abs(ms);
  const pre = ms < 0 ? "in " : "";
  const post = ms < 0 ? "" : " ago";
  if (a < 60e3) return ms < 0 ? "now" : "just now";
  if (a < 3600e3) return `${pre}${Math.round(a / 60e3)} min${post}`;
  if (a < 86400e3) return `${pre}${Math.round(a / 3600e3)} h${post}`;
  return `${pre}${Math.round(a / 86400e3)} d${post}`;
}
export const daysSince = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 86400e3 : null);
export function money(n) {
  if (n == null || n === "" || Number.isNaN(Number(n))) return "—";
  const v = Number(n);
  if (v >= 1e9) return `Rp ${(v / 1e9).toFixed(v % 1e9 === 0 ? 0 : 2)}B`;
  if (v >= 1e6) return `Rp ${(v / 1e6).toFixed(v % 1e6 === 0 ? 0 : 1)}M`;
  return `Rp ${v.toLocaleString("en-US")}`;
}
export const initials = (n) =>
  String(n || "?")
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] || "")
    .join("")
    .toUpperCase() || "?";
export const baliToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
export const isStaff = () => !!S.meta?.staff;

// ── icons ──
const svg = (p, sw = 1.5) => `<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
export const I = {
  inbox: svg('<path d="M2 9h3l1.5 2h3L11 9h3M2 9l1.5-5h9L14 9v4H2V9z"/>'),
  today: svg('<rect x="2.5" y="3" width="11" height="10.5" rx="1.5"/><path d="M2.5 6.5h11M5.5 1.8v2.4M10.5 1.8v2.4M5 9.5l1.5 1.5L10 8"/>'),
  board: svg('<rect x="2" y="3" width="3.5" height="10" rx="1"/><rect x="6.25" y="3" width="3.5" height="7" rx="1"/><rect x="10.5" y="3" width="3.5" height="5" rx="1"/>'),
  table: svg('<rect x="2" y="3" width="12" height="10" rx="1"/><path d="M2 7h12M2 10h12M6 3v10"/>'),
  gallery: svg('<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>'),
  villa: svg('<path d="M2 8l6-5 6 5M4 7v6h8V7M7 13V9.5h2V13"/>'),
  cal: svg('<rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 7h11M5.5 2v3M10.5 2v3"/>'),
  chart: svg('<path d="M2 13.5h12M3.5 11l3-4 2.5 2.5L13 4"/>'),
  money: svg('<rect x="1.5" y="4" width="13" height="8.5" rx="1.5"/><circle cx="8" cy="8.25" r="1.9"/><path d="M4 6.5v3.5M12 6.5v3.5"/>'),
  auto: svg('<circle cx="8" cy="8" r="2.4"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6L11 5M5 11l-1.4 1.4"/>'),
  gear: svg('<circle cx="8" cy="8" r="2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4"/>'),
  search: svg('<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2l3.6 3.6"/>'),
  bell: svg('<path d="M4 11V7.5a4 4 0 0 1 8 0V11l1.2 1.5H2.8L4 11zM6.5 14h3"/>'),
  x: svg('<path d="M4 4l8 8M12 4l-8 8"/>', 1.7),
  back: svg('<path d="M10 3L5 8l5 5"/>', 1.7),
  fwd: svg('<path d="M6 3l5 5-5 5"/>', 1.7),
  up: svg('<path d="M3 10l5-5 5 5"/>', 1.7),
  down: svg('<path d="M3 6l5 5 5-5"/>', 1.7),
  left: svg('<path d="M9.5 3.5L5 8l4.5 4.5M13 3.5v9"/>'),
  right: svg('<path d="M6.5 3.5L11 8l-4.5 4.5M3 3.5v9"/>'),
  panel: svg('<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M6 2.5v11"/>'),
  mic: svg('<rect x="6" y="2" width="4" height="8" rx="2"/><path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2"/>'),
  sparkle: svg('<path d="M8 2l1.3 3.7L13 7l-3.7 1.3L8 12l-1.3-3.7L3 7l3.7-1.3z"/>'),
  ext: svg('<path d="M9 3h4v4M13 3L7 9M11 9.5V13H3V5h3.5"/>'),
  drive: svg('<path d="M5.5 2.5h5l3.5 6-2.5 4.5h-7L2 8.5z M5.5 2.5L9 8.5h5M2 8.5h7l-2.5 4.5"/>'),
  video: svg('<rect x="2" y="4" width="8" height="8" rx="1"/><path d="M10 7l4-2v6l-4-2"/>'),
  moon: svg('<path d="M13 9.5A5.5 5.5 0 1 1 6.5 3a4.5 4.5 0 0 0 6.5 6.5z"/>'),
  out: svg('<path d="M6 13H3V3h3M10 11l3-3-3-3M13 8H6"/>'),
  plus: svg('<path d="M8 3v10M3 8h10"/>', 1.7),
  goal: svg('<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="2.5"/><path d="M8 8l4.5-4.5"/>'),
  timeline: svg('<path d="M2 4h6M5 8h7M3.5 12h8"/>', 2),
  trash: svg('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>'),
  check: svg('<path d="M3.5 8.5l3 3 6-7"/>', 2),
  book: svg('<path d="M3 3.5h4a1.5 1.5 0 011.5 1.5v8A1.5 1.5 0 007 11.5H3zM13 3.5H9.5A1.5 1.5 0 008 5v8a1.5 1.5 0 011.5-1.5H13z"/>'),
  wa: '<svg class="ic" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5A6.5 6.5 0 0 0 2.4 11.3L1.5 14.5l3.3-.9A6.5 6.5 0 1 0 8 1.5zm0 1.3a5.2 5.2 0 1 1-2.7 9.6l-.3-.2-1.9.5.5-1.8-.2-.3A5.2 5.2 0 0 1 8 2.8z"/></svg>',
};

// ── toasts & dialogs ──
let toastsEl = null;
export function toast(msg, opts = {}) {
  if (!toastsEl) {
    toastsEl = document.createElement("div");
    toastsEl.className = "toasts";
    document.body.appendChild(toastsEl);
  }
  const t = document.createElement("div");
  t.className = "toast" + (opts.bad ? " bad" : "");
  t.innerHTML = `<span>${esc(msg)}</span>${opts.undo ? "<button>Undo</button>" : ""}`;
  if (opts.undo) t.querySelector("button").onclick = () => {
    opts.undo();
    t.remove();
  };
  toastsEl.appendChild(t);
  setTimeout(() => t.remove(), opts.ms || (opts.bad ? 7000 : 4200));
}
export const fail = (e) => toast(e && e.message ? e.message : String(e), { bad: true });

/**
 * A dialog with a form. `body` is HTML; inputs with a name= are returned.
 * Resolves with { action, values } or null on cancel.
 */
export function dialog({ title, body = "", actions = [{ label: "Cancel", value: null }, { label: "OK", value: "ok", primary: true }], wide = false, onMount }) {
  return new Promise((resolve) => {
    const ov = document.createElement("div");
    ov.className = "overlay";
    ov.innerHTML = `<form class="dialog" style="${wide ? "width:min(760px,100%)" : ""}"><h3>${esc(title)}</h3><div class="dlg-body">${body}</div><div class="acts">${actions
      .map((a, i) => `<button type="${a.primary ? "submit" : "button"}" class="btn ${a.primary ? "primary" : ""} ${a.danger ? "danger" : ""}" data-i="${i}">${esc(a.label)}</button>`)
      .join("")}</div></form>`;
    const form = ov.querySelector("form");
    const close = (v) => {
      ov.remove();
      document.removeEventListener("keydown", onKey);
      resolve(v);
    };
    const values = () => {
      const out = {};
      form.querySelectorAll("[name]").forEach((el) => {
        out[el.name] = el.type === "checkbox" ? el.checked : el.value;
      });
      return out;
    };
    const onKey = (e) => {
      if (e.key === "Escape") close(null);
    };
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const a = actions.find((x) => x.primary);
      close(a && a.value !== null ? { action: a.value, values: values() } : null);
    });
    form.querySelectorAll("button[data-i]").forEach((b) => {
      if (b.type === "submit") return;
      b.onclick = () => {
        const a = actions[Number(b.dataset.i)];
        close(a.value === null ? null : { action: a.value, values: values() });
      };
    });
    ov.addEventListener("mousedown", (e) => {
      if (e.target === ov) close(null);
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(ov);
    if (onMount) onMount(form);
    const first = form.querySelector("input,textarea,select");
    if (first) setTimeout(() => first.focus(), 30);
  });
}
export async function confirmBox(title, text, okLabel = "Confirm", danger = false) {
  const r = await dialog({ title, body: `<p class="muted" style="margin:0">${esc(text)}</p>`, actions: [{ label: "Cancel", value: null }, { label: okLabel, value: "ok", primary: true, danger }] });
  return !!r;
}

// ── delegated events ──
export function on(root, type, selector, fn) {
  // One handler per (element, event, selector): a screen that redraws binds again
  // and replaces its previous handler instead of stacking a second one.
  root._uosH = root._uosH || {};
  const key = type + "|" + selector;
  if (root._uosH[key]) root.removeEventListener(type, root._uosH[key]);
  const h = (e) => {
    const t = e.target.closest(selector);
    if (t && root.contains(t)) fn(e, t);
  };
  root._uosH[key] = h;
  root.addEventListener(type, h);
}

// ── resizable panels: drag a handle, the size lives in a CSS variable ──
export function applySizes() {
  const sizes = store.get("sizes", {});
  for (const [k, v] of Object.entries(sizes)) document.documentElement.style.setProperty(k, v + "px");
}
export function resizer(handle, { varName, min, max, invert = false }) {
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("drag");
    const start = e.clientX;
    const cur = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(varName)) || 300;
    const frames = document.querySelectorAll("iframe");
    frames.forEach((f) => (f.style.pointerEvents = "none"));
    const move = (ev) => {
      const dx = (ev.clientX - start) * (invert ? -1 : 1);
      const w = Math.max(min, Math.min(max, cur + dx));
      document.documentElement.style.setProperty(varName, w + "px");
    };
    const up = () => {
      handle.classList.remove("drag");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      frames.forEach((f) => (f.style.pointerEvents = ""));
      const sizes = store.get("sizes", {});
      sizes[varName] = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(varName));
      store.set("sizes", sizes);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
  handle.addEventListener("dblclick", () => {
    const sizes = store.get("sizes", {});
    delete sizes[varName];
    store.set("sizes", sizes);
    document.documentElement.style.removeProperty(varName);
  });
}

// ── screens & peeks registry, routing ──
export const screens = {};
export const peeks = {};
export function parseRoute() {
  const h = (location.hash || "").replace(/^#\/?/, "");
  const [path, qs] = h.split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const q = Object.fromEntries(new URLSearchParams(qs || ""));
  return { screen: parts[0] || "", parts: parts.slice(1), q };
}
export function go(screen, ...parts) {
  const h = "#/" + [screen, ...parts.filter((p) => p != null && p !== "")].map(encodeURIComponent).join("/");
  if (location.hash === h) emit("route");
  else location.hash = h;
}

// ── the Copilot (/m) embed ──
/** The theme the OS shows now: the one picked with the moon button, else the system's. */
export function currentTheme() {
  const t = document.documentElement.getAttribute("data-theme");
  if (t === "light" || t === "dark") return t;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
/** The Copilot inside the OS wears the OS look; it follows the theme when it changes. */
export function syncCopilotTheme() {
  document.querySelectorAll("iframe.copilot-frame, iframe.kpi").forEach((f) => {
    try {
      f.contentWindow.postMessage({ source: "copilot-bridge", type: "theme", theme: currentTheme() }, S.meta.copilotOrigin);
    } catch (e) {
      /* the frame is still loading; it read the theme from its URL */
    }
  });
}
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => S.meta && syncCopilotTheme());
export function copilotUrl(broker, leadId, single) {
  const qs = new URLSearchParams();
  qs.set("broker", broker || "");
  if (leadId) qs.set("lead", String(leadId));
  if (single) qs.set("single", "1");
  qs.set("host", "os");
  qs.set("theme", currentTheme());
  return `${S.meta.copilotOrigin}/m?${qs.toString()}`;
}
export function brokerForLead(responsible) {
  if (!isStaff() && S.user.brokerKey) return S.user.brokerKey;
  return responsible || S.user.brokerKey || "hos";
}
/**
 * Mounts (or reuses) the Copilot inside `host`: the amoCRM Copilot page itself, dressed as the OS
 * by the server (host=os). single: one card's Copilot in a side panel, without its list.
 */
export function mountCopilot(host, broker, leadId, single) {
  let f = host.querySelector("iframe.copilot-frame");
  const want = copilotUrl(broker, leadId, single);
  if (f && f.dataset.broker === broker) {
    if (f.dataset.lead !== String(leadId || "")) {
      f.dataset.lead = String(leadId || "");
      try {
        f.contentWindow.postMessage({ source: "copilot-bridge", type: "lead", leadId: String(leadId) }, S.meta.copilotOrigin);
      } catch (e) {
        f.src = want;
      }
    }
    return f;
  }
  host.innerHTML = `<iframe class="copilot-frame" allow="microphone; clipboard-write; notifications" title="Copilot"></iframe><div class="frame-note">Opening the Copilot…</div>`;
  f = host.querySelector("iframe");
  f.dataset.broker = broker;
  f.dataset.lead = String(leadId || "");
  f.addEventListener("load", () => {
    const n = host.querySelector(".frame-note");
    if (n) n.remove();
  });
  f.src = want;
  return f;
}
// /m tells us when it sent something: lists refresh at once.
window.addEventListener("message", (e) => {
  if (!S.meta || e.origin !== S.meta.copilotOrigin) return;
  const dd = e.data;
  if (!dd || dd.source !== "copilot-embed") return;
  if (dd.type === "sent") {
    dropCache("inbox");
    dropCache("board");
    emit("lead-changed", { leadId: dd.leadId });
  }
});

// ── dictation (the Copilot's own transcription endpoint) ──
export async function recordVoice(button, onText) {
  if (button._rec) {
    button._rec.stop();
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    toast("Microphone is blocked in this browser.", { bad: true });
    return;
  }
  const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/mp4";
  const rec = new MediaRecorder(stream, { mimeType: mime });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    button._rec = null;
    button.classList.remove("rec");
    button.innerHTML = button._label;
    const blob = new Blob(chunks, { type: mime });
    if (blob.size < 1200) return;
    button.disabled = true;
    try {
      const res = await fetch("/os/api/p/transcribe", { method: "POST", credentials: "same-origin", headers: { "Content-Type": mime }, body: blob });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Transcription failed");
      onText(String(j.text || "").trim());
    } catch (e) {
      fail(e);
    } finally {
      button.disabled = false;
    }
  };
  button._label = button.innerHTML;
  button._rec = rec;
  button.classList.add("rec");
  button.innerHTML = `${I.mic} Stop`;
  rec.start();
}

// ── cards and villas shared bits ──
export const TEMP_CLASS = { hot: "hot", warm: "warm", cold: "cold" };
export function stageOwner(pipelineKey, stage) {
  const s = String(stage || "").toLowerCase();
  if (/closed|won|lost|contract signed|check in|live$/.test(s)) return s === "live" && pipelineKey === "rental-listings" ? "site" : "person";
  if (pipelineKey === "rental" && /need assessed|options sent|viewing scheduled|viewing done|objection/.test(s)) return "code";
  if (pipelineKey === "rental-listings" && /taken to work|qualified|inspection|long term|co-broke/.test(s)) return "code";
  return null;
}
/** Two queues: Live (the client just wrote) and Push (everything we start). Reach was dropped on 26.09: the team does not use it; those drafts sit in Push. */
export function queueOf(item) {
  return item.kind === "live" ? "live" : "push";
}
/** The site's image edge serves every catalog photo resized: /img/<bucket>/<path>?w=<width>. */
export function imgUrl(u, w = 600) {
  if (!u) return "";
  const m = String(u).match(/\/storage\/v1\/object\/public\/(.+)$/);
  return m ? `https://unicorn-properties.com/img/${m[1]}?w=${w}` : u;
}
export const coverUrl = (images, w = 600) => imgUrl(Array.isArray(images) ? images[0] : null, w);
export function imgFallback(el) {
  el.addEventListener(
    "error",
    (e) => {
      const img = e.target;
      if (img.tagName === "IMG" && img.dataset.raw && img.src !== img.dataset.raw) img.src = img.dataset.raw;
    },
    true,
  );
}

// ── one look for every dropdown ──
// The browser's own select popup (the blue macOS list) does not match the OS.
// Every <select> stays a real select, so values and change handlers work as
// before; only the list that opens is ours. Multi-selects keep the native one.
let openMenu = null;
function closeSelectMenu() {
  if (!openMenu) return;
  openMenu.el.remove();
  openMenu.select.classList.remove("uselect-open");
  document.removeEventListener("keydown", openMenu.onKey, true);
  openMenu = null;
}
function pickOption(select, index) {
  if (select.selectedIndex !== index) {
    select.selectedIndex = index;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }
}
function openSelectMenu(select) {
  closeSelectMenu();
  const opts = [...select.options];
  const many = opts.length > 10;
  const el = document.createElement("div");
  el.className = "uselect-menu";
  el.setAttribute("role", "listbox");
  const rowsHtml = (filter) => {
    let html = "";
    let lastGroup = null;
    opts.forEach((o, i) => {
      if (filter && !o.text.toLowerCase().includes(filter)) return;
      const g = o.parentElement?.tagName === "OPTGROUP" ? o.parentElement.label : null;
      if (g !== lastGroup && g) html += `<div class="grp">${esc(g)}</div>`;
      lastGroup = g;
      html += `<div class="opt ${i === select.selectedIndex ? "sel" : ""} ${o.disabled ? "dis" : ""}" role="option" data-i="${i}"><span class="ck">${i === select.selectedIndex ? I.check : ""}</span><span class="tx">${esc(o.text)}</span></div>`;
    });
    return html || `<div class="none">Nothing matches</div>`;
  };
  el.innerHTML = `${many ? `<input class="uselect-q" placeholder="Search…" autocomplete="off">` : ""}<div class="list">${rowsHtml("")}</div>`;
  document.body.appendChild(el);
  const r = select.getBoundingClientRect();
  const w = Math.max(r.width, Math.min(320, Math.max(180, r.width)));
  el.style.minWidth = w + "px";
  const below = window.innerHeight - r.bottom;
  const h = Math.min(el.offsetHeight, 340);
  el.style.left = Math.max(8, Math.min(r.left, window.innerWidth - el.offsetWidth - 8)) + "px";
  el.style.top = (below < h + 12 && r.top > below ? Math.max(8, r.top - h - 4) : r.bottom + 4) + "px";
  select.classList.add("uselect-open");
  const list = el.querySelector(".list");
  let hi = select.selectedIndex;
  const mark = () => {
    list.querySelectorAll(".opt.hi").forEach((x) => x.classList.remove("hi"));
    const cur = list.querySelector(`.opt[data-i="${hi}"]`);
    if (cur) {
      cur.classList.add("hi");
      cur.scrollIntoView({ block: "nearest" });
    }
  };
  mark();
  const visible = () => [...list.querySelectorAll(".opt:not(.dis)")].map((x) => Number(x.dataset.i));
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeSelectMenu();
      select.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const v = visible();
      const at = v.indexOf(hi);
      hi = v[Math.max(0, Math.min(v.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))] ?? v[0];
      mark();
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (hi >= 0 && !opts[hi]?.disabled) pickOption(select, hi);
      closeSelectMenu();
      select.focus();
    } else if (e.key === "Tab") closeSelectMenu();
  };
  document.addEventListener("keydown", onKey, true);
  openMenu = { el, select, onKey };
  const q = el.querySelector(".uselect-q");
  if (q) {
    q.focus();
    q.addEventListener("input", () => {
      list.innerHTML = rowsHtml(q.value.trim().toLowerCase());
      hi = visible()[0] ?? -1;
      mark();
    });
  }
  list.addEventListener("mousedown", (e) => e.preventDefault());
  list.addEventListener("click", (e) => {
    const o = e.target.closest(".opt");
    if (!o || o.classList.contains("dis")) return;
    pickOption(select, Number(o.dataset.i));
    closeSelectMenu();
  });
}
const enhanceable = (t) => t && t.tagName === "SELECT" && !t.multiple && !t.disabled && !t.closest(".native-select");
document.addEventListener(
  "pointerdown",
  (e) => {
    if (openMenu && !openMenu.el.contains(e.target) && e.target !== openMenu.select) closeSelectMenu();
    const t = e.target.closest?.("select");
    if (!enhanceable(t) || e.button !== 0) return;
    e.preventDefault();
    if (openMenu && openMenu.select === t) return closeSelectMenu();
    t.focus({ preventScroll: true });
    openSelectMenu(t);
  },
  true,
);
// Chrome and Safari open the native list on mousedown; that list must not appear.
document.addEventListener(
  "mousedown",
  (e) => {
    const t = e.target.closest?.("select");
    if (enhanceable(t)) e.preventDefault();
  },
  true,
);
document.addEventListener(
  "keydown",
  (e) => {
    const t = document.activeElement;
    if (!enhanceable(t) || openMenu) return;
    if (e.key === " " || e.key === "Enter" || (e.altKey && e.key === "ArrowDown")) {
      e.preventDefault();
      openSelectMenu(t);
    }
  },
  true,
);
window.addEventListener("resize", closeSelectMenu);
document.addEventListener("scroll", (e) => openMenu && !openMenu.el.contains(e.target) && closeSelectMenu(), true);

/**
 * The column a drag is over: the one under the pointer, or else the one whose
 * left–right span holds it. Dropping anywhere above or below a stage, not only
 * on its cards, puts the card in that stage (owner, 26.09).
 */
export function dropColumn(board, e) {
  const direct = e.target.closest?.("[data-drop]");
  if (direct && board.contains(direct)) return direct;
  return [...board.querySelectorAll("[data-drop]")].find((c) => {
    const r = c.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right;
  }) || null;
}
/**
 * Drag handlers for a board live on the whole screen around it, so a card let
 * go below the columns or in the margin still lands. One handler per event:
 * a redrawn board replaces the old ones instead of stacking.
 */
export function boardListen(board, type, fn) {
  const host = board.closest(".content") || board.parentElement || board;
  host._boardH = host._boardH || {};
  if (host._boardH[type]) host.removeEventListener(type, host._boardH[type]);
  host._boardH[type] = fn;
  host.addEventListener(type, fn);
}
