// Unicorn OS — analytics, one funnel at a time (owner, 26.09): Rental clients, Rental Listings, Sales.
// Inside a funnel: the team (people against their targets and against each other, and where each
// loses), the bottlenecks, the objections and the waits — for the team or for one person.
// Company-wide pages (the weekly brief, the daily numbers, AI cost) sit apart.
import { S, api, esc, I, screens, store, on, money, fmtDT, fmtDay, rel, isStaff, emit, toast, fail, currentTheme } from "./core.js";

const FUNNELS = [
  ["rental", "Rental clients", "Rental"],
  ["rental-listings", "Rental listings", "Rental Listings"],
  ["unicorn", "Sales", "Unicorn"],
];
const SECTIONS = {
  rental: [
    ["team", "Team"],
    ["bottlenecks", "Bottlenecks"],
    ["objections", "Objections"],
    ["waits", "Funnel & waits"],
    ["supply", "Supply gaps"],
  ],
  "rental-listings": [
    ["team", "Team"],
    ["bottlenecks", "Bottlenecks"],
    ["waits", "Funnel & waits"],
  ],
  unicorn: [
    ["team", "Team"],
    ["waits", "Funnel & waits"],
  ],
  company: [
    ["work", "Bot and people"],
    ["brief", "Weekly brief"],
    ["daily", "Daily numbers"],
    ["cost", "AI cost"],
  ],
};
const STAFF_ONLY = new Set(["team", "work", "brief", "daily", "cost"]);

const pct = (a, b) => (b ? Math.round((a / b) * 100) + "%" : "—");
const nameOf = (x) => (x.name || x.client_name || x.clientName || "").replace(/\s*\(клиент.*$/i, "") || `#${x.leadId || x.lead_id}`;
const mins = (m) => (m == null || m === 0 ? "—" : m < 60 ? `${m} min` : m < 1440 ? `${(m / 60).toFixed(1)} h` : `${(m / 1440).toFixed(1)} d`);
function thisMonday() {
  const b = new Date(Date.now() + 8 * 3600e3);
  return new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate() - ((b.getUTCDay() + 6) % 7))).toISOString().slice(0, 10);
}
const shiftWeek = (ws, n) => new Date(new Date(ws + "T00:00:00Z").getTime() + n * 7 * 86400e3).toISOString().slice(0, 10);
function weekOptions(sel) {
  const m = thisMonday();
  return [...Array(10)]
    .map((_, i) => {
      const d = shiftWeek(m, -i);
      return `<option value="${d}" ${d === sel ? "selected" : ""}>${i === 0 ? "This week · " : i === 1 ? "Last week · " : ""}${esc(fmtDay(d + "T04:00:00Z"))}</option>`;
    })
    .join("");
}

