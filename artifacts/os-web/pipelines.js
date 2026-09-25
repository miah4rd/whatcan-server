// Unicorn OS — pipelines as a board and as a table of the same cards.
import { S, api, esc, I, screens, store, on, rel, money, initials, isStaff, onBus, fmtDay, stageOwner, dropCache, emit, fail, dropColumn, boardListen } from "./core.js";
import { moveStage, pipelineOf, isListingPipe, daysInStage } from "./lead.js";
import { osFunnel, renderOsBoard } from "./funnels.js";

const PARKED = /long term|co-broke|live|weekly check|availability received|check in|contract signed|backlog/i;
const rotLimit = (stage) => (/new lead|initial contact|need assessed|taken to work|viewing suggested/i.test(stage) ? 3 : 7);

async function loadBoard(key, force, stale) {
  const opts = store.get("board-opts:" + key, {});
  const ck = `board:${key}:${opts.broker || ""}:${opts.closed ? 1 : 0}:${opts.all ? "all" : 90}`;
  const c = S.cache[ck];
  if (!force && c && (stale || Date.now() - c.at < 60_000)) return c.value;
  const qs = new URLSearchParams({ pipeline: key });
  if (opts.broker) qs.set("broker", opts.broker);
  if (opts.closed) qs.set("closed", "1");
  qs.set("active", opts.all ? "all" : "90");
  const r = await api("/leads?" + qs.toString());
  S.cache[ck] = { at: Date.now(), value: r.items };
  return r.items;
}

function cardSub(c) {
  if (isListingPipe(c.pipeline)) {
    const f = c.facts || {};
    return [f.bedrooms ? `${f.bedrooms}BR` : null, f.monthlyIdr ? money(f.monthlyIdr) : null, f.area || null].filter(Boolean).join(" · ") || "no facts yet";
  }
  const r = c.request || {};
  return [r.bedrooms ? `${r.bedrooms}BR` : null, r.areas || null, r.budget ? money(r.budget) : null, r.moveIn ? `from ${r.moveIn}` : null].filter(Boolean).join(" · ") || c.intent || "request not read yet";
}

function matches(c, f) {
  if (f.temp && c.temperature !== f.temp) return false;
  if (f.q) {
    const hay = `${c.name} ${c.leadId} ${c.stage} ${cardSub(c)} ${c.responsible}`.toLowerCase();
    if (!hay.includes(f.q.toLowerCase())) return false;
  }
  if (f.onlyDrafts && !c.draft) return false;
  return true;
}

function cardHtml(c, selId) {
  const days = daysInStage(c);
  const rot = days != null && !PARKED.test(c.stage || "") && days > rotLimit(c.stage || "");
  const q = c.draft ? (c.draft.kind === "live" ? "live" : "push") : "";
  return `<div class="card ${rot ? "rot" : ""} ${String(selId) === c.leadId ? "sel" : ""}" draggable="true" data-card="${esc(c.leadId)}">
    <div class="ct"><span class="nm">${esc(c.name)}</span>${q ? `<span class="q ${q}">${esc(c.draft.kind)}</span>` : ""}</div>
    <div class="cs">${esc(cardSub(c))}</div>
    <div class="cm">${c.temperature ? `<span class="pill ${esc(c.temperature)}">${esc(c.temperature)}</span>` : ""}${c.viewingAt ? `<span class="pill ok">viewing ${esc(fmtDay(c.viewingAt))}</span>` : ""}${
      c.nextTaskDue ? `<span class="pill ${new Date(c.nextTaskDue) < new Date() ? "bad" : ""}">task ${esc(rel(c.nextTaskDue))}</span>` : ""
    }<span class="age ${rot ? "rot" : ""}" title="days in this stage">${days == null ? "" : Math.floor(days) + "d"}</span><span class="spacer"></span><span class="avatar sm" title="${esc(c.responsible || "")}">${esc(initials(c.responsible || "?"))}</span></div></div>`;
}

