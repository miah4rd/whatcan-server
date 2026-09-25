// Unicorn OS — automations, funnel by funnel (owner, 26.09).
// A funnel is a list of stages. For each: what moves a card into it and who owns that move,
// the autopilot line (the bot sends on its own above it, people approve below), and how ready
// the stage is to be handed over (the share of drafts sent exactly as written). The other rules
// of the funnel follow; rules that belong to no funnel sit under General.
import { S, api, esc, I, screens, on, toast, fail, isStaff, money, dialog, confirmBox, store, rel } from "./core.js";

const FUNNELS = [
  ["rental", "Rental clients", "Rental clients"],
  ["rental-listings", "Rental listings", "Villa owners (Rental Listings)"],
  ["unicorn", "Sales", "Sales"],
];
const GENERAL_GROUPS = ["Everyone", "Safety"];
const OWNER = {
  copilot: ["Copilot reads the chat", "code"],
  rule: ["Rule in code", "site"],
  person: ["Only a person", "person"],
  workflow: ["Working stage", ""],
};

function switchHtml(r) {
  if (!r.switch) return `<span class="owner ${r.owner}" style="margin-left:auto">${r.owner === "code" ? "runs by rule" : r.owner === "site" ? "site switch" : "person decides"}</span>`;
  const dis = r.editable ? "" : "disabled";
  if (r.switch.kind === "budget") {
    const v = r.value || {};
    return `<div class="toggle">${["on", "off"].map((x) => `<button ${dis} class="${(v.enabled ? "on" : "off") === x ? x : ""}" data-budget="${r.id}" data-on="${x}">${x}</button>`).join("")}</div>`;
  }
  const v = String(r.value ?? "");
  return `<div class="toggle">${(r.options || []).map((x) => `<button ${dis} class="${v === x ? x : ""}" data-set="${r.id}" data-v="${esc(x)}">${esc(x)}</button>`).join("")}</div>`;
}
function ruleCard(x) {
  return `<div class="rule"><div class="rh"><b>${esc(x.name)}</b>${switchHtml(x)}</div>
    <div class="rd"><b>When</b> ${esc(x.when)}<br><b>Then</b> ${esc(x.does)}<br><b>Who hears</b> ${esc(x.notifies)}</div>
    ${x.switch?.kind === "budget" ? `<div class="faint" style="font-size:11.5px">Threshold: ${money(x.value?.minMonthlyIdr)} / month${x.editable ? ` · <a href="#" data-budget-edit="${x.id}">change</a>` : ""}</div>` : ""}</div>`;
}

function readinessHtml(d) {
  const decided = d.asWritten + d.edited + d.skipped;
  if (!d.total) return `<span class="faint">no drafts at this stage in 30 days</span>`;
  const r = d.readiness;
  const cls = r == null ? "" : r >= 85 && decided >= 20 ? "ok" : r >= 60 ? "warn" : "bad";
  return `<div class="ready"><div class="rbar"><i class="w" style="width:${decided ? (d.asWritten / decided) * 100 : 0}%"></i><i class="e" style="width:${decided ? (d.edited / decided) * 100 : 0}%"></i><i class="s" style="width:${decided ? (d.skipped / decided) * 100 : 0}%"></i></div>
    <span>${r == null ? `<span class="faint">too few decided</span>` : `<span class="pill ${cls}">${r}% as written</span>`} <span class="faint">${d.total} drafts · ${d.asWritten} sent as written · ${d.edited} edited · ${d.skipped} skipped${d.auto ? ` · ${d.auto} by autopilot` : ""}</span></span></div>`;
}

