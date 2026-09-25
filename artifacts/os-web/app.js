// Unicorn OS — entry: sign-in, shell, navigation, notifications, search.
import { S, api, esc, I, store, toast, fail, dialog, on, resizer, applySizes, screens, peeks, parseRoute, go, emit, onBus, rel, initials, isStaff, dropCache, syncCopilotTheme } from "./core.js";
import "./inbox.js";
import "./pipelines.js";
import "./listings.js";
import "./calendar.js";
import "./analytics.js";
import "./automations.js";
import "./settings.js";
import { searchProjects, warmProjects } from "./projects.js";

const app = document.getElementById("app");
applySizes();

// ── sign-in ──
function renderLogin(msg) {
  app.innerHTML = `<div class="login"><form class="login-card" id="login">
    <div class="brand"><div class="logo">U</div><div><h1>Unicorn OS</h1><p>Rentals, listings and sales in one place.</p></div></div>
    <label class="fld"><span>Login</span><input class="in" name="login" autocomplete="username" autocapitalize="none" required></label>
    <label class="fld"><span>Password</span><input class="in" name="password" type="password" autocomplete="current-password" required></label>
    <div class="err" id="login-err">${esc(msg || "")}</div>
    <button class="btn primary" type="submit">Sign in</button>
    <p class="faint" style="font-size:12px">No account? Ask Nikita to add you in Settings → Team.</p>
  </form></div>`;
  const f = document.getElementById("login");
  f.querySelector("input").focus();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const b = f.querySelector("button");
    b.disabled = true;
    try {
      const r = await api("/login", { body: { login: f.login.value, password: f.password.value }, allow401: true });
      S.user = r.user;
      await boot();
    } catch (err) {
      document.getElementById("login-err").textContent = err.message;
      b.disabled = false;
    }
  };
}

async function forcePassword() {
  for (;;) {
    const r = await dialog({
      title: "Choose your own password",
      body: `<p class="muted" style="margin:0 0 10px">This account still has the starter password. Pick one only you know.</p>
        <div class="stack"><label class="fld"><span>Current password</span><input class="in" name="current" type="password" autocomplete="current-password"></label>
        <label class="fld"><span>New password (10+ characters)</span><input class="in" name="next" type="password" autocomplete="new-password"></label></div>`,
      actions: [{ label: "Save password", value: "ok", primary: true }],
    });
    if (!r) continue;
    try {
      await api("/password", { body: r.values });
      S.user.mustChangePassword = false;
      toast("Password saved");
      return;
    } catch (e) {
      fail(e);
    }
  }
}

onBus("signed-out", () => renderLogin("You were signed out. Sign in again."));

// ── navigation ──
function navItems() {
  const staff = isStaff();
  const items = [
    { id: "tasks", label: "Tasks", icon: I.inbox },
    { sec: "Pipelines" },
    { id: "pipeline/rental", label: "Rental leads", dot: "var(--live)" },
    { id: "pipeline/rental-listings", label: "Rental Listings", dot: "var(--reach)" },
    { id: "pipeline/unicorn", label: "UNICORN sales", dot: "var(--accent)", staffOnly: true },
    { sec: "Workspace" },
    { id: "projects", label: "Projects", icon: I.goal },
    { id: "listings", label: "Listings", icon: I.villa },
    { id: "calendar", label: "Calendar", icon: I.cal },
    { id: "analytics", label: "Analytics", icon: I.chart },
    { sec: "System" },
    { id: "automations", label: "Automations", icon: I.auto },
    { id: "settings", label: "Settings", icon: I.gear },
  ];
  return items.filter((x) => !x.staffOnly || staff);
}
function currentNavId() {
  const r = parseRoute();
  return r.screen === "pipeline" ? `pipeline/${r.parts[0] || "rental"}` : r.screen;
}

function sidebarMode() {
  return store.get("sidebar", "full");
}
function setSidebarMode(m) {
  store.set("sidebar", m);
  const sh = document.querySelector(".shell");
  if (!sh) return;
  sh.classList.remove("rail", "hidden", "reveal");
  if (m !== "full") sh.classList.add(m);
}