screens.pipeline = {
  title: (r) => pipelineOf(r.parts[0] || "rental")?.name || osFunnel(r.parts[0])?.name || "Pipeline",
  flush: false,
  async render({ el, tools, route }) {
    const key = route.parts[0] || "rental";
    const p = (S.meta.pipelines || []).find((x) => x.key === key);
    if (!p && osFunnel(key)) return renderOsBoard({ el, tools, key });
    if (!p) {
      el.innerHTML = `<div class="empty">Unknown funnel.</div>`;
      return;
    }
    const opts = store.get("board-opts:" + key, {});
    const view = store.get("board-view:" + key, "board");
    const f = { q: "", temp: opts.temp || "", onlyDrafts: !!opts.onlyDrafts };
    tools.innerHTML = `<div class="views"><button data-view="board" class="${view === "board" ? "active" : ""}">${I.board}Board</button><button data-view="table" class="${view === "table" ? "active" : ""}">${I.table}Table</button></div>
      ${isStaff() ? `<select class="chip" id="pf-broker"><option value="">Everyone</option>${S.meta.brokers.map((b) => `<option ${b === opts.broker ? "selected" : ""}>${esc(b)}</option>`).join("")}</select>` : ""}
      ${isListingPipe(p.name) ? "" : `<select class="chip" id="pf-temp"><option value="">Any temperature</option>${["hot", "warm", "cold"].map((t) => `<option ${t === f.temp ? "selected" : ""}>${t}</option>`).join("")}</select>`}
      <button class="chip ${f.onlyDrafts ? "on" : ""}" id="pf-drafts">Has a draft</button>
      <button class="chip ${opts.closed ? "on" : ""}" id="pf-closed">Show closed</button>
      <button class="chip ${opts.all ? "on" : ""}" id="pf-all" title="By default the board shows cards active in the last 90 days">All time</button>
      <input class="in" id="pf-q" placeholder="Search…" style="width:160px;padding:5px 8px">
      <a class="btn sm ghost" href="#/funnels/${esc(key)}" title="Funnel settings: stages, what moves a card into each, the autopilot">${I.gear} Settings</a>
      <button class="btn sm ghost" id="pf-refresh">Refresh</button>`;
    el.innerHTML = `<div class="loading">Loading ${esc(p.name)}…</div>`;
    let cards = [];
    // Any earlier copy of this board shows at once; if it is older than a
    // minute, the fresh one is fetched behind it and drawn when it lands.
    const ckey = () => {
      const o = store.get("board-opts:" + key, {});
      return `board:${key}:${o.broker || ""}:${o.closed ? 1 : 0}:${o.all ? "all" : 90}`;
    };
    const had = S.cache[ckey()];
    try {
      cards = await loadBoard(key, false, true);
    } catch (e) {
      el.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
      return;
    }
    if (had && Date.now() - had.at >= 60_000) {
      loadBoard(key, true)
        .then((fresh) => {
          if (S.route.screen !== "pipeline" || (S.route.parts[0] || "rental") !== key) return;
          cards = fresh;
          draw();
        })
        .catch(() => undefined);
    }
    const setOpt = (k, v) => {
      opts[k] = v;
      store.set("board-opts:" + key, opts);
    };
    const rerender = async (force) => {
      if (force) {
        el.innerHTML = `<div class="loading">Refreshing…</div>`;
        cards = await loadBoard(key, true).catch((e) => (fail(e), cards));
      }
      draw();
    };
    const draw = () => {
      const v = store.get("board-view:" + key, "board");
      const list = cards.filter((c) => matches(c, f));
      if (v === "table") drawTable(el, p, list);
      else drawBoard(el, p, list, opts);
    };
    tools.querySelectorAll("[data-view]").forEach((b) =>
      b.addEventListener("click", () => {
        store.set("board-view:" + key, b.dataset.view);
        tools.querySelectorAll("[data-view]").forEach((x) => x.classList.toggle("active", x === b));
        draw();
      }),
    );
    const bsel = document.getElementById("pf-broker");
    if (bsel) bsel.onchange = () => (setOpt("broker", bsel.value), rerender(true));
    const tsel = document.getElementById("pf-temp");
    if (tsel) tsel.onchange = () => ((f.temp = tsel.value), setOpt("temp", tsel.value), draw());
    document.getElementById("pf-drafts").onclick = (e) => {
      f.onlyDrafts = !f.onlyDrafts;
      setOpt("onlyDrafts", f.onlyDrafts);
      e.target.classList.toggle("on", f.onlyDrafts);
      draw();
    };
    document.getElementById("pf-closed").onclick = (e) => {
      setOpt("closed", !opts.closed);
      e.target.classList.toggle("on", !!opts.closed);
      rerender(true);
    };
    let t;
    document.getElementById("pf-q").oninput = (e) => {
      clearTimeout(t);
      t = setTimeout(() => ((f.q = e.target.value), draw()), 150);
    };
    document.getElementById("pf-all").onclick = (e) => {
      setOpt("all", !opts.all);
      e.target.classList.toggle("on", !!opts.all);
      rerender(true);
    };
    document.getElementById("pf-refresh").onclick = () => rerender(true);
    screens.pipeline._redraw = () => rerender(true);
    draw();
  },
};

