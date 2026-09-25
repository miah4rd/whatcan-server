// Unicorn OS — Projects: goals and tasks in the format of the owner's Notion boards.
// Views: tasks as Board / Table / Calendar, projects as Board / Timeline.
// Everything opens in the side peek; every field saves as you change it.
import { S, api, esc, I, screens, peeks, store, on, rel, initials, isStaff, emit, onBus, toast, fail, dialog, confirmBox, fmtDate, baliToday, recordVoice, resizer, dropColumn, boardListen } from "./core.js";

const F = () => S.meta.projectFormat || { taskStatuses: [], projectStatuses: [], priorities: [], estimates: [] };
const people = () => S.meta.people || [];
const personName = (id) => people().find((p) => p.id === id)?.name || "Former member";
const PRIO = { Low: "", Medium: "warn", High: "bad", "Extra High": "bad" };
const STATUS = { "Not started": "", "In progress": "stage", Done: "ok", Archived: "", Backlog: "", Planning: "", Paused: "warn", Canceled: "" };
const OPEN = new Set(["Not started", "In progress"]);

// ── data held for the screen; the peek updates it through the bus ──
const P = { projects: [], tasks: [], at: 0, redraw: null };
const opts = () => store.get("proj-opts", { project: "", person: "", archived: false, subtasks: false });
const setOpts = (patch) => store.set("proj-opts", { ...opts(), ...patch });

async function load(force) {
  if (!force && P.at && Date.now() - P.at < 30_000) return;
  const o = opts();
  const [pr, tr] = await Promise.all([isStaff() ? api("/projects") : Promise.resolve({ items: [] }), api("/ptasks" + (o.archived ? "?archived=1" : ""))]);
  P.projects = pr.items || [];
  P.tasks = tr.items || [];
  P.at = Date.now();
}

const today = () => baliToday();
const dueOf = (t) => t.dueEnd || t.dueStart;
const isOpen = (t) => OPEN.has(t.status);
const overdue = (t) => isOpen(t) && dueOf(t) && dueOf(t) < today();
const bySort = (a, b) => a.sort - b.sort || a.id - b.id;
function shortDay(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}
function dueLabel(t) {
  if (!t.dueStart) return "";
  const s = t.dueStart === today() ? "Today" : shortDay(t.dueStart);
  return t.dueEnd && t.dueEnd !== t.dueStart ? `${s} to ${shortDay(t.dueEnd)}` : s;
}
const addDays = (iso, n) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86400e3).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400e3);

function avatars(ids, max = 3) {
  if (!ids?.length) return "";
  const shown = ids.slice(0, max).map((id) => `<span class="avatar sm" title="${esc(personName(id))}">${esc(initials(personName(id)))}</span>`).join("");
  return `<span class="avs">${shown}${ids.length > max ? `<span class="avatar sm">+${ids.length - max}</span>` : ""}</span>`;
}
const projectName = (id) => P.projects.find((p) => p.id === id)?.name || "";

function recount() {
  // Sub-task counters follow the loaded tasks, so a new sub-task shows at once.
  const kids = new Map();
  for (const t of P.tasks) {
    if (!t.parentId || t.status === "Archived") continue;
    const k = kids.get(t.parentId) || { total: 0, done: 0 };
    k.total += 1;
    if (t.status === "Done") k.done += 1;
    kids.set(t.parentId, k);
  }
  for (const t of P.tasks) t.subtasks = kids.get(t.id) || { total: 0, done: 0 };
  for (const p of P.projects) {
    const ts = P.tasks.filter((t) => t.projectId === p.id && !t.parentId && t.status !== "Archived");
    const done = ts.filter((t) => t.status === "Done").length;
    p.tasks = { total: ts.length, done, open: ts.filter(isOpen).length, overdue: ts.filter(overdue).length };
    p.completion = ts.length ? Math.round((done / ts.length) * 100) : 0;
  }
}
function upsert(t) {
  const i = P.tasks.findIndex((x) => x.id === t.id);
  if (i >= 0) P.tasks[i] = { ...P.tasks[i], ...t };
  else P.tasks.push(t);
  recount();
}
onBus("ptask-changed", (t) => {
  if (t) upsert(t);
  if (P.redraw) P.redraw();
});
onBus("ptask-removed", (id) => {
  P.tasks = P.tasks.filter((t) => t.id !== id && t.parentId !== id);
  recount();
  if (P.redraw) P.redraw();
});
onBus("project-changed", (p) => {
  if (p) {
    const i = P.projects.findIndex((x) => x.id === p.id);
    if (i >= 0) P.projects[i] = { ...P.projects[i], ...p };
    else P.projects.push(p);
  }
  if (P.redraw) P.redraw();
});
onBus("project-removed", (id) => {
  P.projects = P.projects.filter((p) => p.id !== id);
  for (const t of P.tasks) if (t.projectId === id) t.projectId = null;
  if (P.redraw) P.redraw();
});

async function patchTask(id, body) {
  const t = await api(`/ptasks/${id}`, { method: "PATCH", body });
  emit("ptask-changed", t);
  return t;
}
async function createTask(body) {
  const t = await api("/ptasks", { body });
  emit("ptask-changed", t);
  return t;
}
/** Defaults for a new task: whatever the board is filtered to. */
function newTaskDefaults(extra = {}) {
  const o = opts();
  const out = { ...extra };
  if (/^\d+$/.test(String(o.project || ""))) out.projectId = Number(o.project);
  if (o.person === "me") out.assigneeIds = [S.user.id];
  else if (/^\d+$/.test(String(o.person || ""))) out.assigneeIds = [Number(o.person)];
  else out.assigneeIds = [S.user.id];
  return out;
}
export async function newTaskDialog(extra = {}) {
  const r = await dialog({
    title: "New task",
    body: `<div class="stack"><label class="fld"><span>What needs to be done</span><input class="in" name="title" required></label>
      <label class="fld"><span>Project</span><select class="in" name="projectId"><option value="">No project</option>${P.projects
        .filter((p) => !/Done|Canceled/.test(p.status))
        .map((p) => `<option value="${p.id}" ${newTaskDefaults(extra).projectId === p.id ? "selected" : ""}>${esc(p.name)}</option>`)
        .join("")}</select></label>
      <label class="fld"><span>Due</span><input class="in" type="date" name="dueStart" value="${esc(extra.dueStart || "")}"></label></div>`,
    actions: [{ label: "Cancel", value: null }, { label: "Create", value: "ok", primary: true }],
  });
  if (!r || !r.values.title.trim()) return null;
  try {
    const t = await createTask({ ...newTaskDefaults(extra), title: r.values.title, projectId: r.values.projectId ? Number(r.values.projectId) : null, dueStart: r.values.dueStart || null });
    emit("open-peek", { type: "ptask", id: t.id });
    return t;
  } catch (e) {
    fail(e);
    return null;
  }
}
async function newProjectDialog(status) {
  const r = await dialog({
    title: "New project",
    body: `<div class="stack"><label class="fld"><span>Name</span><input class="in" name="name" required></label>
      <label class="fld"><span>Goal in one line</span><input class="in" name="summary" placeholder="What is done when this project is done"></label>
      <div class="row"><label class="fld" style="flex:1"><span>Start</span><input class="in" type="date" name="startDate"></label><label class="fld" style="flex:1"><span>End</span><input class="in" type="date" name="endDate"></label></div></div>`,
    actions: [{ label: "Cancel", value: null }, { label: "Create", value: "ok", primary: true }],
  });
  if (!r || !r.values.name.trim()) return;
  try {
    const p = await api("/projects", { body: { ...r.values, status: status || "Planning", startDate: r.values.startDate || null, endDate: r.values.endDate || null } });
    emit("project-changed", p);
    emit("open-peek", { type: "project", id: p.id });
  } catch (e) {
    fail(e);
  }
}

