// Unicorn OS — every rule the Copilot runs, in plain words, with its real switch; autopilot as a stage ladder.
import { S, api, esc, I, screens, on, toast, fail, isStaff, money, dialog, confirmBox } from "./core.js";

const GROUPS = ["Rental clients", "Villa owners (Rental Listings)", "Sales", "Everyone", "Safety"];

function ladder(rule) {
  const stages = rule.options || [];
  const s = rule.value || {};
  if (!stages.length) return "";
  const upTo = s.upToStageName;
  const idx = upTo ? stages.findIndex((x) => x.toLowerCase() === String(upTo).toLowerCase()) : -1;
  return `<div class="ladder">${stages
    .map((name, i) => {
      const cls = s.mode !== "off" && idx >= 0 && i < idx ? "bot" : i === idx && s.mode !== "off" ? "hand" : "";
      return `<span class="${cls}" title="${cls === "bot" ? "The bot sends on its own here" : cls === "hand" ? "From here the broker approves" : "The broker approves"}">${esc(name)}</span>`;
    })
    .join("")}</div>
    <div class="faint" style="font-size:11.5px">${s.mode === "off" ? "Off: every draft waits for the broker." : `${s.mode === "dry" ? "Dry run: logs what it would send, sends nothing. " : ""}The bot sends by itself in the green stages; from <b>${esc(upTo || "—")}</b> on, the broker approves.`}</div>`;
}

function switchHtml(r) {
  if (!r.switch) return `<span class="owner ${r.owner}" style="margin-left:auto">${r.owner === "code" ? "runs by rule" : r.owner === "site" ? "site switch" : "person decides"}</span>`;
  const dis = r.editable ? "" : "disabled";
  if (r.switch.kind === "autopilot") {
    const m = r.value?.mode || "off";
    return `<div class="toggle">${["on", "dry", "off"].map((x) => `<button ${dis} class="${m === x ? x : ""}" data-ap="${r.id}" data-mode="${x}">${x}</button>`).join("")}</div>`;
  }
  if (r.switch.kind === "budget") {
    const v = r.value || {};
    return `<div class="toggle">${["on", "off"].map((x) => `<button ${dis} class="${(v.enabled ? "on" : "off") === x ? x : ""}" data-budget="${r.id}" data-on="${x}">${x}</button>`).join("")}</div>`;
  }
  const v = String(r.value ?? "");
  return `<div class="toggle">${(r.options || []).map((x) => `<button ${dis} class="${v === x ? x : ""}" data-set="${r.id}" data-v="${esc(x)}">${esc(x)}</button>`).join("")}</div>`;
}