function drawBoard(el, p, list, opts) {
  const collapsed = new Set(store.get("collapsed:" + p.key, []));
  const stages = p.stages.map((s) => s.name).filter((n) => opts.closed || !/closed|won|lost|^успешно|^закрыто/i.test(n));
  for (const c of list) if (c.stage && !stages.includes(c.stage)) stages.push(c.stage);
  const sel = S.peek?.type === "lead" ? S.peek.id : null;
  el.innerHTML = `<div class="board">${stages
    .map((s) => {
      const cs = list.filter((c) => c.stage === s);
      const own = stageOwner(p.key, s);
      const rot = cs.filter((c) => !PARKED.test(s) && (daysInStage(c) ?? 0) > rotLimit(s)).length;
      const isColl = collapsed.has(s);
      return `<div class="col ${isColl ? "collapsed" : ""}" data-drop="${esc(s)}" title="${isColl ? "Click to expand" : ""}">
        <h3><span data-collapse="${esc(s)}" style="cursor:pointer" title="Collapse or expand">${esc(s)}</span>${own ? `<span class="owner ${own}" title="${own === "code" ? "The Copilot moves cards here by rule" : own === "site" ? "Set by the Listed switch on the site" : "Only a person moves cards here"}">${own}</span>` : ""}<span class="n">${cs.length}</span></h3>
        ${rot ? `<div class="sum" style="color:var(--hot)">${rot} waiting too long</div>` : ""}
        <div class="cards">${cs.map((c) => cardHtml(c, sel)).join("") || `<div class="faint" style="font-size:11.5px;padding:6px">empty</div>`}</div></div>`;
    })
    .join("")}</div>`;
  const board = el.querySelector(".board");
  on(board, "click", "[data-card]", (e, c) => {
    const card = list.find((x) => x.leadId === c.dataset.card);
    board.querySelectorAll(".card.sel").forEach((x) => x.classList.remove("sel"));
    c.classList.add("sel");
    emit("open-peek", { type: "lead", id: c.dataset.card, tab: card?.draft ? "copilot" : "card" });
  });
  on(board, "click", "[data-collapse]", (e, h) => {
    e.stopPropagation();
    const s = h.dataset.collapse;
    if (collapsed.has(s)) collapsed.delete(s);
    else collapsed.add(s);
    store.set("collapsed:" + p.key, [...collapsed]);
    drawBoard(el, p, list, opts);
  });
  on(board, "click", ".col.collapsed", (e, col) => {
    collapsed.delete(col.dataset.drop);
    store.set("collapsed:" + p.key, [...collapsed]);
    drawBoard(el, p, list, opts);
  });
  board.addEventListener("dragstart", (e) => {
    const c = e.target.closest("[data-card]");
    if (!c) return;
    e.dataTransfer.setData("text/plain", c.dataset.card);
    c.classList.add("dragging");
  });
  board.addEventListener("dragend", (e) => e.target.closest?.("[data-card]")?.classList.remove("dragging"));
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
    if (!col) return;
    e.preventDefault();
    const id = e.dataTransfer.getData("text/plain");
    const card = list.find((x) => x.leadId === id);
    const to = col.dataset.drop;
    if (!card || card.stage === to) return;
    const from = card.stage;
    const ok = await moveStage(id, to, from);
    if (ok) {
      card.stage = to;
      card.stageSince = new Date().toISOString();
      drawBoard(el, p, list, opts);
    }
  });
}