function renderShell() {
  const mode = sidebarMode();
  app.innerHTML = `<div class="shell ${mode === "full" ? "" : mode}">
    <div class="edge-zone"></div>
    <aside class="sidebar">
      <div class="ws"><div class="logo">U</div><div class="name">Unicorn OS</div>
        <button class="collapse" id="sb-mode" title="Collapse the sidebar ( [ )">${I.left}</button></div>
      <button class="search" id="open-palette">${I.search}<span>Search or jump to…</span><span class="kbd">⌘K</span></button>
      <nav id="nav"></nav>
      <div class="foot"><div class="avatar sm">${esc(initials(S.user.name))}</div><span class="who-name" style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(S.user.name)} <span class="faint">· ${esc(S.user.role)}</span></span></div>
      <div class="resize-x" id="sb-resize" title="Drag to resize · double-click to reset"></div>
    </aside>
    <div class="main">
      <div class="topbar">
        <button class="iconbtn backbtn" id="m-back" hidden>${I.back}</button>
        <button class="iconbtn hide-m" id="sb-toggle" title="Sidebar: full / icons / hidden ( [ )">${I.panel}</button>
        <div class="crumb" id="crumb"></div>
        <div class="tools" id="tools"></div>
        <div class="spacer"></div>
        <button class="iconbtn" id="bell" title="Notifications">${I.bell}<span class="cnt" id="bell-cnt" hidden></span></button>
        <button class="iconbtn hide-m" id="theme" title="Light / dark">${I.moon}</button>
        <button class="iconbtn" id="signout" title="Sign out">${I.out}</button>
      </div>
      <div class="preview-bar" id="preview-bar">Preview · amoCRM and the Copilot stay the working tools for now. Unicorn OS shows the same live data, so any change made here (a stage, a task, a villa) is real.<button id="preview-x" title="Hide">×</button></div>
      <div class="body" style="position:relative;flex:1;min-height:0;display:flex">
        <div class="content" id="content"></div>
        <div class="peek" id="peek" hidden></div>
      </div>
      <div class="notif" id="notif" hidden></div>
    </div>
    <nav class="mobile-nav" id="mnav"></nav>
  </div>`;
  renderNav();
  const pb = document.getElementById("preview-bar");
  if (store.get("preview-hidden-" + new Date().toISOString().slice(0, 10), false)) pb.hidden = true;
  document.getElementById("preview-x").onclick = () => {
    pb.hidden = true;
    store.set("preview-hidden-" + new Date().toISOString().slice(0, 10), true);
  };
  resizer(document.getElementById("sb-resize"), { varName: "--sidebar-w", min: 180, max: 420 });
  const sh = app.querySelector(".shell");
  const cycle = () => {
    const m = sidebarMode();
    setSidebarMode(m === "full" ? "rail" : m === "rail" ? "hidden" : "full");
    renderNav();
  };
  document.getElementById("sb-toggle").onclick = cycle;
  document.getElementById("sb-mode").onclick = cycle;
  // Hidden mode: the sidebar slides in when the mouse touches the left edge.
  sh.querySelector(".edge-zone").addEventListener("mouseenter", () => sh.classList.add("reveal"));
  sh.querySelector(".sidebar").addEventListener("mouseleave", () => sh.classList.remove("reveal"));
  document.getElementById("open-palette").onclick = openPalette;
  document.getElementById("theme").onclick = toggleTheme;
  document.getElementById("signout").onclick = async () => {
    await api("/logout", { body: {} }).catch(() => undefined);
    S.user = null;
    renderLogin();
  };
  document.getElementById("bell").onclick = toggleNotif;
  on(document.getElementById("nav"), "click", "[data-go]", (e, t) => {
    e.preventDefault();
    location.hash = "#/" + t.dataset.go;
    if (sh.classList.contains("hidden")) sh.classList.remove("reveal");
  });
  on(document.getElementById("mnav"), "click", "[data-go]", (e, t) => {
    location.hash = "#/" + t.dataset.go;
  });
}

function renderNav() {
  const cur = currentNavId();
  const counts = S.cache["counts"]?.value || {};
  const html = navItems()
    .map((n) => {
      if (n.sec) return `<div class="nav-section">${n.sec}</div>`;
      const badge = n.id === "tasks" && counts.inbox ? `<span class="badge live">${counts.inbox}</span>` : "";
      return `<a href="#/${n.id}" class="nav ${cur === n.id ? "active" : ""}" data-go="${n.id}" title="${esc(n.label)}">${n.dot ? `<span class="dot" style="background:${n.dot}"></span>` : n.icon}<span class="lbl">${esc(n.label)}</span>${badge}</a>`;
    })
    .join("");
  const nav = document.getElementById("nav");
  if (nav) nav.innerHTML = html;
  const mn = document.getElementById("mnav");
  if (mn) {
    const tabs = [
      ["tasks", "Tasks", I.inbox, counts.inbox],
      ["calendar", "Calendar", I.cal],
      ["pipeline/rental", "Leads", I.board],
      ["listings", "Listings", I.villa],
      ["more", "More", I.gear],
    ];
    mn.innerHTML = tabs
      .map(([id, l, ic, c]) => `<button data-go="${id}" class="${cur === id || (id === "more" && ["projects", "analytics", "automations", "settings", "more"].includes(cur)) ? "active" : ""}">${ic}<span>${l}</span>${c ? `<span class="cnt">${c}</span>` : ""}</button>`)
      .join("");
  }
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme");
  const sys = matchMedia("(prefers-color-scheme: dark)").matches;
  const next = cur === "dark" ? "light" : cur === "light" ? "dark" : sys ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try {
    localStorage.setItem("uos-theme", next);
  } catch (e) {
    /* ignore */
  }
  syncCopilotTheme();
}

