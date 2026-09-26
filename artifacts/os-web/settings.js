// Unicorn OS — settings: profile, this device's notifications, the team and roles, integrations.
import { S, api, esc, I, screens, on, toast, fail, dialog, isStaff, rel, emit } from "./core.js";

const ROLE_TEXT = {
  admin: "Everything, including the team and the switches.",
  manager: "Everything except managing the team.",
  broker: "Own cards, tasks and calendar; villas; no switches, no costs, no other brokers' cards.",
  partner: "The money: dashboard, P&L, staff and expenses.",
};

screens.settings = {
  title: "Settings",
  async render({ el, tools, route }) {
    const staff = isStaff();
    const tabs = [["profile", "Profile"], ...(staff ? [["team", "Team & roles"], ["integrations", "Integrations"]] : [])];
    const tab = tabs.some((t) => t[0] === route.parts[0]) ? route.parts[0] : "profile";
    tools.innerHTML = `<div class="views">${tabs.map(([k, l]) => `<button data-stab="${k}" class="${k === tab ? "active" : ""}">${esc(l)}</button>`).join("")}</div>`;
    on(tools, "click", "[data-stab]", (e, b) => (location.hash = `#/settings/${b.dataset.stab}`));
    el.innerHTML = `<div class="loading">Loading…</div>`;
    if (tab === "profile") return profile(el);
    if (tab === "team") return team(el);
    return integrations(el);
  },
};

function profile(el) {
  const u = S.user;
  el.innerHTML = `<div class="page kgrid">
    <div class="panel"><h3>You</h3><dl class="props"><dt>Name</dt><dd>${esc(u.name)}</dd><dt>Login</dt><dd class="mono">${esc(u.login)}</dd><dt>Role</dt><dd>${esc(u.role)} <span class="faint">— ${esc(ROLE_TEXT[u.role] || "")}</span></dd><dt>Copilot name</dt><dd>${esc(u.brokerKey || "—")}</dd></dl></div>
    <div class="panel"><h3>Password</h3><form id="pw" class="stack"><label class="fld"><span>Current password</span><input class="in" type="password" name="current" autocomplete="current-password" required></label>
      <label class="fld"><span>New password (10+ characters)</span><input class="in" type="password" name="next" autocomplete="new-password" required minlength="10"></label><button class="btn primary" type="submit">Change password</button></form></div>
    <div class="panel"><h3>Notifications on this device</h3><p class="muted" style="margin:0 0 8px">Client replies, due promises and reports arrive as push notifications, the same ones the Copilot sends. On iPhone add Unicorn OS to the home screen first (Share → Add to Home Screen).</p>
      <div class="row"><button class="btn primary" id="push-on">${I.bell} Enable notifications here</button><span class="faint" id="push-state">${"Notification" in window ? "Browser permission: " + Notification.permission : "This browser has no notifications"}</span></div></div>
    <div class="panel"><h3>Layout</h3><p class="muted" style="margin:0 0 8px">Every border between columns can be dragged; double-click a border to reset it. The sidebar has three states: full, icons, hidden (it slides out when the mouse touches the left edge). Shortcut: <span class="kbd">[</span>. Search: <span class="kbd">⌘K</span>.</p>
      <button class="btn" id="reset-layout">Reset all column widths</button></div>
  </div>`;
  el.querySelector("#pw").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api("/password", { body: { current: f.current.value, next: f.next.value } });
      toast("Password changed");
      f.reset();
    } catch (err) {
      fail(err);
    }
  };
  el.querySelector("#push-on").onclick = () => emit("enable-push");
  el.querySelector("#reset-layout").onclick = () => {
    try {
      localStorage.removeItem("uos:sizes");
    } catch (e) {
      /* ignore */
    }
    for (const v of ["--sidebar-w", "--list-w", "--ctx-w", "--peek-w"]) document.documentElement.style.removeProperty(v);
    toast("Column widths reset");
  };
}

