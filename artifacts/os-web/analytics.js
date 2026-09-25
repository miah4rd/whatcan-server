// Unicorn OS — analytics: bottlenecks first (targets, gates, objections), then funnel, supply, daily numbers, cost.
import { S, api, esc, I, screens, store, on, money, fmtDT, fmtDay, rel, isStaff, emit, toast, fail, dialog, baliToday } from "./core.js";

const TABS = [
  ["bottlenecks", "Bottlenecks"],
  ["objections", "Objections"],
  ["funnel", "Funnel & waits"],
  ["supply", "Supply gaps"],
  ["daily", "Daily numbers", true],
  ["cost", "AI cost", true],
  ["targets", "Targets"],
];

const pct = (a, b) => (b ? Math.round((a / b) * 100) + "%" : "—");
const nameOf = (x) => (x.name || x.client_name || "").replace(/\s*\(клиент.*$/i, "") || `#${x.leadId || x.lead_id}`;

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
    else if (/^\d+\.\s/.test(l)) html += `<p>${l}</p>`;
    else if (l.trim()) html += `<p>${l}</p>`;
  }
  if (inList) html += "</ul>";
  return html;
}

function gateHtml(steps, prev) {
  const max = Math.max(1, ...steps.map((s) => s.n || 0));
  return `<div class="gate">${steps
    .map((s, i) => {
      const before = i > 0 ? steps[i - 1].n : null;
      const drop = before != null && before > 0 && (s.n || 0) / before < 0.5;
      const p = prev?.steps?.[i]?.n;
      return `<div class="st ${drop ? "drop" : ""}" title="${esc(s.note || "")}"><span>${esc(s.label)}</span><div class="bar"><i style="width:${Math.round(((s.n || 0) / max) * 100)}%"></i></div><span class="v">${s.n ?? "—"}${i > 0 && before ? ` <span class="faint">${pct(s.n || 0, before)}</span>` : ""}${p != null ? `<br><span class="faint" style="font-size:10.5px">prev ${p}</span>` : ""}</span></div>`;
    })
    .join("")}</div>`;
}

function targetRow(label, fact, t, prev) {
  if (!t) return "";
  const ratio = t.value ? fact / t.value : 0;
  const cls = ratio >= 1 ? "" : t.floor != null && fact >= t.floor ? "warn" : "bad";
  return `<div class="target"><span>${esc(label)} <span class="faint">${t.floor != null ? `${t.floor}–${t.value}` : t.value}${prev != null ? ` · last week ${prev}` : ""}</span></span><span class="num"><b>${fact ?? "—"}</b> / ${t.value}</span><div class="pb ${cls}"><i style="width:${Math.min(100, Math.round(ratio * 100))}%"></i></div></div>`;
}

screens.analytics = {
  title: "Analytics",
  async render({ el, tools, route }) {
    const staff = isStaff();
    const tabs = TABS.filter((t) => !t[2] || staff);
    const tab = tabs.some((t) => t[0] === route.parts[0]) ? route.parts[0] : "bottlenecks";
    tools.innerHTML = `<div class="views">${tabs.map(([k, l]) => `<button data-atab="${k}" class="${k === tab ? "active" : ""}">${esc(l)}</button>`).join("")}</div>`;
    on(tools, "click", "[data-atab]", (e, b) => (location.hash = `#/analytics/${b.dataset.atab}`));
    el.innerHTML = `<div class="loading">Counting…</div>`;
    try {
      await VIEWS[tab](el, route, tools);
    } catch (e) {
      el.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
    on(el, "click", "[data-lead]", (e, x) => {
      e.preventDefault();
      emit("open-peek", { type: "lead", id: x.dataset.lead });
    });
    on(el, "click", "[data-villa]", (e, x) => {
      e.preventDefault();
      emit("open-peek", { type: "villa", id: x.dataset.villa });
    });
  },
};

function weekOptions(sel) {
  const out = [];
  const b = new Date(Date.now() + 8 * 3600e3);
  const monday = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate() - ((b.getUTCDay() + 6) % 7)));
  for (let i = 0; i < 8; i++) {
    const d = new Date(monday.getTime() - i * 7 * 86400e3).toISOString().slice(0, 10);
    out.push(`<option value="${d}" ${d === sel ? "selected" : ""}>${i === 0 ? "This week" : i === 1 ? "Last week" : ""} ${d}</option>`);
  }
  return out.join("");
}

