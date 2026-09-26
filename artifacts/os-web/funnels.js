// Unicorn OS — Funnels (was Automations until 26.09): each funnel's stages, what moves a card into
// each, the autopilot line and the funnel's other automations; new funnels of the OS's own, with
// their board and cards.
// Owner, 26.09: changes to stages live in the OS only. A funnel from amoCRM keeps amoCRM's stages
// on its board; stage changes here are the plan for the move. Its bot rules act at once, as before.
import { S, api, esc, I, screens, peeks, on, toast, fail, isStaff, money, dialog, confirmBox, store, rel, fmtDT, emit, onBus, initials, dropColumn, boardListen } from "./core.js";
import { proposeChange, PLAYBOOK_OF } from "./playbooks.js";

// Tabs for the funnels that come from amoCRM, and the group their other automations sit in.
const AMO = {
  rental: ["Rental clients", "Rental clients"],
  "rental-listings": ["Rental listings", "Villa owners (Rental Listings)"],
  unicorn: ["Sales", "Sales"],
};
const GENERAL_GROUPS = ["Everyone", "Safety"];
const OWNER = {
  copilot: ["Copilot reads the chat", "code"],
  rule: ["Rule in code", "site"],
  person: ["Only a person", "person"],
  workflow: ["Working stage", ""],
};
const KIND = { open: "Open", won: "Won", lost: "Lost" };
const CHANGE = {
  new: ["new", "added at the move"],
  renamed: ["renamed", ""],
  moved: ["moved", "new place at the move"],
  removed: ["removed", "removed at the move"],
  gone: ["gone", "no longer in amoCRM"],
};

// The bot's switches are shown as they stand; a change is a proposal to the owner (Playbooks, 26.09).
function switchHtml(r) {
  if (!r.switch) return `<span class="owner ${r.owner}" style="margin-left:auto">${r.owner === "code" ? "runs by rule" : r.owner === "site" ? "site switch" : "person decides"}</span>`;
  const v = r.switch.kind === "budget" ? (r.value?.enabled ? "on" : "off") : String(r.value ?? "");
  return `<span class="row" style="gap:6px;margin-left:auto"><span class="pill">${esc(v || "—")}</span><button class="btn sm ghost" data-propose-rule="${esc(r.id)}">Propose change</button></span>`;
}
function ruleCard(x) {
  return `<div class="rule"><div class="rh"><b>${esc(x.name)}</b>${switchHtml(x)}</div>
    <div class="rd"><b>When</b> ${esc(x.when)}<br><b>Then</b> ${esc(x.does)}<br><b>Who hears</b> ${esc(x.notifies)}</div>
    ${x.switch?.kind === "budget" ? `<div class="faint" style="font-size:11.5px">Threshold: ${money(x.value?.minMonthlyIdr)} / month</div>` : ""}</div>`;
}
function readinessHtml(d) {
  const decided = d.asWritten + d.edited + d.skipped;
  if (!d.total) return `<span class="faint">no drafts at this stage in 30 days</span>`;
  const r = d.readiness;
  const cls = r == null ? "" : r >= 85 && decided >= 20 ? "ok" : r >= 60 ? "warn" : "bad";
  return `<div class="ready"><div class="rbar"><i class="w" style="width:${decided ? (d.asWritten / decided) * 100 : 0}%"></i><i class="e" style="width:${decided ? (d.edited / decided) * 100 : 0}%"></i><i class="s" style="width:${decided ? (d.skipped / decided) * 100 : 0}%"></i></div>
    <span>${r == null ? `<span class="faint">too few decided</span>` : `<span class="pill ${cls}">${r}% as written</span>`} <span class="faint">${d.total} drafts · ${d.asWritten} sent as written · ${d.edited} edited · ${d.skipped} skipped${d.auto ? ` · ${d.auto} by autopilot` : ""}</span></span></div>`;
}
const tabLabel = (f) => (AMO[f.key] ? AMO[f.key][0] : f.name);

async function newFunnel(funnels) {
  const r = await dialog({
    title: "New funnel",
    body: `<label class="fld"><span>Name</span><input class="in" name="name" placeholder="Sales, Villa management, Hiring…" required></label>
      <label class="fld" style="margin-top:10px"><span>Stages to start from</span><select class="in" name="copyFrom"><option value="">New · In progress · Won · Lost</option>${funnels.map((f) => `<option value="${esc(f.key)}">Copy the stages of ${esc(tabLabel(f))}</option>`).join("")}</select></label>
      <p class="faint" style="font-size:12px;margin:10px 0 0">The funnel and its cards live in Unicorn OS; amoCRM is not changed. Stages can be added, renamed, moved and removed after.</p>`,
    actions: [{ label: "Cancel", value: null }, { label: "Create", value: "ok", primary: true }],
  });
  if (!r) return null;
  const out = await api("/funnels", { body: { name: r.values.name, copyFrom: r.values.copyFrom || undefined } });
  S.meta.osFunnels = [...(S.meta.osFunnels || []), { key: out.key, name: out.name, color: null }];
  toast(`Funnel “${out.name}” created`);
  return out;
}