async function team(el) {
  const r = await api("/team");
  const admin = S.user.role === "admin";
  el.innerHTML = `<div class="page stack" style="gap:12px"><div class="panel"><h3>People <span class="faint">each with their own password</span>${admin ? `<button class="btn sm primary" id="t-add">${I.plus} Add a person</button>` : ""}</h3>
    <div class="tbl-wrap" style="max-height:none"><table class="grid"><thead><tr><th>Name</th><th>Login</th><th>Role</th><th>Copilot name</th><th>Last sign-in</th><th>Status</th>${admin ? "<th></th>" : ""}</tr></thead><tbody>${r.items
      .map(
        (u) => `<tr data-user="${u.id}"><td><b>${esc(u.name)}</b></td><td class="mono">${esc(u.login)}</td><td>${esc(u.role)}</td><td>${esc(u.brokerKey || "—")}</td><td>${u.lastLoginAt ? esc(rel(u.lastLoginAt)) : `<span class="faint">never</span>`}</td><td>${u.disabled ? `<span class="pill bad">disabled</span>` : u.mustChangePassword ? `<span class="pill warn">starter password</span>` : `<span class="pill ok">active</span>`}</td>
        ${admin ? `<td><button class="btn sm" data-edit="${u.id}">Edit</button> <button class="btn sm" data-reset="${u.id}">New password</button></td>` : ""}</tr>`,
      )
      .join("")}</tbody></table></div></div>
    <div class="panel"><h3>Roles</h3><dl class="props">${Object.entries(ROLE_TEXT).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
      <p class="faint" style="font-size:12px;margin:8px 0 0">"Copilot name" ties a person to their cards: it is the responsible name the Copilot uses (Amelia, Yudi, hos for the owner).</p></div></div>`;
  if (!admin) return;
  const showPassword = async (login, pw) =>
    dialog({
      title: `Password for ${login}`,
      body: `<p class="muted" style="margin:0 0 8px">Give it to the person directly. They must change it on first sign-in. It is not shown again.</p><div class="note mono" style="font-size:15px;user-select:all">${esc(pw)}</div>`,
      actions: [{ label: "Done", value: null }],
    });
  el.querySelector("#t-add").onclick = async () => {
    const res = await dialog({
      title: "Add a person",
      body: `<div class="stack"><div class="grid2"><label class="fld"><span>Name</span><input class="in" name="name" required></label><label class="fld"><span>Login</span><input class="in" name="login" required pattern="[a-z0-9._-]{2,32}" placeholder="lowercase"></label></div>
        <div class="grid2"><label class="fld"><span>Role</span><select class="in" name="role"><option value="broker">broker</option><option value="manager">manager</option><option value="admin">admin</option><option value="partner">partner</option></select></label>
        <label class="fld"><span>Copilot name (their cards)</span><input class="in" name="brokerKey" list="brokers-dl" placeholder="e.g. Amelia"><datalist id="brokers-dl">${S.meta.brokers.map((b) => `<option value="${esc(b)}">`).join("")}</datalist></label></div></div>`,
      actions: [{ label: "Cancel", value: null }, { label: "Create", value: "ok", primary: true }],
    });
    if (!res) return;
    try {
      const out = await api("/team", { body: res.values });
      await showPassword(out.user.login, out.password);
      team(el);
    } catch (e) {
      fail(e);
    }
  };
  on(el, "click", "[data-reset]", async (e, b) => {
    const u = r.items.find((x) => String(x.id) === b.dataset.reset);
    const res = await dialog({ title: `New password for ${u.name}?`, body: `<p class="muted" style="margin:0">Their current sessions are signed out.</p>`, actions: [{ label: "Cancel", value: null }, { label: "Make a new password", value: "ok", primary: true }] });
    if (!res) return;
    try {
      const out = await api(`/team/${u.id}/reset`, { body: {} });
      await showPassword(u.login, out.password);
      team(el);
    } catch (err) {
      fail(err);
    }
  });
  on(el, "click", "[data-edit]", async (e, b) => {
    const u = r.items.find((x) => String(x.id) === b.dataset.edit);
    const res = await dialog({
      title: `Edit ${u.name}`,
      body: `<div class="stack"><div class="grid2"><label class="fld"><span>Name</span><input class="in" name="name" value="${esc(u.name)}"></label><label class="fld"><span>Role</span><select class="in" name="role">${["broker", "manager", "admin", "partner"].map((x) => `<option ${x === u.role ? "selected" : ""}>${x}</option>`).join("")}</select></label></div>
        <label class="fld"><span>Copilot name</span><input class="in" name="brokerKey" value="${esc(u.brokerKey || "")}"></label>
        <label class="row" style="gap:6px"><input type="checkbox" name="disabled" ${u.disabled ? "checked" : ""}> Disabled (cannot sign in)</label></div>`,
      actions: [{ label: "Cancel", value: null }, { label: "Save", value: "ok", primary: true }],
    });
    if (!res) return;
    try {
      await api(`/team/${u.id}`, { method: "PATCH", body: res.values });
      toast("Saved");
      team(el);
    } catch (err) {
      fail(err);
    }
  });
}