let sortState = store.get("table-sort", { k: "lastMessageAt", dir: -1 });
function drawTable(el, p, list) {
  const listing = isListingPipe(p.name);
  const cols = listing
    ? [
        ["name", "Villa / card"],
        ["stage", "Stage"],
        ["bedrooms", "BR"],
        ["price", "Price / mo"],
        ["commission", "Commission"],
        ["minStay", "Min stay"],
        ["freeFrom", "Free from"],
        ["area", "Area"],
        ["lastMessageAt", "Last message"],
        ["days", "Days in stage"],
        ["draft", "Draft"],
        ["responsible", "Broker"],
      ]
    : [
        ["name", "Client"],
        ["stage", "Stage"],
        ["temperature", "Temp"],
        ["bedrooms", "BR"],
        ["areas", "Areas"],
        ["budget", "Budget"],
        ["moveIn", "Move-in"],
        ["stay", "Stay"],
        ["lastMessageAt", "Last message"],
        ["days", "Days in stage"],
        ["nextTaskDue", "Next task"],
        ["draft", "Draft"],
        ["responsible", "Broker"],
      ];
  const val = (c, k) => {
    const f = c.facts || {};
    const r = c.request || {};
    switch (k) {
      case "bedrooms":
        return listing ? f.bedrooms ?? null : r.bedrooms ?? null;
      case "price":
        return f.monthlyIdr ?? null;
      case "commission":
        return f.commission ?? null;
      case "minStay":
        return f.minStayMonths ?? null;
      case "freeFrom":
        return f.freeFromIso || f.availableFrom || null;
      case "area":
        return f.area ?? null;
      case "areas":
        return r.areas ?? null;
      case "budget":
        return r.budget ?? null;
      case "moveIn":
        return r.moveIn ?? null;
      case "stay":
        return r.stay ?? null;
      case "days":
        return daysInStage(c);
      case "draft":
        return c.draft?.kind ?? null;
      default:
        return c[k] ?? null;
    }
  };
  const sorted = [...list].sort((a, b) => {
    const x = val(a, sortState.k);
    const y = val(b, sortState.k);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (x > y ? 1 : x < y ? -1 : 0) * sortState.dir;
  });
  const stages = p.stages.map((s) => s.name);
  const cell = (c, k) => {
    const v = val(c, k);
    if (k === "name") return `<b>${esc(c.name)}</b>`;
    if (k === "stage") return `<select class="inline" data-stage="${esc(c.leadId)}">${[...new Set([c.stage, ...stages])].filter(Boolean).map((s) => `<option ${s === c.stage ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>`;
    if (k === "temperature") return v ? `<span class="pill ${esc(v)}">${esc(v)}</span>` : "";
    if (k === "price" || k === "budget") return `<span class="num">${money(v)}</span>`;
    if (k === "lastMessageAt" || k === "nextTaskDue") return v ? `<span class="age ${k === "nextTaskDue" && new Date(v) < new Date() ? "rot" : ""}">${esc(rel(v))}</span>` : "";
    if (k === "days") return v == null ? "" : `<span class="age ${!PARKED.test(c.stage || "") && v > rotLimit(c.stage || "") ? "rot" : ""}">${Math.floor(v)}d</span>`;
    if (k === "draft") return v ? `<span class="q ${v === "live" ? "live" : "push"}">${esc(v)}</span>` : "";
    return esc(v ?? "");
  };
  const sel = S.peek?.type === "lead" ? S.peek.id : null;
  el.innerHTML = `<div class="tbl-wrap"><table class="grid"><thead><tr>${cols.map(([k, l]) => `<th data-sort="${k}" class="${sortState.k === k ? "sorted" : ""}">${esc(l)}${sortState.k === k ? (sortState.dir > 0 ? " ↑" : " ↓") : ""}</th>`).join("")}</tr></thead>
    <tbody>${sorted.map((c) => `<tr data-row="${esc(c.leadId)}" class="${sel === c.leadId ? "sel" : ""}">${cols.map(([k]) => `<td class="${k === "name" || k === "areas" ? "ellip" : ""}">${cell(c, k)}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${cols.length}" class="empty">No cards match.</td></tr>`}</tbody></table></div>
    <p class="faint" style="font-size:11.5px;margin:8px 2px">${sorted.length} cards · click a column to sort · change a stage right in the table · a row opens the card on the right.</p>`;
  on(el, "click", "[data-sort]", (e, th) => {
    const k = th.dataset.sort;
    sortState = { k, dir: sortState.k === k ? -sortState.dir : -1 };
    store.set("table-sort", sortState);
    drawTable(el, p, list);
  });
  on(el, "click", "tr[data-row]", (e, tr) => {
    if (e.target.closest("select")) return;
    el.querySelectorAll("tr.sel").forEach((x) => x.classList.remove("sel"));
    tr.classList.add("sel");
    const c = list.find((x) => x.leadId === tr.dataset.row);
    emit("open-peek", { type: "lead", id: tr.dataset.row, tab: c?.draft ? "copilot" : "card" });
  });
  el.querySelectorAll("select[data-stage]").forEach((s) =>
    s.addEventListener("change", async () => {
      const c = list.find((x) => x.leadId === s.dataset.stage);
      const ok = await moveStage(s.dataset.stage, s.value, c?.stage);
      if (ok && c) c.stage = s.value;
      else if (c) s.value = c.stage;
    }),
  );
}

onBus("lead-changed", () => {
  if (S.route.screen === "pipeline" && screens.pipeline._redraw) {
    dropCache("board");
    screens.pipeline._redraw();
  }
});
