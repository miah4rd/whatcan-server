/**
 * The owner's daily numbers page (lib/kpi-dashboard.ts has what each number means and where it
 * comes from).
 *
 * GET  /kpi?k=KEY                       the page (English; the owner posts it to the team chat)
 * GET  /kpi/data?k=KEY&to=YYYY-MM-DD&days=7   the numbers as JSON
 * POST /kpi/pull-spend (x-admin-token)  pull Meta spend from the Make scenario now (it runs every 4h)
 *
 * `kpi_dashboard_key` in broker_settings opens the page; no key stored → nothing opens.
 */
import { Router } from "express";
import { pool } from "@workspace/db";
import { buildKpi, baliDate, pullMetaSpend } from "../lib/kpi-dashboard";

const router = Router();

async function setting(key: string): Promise<string | null> {
  const r = await pool.query(`SELECT value FROM broker_settings WHERE key = $1`, [key]);
  return (r.rows[0] as { value?: string } | undefined)?.value ?? null;
}

async function allowed(k: unknown): Promise<boolean> {
  const key = await setting("kpi_dashboard_key");
  return Boolean(key) && typeof k === "string" && k === key;
}

router.get("/kpi", async (req, res) => {
  if (!(await allowed(req.query["k"]))) {
    res.status(403).type("text/plain").send("Forbidden");
    return;
  }
  res.set("Cache-Control", "no-store").type("html").send(PAGE_HTML);
});

router.get("/kpi/data", async (req, res) => {
  if (!(await allowed(req.query["k"]))) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query["to"] ?? "")) ? String(req.query["to"]) : baliDate();
  const days = Number(req.query["days"]) || 7;
  try {
    res.set("Cache-Control", "no-store").json(await buildKpi(to, days));
  } catch (err) {
    req.log.error({ err }, "kpi failed");
    res.status(500).json({ error: "kpi failed" });
  }
});

/** Pull Meta spend now (admin token): POST /kpi/pull-spend with x-admin-token. */
router.post("/kpi/pull-spend", async (req, res) => {
  const token = process.env["ADMIN_TOKEN"];
  const given = req.get("x-admin-token") ?? (req.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token || given !== token) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  res.json({ result: await pullMetaSpend() });
});

// The page. Client code below uses no backticks and no dollar-brace: it lives in String.raw.
const PAGE_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Daily Numbers</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📊</text></svg>">
<style>
:root {
  --bg: #f6f7f9; --card: #ffffff; --ink: #14171f; --muted: #667085; --line: #e4e7ec;
  --accent: #2f6fed; --good: #12825b; --warn: #b54708; --bad: #c01048; --soft: #eef2fb; --sel: #fff7e0;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #0f1218; --card: #171b24; --ink: #e8eaf0; --muted: #98a2b3; --line: #2a303c;
    --accent: #7aa2ff; --good: #4ccf9a; --warn: #f7b155; --bad: #ff7aa2; --soft: #1d2433; --sel: #2b2616; color-scheme: dark; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink);
  font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.wrap { max-width: 1180px; margin: 0 auto; padding: 16px; }
header { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; margin-bottom: 14px; }
h1 { font-size: 20px; margin: 0; letter-spacing: -0.01em; }
.sub { color: var(--muted); font-size: 12px; }
.controls { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
button, input[type=date], select { font: inherit; border: 1px solid var(--line); background: var(--card); color: var(--ink);
  border-radius: 8px; padding: 6px 10px; min-height: 34px; }
button { cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 14px; }
@media (max-width: 420px) { .tiles { grid-template-columns: 1fr 1fr; } .tile .value { font-size: 22px; } }
.tile { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; }
.tile .label { color: var(--muted); font-size: 12px; }
.tile .value { font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; margin-top: 2px; }
.tile .note { color: var(--muted); font-size: 12px; margin-top: 2px; }
section { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px; margin-bottom: 14px; }
section h2 { font-size: 15px; margin: 0 0 2px; }
section .hint { color: var(--muted); font-size: 12px; margin: 0 0 10px; }
.scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { padding: 6px 8px; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; }
th:first-child, td:first-child { text-align: left; white-space: normal; min-width: 190px; position: sticky; left: 0; background: var(--card); }
thead th { color: var(--muted); font-weight: 500; font-size: 12px; }
td.sel, th.sel { background: var(--sel); font-weight: 700; }
td.tot, th.tot { border-left: 1px solid var(--line); font-weight: 600; }
tr.group td { background: var(--soft); font-weight: 600; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .03em; }
tr.group td:first-child { background: var(--soft); }
.z { color: var(--muted); opacity: .55; }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 10px; }
.kv { display: flex; justify-content: space-between; gap: 8px; padding: 5px 0; border-bottom: 1px dashed var(--line); }
.kv:last-child { border-bottom: 0; }
.kv b { font-variant-numeric: tabular-nums; }
.bad { color: var(--bad); } .warn { color: var(--warn); } .good { color: var(--good); }
.bar { height: 8px; border-radius: 4px; background: var(--soft); overflow: hidden; margin-top: 6px; }
.bar i { display: block; height: 100%; background: var(--accent); }
.target { padding: 8px 0; }
.target .row { display: flex; justify-content: space-between; }
.person h3 { margin: 0 0 2px; font-size: 15px; }
.muted { color: var(--muted); }
.toast { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); background: var(--ink); color: var(--bg);
  padding: 8px 14px; border-radius: 8px; opacity: 0; transition: opacity .2s; pointer-events: none; }