screens.funnels = {
  title: "Funnels",
  async render({ el, tools, route }) {
    const staff = isStaff();
    el.innerHTML = `<div class="loading">Reading the funnels…</div>`;
    const wantNew = route.parts[0] === "new";
    const want = wantNew ? null : route.parts[0];
    const saved = store.get("fn-tab", "rental");
    const tabGuess = want || saved;
    const [fl, all, mapGuess] = await Promise.all([
      api("/funnels"),
      api("/automations"),
      AMO[tabGuess] ? api(`/automations/map?funnel=${tabGuess}`).catch(() => null) : Promise.resolve(null),
    ]);
    // amoCRM funnels in the menu's order (Rental first), then the OS's own.
    const rank = (f) => (AMO[f.key] ? Object.keys(AMO).indexOf(f.key) : 10);
    const funnels = [...fl.items].sort((a, b) => rank(a) - rank(b));
    const keys = funnels.map((f) => f.key);
    const tab = [...keys, "general"].includes(tabGuess) ? tabGuess : "rental";
    store.set("fn-tab", tab);
    const map = AMO[tab] ? (tabGuess === tab ? mapGuess : await api(`/automations/map?funnel=${tab}`)) : null;
    tools.innerHTML = `<div class="views">${funnels.map((f) => `<button data-fn="${esc(f.key)}" class="${f.key === tab ? "active" : ""}">${esc(tabLabel(f))}</button>`).join("")}<button data-fn="general" class="${tab === "general" ? "active" : ""}">General</button></div>
      ${staff ? `<button class="btn sm" id="fn-new">${I.plus} New funnel</button>` : ""}<button class="btn sm ghost" id="fn-refresh">Refresh</button>`;
    on(tools, "click", "[data-fn]", (e, b) => (location.hash = `#/funnels/${b.dataset.fn}`));
    const redraw = () => screens.funnels.render({ el, tools, route: { ...S.route, parts: [tab] } });
    tools.querySelector("#fn-refresh").onclick = redraw;
    const openNew = async () => {
      try {
        const out = await newFunnel(funnels);
        if (out) location.hash = `#/funnels/${out.key}`;
        else if (wantNew) history.replaceState(null, "", `#/funnels/${tab}`);
      } catch (e) {
        fail(e);
      }
    };
    if (staff) tools.querySelector("#fn-new").onclick = openNew;

    const f = funnels.find((x) => x.key === tab);
    if (tab === "general") drawGeneral(el, all, staff);
    else if (f.source === "amo") drawAmo(el, f, map, all, staff, redraw);
    else drawOs(el, f, staff, redraw);
    bindSwitches(el, all, tab);
    if (wantNew && staff) openNew();
  },
};
// Old links (#/automations/rental) open the same funnel here.
screens.automations = { title: "Funnels", render: ({ route }) => location.replace(`#/funnels/${route.parts[0] || ""}`) };

function drawGeneral(el, all, staff) {
  const others = all.rules.filter((x) => GENERAL_GROUPS.includes(x.group) && x.switch?.kind !== "autopilot");
  el.innerHTML = `<div class="page"><h1 class="pt">General</h1><p class="pd">Rules that belong to no single funnel. The switches are the live ones the Copilot reads, shown as they stand; a change is a proposal the owner approves in Playbooks.</p><div class="auto-grid">${others.map(ruleCard).join("")}</div></div>`;
}

function bindSwitches(el, all, tab) {
  on(el, "click", "[data-propose-rule]", (e, b) => {
    const x = all.rules.find((y) => y.id === b.dataset.proposeRule);
    const now = x.switch?.kind === "budget" ? `${x.value?.enabled ? "on" : "off"}, threshold ${money(x.value?.minMonthlyIdr)} / month` : String(x.value ?? "");
    proposeChange({ file: PLAYBOOK_OF[tab] || "general.md", section: x.name, current: `${x.name}: ${now}. When: ${x.when}. Then: ${x.does}.` });
  });
}

// ── the structure editor shared by both kinds of funnel ──

/** Drag a stage row by its handle to a new place; `save(ids)` gets the new order of row ids. */
function bindReorder(list, save) {
  let drag = null;
  list.addEventListener("dragstart", (e) => {
    const row = e.target.closest("[data-row]");
    if (!row) return;
    drag = row;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", row.dataset.row);
    row.classList.add("dragging");
  });
  list.addEventListener("dragend", () => {
    drag?.classList.remove("dragging");
    list.querySelectorAll(".drop-before,.drop-after").forEach((x) => x.classList.remove("drop-before", "drop-after"));
    drag = null;
  });
  list.addEventListener("dragover", (e) => {
    const row = e.target.closest("[data-row]");
    if (!drag || !row || row === drag) return;
    e.preventDefault();
    const b = row.getBoundingClientRect();
    list.querySelectorAll(".drop-before,.drop-after").forEach((x) => x.classList.remove("drop-before", "drop-after"));
    row.classList.add(e.clientY > b.top + b.height / 2 ? "drop-after" : "drop-before");
  });
  list.addEventListener("drop", (e) => {
    const row = e.target.closest("[data-row]");
    if (!drag || !row || row === drag) return;
    e.preventDefault();
    const after = row.classList.contains("drop-after");
    row.classList.remove("drop-before", "drop-after");
    const ids = [...list.querySelectorAll("[data-row]")].map((x) => x.dataset.row).filter((x) => x !== drag.dataset.row);
    ids.splice(ids.indexOf(row.dataset.row) + (after ? 1 : 0), 0, drag.dataset.row);
    save(ids);
  });
}

