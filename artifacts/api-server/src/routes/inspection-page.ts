import { Router } from "express";

/**
 * /m/inspection/<report id> — the inspection report screen of Copilot (lib/inspection-report.ts).
 * Its own page, opened from the card in /m (and inside the extension's iframe, same origin), so the
 * long form keeps its state: /m re-renders the whole card on every toast and refresh.
 *
 * The client script is written without backticks, "${" or backslashes: this file is a template
 * literal (the same trap as mobile.ts).
 */
const router = Router();

const PAGE = String.raw`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
<title>Inspection report</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
body { margin: 0; background: #0f1320; color: #e6e8ee; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 14px; padding-bottom: calc(40px + env(safe-area-inset-bottom)); }
header { position: sticky; top: 0; z-index: 5; background: #141827; border-bottom: 1px solid #2a3146; padding: max(12px, env(safe-area-inset-top)) 16px 10px; display: flex; align-items: center; gap: 10px; }
header button { background: none; border: 0; color: #7dd3fc; font: inherit; font-size: 13.5px; cursor: pointer; padding: 0; }
header .t { font-weight: 700; font-size: 14.5px; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
header .sv { font-size: 11.5px; color: #6b7488; white-space: nowrap; }
main { padding: 12px 12px 0; max-width: 640px; margin: 0 auto; }
.vr { background: #181d2e; border: 1px solid rgba(251,191,36,.35); border-radius: 12px; padding: 12px 14px; margin-bottom: 12px; }
.vr.lost { border-color: rgba(248,113,113,.4); }
.head { font-size: 12.5px; color: #fbbf24; font-weight: 700; }
.head b { color: #fde68a; }
.sub { font-size: 11.5px; color: #6b7488; margin-top: 3px; }
.sub a { color: #7dd3fc; text-decoration: none; }
.section { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #8a93a8; margin: 16px 0 6px; }
.req { color: #fbbf24; letter-spacing: .04em; }
.req.ok { color: #4ade80; }
.opts { display: flex; flex-wrap: wrap; gap: 6px; }
.opt { border: 1px solid #2a3146; background: #0f1320; color: #b6bccd; border-radius: 20px; padding: 8px 13px; font-size: 13.5px; cursor: pointer; font-family: inherit; }
.opt.on { background: rgba(45,212,191,.16); border-color: #2dd4bf; color: #5eead4; }
.opt.on.bad { background: rgba(248,113,113,.14); border-color: #f87171; color: #fca5a5; }
.flags { display: grid; gap: 6px; }
.flag { display: flex; gap: 6px; align-items: center; }
.flag input { flex: 1; min-width: 0; background: #0f1320; color: #e6e8ee; border: 1px solid #2a3146; border-radius: 8px; padding: 8px 10px; font-size: 16px; font-family: inherit; }
.flag.red input { border-left: 3px solid #f87171; }
.flag.green input { border-left: 3px solid #4ade80; }
.x { background: none; border: 0; color: #6b7488; font-size: 18px; cursor: pointer; padding: 2px 8px; }
.add { background: none; border: 1px dashed #2a3146; color: #8a93a8; border-radius: 8px; padding: 7px 11px; font-size: 13px; cursor: pointer; font-family: inherit; justify-self: start; }
.check { display: flex; gap: 8px; align-items: center; font-size: 13.5px; color: #b6bccd; margin-top: 8px; }
.check input { accent-color: #f87171; width: 18px; height: 18px; }
textarea { width: 100%; min-height: 96px; background: #0f1320; color: #e6e8ee; border: 1px solid #2a3146; border-radius: 8px; padding: 9px 10px; font-size: 16px; font-family: inherit; resize: vertical; line-height: 1.45; }
input.txt { width: 100%; background: #0f1320; color: #e6e8ee; border: 1px solid #2a3146; border-radius: 8px; padding: 8px 10px; font-size: 16px; font-family: inherit; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
.btn { border: 1px solid #2a3146; background: transparent; color: #8a93a8; border-radius: 8px; padding: 7px 12px; font-size: 13px; cursor: pointer; font-family: inherit; }
.btn.rec { background: #ef4444; border-color: #ef4444; color: #fff; }
.btn.ai { border-color: rgba(167,139,250,.5); background: rgba(139,92,246,.12); color: #c4b5fd; }
.btn[disabled] { opacity: .4; cursor: default; }
.status { font-size: 12px; color: #8a93a8; }
.drop { display: block; border: 1.5px dashed #3a4462; border-radius: 10px; padding: 14px; text-align: center; color: #8a93a8; font-size: 12.5px; cursor: pointer; background: rgba(125,211,252,.03); }
.drop b { color: #7dd3fc; font-weight: 600; }
.drop input { display: none; }
.thumbs { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 6px; margin-top: 8px; }
.th { aspect-ratio: 1; border-radius: 7px; position: relative; overflow: hidden; border: 1px solid #2a3146; background: #141827 center/cover no-repeat; cursor: pointer; }
.th.cover { outline: 2px solid #2dd4bf; outline-offset: -2px; }
.th .tag { position: absolute; left: 4px; bottom: 4px; font-size: 9.5px; font-weight: 700; background: rgba(0,0,0,.65); color: #fff; padding: 1px 5px; border-radius: 4px; }
.th .rm { position: absolute; right: 2px; top: 2px; width: 22px; height: 22px; border-radius: 50%; border: 0; background: rgba(0,0,0,.6); color: #fff; font-size: 13px; line-height: 22px; padding: 0; cursor: pointer; }
.th.up { opacity: .55; }
.vid { display: flex; gap: 10px; align-items: center; margin-top: 8px; background: #0f1320; border: 1px solid #2a3146; border-radius: 8px; padding: 8px 10px; font-size: 12.5px; }
.bar { height: 4px; background: #2a3146; border-radius: 3px; overflow: hidden; margin-top: 5px; }
.bar i { display: block; height: 100%; width: 0; background: #2dd4bf; }
details.more { margin-top: 16px; border-top: 1px solid #2a3146; padding-top: 10px; }
details.more summary { font-size: 12.5px; color: #8a93a8; cursor: pointer; }
.kv { display: grid; grid-template-columns: 96px minmax(0,1fr); gap: 6px 8px; margin-top: 8px; font-size: 12.5px; align-items: center; }
.kv label { color: #6b7488; }
.send { background: #2dd4bf; color: #06121a; border: none; border-radius: 10px; padding: 12px 18px; font-weight: 800; font-size: 14.5px; cursor: pointer; font-family: inherit; }
.send[disabled] { opacity: .38; cursor: default; }
.send.lost { background: #f87171; color: #1a0606; }
.link { font-size: 12.5px; color: #7dd3fc; cursor: pointer; background: none; border: 0; padding: 0; font-family: inherit; }
.missing { font-size: 12.5px; color: #fbbf24; line-height: 1.4; }
.ck { display: grid; grid-template-columns: 22px minmax(0,1fr); gap: 8px; padding: 8px 2px; border-bottom: 1px solid rgba(42,49,70,.6); font-size: 13.5px; }
.ck:last-child { border-bottom: 0; }
.ck .ic { width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; font-weight: 800; margin-top: 1px; background: #2a3146; color: #8a93a8; }
.ck.run .ic { background: transparent; border: 2px solid #7dd3fc; border-top-color: transparent; animation: spin .8s linear infinite; }
.ck.ok .ic { background: rgba(74,222,128,.18); color: #4ade80; }
.ck.warn .ic { background: rgba(251,191,36,.18); color: #fbbf24; }
.ck.bad .ic { background: rgba(248,113,113,.2); color: #f87171; }
.ck small { display: block; color: #6b7488; font-size: 11.5px; margin-top: 2px; }
.ck.bad small { color: #fca5a5; }
@keyframes spin { to { transform: rotate(360deg); } }
.done { background: rgba(74,222,128,.08); border: 1px solid rgba(74,222,128,.3); color: #c8f5e0; border-radius: 12px; padding: 10px 14px; font-size: 13.5px; line-height: 1.5; margin-top: 10px; }
.fail { background: rgba(248,113,113,.08); border: 1px solid rgba(248,113,113,.35); color: #fde2e2; border-radius: 12px; padding: 10px 14px; font-size: 13.5px; line-height: 1.5; margin-top: 10px; }
.empty { text-align: center; color: #6b7488; padding: 60px 20px; }
[hidden] { display: none !important; }
</style></head><body>
<header><button id="back">&lsaquo; Inbox</button><div class="t" id="title">Inspection report</div><div class="sv" id="saved"></div></header>
<main id="app"><div class="empty">Loading&hellip;</div></main>
<script>
(function () {
  var ID = location.pathname.split("/").pop();
  var qs = new URLSearchParams(location.search);
  var BROKER = qs.get("broker") || "Yudi";
  var API = "/api/public/inspection-report/" + ID;
  var S = null;           // report state being edited
  var L = null;           // listing + private data from the site
  var listed = false;
  var uploads = 0;
  var saveTimer = null;
  var poll = null;
  var lostOpen = false;
  var lostReason = null;
  var lang = "en-US";
  var app = document.getElementById("app");
  function $(s) { return document.querySelector(s); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function fmt(iso) { try { return new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Makassar", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); } catch (e) { return iso; } }
  function lines(s) { return String(s || "").split("\n").map(function (x) { return x.trim(); }).filter(Boolean); }
  function filled(a) { return a.some(function (x) { return String(x).trim(); }); }

  $("#back").onclick = function () { if (history.length > 1) history.back(); else location.href = "/m"; };

  function load() {
    fetch(API).then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) { app.innerHTML = '<div class="empty">' + esc(d.error) + "</div>"; return; }
      var r = d.report; L = d;
      var p = d.private || {};
      S = {
        code: r.property_code || "",
        red: lines(r.red_flags != null ? r.red_flags : p.red_flags),
        green: lines(r.green_flags != null ? r.green_flags : p.green_flags),
        construction: r.construction_nearby != null ? !!r.construction_nearby : !!p.construction_nearby,
        notes: r.notes || "",
        photos: r.photos || [],
        cover: r.cover || null,
        video: r.video_url || null,
        edits: r.private_edits || {},
        status: r.status,
        checks: r.checks || [],
      };
      if (!S.red.length) S.red = [""];
      if (!S.green.length) S.green = [""];
      listed = r.status !== "due" && r.status !== "not_listing" ? true : (d.listing ? d.listing.pre_listed === false : false);
      $("#title").textContent = (r.property_code || "Inspection report") + (d.listing && d.listing.title ? " · " + d.listing.title : "");
      render();
      if (S.status === "checking") startPoll();
    }).catch(function () { app.innerHTML = '<div class="empty">Could not load the report. Check the connection and reload.</div>'; });
  }

  function missing() {
    var m = [];
    if (!S.code) m.push("the villa code");
    if (!listed) m.push("switch to Listed");
    if (!filled(S.red)) m.push("a red flag");
    if (!filled(S.green)) m.push("a green flag");
    if (!S.notes.trim()) m.push("your notes");
    if (uploads) m.push("wait for the uploads");
    return m;
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    $("#saved").textContent = "editing…";
    saveTimer = setTimeout(save, 900);
  }
  function save() {
    clearTimeout(saveTimer);
    return fetch(API + "/save", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ propertyCode: S.code, red: S.red, green: S.green, construction: S.construction, notes: S.notes, photos: S.photos, cover: S.cover, video: S.video, privateEdits: S.edits }),
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.ok) { $("#saved").textContent = "saved"; if (d.report && d.report.property_code && !S.code) S.code = d.report.property_code; }
      else $("#saved").textContent = "not saved";
      return d;
    }).catch(function () { $("#saved").textContent = "not saved — offline?"; });
  }

  function flagsHtml(kind) {
    var h = '<div class="flags">';
    S[kind].forEach(function (v, i) {
      h += '<div class="flag ' + kind + '"><input id="' + kind + i + '" data-k="' + kind + '" data-i="' + i + '" value="' + esc(v) + '" placeholder="' + (kind === "red" ? "e.g. road noise at night" : "e.g. sunset view from the pool") + '"><button class="x" data-del="' + kind + '" data-i="' + i + '" aria-label="Remove">&times;</button></div>';
    });
    return h + '<button class="add" data-add="' + kind + '">+ Add ' + kind + " flag</button></div>";
  }

  function checksHtml() {
    var h = "";
    S.checks.forEach(function (c) {
      var icon = { ok: "&#10003;", warn: "!", bad: "&times;", run: "", todo: "" }[c.state] || "";
      h += '<div class="ck ' + c.state + '"><span class="ic">' + icon + "</span><div>" + esc(c.label) + (c.detail ? "<small>" + esc(c.detail) + "</small>" : "") + "</div></div>";
    });
    return h;
  }

  function render() {
    var r = L.report, lst = L.listing, m = missing();
    var head = '<div class="head">&#x1F50D; Inspection report &middot; <b>' + esc(S.code || "villa?") + "</b> &middot; " + esc(fmt(r.visit_at)) + "</div>";
    var sub = '<div class="sub">' + (lst ? esc([lst.bedrooms ? lst.bedrooms + "BR" : null, lst.area].filter(Boolean).join(" · ")) + " &middot; " : "") +
      '<a href="' + esc(L.card_url) + '" target="_blank">amoCRM card</a>' + (L.site_url ? ' &middot; <a href="' + esc(L.site_url) + '" target="_blank">on the site</a>' : "") + "</div>";

    if (S.status === "done" || S.status === "not_listing") {
      app.innerHTML = '<div class="vr' + (S.status === "not_listing" ? " lost" : "") + '">' + head + sub + checksHtml() +
        '<div class="done">' + (S.status === "done" ? "&#x2705; Inspection closed. The villa is Listed on the site and live in amoCRM; the report is in Unicorn Rental." : "Closed: not listing. The card is lost, the listing is hidden.") + "</div></div>";
      return;
    }
    if (S.status === "checking" || (S.status === "failed" && S.checks.length)) {
      var failed = S.status === "failed";
      app.innerHTML = '<div class="vr">' + head + sub + '<div style="margin-top:8px">' + checksHtml() + "</div>" +
        (failed ? '<div class="fail">The report is <b>not closed</b>: the red lines did not go through. Fix what they say (or wait a minute) and check again &mdash; green lines are not repeated. Nikita got a push.</div><div class="row" style="margin-top:12px"><button class="send" id="recheck">Check again</button><button class="link" id="edit">Edit the report</button></div>' : '<div class="row"><span class="status">Applying and checking every change&hellip;</span></div>') +
        "</div>";
      if (failed) {
        $("#recheck").onclick = done;
        $("#edit").onclick = function () { S.status = "due"; render(); };
      }
      return;
    }

    var h = '<div class="vr">' + head + sub;
    if (!r.property_code) {
      h += '<div class="section">Which villa <span class="req' + (S.code ? " ok" : "") + '">' + (S.code ? "&#10003;" : "required") + "</span></div>" +
        '<input class="txt" id="code" placeholder="Villa code, e.g. R-YUD-071" autocapitalize="characters" value="' + esc(S.code) + '">';
    }
    h += '<div class="section">Listing status <span class="req' + (listed ? " ok" : "") + '">' + (listed ? "&#10003;" : "required") + "</span></div>" +
      '<div class="opts"><button class="opt' + (!listed ? " on bad" : "") + '" data-listed="0">Pre-listed</button><button class="opt' + (listed ? " on" : "") + '" data-listed="1">&#10003; Listed &mdash; inspected</button></div>';
    h += '<div class="section">&#x1F534; Red flags <span class="req' + (filled(S.red) ? " ok" : "") + '">' + (filled(S.red) ? "&#10003;" : "at least one") + "</span></div>" + flagsHtml("red") +
      '<label class="check"><input type="checkbox" id="constr"' + (S.construction ? " checked" : "") + "> Construction nearby</label>";
    h += '<div class="section">&#x1F7E2; Green flags <span class="req' + (filled(S.green) ? " ok" : "") + '">' + (filled(S.green) ? "&#10003;" : "at least one") + "</span></div>" + flagsHtml("green");
    h += '<div class="section">Your notes <span class="req' + (S.notes.trim() ? " ok" : "") + '">' + (S.notes.trim() ? "&#10003;" : "required") + "</span></div>" +
      '<textarea id="notes" placeholder="Condition, owner&rsquo;s terms, anything the team should know &mdash; or dictate it">' + esc(S.notes) + "</textarea>" +
      '<div class="row"><button class="btn" id="mic">&#x1F3A4; Dictate</button><button class="btn" id="lang">' + (lang === "en-US" ? "EN" : "ID") + '</button><button class="btn ai" id="tidy"' + (S.notes.trim() ? "" : " disabled") + '>&#x2728; Tidy up with AI</button><span class="status" id="tidyst"></span></div>';

    h += '<div class="section">Photos &amp; video <span style="text-transform:none;letter-spacing:0;color:#6b7488;font-weight:400">optional</span></div>' +
      '<label class="drop"><input type="file" id="pics" accept="image/*" multiple><b>Add photos</b> from your phone<br><span style="font-size:11.5px">Yours go first &middot; ' + "6 or more replace the photos found online (hidden, not deleted)" + "</span></label>";
    if (S.photos.length || uploads) {
      h += '<div class="thumbs">';
      S.photos.forEach(function (u, i) {
        var cov = (S.cover || S.photos[0]) === u;
        h += '<div class="th' + (cov ? " cover" : "") + '" data-ph="' + i + '" style="background-image:url(' + esc(u) + ')"><span class="tag">' + (cov ? "COVER" : "NEW") + '</span><button class="rm" data-rm="' + i + '" aria-label="Remove">&times;</button></div>';
      });
      for (var k = 0; k < uploads; k++) h += '<div class="th up"><span class="tag">&hellip;</span></div>';
      h += "</div>";
      if (S.photos.length) h += '<div class="status" style="margin-top:6px">' + S.photos.length + " new &middot; tap a photo to make it the cover &middot; " + (S.photos.length >= 6 ? "the online photos will be hidden" : "the photos already on the site stay after yours") + "</div>";
    } else if (lst) {
      h += '<div class="status" style="margin-top:6px">Now on the site: ' + ((lst.images || []).length) + " photos</div>";
    }
    if (S.video) {
      h += '<div class="vid"><div style="flex:1;min-width:0">&#x1F3AC; Video tour added<div class="status">' + esc(S.video.split("/").pop()) + '</div></div><button class="x" id="rmvid" aria-label="Remove video">&times;</button></div>';
    } else {
      h += '<div class="vid" id="vidrow"><div style="flex:1;min-width:0"><label class="link"><input type="file" id="vidin" accept="video/*" hidden>+ Add video tour</label><div class="bar" id="vbarw" hidden><i id="vbar"></i></div><div class="status" id="vst">up to 200 MB &middot; ' + (lst && lst.video_url ? "replaces the current video" : "no video on the site yet") + "</div></div></div>";
    }

    var p = L.private || {};
    var ed = S.edits;
    h += '<details class="more"><summary>Internal data &mdash; owner, phone, pin, Drive (the site&rsquo;s own fields)</summary><div class="kv">' +
      '<label for="kv_owner_name">Owner</label><input class="txt" id="kv_owner_name" value="' + esc(ed.owner_name != null ? ed.owner_name : p.owner_name || "") + '">' +
      '<label for="kv_owner_phone">Phone</label><input class="txt" id="kv_owner_phone" value="' + esc(ed.owner_phone != null ? ed.owner_phone : p.owner_phone || "") + '">' +
      '<label for="kv_google_maps_url">Map pin</label><input class="txt" id="kv_google_maps_url" value="' + esc(ed.google_maps_url != null ? ed.google_maps_url : p.google_maps_url || "") + '">' +
      '<label for="kv_drive_folder_url">Drive folder</label><input class="txt" id="kv_drive_folder_url" value="' + esc(ed.drive_folder_url != null ? ed.drive_folder_url : p.drive_folder_url || "") + '">' +
      "</div></details>";

    h += '<div class="row" style="margin-top:16px"><button class="send" id="done"' + (m.length ? " disabled" : "") + ">Report done &rarr; live</button></div>" +
      '<div class="row">' + (m.length ? '<span class="missing">Still needed: ' + esc(m.join(", ")) + "</span>" : '<span class="status">Everything is filled. The bot applies it to the site, amoCRM and the chat, and checks each one.</span>') + "</div>" +
      '<div class="row" style="margin-top:14px"><button class="link" id="lostlink">Villa doesn&rsquo;t fit &mdash; not listing &rsaquo;</button></div></div>';

    if (lostOpen) {
      h += '<div class="vr lost"><div class="head" style="color:#f87171">&#x2715; Not listing &middot; <b style="color:#fca5a5">' + esc(S.code || "villa") + "</b></div>" +
        '<div class="section">Why <span class="req' + (lostReason ? " ok" : "") + '">' + (lostReason ? "&#10003;" : "required") + '</span></div><div class="opts">';
      (L.reasons || []).forEach(function (x) { h += '<button class="opt' + (lostReason === x ? " on bad" : "") + '" data-reason="' + esc(x) + '">' + esc(x) + "</button>"; });
      h += '</div><div class="status" style="margin-top:8px">Uses your notes above as the reason in words.</div>' +
        '<div class="row" style="margin-top:12px"><button class="send lost" id="lostgo"' + (lostReason && S.notes.trim() ? "" : " disabled") + ">Close &mdash; not listing</button></div>" +
        '<div class="row"><span class="status">Card &rarr; lost with this reason &middot; the listing is hidden from the site &middot; one line to Unicorn Rental</span></div></div>';
    }
    app.innerHTML = h;
    bind();
  }

  function rerenderKeep(id) {
    var el = document.getElementById(id), pos = el ? el.selectionStart : null;
    render();
    var n = document.getElementById(id);
    if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) {} }
  }

  function bind() {
    var code = $("#code");
    if (code) code.oninput = function () { var before = missing().join(); S.code = code.value.trim().toUpperCase(); scheduleSave(); if (missing().join() !== before) rerenderKeep("code"); };
    document.querySelectorAll("[data-listed]").forEach(function (b) { b.onclick = function () { listed = b.getAttribute("data-listed") === "1"; render(); }; });
    document.querySelectorAll(".flag input").forEach(function (inp) {
      inp.oninput = function () {
        var before = missing().join();
        S[inp.getAttribute("data-k")][+inp.getAttribute("data-i")] = inp.value;
        scheduleSave();
        if (missing().join() !== before) rerenderKeep(inp.id);
      };
    });
    document.querySelectorAll("[data-del]").forEach(function (b) { b.onclick = function () { var k = b.getAttribute("data-del"); S[k].splice(+b.getAttribute("data-i"), 1); if (!S[k].length) S[k] = [""]; scheduleSave(); render(); }; });
    document.querySelectorAll("[data-add]").forEach(function (b) { b.onclick = function () { var k = b.getAttribute("data-add"); S[k].push(""); render(); var n = document.getElementById(k + (S[k].length - 1)); if (n) n.focus(); }; });
    $("#constr").onchange = function () { S.construction = $("#constr").checked; scheduleSave(); };
    var nt = $("#notes");
    nt.oninput = function () { var before = missing().join(); S.notes = nt.value; scheduleSave(); $("#tidy").disabled = !nt.value.trim(); if (missing().join() !== before) rerenderKeep("notes"); };
    $("#mic").onclick = dictate;
    $("#lang").onclick = function () { lang = lang === "en-US" ? "id-ID" : "en-US"; $("#lang").textContent = lang === "en-US" ? "EN" : "ID"; };
    $("#tidy").onclick = tidy;
    $("#pics").onchange = function () { addPhotos([].slice.call($("#pics").files || [])); };
    document.querySelectorAll("[data-ph]").forEach(function (t) { t.onclick = function (e) { if (e.target.getAttribute("data-rm") != null) return; S.cover = S.photos[+t.getAttribute("data-ph")]; scheduleSave(); render(); }; });
    document.querySelectorAll("[data-rm]").forEach(function (b) { b.onclick = function () { var u = S.photos.splice(+b.getAttribute("data-rm"), 1)[0]; if (S.cover === u) S.cover = S.photos[0] || null; scheduleSave(); render(); }; });
    var vi = $("#vidin"); if (vi) vi.onchange = function () { if (vi.files && vi.files[0]) addVideo(vi.files[0]); };
    var rv = $("#rmvid"); if (rv) rv.onclick = function () { S.video = null; scheduleSave(); render(); };
    ["owner_name", "owner_phone", "google_maps_url", "drive_folder_url"].forEach(function (k) {
      var el = $("#kv_" + k); if (el) el.oninput = function () { S.edits[k] = el.value; scheduleSave(); };
    });
    $("#done").onclick = done;
    $("#lostlink").onclick = function () { lostOpen = !lostOpen; render(); if (lostOpen) window.scrollTo(0, document.body.scrollHeight); };
    document.querySelectorAll("[data-reason]").forEach(function (b) { b.onclick = function () { lostReason = b.getAttribute("data-reason"); render(); window.scrollTo(0, document.body.scrollHeight); }; });
    var lg = $("#lostgo"); if (lg) lg.onclick = notListing;
  }

  // ── Dictation (Web Speech API, the same as the viewing report) ──
  var rec = null;
  function dictate() {
    var btn = $("#mic");
    if (rec) { rec.stop(); return; }
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { btn.textContent = "Not supported here"; setTimeout(function () { btn.innerHTML = "&#x1F3A4; Dictate"; }, 3000); return; }
    var base = S.notes.trim();
    var finals = "";
    rec = new SR();
    rec.lang = lang; rec.continuous = true; rec.interimResults = true;
    rec.onstart = function () { btn.classList.add("rec"); btn.textContent = "Stop"; };
    rec.onresult = function (ev) {
      var interim = "";
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        if (ev.results[i].isFinal) finals += ev.results[i][0].transcript + " "; else interim += ev.results[i][0].transcript;
      }
      var t = (base ? base + " " : "") + finals + interim;
      $("#notes").value = t; S.notes = t;
    };
    rec.onerror = function (e) { btn.textContent = e.error === "not-allowed" ? "Mic blocked" : "Mic error"; };
    rec.onend = function () {
      rec = null;
      S.notes = $("#notes").value.trim();
      scheduleSave();
      render();
      if (S.notes) { $("#tidyst").textContent = "dictated — tidy it up?"; }
    };
    rec.start();
  }

  function tidy() {
    var btn = $("#tidy"), st = $("#tidyst");
    btn.disabled = true; st.textContent = "packing it up…";
    fetch(API + "/tidy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: S.notes }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { st.textContent = d.error || "not available"; btn.disabled = false; return; }
        S.notes = d.text; scheduleSave(); render();
        $("#tidyst").textContent = "tidied — edit if needed";
      })
      .catch(function () { st.textContent = "no connection"; btn.disabled = false; });
  }

  // ── Uploads: straight from the phone into the site's storage ──
  function signed(kind, name) {
    return fetch(API + "/upload", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: kind, name: name }) })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (!d.uploadUrl) throw new Error(d.error || "no upload slot"); return d; });
  }
  function shrink(file) {
    // Long side 2400 px, JPEG: HEIC from an iPhone becomes a photo every browser can show.
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var max = 2400, w = img.naturalWidth, h = img.naturalHeight, s = Math.min(1, max / Math.max(w, h));
        var c = document.createElement("canvas"); c.width = Math.round(w * s); c.height = Math.round(h * s);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { resolve(b || file); }, "image/jpeg", 0.85);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }
  function put(uploadUrl, blob, type, onProgress) {
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest();
      x.open("PUT", uploadUrl);
      x.setRequestHeader("Content-Type", type);
      x.setRequestHeader("x-upsert", "false");
      if (onProgress) x.upload.onprogress = function (e) { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      x.onload = function () { if (x.status >= 200 && x.status < 300) resolve(); else reject(new Error("upload " + x.status)); };
      x.onerror = function () { reject(new Error("upload failed")); };
      x.send(blob);
    });
  }
  function addPhotos(files) {
    if (!S.code) { alert("Name the villa code first."); return; }
    uploads += files.length; render();
    var chain = Promise.resolve();
    files.forEach(function (f) {
      chain = chain.then(function () {
        return shrink(f).then(function (blob) {
          return signed("photo", f.name).then(function (s) { return put(s.uploadUrl, blob, "image/jpeg").then(function () { return s.publicUrl; }); });
        }).then(function (u) { S.photos.push(u); if (!S.cover) S.cover = u; })
          .catch(function (e) { alert("A photo did not upload: " + e.message); })
          .then(function () { uploads--; render(); });
      });
    });
    chain.then(save);
  }
  function addVideo(file) {
    if (!S.code) { alert("Name the villa code first."); return; }
    if (file.size > 200 * 1024 * 1024) { $("#vst").textContent = "This video is " + Math.round(file.size / 1048576) + " MB; the limit is 200 MB. Trim it or record a shorter one."; return; }
    uploads++;
    $("#vbarw").hidden = false; $("#vst").textContent = "uploading " + Math.round(file.size / 1048576) + " MB… keep this screen open";
    signed("video", file.name)
      .then(function (s) { return put(s.uploadUrl, file, file.type || "video/mp4", function (p) { var b = $("#vbar"); if (b) b.style.width = Math.round(p * 100) + "%"; }).then(function () { return s.publicUrl; }); })
      .then(function (u) { S.video = u; uploads--; save(); render(); })
      .catch(function (e) { uploads--; render(); alert("The video did not upload: " + e.message); });
  }

  // ── Report done ──
  function done() {
    var btn = $("#done") || $("#recheck");
    if (btn) btn.disabled = true;
    save().then(function () {
      return fetch(API + "/done", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ broker: BROKER }) });
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) { alert(d.missing ? "Still needed: " + d.missing.join(", ") : (d.error || "Could not start")); if (btn) btn.disabled = false; return; }
      S.status = "checking"; render(); startPoll();
    }).catch(function () { alert("No connection — nothing was sent. Try again."); if (btn) btn.disabled = false; });
  }
  function startPoll() {
    clearInterval(poll);
    poll = setInterval(function () {
      fetch(API + "/status").then(function (r) { return r.json(); }).then(function (d) {
        S.checks = d.checks || []; S.status = d.status;
        render();
        if (d.status !== "checking") clearInterval(poll);
      }).catch(function () {});
    }, 1500);
  }

  function notListing() {
    var btn = $("#lostgo"); btn.disabled = true;
    save().then(function () {
      return fetch(API + "/not-listing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: lostReason, notes: S.notes, broker: BROKER }) });
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.checks) { S.checks = d.checks; S.status = d.ok ? "not_listing" : "failed"; lostOpen = false; render(); return; }
      alert(d.error || "Could not close"); btn.disabled = false;
    }).catch(function () { alert("No connection — nothing was sent."); btn.disabled = false; });
  }

  window.addEventListener("beforeunload", function (e) { if (uploads) { e.preventDefault(); e.returnValue = ""; } });
  load();
})();
</script></body></html>`;

router.get("/m/inspection/:id", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.type("html").send(PAGE);
});

export default router;
