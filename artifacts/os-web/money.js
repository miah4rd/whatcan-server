// Unicorn OS — Money (owner, 26.09): the manager's money dashboard and the partners' P&L, in IDR
// with USD in brackets. Revenue comes from amoCRM won deals until the move, then from commissions
// entered here; staff and expenses are entered here from scratch. Nothing is guessed: no source,
// no number.
import { S, api, esc, screens, on, toast, fail, dialog } from "./core.js";

const role = () => S.user?.role;
const seesPnl = () => ["admin", "partner"].includes(role());

let FX = null;
const n0 = (x) => Math.round(x).toLocaleString("en-US");
function short(x) {
  const a = Math.abs(x);
  if (a >= 1e9) return `${(x / 1e9).toFixed(a >= 1e10 ? 1 : 2)}B`;
  if (a >= 1e6) return `${(x / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M`;
  if (a >= 1e3) return `${(x / 1e3).toFixed(0)}K`;
  return n0(x);
}
/** IDR 12.5M (USD 760). */
function idr(x) {
  if (x == null) return `<span class="faint">not set</span>`;
  const usd = FX?.rate ? ` <span class="faint">(USD ${n0(x / FX.rate)})</span>` : "";
  return `IDR ${short(x)}${usd}`;
}
/** The change against the previous period; `good` = "up" when more is better, "down" for costs. */
function delta(now, prev, good = "up") {
  if (now == null || prev == null) return "";
  if (!prev) return now ? `<span class="an-d">new</span>` : "";
  const pct = ((now - prev) / Math.abs(prev)) * 100;
  if (Math.abs(pct) < 0.5) return `<span class="an-d">±0%</span>`;
  const better = good === "up" ? pct > 0 : pct < 0;
  return `<span class="an-d ${better ? "up" : "down"}">${pct > 0 ? "▲" : "▼"} ${Math.abs(pct).toFixed(0)}%</span>`;
}
const tile = (label, value, sub = "") => `<div class="kpi" style="cursor:default"><div class="l">${esc(label)}</div><div class="v" style="font-size:18px">${value}</div><div class="d">${sub}</div></div>`;

// ── periods ──
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const addDays = (d, k) => new Date(Date.parse(d + "T00:00:00Z") + k * 86400e3).toISOString().slice(0, 10);
const PRESETS = [
  ["this-month", "This month"],
  ["last-month", "Last month"],
  ["last-30", "Last 30 days"],
  ["this-quarter", "This quarter"],
  ["this-year", "This year"],
  ["custom", "Pick dates…"],
];
function presetRange(k) {
  const t = today();
  const y = +t.slice(0, 4), m = +t.slice(5, 7);
  const first = (Y, M) => new Date(Date.UTC(Y, M - 1, 1)).toISOString().slice(0, 10);
  if (k === "last-month") return { from: first(y, m - 1), to: addDays(first(y, m), -1) };
  if (k === "last-30") return { from: addDays(t, -29), to: t };
  if (k === "this-quarter") return { from: first(y, Math.floor((m - 1) / 3) * 3 + 1), to: t };
  if (k === "this-year") return { from: first(y, 1), to: t };
  return { from: first(y, m), to: t };
}
let pick = { preset: "this-month", ...presetRange("this-month") };

function periodBar() {
  return `<div class="row" style="gap:6px;flex-wrap:wrap"><select class="chip" id="mn-preset">${PRESETS.map(([k, l]) => `<option value="${k}" ${k === pick.preset ? "selected" : ""}>${l}</option>`).join("")}</select>
    ${pick.preset === "custom" ? `<input type="date" class="chip" id="mn-from" value="${pick.from}"><span class="faint">–</span><input type="date" class="chip" id="mn-to" value="${pick.to}">` : `<span class="faint" style="font-size:12px">${pick.from} – ${pick.to}</span>`}</div>`;
}
function bindPeriod(el, rerender) {
  const p = el.querySelector("#mn-preset");
  if (p) p.onchange = () => { pick = p.value === "custom" ? { ...pick, preset: "custom" } : { preset: p.value, ...presetRange(p.value) }; rerender(); };
  for (const id of ["mn-from", "mn-to"]) {
    const i = el.querySelector("#" + id);
    if (i) i.onchange = () => { pick = { ...pick, [id === "mn-from" ? "from" : "to"]: i.value }; rerender(); };
  }
}
const qs = () => `from=${pick.from}&to=${pick.to}`;