async function stageDialog(title, s, withKind) {
  return dialog({
    title,
    body: `<label class="fld"><span>Stage name</span><input class="in" name="name" value="${esc(s?.name || "")}" required></label>
      ${withKind ? `<label class="fld" style="margin-top:10px"><span>Kind</span><select class="in" name="kind">${Object.entries(KIND).map(([k, l]) => `<option value="${k}" ${(s?.kind || "open") === k ? "selected" : ""}>${l}${k === "open" ? " (the card is still being worked)" : k === "won" ? " (a closing stage: done well)" : " (a closing stage: lost)"}</option>`).join("")}</select></label>` : ""}`,
    actions: [{ label: "Cancel", value: null }, { label: "Save", value: "ok", primary: true }],
  });
}

async function ruleDialog(stageName, text, help, canReset) {
  return dialog({
    title: `What moves a card to “${stageName}”`,
    wide: true,
    body: `<p class="muted" style="margin:0 0 8px">${esc(help)}</p><textarea class="in" name="rule" rows="6">${esc(text || "")}</textarea>${canReset ? `<p class="faint" style="font-size:12px;margin:8px 0 0">Empty it to go back to the built-in description.</p>` : ""}`,
    actions: [{ label: "Cancel", value: null }, ...(canReset ? [{ label: "Back to built-in", value: "reset" }] : []), { label: "Save", value: "ok", primary: true }],
  });
}