// ── routing ──
let currentScreen = null;
async function route() {
  if (!S.user) return;
  const r = parseRoute();
  if (!r.screen) {
    go("tasks");
    return;
  }
  S.route = r;
  renderNav();
  const name = r.screen;
  const sc = screens[name] || screens.tasks;
  const content = document.getElementById("content");
  const tools = document.getElementById("tools");
  const crumb = document.getElementById("crumb");
  if (currentScreen && currentScreen !== sc && currentScreen.leave) currentScreen.leave();
  if (currentScreen !== sc) closePeek();
  currentScreen = sc;
  content.className = "content" + (sc.flush ? " flush" : "");
  tools.innerHTML = "";
  crumb.textContent = typeof sc.title === "function" ? sc.title(r) : sc.title || "";
  document.getElementById("m-back").hidden = true;
  try {
    await sc.render({ el: content, tools, crumb, route: r, back: document.getElementById("m-back") });
  } catch (e) {
    if (e.status === 401) return;
    content.innerHTML = `<div class="empty">Could not load this screen: ${esc(e.message)}</div>`;
  }
  if (r.q.lead && name !== "tasks" && name !== "inbox") openPeek("lead", r.q.lead);
  if (r.q.villa) openPeek("villa", r.q.villa);
  if (r.q.ptask) openPeek("ptask", r.q.ptask);
}
window.addEventListener("hashchange", route);
onBus("route", route);

// ── the side peek (cards and villas open here, from any screen) ──
export function openPeek(type, id, tab) {
  const p = peeks[type];
  if (!p) return;
  const el = document.getElementById("peek");
  if (!el) return;
  S.peek = { type, id: String(id), tab: tab || S.peek?.tabByType?.[type] || p.defaultTab };
  el.hidden = false;
  el.parentElement?.classList.add("peek-open");
  el.innerHTML = `<div class="resize-x" id="peek-resize" title="Drag to resize · double-click to reset"></div><div class="loading">Loading…</div>`;
  resizer(document.getElementById("peek-resize"), { varName: "--peek-w", min: 360, max: Math.max(420, window.innerWidth - 240), invert: true });
  p.render(el, S.peek, { close: closePeek, setTab: (t) => openPeek(type, id, t) });
  emit("peek-open", S.peek);
}
export function closePeek() {
  const el = document.getElementById("peek");
  if (el) {
    el.hidden = true;
    el.innerHTML = "";
    el.parentElement?.classList.remove("peek-open");
  }
  if (S.peek) emit("peek-close", S.peek);
  S.peek = null;
}
window.UOS = { openPeek, closePeek };
onBus("open-peek", (d) => openPeek(d.type, d.id, d.tab));
onBus("close-peek", closePeek);