const VIEWS = {
  async bottlenecks(el) {
    const staff = isStaff();
    const b = new Date(Date.now() + 8 * 3600e3);
    const thisMonday = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate() - ((b.getUTCDay() + 6) % 7))).toISOString().slice(0, 10);
    const lastMonday = new Date(new Date(thisMonday).getTime() - 7 * 86400e3).toISOString().slice(0, 10);
    const week = store.get("an-week", lastMonday);
    const prevWeek = new Date(new Date(week).getTime() - 7 * 86400e3).toISOString().slice(0, 10);
    const [g, gp, briefs] = await Promise.all([
      api(`/analytics/gates?week=${week}`),
      api(`/analytics/gates?week=${prevWeek}`).catch(() => null),
      staff ? api("/analytics/briefs").catch(() => ({ items: [] })) : Promise.resolve({ items: [] }),
    ]);
    const brief = (briefs.items || []).find((x) => x.weekStart === g.weekStart);
    const t = g.targets || {};
    const v2 = g.gateViewingToDeal || {};
    const v2p = gp?.gateViewingToDeal || {};
    const y = g.gateYudi;
    const yp = gp?.gateYudi;
    const ystep = (gate, k) => gate?.steps?.find((s) => s.key === k)?.n ?? null;
    const heldAmelia = (v2.viewings || []).length;
    const stuck = g.gateOptionsToViewing?.stuck || [];
    const byStep = {};
    for (const s of stuck) (byStep[s.step] = byStep[s.step] || []).push(s);
    const drafts = g.drafts || [];

    el.innerHTML = `<div class="page stack" style="gap:12px">
      <div class="row"><select class="chip" id="an-week">${weekOptions(week)}</select><span class="faint">Weeks are Monday–Sunday, Bali time. ${week === thisMonday ? "This week is still running." : ""}</span></div>
      ${staff ? `<div class="panel"><h3>Weekly bottleneck brief <span class="faint">${brief ? `written ${rel(brief.generatedAt)} · ${esc(brief.generatedBy || "")}` : "written automatically on Monday 08:30"}</span><button class="btn sm" id="brief-go">${I.sparkle} ${brief ? "Rewrite" : "Write it now"}</button></h3>
        ${brief ? `<div class="brief">${md(brief.content)}</div><div class="row" style="margin-top:8px"><button class="btn sm" id="brief-copy">Copy for the team chat</button></div>` : `<p class="faint" style="margin:0">No brief for this week yet. It reads the numbers below, the objections and the viewing reports, and says where we are stuck, why, and what to do.</p>`}</div>` : ""}
      <div class="kgrid">
        <div class="panel"><h3>Target vs fact · Amelia</h3>
          ${targetRow("Viewings held", heldAmelia, t["amelia.viewings"], (v2p.viewings || []).length)}
          ${targetRow("Contracts signed", v2.contractsSigned ?? 0, t["amelia.deals"], v2p.contractsSigned)}</div>
        ${y ? `<div class="panel"><h3>Target vs fact · Yudi</h3>
          ${targetRow("Inspections held", ystep(y, "held") ?? 0, t["yudi.inspections"], ystep(yp, "held"))}
          ${targetRow("Pre-listed published", y.published ?? 0, t["yudi.prelisted"], yp?.published)}
          ${targetRow("Switched to Listed", ystep(y, "listed") ?? 0, t["yudi.listed"], ystep(yp, "listed"))}</div>` : ""}
      </div>
      <div class="kgrid">
        <div class="panel"><h3>Gate 1 · Options → viewing <span class="faint">clients whose first shortlist went out this week</span></h3>${g.gateOptionsToViewing?.steps ? gateHtml(g.gateOptionsToViewing.steps, gp?.gateOptionsToViewing) : `<span class="faint">no data</span>`}
          <p class="faint" style="font-size:11.5px;margin:8px 0 0">"Viewing offered" is read from our messages (viewing / visit words): the chats do not store it as a fact yet.</p></div>
        <div class="panel"><h3>Where those clients stopped <span class="faint">${stuck.length}</span></h3><div class="stack" style="max-height:340px;overflow:auto">${
          Object.entries(byStep)
            .map(([step, arr]) => `<div class="sect-h">${esc(step)} · ${arr.length}</div>${arr.slice(0, 12).map((s) => `<div class="quote" data-lead="${esc(s.leadId)}" style="cursor:pointer"><b>${esc(nameOf(s))}</b> <span class="pill stage">${esc(s.stage || "")}</span>${s.lastClientText ? `<br>“${esc(String(s.lastClientText).slice(0, 180))}”` : ""}<div class="by">${s.lastClientAt ? "last wrote " + esc(rel(s.lastClientAt)) : "never wrote back"}${s.offeredBy ? " · viewing offered by " + esc(s.offeredBy) : ""}</div></div>`).join("")}`)
            .join("") || `<div class="empty">Nobody stuck — or no shortlists this week.</div>`
        }</div></div>
      </div>
      <div class="panel"><h3>Gate 2 · Viewing → deal <span class="faint">${heldAmelia} viewings held · outcomes: ${Object.entries(v2.outcomes || {}).map(([k, n]) => `${esc(k)} ${n}`).join(" · ") || "—"}</span></h3>
        <div class="tbl-wrap" style="max-height:none"><table class="grid"><thead><tr><th>When</th><th>Client</th><th>Villa</th><th>Outcome</th><th>Client's feedback</th><th>Next step</th><th>Stage now</th></tr></thead><tbody>${
          (v2.viewings || [])
            .map((r) => `<tr data-lead="${esc(r.lead_id)}"><td>${esc(fmtDT(r.viewing_at))}</td><td><b>${esc(nameOf(r))}</b></td><td>${r.property_code ? `<a href="#" data-villa="${esc(r.property_code)}" class="mono">${esc(r.property_code)}</a>` : "—"}</td><td>${r.outcome ? `<span class="pill ${r.outcome === "go" ? "ok" : r.outcome === "no" ? "bad" : "warn"}">${esc(r.outcome)}</span>` : r.report_status === "due" ? `<span class="pill bad">report missing</span>` : "—"}</td><td class="ellip" title="${esc(r.feedback || "")}">${esc(r.feedback || "")}</td><td>${esc((r.next_steps || []).join(", "))}</td><td>${esc(r.lead_stage || "")}</td></tr>`)
            .join("") || `<tr><td colspan="7" class="empty">No viewings held this week.</td></tr>`
        }</tbody></table></div></div>
      ${y ? `<div class="panel"><h3>Yudi's chain · QUALIFIED → inspection → Listed → live <span class="faint">reports still due: ${y.reportsDue ?? "—"}</span></h3>${gateHtml(y.steps, yp)}</div>` : ""}
      ${staff && drafts.length ? `<div class="panel"><h3>What happened to the Copilot's drafts <span class="faint">bot and brokers apart</span></h3><div class="tbl-wrap" style="max-height:none"><table class="grid"><thead><tr><th>Broker</th><th>Kind</th><th>Bot sent</th><th>Sent as written</th><th>Edited</th><th>Skipped</th><th>Untouched</th></tr></thead><tbody>${drafts
        .map((d) => `<tr><td>${esc(d.broker)}</td><td>${esc(d.kind)}</td><td class="num">${d.bot_sent}</td><td class="num">${d.sent_as_is}</td><td class="num">${d.edited}</td><td class="num">${d.skipped}</td><td class="num">${d.untouched}</td></tr>`)
        .join("")}</tbody></table></div></div>` : ""}
    </div>`;
    el.querySelector("#an-week").onchange = (e) => {
      store.set("an-week", e.target.value);
      VIEWS.bottlenecks(el);
    };
    const bg = el.querySelector("#brief-go");
    if (bg)
      bg.onclick = async () => {
        bg.disabled = true;
        bg.textContent = "Writing… (about a minute)";
        try {
          await api("/analytics/briefs", { body: { week } });
          toast("Brief written");
          VIEWS.bottlenecks(el);
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

  async objections(el) {
    const days = Number(store.get("obj-days", 30));
    const r = await api(`/analytics/objections?days=${days}`);
    const cats = r.categories || {};
    const total = r.byCategory.reduce((a, x) => a + x.n, 0);
    const max = Math.max(1, ...r.byCategory.map((x) => x.n));
    const weeks = [...new Set(r.byWeek.map((x) => x.week))].sort();
    const grid = {};
    for (const x of r.byWeek) grid[`${x.category}|${x.week}`] = x.n;
    const byCat = {};
    for (const q of r.recent) (byCat[q.category] = byCat[q.category] || []).push(q);
    el.innerHTML = `<div class="page stack" style="gap:12px">
      <div class="row"><select class="chip" id="obj-days">${[7, 14, 30, 90].map((d) => `<option value="${d}" ${d === days ? "selected" : ""}>Last ${d} days</option>`).join("")}</select>
        <span class="faint">Read every two hours from what Rental clients wrote after getting options, and from filed viewing reports. Last pass ${r.lastScanAt ? esc(rel(r.lastScanAt)) : "not yet"}.</span>
        ${isStaff() ? `<button class="btn sm" id="obj-scan">Read new messages now</button>` : ""}</div>
      <div class="kgrid">
        <div class="panel"><h3>Objections by kind <span class="faint">${total} objections · ${new Set(r.recent.map((x) => x.lead_id)).size} clients</span></h3><div class="bars">${
          r.byCategory.map((x) => `<div class="row"><span>${esc(cats[x.category] || x.category)}</span><div class="b"><i style="width:${Math.round((x.n / max) * 100)}%"></i></div><span class="num">${x.n}</span></div>`).join("") ||
          `<div class="empty">No objections recorded yet. The first pass runs within minutes of the deploy.</div>`
        }</div></div>
        <div class="panel"><h3>By week</h3>${
          weeks.length
            ? `<div class="tbl-wrap" style="max-height:none"><table class="grid"><thead><tr><th>Kind</th>${weeks.map((w) => `<th>${esc(fmtDay(w + "T12:00:00Z"))}</th>`).join("")}</tr></thead><tbody>${r.byCategory
                .map((c) => `<tr><td>${esc(cats[c.category] || c.category)}</td>${weeks.map((w) => `<td class="num">${grid[`${c.category}|${w}`] || ""}</td>`).join("")}</tr>`)
                .join("")}</tbody></table></div>`
            : `<span class="faint">no data yet</span>`
        }</div>
      </div>
      <div class="panel"><h3>In the clients' own words</h3><div class="kgrid">${
        Object.entries(byCat)
          .map(([c, arr]) => `<div><div class="sect-h">${esc(cats[c] || c)} · ${arr.length}</div><div class="stack">${arr.slice(0, 8).map((q) => `<div class="quote" data-lead="${esc(q.lead_id)}" style="cursor:pointer">“${esc(q.quote || "")}”<div class="by">${esc(nameOf(q))} · ${esc(q.source === "viewing-report" ? "viewing report" : "chat")} · ${esc(rel(q.said_at))}${q.lead_stage ? " · " + esc(q.lead_stage) : ""}${q.req_bedrooms ? ` · ${q.req_bedrooms}BR ${esc(q.req_areas || "")} ${q.req_budget_idr_monthly ? money(q.req_budget_idr_monthly) : ""}` : ""}</div></div>`).join("")}</div></div>`)
          .join("") || `<span class="faint">—</span>`
      }</div></div>
      <div class="kgrid">
        <div class="panel"><h3>Viewing reports <span class="faint">${r.viewingReports.length}</span></h3><div class="stack" style="max-height:420px;overflow:auto">${
          r.viewingReports.map((v) => `<div class="quote" data-lead="${esc(v.lead_id)}" style="cursor:pointer"><b>${esc(fmtDay(v.viewing_at))} · <span class="mono">${esc(v.property_code || "")}</span></b> <span class="pill ${v.outcome === "go" ? "ok" : v.outcome === "no" ? "bad" : "warn"}">${esc(v.outcome || "")}</span><br>${esc(v.feedback || "no feedback written")}<div class="by">next: ${esc((v.next_steps || []).join(", ") || "—")} · ${esc(v.responsible_user || "")}</div></div>`).join("") ||
          `<div class="empty">No viewing reports in this period.</div>`
        }</div></div>
        <div class="panel"><h3>Cards closed as lost <span class="faint">${r.lost.length}</span></h3>
          ${r.lostReasons.length ? `<div class="bars" style="margin-bottom:10px">${r.lostReasons.map((x) => `<div class="row"><span>${esc(r.closeReasons[x.reason] || x.reason)}</span><div class="b"><i style="width:${Math.round((x.n / Math.max(...r.lostReasons.map((y) => y.n))) * 100)}%"></i></div><span class="num">${x.n}</span></div>`).join("")}</div>` : `<p class="faint" style="margin:0 0 8px;font-size:12px">Reasons are recorded from now on: closing a card as lost in Unicorn OS asks why. amoCRM never stored them.</p>`}
          <div class="stack" style="max-height:300px;overflow:auto">${r.lost.map((l) => `<div class="note" data-lead="${esc(l.lead_id)}" style="cursor:pointer">#${esc(l.lead_id)} from ${esc(l.from_stage || "—")} · ${esc(rel(l.changed_at))}${l.discard_reason ? `<br><span class="faint">${esc(l.discard_reason)}</span>` : ""}</div>`).join("") || `<span class="faint">none</span>`}</div></div>
      </div></div>`;
    el.querySelector("#obj-days").onchange = (e) => {
      store.set("obj-days", Number(e.target.value));
      VIEWS.objections(el);
    };
    const sc = el.querySelector("#obj-scan");
    if (sc)
      sc.onclick = async () => {
        sc.disabled = true;
        sc.textContent = "Reading…";
        try {
          const x = await api("/analytics/objections/scan", { body: {} });
          toast(`Read ${x.messages} messages and ${x.reports} reports · ${x.found} new objections`);
          VIEWS.objections(el);
        } catch (e) {
          fail(e);
          sc.disabled = false;
        }
      };
  },

  async funnel(el) {
    const pipe = store.get("fun-pipe", "Rental");
    const [f, w] = await Promise.all([api(`/analytics/funnel?pipeline=${encodeURIComponent(pipe)}&weeks=6`), api(`/analytics/waits?pipeline=${encodeURIComponent(pipe)}`)]);
    const p = (S.meta.pipelines || []).find((x) => x.name.toLowerCase() === pipe.toLowerCase());
    const order = (p?.stages || []).map((s) => s.name);
    const weeks = [...new Set(f.arrivals.map((x) => x.week))].sort();
    const stages = [...new Set([...order, ...f.arrivals.map((x) => x.to_stage)])].filter((s) => f.arrivals.some((x) => x.to_stage === s));
    const cell = (s, wk) => f.arrivals.find((x) => x.to_stage === s && x.week === wk)?.n || "";
    const created = (wk) => f.created.find((x) => x.week === wk)?.n || "";
    const waits = [...w.stages].sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage));
    el.innerHTML = `<div class="page stack" style="gap:12px">
      <div class="row"><select class="chip" id="fun-pipe">${["Rental", "Rental Listings", ...(isStaff() ? ["Unicorn"] : [])].map((x) => `<option ${x === pipe ? "selected" : ""}>${x}</option>`).join("")}</select><span class="faint">Cards arriving in each stage per week (from recorded stage moves; moves made by hand in amoCRM may be missing).</span></div>
      <div class="panel"><h3>Arrivals per stage per week</h3><div class="tbl-wrap" style="max-height:none"><table class="grid"><thead><tr><th>Stage</th>${weeks.map((wk) => `<th>${esc(fmtDay(wk + "T12:00:00Z"))}</th>`).join("")}</tr></thead><tbody>
        <tr><td><b>New cards</b></td>${weeks.map((wk) => `<td class="num">${created(wk)}</td>`).join("")}</tr>
        ${stages.map((s) => `<tr><td>${esc(s)}</td>${weeks.map((wk) => `<td class="num">${cell(s, wk)}</td>`).join("")}</tr>`).join("")}</tbody></table></div></div>
      <div class="panel"><h3>Where cards wait now <span class="faint">open cards per stage, days since they arrived there</span></h3><div class="tbl-wrap" style="max-height:none"><table class="grid"><thead><tr><th>Stage</th><th>Cards</th><th>Median days</th><th>&gt; 3 d</th><th>&gt; 7 d</th><th>&gt; 14 d</th><th>Longest waiting</th></tr></thead><tbody>${waits
        .map((s) => `<tr><td>${esc(s.stage)}</td><td class="num">${s.count}</td><td class="num">${s.medianDays.toFixed(1)}</td><td class="num">${s.over3}</td><td class="num" style="${s.over7 ? "color:var(--hot);font-weight:600" : ""}">${s.over7}</td><td class="num">${s.over14}</td><td>${s.cards.slice(0, 4).map((c) => `<a href="#" data-lead="${esc(c.leadId)}">#${esc(c.leadId)}</a> <span class="faint">${Math.floor(c.days)}d</span>`).join(" · ")}</td></tr>`)
        .join("")}</tbody></table></div></div></div>`;
    el.querySelector("#fun-pipe").onchange = (e) => {
      store.set("fun-pipe", e.target.value);
      VIEWS.funnel(el);
    };
  },

  async supply(el) {
    const days = Number(store.get("sup-days", 14));
    const r = await api(`/analytics/supply?days=${days}`);
    el.innerHTML = `<div class="page stack" style="gap:12px">
      <div class="row"><select class="chip" id="sup-days">${[7, 14, 30, 60].map((d) => `<option value="${d}" ${d === days ? "selected" : ""}>Requests of the last ${d} days</option>`).join("")}</select>
      <span class="faint">What clients asked for (area × bedrooms × budget) against published rent villas free within 92 days in the same corridor (70–125% of the budget). Area matching is by name, so treat it as a guide.</span></div>
      <div class="panel"><h3>Most requested segments</h3><div class="tbl-wrap" style="max-height:none"><table class="grid"><thead><tr><th>Area</th><th>BR</th><th>Budget</th><th>Requests</th><th>Matching villas</th><th>Examples</th></tr></thead><tbody>${r.segments
        .map((s) => `<tr><td>${esc(s.area)}</td><td>${esc(s.bedrooms ?? "any")}</td><td>${esc(s.band)}</td><td class="num"><b>${s.requests}</b></td><td class="num" style="${s.matchingVillas === 0 ? "color:var(--hot);font-weight:600" : ""}">${s.matchingVillas}</td><td>${(s.examples || []).map((id) => `<a href="#" data-villa="${esc(id)}" class="mono">${esc(id)}</a>`).join(" ")}</td></tr>`)
        .join("") || `<tr><td colspan="6" class="empty">No requests with readable criteria in this period.</td></tr>`}</tbody></table></div>
      <p class="faint" style="font-size:12px;margin:8px 0 0">A red 0 is a segment to source first: clients are asking and nothing fits.</p></div></div>`;
    el.querySelector("#sup-days").onchange = (e) => {
      store.set("sup-days", Number(e.target.value));
      VIEWS.supply(el);
    };
  },

  async daily(el) {
    const r = await api("/analytics/kpi-url");
    if (!r.url) {
      el.innerHTML = `<div class="empty">The daily numbers page has no key configured on the server.</div>`;
      return;
    }
    el.innerHTML = `<p class="faint" style="margin:0 0 8px">The daily numbers page (traffic, Meta spend, cost per lead, autopilot, Amelia and Yudi) — the same page used for the team chat. <a href="${esc(r.url)}" target="_blank" rel="noopener">Open it on its own ${I.ext}</a></p><iframe class="kpi" src="${esc(r.url)}" title="Daily numbers"></iframe>`;
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
    el.innerHTML = `<div class="page stack" style="gap:12px"><div class="row"><select class="chip" id="cost-days">${[7, 14, 31].map((d) => `<option value="${d}" ${d === days ? "selected" : ""}>Last ${d} days</option>`).join("")}</select><span class="faint">Every AI call is logged with its cost and purpose. A day above twice the median is marked.</span></div>
      <div class="panel"><h3>USD per day</h3><div class="bars">${dayList.map((d) => `<div class="row"><span>${esc(fmtDay(d + "T12:00:00Z"))}</span><div class="b"><i style="width:${Math.round((dayTot(d) / Math.max(...dayList.map(dayTot), 0.01)) * 100)}%;${dayTot(d) > 2 * med ? "background:var(--hot)" : ""}"></i></div><span class="num">$${dayTot(d).toFixed(2)}</span></div>`).join("")}</div></div>
      <div class="panel"><h3>By purpose</h3><div class="tbl-wrap" style="max-height:none"><table class="grid"><thead><tr><th>Purpose</th><th>Total</th>${dayList.map((d) => `<th>${esc(d.slice(5))}</th>`).join("")}</tr></thead><tbody>${labels
        .map((l) => `<tr><td>${esc(l)}</td><td class="num"><b>$${tot(l).toFixed(2)}</b></td>${dayList.map((d) => `<td class="num">${(r.rows.find((x) => x.day === d && x.label === l)?.usd ?? "") === "" ? "" : "$" + r.rows.find((x) => x.day === d && x.label === l).usd.toFixed(2)}</td>`).join("")}</tr>`)
        .join("")}</tbody></table></div></div></div>`;
    el.querySelector("#cost-days").onchange = (e) => {
      store.set("cost-days", Number(e.target.value));
      VIEWS.cost(el);
    };
  },

  async targets(el) {
    const r = await api("/analytics/targets");
    const admin = S.user.role === "admin";
    const LABEL = { "amelia.viewings": "Amelia · viewings held / week", "amelia.deals": "Amelia · contracts signed / week", "yudi.inspections": "Yudi · inspections held / week", "yudi.prelisted": "Yudi · Pre-listed published / week", "yudi.listed": "Yudi · switched to Listed / week" };
    el.innerHTML = `<div class="page stack" style="gap:12px"><div class="panel"><h3>Weekly targets <span class="faint">each with the date it took effect, so old weeks keep their own target</span>${admin ? `<button class="btn sm primary" id="t-new">${I.plus} Change a target</button>` : ""}</h3>
      <div class="tbl-wrap" style="max-height:none"><table class="grid"><thead><tr><th>Target</th><th>Value</th><th>Acceptable from</th><th>From</th><th>Note</th><th>By</th></tr></thead><tbody>${r.items
        .map((x) => `<tr><td>${esc(LABEL[x.key] || x.key)}</td><td class="num"><b>${x.value}</b></td><td class="num">${x.floor ?? ""}</td><td>${esc(x.from)}</td><td class="ellip" title="${esc(x.note || "")}">${esc(x.note || "")}</td><td>${esc(x.by || "")}</td></tr>`)
        .join("")}</tbody></table></div></div></div>`;
    const nb = el.querySelector("#t-new");
    if (nb)
      nb.onclick = async () => {
        const res = await dialog({
          title: "Change a weekly target",
          body: `<div class="stack"><label class="fld"><span>Target</span><select class="in" name="key">${Object.entries(LABEL).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("")}</select></label>
            <div class="grid3"><label class="fld"><span>Value</span><input class="in" type="number" name="value" required min="0"></label><label class="fld"><span>Acceptable from</span><input class="in" type="number" name="floor" min="0"></label><label class="fld"><span>Starts</span><input class="in" type="date" name="from" value="${baliToday()}" required></label></div>
            <label class="fld"><span>Note</span><input class="in" name="note" placeholder="why it changed"></label></div>`,
          actions: [{ label: "Cancel", value: null }, { label: "Save", value: "ok", primary: true }],
        });
        if (!res) return;
        try {
          await api("/analytics/targets", { body: res.values });
          toast("Target saved");
          VIEWS.targets(el);
        } catch (e) {
          fail(e);
        }
      };
  },
};