// ── a funnel from amoCRM: live stages and rules, and the plan for the move ──
function drawAmo(el, f, map, all, staff, redraw) {
  const ap = map.autopilot;
  const stat = new Map(map.stages.map((s) => [s.name.toLowerCase(), s]));
  const rows = f.plan ? f.plan.stages : f.live.map((s) => ({ id: null, amoStageId: s.id, name: s.name, liveName: s.name, change: null, removed: false, rule: "" }));
  const rowKey = (r) => (r.id ? `p${r.id}` : `a${r.amoStageId}`);
  const changes = rows.filter((r) => r.change).length;
  const others = all.rules.filter((x) => x.group === AMO[f.key][1] && x.switch?.kind !== "autopilot");
  const lineName = ap.mode !== "off" && ap.upToStageName ? ap.upToStageName.toLowerCase() : null;

  const rowHtml = (r, i) => {
    const s = r.liveName && !r.removed ? stat.get(r.liveName.toLowerCase()) : null;
    const line = s && lineName && r.liveName.toLowerCase() === lineName ? `<div class="apline"><span>${ap.mode === "dry" ? "Dry run above: logged, not sent" : "Autopilot sends above"} · people approve from here</span></div>` : "";
    const [ownLabel, ownCls] = s ? OWNER[s.owner] || ["", ""] : ["", ""];
    const mode = !s ? `<span class="mode person">${r.change === "new" ? "Planned" : "—"}</span>` : s.owner === "person" ? `<span class="mode person">Person</span>` : s.autopilot === "autopilot" ? `<span class="mode bot">Autopilot</span>` : s.autopilot === "dry" ? `<span class="mode dry">Dry run</span>` : `<span class="mode people">People approve</span>`;
    const ch = r.change ? CHANGE[r.change] : null;
    const chTag = ch ? `<span class="pill ${r.change === "removed" || r.change === "gone" ? "bad" : "warn"}" title="Saved in Unicorn OS for the move; amoCRM is not changed">${r.change === "renamed" ? `renamed · “${esc(r.liveName)}” in amoCRM until the move` : `${esc(ch[0])}${ch[1] ? " · " + esc(ch[1]) : ""}`}</span>` : "";
    const how = s ? `<div class="how"><span class="faint">What moves a card here:</span> ${esc(s.howItGetsHere)}${s.edited ? ` <span class="pill warn" title="rewritten in Unicorn OS">edited by ${esc(s.edited.by || "")} ${esc(rel(s.edited.at))}</span>` : ""}</div>${s.builtIn ? `<div class="how faint">${esc(s.builtIn)}</div>` : ""}` : r.change === "new" ? `<div class="how"><span class="faint">What moves a card here:</span> ${r.rule ? esc(r.rule) : `<span class="faint">not written yet; the Copilot reads it from the move</span>`}</div>` : "";
    return `${line}<div class="stage-row ${r.removed ? "removed" : ""}" data-row="${rowKey(r)}" ${staff && !r.removed ? `draggable="true"` : ""}>
      <div class="sl">${staff && !r.removed ? `<span class="grip" title="Drag to move the stage">⋮⋮</span>` : ""}${mode}</div>
      <div class="sm2"><div class="sn"><b>${esc(r.name)}</b>${chTag}${ownLabel ? `<span class="owner ${ownCls}">${esc(ownLabel)}</span>` : ""}${s ? `<span class="faint">${s.cardsNow} cards now · into it in 7 days: ${s.movesIn7d.bot} by the bot, ${s.movesIn7d.people} by people</span>` : ""}</div>
        ${how}${s && s.owner !== "person" ? readinessHtml(s.drafts30d) : ""}</div>
      <div class="sa">${
        !staff
          ? ""
          : r.removed
            ? `<button class="btn sm" data-restore="${rowKey(r)}">Restore</button>`
            : `${r.change === "new" ? `<button class="btn sm" data-edit-rule="${rowKey(r)}">Edit what moves it</button>` : s ? `<button class="btn sm" data-edit-rule="${rowKey(r)}" title="The stage's rule is the funnel's regulation: the owner approves a change">Propose change</button>` : ""}<span class="row" style="gap:4px"><button class="btn sm ghost" data-rename="${rowKey(r)}">Rename</button><button class="btn sm ghost" data-remove="${rowKey(r)}">Remove</button></span>`
      }</div></div>`;
  };

  el.innerHTML = `<div class="page"><div class="fn-head"><h1 class="pt">${esc(AMO[f.key][0])}</h1><span class="pill" title="Cards and stages come from amoCRM until the agency moves">from amoCRM</span><span class="spacer"></span><a class="btn sm ghost" href="#/pipeline/${esc(f.key)}">${I.board} Open the board</a></div>
    <p class="pd">Each stage: what moves a card into it and who owns that move, and how ready it is for the autopilot. The rules for the bot are the funnel's regulation (Playbooks): shown here, changed only by a proposal the owner approves. Adding, renaming, moving or removing stages is saved in Unicorn OS for the move; amoCRM keeps its stages until then.</p>
    <div class="panel ap-panel"><h3>Autopilot <span class="row" style="gap:8px"><span class="pill">${esc(ap.mode)}</span><span class="faint">up to ${ap.dailyCap} sends a day</span><button class="btn sm ghost" id="fn-ap-propose">Propose change</button></span></h3>
      <p class="faint" style="margin:0;font-size:12px">${ap.mode === "off" ? "Off: people approve every draft in every stage." : `${ap.mode === "dry" ? "Dry run: it logs what it would send and sends nothing. " : ""}The line is before <b>${esc(ap.upToStageName || "—")}</b>: above it the bot sends on its own, from it on people approve.`} Where the autopilot works is part of the funnel's regulation: a change goes to the owner as a proposal.</p></div>
    <div class="stage-map" id="fn-stages">${rows.map(rowHtml).join("")}</div>
    ${staff ? `<div class="row fn-foot"><button class="btn sm" id="fn-add">${I.plus} Add a stage</button>${changes ? `<span class="faint">${changes} change${changes === 1 ? "" : "s"} saved for the move · amoCRM unchanged</span><button class="btn sm ghost" id="fn-discard">Discard the plan</button>` : ""}</div>` : ""}
    <p class="faint" style="font-size:11.5px">“As written” counts drafts of the last 30 days, by the stage the card was in when the draft was written. A stage is ready for the autopilot at 85% or more, from 20 decided drafts. The description of a stage is the one the Copilot reads now.</p>
    ${others.length ? `<h3 style="font-size:13px;margin:18px 0 8px">Other automations in this funnel</h3><div class="auto-grid">${others.map(ruleCard).join("")}</div>` : ""}</div>`;

  // The first structure change starts the plan (a copy of amoCRM's stages); rows then carry plan ids.
  const planned = async (key) => {
    const fresh = f.plan ? f : await api(`/funnels/${encodeURIComponent(f.key)}/plan`, { method: "POST" });
    const r = key.startsWith("p") ? fresh.plan.stages.find((x) => `p${x.id}` === key) : fresh.plan.stages.find((x) => `a${x.amoStageId}` === key);
    return { fresh, row: r };
  };
  const saved = (msg) => (toast(msg), redraw());
  const base = `/funnels/${encodeURIComponent(f.key)}`;

  const playbook = PLAYBOOK_OF[f.key];
  el.querySelector("#fn-ap-propose")?.addEventListener("click", () =>
    proposeChange({ file: playbook, section: "Autopilot", current: `Autopilot ${ap.mode}${ap.upToStageName ? `, line before ${ap.upToStageName}` : ""}, up to ${ap.dailyCap} sends a day.` }),
  );
  on(el, "click", "[data-edit-rule]", async (e, b) => {
    const r = rows.find((x) => rowKey(x) === b.dataset.editRule);
    const s = r.liveName ? stat.get(r.liveName.toLowerCase()) : null;
    if (s && r.change !== "new") return proposeChange({ file: playbook, section: `Stage: ${s.name}`, current: s.howItGetsHere });
    const res = await ruleDialog(r.name, r.rule, "A planned stage: the Copilot starts reading this on the day of the move. Say what must have happened in the chat, and what is not enough.", false);
    if (!res) return;
    try {
      await api(`${base}/stages/${r.id}`, { method: "PATCH", body: { rule: res.values.rule } });
      saved("Saved for the move");
    } catch (err) {
      fail(err);
    }
  });
  on(el, "click", "[data-rename]", async (e, b) => {
    const r = rows.find((x) => rowKey(x) === b.dataset.rename);
    const res = await stageDialog(`Rename “${r.name}”`, r, false);
    if (!res) return;
    try {
      const { row } = await planned(b.dataset.rename);
      await api(`${base}/stages/${row.id}`, { method: "PATCH", body: { name: res.values.name } });
      saved("Renamed for the move · amoCRM keeps the old name until then");
    } catch (err) {
      fail(err);
    }
  });
  on(el, "click", "[data-remove]", async (e, b) => {
    const r = rows.find((x) => rowKey(x) === b.dataset.remove);
    if (!(await confirmBox(`Remove “${r.name}”?`, r.change === "new" ? "The planned stage goes away." : "Saved for the move: the stage stays in amoCRM and on the board until then.", "Remove", true))) return;
    try {
      const { row } = await planned(b.dataset.remove);
      await api(`${base}/stages/${row.id}/remove`, { body: {} });
      saved(r.change === "new" ? "Planned stage removed" : "Removed at the move · amoCRM unchanged");
    } catch (err) {
      fail(err);
    }
  });
  on(el, "click", "[data-restore]", async (e, b) => {
    const r = rows.find((x) => rowKey(x) === b.dataset.restore);
    try {
      await api(`${base}/stages/${r.id}`, { method: "PATCH", body: { restore: true } });
      saved("Stage kept");
    } catch (err) {
      fail(err);
    }
  });
  const add = el.querySelector("#fn-add");
  if (add)
    add.onclick = async () => {
      const res = await stageDialog("Add a stage", null, true);
      if (!res) return;
      try {
        await planned("p0");
        await api(`${base}/stages`, { body: { name: res.values.name, kind: res.values.kind } });
        saved("Stage added for the move · amoCRM unchanged");
      } catch (err) {
        fail(err);
      }
    };
  const disc = el.querySelector("#fn-discard");
  if (disc)
    disc.onclick = async () => {
      if (!(await confirmBox("Discard the plan for the move?", "Every stage change saved here goes; the stages go back to amoCRM's own. The rules for the bot stay as they are.", "Discard", true))) return;
      try {
        await api(`${base}/discard-plan`, { body: {} });
        saved("Plan discarded");
      } catch (err) {
        fail(err);
      }
    };
  if (staff)
    bindReorder(el.querySelector("#fn-stages"), async (keys) => {
      try {
        const { fresh } = await planned("p0");
        const ids = keys.map((k) => (k.startsWith("p") ? fresh.plan.stages.find((x) => `p${x.id}` === k) : fresh.plan.stages.find((x) => `a${x.amoStageId}` === k))?.id).filter(Boolean);
        await api(`${base}/stage-order`, { body: { ids } });
        saved("New order saved for the move · amoCRM unchanged");
      } catch (err) {
        fail(err);
      }
    });
}

