import { Router } from "express";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";

/**
 * /m/flags?k=<key> — Yudi fills in the red flags, green flags and notes of villas that are already
 * Listed but were switched without an inspection report (owner, 26.09.2026: "те, которые он уже
 * проверил, но не дозаполнил ... в какой-то удобной форме ему скинуть, чтобы он быстро мог
 * дозаполнить"). 33 of 37 Listed rentals had no flags on 26.09; new reports cannot be sent
 * without them (inspection-report.ts), this page closes the old ones.
 *
 * One screen, one villa per card: tap the usual flags, add your own line, keep or write the notes,
 * Save. It writes only the site's Internal data (property_private: red_flags, green_flags, notes,
 * construction_nearby) — no stage, no card, no group post. `flags_backfill_key` in broker_settings
 * opens it; no key stored → nothing opens.
 *
 * The client script is written without backticks, "${" or backslashes: the page is a template
 * literal (the same trap as mobile.ts).
 */
const router = Router();

async function key(): Promise<string | null> {
  const { rows } = await pool.query(`SELECT value FROM broker_settings WHERE key = 'flags_backfill_key'`);
  const v = rows[0]?.value;
  return typeof v === "string" && v.length >= 16 ? v : null;
}

async function allowed(k: unknown): Promise<boolean> {
  const want = await key();
  return !!want && typeof k === "string" && k === want;
}

function siteDb(): { url: string; key: string } {
  const url = process.env["SUPABASE_URL"] ?? "";
  const k = process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? "";
  if (!url || !k) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
  return { url, key: k };
}

