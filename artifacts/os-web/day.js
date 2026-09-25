// Unicorn OS — My day: what needs you now, in the order it costs us if left.
import { S, api, esc, I, screens, on, fmtDT, fmtTime, rel, isStaff, queueOf, go, emit, store, baliToday, fail } from "./core.js";
import { taskRow, bindTasks } from "./lead.js";

function startOfDay(offset = 0) {
  const t = new Date(Date.now() + 8 * 3600e3);
  const day = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + offset));
  return new Date(day.getTime() - 8 * 3600e3);
}

screens.day = {
  title: "My day",
  async render({ el, tools }) {
    const staff = isStaff();
    let scopeAll = staff && store.get("day-all", true);
    tools.innerHTML = staff ? `<select class="chip" id="day-scope"><option value="all" ${scopeAll ? "selected" : ""}>Whole team</option><option value="me" ${scopeAll ? "" : "selected"}>Only mine</option></select>` : "";
    if (staff)
      document.getElementById("day-scope").onchange = (e) => {
        store.set("day-all", e.target.value === "all");
        screens.day.render({ el, tools });
      };
    el.innerHTML = `<div class="loading">Gathering your day…</div>`;
    const brokers = staff && scopeAll ? S.meta.brokers : [S.user.brokerKey].filter(Boolean);
    api("/tasks/cleanup").then((r) => {
      const n = document.getElementById("day-cleanup");
      if (n && r.count) n.textContent = `${r.count} more open tasks sit on closed or deleted cards — clean-up, not work (close them in amoCRM when convenient).`;
    }).catch(() => undefined);
    const [tasksR, cal, notif, drafts, waitsR, waitsL, mineR] = await Promise.all([
      api(`/tasks${staff && scopeAll ? "?all=1" : ""}`).catch(() => ({ items: [] })),
      api(`/calendar?from=${startOfDay(0).toISOString()}&to=${startOfDay(2).toISOString()}`).catch(() => ({ events: [] })),
      api("/notifications").catch(() => ({ items: [] })),
      Promise.all(brokers.map((b) => api(`/p/suggestions?responsibleUser=${encodeURIComponent(b)}`).then((r) => r.items || []).catch(() => []))).then((x) => x.flat()),
      api(`/analytics/waits?pipeline=Rental`).catch(() => ({ stages: [] })),
      api(`/analytics/waits?pipeline=Rental%20Listings`).catch(() => ({ stages: [] })),
      api(`/ptasks?assignee=me`).catch(() => ({ items: [] })),
    ]);
    // Project tasks given to me (the Projects boards): late, today, this week, in progress.
    const td = baliToday();
    const in7 = new Date(Date.parse(td + "T00:00:00Z") + 7 * 86400e3).toISOString().slice(0, 10);
    const mine = (mineR.items || [])
      .filter((t) => (t.status === "Not started" || t.status === "In progress") && ((t.dueEnd || t.dueStart) ? (t.dueEnd || t.dueStart) <= in7 : t.status === "In progress"))
      .sort((a, b) => String(a.dueEnd || a.dueStart || "9999").localeCompare(String(b.dueEnd || b.dueStart || "9999")));
    const ptRow = (t) => {
      const due = t.dueEnd || t.dueStart;
      const late = due && due < td;
      return `<div class="task"><button class="cb" data-pt-done="${t.id}" title="Mark done"></button><div><div class="tt" data-pt-open="${t.id}" style="cursor:pointer">${esc(t.title)}</div><div class="ts">${t.status === "In progress" ? `<span class="pill stage">In progress</span>` : ""}${t.priority ? `<span>${esc(t.priority)}</span>` : ""}</div></div><div class="due ${late ? "over" : ""}">${due ? (due === td ? "today" : esc(new Date(due + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }))) : ""}</div></div>`;
    };
    const tasks = tasksR.items || [];
    const now = new Date();
    const endToday = startOfDay(1);
    const overdue = tasks.filter((t) => new Date(t.due) < now);
    const today = tasks.filter((t) => new Date(t.due) >= now && new Date(t.due) < endToday);
    const tomorrow = tasks.filter((t) => new Date(t.due) >= endToday && new Date(t.due) < startOfDay(2));
    const q = { live: [], reach: [], push: [] };
    for (const it of drafts) q[queueOf(it)].push(it);
    const promises = (notif.items || []).filter((i) => i.kind === "promise");
    const reports = (notif.items || []).filter((i) => i.kind === "viewing-report" || i.kind === "inspection-report");
    const events = (cal.events || []).filter((e) => e.kind !== "task" && new Date(e.at) < endToday);
    const stale = [...(waitsR.stages || []).map((s) => ({ ...s, pipe: "rental" })), ...(waitsL.stages || []).map((s) => ({ ...s, pipe: "rental-listings" }))]
      .filter((s) => s.over7 > 0 && !/long term|co-broke|live|weekly|availability|check in|contract/i.test(s.stage))
      .sort((a, b) => b.over7 - a.over7);

    const kpi = (label, v, sub, goTo) => `<button class="kpi" ${goTo ? `data-go="${goTo}"` : ""}><div class="l">${label}</div><div class="v num">${v}</div><div class="d">${sub}</div></button>`;
    const draftRows = (arr) =>
      arr
        .slice(0, 12)
        .map(
          (i) => `<div class="conv" data-open-inbox="${esc(i.lead_id)}" style="border:1px solid var(--border);border-radius:8px;background:var(--surface)"><div class="avatar sm">${esc((i.lead_name || "#").slice(0, 2).toUpperCase())}</div>
          <div><div class="t"><span class="nm">${esc(i.lead_name || "#" + i.lead_id)}</span><span class="q ${queueOf(i)}">${queueOf(i)}</span></div><div class="s">${esc(i.last_lead_text || i.suggestion_text || "")}</div></div>
          <div class="meta"><b>${esc(rel(i.triggered_by_message_at || i.created_at).replace(" ago", ""))}</b>${esc(i.responsible_user || "")}</div></div>`,
        )
        .join("");

    el.innerHTML = `<div class="page">
      <div class="kpis">
        ${kpi("Clients waiting", q.live.length, "they wrote, a draft is ready", "inbox")}
        ${kpi("Promises due", promises.length, "things we said we'd do", "")}
        ${kpi("Overdue tasks", overdue.length, overdue.length ? `oldest ${rel(overdue[0]?.due)}` : "none", "")}
        ${kpi("Due today", today.length, `${tomorrow.length} tomorrow`, "")}
        ${kpi("Visits today", events.length, "viewings and inspections", "calendar")}
        ${kpi("Reports to file", reports.length, "after viewings / inspections", "")}
      </div>
      <div class="day-grid">
        <div class="panel"><h3>Clients waiting for an answer <span class="faint">${q.live.length}</span></h3><div class="stack">${draftRows(q.live) || `<div class="empty">Nobody is waiting. Good.</div>`}</div>
          ${q.reach.length || q.push.length ? `<p class="faint" style="margin:8px 0 0;font-size:12px">${q.reach.length} Reach and ${q.push.length} Push drafts are in the <a href="#/inbox">Inbox</a>.</p>` : ""}</div>
        <div class="panel"><h3>Promises and reports <span class="faint">${promises.length + reports.length}</span></h3><div class="stack">${
          [...promises, ...reports]
            .map((i) => `<div class="note" style="cursor:pointer" data-open-lead="${esc(i.leadId || "")}"><b>${esc(i.title)}</b><br>${esc(i.body)}<br><span class="faint">${fmtDT(i.at)}</span></div>`)
            .join("") || `<div class="empty">Nothing promised or due.</div>`
        }</div></div>
        <div class="panel" id="day-tasks"><h3>Tasks <span class="faint">overdue ${overdue.length} · today ${today.length} · tomorrow ${tomorrow.length}</span></h3><div class="stack">
          ${overdue.length ? `<div class="sect-h">Overdue</div>${overdue.slice(0, 40).map((t) => taskRow(t, { showLead: true })).join("")}` : ""}
          ${today.length ? `<div class="sect-h">Today</div>${today.map((t) => taskRow(t, { showLead: true })).join("")}` : ""}
          ${tomorrow.length ? `<div class="sect-h">Tomorrow</div>${tomorrow.map((t) => taskRow(t, { showLead: true })).join("")}` : ""}
          ${!overdue.length && !today.length && !tomorrow.length ? `<div class="empty">No tasks for today or tomorrow.</div>` : ""}</div><p class="faint" id="day-cleanup" style="font-size:12px;margin:8px 0 0"></p></div>
        ${mine.length || isStaff() ? `<div class="panel" id="day-ptasks"><h3>My project tasks <span class="faint">${mine.length}</span></h3><div class="stack">${mine.map(ptRow).join("") || `<div class="empty">No project tasks due this week.${isStaff() ? ` <a href="#/projects">Open Projects</a>` : ""}</div>`}</div></div>` : ""}
        <div class="panel"><h3>Visits today <span class="faint">${events.length}</span></h3><div class="stack">${
          events.map((e) => `<div class="note" style="cursor:pointer" data-open-lead="${esc(e.leadId || "")}"><b>${esc(fmtTime(e.at))} · ${esc(e.title)}</b>${e.sub ? `<br><span class="faint">${esc(e.sub)}</span>` : ""}</div>`).join("") ||
          `<div class="empty">No viewings or inspections today.</div>`
        }</div></div>
        <div class="panel"><h3>Cards waiting too long in a stage <span class="faint">over 7 days</span></h3><div class="bars">${
          stale.length
            ? stale
                .slice(0, 10)
                .map((s) => `<div class="row" style="cursor:pointer" data-board="${s.pipe}"><span>${esc(s.stage)} <span class="faint">· ${s.pipe === "rental" ? "Rental" : "Listings"}</span></span><div class="b"><i style="width:${Math.round((s.over7 / Math.max(1, s.count)) * 100)}%;background:var(--hot)"></i></div><span class="num">${s.over7}/${s.count}</span></div>`)
                .join("")
            : `<div class="empty">No stage has cards older than a week.</div>`
        }</div></div>
      </div></div>`;
    on(el, "click", "[data-go]", (e, b) => b.dataset.go && go(b.dataset.go));
    on(el, "click", "[data-open-inbox]", (e, c) => (location.hash = `#/inbox?lead=${encodeURIComponent(c.dataset.openInbox)}`));
    on(el, "click", "[data-open-lead]", (e, c) => {
      e.preventDefault();
      if (c.dataset.openLead) emit("open-peek", { type: "lead", id: c.dataset.openLead });
    });
    on(el, "click", "[data-board]", (e, r) => go("pipeline", r.dataset.board));
    on(el, "click", "[data-pt-open]", (e, t) => emit("open-peek", { type: "ptask", id: t.dataset.ptOpen }));
    on(el, "click", "[data-pt-done]", async (e, b) => {
      b.disabled = true;
      try {
        await api(`/ptasks/${b.dataset.ptDone}`, { method: "PATCH", body: { status: "Done" } });
        b.closest(".task").remove();
      } catch (err) {
        b.disabled = false;
        fail(err);
      }
    });
    bindTasks(document.getElementById("day-tasks"), () => tasks, null, () => screens.day.render({ el, tools }));
  },
};
