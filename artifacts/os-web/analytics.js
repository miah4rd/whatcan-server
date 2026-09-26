// Unicorn OS — Analytics (owner, 26.09): one page per funnel, read top to bottom in a minute.
//   Today — red flags as of now.
//   1. Targets — what we want: per person and the team, any period.
//   2. Work done — inflow and its cost, every stage (who works it, reached, conversion, messages,
//      cards now, stuck), the bot and the people, each broker's Copilot work and reports.
//   3. Bottlenecks — why the target is missed: the client's (owner's) side, our side, the inflow.
// The numbers come from /analytics/funnel-report (lib/os/funnel-report.ts); nothing is changed here
// except targets, by the owner and managers.
import { S, api, esc, I, screens, on, toast, fail, dialog, isStaff, money, store, fmtDT, emit } from "./core.js";

const FUNNELS = [
  ["rental", "Rental clients"],
  ["rental-listings", "Rental listings"],
  ["unicorn", "Sales"],
];
const PERIODS = [
  ["day", "Day"],
  ["week", "Week"],
  ["month", "Month"],
  ["quarter", "Quarter"],
  ["half", "Half-year"],
  ["year", "Year"],
];
const TARGET_PERIODS = ["week", "month", "quarter", "half", "year"];
const WORKED_BY = { autopilot: ["Autopilot", "bot"], copilot: ["Copilot + person", "cp"], person: ["Person", "ppl"], rule: ["Rule", "bot"], workflow: ["Working stage", ""] };

const baliToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400e3).toISOString().slice(0, 10);
function shift(period, day, dir) {
  const [y, m] = day.split("-").map(Number);
  const iso = (Y, M) => new Date(Date.UTC(Y, M - 1, 1)).toISOString().slice(0, 10);
  if (period === "day") return addDays(day, dir);
  if (period === "week") return addDays(day, 7 * dir);
  if (period === "month") return iso(y, m + dir);
  if (period === "quarter") return iso(y, m + 3 * dir);
  if (period === "half") return iso(y, m + 6 * dir);
  return iso(y + dir, m);
}
const mins = (m) => (m == null ? "—" : m < 60 ? `${m} min` : m < 1440 ? `${(m / 60).toFixed(1)} h` : `${(m / 1440).toFixed(1)} d`);
const dash = (v) => (v == null || v === "" ? "—" : v);
const delta = (v, p) => (p == null || v === p ? "" : `<span class="an-d ${v > p ? "up" : "down"}">${v > p ? "▲" : "▼"} ${Math.abs(v - p)}</span>`);