screens.automations = {
  title: "Automations",
  async render({ el, tools, route }) {
    const staff = isStaff();
    const tab = [...FUNNELS.map((f) => f[0]), "general"].includes(route.parts[0]) ? route.parts[0] : store.get("au-tab", "rental");
    store.set("au-tab", tab);
    tools.innerHTML = `<div class="views">${FUNNELS.map(([k, l]) => `<button data-au="${k}" class="${k === tab ? "active" : ""}">${esc(l)}</button>`).join("")}<button data-au="general" class="${tab === "general" ? "active" : ""}">General</button></div><button class="btn sm ghost" id="au-refresh">Refresh</button>`;
    on(tools, "click", "[data-au]", (e, b) => (location.hash = `#/automations/${b.dataset.au}`));
    tools.querySelector("#au-refresh").onclick = () => screens.automations.render({ el, tools, route });
    el.innerHTML = `<div class="loading">Reading the switches…</div>`;
    const redraw = () => screens.automations.render({ el, tools, route: S.route });
    const [all, map] = await Promise.all([api("/automations"), tab === "general" ? Promise.resolve(null) : api(`/automations/map?funnel=${tab}`)]);
    const fun = FUNNELS.find((f) => f[0] === tab);
    const others = all.rules.filter((x) => (tab === "general" ? GENERAL_GROUPS.includes(x.group) : x.group === fun[2]) && x.switch?.kind !== "autopilot");

    if (!map) {
      el.innerHTML = `<div class="page"><h1 class="pt">General</h1><p class="pd">Rules that belong to no single funnel. The switches are the live ones the Copilot reads${staff ? "" : " (only the owner and managers can change them)"}.</p><div class="auto-grid">${others.map(ruleCard).join("")}</div></div>`;
    } else {
      const ap = map.autopilot;
      const lineAt = ap.mode !== "off" && ap.upToStageName ? map.stages.findIndex((s) => s.name.toLowerCase() === ap.upToStageName.toLowerCase()) : -1;
      const stageRow = (s, i) => {
        const [ownLabel, ownCls] = OWNER[s.owner] || ["", ""];
        const line = i === lineAt ? `<div class="apline"><span>${ap.mode === "dry" ? "Dry run above: logged, not sent" : "Autopilot sends above"} · people approve from here</span></div>` : "";
        const mode = s.owner === "person" ? `<span class="mode person">Person</span>` : s.autopilot === "autopilot" ? `<span class="mode bot">Autopilot</span>` : s.autopilot === "dry" ? `<span class="mode dry">Dry run</span>` : `<span class="mode people">People approve</span>`;
        return `${line}<div class="stage-row" data-stage="${esc(s.name)}">
          <div class="sl">${mode}</div>
          <div class="sm2"><div class="sn"><b>${esc(s.name)}</b><span class="owner ${ownCls}">${esc(ownLabel)}</span><span class="faint">${s.cardsNow} cards now · into it in 7 days: ${s.movesIn7d.bot} by the bot, ${s.movesIn7d.people} by people</span></div>
            <div class="how"><span class="faint">What moves a card here:</span> ${esc(s.howItGetsHere)}${s.edited ? ` <span class="pill warn" title="rewritten in Unicorn OS">edited by ${esc(s.edited.by || "")} ${esc(rel(s.edited.at))}</span>` : ""}</div>
            ${s.builtIn ? `<div class="how faint">${esc(s.builtIn)}</div>` : ""}
            ${s.owner !== "person" ? readinessHtml(s.drafts30d) : ""}</div>
          <div class="sa">${staff && s.editable ? `<button class="btn sm" data-edit-rule="${esc(s.name)}">Edit what moves it</button>` : ""}${
            staff && s.owner !== "person" && i > 0 ? `<button class="btn sm ghost" data-line="${esc(s.name)}" title="The autopilot sends on its own in every stage above this one">Autopilot up to here</button>` : ""
          }</div></div>`;
      };
      el.innerHTML = `<div class="page"><h1 class="pt">${esc(fun[1])}</h1>
        <p class="pd">Each stage: what moves a card into it and who owns that move, and how ready it is for the autopilot. People start every stage in the Copilot, approving drafts; the fewer edits a stage needs, the sooner it can go to the autopilot. The autopilot writes the same way the Copilot learned from those approvals; it just does not wait for the button.</p>
        <div class="panel ap-panel"><h3>Autopilot <span class="row" style="gap:8px"><div class="toggle">${["on", "dry", "off"].map((x) => `<button ${staff ? "" : "disabled"} class="${ap.mode === x ? x : ""}" data-apmode="${x}">${x}</button>`).join("")}</div><span class="faint">up to ${ap.dailyCap} sends a day</span></span></h3>
          <p class="faint" style="margin:0;font-size:12px">${ap.mode === "off" ? "Off: people approve every draft in every stage." : `${ap.mode === "dry" ? "Dry run: it logs what it would send and sends nothing. " : ""}The line is before <b>${esc(ap.upToStageName || "—")}</b>: above it the bot sends on its own, from it on people approve.`} Use “Autopilot up to here” on a stage to move the line.</p></div>
        <div class="stage-map">${map.stages.map(stageRow).join("")}</div>
        <p class="faint" style="font-size:11.5px">“As written” counts drafts of the last 30 days, by the stage the card was in when the draft was written. A stage is ready for the autopilot at 85% or more, from 20 decided drafts. A rewritten description is what the Copilot reads from now on; rules in code and person-only stages are shown as they are.</p>
        ${others.length ? `<h3 style="font-size:13px;margin:18px 0 8px">Other automations in this funnel</h3><div class="auto-grid">${others.map(ruleCard).join("")}</div>` : ""}</div>`;
    }

    const live = async (title, fn, msg) => {
      if (!(await confirmBox("Change a live switch?", `${title}: this changes how the Copilot works right now, for amoCRM too, not only in Unicorn OS.`, "Change it"))) return;
      try {
        await fn();
        toast(msg);
        redraw();
      } catch (e) {
        fail(e);
      }
    };
    if (map) {
      const ap = map.autopilot;
      on(el, "click", "[data-apmode]", async (e, b) => {
        const mode = b.dataset.apmode;
        let upTo = ap.upToStageName;
        if (mode !== "off" && !upTo) {
          toast("Pick the line first: “Autopilot up to here” on the stage where people take over.", { bad: true });
          return;
        }
        live(`Autopilot · ${map.funnel}`, () => api("/automations/autopilot", { body: { funnel: map.funnel, mode, upToStageName: upTo, dailyCap: ap.dailyCap } }), `Autopilot ${mode}`);
      });
      on(el, "click", "[data-line]", (e, b) => {
        const stage = b.dataset.line;
        const mode = ap.mode === "off" ? "dry" : ap.mode;
        live(
          `Autopilot up to ${stage}`,
          () => api("/automations/autopilot", { body: { funnel: map.funnel, mode, upToStageName: stage, dailyCap: ap.dailyCap } }),
          ap.mode === "off" ? `Line set before ${stage}; the autopilot starts in dry run` : `People approve from ${stage} on`,
        );
      });
      on(el, "click", "[data-edit-rule]", async (e, b) => {
        const s = map.stages.find((x) => x.name === b.dataset.editRule);
        const res = await dialog({
          title: `What moves a card to “${s.name}”`,
          wide: true,
          body: `<p class="muted" style="margin:0 0 8px">The Copilot reads this when it decides where a conversation stands. Say what must have happened in the chat, and what is not enough.</p>
            <textarea class="in" name="meaning" rows="6">${esc(s.howItGetsHere)}</textarea>
            ${s.edited ? `<p class="faint" style="font-size:12px;margin:8px 0 0">Empty it to go back to the built-in description.</p>` : ""}`,
          actions: [{ label: "Cancel", value: null }, ...(s.edited ? [{ label: "Back to built-in", value: "reset" }] : []), { label: "Save", value: "ok", primary: true }],
        });
        if (!res) return;
        const meaning = res.action === "reset" ? "" : res.values.meaning;
        live(`The description of ${s.name}`, () => api("/automations/stage-rule", { body: { funnel: map.funnel, stage: s.name, meaning } }), meaning ? "The Copilot reads the new description from now on" : "Back to the built-in description");
      });
    }
    on(el, "click", "[data-set]", (e, b) => live(b.dataset.set, () => api(`/automations/${b.dataset.set}`, { body: { value: b.dataset.v } }), `Set to ${b.dataset.v}`));
    on(el, "click", "[data-budget]", (e, b) => {
      const x = all.rules.find((y) => y.id === b.dataset.budget);
      live(x.name, () => api(`/automations/${x.id}`, { body: { enabled: b.dataset.on === "on", minMonthlyIdr: x.value?.minMonthlyIdr || 30000000 } }), `Budget gate ${b.dataset.on}`);
    });
    on(el, "click", "[data-budget-edit]", async (e, a) => {
      e.preventDefault();
      const x = all.rules.find((y) => y.id === a.dataset.budgetEdit);
      const res = await dialog({
        title: "Budget gate threshold",
        body: `<label class="fld"><span>Close Rental leads below (IDR per month)</span><input class="in" type="number" name="min" value="${x.value?.minMonthlyIdr || 30000000}" step="1000000"></label>`,
        actions: [{ label: "Cancel", value: null }, { label: "Save", value: "ok", primary: true }],
      });
      if (res) live(x.name, () => api(`/automations/${x.id}`, { body: { enabled: !!x.value?.enabled, minMonthlyIdr: Number(res.values.min) } }), "Threshold saved");
    });
  },
};