// Tiny markdown for the weekly brief (headings, bold, bullets, paragraphs).
function md(text) {
  const lines = esc(text || "").split("\n");
  let html = "";
  let inList = false;
  for (const raw of lines) {
    const l = raw.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    if (/^\s*[-*•]\s+/.test(l)) {
      if (!inList) html += "<ul>";
      inList = true;
      html += `<li>${l.replace(/^\s*[-*•]\s+/, "")}</li>`;
      continue;
    }
    if (inList) html += "</ul>";
    inList = false;
    if (/^#{1,3}\s/.test(l)) html += `<h3>${l.replace(/^#{1,3}\s/, "")}</h3>`;
    else if (l.trim()) html += `<p>${l}</p>`;
  }
  if (inList) html += "</ul>";
  return html;
}

function gateHtml(steps, prevSteps) {
  const max = Math.max(1, ...steps.map((s) => s.n || 0));
  return `<div class="gate">${steps
    .map((s, i) => {
      const before = i > 0 ? steps[i - 1].n : null;
      const drop = before != null && before > 0 && (s.n || 0) / before < 0.5;
      const p = prevSteps?.[i]?.n;
      return `<div class="st ${drop ? "drop" : ""}" title="${esc(s.note || "")}"><span>${esc(s.label)}</span><div class="bar"><i style="width:${Math.round(((s.n || 0) / max) * 100)}%"></i></div><span class="v">${s.n ?? "—"}${i > 0 && before ? ` <span class="faint">${pct(s.n || 0, before)}</span>` : ""}${p != null ? `<br><span class="faint" style="font-size:10.5px">prev ${p}</span>` : ""}</span></div>`;
    })
    .join("")}</div>`;
}

/** The team table of a funnel for a period, cached for the person filters. */
async function loadTeam(funnel, date, force, period = "week") {
  const key = `team:${funnel}:${period}:${date}`;
  const c = S.cache[key];
  if (!force && c && Date.now() - c.at < 60_000) return c.value;
  const v = await api(`/analytics/team?funnel=${funnel}&period=${period}&date=${date}`);
  S.cache[key] = { at: Date.now(), value: v };
  return v;
}
const PERIODS = [
  ["week", "Week"],
  ["month", "Month"],
  ["quarter", "Quarter"],
  ["year", "Year"],
];
/** The last few periods of a kind, newest first, as [start day, label]. */
function periodChoices(period) {
  const today = new Date(Date.now() + 8 * 3600e3);
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const iso = (Y, M) => new Date(Date.UTC(Y, M, 1)).toISOString().slice(0, 10);
  if (period === "month") return [...Array(12)].map((_, i) => [iso(y, m - i), new Date(Date.UTC(y, m - i, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })]);
  if (period === "quarter") {
    const q0 = Math.floor(m / 3);
    return [...Array(6)].map((_, i) => {
      const d = new Date(Date.UTC(y, (q0 - i) * 3, 1));
      return [d.toISOString().slice(0, 10), `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`];
    });
  }
  if (period === "year") return [...Array(3)].map((_, i) => [`${y - i}-01-01`, String(y - i)]);
  const mon = thisMonday();
  return [...Array(10)].map((_, i) => {
    const d = shiftWeek(mon, -i);
    return [d, `${i === 0 ? "This week · " : i === 1 ? "Last week · " : ""}${fmtDay(d + "T04:00:00Z")}`];
  });
}
async function peopleOf(funnel) {
  if (!isStaff()) return [];
  try {
    return (await loadTeam(funnel, thisMonday(), false, "week")).people.map((p) => p.name);
  } catch (e) {
    return [];
  }
}

screens.analytics = {
  title: "Analytics",
  async render({ el, tools, route }) {
    const staff = isStaff();
    let funnel = route.parts[0] && (SECTIONS[route.parts[0]] ? route.parts[0] : null);
    funnel = funnel || store.get("an-funnel", "rental");
    if (funnel === "company" && !staff) funnel = "rental";
    const secs = SECTIONS[funnel].filter(([k]) => staff || !STAFF_ONLY.has(k));
    const section = secs.some(([k]) => k === route.parts[1]) ? route.parts[1] : store.get(`an-sec:${funnel}`, secs[0][0]);
    const sec = secs.some(([k]) => k === section) ? section : secs[0][0];
    store.set("an-funnel", funnel);
    store.set(`an-sec:${funnel}`, sec);
    tools.innerHTML = `<div class="views">${FUNNELS.map(([k, l]) => `<button data-fun="${k}" class="${k === funnel ? "active" : ""}">${esc(l)}</button>`).join("")}${
      staff ? `<button data-fun="company" class="${funnel === "company" ? "active" : ""}">Company</button>` : ""
    }</div><div class="views">${secs.map(([k, l]) => `<button data-sec="${k}" class="${k === sec ? "active" : ""}">${esc(l)}</button>`).join("")}</div>`;
    on(tools, "click", "[data-fun]", (e, b) => (location.hash = `#/analytics/${b.dataset.fun}`));
    on(tools, "click", "[data-sec]", (e, b) => (location.hash = `#/analytics/${funnel}/${b.dataset.sec}`));
    el.innerHTML = `<div class="loading">Counting…</div>`;
    try {
      await VIEWS[sec](el, funnel);
    } catch (e) {
      el.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
    on(el, "click", "[data-lead]", (e, x) => {
      e.preventDefault();
      emit("open-peek", { type: "lead", id: x.dataset.lead, tab: "overview" });
    });
    on(el, "click", "[data-vreport]", (e, x) => {
      e.preventDefault();
      emit("open-peek", { type: "vreport", id: x.dataset.vreport });
    });
    on(el, "click", "[data-villa]", (e, x) => {
      e.preventDefault();
      emit("open-peek", { type: "villa", id: x.dataset.villa });
    });
  },
};
const rerender = () => screens.analytics.render({ el: document.getElementById("content"), tools: document.getElementById("tools"), route: S.route });

/** Week and person pickers shared by the funnel sections. */
async function filtersHtml(funnel, { week = true, person = true } = {}) {
  const w = store.get("an-week", thisMonday());
  const who = store.get(`an-who:${funnel}`, "");
  const names = person ? await peopleOf(funnel) : [];
  return {
    week: w,
    who: names.includes(who) ? who : "",
    html: `<div class="row an-filters">${week ? `<select class="chip" id="an-week">${weekOptions(w)}</select>` : ""}${
      person && names.length ? `<select class="chip" id="an-who"><option value="">Whole team</option>${names.map((n) => `<option ${n === who ? "selected" : ""}>${esc(n)}</option>`).join("")}</select>` : ""
    }${week ? `<span class="faint">Weeks run Monday to Sunday, Bali time.</span>` : ""}</div>`,
    bind(el) {
      const ws = el.querySelector("#an-week");
      if (ws) ws.onchange = () => (store.set("an-week", ws.value), rerender());
      const ps = el.querySelector("#an-who");
      if (ps) ps.onchange = () => (store.set(`an-who:${funnel}`, ps.value), rerender());
    },
  };
}

const VIEWS = {
  // ── The team of a funnel: targets, fact, ranking, and where each person loses ──
  async team(el, funnel) {
    const period = store.get("an-period", "week");
    const choices = periodChoices(period);
    const anchor = choices.some(([d]) => d === store.get(`an-anchor:${period}`)) ? store.get(`an-anchor:${period}`) : choices[0][0];
    const edit = !!store.get("an-edit-targets", false);
    const prevAnchor = choices[choices.findIndex(([d]) => d === anchor) + 1]?.[0];
    const [t, tp] = await Promise.all([loadTeam(funnel, anchor, true, period), prevAnchor ? loadTeam(funnel, prevAnchor, false, period).catch(() => null) : Promise.resolve(null)]);
    const periodWord = { week: "week", month: "month", quarter: "quarter", year: "year" }[period];
    const f = {
      week: t.from,
      html: `<div class="row an-filters"><div class="views">${PERIODS.map(([k, l]) => `<button data-period="${k}" class="${k === period ? "active" : ""}">${l}</button>`).join("")}</div>
        <select class="chip" id="an-anchor">${choices.map(([d, l]) => `<option value="${d}" ${d === anchor ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
        <span class="faint">Counted over the ${periodWord} in Bali time.</span></div>`,
      bind(root) {
        on(root, "click", "[data-period]", (e, b) => (store.set("an-period", b.dataset.period), rerender()));
        root.querySelector("#an-anchor").onchange = (e) => (store.set(`an-anchor:${period}`, e.target.value), rerender());
      },
    };
    const metrics = t.metrics;
    const prevOf = (name, k) => tp?.people.find((p) => p.name === name)?.values?.[k]?.v;
    const cell = (who, m, v, target, prev) => {
      const tv = target?.value;
      const cls = tv ? (v >= tv ? "ok" : target.floor != null && v >= target.floor ? "warn" : "bad") : "";
      const own = tv != null && !target?.summed && !target?.implied;
      const input = edit && m.target ? `<input class="tin" type="number" min="0" step="1" data-t="${esc(m.key)}" data-who="${esc(who)}" value="${own ? esc(tv) : ""}" placeholder="${tv != null ? esc(tv) : "—"}" title="Target per ${periodWord}">` : "";
      const mark = target?.summed ? "*" : target?.implied ? "≈" : "";
      return `<td class="num tcell ${cls}"><b>${v ?? 0}</b>${tv != null && !edit ? `<span class="tgt" title="${target.implied ? "from the weekly target" : target.summed ? "sum of the people's targets" : ""}">/ ${mark === "≈" ? "≈" : ""}${esc(tv)}${mark === "*" ? "*" : ""}</span>` : ""}${input}${prev != null && !edit ? `<div class="prev">prev ${prev}</div>` : ""}</td>`;
    };
    const habitCells = (vals) =>
      `<td class="num">${esc(mins(vals.reply_min?.v))}</td><td class="num ${vals.overdue_tasks?.v ? "bad-t" : ""}">${vals.overdue_tasks?.v ?? 0}</td><td class="num ${vals.reports_due?.v ? "bad-t" : ""}">${vals.reports_due?.v ?? 0}</td><td class="num">${vals.drafts_edited_pct?.v ? vals.drafts_edited_pct.v + "%" : "—"}</td>`;
    const scoreHtml = (p) => {
      if (p.score == null) return `<span class="faint">no activity</span>`;
      const s = Math.round(p.score * 100);
      const cls = p.score >= 1 ? "ok" : p.score >= 0.8 ? "warn" : "bad";
      return `<span class="pill ${cls}" title="${esc(p.basis)}">${s}%</span>`;
    };
    const rows = t.people
      .map(
        (p) => `<tr><td class="num">${p.rank}</td><td><b>${esc(p.name)}</b></td>${metrics.map((m) => cell(p.name, m, p.values[m.key]?.v, p.targets[m.key], prevOf(p.name, m.key))).join("")}${habitCells(p.values)}<td>${scoreHtml(p)}</td>
        <td class="why">${p.weakest ? `${esc(p.weakest.step)} <span class="faint">${Math.round(p.weakest.rate * 100)}% vs team ${Math.round(p.weakest.teamRate * 100)}% (of ${p.weakest.base})</span>` : `<span class="faint">no step clearly below the team</span>`}</td></tr>`,
      )
      .join("");
    const teamRow = `<tr class="team-row"><td></td><td><b>Team</b></td>${metrics.map((m) => cell("team", m, t.team.values[m.key]?.v, t.team.targets[m.key], tp?.team.values?.[m.key]?.v)).join("")}<td class="num">—</td><td class="num">${t.team.values.overdue_tasks?.v ?? 0}</td><td class="num">${t.team.values.reports_due?.v ?? 0}</td><td></td><td></td><td></td></tr>`;
    // Conversion at each step, person by person: the reason one is behind shows here.
    const gateRows = t.gates
      .map((g) => {
        const per = t.people.map((p) => {
          const a = p.values[g.from]?.v || 0;
          const b = p.values[g.to]?.v || 0;
          const r = a ? b / a : null;
          const worse = r != null && g.teamRate != null && a >= 3 && g.teamRate - r > 0.1;
          return `<td class="num ${worse ? "bad-t" : ""}">${r == null ? "—" : Math.round(r * 100) + "%"}<span class="faint"> ${b}/${a}</span></td>`;
        });
        return `<tr><td>${esc(metrics.find((m) => m.key === g.from)?.label || g.from)} → ${esc(metrics.find((m) => m.key === g.to)?.label || g.to)}</td><td class="num"><b>${g.teamRate == null ? "—" : Math.round(g.teamRate * 100) + "%"}</b></td>${per.join("")}</tr>`;
      })
      .join("");
    el.innerHTML = `<div class="page stack" style="gap:12px">${f.html}
      <div class="panel"><h3>${esc(FUNNELS.find((x) => x[0] === funnel)[1])} · the team this ${periodWord} <span class="row" style="gap:8px"><span class="faint">${t.people.length} people with cards in this funnel</span><button class="btn sm ${edit ? "primary" : ""}" id="an-edit">${edit ? "Done" : "Set targets"}</button></span></h3>
        ${edit ? `<div class="help">These are ${periodWord}ly targets, from the ${periodWord} shown onward; earlier ${periodWord}s keep theirs. Leave a box empty for no target. A team target left empty is the sum of the people's (marked *). Without a ${periodWord}ly target, the weekly one scaled to the ${periodWord} is shown (marked ≈).</div>` : ""}
        <div class="tbl-wrap" style="max-height:none"><table class="grid team"><thead><tr><th>#</th><th>Person</th>${metrics.map((m) => `<th title="${esc(m.label)}">${esc(m.label)}</th>`).join("")}<th>Reply wait</th><th>Overdue tasks</th><th>Reports owed</th><th>Drafts rewritten</th><th>Score</th><th>Where they lose most</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="${metrics.length + 8}" class="empty">Nobody holds cards in this funnel yet.</td></tr>`}${teamRow}</tbody></table></div>
        <p class="faint" style="font-size:11.5px;margin:8px 0 0">Score: the share of their own targets reached (capped at 150%), or, without targets, of the team's average. Reply wait is the median time a client waited for the first answer. Overdue tasks and reports owed are counted now, not for the week.</p></div>
      ${t.gates.length ? `<div class="panel"><h3>Conversion at each step <span class="faint">red: more than 10 points below the rest of the team</span></h3><div class="tbl-wrap" style="max-height:none"><table class="grid"><thead><tr><th>Step</th><th>Team</th>${t.people.map((p) => `<th>${esc(p.name)}</th>`).join("")}</tr></thead><tbody>${gateRows}</tbody></table></div></div>` : ""}
    </div>`;
    f.bind(el);
    el.querySelector("#an-edit").onclick = () => (store.set("an-edit-targets", !edit), rerender());
    on(el, "change", "input.tin", async (e, inp) => {
      try {
        await api("/analytics/team-targets", { body: { funnel, metric: inp.dataset.t, who: inp.dataset.who, value: inp.value === "" ? null : Number(inp.value), from: t.from, period } });
        toast(`${periodWord[0].toUpperCase() + periodWord.slice(1)}ly target saved for ${inp.dataset.who === "team" ? "the team" : inp.dataset.who}`);
        delete S.cache[`team:${funnel}:${period}:${anchor}`];
      } catch (err) {
        fail(err);
      }
    });
  },

  // ── Bottlenecks, for the team or one person ──
  async bottlenecks(el, funnel) {
    const f = await filtersHtml(funnel);
    const q = `week=${f.week}${f.who ? `&broker=${encodeURIComponent(f.who)}` : ""}`;
    if (funnel === "rental-listings") {
      const [t, tp] = await Promise.all([loadTeam(funnel, f.week, false, "week"), loadTeam(funnel, shiftWeek(f.week, -1), false, "week").catch(() => null)]);
      const pick = (x) => (f.who ? x?.people.find((p) => p.name === f.who)?.values : x?.team.values) || {};
      const cur = pick(t);
      const prev = pick(tp);
      const steps = t.metrics.map((m) => ({ label: m.label, n: cur[m.key]?.v ?? 0 }));
      const prevSteps = t.metrics.map((m) => ({ n: prev[m.key]?.v ?? 0 }));
      el.innerHTML = `<div class="page stack" style="gap:12px">${f.html}
        <div class="panel"><h3>Owner cards to Listed · ${esc(f.who || "whole team")} <span class="faint">reports owed now: ${cur.reports_due?.v ?? 0} · overdue tasks: ${cur.overdue_tasks?.v ?? 0}</span></h3>${gateHtml(steps, prevSteps)}
          <p class="faint" style="font-size:11.5px;margin:8px 0 0">Published and Listed come from the site; a listing belongs to the person its code names (R-YUD is Yudi).</p></div></div>`;
      f.bind(el);
      return;
    }
    const [g, gp] = await Promise.all([api(`/analytics/gates?${q}`), api(`/analytics/gates?week=${shiftWeek(f.week, -1)}${f.who ? `&broker=${encodeURIComponent(f.who)}` : ""}`).catch(() => null)]);
    const v2 = g.gateViewingToDeal || {};
    const stuck = g.gateOptionsToViewing?.stuck || [];
    const byStep = {};
    for (const s of stuck) (byStep[s.step] = byStep[s.step] || []).push(s);
    const drafts = (g.drafts || []).filter((d) => !f.who || d.broker.toLowerCase() === f.who.toLowerCase());
    el.innerHTML = `<div class="page stack" style="gap:12px">${f.html}
      <div class="kgrid">
        <div class="panel"><h3>Options → viewing · ${esc(f.who || "whole team")} <span class="faint">clients whose first shortlist went out this week</span></h3>${g.gateOptionsToViewing?.steps ? gateHtml(g.gateOptionsToViewing.steps, gp?.gateOptionsToViewing?.steps) : `<span class="faint">no data</span>`}
          <p class="faint" style="font-size:11.5px;margin:8px 0 0">"Viewing offered" is read from our messages (viewing / visit words): the chats do not store it as a fact yet.</p></div>
        <div class="panel"><h3>Where those clients stopped <span class="faint">${stuck.length}</span></h3><div class="stack" style="max-height:360px;overflow:auto">${
          Object.entries(byStep)
            .map(([step, arr]) => `<div class="sect-h">${esc(step)} · ${arr.length}</div>${arr.slice(0, 12).map((s) => `<div class="quote" data-lead="${esc(s.leadId)}" style="cursor:pointer"><b>${esc(nameOf(s))}</b> <span class="pill stage">${esc(s.stage || "")}</span>${s.lastClientText ? `<br>“${esc(String(s.lastClientText).slice(0, 180))}”` : ""}<div class="by">${s.lastClientAt ? "last wrote " + esc(rel(s.lastClientAt)) : "never wrote back"}${s.offeredBy ? " · viewing offered by " + esc(s.offeredBy) : ""}</div></div>`).join("")}`)
            .join("") || `<div class="empty">Nobody stuck, or no shortlists this week.</div>`
        }</div></div>
      </div>
      <div class="panel"><h3>Viewing → deal <span class="faint">${(v2.viewings || []).length} viewings held · contracts signed ${v2.contractsSigned ?? 0}</span></h3>
        <div class="tbl-wrap" style="max-height:none"><table class="grid"><thead><tr><th>When</th><th>Client</th><th>Villa</th><th>Outcome</th><th>What the client said</th><th>Next step</th><th>Stage now</th></tr></thead><tbody>${
          (v2.viewings || [])
            .map((r) => `<tr ${r.report_id && r.outcome ? `data-vreport="${esc(r.report_id)}"` : `data-lead="${esc(r.lead_id)}"`}><td>${esc(fmtDT(r.viewing_at))}</td><td><b>${esc(nameOf(r))}</b></td><td>${r.property_code ? `<a href="#" data-villa="${esc(r.property_code)}" class="mono">${esc(r.property_code)}</a>` : "—"}</td><td>${r.outcome ? `<span class="pill ${r.outcome === "go" ? "ok" : r.outcome === "no" ? "bad" : "warn"}">${esc(r.outcome)}</span>` : r.report_status === "due" ? `<span class="pill bad">report missing</span>` : "—"}</td><td class="ellip" title="${esc(r.feedback || "")}">${esc(r.feedback || "")}</td><td>${esc((r.next_steps || []).join(", "))}</td><td>${esc(r.lead_stage || "")}</td></tr>`)
            .join("") || `<tr><td colspan="7" class="empty">No viewings held this week.</td></tr>`
        }</tbody></table></div><p class="faint" style="font-size:11.5px;margin:8px 0 0">A row with a filed report opens the report.</p></div>
      ${isStaff() && drafts.length ? `<div class="panel"><h3>What happened to the Copilot's drafts <span class="faint">bot and people apart</span></h3><div class="tbl-wrap" style="max-height:none"><table class="grid"><thead><tr><th>Person</th><th>Kind</th><th>Bot sent</th><th>Sent as written</th><th>Edited</th><th>Skipped</th><th>Untouched</th></tr></thead><tbody>${drafts
        .map((d) => `<tr><td>${esc(d.broker)}</td><td>${esc(d.kind)}</td><td class="num">${d.bot_sent}</td><td class="num">${d.sent_as_is}</td><td class="num">${d.edited}</td><td class="num">${d.skipped}</td><td class="num">${d.untouched}</td></tr>`)
        .join("")}</tbody></table></div></div>` : ""}
    </div>`;
    f.bind(el);
  },

  // ── Objections: the pains first, then every word ──
  async objections(el, funnel) {
    const f = await filtersHtml(funnel, { week: false });
    const days = Number(store.get("obj-days", 30));
    const r = await api(`/analytics/objections?days=${days}${f.who ? `&broker=${encodeURIComponent(f.who)}` : ""}`);
    const cats = r.categories || {};
    const pains = r.pains || [];
    const top = pains.slice(0, 5);
    const byCat = {};
    for (const q of r.recent) (byCat[q.category] = byCat[q.category] || []).push(q);
    const trend = (p) => {
      if (!p.prevClients) return `<span class="faint">new this period</span>`;
      const d = p.clients - p.prevClients;
      return d === 0 ? `<span class="faint">same as before</span>` : `<span class="${d > 0 ? "bad-t" : "ok-t"}">${d > 0 ? "▲" : "▼"} ${Math.abs(d)} vs the ${days} days before</span>`;
    };
    el.innerHTML = `<div class="page stack" style="gap:12px">
      <div class="row an-filters"><select class="chip" id="obj-days">${[7, 14, 30, 90].map((d) => `<option value="${d}" ${d === days ? "selected" : ""}>Last ${d} days</option>`).join("")}</select>${f.html.replace(/^<div class="row an-filters">|<\/div>$/g, "")}
        ${isStaff() ? `<button class="btn sm" id="obj-scan">Read new messages now</button>` : ""}</div>
      <div class="panel"><h3>The main pains <span class="faint">${r.clientsTotal || 0} clients objected · read every two hours from the chats and viewing reports · last pass ${r.lastScanAt ? esc(rel(r.lastScanAt)) : "not yet"}</span></h3>
        <div class="pains">${
          top
            .map(
              (p, i) => `<div class="pain"><div class="pn">${i + 1}</div><div class="pb2"><div class="pt"><b>${esc(p.label)}</b><span class="pill">${p.clients} clients · ${p.share}%</span>${trend(p)}</div>
                ${p.segments.length ? `<div class="faint">Said most by: ${p.segments.map((s) => `${esc(s.segment)} (${s.clients})`).join(" · ")}</div>` : ""}
                <div class="pq">${p.quotes.map((q) => `<a href="#" data-lead="${esc(q.leadId)}">“${esc(q.quote.length > 140 ? q.quote.slice(0, 140) + "…" : q.quote)}”</a>`).join("")}</div></div></div>`,
            )
            .join("") || `<div class="empty">No objections recorded in this period.</div>`
        }</div>
        ${pains.length > 5 ? `<p class="faint" style="font-size:12px;margin:8px 0 0">Also: ${pains.slice(5).map((p) => `${esc(p.label)} ${p.clients}`).join(" · ")}</p>` : ""}</div>
      <div class="panel"><h3>Every objection, in the clients' words <span class="faint">open a kind to read it all</span></h3><div class="stack">${
        pains
          .map((p) => {
            const arr = byCat[p.category] || [];
            return `<details class="objcat"><summary><b>${esc(p.label)}</b> <span class="faint">${p.mentions} mentions · ${p.clients} clients</span></summary><div class="stack" style="margin-top:8px">${arr
              .map((q) => `<div class="quote" data-lead="${esc(q.lead_id)}" style="cursor:pointer">“${esc(q.quote || "")}”<div class="by">${esc(nameOf(q))} · ${esc(q.source === "viewing-report" ? "viewing report" : "chat")} · ${esc(rel(q.said_at))}${q.lead_stage ? " · " + esc(q.lead_stage) : ""}${q.req_bedrooms ? ` · ${q.req_bedrooms}BR ${esc(q.req_areas || "")} ${q.req_budget_idr_monthly ? money(q.req_budget_idr_monthly) : ""}` : ""}</div></div>`)
              .join("") || `<span class="faint">Only older mentions; widen the period.</span>`}</div></details>`;
          })
          .join("") || `<span class="faint">—</span>`
      }</div></div>
      <div class="kgrid">
        <div class="panel"><h3>Viewing reports <span class="faint">${r.viewingReports.length} · open one to read it whole</span></h3><div class="stack" style="max-height:460px;overflow:auto">${
          r.viewingReports
            .map((v) => `<div class="quote" data-vreport="${esc(v.report_id)}" style="cursor:pointer"><b>${esc(fmtDay(v.viewing_at))}${v.property_code ? ` · <span class="mono">${esc(v.property_code)}</span>` : ""}</b> <span class="pill ${v.outcome === "go" ? "ok" : v.outcome === "no" ? "bad" : "warn"}">${esc(v.outcome || "")}</span> <span class="faint">${esc(nameOf(v))}</span><br>${esc(v.feedback ? (v.feedback.length > 220 ? v.feedback.slice(0, 220) + "…" : v.feedback) : "no feedback written")}<div class="by">next: ${esc((v.next_steps || []).join(", ") || "—")} · ${esc(v.responsible_user || "")}</div></div>`)
            .join("") || `<div class="empty">No viewing reports in this period.</div>`
        }</div></div>
        <div class="panel"><h3>Cards closed as lost <span class="faint">${r.lost.length}</span></h3>
          ${r.lostReasons.length ? `<div class="bars" style="margin-bottom:10px">${r.lostReasons.map((x) => `<div class="row"><span>${esc(r.closeReasons[x.reason] || x.reason)}</span><div class="b"><i style="width:${Math.round((x.n / Math.max(...r.lostReasons.map((y) => y.n))) * 100)}%"></i></div><span class="num">${x.n}</span></div>`).join("")}</div>` : `<p class="faint" style="margin:0 0 8px;font-size:12px">Reasons are recorded from now on: closing a card as lost in Unicorn OS asks why. amoCRM never stored them.</p>`}
          <div class="stack" style="max-height:340px;overflow:auto">${r.lost.map((l) => `<div class="note" data-lead="${esc(l.lead_id)}" style="cursor:pointer">#${esc(l.lead_id)} from ${esc(l.from_stage || "—")} · ${esc(rel(l.changed_at))}${l.discard_reason ? `<br><span class="faint">${esc(l.discard_reason)}</span>` : ""}</div>`).join("") || `<span class="faint">none</span>`}</div></div>
      </div></div>`;
    f.bind(el);
    el.querySelector("#obj-days").onchange = (e) => (store.set("obj-days", Number(e.target.value)), rerender());
    const sc = el.querySelector("#obj-scan");
    if (sc)
      sc.onclick = async () => {
        sc.disabled = true;
        sc.textContent = "Reading…";
        try {
          const x = await api("/analytics/objections/scan", { body: {} });
          toast(`Read ${x.messages} messages and ${x.reports} reports · ${x.found} new objections`);
          rerender();
        } catch (e) {
          fail(e);
          sc.disabled = false;
        }
      };
  },

  // ── Funnel and waits, for the team or one person ──
  async waits(el, funnel) {
    const f = await filtersHtml(funnel, { week: false });
    const pipe = FUNNELS.find((x) => x[0] === funnel)[2];
    const b = f.who ? `&broker=${encodeURIComponent(f.who)}` : "";
    const [fw, w] = await Promise.all([api(`/analytics/funnel?pipeline=${encodeURIComponent(pipe)}&weeks=6${b}`), api(`/analytics/waits?pipeline=${encodeURIComponent(pipe)}${b}`)]);
    const p = (S.meta.pipelines || []).find((x) => x.name.toLowerCase() === pipe.toLowerCase());
    const order = (p?.stages || []).map((s) => s.name);
    const weeks = [...new Set(fw.arrivals.map((x) => x.week))].sort();
    const stages = [...new Set([...order, ...fw.arrivals.map((x) => x.to_stage)])].filter((s) => fw.arrivals.some((x) => x.to_stage === s));
    const cellv = (s, wk) => fw.arrivals.find((x) => x.to_stage === s && x.week === wk)?.n || "";
    const created = (wk) => fw.created.find((x) => x.week === wk)?.n || "";
    const waits = [...w.stages].sort((a, c) => order.indexOf(a.stage) - order.indexOf(c.stage));
    el.innerHTML = `<div class="page stack" style="gap:12px">${f.html}
      <div class="panel"><h3>Cards arriving in each stage per week · ${esc(f.who || "whole team")} <span class="faint">from recorded stage moves; moves made by hand in amoCRM may be missing</span></h3><div class="tbl-wrap" style="max-height:none"><table class="grid"><thead><tr><th>Stage</th>${weeks.map((wk) => `<th>${esc(fmtDay(wk + "T12:00:00Z"))}</th>`).join("")}</tr></thead><tbody>
        <tr><td><b>New cards</b></td>${weeks.map((wk) => `<td class="num">${created(wk)}</td>`).join("")}</tr>
        ${stages.map((s) => `<tr><td>${esc(s)}</td>${weeks.map((wk) => `<td class="num">${cellv(s, wk)}</td>`).join("")}</tr>`).join("")}</tbody></table></div></div>
      <div class="panel"><h3>Where cards wait now <span class="faint">open cards per stage, days since they arrived there</span></h3><div class="tbl-wrap" style="max-height:none"><table class="grid"><thead><tr><th>Stage</th><th>Cards</th><th>Median days</th><th>&gt; 3 d</th><th>&gt; 7 d</th><th>&gt; 14 d</th><th>Longest waiting</th></tr></thead><tbody>${waits
        .map((s) => `<tr><td>${esc(s.stage)}</td><td class="num">${s.count}</td><td class="num">${s.medianDays.toFixed(1)}</td><td class="num">${s.over3}</td><td class="num" style="${s.over7 ? "color:var(--hot);font-weight:600" : ""}">${s.over7}</td><td class="num">${s.over14}</td><td>${s.cards.slice(0, 4).map((c) => `<a href="#" data-lead="${esc(c.leadId)}">#${esc(c.leadId)}</a> <span class="faint">${Math.floor(c.days)}d</span>`).join(" · ")}</td></tr>`)
        .join("")}</tbody></table></div></div></div>`;
    f.bind(el);
  },

  async supply(el) {
    const days = Number(store.get("sup-days", 14));
    const r = await api(`/analytics/supply?days=${days}`);
    el.innerHTML = `<div class="page stack" style="gap:12px">
      <div class="row an-filters"><select class="chip" id="sup-days">${[7, 14, 30, 60].map((d) => `<option value="${d}" ${d === days ? "selected" : ""}>Requests of the last ${d} days</option>`).join("")}</select>
      <span class="faint">What clients asked for (area × bedrooms × budget) against published rent listings free within 92 days in the same corridor (70–125% of the budget).</span></div>
      <div class="panel"><h3>Most requested segments</h3><div class="tbl-wrap" style="max-height:none"><table class="grid"><thead><tr><th>Area</th><th>BR</th><th>Budget</th><th>Requests</th><th>Matching listings</th><th>Examples</th></tr></thead><tbody>${r.segments
        .map((s) => `<tr><td>${esc(s.area)}</td><td>${esc(s.bedrooms ?? "any")}</td><td>${esc(s.band)}</td><td class="num"><b>${s.requests}</b></td><td class="num" style="${s.matchingVillas === 0 ? "color:var(--hot);font-weight:600" : ""}">${s.matchingVillas}</td><td>${(s.examples || []).map((id) => `<a href="#" data-villa="${esc(id)}" class="mono">${esc(id)}</a>`).join(" ")}</td></tr>`)
        .join("") || `<tr><td colspan="6" class="empty">No requests with readable criteria in this period.</td></tr>`}</tbody></table></div>
      <p class="faint" style="font-size:12px;margin:8px 0 0">A red 0 is a segment to source first: clients are asking and nothing fits.</p></div></div>`;
    el.querySelector("#sup-days").onchange = (e) => (store.set("sup-days", Number(e.target.value)), rerender());
  },

  // ── Company-wide ──
  // What the bot did and what people did, and the time it saved (owner, 26.09).
  async work(el) {
    const days = Number(store.get("ws-days", 30));
    const funnel = store.get("ws-funnel", "");
    const by = store.get("ws-by", "week");
    const mins = store.get("ws-mins", { hand: 4, approve: 0.5, edit: 2 });
    const r = await api(`/analytics/workshare?days=${days}${funnel ? `&funnel=${funnel}` : ""}`);
    const keyOf = (d) => (by === "day" ? d : by === "month" ? d.slice(0, 7) : (() => {
      const x = new Date(d + "T00:00:00Z");
      x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
      return x.toISOString().slice(0, 10);
    })());
    const F = ["written", "autopilot", "as_written", "edited", "skipped", "people_msgs", "bot_msgs", "bot_moves", "people_moves"];
    const groups = new Map();
    for (const row of r.rows) {
      const k = keyOf(row.day);
      const g = groups.get(k) || Object.fromEntries(F.map((f) => [f, 0]));
      for (const f of F) g[f] += Number(row[f] || 0);
      groups.set(k, g);
    }
    const derive = (g) => {
      const hand = Math.max(0, g.people_msgs - g.as_written - g.edited);
      const otherBot = Math.max(0, g.bot_msgs - g.autopilot);
      const out = g.autopilot + otherBot + g.as_written + g.edited + hand;
      const human = hand * mins.hand + g.as_written * mins.approve + g.edited * mins.edit;
      const allByHand = out * mins.hand;
      return { ...g, hand, otherBot, out, noHuman: g.autopilot + otherBot, byBot: g.autopilot + otherBot + g.as_written + g.edited, humanMin: human, savedMin: Math.max(0, allByHand - human), moves: g.bot_moves + g.people_moves };
    };
    const rows = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, g]) => ({ k, ...derive(g) }));
    const total = derive(Object.fromEntries(F.map((f) => [f, rows.reduce((a, x) => a + x[f], 0)])));
    const pc = (a, b) => (b ? Math.round((a / b) * 100) + "%" : "—");
    const hrs = (m) => (m >= 60 ? `${(m / 60).toFixed(1)} h` : `${Math.round(m)} min`);
    const label = (k) => (by === "month" ? new Date(k + "-01T00:00:00Z").toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }) : fmtDay(k + "T04:00:00Z"));
    const maxOut = Math.max(1, ...rows.map((x) => x.out));
    const seg = (n, cls) => (n ? `<i class="${cls}" style="width:${(n / maxOut) * 100}%" title="${n}"></i>` : "");
    el.innerHTML = `<div class="page stack" style="gap:12px">
      <div class="row an-filters"><select class="chip" id="ws-days">${[30, 90, 180, 365].map((d) => `<option value="${d}" ${d === days ? "selected" : ""}>Last ${d} days</option>`).join("")}</select>
        <select class="chip" id="ws-funnel"><option value="">All funnels</option>${FUNNELS.map(([k, l]) => `<option value="${k}" ${k === funnel ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
        <div class="views">${[["day", "Days"], ["week", "Weeks"], ["month", "Months"]].map(([k, l]) => `<button data-by="${k}" class="${k === by ? "active" : ""}">${l}</button>`).join("")}</div></div>
      <div class="kpis">
        <div class="kpi"><div class="l">Messages out</div><div class="v num">${total.out}</div><div class="d">to clients and owners</div></div>
        <div class="kpi"><div class="l">Written by the bot</div><div class="v num">${pc(total.byBot, total.out)}</div><div class="d">${total.byBot} drafts, templates and autopilot sends</div></div>
        <div class="kpi"><div class="l">Sent with no person</div><div class="v num">${pc(total.noHuman, total.out)}</div><div class="d">${total.autopilot} autopilot · ${total.otherBot} templates</div></div>
        <div class="kpi"><div class="l">Stage moves by the bot</div><div class="v num">${pc(total.bot_moves, total.moves)}</div><div class="d">${total.bot_moves} of ${total.moves}</div></div>
        <div class="kpi"><div class="l">People's time</div><div class="v num">${hrs(total.humanMin)}</div><div class="d">spent on messages</div></div>
        <div class="kpi"><div class="l">Time saved</div><div class="v num">${hrs(total.savedMin)}</div><div class="d">against writing all by hand</div></div>
      </div>
      <div class="panel"><h3>Messages out per ${by} <span class="legend" style="margin:0"><span><i style="background:var(--live)"></i>autopilot</span><span><i style="background:var(--reach)"></i>templates</span><span><i style="background:var(--accent)"></i>draft as written</span><span><i style="background:var(--push)"></i>draft edited</span><span><i style="background:var(--border-2)"></i>by hand</span></span></h3>
        <div class="wsbars">${rows
          .map((x) => `<div class="row"><span>${esc(label(x.k))}</span><div class="stackbar">${seg(x.autopilot, "a")}${seg(x.otherBot, "t")}${seg(x.as_written, "w")}${seg(x.edited, "e")}${seg(x.hand, "h")}</div><span class="num">${x.out}</span><span class="num faint">${pc(x.byBot, x.out)}</span></div>`)
          .join("") || `<div class="empty">No messages in this period.</div>`}</div></div>
      <div class="panel"><h3>Per ${by} <span class="faint">minutes per message: <label>by hand <input class="tin" type="number" step="0.5" min="0" id="m-hand" value="${mins.hand}"></label> · <label>approve <input class="tin" type="number" step="0.5" min="0" id="m-approve" value="${mins.approve}"></label> · <label>edit <input class="tin" type="number" step="0.5" min="0" id="m-edit" value="${mins.edit}"></label></span></h3>
        <div class="tbl-wrap" style="max-height:none"><table class="grid"><thead><tr><th>${by === "day" ? "Day" : by === "week" ? "Week of" : "Month"}</th><th>Drafts written</th><th>Autopilot sent</th><th>Sent as written</th><th>Edited</th><th>Skipped</th><th>By hand</th><th>Templates</th><th>Written by the bot</th><th>Stage moves bot / people</th><th>People's time</th><th>Saved</th></tr></thead><tbody>${rows
          .map((x) => `<tr><td>${esc(label(x.k))}</td><td class="num">${x.written}</td><td class="num">${x.autopilot}</td><td class="num">${x.as_written}</td><td class="num">${x.edited}</td><td class="num">${x.skipped}</td><td class="num">${x.hand}</td><td class="num">${x.otherBot}</td><td class="num"><b>${pc(x.byBot, x.out)}</b></td><td class="num">${x.bot_moves} / ${x.people_moves}</td><td class="num">${hrs(x.humanMin)}</td><td class="num">${hrs(x.savedMin)}</td></tr>`)
          .join("")}</tbody></table></div>
        <p class="faint" style="font-size:11.5px;margin:8px 0 0">"By hand" is the people's messages that did not come from a draft (sent from the phone or typed in amoCRM). Templates are the bot's own messages, such as the welcome. Time uses the minutes above, kept on this device.</p></div></div>`;
    el.querySelector("#ws-days").onchange = (e) => (store.set("ws-days", Number(e.target.value)), rerender());
    el.querySelector("#ws-funnel").onchange = (e) => (store.set("ws-funnel", e.target.value), rerender());
    on(el, "click", "[data-by]", (e, b) => (store.set("ws-by", b.dataset.by), rerender()));
    for (const [id, k] of [["m-hand", "hand"], ["m-approve", "approve"], ["m-edit", "edit"]])
      el.querySelector("#" + id).onchange = (e) => (store.set("ws-mins", { ...mins, [k]: Math.max(0, Number(e.target.value) || 0) }), rerender());
  },

  async brief(el) {
    const week = store.get("an-brief-week", shiftWeek(thisMonday(), -1));
    const briefs = await api("/analytics/briefs").catch(() => ({ items: [] }));
    const brief = (briefs.items || []).find((x) => x.weekStart === week);
    el.innerHTML = `<div class="page stack" style="gap:12px">
      <div class="row an-filters"><select class="chip" id="br-week">${weekOptions(week)}</select><span class="faint">Written automatically on Monday 08:30 from the numbers, the objections and the viewing reports.</span></div>
      <div class="panel"><h3>Weekly bottleneck brief <span class="faint">${brief ? `written ${rel(brief.generatedAt)} · ${esc(brief.generatedBy || "")}` : "not written yet"}</span><button class="btn sm" id="brief-go">${I.sparkle} ${brief ? "Rewrite" : "Write it now"}</button></h3>
        ${brief ? `<div class="brief">${md(brief.content)}</div><div class="row" style="margin-top:8px"><button class="btn sm" id="brief-copy">Copy for the team chat</button></div>` : `<p class="faint" style="margin:0">No brief for this week yet. It says where we are stuck, why, and what to do.</p>`}</div></div>`;
    el.querySelector("#br-week").onchange = (e) => (store.set("an-brief-week", e.target.value), rerender());
    const bg = el.querySelector("#brief-go");
    bg.onclick = async () => {
      bg.disabled = true;
      bg.textContent = "Writing… (about a minute)";
      try {
        await api("/analytics/briefs", { body: { week } });
        toast("Brief written");
        rerender();
      } catch (e) {
        fail(e);
        bg.disabled = false;
      }
    };
    const bc = el.querySelector("#brief-copy");
    if (bc)
      bc.onclick = async () => {
        try {
          await navigator.clipboard.writeText(brief.content);
          toast("Copied");
        } catch (e) {
          toast("Select the text and copy it", { bad: true });
        }
      };
  },

  async daily(el) {
    const r = await api("/analytics/kpi-url");
    if (!r.url) {
      el.innerHTML = `<div class="empty">The daily numbers page has no key configured on the server.</div>`;
      return;
    }
    el.innerHTML = `<p class="faint" style="margin:0 0 8px">The daily numbers page (traffic, Meta spend, cost per lead, autopilot, the team), the same one used for the team chat. <a href="${esc(r.url)}" target="_blank" rel="noopener">Open it on its own ${I.ext}</a></p><iframe class="kpi" src="${esc(r.url)}&host=os&theme=${currentTheme()}" title="Daily numbers"></iframe>`;
  },

  async cost(el) {
    const days = Number(store.get("cost-days", 7));
    const r = await api(`/analytics/ai-cost?days=${days}`);
    const dayList = [...new Set(r.rows.map((x) => x.day))].sort();
    const labels = [...new Set(r.rows.map((x) => x.label))];
    const tot = (lab) => r.rows.filter((x) => x.label === lab).reduce((a, x) => a + x.usd, 0);
    labels.sort((a, b) => tot(b) - tot(a));
    const dayTot = (d) => r.rows.filter((x) => x.day === d).reduce((a, x) => a + x.usd, 0);
    const med = [...dayList.map(dayTot)].sort((a, b) => a - b)[Math.floor(dayList.length / 2)] || 0;
    el.innerHTML = `<div class="page stack" style="gap:12px"><div class="row an-filters"><select class="chip" id="cost-days">${[7, 14, 31].map((d) => `<option value="${d}" ${d === days ? "selected" : ""}>Last ${d} days</option>`).join("")}</select><span class="faint">Every AI call is logged with its cost and purpose. A day above twice the median is marked.</span></div>
      <div class="panel"><h3>USD per day</h3><div class="bars">${dayList.map((d) => `<div class="row"><span>${esc(fmtDay(d + "T12:00:00Z"))}</span><div class="b"><i style="width:${Math.round((dayTot(d) / Math.max(...dayList.map(dayTot), 0.01)) * 100)}%;${dayTot(d) > 2 * med ? "background:var(--hot)" : ""}"></i></div><span class="num">$${dayTot(d).toFixed(2)}</span></div>`).join("")}</div></div>
      <div class="panel"><h3>By purpose</h3><div class="tbl-wrap" style="max-height:none"><table class="grid"><thead><tr><th>Purpose</th><th>Total</th>${dayList.map((d) => `<th>${esc(d.slice(5))}</th>`).join("")}</tr></thead><tbody>${labels
        .map((l) => `<tr><td>${esc(l)}</td><td class="num"><b>$${tot(l).toFixed(2)}</b></td>${dayList.map((d) => {
          const x = r.rows.find((y) => y.day === d && y.label === l);
          return `<td class="num">${x ? "$" + x.usd.toFixed(2) : ""}</td>`;
        }).join("")}</tr>`)
        .join("")}</tbody></table></div></div></div>`;
    el.querySelector("#cost-days").onchange = (e) => (store.set("cost-days", Number(e.target.value)), rerender());
  },
};