// ── views ──
async function dashboard(el) {
  const d = await api(`/money?${qs()}`);
  FX = d.fx;
  const a = d.now, b = d.prev;
  const rev = a.gciEntered + a.amoValue, revPrev = b.gciEntered + b.amoValue;
  const planPct = d.target ? Math.round((rev / d.target) * 100) : null;
  el.innerHTML = `<div class="page">
    <div class="row" style="justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><h1 class="pt" style="margin:0">Money</h1>${periodBar()}</div>
    <p class="pd">Compared with the ${d.period.days} days before (${d.period.prev.from} – ${d.period.prev.to}). USD at ${FX.rate ? n0(FX.rate) : "—"} IDR (${esc(FX.source)}).</p>
    <div class="grid4" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px">
      ${tile("Won deals", `${a.wonDeals} ${delta(a.wonDeals, b.wonDeals)}`, a.fromAmo ? `${a.fromAmo} from amoCRM` : "")}
      ${tile("Deal value (amoCRM)", `${idr(a.wonValue)} ${delta(a.wonValue, b.wonValue)}`, "as amoCRM holds it")}
      ${tile("Revenue vs plan", `${idr(rev)} ${delta(rev, revPrev)}`, d.target ? `plan ${idr(d.target)} · ${planPct}%` : "plan not set (Settings)")}
      ${tile("Received", `${idr(a.received)} ${delta(a.received, b.received)}`, `pending ${idr(a.pending)}`)}
      ${tile("Average deal", `${a.avgDealValue == null ? "—" : idr(a.avgDealValue)} ${delta(a.avgDealValue, b.avgDealValue)}`)}
      ${tile("Ad spend (Meta)", `${idr(a.adSpend)} ${delta(a.adSpend, b.adSpend, "down")}`)}
      ${tile("Cost per paid lead", `${a.cpl == null ? "—" : idr(a.cpl)} ${delta(a.cpl, b.cpl, "down")}`, `${a.paidLeads} paid of ${a.leads} leads`)}
      ${tile("Ad spend per deal", `${a.costPerDeal == null ? "—" : idr(a.costPerDeal)} ${delta(a.costPerDeal, b.costPerDeal, "down")}`)}
      ${tile("Fell through", `${a.fellThrough} ${delta(a.fellThrough, b.fellThrough, "down")}`)}
    </div>
    <div class="grid2" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px;margin-top:16px">
      <div class="panel"><h3>By broker</h3>${a.byBroker.length ? `<table class="grid"><thead><tr><th>Broker</th><th>Deals</th><th>Deal value</th><th>Commission</th></tr></thead><tbody>${a.byBroker.map((x) => `<tr><td>${esc(x.name)}</td><td>${x.deals}</td><td>${idr(x.value)}</td><td>${x.commission ? idr(x.commission) : `<span class="faint">—</span>`}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">No won deals in this period.</div>`}</div>
      <div class="panel"><h3>By funnel</h3>${a.byFunnel.length ? `<table class="grid"><thead><tr><th>Funnel</th><th>Deals</th><th>Deal value</th></tr></thead><tbody>${a.byFunnel.map((x) => `<tr><td>${esc(x.name)}</td><td>${x.deals}</td><td>${idr(x.value)}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">No won deals in this period.</div>`}</div>
    </div>
    <div class="help" style="margin-top:14px">Until the move, revenue is the value of won deals in amoCRM. After it, enter each deal's commission under Commissions; an entered deal replaces its amoCRM value everywhere.</div>
  </div>`;
}

async function pnl(el) {
  const d = await api(`/money/pnl?${qs()}`);
  FX = d.fx;
  const a = d.now, b = d.prev;
  const line = (label, x, y, good = "up", cls = "") => `<tr class="${cls}"><td>${label}</td><td style="text-align:right">${idr(x)}</td><td style="text-align:right">${idr(y)}</td><td style="text-align:right">${delta(x, y, good)}</td></tr>`;
  const sub = (label, x) => `<tr><td style="padding-left:26px" class="faint">${esc(label)}</td><td style="text-align:right" class="faint">${idr(x)}</td><td></td><td></td></tr>`;
  el.innerHTML = `<div class="page">
    <div class="row" style="justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><h1 class="pt" style="margin:0">P&L</h1>${periodBar()}</div>
    <p class="pd">Partners' view. Previous period: ${d.period.prev.from} – ${d.period.prev.to}. USD at ${FX.rate ? n0(FX.rate) : "—"} IDR (${esc(FX.source)}).</p>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin-bottom:14px">
      ${tile("Revenue", `${idr(a.revenue.gci)} ${delta(a.revenue.gci, b.revenue.gci)}`, a.revenue.amoDeals ? `${a.revenue.amoDeals} deals at amoCRM value` : "")}
      ${tile("Company dollar", `${idr(a.companyDollar)} ${delta(a.companyDollar, b.companyDollar)}`, "after brokers' commission")}
      ${tile("Operating costs", `${idr(a.opex.total)} ${delta(a.opex.total, b.opex.total, "down")}`)}
      ${tile("Net profit", `${idr(a.net)} ${delta(a.net, b.net)}`, a.margin == null ? "" : `margin ${a.margin.toFixed(0)}%`)}
      ${tile("Break-even revenue", a.breakEvenGci == null ? "—" : idr(a.breakEvenGci), "revenue that covers the costs")}
    </div>
    <div class="panel"><table class="grid" style="font-size:13px"><thead><tr><th>Line</th><th style="text-align:right">This period</th><th style="text-align:right">Before</th><th style="text-align:right">Change</th></tr></thead><tbody>
      ${line("<b>Revenue</b>", a.revenue.gci, b.revenue.gci)}
      ${a.revenue.entered ? sub("Commissions entered in the OS", a.revenue.entered) : ""}
      ${a.revenue.fromAmoValue ? sub("amoCRM won deal value (until the move)", a.revenue.fromAmoValue) : ""}
      ${line(`Brokers' commission${a.costOfSales.fromShare ? ` <span class="faint">(${d.settings.broker_share_pct}% of amoCRM value)</span>` : ""}`, a.costOfSales.brokers, b.costOfSales.brokers, "down")}
      ${line("<b>Company dollar</b>", a.companyDollar, b.companyDollar)}
      ${line("Advertising (Meta)", a.opex.ads, b.opex.ads, "down")}
      ${line(`AI <span class="faint">(USD ${a.opex.aiUsd.toFixed(0)})</span>`, a.opex.ai, b.opex.ai, "down")}
      ${line("Staff", a.opex.staff, b.opex.staff, "down")}
      ${a.opex.staffLines.map((s) => sub(s.name, s.amount)).join("")}
      ${line("Other expenses", a.opex.expenses, b.opex.expenses, "down")}
      ${a.opex.expenseCategories.map((s) => sub(s.name, s.amount)).join("")}
      ${line("<b>Operating costs</b>", a.opex.total, b.opex.total, "down")}
      ${line("<b>Net profit</b>", a.net, b.net)}
    </tbody></table></div>
    <div class="help" style="margin-top:14px">Monthly amounts (salaries, rent, subscriptions) are spread over the days of the period. Staff and expenses are entered under Staff & expenses.</div>
  </div>`;
}

// ── entries ──
const FIELDS = {
  commissions: [
    ["title", "Deal", "text", true], ["funnel", "Funnel", ["Rental", "Sales", "Other"]], ["broker", "Broker", "text"], ["amo_lead_id", "amoCRM lead id", "text"],
    ["deal_value_idr", "Deal value, IDR", "money"], ["commission_idr", "Our commission, IDR", "money", true], ["broker_idr", "Broker's share, IDR", "money"],
    ["status", "Status", ["pending", "earned", "received", "fell_through"]], ["closed_on", "Closed on", "date", true], ["received_on", "Received on", "date"], ["note", "Note", "text"],
  ],
  staff: [["name", "Name", "text", true], ["role", "Role", "text"], ["monthly_idr", "Monthly cost, IDR", "money", true], ["start_date", "Start", "date", true], ["end_date", "End", "date"], ["note", "Note", "text"]],
  expenses: [
    ["name", "Expense", "text", true], ["category", "Category", ["Office", "Software", "Marketing", "Transport", "Legal & tax", "Other"]], ["amount_idr", "Amount, IDR", "money", true],
    ["recurring", "Every month", "check"], ["start_date", "Date / start", "date", true], ["end_date", "End (monthly only)", "date"], ["note", "Note", "text"],
  ],
};
const TITLES = { commissions: "commission", staff: "person", expenses: "expense" };
const val = (r, k) => (r?.[k] == null ? "" : String(r[k]).slice(0, k.endsWith("_date") || k.endsWith("_on") ? 10 : 500));

async function editEntry(kind, row, done) {
  const f = FIELDS[kind];
  const input = ([k, label, type, req]) => {
    if (Array.isArray(type)) return `<label class="fld"><span>${label}</span><select class="in" name="${k}">${type.map((o) => `<option ${val(row, k) === o ? "selected" : ""}>${o}</option>`).join("")}</select></label>`;
    if (type === "check") return `<label class="fld" style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" name="${k}" ${row?.[k] ? "checked" : ""}><span>${label}</span></label>`;
    return `<label class="fld"><span>${label}${req ? " *" : ""}</span><input class="in" name="${k}" type="${type === "date" ? "date" : "text"}" ${type === "money" ? `inputmode="numeric" placeholder="e.g. 15000000"` : ""} value="${esc(val(row, k))}"></label>`;
  };
  const r = await dialog({
    title: `${row ? "Edit" : "Add"} ${TITLES[kind]}`,
    body: `<div class="grid2">${f.map(input).join("")}</div>`,
    actions: [...(row ? [{ label: "Delete", value: "delete" }] : []), { label: "Cancel", value: null }, { label: "Save", value: "ok", primary: true }],
  });
  if (!r) return;
  try {
    if (r.action === "delete") await api(`/money/${kind}/${row.id}`, { method: "DELETE" });
    else await api(row ? `/money/${kind}/${row.id}` : `/money/${kind}`, { method: row ? "PUT" : "POST", body: r.values });
    toast(r.action === "delete" ? "Deleted" : "Saved");
    done();
  } catch (e) {
    fail(e);
  }
}

async function entries(el, kinds) {
  const d = await api("/money/entries");
  FX = d.fx;
  const cell = (r, [k, , type]) => (type === "money" ? (r[k] == null ? "—" : idr(Number(r[k]))) : type === "check" ? (r[k] ? "monthly" : "once") : esc(val(r, k) || "—"));
  el.innerHTML = `<div class="page">${kinds.map((kind) => {
    const rows = d[kind];
    const cols = FIELDS[kind].filter(([k]) => k !== "note");
    return `<div class="row" style="justify-content:space-between;align-items:center;margin:${kind === kinds[0] ? 0 : 22}px 0 8px"><h2 style="margin:0;font-size:15px">${{ commissions: "Commissions", staff: "Staff", expenses: "Expenses" }[kind]}</h2><button class="btn sm primary" data-add="${kind}">Add ${TITLES[kind]}</button></div>
      ${rows.length ? `<div class="tbl-wrap" style="max-height:none"><table class="grid"><thead><tr>${cols.map(([, l]) => `<th>${esc(l)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr data-edit="${kind}:${r.id}">${cols.map((c) => `<td>${cell(r, c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : `<div class="empty">${kind === "commissions" ? "No commissions yet. They are entered here after the move from amoCRM; until then the dashboard uses amoCRM deal values." : "Nothing entered yet."}</div>`}`;
  }).join("")}</div>`;
  const again = () => entries(el, kinds);
  el.onclick = (e) => {
    const add = e.target.closest("[data-add]");
    if (add) return editEntry(add.dataset.add, null, again);
    const tr = e.target.closest("[data-edit]");
    if (!tr) return;
    const [kind, id] = tr.dataset.edit.split(":");
    editEntry(kind, d[kind].find((x) => String(x.id) === id), again);
  };
}

async function settings(el) {
  const d = await api("/money/entries");
  const s = d.settings;
  el.innerHTML = `<div class="page" style="max-width:640px"><h1 class="pt">Money settings</h1>
    <div class="panel stack" style="gap:12px">
      <label class="fld"><span>Monthly revenue plan, IDR</span><input class="in" id="ms-plan" inputmode="numeric" value="${s.monthly_gci_target_idr ?? ""}" placeholder="not set"></label>
      <label class="fld"><span>Brokers' share of revenue, % <span class="faint">(for amoCRM deals until commissions are entered)</span></span><input class="in" id="ms-share" inputmode="decimal" value="${s.broker_share_pct ?? ""}" placeholder="not set"></label>
      <label class="fld"><span>USD rate, IDR per 1 USD <span class="faint">(empty = market rate, now ${d.fx.rate ? n0(d.fx.rate) : "—"})</span></span><input class="in" id="ms-fx" inputmode="numeric" value="${s.fx_manual_idr_per_usd ?? ""}" placeholder="market rate"></label>
      <div><button class="btn primary" id="ms-save">Save</button></div>
    </div>
    <div class="help" style="margin-top:12px">The bonus scheme comes later, on top of the commission table.</div></div>`;
  el.querySelector("#ms-save").onclick = async () => {
    const num = (id) => el.querySelector(id).value.replace(/[\s,_]/g, "");
    try {
      await api("/money/settings", { method: "PUT", body: { monthly_gci_target_idr: num("#ms-plan"), broker_share_pct: num("#ms-share"), fx_manual_idr_per_usd: num("#ms-fx") } });
      toast("Saved");
    } catch (e) {
      fail(e);
    }
  };
}

screens.money = {
  title: "Money",
  async render({ el, tools, route }) {
    const tabs = [["dashboard", "Dashboard"], ...(seesPnl() ? [["pnl", "P&L"]] : []), ["commissions", "Commissions"], ...(seesPnl() ? [["costs", "Staff & expenses"], ["settings", "Settings"]] : [])];
    const tab = tabs.some(([k]) => k === route.parts[0]) ? route.parts[0] : "dashboard";
    tools.innerHTML = `<div class="views">${tabs.map(([k, l]) => `<button data-mt="${k}" class="${k === tab ? "active" : ""}">${l}</button>`).join("")}</div>`;
    on(tools, "click", "[data-mt]", (e, b) => (location.hash = `#/money/${b.dataset.mt}`));
    el.onclick = null;
    el.innerHTML = `<div class="loading">Counting…</div>`;
    const rerender = () => screens.money.render({ el, tools, route });
    if (tab === "pnl") await pnl(el);
    else if (tab === "commissions") await entries(el, ["commissions"]);
    else if (tab === "costs") await entries(el, ["staff", "expenses"]);
    else if (tab === "settings") await settings(el);
    else await dashboard(el);
    bindPeriod(el, rerender);
  },
};