.toast.on { opacity: 1; }
.err { background: var(--card); border: 1px solid var(--bad); color: var(--bad); padding: 12px; border-radius: 10px; }
footer { color: var(--muted); font-size: 12px; padding: 4px 2px 24px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>Unicorn Property: daily numbers</h1>
      <div class="sub" id="sub">Loading…</div>
    </div>
    <div class="controls">
      <button id="prev" title="Previous day">‹</button>
      <input type="date" id="day">
      <button id="next" title="Next day">›</button>
      <select id="span"><option value="7">7 days</option><option value="14">14 days</option><option value="30">30 days</option></select>
      <button class="primary" id="copy">Copy for chat</button>
    </div>
  </header>
  <div id="app"></div>
  <footer id="foot"></footer>
</div>
<div class="toast" id="toast">Copied</div>
<script>
(function () {
  var params = new URLSearchParams(location.search);
  var KEY = params.get("k") || "";
  var state = { day: params.get("day") || "", span: params.get("days") || "7", data: null };
  var el = function (id) { return document.getElementById(id); };

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function fmt(n) { if (n == null || isNaN(n)) return "–"; return Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 }); }
  function money(n, cur) {
    if (n == null || isNaN(n)) return "–";
    var c = cur || "";
    if (c === "IDR") return "IDR " + (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : fmt(n));
    return (c === "USD" ? "$" : c ? c + " " : "") + Number(n).toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0 });
  }
  function sum(s) { var t = 0; for (var k in s) t += s[k] || 0; return t; }
  function add() { var out = {}; var args = arguments; state.data.days.forEach(function (d) { var t = 0; for (var i = 0; i < args.length; i++) t += (args[i] && args[i][d]) || 0; out[d] = t; }); return out; }
  function dlabel(d) { var x = new Date(d + "T00:00:00Z"); return x.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }); }
  function short(d) { var x = new Date(d + "T00:00:00Z"); return x.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }); }

  function table(rows) {
    var days = state.data.days, sel = state.data.days[state.data.days.length - 1];
    var h = '<div class="scroll"><table><thead><tr><th></th>';
    days.forEach(function (d) { h += '<th class="' + (d === sel ? "sel" : "") + '">' + esc(short(d)) + "</th>"; });
    h += '<th class="tot">Total</th></tr></thead><tbody>';
    rows.forEach(function (r) {
      if (r.group) { h += '<tr class="group"><td colspan="' + (days.length + 2) + '">' + esc(r.group) + "</td></tr>"; return; }
      h += "<tr><td>" + esc(r.label) + (r.hint ? ' <span class="muted">· ' + esc(r.hint) + "</span>" : "") + "</td>";
      days.forEach(function (d) {
        var v = r.s[d];
        var txt = r.money ? money(v, r.cur) : fmt(v);
        h += '<td class="' + (d === sel ? "sel " : "") + (!v ? "z" : "") + '">' + (v ? txt : (r.money ? "–" : "0")) + "</td>";
      });
      var t = r.total != null ? r.total : sum(r.s);
      h += '<td class="tot">' + (r.money ? money(t, r.cur) : fmt(t)) + "</td></tr>";
    });
    return h + "</tbody></table></div>";
  }

  function tile(label, value, note, cls) {
    return '<div class="tile"><div class="label">' + esc(label) + '</div><div class="value ' + (cls || "") + '">' + value + '</div>' + (note ? '<div class="note">' + note + "</div>" : "") + "</div>";
  }
  function target(label, got, of) {
    var pct = of ? Math.min(100, Math.round(got / of * 100)) : 0;
    return '<div class="target"><div class="row"><span>' + esc(label) + '</span><b class="' + (got >= of ? "good" : "") + '">' + fmt(got) + " / " + fmt(of) + '</b></div><div class="bar"><i style="width:' + pct + '%"></i></div></div>';
  }

  function derive() {
    var D = state.data, T = D.traffic, L = T.leads, days = D.days;
    var c = L.clients || {}, s = L.sales || {}, o = L.owners || {};
    var paidClients = add(c.paid_meta_form, c.paid_website, s.paid_meta_form, s.paid_website);
    var organicClients = add(c.organic_website, c.fb_groups, c.instagram, c.direct, s.organic_website, s.fb_groups, s.instagram, s.direct);
    var allPaid = add(paidClients, o.paid_meta_form);
    var cpl = {}; days.forEach(function (d) { cpl[d] = allPaid[d] ? T.ads.spend[d] / allPaid[d] : 0; });
    return { c: c, s: s, o: o, paidClients: paidClients, organicClients: organicClients, allPaid: allPaid, cpl: cpl };
  }

  function render() {
    var D = state.data, T = D.traffic, A = D.autopilot, days = D.days, sel = days[days.length - 1];
    var x = derive(), cur = T.ads.currency;
    var totalSpend = sum(T.ads.spend), totalPaid = sum(x.allPaid);
    el("sub").textContent = "Selected day " + dlabel(sel) + " · Bali time" + (sel === D.today ? " · today so far" : "");
    var amelia = D.brokers.find(function (b) { return b.name === "Amelia"; });
    var yudi = D.brokers.find(function (b) { return b.name === "Yudi"; });
    var h = "";

    // Tiles for the selected day
    h += '<div class="tiles">';
    h += tile("New client leads", fmt(x.paidClients[sel] + x.organicClients[sel]), fmt(x.paidClients[sel]) + " paid · " + fmt(x.organicClients[sel]) + " organic");
    h += tile("Ad spend (Meta)", T.ads.spendUpdatedAt ? money(T.ads.spend[sel], cur) : "–", T.ads.spendUpdatedAt ? ("Cost per lead " + (x.allPaid[sel] ? money(x.cpl[sel], cur) : "–")) : "Waiting for the Meta feed");
    h += tile("New owner leads", fmt(add(x.o.owner_outreach, x.o.owner_referral, x.o.owner_other, x.o.paid_meta_form)[sel]), "Rental Listings");
    h += tile("Autopilot messages", fmt(A.listings.messagesSent[sel] + A.weeklyCheck.sent[sel] + A.rental.adInstantReplies[sel] + A.rental.autoSent[sel]), fmt(A.listings.ownersMessaged[sel]) + " owners reached");
    if (amelia) h += tile("Amelia: viewings", fmt(amelia.viewings.held[sel]), fmt(amelia.viewings.agreed[sel]) + " newly agreed");
    if (yudi) h += tile("Yudi: inspections", fmt(yudi.inspections.due[sel]), fmt(yudi.inspections.listed[sel]) + " switched to Listed");
    h += "</div>";

    // Week to date
    var W = D.week;
    h += '<section><h2>This week vs target</h2><p class="hint">Week from ' + esc(short(W.weekStart)) + " (Mon), day " + W.daysIn + " of 7. Targets set by the owner on 14.09.</p><div class=\"grid2\">";
    h += "<div><b>Amelia</b>" + target("Viewings held", W.amelia.viewings, W.amelia.viewingsTarget) + target("Deals won", W.amelia.deals, W.amelia.dealsTarget) + "</div>";
    h += "<div><b>Yudi</b>" + target("Listings published (Pre-listed)", W.yudi.published, W.yudi.publishedTarget) + target("Inspected → Listed on site", W.yudi.listed, W.yudi.listedTarget) + "</div>";
    h += "</div></section>";

    // Traffic
    var L = function (seg, ch) { return (T.leads[seg] || {})[ch] || {}; };
    h += '<section><h2>Traffic</h2><p class="hint">New amoCRM cards by source (Source field, UTM, tags). Paid = Meta lead forms + website visits from a paid click.</p>';
    var rows = [
      { group: "Clients (Rental + Sales)" },
      { label: "Paid, total", s: x.paidClients },
      { label: "Meta lead form", s: add(L("clients", "paid_meta_form"), L("sales", "paid_meta_form")) },
      { label: "Website, paid click", s: add(L("clients", "paid_website"), L("sales", "paid_website")) },
      { label: "Organic, total", s: x.organicClients },
      { label: "Website, organic", s: add(L("clients", "organic_website"), L("sales", "organic_website")) },
      { label: "Facebook groups (scout)", s: add(L("clients", "fb_groups"), L("sales", "fb_groups")) },
      { label: "Instagram", s: add(L("clients", "instagram"), L("sales", "instagram")) },
      { label: "Direct / WhatsApp / other", s: add(L("clients", "direct"), L("sales", "direct")) },
      { label: "of which Sales pipeline", hint: "all sources", s: add(L("sales", "paid_meta_form"), L("sales", "paid_website"), L("sales", "organic_website"), L("sales", "fb_groups"), L("sales", "instagram"), L("sales", "direct")) },
      { group: "Villa owners (Rental Listings)" },
      { label: "Owner outreach (AI scout)", s: L("owners", "owner_outreach") },
      { label: "Owner referral", s: L("owners", "owner_referral") },
      { label: "Meta lead form (owners)", s: L("owners", "paid_meta_form") },
      { label: "Other", s: L("owners", "owner_other") },
      { group: "Paid media (Meta Ads)" },
      { label: "Spend", s: T.ads.spend, money: true, cur: cur },
      { label: "Impressions", s: T.ads.impressions },
      { label: "Link clicks", s: T.ads.linkClicks },
      { label: "Leads counted by Meta", s: T.ads.metaLeads },
      { label: "Paid leads in amoCRM", s: x.allPaid },
      { label: "Cost per paid lead", hint: "spend ÷ amoCRM paid leads", s: x.cpl, money: true, cur: cur, total: totalPaid ? totalSpend / totalPaid : 0 }
    ];
    h += table(rows);
    if (!T.ads.spendUpdatedAt) h += '<p class="hint warn">No Meta spend received yet for these days. It is pulled every 4 hours from the Make scenario &ldquo;whatcan KPI: Meta ad spend on request&rdquo;.</p>';
    else h += '<p class="hint">Spend last updated ' + esc(new Date(T.ads.spendUpdatedAt).toLocaleString("en-GB", { timeZone: "Asia/Makassar" })) + " (Bali). Meta days follow the ad account's time zone.</p>";
    if (T.ads.campaigns.length) {
      h += '<div class="scroll"><table><thead><tr><th>Campaign (whole period)</th><th>Spend</th><th>Meta leads</th><th>Per lead</th></tr></thead><tbody>';
      T.ads.campaigns.forEach(function (cp) { h += "<tr><td>" + esc(cp.name) + "</td><td>" + money(cp.spend, cur) + "</td><td>" + fmt(cp.metaLeads) + "</td><td>" + (cp.metaLeads ? money(cp.spend / cp.metaLeads, cur) : "–") + "</td></tr>"; });
      h += "</tbody></table></div>";
    }
    h += "</section>";

    // Autopilot
    var wc = A.weeklyCheck;
    h += '<section><h2>Autopilot</h2><p class="hint">Messages the bot sent by itself (nobody pressed approve) and the stage moves it made. Never counted as broker work.</p>';
    h += table([
      { group: "Listing qualification (villa owners)" },
      { label: "Messages sent to owners", s: A.listings.messagesSent },
      { label: "Owners messaged", s: A.listings.ownersMessaged },
      { label: "First contact with a new owner", s: A.listings.firstContacts },
      { label: "Owners who replied", s: A.listings.ownersReplied },
      { label: "→ TAKEN TO WORK", s: A.listings.takenToWork },
      { label: "→ QUALIFIED (Pre-listed)", s: A.listings.qualified },
      { label: "→ co-broke", s: A.listings.coBroke },
      { label: "→ long term", s: A.listings.longTerm },
      { label: "→ Closed lost", s: A.listings.closedLost },
      { group: "Weekly availability check (live listings)" },
      { label: "Checks sent", s: wc.sent },
      { label: "Owner answered", s: wc.answered },
      { label: "Clear answer", s: wc.clearAnswers },
      { label: "Availability confirmed/updated on site", s: wc.siteUpdated },
      { group: "Clients (Rental)" },
      { label: "Instant replies to ad leads", s: A.rental.adInstantReplies },
      { label: "Other auto-sent client messages", s: A.rental.autoSent }
    ]);
    var covCls = wc.liveListings && wc.liveAskedLast7d < wc.liveListings ? "warn" : "good";
    h += '<p class="hint">Right now: <b>' + fmt(wc.liveListings) + "</b> listings in live / weekly-check stages; <b class=\"" + covCls + "\">" + fmt(wc.liveAskedLast7d) + "</b> heard from us in the last 7 days (" + fmt(wc.liveWeeklyCheckLast7d) + " by the weekly check). Weekly check mode: <b>" + esc(wc.mode) + "</b>.</p>";
    h += "</section>";

    // Brokers
    D.brokers.forEach(function (b) {
      var m = b.messages;
      h += '<section class="person"><h3>' + esc(b.name) + '</h3><p class="hint">' + esc(b.role) + ". Only what " + esc(b.name) + " did personally: approved or edited in Copilot, or sent from the phone.</p>";
      var r = [
        { group: "Communication" },
        { label: "Messages via Copilot", s: m.viaCopilot },
        { label: "Messages from phone (WhatsApp)", s: m.fromPhone },
        { label: "People written to", s: m.peopleWritten },
        { label: "People who wrote in", s: m.peopleWroteIn }
      ];
      if (b.viewings) r = r.concat([
        { group: "Viewings" },
        { label: "Viewings agreed", hint: "by agreement day", s: b.viewings.agreed },
        { label: "Viewings held", hint: "by viewing day", s: b.viewings.held },
        { label: "Viewing reports filed", s: b.viewings.reportsFiled },
        { label: "Deals won", s: b.dealsWon }
      ]);
      if (b.inspections) r = r.concat([
        { group: "Inspections and listings" },
        { label: "Inspections agreed", hint: "by agreement day", s: b.inspections.agreed },
        { label: "Inspections scheduled", hint: "by visit day", s: b.inspections.due },
        { label: "Switched Pre-listed → Listed", hint: "site", s: b.inspections.listed },
        { label: "Listings published (Pre-listed)", hint: "site", s: b.inspections.published }
      ]);
      if (b.tasks) r = r.concat([
        { group: "amoCRM tasks closed" },
        { label: "Closed by " + b.name, s: b.tasks.doneByBroker },
        { label: "Closed automatically by Copilot", s: b.tasks.doneAuto }
      ]);
      h += table(r);
      h += '<div class="grid2" style="margin-top:10px">';
      if (b.tasks) {
        var t = b.tasks;
        h += "<div><b>Tasks right now</b> <span class=\"muted\">(" + esc(b.pipeline) + " funnel)</span>" +
          '<div class="kv"><span>Open tasks on open cards</span><b>' + fmt(t.open) + "</b></div>" +
          '<div class="kv"><span>Overdue</span><b class="' + (t.overdue ? "bad" : "good") + '">' + fmt(t.overdue) + "</b></div>" +
          '<div class="kv"><span>Overdue more than 1 / 3 / 7 days</span><b>' + fmt(t.overdue1d) + " / " + fmt(t.overdue3d) + " / " + fmt(t.overdue7d) + "</b></div>" +
          '<div class="kv"><span>Typical delay (median) · oldest</span><b>' + t.medianOverdueDays + " d · " + fmt(t.oldestOverdueDays) + " d</b></div>" +
          '<div class="kv"><span class="muted">Clean-up: open tasks in other funnels (old Sales cards)</span><b class="muted">' + fmt(t.cleanupOtherFunnels) + "</b></div>" +
          '<div class="kv"><span class="muted">Clean-up: open tasks on closed / archived cards</span><b class="muted">' + fmt(t.cleanupArchived) + "</b></div></div>";
      } else h += '<div class="muted">amoCRM tasks could not be read.</div>';
      if (b.inbox) {
        var i = b.inbox;
        h += "<div><b>Copilot inbox right now</b>" +
          '<div class="kv"><span>Waiting for our reply</span><b class="' + (i.waiting ? "warn" : "good") + '">' + fmt(i.waiting) + "</b></div>" +
          '<div class="kv"><span>…waiting more than 24h</span><b class="' + (i.waitingOverdue ? "bad" : "good") + '">' + fmt(i.waitingOverdue) + "</b></div>" +
          '<div class="kv"><span>Overdue follow-ups</span><b>' + fmt(i.overdueFollowups) + "</b></div>" +
          '<div class="kv"><span>Promises not kept yet</span><b>' + fmt(i.openPromises) + "</b></div>" +
          '<div class="kv"><span>Drafts never opened (today)</span><b>' + fmt(i.untouchedDrafts) + "</b></div></div>";
      }
      h += "</div></section>";
    });

    el("app").innerHTML = h;
    el("foot").textContent = "Generated " + new Date(D.generatedAt).toLocaleString("en-GB", { timeZone: "Asia/Makassar" }) + " Bali. Sources: amoCRM, Copilot, the website database, Meta Ads via Make.";
  }

  function chatText() {
    var D = state.data, T = D.traffic, A = D.autopilot, d = D.days[D.days.length - 1], x = derive(), cur = T.ads.currency;
    var lines = [];
    lines.push("*Daily numbers · " + dlabel(d) + "*" + (d === D.today ? " (so far)" : ""));
    lines.push("");
    lines.push("*Traffic*");
    lines.push("New client leads: " + fmt(x.paidClients[d] + x.organicClients[d]) + " (paid " + fmt(x.paidClients[d]) + ", organic " + fmt(x.organicClients[d]) + ")");
    if (T.ads.spendUpdatedAt) lines.push("Meta spend: " + money(T.ads.spend[d], cur) + " · cost per lead " + (x.allPaid[d] ? money(x.cpl[d], cur) : "–"));
    var own = add(x.o.owner_outreach, x.o.owner_referral, x.o.owner_other, x.o.paid_meta_form);
    lines.push("New owner leads: " + fmt(own[d]));
    lines.push("");
    lines.push("*Autopilot*");
    lines.push("Owners messaged: " + fmt(A.listings.ownersMessaged[d]) + " (" + fmt(A.listings.firstContacts[d]) + " first contacts), replied: " + fmt(A.listings.ownersReplied[d]));
    lines.push("Qualified (Pre-listed): " + fmt(A.listings.qualified[d]) + " · taken to work: " + fmt(A.listings.takenToWork[d]) + " · closed lost: " + fmt(A.listings.closedLost[d]));
    lines.push("Weekly check: sent " + fmt(A.weeklyCheck.sent[d]) + ", answered " + fmt(A.weeklyCheck.answered[d]) + ", site updated " + fmt(A.weeklyCheck.siteUpdated[d]));
    D.brokers.forEach(function (b) {
      lines.push("");
      lines.push("*" + b.name + "*");
      lines.push("Messages: " + fmt(b.messages.viaCopilot[d]) + " via Copilot + " + fmt(b.messages.fromPhone[d]) + " from phone · " + fmt(b.messages.peopleWritten[d]) + " people");
      if (b.viewings) lines.push("Viewings: " + fmt(b.viewings.held[d]) + " held, " + fmt(b.viewings.agreed[d]) + " agreed, " + fmt(b.viewings.reportsFiled[d]) + " reports filed");
      if (b.inspections) lines.push("Inspections: " + fmt(b.inspections.due[d]) + " scheduled, " + fmt(b.inspections.listed[d]) + " → Listed, " + fmt(b.inspections.published[d]) + " published");
      if (b.tasks) lines.push("Tasks: " + fmt(b.tasks.overdue) + " overdue of " + fmt(b.tasks.open) + " open (" + fmt(b.tasks.overdue3d) + " over 3 days)");
      if (b.inbox) lines.push("Waiting for reply: " + fmt(b.inbox.waiting) + " (" + fmt(b.inbox.waitingOverdue) + " over 24h)");
    });
    var W = D.week;
    lines.push("");
    lines.push("*Week to date* (day " + W.daysIn + "/7)");
    lines.push("Amelia: viewings " + W.amelia.viewings + "/" + W.amelia.viewingsTarget + ", deals " + W.amelia.deals + "/" + W.amelia.dealsTarget);
    lines.push("Yudi: published " + W.yudi.published + "/" + W.yudi.publishedTarget + ", Listed " + W.yudi.listed + "/" + W.yudi.listedTarget);
    return lines.join("\n");
  }

  function load() {
    el("app").innerHTML = '<p class="muted">Loading…</p>';
    var q = "k=" + encodeURIComponent(KEY) + "&days=" + encodeURIComponent(state.span) + (state.day ? "&to=" + state.day : "");
    fetch("/kpi/data?" + q).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }).then(function (d) {
      state.data = d;
      if (!state.day) state.day = d.days[d.days.length - 1];
      el("day").value = state.day;
      el("day").max = d.today;
      el("next").disabled = state.day >= d.today;
      render();
    }).catch(function (e) { el("app").innerHTML = '<div class="err">Could not load the numbers: ' + esc(e.message) + "</div>"; });
  }
  function shift(n) {
    var d = new Date((state.day || new Date().toISOString().slice(0, 10)) + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    state.day = d.toISOString().slice(0, 10);
    sync(); load();
  }
  function sync() {
    var p = new URLSearchParams(location.search);
    if (state.day) p.set("day", state.day);
    p.set("days", state.span);
    history.replaceState(null, "", location.pathname + "?" + p.toString());
  }
  el("prev").onclick = function () { shift(-1); };
  el("next").onclick = function () { shift(1); };
  el("day").onchange = function () { state.day = this.value; sync(); load(); };
  el("span").value = state.span;
  el("span").onchange = function () { state.span = this.value; sync(); load(); };
  el("copy").onclick = function () {
    if (!state.data) return;
    var t = chatText();
    var done = function () { var n = el("toast"); n.classList.add("on"); setTimeout(function () { n.classList.remove("on"); }, 1400); };
    if (navigator.clipboard) navigator.clipboard.writeText(t).then(done, function () { prompt("Copy:", t); });
    else prompt("Copy:", t);
  };
  load();
})();
</script>
</body>
</html>`;

export default router;