screens.analytics = {
  title: "Analytics",
  async render({ el, tools, route }) {
    const funnel = FUNNELS.some((f) => f[0] === route.parts[0]) ? route.parts[0] : store.get("an-funnel", "rental");
    store.set("an-funnel", funnel);
    const period = PERIODS.some((p) => p[0] === route.q.period) ? route.q.period : store.get("an-period", "week");
    store.set("an-period", period);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(route.q.date || "") ? route.q.date : baliToday();
    const who = isStaff() ? route.q.who || "team" : "me";
    const go = (patch) => {
      const qs = new URLSearchParams({ period, date, who: isStaff() ? who : "", ...patch });
      for (const [k, v] of [...qs]) if (!v) qs.delete(k);
      location.hash = `#/analytics/${patch.funnel || funnel}?${qs}`;
    };
    tools.innerHTML = `<div class="views">${FUNNELS.map(([k, l]) => `<button data-an-f="${k}" class="${k === funnel ? "active" : ""}">${l}</button>`).join("")}</div>
      <select class="chip" id="an-period">${PERIODS.map(([k, l]) => `<option value="${k}" ${k === period ? "selected" : ""}>${l}</option>`).join("")}</select>
      <button class="iconbtn" id="an-prev" title="Earlier">${I.left}</button><button class="iconbtn" id="an-next" title="Later">${I.right}</button>
      ${isStaff() ? `<select class="chip" id="an-who"><option value="team">Team and everyone</option></select>` : ""}`;
    on(tools, "click", "[data-an-f]", (e, b) => go({ funnel: b.dataset.anF }));
    tools.querySelector("#an-period").onchange = (e) => go({ period: e.target.value });
    tools.querySelector("#an-prev").onclick = () => go({ date: shift(period, date, -1) });
    tools.querySelector("#an-next").onclick = () => go({ date: shift(period, date, 1) });
    el.innerHTML = `<div class="loading">Counting ${esc(FUNNELS.find((f) => f[0] === funnel)[1])}…</div>`;
    let d;
    try {
      d = await api(`/analytics/funnel-report?funnel=${funnel}&period=${period}&date=${date}${who !== "team" && who !== "me" ? `&who=${encodeURIComponent(who)}` : ""}`);
    } catch (e) {
      el.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
      return;
    }
    const whoSel = tools.querySelector("#an-who");
    if (whoSel) {
      whoSel.innerHTML += d.people.map((p) => `<option ${p.toLowerCase() === String(who).toLowerCase() ? "selected" : ""}>${esc(p)}</option>`).join("");
      whoSel.onchange = (e) => go({ who: e.target.value });
    }
    el.innerHTML = `<div class="page an">
      <div class="an-range faint">${esc(label(d))}${d.who !== "team" ? ` · ${esc(d.who)}` : ""}</div>
      ${flagsHtml(d)}
      ${targetsHtml(d)}
      ${workHtml(d)}
      ${bottlenecksHtml(d)}
    </div>`;
    on(el, "click", "[data-lead]", (e, a) => (e.preventDefault(), emit("open-peek", { type: "lead", id: a.dataset.lead })));
    const setBtn = el.querySelector("#an-set-targets");
    if (setBtn) setBtn.onclick = () => setTargets(d, funnel, period, date);
  },
};

function label(d) {
  const f = new Date(d.from + "T00:00:00Z");
  const t = new Date(Date.parse(d.to + "T00:00:00Z") - 86400e3);
  const o = { day: "numeric", month: "short", timeZone: "UTC" };
  return d.period === "day" ? f.toLocaleDateString("en-GB", { ...o, weekday: "short" }) : `${f.toLocaleDateString("en-GB", o)} – ${t.toLocaleDateString("en-GB", { ...o, year: "numeric" })}`;
}