// ── a funnel of the OS's own ──
function drawOs(el, f, staff, redraw) {
  const base = `/funnels/${encodeURIComponent(f.key)}`;
  const rowHtml = (s) => `<div class="stage-row" data-row="${s.id}" ${staff ? `draggable="true"` : ""}>
      <div class="sl">${staff ? `<span class="grip" title="Drag to move the stage">⋮⋮</span>` : ""}<span class="mode ${s.kind === "won" ? "bot" : s.kind === "lost" ? "dry" : "person"}">${KIND[s.kind] || "Open"}</span></div>
      <div class="sm2"><div class="sn"><b>${esc(s.name)}</b><span class="faint">${s.cards} card${s.cards === 1 ? "" : "s"} now</span></div>
        <div class="how"><span class="faint">What moves a card here:</span> ${s.rule ? esc(s.rule) : `<span class="faint">not written yet</span>`}</div></div>
      <div class="sa">${staff ? `<button class="btn sm" data-edit-rule="${s.id}">Edit what moves it</button><span class="row" style="gap:4px"><button class="btn sm ghost" data-rename="${s.id}">Rename</button><button class="btn sm ghost" data-remove="${s.id}">Remove</button></span>` : ""}</div></div>`;
  el.innerHTML = `<div class="page"><div class="fn-head"><h1 class="pt">${esc(f.name)}</h1><span class="pill ok" title="This funnel and its cards live in Unicorn OS">Unicorn OS</span><span class="spacer"></span>
      <a class="btn sm" href="#/pipeline/${esc(f.key)}">${I.board} Open the board</a>${staff ? `<button class="btn sm ghost" id="fn-rename">Rename</button><button class="btn sm ghost" id="fn-archive">Remove the funnel</button>` : ""}</div>
    <p class="pd">This funnel and its cards live in Unicorn OS only; amoCRM does not see them. People move the cards on the board; the Copilot does not read them yet. The rule of each stage says what must have happened for a card to be there.</p>
    <div class="stage-map" id="fn-stages">${f.stages.map(rowHtml).join("")}</div>
    ${staff ? `<div class="row fn-foot"><button class="btn sm" id="fn-add">${I.plus} Add a stage</button></div>` : ""}</div>`;
  if (!staff) return;
  const saved = (msg) => (toast(msg), redraw());
  const run = (fn, msg) => fn().then(() => saved(msg)).catch(fail);
  on(el, "click", "[data-edit-rule]", async (e, b) => {
    const s = f.stages.find((x) => String(x.id) === b.dataset.editRule);
    const res = await ruleDialog(s.name, s.rule, "What must have happened for a card to be in this stage, and what is not enough. People read it now; the Copilot will read it when it works in this funnel.", false);
    if (res) run(() => api(`${base}/stages/${s.id}`, { method: "PATCH", body: { rule: res.values.rule } }), "Rule saved");
  });
  on(el, "click", "[data-rename]", async (e, b) => {
    const s = f.stages.find((x) => String(x.id) === b.dataset.rename);
    const res = await stageDialog(`Stage “${s.name}”`, s, true);
    if (res) run(() => api(`${base}/stages/${s.id}`, { method: "PATCH", body: { name: res.values.name, kind: res.values.kind } }), "Stage saved");
  });
  on(el, "click", "[data-remove]", async (e, b) => {
    const s = f.stages.find((x) => String(x.id) === b.dataset.remove);
    const rest = f.stages.filter((x) => x.id !== s.id);
    if (!rest.length) return toast("A funnel keeps at least one stage.", { bad: true });
    const res = await dialog({
      title: `Remove “${s.name}”?`,
      body: s.cards
        ? `<p class="muted" style="margin:0 0 8px">${s.cards} card${s.cards === 1 ? " is" : "s are"} in this stage. They move to:</p><select class="in" name="moveTo">${rest.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("")}</select>`
        : `<p class="muted" style="margin:0">No cards are in it.</p>`,
      actions: [{ label: "Cancel", value: null }, { label: "Remove", value: "ok", primary: true, danger: true }],
    });
    if (res) run(() => api(`${base}/stages/${s.id}/remove`, { body: { moveTo: res.values.moveTo ? Number(res.values.moveTo) : undefined } }), "Stage removed");
  });
  el.querySelector("#fn-add").onclick = async () => {
    const res = await stageDialog("Add a stage", null, true);
    if (res) run(() => api(`${base}/stages`, { body: { name: res.values.name, kind: res.values.kind } }), "Stage added");
  };
  el.querySelector("#fn-rename").onclick = async () => {
    const res = await dialog({ title: "Rename the funnel", body: `<label class="fld"><span>Name</span><input class="in" name="name" value="${esc(f.name)}" required></label>`, actions: [{ label: "Cancel", value: null }, { label: "Save", value: "ok", primary: true }] });
    if (!res) return;
    run(async () => {
      await api(base, { method: "PATCH", body: { name: res.values.name } });
      const m = (S.meta.osFunnels || []).find((x) => x.key === f.key);
      if (m) m.name = res.values.name;
    }, "Funnel renamed");
  };
  el.querySelector("#fn-archive").onclick = async () => {
    if (!(await confirmBox(`Remove “${f.name}”?`, "The funnel and its board leave the menu. Its cards are kept in the database.", "Remove", true))) return;
    try {
      await api(base, { method: "DELETE" });
      S.meta.osFunnels = (S.meta.osFunnels || []).filter((x) => x.key !== f.key);
      toast("Funnel removed");
      location.hash = "#/funnels/rental";
    } catch (err) {
      fail(err);
    }
  };
  bindReorder(el.querySelector("#fn-stages"), (ids) => run(() => api(`${base}/stage-order`, { body: { ids: ids.map(Number) } }), "New order saved"));
}