async function integrations(el) {
  const r = await api("/integrations");
  const ok = (b) => (b ? `<span class="pill ok">working</span>` : `<span class="pill bad">not working</span>`);
  const fresh = (at, mins) => (at && Date.now() - new Date(at).getTime() < mins * 60e3 ? `<span class="pill ok">${esc(rel(at))}</span>` : at ? `<span class="pill warn">${esc(rel(at))}</span>` : `<span class="pill bad">never</span>`);
  const wa = r.whatsapp || [];
  const ai = r.ai || {};
  el.innerHTML = `<div class="page stack" style="gap:12px">
    <div class="panel"><h3>WhatsApp numbers <span class="faint">our own gateway</span></h3><div class="tbl-wrap" style="max-height:none"><table class="grid"><thead><tr><th>Number</th><th>Label</th><th>Status</th><th>Mode</th><th>Funnel</th><th>Owner</th><th>Updated</th></tr></thead><tbody>${wa
      .map((s) => `<tr><td class="mono">${esc(s.phone || s.name)}</td><td>${esc(s.label || s.name)}</td><td>${/open|connected|online|live/i.test(String(s.status)) ? `<span class="pill ok">${esc(s.status)}</span>` : `<span class="pill warn">${esc(s.status || "unknown")}</span>`}</td><td>${esc(s.mode)}</td><td>${esc(s.pipeline || "")}</td><td>${esc(s.responsible || "")}</td><td>${esc(rel(s.updated_at))}</td></tr>`)
      .join("") || `<tr><td colspan="7" class="empty">No sessions registered.</td></tr>`}</tbody></table></div>
      <p class="faint" style="font-size:12px;margin:8px 0 0">Last message through the gateway: ${esc(rel(r.whatsappLastMessage))}. Messages reach cards through amoCRM's channel; the last one stored: ${esc(rel(r.amoLastMessage))}.</p></div>
    <div class="kgrid">
      <div class="panel"><h3>amoCRM ${ok(r.amocrm?.ok)}</h3><dl class="props"><dt>Account</dt><dd>${esc(r.amocrm?.name || "—")}</dd><dt>Cards synced</dt><dd>${fresh(r.amoLastSync, 15)}</dd><dt>Messages synced</dt><dd>${fresh(r.amoLastMessage, 120)}</dd></dl>
        <p class="faint" style="font-size:12px;margin:8px 0 0">During the transition amoCRM stays the record: stages, tasks and the WhatsApp channel live there, and Unicorn OS reads and writes them through its API.</p></div>
      <div class="panel"><h3>AI (Anthropic) ${ok(!ai.outage)}</h3><dl class="props"><dt>Last success</dt><dd>${ai.minutesSinceLastSuccess == null ? "—" : ai.minutesSinceLastSuccess + " min ago"}</dd><dt>Recent failures</dt><dd>${esc(ai.recentFailures ?? 0)}${ai.lastFailureKind ? ` · ${esc(ai.lastFailureKind)}` : ""}</dd><dt>Spent today</dt><dd>${r.aiSpendToday != null ? "$" + esc(r.aiSpendToday) : "—"}</dd></dl></div>
      <div class="panel"><h3>Website catalog ${ok(r.site?.configured)}</h3><p class="muted" style="margin:0">Villas are read from and written to the site's own database (unicorn-properties.com). Edits pass the site's rules and are read back.</p></div>
      <div class="panel"><h3>Google Calendar ${ok(r.calendar?.configured)}</h3><dl class="props"><dt>Calendar</dt><dd>${esc(r.calendar?.calendarId || "—")}</dd><dt>Last inspection event</dt><dd>${esc(rel(r.calendar?.lastInspectionEvent))}</dd></dl><p class="faint" style="font-size:12px;margin:8px 0 0">Agreed viewings and inspections are added to the shared Brokers calendar through Make; the calendar is only ever added to.</p></div>
      <div class="panel"><h3>Meta ads spend</h3><dl class="props"><dt>Last pull</dt><dd>${fresh(r.metaSpendLast, 6 * 60)}</dd></dl><p class="faint" style="font-size:12px;margin:8px 0 0">Pulled every 4 hours through Make. The Facebook connection in Make expires on 25.10.2026 and must be reconnected there.</p></div>
      <div class="panel"><h3>Push notifications</h3><dl class="props">${(r.push || []).map((p) => `<dt>${esc(p.broker_id)}</dt><dd>${p.devices} device${p.devices === 1 ? "" : "s"}</dd>`).join("") || "<dt>—</dt><dd>nobody subscribed</dd>"}</dl></div>
      <div class="panel"><h3>Google Drive</h3><p class="muted" style="margin:0">Each villa links to its Drive folder (Internal data). Inspection reports copy photos and video there through Make.</p></div>
    </div></div>`;
}