// ── notifications ──
async function refreshNotif() {
  try {
    const r = await api("/notifications");
    const before = new Set((S.notif.items || []).map((i) => i.id));
    S.notif.items = r.items || [];
    S.notif.seenAt = r.seenAt;
    const unseen = S.notif.items.filter((i) => !r.seenAt || i.at > r.seenAt).length;
    const cnt = document.getElementById("bell-cnt");
    if (cnt) {
      cnt.hidden = !unseen;
      cnt.textContent = unseen > 99 ? "99+" : String(unseen);
    }
    // A new item while the tab is open: a browser notification if allowed.
    const fresh = S.notif.items.filter((i) => !before.has(i.id) && before.size && i.kind !== "system");
    if (fresh.length && "Notification" in window && Notification.permission === "granted" && document.hidden) {
      const f = fresh[0];
      try {
        const n = new Notification(f.title, { body: f.body, icon: "/os/icon.svg", tag: f.id });
        n.onclick = () => {
          window.focus();
          if (f.leadId) openPeek("lead", f.leadId);
          else if (f.ptaskId) openPeek("ptask", f.ptaskId);
        };
      } catch (e) {
        /* some browsers only allow notifications from the service worker */
      }
    }
    // Counters for the sidebar.
    const live = S.notif.items.filter((i) => i.kind === "live").length;
    const due = S.notif.items.filter((i) => ["promise", "task", "viewing-report", "inspection-report"].includes(i.kind) || String(i.id).startsWith("pt-due:")).length;
    S.cache["counts"] = { at: Date.now(), value: { inbox: live, day: due } };
    renderNav();
    if (S.notif.open) renderNotif();
  } catch (e) {
    /* next poll */
  }
}
function renderNotif() {
  const el = document.getElementById("notif");
  if (!el) return;
  const items = S.notif.items;
  el.innerHTML = `<div style="display:flex;align-items:center;padding:10px 12px;border-bottom:1px solid var(--border)"><b>Notifications</b><span class="spacer"></span><button class="btn sm ghost" id="notif-push">Enable on this device</button></div>${
    items.length
      ? items
          .map(
            (i) =>
              `<div class="it ${!S.notif.seenAt || i.at > S.notif.seenAt ? "new" : ""} ${i.severity}" data-lead="${esc(i.leadId || "")}" data-ptask="${esc(i.ptaskId || "")}" data-kind="${esc(i.kind)}"><i></i><div><b>${esc(i.title)}</b><div class="muted">${esc(i.body)}</div><small>${rel(i.at)}</small></div></div>`,
          )
          .join("")
      : `<div class="empty">Nothing needs you right now.</div>`
  }`;
  on(el, "click", ".it", (e, t) => {
    toggleNotif();
    if (t.dataset.lead) openPeek("lead", t.dataset.lead);
    else if (t.dataset.ptask) openPeek("ptask", t.dataset.ptask);
  });
  document.getElementById("notif-push").onclick = enablePush;
}
async function toggleNotif() {
  const el = document.getElementById("notif");
  S.notif.open = el.hidden;
  el.hidden = !el.hidden;
  if (!el.hidden) {
    renderNotif();
    await api("/notifications/seen", { body: {} }).catch(() => undefined);
    S.notif.seenAt = new Date().toISOString();
    document.getElementById("bell-cnt").hidden = true;
  }
}
document.addEventListener("mousedown", (e) => {
  const el = document.getElementById("notif");
  if (el && !el.hidden && !el.contains(e.target) && !e.target.closest("#bell")) {
    el.hidden = true;
    S.notif.open = false;
  }
});