screens.automations = {
  title: "Automations",
  async render({ el, tools }) {
    tools.innerHTML = `<button class="btn sm ghost" id="au-refresh">Refresh</button>`;
    tools.querySelector("#au-refresh").onclick = () => screens.automations.render({ el, tools });
    el.innerHTML = `<div class="loading">Reading the switches…</div>`;
    const r = await api("/automations");
    const staff = isStaff();
    const byGroup = {};
    for (const x of r.rules) (byGroup[x.group] = byGroup[x.group] || []).push(x);
    el.innerHTML = `<div class="page"><h1 class="pt">Automations</h1>
      <p class="pd">Everything the system does on its own, in plain words: what starts it, what it does, who hears about it. The switches are the real ones the Copilot reads${staff ? "" : " (only the owner and managers can change them)"}. "Dry" logs what it would do without doing it.</p>
      ${GROUPS.filter((g) => byGroup[g])
        .map(
          (g) => `<h3 style="font-size:13px;margin:18px 0 8px">${esc(g)}</h3><div class="auto-grid">${byGroup[g]
            .map(
              (x) => `<div class="rule"><div class="rh"><b>${esc(x.name)}</b>${switchHtml(x)}</div>
              <div class="rd"><b>When</b> ${esc(x.when)}<br><b>Then</b> ${esc(x.does)}<br><b>Who hears</b> ${esc(x.notifies)}</div>
              ${x.switch?.kind === "autopilot" ? ladder(x) + (x.editable ? `<div class="row"><button class="btn sm" data-ap-stage="${x.id}">Set the stage it stops before</button><button class="btn sm ghost" data-ready="${esc(x.switch.pipeline)}">Readiness per situation</button></div>` : "") : ""}
              ${x.switch?.kind === "budget" ? `<div class="faint" style="font-size:11.5px">Threshold: ${money(x.value?.minMonthlyIdr)} / month${x.editable ? ` · <a href="#" data-budget-edit="${x.id}">change</a>` : ""}</div>` : ""}
            </div>`,
            )
            .join("")}</div>`,
        )
        .join("")}</div>`;

    const post = async (id, body, msg) => {
      // These are the Copilot's live switches: the same ones amoCRM work runs on today.
      const x = r.rules.find((y) => y.id === id);
      if (!(await confirmBox("Change a live switch?", `${x ? x.name : id}: this changes how the Copilot works right now, for amoCRM too — not only in Unicorn OS.`, "Change it"))) return;
      try {
        await api(`/automations/${id}`, { body });
        toast(msg);
        screens.automations.render({ el, tools });
      } catch (e) {
        fail(e);
      }
    };
    const pickStage = async (x, mode) => {
      const res = await dialog({
        title: `${x.name}: where does the bot stop?`,
        body: `<p class="muted" style="margin:0 0 8px">The bot sends by itself in every stage BEFORE the one you pick; from that stage on the broker approves each message.</p>
          <label class="fld"><span>Hand over to the broker at</span><select class="in" name="stage">${(x.options || []).map((s) => `<option ${s === x.value?.upToStageName ? "selected" : ""}>${esc(s)}</option>`).join("")}</select></label>
          <label class="fld" style="margin-top:8px"><span>Mode</span><select class="in" name="mode">${["on", "dry"].map((m) => `<option ${m === (mode || x.value?.mode) ? "selected" : ""}>${m}</option>`).join("")}</select></label>`,
        actions: [{ label: "Cancel", value: null }, { label: "Save", value: "ok", primary: true }],
      });
      if (!res) return;
      await post(x.id, { mode: res.values.mode, upToStageName: res.values.stage }, `${x.name}: ${res.values.mode}, broker from ${res.values.stage}`);
    };
    on(el, "click", "[data-ap]", async (e, b) => {
      const x = r.rules.find((y) => y.id === b.dataset.ap);
      const mode = b.dataset.mode;
      if (mode === "off") return post(x.id, { mode: "off" }, `${x.name}: off`);
      if (!x.value?.upToStageName) return pickStage(x, mode);
      return post(x.id, { mode, upToStageName: x.value.upToStageName }, `${x.name}: ${mode}`);
    });
    on(el, "click", "[data-ap-stage]", (e, b) => pickStage(r.rules.find((y) => y.id === b.dataset.apStage)));
    on(el, "click", "[data-set]", (e, b) => post(b.dataset.set, { value: b.dataset.v }, `Set to ${b.dataset.v}`));
    on(el, "click", "[data-budget]", (e, b) => {
      const x = r.rules.find((y) => y.id === b.dataset.budget);
      post(x.id, { enabled: b.dataset.on === "on", minMonthlyIdr: x.value?.minMonthlyIdr || 30000000 }, `Budget gate ${b.dataset.on}`);
    });
    on(el, "click", "[data-budget-edit]", async (e, a) => {
      e.preventDefault();
      const x = r.rules.find((y) => y.id === a.dataset.budgetEdit);
      const res = await dialog({
        title: "Budget gate threshold",
        body: `<label class="fld"><span>Close Rental leads below (IDR per month)</span><input class="in" type="number" name="min" value="${x.value?.minMonthlyIdr || 30000000}" step="1000000"></label>`,
        actions: [{ label: "Cancel", value: null }, { label: "Save", value: "ok", primary: true }],
      });
      if (res) post(x.id, { enabled: !!x.value?.enabled, minMonthlyIdr: Number(res.values.min) }, "Threshold saved");
    });
    on(el, "click", "[data-ready]", async (e, b) => {
      const pipe = b.dataset.ready;
      const brokers = S.meta.brokers.length ? S.meta.brokers : [S.user.brokerKey];
      const rows = await Promise.all(brokers.map((br) => api(`/p/autopilot-readiness?broker=${encodeURIComponent(br)}&pipeline=${encodeURIComponent(pipe)}`).then((x) => ({ br, x })).catch(() => ({ br, x: null }))));
      const body = rows
        .filter((r2) => r2.x)
        .map(
          ({ br, x }) => `<div class="sect-h">${esc(br)}</div><div class="tbl-wrap" style="max-height:none"><table class="grid"><thead><tr><th>Situation</th><th>Drafts (14 d)</th><th>Sent untouched</th><th>Before</th><th>Verdict</th></tr></thead><tbody>${(x.situations || [])
            .map((s) => `<tr><td>${esc(s.situation)}</td><td class="num">${s.decided ?? ""}</td><td class="num">${s.cleanRatePct ?? "—"}%</td><td class="num">${s.prevCleanRatePct ?? "—"}${s.prevCleanRatePct != null ? "%" : ""}</td><td>${esc(s.readiness || s.status || "")}</td></tr>`)
            .join("")}</tbody></table></div>`,
        )
        .join("");
      await dialog({ title: `Autopilot readiness · ${pipe}`, body: body || `<p class="muted">No readiness data.</p>`, wide: true, actions: [{ label: "Close", value: null }] });
    });
  },
};