function matches(t, o, q) {
  if (!o.archived && t.status === "Archived") return false;
  const personFilter = o.person && o.person !== "";
  if (!o.subtasks && t.parentId && !personFilter) return false;
  if (o.project === "none" && t.projectId) return false;
  if (/^\d+$/.test(String(o.project || "")) && t.projectId !== Number(o.project)) return false;
  if (o.person === "me" && !t.assigneeIds.includes(S.user.id)) return false;
  if (o.person === "none" && t.assigneeIds.length) return false;
  if (/^\d+$/.test(String(o.person || "")) && !t.assigneeIds.includes(Number(o.person))) return false;
  if (q) {
    const hay = `${t.key} ${t.title} ${t.tags.join(" ")} ${t.summary} ${projectName(t.projectId)}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

// ── the screen ──
screens.projects = {
  title: "Projects",
  async render({ el, tools }) {
    if (!isStaff()) {
      el.innerHTML = `<div class="empty">Projects are for managers. Tasks given to you show in My day.</div>`;
      return;
    }
    let view = store.get("proj-view", "board");
    let q = "";
    const o = opts();
    const pv = () => view === "projects" || view === "timeline";
    const drawTools = () => {
      const oo = opts();
      tools.innerHTML = `<div class="views">${[
        ["board", I.board, "Board"],
        ["table", I.table, "Table"],
        ["calendar", I.cal, "Calendar"],
      ]
        .map(([k, ic, l]) => `<button data-view="${k}" class="${view === k ? "active" : ""}">${ic}${l}</button>`)
        .join("")}</div>
      <div class="views">${[
        ["projects", I.goal, "Projects"],
        ["timeline", I.timeline, "Timeline"],
      ]
        .map(([k, ic, l]) => `<button data-view="${k}" class="${view === k ? "active" : ""}">${ic}${l}</button>`)
        .join("")}</div>
      <button class="btn sm primary" id="pj-new">${I.plus}${pv() ? "New project" : "New task"}</button>`;
      // Filters sit above the view, the way Notion puts them over a database.
      filters.innerHTML = `${
        pv()
          ? ""
          : `<select class="chip" id="pj-project"><option value="">All projects</option><option value="none" ${oo.project === "none" ? "selected" : ""}>No project</option>${P.projects
              .map((p) => `<option value="${p.id}" ${String(oo.project) === String(p.id) ? "selected" : ""}>${esc(p.name)}</option>`)
              .join("")}</select>`
      }
      <select class="chip" id="pj-person"><option value="">${pv() ? "Any owner" : "Everyone"}</option><option value="me" ${oo.person === "me" ? "selected" : ""}>Mine</option>${
        pv() ? "" : `<option value="none" ${oo.person === "none" ? "selected" : ""}>Unassigned</option>`
      }${people()
        .filter((p) => p.id !== S.user.id)
        .map((p) => `<option value="${p.id}" ${String(oo.person) === String(p.id) ? "selected" : ""}>${esc(p.name)}</option>`)
        .join("")}</select>
      ${pv() ? "" : `<button class="chip ${oo.subtasks ? "on" : ""}" id="pj-sub" title="Show sub-tasks as their own cards">Sub-tasks</button><button class="chip ${oo.archived ? "on" : ""}" id="pj-arch">Archived</button>`}
      <input class="in" id="pj-q" placeholder="Search…" value="${esc(q)}">`;
      tools.querySelectorAll("[data-view]").forEach((b) =>
        b.addEventListener("click", () => {
          view = b.dataset.view;
          store.set("proj-view", view);
          drawTools();
          draw();
        }),
      );
      const ps = document.getElementById("pj-project");
      if (ps) ps.onchange = () => (setOpts({ project: ps.value }), draw());
      document.getElementById("pj-person").onchange = (e) => (setOpts({ person: e.target.value }), draw());
      const sb = document.getElementById("pj-sub");
      if (sb) sb.onclick = () => (setOpts({ subtasks: !opts().subtasks }), sb.classList.toggle("on"), draw());
      const ar = document.getElementById("pj-arch");
      if (ar)
        ar.onclick = async () => {
          setOpts({ archived: !opts().archived });
          ar.classList.toggle("on");
          body.innerHTML = `<div class="loading">Loading…</div>`;
          await load(true).catch(fail);
          draw();
        };
      let tm;
      document.getElementById("pj-q").oninput = (e) => {
        clearTimeout(tm);
        tm = setTimeout(() => ((q = e.target.value.trim().toLowerCase()), draw()), 150);
      };
      document.getElementById("pj-new").onclick = () => (pv() ? newProjectDialog() : newTaskDialog());
    };
    const draw = () => {
      const oo = opts();
      if (view === "projects") return drawProjects(body, oo, q);
      if (view === "timeline") return drawTimeline(body, oo, q);
      const list = P.tasks.filter((t) => matches(t, oo, q));
      if (view === "table") drawTable(body, list);
      else if (view === "calendar") drawCalendar(body, list);
      else drawBoard(body, list, oo);
    };
    el.innerHTML = `<div class="pj-wrap"><div class="row pj-filters" id="pj-filters"></div><div class="pj-body" id="pj-body"><div class="loading">Loading projects…</div></div></div>`;
    const filters = el.querySelector("#pj-filters");
    const body = el.querySelector("#pj-body");
    try {
      await load(true);
    } catch (e) {
      body.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
      return;
    }
    recount();
    if (o.project && /^\d+$/.test(String(o.project)) && !P.projects.some((p) => String(p.id) === String(o.project))) setOpts({ project: "" });
    drawTools();
    P.redraw = draw;
    draw();
  },
  leave() {
    P.redraw = null;
  },
};

// ── Board: columns by status, drag to move and to reorder ──
function taskCard(t) {
  const parent = t.parentId ? P.tasks.find((x) => x.id === t.parentId) : null;
  const due = dueOf(t);
  const od = overdue(t);
  const td = isOpen(t) && due === today();
  const sel = S.peek?.type === "ptask" && S.peek.id === String(t.id);
  return `<div class="card pt ${sel ? "sel" : ""} ${t.status === "Done" ? "done" : ""}" draggable="true" data-pt="${t.id}">
    <div class="ct"><span class="nm">${esc(t.title)}</span></div>
    ${parent ? `<div class="cs">in ${esc(parent.title)}</div>` : ""}
    <div class="cm">${t.projectId ? `<span class="pill">${esc(projectName(t.projectId))}</span>` : ""}${t.priority ? `<span class="pill ${PRIO[t.priority] || ""}">${esc(t.priority)}</span>` : ""}${
      due ? `<span class="pill ${od ? "bad" : td ? "warn" : ""}">${esc(dueLabel(t))}</span>` : ""
    }${t.subtasks?.total ? `<span class="pill" title="sub-tasks done">${t.subtasks.done}/${t.subtasks.total}</span>` : ""}${t.comments ? `<span class="faint" style="font-size:11px">${t.comments} comment${t.comments > 1 ? "s" : ""}</span>` : ""}${t.tags
      .map((g) => `<span class="tag">${esc(g)}</span>`)
      .join("")}<span class="spacer"></span>${avatars(t.assigneeIds)}</div></div>`;
}

function drawBoard(el, list, o) {
  const cols = F()
    .taskStatuses.map((s) => s.name)
    .filter((n) => n !== "Archived" || o.archived);
  el.innerHTML = `<div class="board pj">${cols
    .map((st) => {
      const cs = list.filter((t) => t.status === st).sort(bySort);
      return `<div class="col" data-drop="${esc(st)}"><h3><span class="pill ${STATUS[st] || ""}">${esc(st)}</span><span class="n">${cs.length}</span></h3>
        <div class="cards">${cs.map(taskCard).join("")}</div>
        ${st !== "Archived" ? `<button class="add-row" data-add="${esc(st)}">${I.plus} New</button>` : ""}</div>`;
    })
    .join("")}</div>`;
  const board = el.querySelector(".board");
  on(board, "click", "[data-pt]", (e, c) => {
    board.querySelectorAll(".card.sel").forEach((x) => x.classList.remove("sel"));
    c.classList.add("sel");
    emit("open-peek", { type: "ptask", id: c.dataset.pt });
  });
  on(board, "click", "[data-add]", (e, b) => quickAdd(b, { status: b.dataset.add }));
  let dragId = null;
  board.addEventListener("dragstart", (e) => {
    const c = e.target.closest("[data-pt]");
    if (!c) return;
    dragId = Number(c.dataset.pt);
    e.dataTransfer.setData("text/plain", c.dataset.pt);
    e.dataTransfer.effectAllowed = "move";
    c.classList.add("dragging");
  });
  board.addEventListener("dragend", () => {
    board.querySelectorAll(".dragging,.drop-before").forEach((x) => x.classList.remove("dragging", "drop-before"));
    board.querySelectorAll(".col.over").forEach((x) => x.classList.remove("over"));
  });
  const beforeCard = (col, y) => [...col.querySelectorAll(".card:not(.dragging)")].find((c) => {
    const r = c.getBoundingClientRect();
    return y < r.top + r.height / 2;
  });
  boardListen(board, "dragover", (e) => {
    const col = dropColumn(board, e);
    if (!col) return;
    e.preventDefault();
    board.querySelectorAll(".col.over").forEach((x) => x !== col && x.classList.remove("over"));
    col.classList.add("over");
    board.querySelectorAll(".drop-before").forEach((x) => x.classList.remove("drop-before"));
    const b = beforeCard(col, e.clientY);
    if (b) b.classList.add("drop-before");
  });
  boardListen(board, "drop", async (e) => {
    const col = dropColumn(board, e);
    if (!col || dragId == null) return;
    e.preventDefault();
    const t = P.tasks.find((x) => x.id === dragId);
    const status = col.dataset.drop;
    const b = beforeCard(col, e.clientY);
    board.querySelectorAll(".col.over,.drop-before").forEach((x) => x.classList.remove("over", "drop-before"));
    if (!t) return;
    const colTasks = list.filter((x) => x.status === status && x.id !== t.id).sort(bySort);
    const nextIdx = b ? colTasks.findIndex((x) => x.id === Number(b.dataset.pt)) : colTasks.length;
    const prev = colTasks[nextIdx - 1];
    const next = colTasks[nextIdx];
    const sort = prev && next ? (prev.sort + next.sort) / 2 : next ? next.sort - 1 : prev ? prev.sort + 1 : 0;
    const before = { status: t.status, sort: t.sort };
    if (before.status === status && Math.abs(before.sort - sort) < 1e-9) return;
    upsert({ id: t.id, status, sort });
    P.redraw && P.redraw();
    try {
      await patchTask(t.id, status === before.status ? { sort } : { status, sort });
    } catch (err) {
      upsert({ id: t.id, ...before });
      P.redraw && P.redraw();
      fail(err);
    }
    dragId = null;
  });
}

/** Inline "New" row: Enter creates and keeps the row open for the next one. */
function quickAdd(btn, extra) {
  const wrap = document.createElement("div");
  wrap.className = "quick-add";
  wrap.innerHTML = `<input class="in" placeholder="Task name, Enter to add"><div class="faint" style="font-size:11px">Enter adds · Esc closes</div>`;
  btn.replaceWith(wrap);
  const input = wrap.querySelector("input");
  input.focus();
  const close = () => {
    if (wrap.isConnected) wrap.replaceWith(btn);
  };
  input.addEventListener("keydown", async (e) => {
    if (e.key === "Escape") return close();
    if (e.key !== "Enter" || !input.value.trim()) return;
    const title = input.value.trim();
    input.value = "";
    try {
      const col = P.tasks.filter((t) => t.status === (extra.status || "Not started"));
      const sort = col.length ? Math.max(...col.map((t) => t.sort)) + 1 : 0;
      await createTask({ ...newTaskDefaults(extra), title, sort });
      const again = document.querySelector(`[data-add="${CSS.escape(extra.status || "Not started")}"]`);
      if (again) quickAdd(again, extra);
    } catch (err) {
      fail(err);
    }
  });
  input.addEventListener("blur", () => setTimeout(() => !input.value.trim() && close(), 150));
}

// ── Table: grouped by project, inline status and priority ──
let tsort = store.get("pj-sort", { k: "due", dir: 1 });
function drawTable(el, list) {
  const group = store.get("pj-group", true);
  const cols = [
    ["title", "Task"],
    ["status", "Status"],
    ["assignees", "Assignee"],
    ["due", "Due"],
    ["priority", "Priority"],
    ["project", "Project"],
    ["estimate", "Est."],
    ["tags", "Tags"],
    ["sub", "Sub-tasks"],
    ["updatedAt", "Updated"],
  ];
  const prioRank = (p) => F().priorities.indexOf(p);
  const val = (t, k) =>
    k === "due" ? dueOf(t) || "9999" : k === "assignees" ? t.assigneeIds.map(personName).join(", ") : k === "priority" ? -prioRank(t.priority) : k === "project" ? projectName(t.projectId) : k === "sub" ? t.subtasks?.total || 0 : k === "tags" ? t.tags.join(",") : t[k] ?? "";
  const sorted = [...list].sort((a, b) => {
    const x = val(a, tsort.k);
    const y = val(b, tsort.k);
    return (x > y ? 1 : x < y ? -1 : 0) * tsort.dir || bySort(a, b);
  });
  const row = (t) => `<tr data-pt="${t.id}" class="${S.peek?.type === "ptask" && S.peek.id === String(t.id) ? "sel" : ""}">
    <td class="ellip" style="max-width:360px"><span class="faint mono" style="font-size:11px">${esc(t.key)}</span> ${t.parentId ? `<span class="faint">in ${esc(P.tasks.find((x) => x.id === t.parentId)?.title || "")} ·</span> ` : ""}<b style="font-weight:500">${esc(t.title)}</b></td>
    <td><select class="inline" data-f="status">${F()
      .taskStatuses.map((s) => `<option ${s.name === t.status ? "selected" : ""}>${esc(s.name)}</option>`)
      .join("")}</select></td>
    <td>${avatars(t.assigneeIds, 4) || `<span class="faint">none</span>`}</td>
    <td class="${overdue(t) ? "bad-t" : ""}">${esc(dueLabel(t)) || `<span class="faint">none</span>`}</td>
    <td><select class="inline" data-f="priority"><option value="">none</option>${F()
      .priorities.map((p) => `<option ${p === t.priority ? "selected" : ""}>${esc(p)}</option>`)
      .join("")}</select></td>
    <td class="ellip" style="max-width:180px">${esc(projectName(t.projectId)) || `<span class="faint">none</span>`}</td>
    <td>${esc(t.estimate || "")}</td>
    <td>${t.tags.map((g) => `<span class="tag">${esc(g)}</span>`).join("")}</td>
    <td>${t.subtasks?.total ? `${t.subtasks.done}/${t.subtasks.total}` : ""}</td>
    <td class="faint">${esc(rel(t.updatedAt))}</td></tr>`;
  let body = "";
  if (group) {
    const groups = [...P.projects.map((p) => ({ id: p.id, name: p.name, p })), { id: null, name: "No project" }];
    for (const g of groups) {
      const ts = sorted.filter((t) => (t.projectId ?? null) === g.id);
      if (!ts.length) continue;
      body += `<tr class="group-h"><td colspan="${cols.length}">${esc(g.name)} <span class="faint" style="font-weight:500">· ${ts.length}${g.p ? ` · ${g.p.completion}% done` : ""}</span></td></tr>${ts.map(row).join("")}`;
    }
  } else body = sorted.map(row).join("");
  el.innerHTML = `<div class="row" style="margin-bottom:8px"><button class="chip ${group ? "on" : ""}" id="pj-grp">Group by project</button><span class="faint" style="font-size:12px">${list.length} tasks</span></div>
    <div class="tbl-wrap"><table class="grid"><thead><tr>${cols
      .map(([k, l]) => `<th data-k="${k}" class="${tsort.k === k ? "sorted" : ""}">${esc(l)}${tsort.k === k ? (tsort.dir > 0 ? " ▲" : " ▼") : ""}</th>`)
      .join("")}</tr></thead><tbody>${body || `<tr><td colspan="${cols.length}" class="empty">No tasks match.</td></tr>`}</tbody></table></div>`;
  document.getElementById("pj-grp").onclick = () => (store.set("pj-group", !group), drawTable(el, list));
  const tbl = el.querySelector("table");
  on(tbl, "click", "th[data-k]", (e, th) => {
    tsort = { k: th.dataset.k, dir: tsort.k === th.dataset.k ? -tsort.dir : 1 };
    store.set("pj-sort", tsort);
    drawTable(el, list);
  });
  on(tbl, "click", "tr[data-pt]", (e, tr) => {
    if (e.target.closest("select")) return;
    emit("open-peek", { type: "ptask", id: tr.dataset.pt });
  });
  on(tbl, "change", "select[data-f]", async (e, s) => {
    const id = Number(s.closest("tr").dataset.pt);
    try {
      await patchTask(id, { [s.dataset.f]: s.value || null });
    } catch (err) {
      fail(err);
    }
  });
}

// ── Calendar: a month, tasks on their due days; drag to move the date ──
function drawCalendar(el, list) {
  const month = store.get("pj-month", today().slice(0, 7));
  const first = `${month}-01`;
  const dow = (new Date(first + "T00:00:00Z").getUTCDay() + 6) % 7;
  const start = addDays(first, -dow);
  const days = [...Array(42)].map((_, i) => addDays(start, i));
  const onDay = (d) =>
    list
      .filter((t) => t.dueStart && t.dueStart <= d && (t.dueEnd || t.dueStart) >= d)
      .sort((a, b) => (isOpen(b) ? 1 : 0) - (isOpen(a) ? 1 : 0) || bySort(a, b));
  const label = new Date(first + "T00:00:00Z").toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  const noDue = list.filter((t) => !t.dueStart && isOpen(t)).length;
  el.innerHTML = `<div class="row" style="margin-bottom:8px"><button class="btn sm" data-m="-1">${I.back}</button><button class="btn sm" data-m="0">Today</button><button class="btn sm" data-m="1">${I.fwd}</button><b style="font-size:15px;margin-left:6px">${esc(label)}</b><span class="spacer"></span><span class="faint" style="font-size:12px">Double-click a day to add a task · drag a task to move it · ${noDue} open without a date</span></div>
    <div class="mcal">${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => `<div class="hd">${d}</div>`).join("")}${days
      .map((d) => {
        const ts = onDay(d);
        return `<div class="day ${d.slice(0, 7) !== month ? "out" : ""} ${d === today() ? "today" : ""}" data-day="${d}"><div class="dn">${Number(d.slice(8))}</div>${ts
          .slice(0, 4)
          .map((t) => `<div class="ev ${t.status === "Done" ? "done" : overdue(t) ? "late" : ""}" draggable="true" data-pt="${t.id}" title="${esc(t.title)}">${esc(t.title)}</div>`)
          .join("")}${ts.length > 4 ? `<div class="more" data-more="${d}">+${ts.length - 4} more</div>` : ""}</div>`;
      })
      .join("")}</div>`;
  on(el, "click", "[data-m]", (e, b) => {
    const m = Number(b.dataset.m);
    let next = today().slice(0, 7);
    if (m) {
      const [y, mo] = month.split("-").map(Number);
      const dt = new Date(Date.UTC(y, mo - 1 + m, 1));
      next = dt.toISOString().slice(0, 7);
    }
    store.set("pj-month", next);
    drawCalendar(el, list);
  });
  const cal = el.querySelector(".mcal");
  on(cal, "click", "[data-pt]", (e, c) => {
    e.stopPropagation();
    emit("open-peek", { type: "ptask", id: c.dataset.pt });
  });
  on(cal, "click", "[data-more]", (e, m) => {
    e.stopPropagation();
    const d = m.dataset.more;
    const ts = onDay(d);
    dialog({
      title: fmtDate(d + "T04:00:00Z"),
      body: `<div class="stack">${ts.map((t) => `<a href="#" class="note" data-open="${t.id}">${esc(t.title)}</a>`).join("")}</div>`,
      actions: [{ label: "Close", value: null }],
      onMount: (form) =>
        on(form, "click", "[data-open]", (ev, a) => {
          ev.preventDefault();
          form.closest(".overlay").remove();
          emit("open-peek", { type: "ptask", id: a.dataset.open });
        }),
    });
  });
  on(cal, "dblclick", "[data-day]", (e, d) => newTaskDialog({ dueStart: d.dataset.day }));
  let dragId = null;
  cal.addEventListener("dragstart", (e) => {
    const c = e.target.closest("[data-pt]");
    if (!c) return;
    dragId = Number(c.dataset.pt);
    e.dataTransfer.setData("text/plain", c.dataset.pt);
  });
  cal.addEventListener("dragover", (e) => {
    const d = e.target.closest("[data-day]");
    if (!d) return;
    e.preventDefault();
    cal.querySelectorAll(".over").forEach((x) => x !== d && x.classList.remove("over"));
    d.classList.add("over");
  });
  cal.addEventListener("drop", async (e) => {
    const d = e.target.closest("[data-day]");
    cal.querySelectorAll(".over").forEach((x) => x.classList.remove("over"));
    if (!d || dragId == null) return;
    e.preventDefault();
    const t = P.tasks.find((x) => x.id === dragId);
    dragId = null;
    if (!t || t.dueStart === d.dataset.day) return;
    const len = t.dueEnd ? daysBetween(t.dueStart, t.dueEnd) : 0;
    try {
      await patchTask(t.id, { dueStart: d.dataset.day, dueEnd: len ? addDays(d.dataset.day, len) : null });
    } catch (err) {
      fail(err);
    }
  });
}

// ── Projects: a board by status (the "Mine" view of the Notion template) ──
function projectMatches(p, o, q) {
  if (o.person === "me" && p.ownerId !== S.user.id) return false;
  if (/^\d+$/.test(String(o.person || "")) && p.ownerId !== Number(o.person)) return false;
  if (q && !`${p.name} ${p.summary}`.toLowerCase().includes(q)) return false;
  return true;
}
function progress(p) {
  return `<div class="prog" title="${p.tasks.done} of ${p.tasks.total} tasks done"><i style="width:${p.completion}%"></i></div>`;
}
function drawProjects(el, o, q) {
  const list = P.projects.filter((p) => projectMatches(p, o, q));
  el.innerHTML = `<div class="board pj">${F()
    .projectStatuses.map((s) => s.name)
    .map((st) => {
      const ps = list.filter((p) => p.status === st).sort((a, b) => a.sort - b.sort || a.id - b.id);
      return `<div class="col" data-drop="${esc(st)}"><h3><span class="pill ${STATUS[st] || ""}">${esc(st)}</span><span class="n">${ps.length}</span></h3><div class="cards">${ps
        .map(
          (p) => `<div class="card pcard" draggable="true" data-pj="${p.id}"><div class="ct"><span class="nm">${esc(p.name)}</span></div>
            ${p.summary ? `<div class="cs2">${esc(p.summary)}</div>` : ""}
            ${progress(p)}
            <div class="cm"><span class="faint" style="font-size:11px">${p.completion}% · ${p.tasks.open} open${p.tasks.overdue ? ` · <b style="color:var(--hot)">${p.tasks.overdue} late</b>` : ""}</span>${p.priority ? `<span class="pill ${PRIO[p.priority] || ""}">${esc(p.priority)}</span>` : ""}${
              p.startDate || p.endDate ? `<span class="pill">${esc(shortDay(p.startDate) || "?")} to ${esc(shortDay(p.endDate) || "?")}</span>` : ""
            }<span class="spacer"></span>${p.ownerId ? avatars([p.ownerId]) : ""}</div></div>`,
        )
        .join("")}</div><button class="add-row" data-addp="${esc(st)}">${I.plus} New project</button></div>`;
    })
    .join("")}</div>`;
  const board = el.querySelector(".board");
  on(board, "click", "[data-pj]", (e, c) => emit("open-peek", { type: "project", id: c.dataset.pj }));
  on(board, "click", "[data-addp]", (e, b) => newProjectDialog(b.dataset.addp));
  let dragId = null;
  board.addEventListener("dragstart", (e) => {
    const c = e.target.closest("[data-pj]");
    if (!c) return;
    dragId = Number(c.dataset.pj);
    e.dataTransfer.setData("text/plain", c.dataset.pj);
    c.classList.add("dragging");
  });
  board.addEventListener("dragend", () => board.querySelectorAll(".dragging,.col.over").forEach((x) => x.classList.remove("dragging", "over")));
  boardListen(board, "dragover", (e) => {
    const col = dropColumn(board, e);
    if (!col) return;
    e.preventDefault();
    board.querySelectorAll(".col.over").forEach((x) => x !== col && x.classList.remove("over"));
    col.classList.add("over");
  });
  boardListen(board, "drop", async (e) => {
    const col = dropColumn(board, e);
    board.querySelectorAll(".col.over").forEach((x) => x.classList.remove("over"));
    if (!col || dragId == null) return;
    e.preventDefault();
    const p = P.projects.find((x) => x.id === dragId);
    dragId = null;
    if (!p || p.status === col.dataset.drop) return;
    try {
      const np = await api(`/projects/${p.id}`, { method: "PATCH", body: { status: col.dataset.drop } });
      emit("project-changed", { ...np, tasks: p.tasks, completion: p.completion });
    } catch (err) {
      fail(err);
    }
  });
}

// ── Timeline: projects on a week grid ──
function drawTimeline(el, o, q) {
  const list = P.projects.filter((p) => projectMatches(p, o, q) && p.status !== "Canceled");
  const dated = list.filter((p) => p.startDate || p.endDate).map((p) => ({ p, s: p.startDate || p.endDate, e: p.endDate || p.startDate }));
  const undated = list.filter((p) => !p.startDate && !p.endDate);
  if (!dated.length) {
    el.innerHTML = `<div class="empty">No project has dates yet. Open a project and set Start and End; it appears here.</div>${undated.length ? `<div class="stack" style="max-width:520px;margin:0 auto">${undated.map((p) => `<a href="#" class="note" data-pj="${p.id}">${esc(p.name)}</a>`).join("")}</div>` : ""}`;
    on(el, "click", "[data-pj]", (e, a) => (e.preventDefault(), emit("open-peek", { type: "project", id: a.dataset.pj })));
    return;
  }
  const monday = (iso) => addDays(iso, -((new Date(iso + "T00:00:00Z").getUTCDay() + 6) % 7));
  let from = monday([today(), ...dated.map((x) => x.s)].sort()[0]);
  let to = [today(), ...dated.map((x) => x.e)].sort().slice(-1)[0];
  from = addDays(from, -7);
  to = addDays(to, 14);
  let weeks = Math.ceil((daysBetween(from, to) + 1) / 7);
  if (weeks > 52) weeks = 52;
  const W = 70;
  const px = (iso) => (daysBetween(from, iso) / 7) * W;
  const head = [...Array(weeks)].map((_, i) => {
    const d = addDays(from, i * 7);
    return `<div class="wk" style="left:${i * W}px;width:${W}px">${esc(shortDay(d))}</div>`;
  });
  el.innerHTML = `<div class="tl"><div class="tl-names"><div class="tl-h">Project</div>${dated
    .map((x) => `<div class="tl-n" data-pj="${x.p.id}" title="${esc(x.p.name)}">${esc(x.p.name)}</div>`)
    .join("")}</div><div class="tl-grid"><div class="tl-inner" style="width:${weeks * W}px"><div class="tl-h">${head.join("")}</div>${dated
    .map(
      (x) => `<div class="tl-r"><div class="bar ${esc((STATUS[x.p.status] || "plain").replace("stage", "doing"))}" data-pj="${x.p.id}" style="left:${Math.max(0, px(x.s))}px;width:${Math.max(W / 7, px(addDays(x.e, 1)) - px(x.s))}px" title="${esc(x.p.name)} · ${esc(x.p.status)} · ${x.p.completion}%"><i style="width:${x.p.completion}%"></i><span>${esc(x.p.name)}</span></div></div>`,
    )
    .join("")}<div class="now" style="left:${px(today())}px"></div></div></div></div>
    ${undated.length ? `<div class="sect-h" style="margin-top:14px">No dates</div><div class="row">${undated.map((p) => `<a href="#" class="chip" data-pj="${p.id}">${esc(p.name)}</a>`).join("")}</div>` : ""}`;
  on(el, "click", "[data-pj]", (e, a) => (e.preventDefault(), emit("open-peek", { type: "project", id: a.dataset.pj })));
  const grid = el.querySelector(".tl-grid");
  // Scroll only when today would sit past most of the visible width.
  if (px(today()) > grid.clientWidth * 0.7) grid.scrollLeft = Math.max(0, px(today()) - grid.clientWidth * 0.3);
}

// ── Task peek ──
function selectHtml(field, options, value, { empty, disabled } = {}) {
  return `<select class="pin" data-f="${field}" ${disabled ? "disabled" : ""}>${empty ? `<option value="">${esc(empty)}</option>` : ""}${options
    .map((o) => {
      const [v, l] = Array.isArray(o) ? o : [o, o];
      return `<option value="${esc(v)}" ${String(v) === String(value ?? "") ? "selected" : ""}>${esc(l)}</option>`;
    })
    .join("")}</select>`;
}
function eventHtml(ev) {
  const who = esc(ev.userName || "Someone");
  const d = ev.detail || {};
  let what = "";
  if (ev.kind === "comment") return `<div class="cmt"><div class="avatar sm">${esc(initials(ev.userName))}</div><div><b>${who}</b> <span class="faint">${esc(rel(ev.at))}</span><div class="ctext">${esc(d.text || "")}</div></div></div>`;
  if (ev.kind === "created") what = "created the task";
  else if (ev.kind === "changed") {
    const parts = [];
    if (d.status) parts.push(`moved it to ${esc(d.status.to)}`);
    if (d.assignees) {
      if (d.assignees.added?.length) parts.push(`gave it to ${esc(d.assignees.added.map(personName).join(", "))}`);
      if (d.assignees.removed?.length) parts.push(`took it from ${esc(d.assignees.removed.map(personName).join(", "))}`);
    }
    if (d.due) parts.push(d.due.to?.[0] ? `set the due date to ${esc(shortDay(d.due.to[0]))}${d.due.to[1] ? " to " + esc(shortDay(d.due.to[1])) : ""}` : "removed the due date");
    if (d.project) parts.push(d.project.to ? `moved it to ${esc(projectName(d.project.to) || "a project")}` : "took it out of the project");
    what = parts.join(", ") || "changed it";
  } else what = esc(ev.kind);
  return `<div class="evl"><i></i><span><b>${who}</b> ${what} <span class="faint">· ${esc(rel(ev.at))}</span></span></div>`;
}

peeks.ptask = {
  defaultTab: "main",
  async render(el, st, ctl) {
    let d;
    try {
      d = await api(`/ptasks/${encodeURIComponent(st.id)}`);
    } catch (e) {
      el.innerHTML = `<div class="ph"><h2>Task</h2><button class="iconbtn" data-close>${I.x}</button></div><div class="empty">${esc(e.message)}</div>`;
      el.querySelector("[data-close]").onclick = ctl.close;
      return;
    }
    const t = d.task;
    const staff = isStaff();
    const lock = !staff;
    if (!P.projects.length && staff) await load().catch(() => undefined);
    el.innerHTML = `<div class="resize-x" id="pt-resize" title="Drag to resize"></div>
      <div class="ph"><span class="faint mono">${esc(t.key)}</span>${d.project ? (staff ? `<a href="#" class="chip" data-open-project="${d.project.id}" style="border-style:solid">${I.goal}${esc(d.project.name)}</a>` : `<span class="chip" style="border-style:solid">${I.goal}${esc(d.project.name)}</span>`) : ""}<span class="spacer"></span>
        ${staff ? `<button class="iconbtn" id="pt-del" title="Delete the task">${I.trash}</button>` : ""}<button class="iconbtn" data-close title="Close (Esc)">${I.x}</button></div>
      <div class="pb pad pt-peek">
        <textarea class="pt-title" id="pt-title" rows="1" ${lock ? "readonly" : ""} placeholder="Task name">${esc(t.title)}</textarea>
        ${d.parent ? `<div class="faint" style="margin-top:-8px">Sub-task of <a href="#" data-open-pt="${d.parent.id}">${esc(d.parent.title)}</a></div>` : ""}
        <dl class="props pprops">
          <dt>Status</dt><dd>${selectHtml("status", F().taskStatuses.map((s) => s.name), t.status)}</dd>
          <dt>Assignee</dt><dd><div class="people" id="pt-people">${t.assigneeIds
            .map((id) => `<span class="person"><span class="avatar sm">${esc(initials(personName(id)))}</span>${esc(personName(id))}${staff ? `<button data-unassign="${id}" title="Remove">${I.x}</button>` : ""}</span>`)
            .join("")}${
            staff
              ? `<select class="pin add" id="pt-add-person"><option value="">+ Add</option>${people()
                  .filter((p) => !t.assigneeIds.includes(p.id))
                  .map((p) => `<option value="${p.id}">${esc(p.name)}</option>`)
                  .join("")}</select>`
              : t.assigneeIds.length
                ? ""
                : `<span class="faint">nobody</span>`
          }</div></dd>
          <dt>Due</dt><dd class="row" style="gap:6px"><input type="date" class="pin" data-f="dueStart" value="${esc(t.dueStart || "")}" ${lock ? "disabled" : ""}><span class="faint">to</span><input type="date" class="pin" data-f="dueEnd" value="${esc(t.dueEnd || "")}" ${lock ? "disabled" : ""} title="Optional end of a range"></dd>
          <dt>Priority</dt><dd>${selectHtml("priority", F().priorities, t.priority, { empty: "none", disabled: lock })}</dd>
          <dt>Estimate</dt><dd>${selectHtml("estimate", F().estimates, t.estimate, { empty: "none", disabled: lock })}</dd>
          <dt>Project</dt><dd>${selectHtml(
            "projectId",
            P.projects.map((p) => [p.id, p.name]),
            t.projectId,
            { empty: "No project", disabled: lock },
          )}</dd>
          <dt>Tags</dt><dd><input class="pin" data-f="tags" value="${esc(t.tags.join(", "))}" placeholder="Website, Improvement" ${lock ? "readonly" : ""}></dd>
          <dt>Created</dt><dd class="faint">${esc(t.createdBy ? personName(t.createdBy) : "")} · ${esc(fmtDate(t.createdAt))}${t.doneAt ? ` · done ${esc(fmtDate(t.doneAt))}` : ""}</dd>
        </dl>
        <label class="fld"><span>Summary</span><textarea class="in" data-f="summary" rows="2" ${lock ? "readonly" : ""} placeholder="The result in one or two lines">${esc(t.summary)}</textarea></label>
        <div class="fld"><div class="row"><span style="font-weight:500">Notes</span><span class="spacer"></span><button class="btn sm ghost" id="pt-dict" title="Dictate into the notes">${I.mic} Dictate</button></div><textarea class="in" data-f="notes" rows="7" placeholder="Details, links, next step…">${esc(t.notes)}</textarea></div>
        <div><div class="sect-h">Sub-tasks <span class="faint">${d.subtasks.filter((s) => s.status === "Done").length}/${d.subtasks.length}</span></div>
          <div class="stack" id="pt-subs">${d.subtasks
            .map(
              (s) => `<div class="sub ${s.status === "Done" ? "done" : ""}"><button class="cb" data-toggle="${s.id}" title="Done / not done">${s.status === "Done" ? I.check : ""}</button><a href="#" data-open-pt="${s.id}">${esc(s.title)}</a><span class="spacer"></span>${s.dueStart ? `<span class="pill ${overdue(s) ? "bad" : ""}">${esc(dueLabel(s))}</span>` : ""}${avatars(s.assigneeIds, 2)}</div>`,
            )
            .join("")}</div>
          ${staff ? `<input class="in" id="pt-sub-add" placeholder="+ Add a sub-task, Enter" style="margin-top:6px">` : ""}</div>
        <div><div class="sect-h">Comments and history</div><div class="activity">${d.events.map(eventHtml).join("") || `<div class="faint">Nothing yet.</div>`}</div>
          <textarea class="in" id="pt-comment" rows="2" placeholder="Write a comment… (⌘Enter sends)" style="margin-top:8px"></textarea>
          <div class="row" style="margin-top:6px"><button class="btn sm ghost" id="pt-cdict">${I.mic} Dictate</button><span class="spacer"></span><button class="btn sm primary" id="pt-csend">Comment</button></div></div>
      </div>`;
    const reopen = () => ctl.setTab("main");
    el.querySelector("[data-close]").onclick = ctl.close;
    resizer(el.querySelector("#pt-resize"), { varName: "--peek-w", min: 360, max: Math.max(420, window.innerWidth - 200), invert: true });
    const save = async (body) => {
      try {
        const nt = await patchTask(t.id, body);
        Object.assign(t, nt);
        return nt;
      } catch (e) {
        fail(e);
        return null;
      }
    };
    // Title grows with its text; Enter saves.
    const title = el.querySelector("#pt-title");
    const fit = () => ((title.style.height = "auto"), (title.style.height = title.scrollHeight + "px"));
    fit();
    title.addEventListener("input", fit);
    title.addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), title.blur()));
    title.addEventListener("blur", () => !lock && title.value.trim() && title.value.trim() !== t.title && save({ title: title.value.trim() }));
    // Selects, dates, tags: save on change.
    on(el, "change", "[data-f]", async (e, f) => {
      const k = f.dataset.f;
      if (k === "summary" || k === "notes") return;
      let v = f.value;
      if (k === "projectId") v = v ? Number(v) : null;
      if (k === "tags") v = v.split(",").map((x) => x.trim()).filter(Boolean);
      if (k === "dueEnd" && v && !t.dueStart) {
        await save({ dueStart: v, dueEnd: null });
        return reopen();
      }
      const nt = await save({ [k]: v || (k === "tags" ? [] : null) });
      if (!nt || k === "dueStart" || k === "dueEnd") reopen();
    });
    // Long text: saves after a pause and when leaving the field.
    el.querySelectorAll('textarea[data-f="summary"],textarea[data-f="notes"]').forEach((ta) => {
      if (ta.readOnly) return;
      let tm;
      const flush = () => {
        clearTimeout(tm);
        if (ta.value !== t[ta.dataset.f]) save({ [ta.dataset.f]: ta.value });
      };
      ta.addEventListener("input", () => {
        clearTimeout(tm);
        tm = setTimeout(flush, 900);
      });
      ta.addEventListener("blur", flush);
    });
    const notes = el.querySelector('textarea[data-f="notes"]');
    el.querySelector("#pt-dict").onclick = (e) =>
      recordVoice(e.currentTarget, (txt) => {
        if (!txt) return;
        notes.value = (notes.value ? notes.value.replace(/\s+$/, "") + "\n" : "") + txt;
        save({ notes: notes.value });
      });
    // People.
    const add = el.querySelector("#pt-add-person");
    if (add)
      add.onchange = async () => {
        if (!add.value) return;
        if (await save({ assigneeIds: [...t.assigneeIds, Number(add.value)] })) reopen();
      };
    on(el, "click", "[data-unassign]", async (e, b) => {
      if (await save({ assigneeIds: t.assigneeIds.filter((i) => i !== Number(b.dataset.unassign)) })) reopen();
    });
    // Sub-tasks.
    on(el, "click", "[data-toggle]", async (e, b) => {
      const s = d.subtasks.find((x) => x.id === Number(b.dataset.toggle));
      if (!s) return;
      try {
        await patchTask(s.id, { status: s.status === "Done" ? "Not started" : "Done" });
        reopen();
      } catch (err) {
        fail(err);
      }
    });
    const subAdd = el.querySelector("#pt-sub-add");
    if (subAdd)
      subAdd.addEventListener("keydown", async (e) => {
        if (e.key !== "Enter" || !subAdd.value.trim()) return;
        try {
          await createTask({ title: subAdd.value.trim(), parentId: t.id, projectId: t.projectId, assigneeIds: t.assigneeIds });
          reopen();
        } catch (err) {
          fail(err);
        }
      });
    on(el, "click", "[data-open-pt]", (e, a) => (e.preventDefault(), emit("open-peek", { type: "ptask", id: a.dataset.openPt })));
    on(el, "click", "[data-open-project]", (e, a) => (e.preventDefault(), emit("open-peek", { type: "project", id: a.dataset.openProject })));
    // Comments.
    const cbox = el.querySelector("#pt-comment");
    const send = async () => {
      if (!cbox.value.trim()) return;
      try {
        await api(`/ptasks/${t.id}/comments`, { body: { text: cbox.value } });
        emit("ptask-changed", { id: t.id, comments: (t.comments || 0) + 1 });
        reopen();
      } catch (err) {
        fail(err);
      }
    };
    el.querySelector("#pt-csend").onclick = send;
    cbox.addEventListener("keydown", (e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && send());
    el.querySelector("#pt-cdict").onclick = (e) => recordVoice(e.currentTarget, (txt) => txt && (cbox.value = (cbox.value ? cbox.value + " " : "") + txt));
    // Delete, with undo.
    const del = el.querySelector("#pt-del");
    if (del)
      del.onclick = async () => {
        if (!(await confirmBox("Delete this task?", d.subtasks.length ? `Its ${d.subtasks.length} sub-tasks go with it. You can undo right after.` : "You can undo right after.", "Delete", true))) return;
        try {
          await api(`/ptasks/${t.id}`, { method: "DELETE" });
          emit("ptask-removed", t.id);
          ctl.close();
          toast("Task deleted", {
            undo: async () => {
              try {
                await api(`/ptasks/${t.id}/restore`, { body: {} });
                P.at = 0;
                await load(true);
                emit("ptask-changed", null);
              } catch (err) {
                fail(err);
              }
            },
          });
        } catch (err) {
          fail(err);
        }
      };
  },
};

// ── Project peek ──
peeks.project = {
  defaultTab: "main",
  async render(el, st, ctl) {
    if (!P.projects.length || !P.projects.some((p) => String(p.id) === String(st.id))) await load(true).catch(() => undefined);
    recount();
    const p = P.projects.find((x) => String(x.id) === String(st.id));
    if (!p) {
      el.innerHTML = `<div class="ph"><h2>Project</h2><button class="iconbtn" data-close>${I.x}</button></div><div class="empty">This project no longer exists.</div>`;
      el.querySelector("[data-close]").onclick = ctl.close;
      return;
    }
    const tasks = P.tasks.filter((t) => t.projectId === p.id && !t.parentId).sort((a, b) => (isOpen(b) ? 1 : 0) - (isOpen(a) ? 1 : 0) || bySort(a, b));
    el.innerHTML = `<div class="resize-x" id="pj-resize" title="Drag to resize"></div>
      <div class="ph"><span class="avatar villa">${I.goal}</span><span class="faint">Project</span><span class="spacer"></span>
        <button class="btn sm" id="pj-board">Open its tasks</button><button class="iconbtn" id="pj-del" title="Delete the project">${I.trash}</button><button class="iconbtn" data-close title="Close (Esc)">${I.x}</button></div>
      <div class="pb pad pt-peek">
        <textarea class="pt-title" id="pj-title" rows="1" placeholder="Project name">${esc(p.name)}</textarea>
        ${progress(p)}<div class="faint" style="font-size:12px;margin-top:-8px">${p.completion}% done · ${p.tasks.done} of ${p.tasks.total} tasks${p.tasks.overdue ? ` · <b style="color:var(--hot)">${p.tasks.overdue} late</b>` : ""}</div>
        <dl class="props pprops">
          <dt>Status</dt><dd>${selectHtml("status", F().projectStatuses.map((s) => s.name), p.status)}</dd>
          <dt>Owner</dt><dd>${selectHtml("ownerId", people().map((x) => [x.id, x.name]), p.ownerId, { empty: "nobody" })}</dd>
          <dt>Priority</dt><dd>${selectHtml("priority", F().priorities, p.priority, { empty: "none" })}</dd>
          <dt>Dates</dt><dd class="row" style="gap:6px"><input type="date" class="pin" data-f="startDate" value="${esc(p.startDate || "")}"><span class="faint">to</span><input type="date" class="pin" data-f="endDate" value="${esc(p.endDate || "")}"></dd>
        </dl>
        <label class="fld"><span>Goal</span><textarea class="in" data-f="summary" rows="2" placeholder="What is true when this project is done">${esc(p.summary)}</textarea></label>
        <div class="fld"><div class="row"><span style="font-weight:500">Notes</span><span class="spacer"></span><button class="btn sm ghost" id="pj-dict">${I.mic} Dictate</button></div><textarea class="in" data-f="notes" rows="6" placeholder="Plan, context, links…">${esc(p.notes)}</textarea></div>
        <div><div class="sect-h">Tasks <span class="faint">${tasks.length}</span></div><div class="stack">${tasks
          .map(
            (t) => `<div class="sub ${t.status === "Done" ? "done" : ""}"><button class="cb" data-toggle="${t.id}" title="Done / not done">${t.status === "Done" ? I.check : ""}</button><a href="#" data-open-pt="${t.id}">${esc(t.title)}</a><span class="spacer"></span>${
              t.status === "In progress" ? `<span class="pill stage">In progress</span>` : ""
            }${t.dueStart ? `<span class="pill ${overdue(t) ? "bad" : ""}">${esc(dueLabel(t))}</span>` : ""}${avatars(t.assigneeIds, 2)}</div>`,
          )
          .join("") || `<div class="faint">No tasks yet.</div>`}</div>
          <input class="in" id="pj-task-add" placeholder="+ Add a task, Enter" style="margin-top:6px"></div>
      </div>`;
    const reopen = () => ctl.setTab("main");
    el.querySelector("[data-close]").onclick = ctl.close;
    resizer(el.querySelector("#pj-resize"), { varName: "--peek-w", min: 360, max: Math.max(420, window.innerWidth - 200), invert: true });
    const save = async (body) => {
      try {
        const np = await api(`/projects/${p.id}`, { method: "PATCH", body });
        Object.assign(p, { ...np, tasks: p.tasks, completion: p.completion });
        emit("project-changed", p);
        return np;
      } catch (e) {
        fail(e);
        return null;
      }
    };
    const title = el.querySelector("#pj-title");
    const fit = () => ((title.style.height = "auto"), (title.style.height = title.scrollHeight + "px"));
    fit();
    title.addEventListener("input", fit);
    title.addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), title.blur()));
    title.addEventListener("blur", () => title.value.trim() && title.value.trim() !== p.name && save({ name: title.value.trim() }));
    on(el, "change", "[data-f]", async (e, f) => {
      const k = f.dataset.f;
      if (k === "summary" || k === "notes") return;
      let v = f.value || null;
      if (k === "ownerId") v = v ? Number(v) : null;
      await save({ [k]: v });
    });
    el.querySelectorAll('textarea[data-f="summary"],textarea[data-f="notes"]').forEach((ta) => {
      let tm;
      const flush = () => {
        clearTimeout(tm);
        if (ta.value !== p[ta.dataset.f]) save({ [ta.dataset.f]: ta.value });
      };
      ta.addEventListener("input", () => {
        clearTimeout(tm);
        tm = setTimeout(flush, 900);
      });
      ta.addEventListener("blur", flush);
    });
    const notes = el.querySelector('textarea[data-f="notes"]');
    el.querySelector("#pj-dict").onclick = (e) =>
      recordVoice(e.currentTarget, (txt) => {
        if (!txt) return;
        notes.value = (notes.value ? notes.value.replace(/\s+$/, "") + "\n" : "") + txt;
        save({ notes: notes.value });
      });
    on(el, "click", "[data-toggle]", async (e, b) => {
      const t = P.tasks.find((x) => x.id === Number(b.dataset.toggle));
      if (!t) return;
      try {
        await patchTask(t.id, { status: t.status === "Done" ? "Not started" : "Done" });
        reopen();
      } catch (err) {
        fail(err);
      }
    });
    on(el, "click", "[data-open-pt]", (e, a) => (e.preventDefault(), emit("open-peek", { type: "ptask", id: a.dataset.openPt })));
    const addIn = el.querySelector("#pj-task-add");
    addIn.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter" || !addIn.value.trim()) return;
      try {
        await createTask({ title: addIn.value.trim(), projectId: p.id, assigneeIds: [S.user.id] });
        reopen();
      } catch (err) {
        fail(err);
      }
    });
    el.querySelector("#pj-board").onclick = () => {
      setOpts({ project: String(p.id), person: "" });
      store.set("proj-view", "board");
      ctl.close();
      if (location.hash.startsWith("#/projects")) {
        P.at = 0;
        emit("route");
      } else location.hash = "#/projects";
    };
    el.querySelector("#pj-del").onclick = async () => {
      if (!(await confirmBox(`Delete "${p.name}"?`, "Its tasks stay, without a project.", "Delete", true))) return;
      try {
        await api(`/projects/${p.id}`, { method: "DELETE" });
        emit("project-removed", p.id);
        ctl.close();
        toast("Project deleted. Its tasks are under No project.");
      } catch (err) {
        fail(err);
      }
    };
  },
};

/** For ⌘K: projects and tasks already loaded. */
export function searchProjects(q) {
  if (!q || !isStaff()) return [];
  const out = [];
  for (const p of P.projects) if (p.name.toLowerCase().includes(q)) out.push({ grp: "Projects", label: p.name, sub: `${p.status} · ${p.completion}%`, act: () => emit("open-peek", { type: "project", id: p.id }) });
  for (const t of P.tasks) if (`${t.key} ${t.title}`.toLowerCase().includes(q)) out.push({ grp: "Project tasks", label: t.title, sub: `${t.status}${t.projectId ? " · " + projectName(t.projectId) : ""}`, act: () => emit("open-peek", { type: "ptask", id: t.id }) });
  return out.slice(0, 20);
}
/** Loaded in the background for staff so search and the bell know the names. */
export function warmProjects() {
  if (isStaff()) load().catch(() => undefined);
}