// ── the board of a funnel of the OS's own ──
export function osFunnel(key) {
  return (S.meta.osFunnels || []).find((x) => x.key === key) || null;
}

export async function renderOsBoard({ el, tools, key }) {
  tools.innerHTML = `<button class="btn sm primary" id="ob-new">${I.plus} New card</button><input class="in" id="ob-q" placeholder="Search…" style="width:160px;padding:5px 8px">
    <a class="btn sm ghost" href="#/funnels/${esc(key)}" title="Funnel settings: stages and what moves a card into each">${I.gear} Settings</a><button class="btn sm ghost" id="ob-refresh">Refresh</button>`;
  el.innerHTML = `<div class="loading">Loading the board…</div>`;
  let data;
  const load = async () => (data = await api(`/funnels/${encodeURIComponent(key)}/cards`));
  try {
    await load();
  } catch (e) {
    el.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  let q = "";
  const sel = () => (S.peek?.type === "ocard" ? S.peek.id : null);
  const cardHtml = (c) => {
    const days = Math.floor((Date.now() - new Date(c.stageSince).getTime()) / 86400e3);
    const sub = [c.phone, c.valueIdr ? money(c.valueIdr) : null].filter(Boolean).join(" · ");
    return `<div class="card ${String(sel()) === String(c.id) ? "sel" : ""}" draggable="true" data-ocard="${c.id}"><div class="ct"><span class="nm">${esc(c.name)}</span></div>${sub ? `<div class="cs">${esc(sub)}</div>` : ""}
      <div class="cm"><span class="age" title="days in this stage">${days}d</span><span class="spacer"></span>${c.responsible ? `<span class="avatar sm" title="${esc(c.responsible)}">${esc(initials(c.responsible))}</span>` : ""}</div></div>`;
  };
  const draw = () => {
    const list = data.items.filter((c) => !q || `${c.name} ${c.phone} ${c.email} ${c.notes}`.toLowerCase().includes(q));
    el.innerHTML = `<div class="board">${data.stages
      .map((s) => {
        const cs = list.filter((c) => c.stageId === s.id);
        return `<div class="col" data-drop="${s.id}"><h3><span>${esc(s.name)}</span>${s.kind !== "open" ? `<span class="owner ${s.kind === "won" ? "code" : "person"}">${s.kind}</span>` : ""}<span class="n">${cs.length}</span><button class="iconbtn" data-add="${s.id}" title="New card in ${esc(s.name)}" style="width:22px;height:22px;flex:0 0 22px">${I.plus}</button></h3>
          <div class="cards">${cs.map(cardHtml).join("") || `<div class="faint" style="font-size:11.5px;padding:6px">empty</div>`}</div></div>`;
      })
      .join("")}</div>`;
    const board = el.querySelector(".board");
    on(board, "click", "[data-ocard]", (e, c) => emit("open-peek", { type: "ocard", id: c.dataset.ocard }));
    on(board, "click", "[data-add]", (e, b) => (e.stopPropagation(), newCard(Number(b.dataset.add))));
    board.addEventListener("dragstart", (e) => {
      const c = e.target.closest("[data-ocard]");
      if (!c) return;
      e.dataTransfer.setData("text/plain", c.dataset.ocard);
      c.classList.add("dragging");
    });
    board.addEventListener("dragend", (e) => e.target.closest?.("[data-ocard]")?.classList.remove("dragging"));
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
      const c = data.items.find((x) => String(x.id) === e.dataTransfer.getData("text/plain"));
      const to = Number(col.dataset.drop);
      if (!c || c.stageId === to) return;
      const was = [c.stageId, c.stage, c.stageSince];
      c.stageId = to;
      c.stage = data.stages.find((s) => s.id === to)?.name || "";
      c.stageSince = new Date().toISOString();
      draw();
      try {
        await api(`/cards/${c.id}`, { method: "PATCH", body: { stageId: to } });
      } catch (err) {
        [c.stageId, c.stage, c.stageSince] = was;
        draw();
        fail(err);
      }
    });
  };
  const newCard = async (stageId) => {
    const r = await dialog({
      title: "New card",
      body: `<label class="fld"><span>Name</span><input class="in" name="name" required></label>
        <div class="row" style="margin-top:10px;flex-wrap:nowrap"><label class="fld" style="flex:1"><span>Phone</span><input class="in" name="phone" inputmode="tel"></label><label class="fld" style="flex:1"><span>Email</span><input class="in" name="email" type="email"></label></div>
        <div class="row" style="margin-top:10px;flex-wrap:nowrap"><label class="fld" style="flex:1"><span>Stage</span><select class="in" name="stageId">${data.stages.map((s) => `<option value="${s.id}" ${s.id === stageId ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label><label class="fld" style="flex:1"><span>Value (IDR)</span><input class="in" name="valueIdr" type="number" step="1000000"></label></div>
        <label class="fld" style="margin-top:10px"><span>Notes</span><textarea class="in" name="notes" rows="3"></textarea></label>`,
      actions: [{ label: "Cancel", value: null }, { label: "Create", value: "ok", primary: true }],
    });
    if (!r) return;
    try {
      const c = await api(`/funnels/${encodeURIComponent(key)}/cards`, { body: { ...r.values, stageId: Number(r.values.stageId), valueIdr: r.values.valueIdr ? Number(r.values.valueIdr) : null } });
      data.items.unshift(c);
      draw();
      toast("Card created");
    } catch (e) {
      fail(e);
    }
  };
  tools.querySelector("#ob-new").onclick = () => newCard(data.stages[0]?.id);
  let t;
  tools.querySelector("#ob-q").oninput = (e) => {
    clearTimeout(t);
    t = setTimeout(() => ((q = e.target.value.toLowerCase()), draw()), 150);
  };
  tools.querySelector("#ob-refresh").onclick = async () => {
    await load().catch(fail);
    draw();
  };
  screens.pipeline._redraw = async () => {
    await load().catch(fail);
    draw();
  };
  draw();
}

// ── a card of the OS's own funnel, in the side panel ──
peeks.ocard = {
  defaultTab: "card",
  async render(el, st, ctl) {
    let c;
    try {
      c = await api(`/cards/${encodeURIComponent(st.id)}`);
    } catch (e) {
      el.innerHTML = `<div class="ph"><h2>Card</h2><button class="iconbtn" data-close>${I.x}</button></div><div class="empty">${esc(e.message)}</div>`;
      el.querySelector("[data-close]").onclick = ctl.close;
      return;
    }
    const staff = isStaff();
    const people = S.meta.people || [];
    const evText = (e) =>
      e.kind === "stage" ? `${esc(e.detail?.from || "—")} → <b>${esc(e.detail?.to || "")}</b>${e.detail?.why ? ` <span class="faint">(${esc(e.detail.why)})</span>` : ""}` : e.kind === "created" ? `Created in <b>${esc(e.detail?.stage || "")}</b>` : e.kind === "deleted" ? "Deleted" : `Edited ${esc(Object.keys(e.detail || {}).join(", "))}`;
    const wa = String(c.phone || "").replace(/[^0-9]/g, "");
    el.innerHTML = `<div class="resize-x" id="oc-resize" title="Drag to resize"></div>
      <div class="ph"><div class="avatar">${esc(initials(c.name))}</div><div style="min-width:0;flex:1"><h2>${esc(c.name)}</h2><div class="faint" style="font-size:12px">${esc(c.funnel.name)} · ${esc(c.stage)}${c.responsible ? " · " + esc(c.responsible) : ""}</div></div>
        <button class="iconbtn" data-close title="Close (Esc)">${I.x}</button></div>
      <div class="pb pad" id="oc-body"><form class="stack" id="oc-form" style="gap:10px">
        <label class="fld"><span>Name</span><input class="in" name="name" value="${esc(c.name)}"></label>
        <label class="fld"><span>Stage</span><select class="in" name="stageId">${c.stages.map((s) => `<option value="${s.id}" ${s.id === c.stageId ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label>
        <div class="row" style="flex-wrap:nowrap"><label class="fld" style="flex:1"><span>Phone ${wa ? `<a href="https://wa.me/${esc(wa)}" target="_blank" rel="noopener">WhatsApp</a>` : ""}</span><input class="in" name="phone" value="${esc(c.phone)}"></label><label class="fld" style="flex:1"><span>Email</span><input class="in" name="email" value="${esc(c.email)}"></label></div>
        <div class="row" style="flex-wrap:nowrap"><label class="fld" style="flex:1"><span>Value (IDR)</span><input class="in" name="valueIdr" type="number" step="1000000" value="${c.valueIdr ?? ""}"></label>
          ${staff ? `<label class="fld" style="flex:1"><span>Responsible</span><select class="in" name="responsibleId"><option value="">Nobody yet</option>${people.map((p) => `<option value="${p.id}" ${p.id === c.responsibleId ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>` : ""}</div>
        <label class="fld"><span>Notes</span><textarea class="in" name="notes" rows="5">${esc(c.notes)}</textarea></label>
        <div class="row"><button class="btn primary" type="submit">Save</button><span class="spacer"></span><button class="btn sm ghost danger" type="button" id="oc-del">Delete the card</button></div>
      </form>
      <div class="sect-h" style="margin-top:18px">History</div>
      <div class="timeline">${c.events.map((e) => `<div class="ev"><i class="person"></i><div>${evText(e)}<small>${esc(fmtDT(e.at))}${e.who ? " · " + esc(e.who) : ""}</small></div></div>`).join("") || `<div class="faint">Nothing yet.</div>`}</div></div>`;
    el.querySelector("[data-close]").onclick = ctl.close;
    const { resizer } = await import("./core.js");
    resizer(el.querySelector("#oc-resize"), { varName: "--peek-w", min: 360, max: Math.max(420, window.innerWidth - 200), invert: true });
    const form = el.querySelector("#oc-form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(form).entries());
      const body = { name: v.name, stageId: Number(v.stageId), phone: v.phone, email: v.email, notes: v.notes, valueIdr: v.valueIdr ? Number(v.valueIdr) : null };
      if (staff) body.responsibleId = v.responsibleId ? Number(v.responsibleId) : null;
      try {
        await api(`/cards/${c.id}`, { method: "PATCH", body });
        toast("Saved");
        emit("ocard-changed", { id: c.id });
        ctl.setTab("card");
      } catch (err) {
        fail(err);
      }
    });
    el.querySelector("#oc-del").onclick = async () => {
      if (!(await confirmBox("Delete this card?", "It leaves the board. The record is kept in the database.", "Delete", true))) return;
      try {
        await api(`/cards/${c.id}`, { method: "PATCH", body: { delete: true } });
        emit("ocard-changed", { id: c.id });
        ctl.close();
      } catch (err) {
        fail(err);
      }
    };
  },
};
onBus("ocard-changed", () => {
  if (S.route.screen === "pipeline" && osFunnel(S.route.parts[0])) screens.pipeline._redraw?.();
});