// ── Today: tiles, one per kind of problem, the number first ──
function flagsHtml(d) {
  // Behind-the-pace targets show in chapter 1 as cards; the tiles are what needs a hand now.
  const now = d.flags.filter((x) => !/behind the pace/.test(x.text));
  if (!now.length) return `<div class="an-today ok">${I.check}<span><b>Today</b> · all in order: no missing reports, nobody waiting over 4 hours.</span></div>`;
  const tiles = [];
  const reports = now.filter((x) => x.leadId);
  if (reports.length)
    tiles.push(`<div class="an-tile red"><b>${reports.length}</b><span>${d.funnel === "rental-listings" ? "inspection" : "viewing"} report${reports.length === 1 ? "" : "s"} not filed</span><ul>${reports
      .map((x) => `<li><a href="#" data-lead="${esc(x.leadId)}">${esc(x.text.replace(/^.*? for /, "").replace(/ \(.*$/, ""))}</a> <span class="faint">${esc(x.who || "")}</span></li>`)
      .join("")}</ul></div>`);
  for (const x of now.filter((x) => !x.leadId)) {
    const m = x.text.match(/^(\d+) clients? waiting over 4 hours for (.+)$/);
    if (m) tiles.push(`<div class="an-tile ${x.level === "red" ? "red" : "amber"}"><b>${m[1]}</b><span>waiting over 4 h</span><em>${esc(m[2])}</em></div>`);
    else tiles.push(`<div class="an-tile amber"><span>${esc(x.text)}</span></div>`);
  }
  return `<div class="an-today-h"><b>Today</b> <span class="faint">${now.length} to look at</span></div><div class="an-tiles">${tiles.join("")}</div>`;
}

// ── 1. Targets: a card per person and the team; each target a bar with where it should be by now ──
function elapsedShare(d) {
  const from = Date.parse(d.from + "T00:00:00+08:00");
  const to = Date.parse(d.to + "T00:00:00+08:00");
  return Math.min(1, Math.max(0, (Date.now() - from) / (to - from)));
}
function targetBar(label, v, t, prev, pace) {
  const goal = t.value;
  const share = goal > 0 ? v / goal : 0;
  const status = share >= 1 ? "done" : share >= pace * 0.85 ? "ok" : share >= pace * 0.6 ? "warn" : "bad";
  const word = { done: "done", ok: "on pace", warn: "a little behind", bad: "behind" }[status];
  return `<div class="tb ${status}"><div class="tb-top"><span>${esc(label)}</span><span class="tb-st">${word}</span></div>
    <div class="tb-num"><b>${v}</b><span>/ ${goal}${t.implied ? `<span class="faint" title="scaled from the weekly target"> ~</span>` : t.summed ? `<span class="faint" title="the sum of the people's targets"> Σ</span>` : ""}</span>${prev != null ? `<small class="faint">last ${prev}</small>` : ""}</div>
    <div class="tb-bar"><i style="width:${Math.min(100, Math.round(share * 100))}%"></i><em style="left:${Math.round(pace * 100)}%" title="where it should be by now"></em></div></div>`;
}
function targetsHtml(d) {
  const sc = d.targets;
  const pace = d.period === "day" ? 1 : elapsedShare(d);
  const working = new Set(d.brokers.map((b) => b.name.toLowerCase()));
  const people = sc.people.filter((p) => (d.who === "team" ? working.has(p.name.toLowerCase()) || Object.keys(p.targets).length : p.name.toLowerCase() === d.who));
  const tmetrics = sc.metrics.filter((m) => m.target);
  const card = (name, values, targets, team) => {
    const bars = tmetrics.filter((m) => targets[m.key] && targets[m.key].value > 0).map((m) => targetBar(m.label, values[m.key]?.v ?? 0, targets[m.key], values[m.key]?.prev, pace));
    return `<div class="tc ${team ? "team" : ""}"><div class="tc-h">${esc(name)}</div>${bars.join("") || `<p class="faint" style="margin:0;font-size:12px">No target set.</p>`}</div>`;
  };
  // A card for everyone with a target, and the team; the rest are named in one line to set theirs.
  const hasTarget = (t) => tmetrics.some((m) => t[m.key] && t[m.key].value > 0);
  const without = people.filter((p) => !hasTarget(p.targets));
  const cards = [...people.filter((p) => hasTarget(p.targets)).map((p) => card(p.name, p.values, p.targets, false)), d.who === "team" ? card("Team (manager)", sc.team.values, sc.team.targets, true) : ""].join("") +
    (without.length ? `<div class="tc none"><span class="faint">No target: ${without.map((p) => esc(p.name)).join(", ")}</span></div>` : "");
  const head = `<tr><th>Metric</th>${people.map((p) => `<th class="r">${esc(p.name)}</th>`).join("")}${d.who === "team" ? `<th class="r">Team</th>` : ""}</tr>`;
  const body = sc.metrics
    .map((m) => `<tr><td>${esc(m.label)}</td>${people.map((p) => `<td class="r">${p.values[m.key]?.v ?? 0}${delta(p.values[m.key]?.v ?? 0, p.values[m.key]?.prev)}</td>`).join("")}${d.who === "team" ? `<td class="r">${sc.team.values[m.key]?.v ?? 0}${delta(sc.team.values[m.key]?.v ?? 0, sc.team.values[m.key]?.prev)}</td>` : ""}</tr>`)
    .join("");
  return `<section class="panel an-ch"><h2><span class="an-n">1</span>Targets <span class="faint">what we want · ${Math.round(pace * 100)}% of the period gone</span>${isStaff() ? `<button class="btn sm" id="an-set-targets" style="margin-left:auto">Edit targets</button>` : ""}</h2>
    <div class="tcs">${cards}</div>
    <details class="an-more"><summary>Every number of the funnel, by person</summary><div class="an-scroll"><table class="grid an-t">${head}${body}</table></div></details>
    <p class="faint an-note">Counted from the conversations and reports, not from stage moves. The mark on a bar is where it should be by now. A weekly target repeats every week until it is changed.</p></section>`;
}

async function setTargets(d, funnel, period, date) {
  const sc = d.targets;
  const per = TARGET_PERIODS.includes(period) ? period : "week";
  const metrics = sc.metrics.filter((m) => m.target);
  const who = [...sc.people.map((p) => [p.name.toLowerCase(), p.name, p.targets]), ["team", "Team (manager)", sc.team.targets]];
  const r = await dialog({
    title: "Edit targets",
    wide: true,
    body: `<label class="fld" style="max-width:220px"><span>For each</span><select class="in" name="period">${TARGET_PERIODS.map((p) => `<option ${p === per ? "selected" : ""} value="${p}">${PERIODS.find((x) => x[0] === p)[1]}</option>`).join("")}</select></label>
      <p class="faint" style="font-size:12px;margin:8px 0">A target repeats every period (every week for a weekly one) until you change it here; a change applies from the period that holds ${esc(date)}. Empty = no target. The team's target, if empty, is the sum of its people's.</p>
      <div class="an-scroll"><table class="grid an-t"><tr><th>Who</th>${metrics.map((m) => `<th>${esc(m.label)}</th>`).join("")}</tr>${who
        .map(([k, name, t]) => `<tr><td>${esc(name)}</td>${metrics.map((m) => `<td><input class="in an-in" type="number" min="0" step="1" name="t:${esc(k)}:${m.key}" value="${t[m.key] && !t[m.key].implied && !t[m.key].summed ? t[m.key].value : ""}"></td>`).join("")}</tr>`)
        .join("")}</table></div>`,
    actions: [{ label: "Cancel", value: null }, { label: "Save", value: "ok", primary: true }],
  });
  if (!r) return;
  try {
    for (const [k, v] of Object.entries(r.values)) {
      if (!k.startsWith("t:")) continue;
      const [, whoKey, metric] = k.split(":");
      const before = (whoKey === "team" ? sc.team.targets : sc.people.find((p) => p.name.toLowerCase() === whoKey)?.targets || {})[metric];
      const had = before && !before.implied && !before.summed ? String(before.value) : "";
      if (String(v) === had) continue;
      await api("/analytics/team-targets", { body: { funnel, metric, who: whoKey, value: v === "" ? null : Number(v), from: date, period: r.values.period } });
    }
    toast("Targets saved");
    screens.analytics.render({ el: document.getElementById("content"), tools: document.getElementById("tools"), route: S.route });
  } catch (e) {
    fail(e);
  }
}

// ── 2. Work done ──
function workHtml(d) {
  const w = d.work;
  const inf = w.inflow;
  const newDelta = inf.prevNewCards ? Math.round(((inf.newCards - inf.prevNewCards) / inf.prevNewCards) * 100) : null;
  const sources = inf.sources.map((s) => `${esc(s.label)} <b>${s.n}</b>`).join(" · ") || "—";
  const spend = inf.spend
    ? `Meta spend <b>${money(inf.spend.amount)}</b>${inf.spend.perPaidLead ? ` · per paid lead <b>${money(inf.spend.perPaidLead)}</b>` : ""}${inf.spend.perCard ? ` · per new card <b>${money(inf.spend.perCard)}</b>` : ""} <span class="faint">(${esc(inf.spend.campaigns.join(", "))})</span>`
    : `<span class="faint">No ad spend on this funnel in the period.</span>`;
  const kpis = [
    ["New cards", inf.newCards, newDelta == null ? "" : `${newDelta > 0 ? "+" : ""}${newDelta}% vs before`],
    ["Sent by the autopilot", w.autopilot, ""],
    ["Approved in the Copilot", w.approvedInCopilot, ""],
    ["Typed on the phone", w.typedOnPhone, ""],
    ["Bot's share of messages", w.botShare == null ? "—" : `${w.botShare}%`, `~${w.hoursSaved} h saved`],
    ["In the queue now", w.queue.live + w.queue.push, `${w.queue.live} live · ${w.queue.push} push`],
  ];
  const stageRows = w.stages
    .map((s) => {
      const [wl, wc] = WORKED_BY[s.workedBy] || [s.workedBy, ""];
      return `<tr><td>${esc(s.name)}</td><td><span class="an-tag ${wc}">${esc(wl)}</span></td><td class="r">${s.reached || "—"}</td><td class="r">${s.conv == null ? "—" : s.conv + "%"}</td><td class="r">${s.sent || "—"}${s.sentByAutopilot ? ` <span class="faint">(${s.sentByAutopilot} bot)</span>` : ""}</td><td class="r">${s.now || "—"}</td><td class="r ${s.stuck ? "bad" : ""}">${s.stuck || "—"}</td></tr>`;
    })
    .join("");
  const rep = d.work.stages && d.funnel === "rental-listings" ? "Inspection reports" : d.funnel === "rental" ? "Viewing reports" : null;
  const bRows = d.brokers
    .map(
      (b) => `<tr class="${b.name === "Team" ? "tm" : ""}"><td>${esc(b.name)}</td><td class="r">${b.sentByPerson || "—"}</td><td class="r">${b.autopilotSent || "—"}</td><td class="r">${mins(b.replyMin)}</td><td class="r">${mins(b.approveMin)}</td><td class="r">${b.draftsDecided ? `${dash(b.asWrittenPct)}% <span class="faint">of ${b.draftsDecided}</span>` : "—"}</td><td class="r ${b.overdueTasks ? "bad" : ""}">${b.overdueTasks || "—"}</td>${
        rep ? `<td class="r">${b.reports.planned ? `${b.reports.filed}/${b.reports.planned}${b.reports.late ? ` <span class="faint">${b.reports.late} late</span>` : ""}` : "—"}</td><td class="r ${b.reports.missing ? "bad" : ""}">${b.reports.missing || "—"}</td>` : ""
      }</tr>`,
    )
    .join("");
  return `<section class="panel an-ch"><h2><span class="an-n">2</span>Work done <span class="faint">what happened</span></h2>
    <div class="an-kpis">${kpis.map(([l, v, s]) => `<div><span class="faint">${esc(l)}</span><b>${v}</b><small class="faint">${s}</small></div>`).join("")}</div>
    <p class="an-line"><b>Inflow</b> · ${sources}${inf.belowBudget ? ` · closed below budget <b>${inf.belowBudget}</b>` : ""}<br>${spend}</p>
    <h3>Every stage</h3>
    <div class="an-scroll"><table class="grid an-t"><tr><th>Stage</th><th>Worked by</th><th class="r" title="Cards that entered the stage in the period">Reached</th><th class="r" title="Reached here ÷ reached at the previous step">Conv.</th><th class="r" title="Messages sent while the card was at this stage">Sent</th><th class="r">Now</th><th class="r" title="No stage move for 7 days or more">Stuck 7d+</th></tr>${stageRows}</table></div>
    <h3>Each broker through the Copilot</h3>
    <div class="an-scroll"><table class="grid an-t"><tr><th>Who</th><th class="r" title="Approved in the Copilot or typed on the phone">Sent by the person</th><th class="r">By the autopilot</th><th class="r" title="Median wait of a client for our reply">Reply</th><th class="r" title="Median time from a ready draft to its send">Draft → sent</th><th class="r" title="Drafts sent without an edit">As written</th><th class="r">Overdue tasks</th>${
      rep ? `<th class="r" title="Filed / held; late = after ${d.reportDueHours} h">${rep}</th><th class="r" title="Not filed ${d.reportDueHours} h after the start">Missing</th>` : ""
    }</tr>${bRows}</table></div>
    <p class="faint an-note">Stage moves in a period are entries, not a cohort: conversion over 100% or on fewer than 3 cards is not shown. A report is due ${d.reportDueHours} hours after the ${d.funnel === "rental-listings" ? "inspection" : "viewing"} starts.</p></section>`;
}

// ── 3. Bottlenecks ──
function objectionList(title, rows) {
  if (!rows) return "";
  return `<div class="an-box"><h4>${esc(title)}</h4>${
    rows.length
      ? `<ul class="an-obj">${rows.map((o) => `<li><b>${esc(o.label)}</b> <span class="faint">${o.clients} client${o.clients === 1 ? "" : "s"} · ${o.share}%</span>${o.quotes.length ? `<div class="faint">${o.quotes.map((q) => `“${esc(q)}”`).join(" · ")}</div>` : ""}</li>`).join("")}</ul>`
      : `<p class="faint">Nothing recorded in the period.</p>`
  }</div>`;
}
function bottlenecksHtml(d) {
  const b = d.bottlenecks;
  const cs = b.clientSide;
  const client =
    d.funnel === "rental-listings"
      ? objectionList("Owners, before the inspection", cs.beforeInspection)
      : `${objectionList("Before the viewing (after options)", cs.beforeViewing)}${objectionList("After the viewing (reports)", cs.afterViewing)}`;
  const ours = `<div class="an-scroll"><table class="grid an-t"><tr><th>Who</th><th class="r">Waiting 4h+ now</th><th class="r">Cards stuck 7d+</th><th class="r">Overdue tasks</th><th class="r">Reports missing</th></tr>${b.ourSide
    .map((r) => `<tr class="${r.name === "Team" ? "tm" : ""}"><td>${esc(r.name)}</td><td class="r ${r.unanswered ? "bad" : ""}">${r.unanswered || "—"}</td><td class="r">${r.stuck || "—"}</td><td class="r">${r.overdueTasks || "—"}</td><td class="r ${r.reportsMissing ? "bad" : ""}">${r.reportsMissing || "—"}</td></tr>`)
    .join("")}</table></div>${b.stuckByStage.length ? `<p class="an-line">Stuck most: ${b.stuckByStage.map((s) => `${esc(s.stage)} <b>${s.stuck}</b> <span class="faint">(${esc((WORKED_BY[s.workedBy] || [s.workedBy])[0])})</span>`).join(" · ")}</p>` : ""}`;
  const inf = b.inflow;
  const ch = inf.prevNewCards ? Math.round(((inf.newCards - inf.prevNewCards) / inf.prevNewCards) * 100) : null;
  const supply = (inf.supply || []).length
    ? `<table class="grid an-t"><tr><th>Asked for</th><th class="r">Requests</th><th class="r">Villas that fit</th></tr>${inf.supply
        .map((s) => `<tr><td>${esc([s.bedrooms ? s.bedrooms + "BR" : "", s.area, s.band].filter(Boolean).join(" · "))}</td><td class="r">${s.requests ?? "—"}</td><td class="r ${Number(s.matchingVillas) < Number(s.requests) ? "bad" : ""}">${s.matchingVillas ?? "—"}</td></tr>`)
        .join("")}</table>`
    : "";
  return `<section class="panel an-ch"><h2><span class="an-n">3</span>Bottlenecks <span class="faint">why the target is missed</span></h2>
    <h3>${d.funnel === "rental-listings" ? "The owner's side" : "The client's side"}</h3><div class="an-cols">${client}</div>
    <h3>Our side <span class="faint">the bot or the broker</span></h3>${ours}
    <h3>The inflow</h3>
    <p class="an-line">New cards <b>${inf.newCards}</b> vs <b>${inf.prevNewCards}</b> the period before${ch == null ? "" : ` (<span class="${ch < 0 ? "bad" : "ok"}">${ch > 0 ? "+" : ""}${ch}%</span>)`}${inf.belowBudget ? ` · closed below budget <b>${inf.belowBudget}</b>` : ""}</p>
    ${supply ? `<h4 class="faint" style="margin:8px 0 4px">Villas for what clients ask (last 14 days)</h4>${supply}` : ""}</section>`;
}