async function site<T>(path: string, init: { method?: string; body?: unknown; prefer?: string } = {}): Promise<T> {
  const { url, key: k } = siteDb();
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method: init.method ?? "GET",
    headers: {
      apikey: k,
      Authorization: `Bearer ${k}`,
      "Content-Type": "application/json",
      ...(init.prefer ? { Prefer: init.prefer } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`site ${init.method ?? "GET"} ${path.split("?")[0]} → ${res.status} ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : null) as T;
}

type Prop = {
  id: string;
  title: string | null;
  area: string | null;
  bedrooms: number | null;
  images: string[] | null;
  garden: string | null;
  living_room: string | null;
  workspace: string | null;
  quiet_area: boolean | null;
};
type Priv = {
  property_id: string;
  red_flags: string | null;
  green_flags: string | null;
  notes: string | null;
  construction_nearby: boolean | null;
};

const filled = (s: string | null | undefined) => String(s ?? "").trim().length > 1;

router.get("/api/public/flags-backfill", async (req, res) => {
  if (!(await allowed(req.query["k"]))) return void res.status(404).json({ error: "not found" });
  try {
    const props = await site<Prop[]>(
      "properties?select=id,title,area,bedrooms,images,garden,living_room,workspace,quiet_area&listing_type=eq.rent&pre_listed=eq.false&is_draft=eq.false&order=id",
    );
    const ids = props.map((p) => `"${p.id}"`).join(",");
    const privs = ids
      ? await site<Priv[]>(`property_private?select=property_id,red_flags,green_flags,notes,construction_nearby&property_id=in.(${encodeURIComponent(ids)})`)
      : [];
    const byId = new Map(privs.map((r) => [r.property_id, r]));
    const villas = props.map((p) => {
      const r = byId.get(p.id);
      const features: string[] = [];
      if (p.garden === "small" || p.garden === "large") features.push(`${p.garden} garden`);
      if (p.garden === "none") features.push("no garden");
      if (p.living_room) features.push(`${p.living_room} living room`);
      if (p.workspace && p.workspace !== "none") features.push(p.workspace === "desk" ? "workspace" : "office room");
      if (p.quiet_area === true) features.push("quiet street");
      return {
        id: p.id,
        title: p.title,
        area: p.area,
        bedrooms: p.bedrooms,
        cover: (p.images ?? [])[0] ?? null,
        features,
        red: r?.red_flags ?? "",
        green: r?.green_flags ?? "",
        notes: r?.notes ?? "",
        construction: r?.construction_nearby === true,
        done: filled(r?.red_flags) && filled(r?.green_flags) && filled(r?.notes),
      };
    });
    res.set("Cache-Control", "no-store").json({ villas });
  } catch (err) {
    logger.warn({ err }, "flags backfill: list failed");
    res.status(503).json({ error: "Could not read the site. Try again in a minute." });
  }
});

router.post("/api/public/flags-backfill/:id", async (req, res) => {
  if (!(await allowed(req.query["k"]))) return void res.status(404).json({ error: "not found" });
  const id = String(req.params.id ?? "").trim();
  const clean = (v: unknown, max: number) =>
    String(v ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .join("\n")
      .slice(0, max);
  const red = clean(req.body?.red, 2000);
  const green = clean(req.body?.green, 2000);
  const notes = String(req.body?.notes ?? "").trim().slice(0, 8000);
  const missing = [!filled(red) && "a red flag", !filled(green) && "a green flag", !filled(notes) && "notes"].filter(Boolean);
  if (missing.length) return void res.status(422).json({ ok: false, missing });
  try {
    const [p] = await site<Array<{ id: string; pre_listed: boolean | null }>>(
      `properties?select=id,pre_listed&id=eq.${encodeURIComponent(id)}&listing_type=eq.rent`,
    );
    if (!p) return void res.status(404).json({ ok: false, error: "no such listing" });
    const row: Record<string, unknown> = { property_id: p.id, red_flags: red, green_flags: green, notes };
    if (req.body?.construction === true) row["construction_nearby"] = true;
    await site("property_private?on_conflict=property_id", {
      method: "POST",
      body: [row],
      prefer: "resolution=merge-duplicates,return=minimal",
    });
    const [back] = await site<Priv[]>(
      `property_private?select=property_id,red_flags,green_flags,notes,construction_nearby&property_id=eq.${encodeURIComponent(p.id)}`,
    );
    const ok = !!back && back.red_flags === red && back.green_flags === green && (back.notes ?? "").trim() === notes;
    logger.info({ id: p.id, red: red.split("\n").length, green: green.split("\n").length, ok }, "flags backfill: saved");
    res.json({ ok, error: ok ? undefined : "Saved, but the site returned something else — reload and check." });
  } catch (err) {
    logger.warn({ err, id }, "flags backfill: save failed");
    res.status(503).json({ ok: false, error: "Could not save to the site. Try again." });
  }
});

const PAGE = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Villa flags</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #0f1320; color: #e6e9f2; font: 15px/1.45 -apple-system, system-ui, sans-serif; }
header { position: sticky; top: 0; z-index: 2; background: #0f1320; padding: 12px 16px; border-bottom: 1px solid #232a3d; }
h1 { font-size: 17px; margin: 0; }
.sub { color: #8a93a8; font-size: 13px; margin-top: 2px; }
.bar { height: 6px; background: #232a3d; border-radius: 3px; margin-top: 8px; overflow: hidden; }
.bar i { display: block; height: 100%; background: #4ade80; }
main { padding: 12px 16px 60px; max-width: 640px; margin: 0 auto; }
.card { background: #161c2c; border: 1px solid #232a3d; border-radius: 12px; margin-bottom: 14px; overflow: hidden; }
.card.done { opacity: .55; }
.head { display: flex; gap: 10px; padding: 10px; align-items: center; cursor: pointer; }
.head img { width: 64px; height: 48px; object-fit: cover; border-radius: 6px; background: #232a3d; flex: none; }
.head b { display: block; font-size: 14px; }
.head span { color: #8a93a8; font-size: 12.5px; }
.tick { margin-left: auto; font-size: 18px; }
.body { padding: 0 12px 12px; }
.lbl { font-size: 13px; font-weight: 600; margin: 12px 0 6px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { border: 1px solid #333c55; background: #1c2336; color: #e6e9f2; border-radius: 16px; padding: 6px 10px; font-size: 13px; }
.chip.on.red { background: #4a1d24; border-color: #f87171; }
.chip.on.green { background: #173826; border-color: #4ade80; }
input.txt, textarea { width: 100%; background: #0f1320; color: #e6e9f2; border: 1px solid #333c55; border-radius: 8px; padding: 8px; font: 16px/1.4 inherit; margin-top: 6px; }
textarea { min-height: 80px; }
.hint { color: #8a93a8; font-size: 12.5px; margin-top: 4px; }
.row { display: flex; gap: 8px; align-items: center; margin-top: 12px; }
.save { background: #4ade80; color: #0f1320; border: 0; border-radius: 8px; padding: 10px 16px; font-weight: 700; font-size: 15px; }
.st { font-size: 13px; color: #8a93a8; }
a { color: #93c5fd; }
</style></head><body>
<header><h1>Villa flags &mdash; Listed villas</h1><div class="sub" id="sub">Loading&hellip;</div><div class="bar"><i id="prog" style="width:0"></i></div></header>
<main id="app"></main>
<script>
(function () {
  var qs = new URLSearchParams(location.search);
  var K = qs.get("k") || "";
  var API = "/api/public/flags-backfill";
  var GREEN = ["Garden", "Large garden", "Enclosed living room", "Closed kitchen", "Workspace / office", "Quiet street", "No construction nearby", "Family-friendly", "Pet-friendly", "Good condition", "Well maintained", "Walk to the beach", "Walk to cafes", "Rice field view", "Staff on site", "Nothing special"];
  var RED = ["Construction nearby", "Road noise", "Open living room", "No garden", "Small garden", "Damp / mould smell", "Ants / insects", "Old, needs maintenance", "Poor build quality", "Small rooms", "Steep stairs", "Nothing special"];
  var V = [];
  var open = null;
  var app = document.getElementById("app");
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function lines(s) { return String(s || "").split("\n").map(function (x) { return x.trim(); }).filter(Boolean); }
  function progress() {
    var d = V.filter(function (v) { return v.done; }).length;
    document.getElementById("sub").textContent = d + " of " + V.length + " done. Tap a villa, tick what is true, Save. No red or green flag? Tick Nothing special.";
    document.getElementById("prog").style.width = (V.length ? Math.round(d * 100 / V.length) : 0) + "%";
  }
  function chipsHtml(v, kind, list) {
    var have = lines(v[kind]).map(function (x) { return x.toLowerCase(); });
    return list.map(function (c) {
      var on = have.indexOf(c.toLowerCase()) >= 0;
      return '<button class="chip ' + kind + (on ? " on" : "") + '" data-kind="' + kind + '" data-c="' + esc(c) + '">' + esc(c) + "</button>";
    }).join("");
  }
  function extra(v, kind, list) {
    var known = list.map(function (x) { return x.toLowerCase(); });
    return lines(v[kind]).filter(function (x) { return known.indexOf(x.toLowerCase()) < 0; }).join("; ");
  }
  function render() {
    progress();
    var todo = V.filter(function (v) { return !v.done; }).concat(V.filter(function (v) { return v.done; }));
    app.innerHTML = todo.map(function (v) {
      var h = '<div class="card' + (v.done ? " done" : "") + '" id="c_' + esc(v.id) + '"><div class="head" data-open="' + esc(v.id) + '">' +
        (v.cover ? '<img src="' + esc(v.cover) + '" alt="">' : "<img alt=\"\">") +
        "<div><b>" + esc(v.id) + " &middot; " + esc(v.area || "") + "</b><span>" + esc(v.title || "") + "</span></div>" +
        '<div class="tick">' + (v.done ? "&#10003;" : "&rsaquo;") + "</div></div>";
      if (open === v.id) {
        h += '<div class="body">' +
          '<div class="hint">' + (v.features.length ? "On the site: " + esc(v.features.join(", ")) + " &middot; " : "") + '<a href="https://unicorn-properties.com/property/' + esc(v.id) + '" target="_blank" rel="noopener">open listing</a></div>' +
          '<div class="lbl">&#x1F7E2; Green flags</div><div class="chips">' + chipsHtml(v, "green", GREEN) + "</div>" +
          '<input class="txt" id="gx" placeholder="Other green flags, separated by ;" value="' + esc(extra(v, "green", GREEN)) + '">' +
          '<div class="lbl">&#x1F534; Red flags</div><div class="chips">' + chipsHtml(v, "red", RED) + "</div>" +
          '<input class="txt" id="rx" placeholder="Other red flags, separated by ;" value="' + esc(extra(v, "red", RED)) + '">' +
          '<div class="lbl">Notes</div><textarea id="nt" placeholder="Condition, owner, anything the team should know">' + esc(v.notes) + "</textarea>" +
          '<div class="row"><button class="save" id="save">Save</button><span class="st" id="st"></span></div></div>';
      }
      return h + "</div>";
    }).join("");
    Array.prototype.forEach.call(document.querySelectorAll("[data-open]"), function (el) {
      el.onclick = function () { open = open === el.getAttribute("data-open") ? null : el.getAttribute("data-open"); render(); var c = document.getElementById("c_" + open); if (c) c.scrollIntoView({ block: "start" }); };
    });
    Array.prototype.forEach.call(document.querySelectorAll(".chip"), function (el) {
      el.onclick = function () { el.classList.toggle("on"); };
    });
    var sv = document.getElementById("save");
    if (sv) sv.onclick = save;
  }
  function picked(kind, extraId) {
    var out = [];
    Array.prototype.forEach.call(document.querySelectorAll(".chip.on." + kind), function (el) { out.push(el.getAttribute("data-c")); });
    String(document.getElementById(extraId).value || "").split(";").forEach(function (x) { if (x.trim()) out.push(x.trim()); });
    if (out.length > 1) out = out.filter(function (x) { return x !== "Nothing special"; });
    return out;
  }
  function save() {
    var v = V.filter(function (x) { return x.id === open; })[0];
    var green = picked("green", "gx"), red = picked("red", "rx"), notes = document.getElementById("nt").value.trim();
    var miss = [];
    if (!green.length) miss.push("a green flag (or Nothing special)");
    if (!red.length) miss.push("a red flag (or Nothing special)");
    if (!notes) miss.push("notes");
    if (miss.length) { alert("Can't save yet. Fill in: " + miss.join(", ") + "."); return; }
    var st = document.getElementById("st"), btn = document.getElementById("save");
    btn.disabled = true; st.textContent = "Saving…";
    fetch(API + "/" + encodeURIComponent(v.id) + "?k=" + encodeURIComponent(K), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ green: green.join("\n"), red: red.join("\n"), notes: notes, construction: red.indexOf("Construction nearby") >= 0 })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) { btn.disabled = false; st.textContent = ""; alert(d.missing ? "Fill in: " + d.missing.join(", ") : (d.error || "Not saved")); return; }
      v.green = green.join("\n"); v.red = red.join("\n"); v.notes = notes; v.done = true;
      var next = V.filter(function (x) { return !x.done; })[0];
      open = next ? next.id : null; render();
      var c = open && document.getElementById("c_" + open); if (c) c.scrollIntoView({ block: "start" });
    }).catch(function () { btn.disabled = false; st.textContent = ""; alert("No connection — nothing was saved. Try again."); });
  }
  fetch(API + "?k=" + encodeURIComponent(K)).then(function (r) { return r.json(); }).then(function (d) {
    if (!d.villas) { app.innerHTML = '<p class="hint">' + esc(d.error || "This link does not open anything.") + "</p>"; return; }
    V = d.villas;
    var first = V.filter(function (x) { return !x.done; })[0];
    open = first ? first.id : null;
    render();
  }).catch(function () { app.innerHTML = '<p class="hint">Could not load. Check the connection and reload.</p>'; });
})();
</script></body></html>`;

router.get("/m/flags", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.type("html").send(PAGE);
});

export default router;