// Web push through the Copilot's own subscription endpoint, per broker key.
async function enablePush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    toast("This browser cannot receive push. On iPhone, add Unicorn OS to the home screen first.", { bad: true });
    return;
  }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      toast("Notifications are blocked for this site in the browser settings.", { bad: true });
      return;
    }
    const reg = await navigator.serviceWorker.register("/os/sw.js", { scope: "/os/" });
    await navigator.serviceWorker.ready;
    const key = await (await fetch("/os/api/p/push/vapid-public-key", { credentials: "same-origin" })).json();
    const pub = key.publicKey || key.key || key.vapidPublicKey;
    const raw = atob(pub.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((pub.length + 3) % 4));
    const appKey = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey }));
    await api("/p/push/subscribe", { body: { brokerId: S.user.brokerKey || S.user.login, subscription: sub.toJSON() } });
    store.set("push", true);
    toast("Notifications are on for this device");
  } catch (e) {
    fail(e);
  }
}
async function resyncPush() {
  if (!store.get("push", false) || !("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration("/os/");
    const sub = reg && (await reg.pushManager.getSubscription());
    if (sub && Notification.permission === "granted") await api("/p/push/subscribe", { body: { brokerId: S.user.brokerKey || S.user.login, subscription: sub.toJSON() } });
  } catch (e) {
    /* silent */
  }
}
onBus("enable-push", enablePush);

// ── ⌘K palette: screens, cards, villas ──
function openPalette() {
  const ov = document.createElement("div");
  ov.className = "overlay";
  ov.innerHTML = `<div class="palette"><input placeholder="A name, a villa code, an area, a screen…" autocomplete="off"><div class="res"></div></div>`;
  document.body.appendChild(ov);
  const input = ov.querySelector("input");
  const res = ov.querySelector(".res");
  let hi = 0;
  let list = [];
  const close = () => ov.remove();
  const build = () => {
    const q = input.value.trim().toLowerCase();
    const out = [];
    for (const n of navItems().filter((x) => x.id)) if (!q || n.label.toLowerCase().includes(q)) out.push({ grp: "Go to", label: n.label, sub: "", act: () => go(...n.id.split("/")) });
    for (const [k, c] of Object.entries(S.cache)) {
      if (!k.startsWith("board:")) continue;
      for (const card of c.value || []) {
        const hay = `${card.name} ${card.leadId} ${card.stage} ${card.request?.areas || ""}`.toLowerCase();
        if (q && hay.includes(q)) out.push({ grp: "Cards", label: card.name, sub: `${card.stage || ""} · ${card.pipeline || ""}`, act: () => openPeek("lead", card.leadId) });
      }
    }
    const villas = S.cache["villas:rent"]?.value || [];
    for (const v of villas) {
      const hay = `${v.id} ${v.title} ${v.area}`.toLowerCase();
      if (q && hay.includes(q)) out.push({ grp: "Listings", label: `${v.id} · ${v.title}`, sub: `${v.bedrooms}BR · ${v.area}`, act: () => openPeek("villa", v.id) });
    }
    out.push(...searchProjects(q));
    if (/^\d{6,}$/.test(q)) out.unshift({ grp: "Open", label: `Card #${q}`, sub: "by amoCRM id", act: () => openPeek("lead", q) });
    list = out.slice(0, 60);
    hi = Math.min(hi, Math.max(0, list.length - 1));
    let last = "";
    res.innerHTML = list.length
      ? list.map((it, i) => (it.grp !== last ? ((last = it.grp), `<div class="grp">${esc(it.grp)}</div>`) : "") + `<div class="r ${i === hi ? "hi" : ""}" data-i="${i}"><span>${esc(it.label)}</span><span class="faint" style="font-size:11.5px;margin-left:auto">${esc(it.sub)}</span></div>`).join("")
      : `<div class="empty">Nothing found. Boards you have opened are searchable; listings too.</div>`;
  };
  input.addEventListener("input", () => {
    hi = 0;
    build();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      hi = Math.min(list.length - 1, hi + 1);
      build();
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      hi = Math.max(0, hi - 1);
      build();
    }
    if (e.key === "Enter" && list[hi]) {
      close();
      list[hi].act();
    }
  });
  on(res, "click", ".r", (e, t) => {
    const it = list[Number(t.dataset.i)];
    close();
    if (it) it.act();
  });
  ov.addEventListener("mousedown", (e) => e.target === ov && close());
  build();
  input.focus();
}

document.addEventListener("keydown", (e) => {
  if (!S.user) return;
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "") || document.activeElement?.isContentEditable;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    openPalette();
  } else if (!typing && e.key === "[") {
    const m = sidebarMode();
    setSidebarMode(m === "full" ? "rail" : m === "rail" ? "hidden" : "full");
    renderNav();
  } else if (!typing && e.key === "Escape" && S.peek) {
    closePeek();
  }
});

// My day was removed on 26.09 (owner: it repeated the Inbox, now Tasks); old links open Tasks.
screens.day = { title: "Tasks", render: () => go("tasks") };

// "More" on phones: a sheet of the remaining screens.
screens.more = {
  title: "More",
  render({ el }) {
    el.innerHTML = `<div class="stack" style="max-width:480px">${[
      ["projects", "Projects", I.goal],
      ["analytics", "Analytics", I.chart],
      ["pipeline/rental-listings", "Rental Listings", I.board],
      ...(isStaff() ? [["pipeline/unicorn", "UNICORN sales", I.board]] : []),
      ["automations", "Automations", I.auto],
      ["settings", "Settings", I.gear],
    ]
      .map(([id, l, ic]) => `<a class="btn" style="justify-content:flex-start;padding:12px" href="#/${id}">${ic} ${l}</a>`)
      .join("")}<button class="btn" style="justify-content:flex-start;padding:12px" id="more-theme">${I.moon} Light / dark</button></div>`;
    document.getElementById("more-theme").onclick = toggleTheme;
  },
};

// ── boot ──
async function boot() {
  try {
    S.meta = await api("/meta");
    S.user = S.meta.user;
  } catch (e) {
    if (e.status === 401) {
      renderLogin();
      return;
    }
    app.innerHTML = `<div class="empty">Unicorn OS could not start: ${esc(e.message)}</div>`;
    return;
  }
  renderShell();
  if (S.user.mustChangePassword) await forcePassword();
  await route();
  refreshNotif();
  setInterval(refreshNotif, 60_000);
  resyncPush();
  warmProjects();
  onBus("lead-changed", () => setTimeout(refreshNotif, 1500));
}
boot();
