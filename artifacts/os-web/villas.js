// Unicorn OS — the website catalog inside the OS: cards like the site, a working table, edits in place.
import { S, api, esc, I, screens, peeks, store, on, money, fmtDate, rel, imgUrl, coverUrl, toast, fail, confirmBox, recordVoice, emit, baliToday, dropCache } from "./core.js";

export async function loadVillas(force, drafts) {
  const key = drafts ? "villas:rent+drafts" : "villas:rent";
  const c = S.cache[key];
  if (!force && c && Date.now() - c.at < 5 * 60_000) return c.value;
  const r = await api(`/listings?type=rent${drafts ? "&drafts=1" : ""}`);
  S.cache[key] = { at: Date.now(), value: r.items };
  return r.items;
}
function replaceVilla(v) {
  for (const k of ["villas:rent", "villas:rent+drafts"]) {
    const c = S.cache[k];
    if (!c) continue;
    const i = c.value.findIndex((x) => x.id === v.id);
    if (i >= 0) c.value[i] = v;
  }
}

const soonLimit = () => new Date(Date.now() + 92 * 86400e3).toISOString().slice(0, 10);
function freeLabel(v) {
  if (!v.freeFrom) return `<span class="pill ok">free now</span>`;
  const far = v.freeFrom > soonLimit();
  return `<span class="pill ${far ? "bad" : "warn"}" title="${far ? "beyond 92 days — not offered" : ""}">from ${esc(fmtDate(v.freeFrom))}</span>`;
}
const statusPill = (v) => (v.is_draft ? `<span class="pill">Draft</span>` : v.pre_listed ? `<span class="pill">Pre-listed</span>` : `<span class="pill ok">Listed</span>`);

screens.villas = {
  title: "Villas",
  async render({ el, tools }) {
    const f = store.get("villa-filters", { view: "gallery", beds: "", area: "", max: "", free: "", status: "", q: "", drafts: false });
    tools.innerHTML = `<div class="views"><button data-view="gallery" class="${f.view === "gallery" ? "active" : ""}">${I.gallery}Cards</button><button data-view="table" class="${f.view === "table" ? "active" : ""}">${I.table}Table</button></div>
      <select class="chip" id="vf-beds"><option value="">Any BR</option>${[1, 2, 3, 4, 5].map((n) => `<option ${String(n) === f.beds ? "selected" : ""} value="${n}">${n} BR${n === 5 ? "+" : ""}</option>`).join("")}</select>
      <select class="chip" id="vf-area"><option value="">Any area</option></select>
      <select class="chip" id="vf-max"><option value="">Any price</option>${[30, 40, 50, 60, 80, 100, 150].map((n) => `<option value="${n}" ${String(n) === f.max ? "selected" : ""}>≤ Rp ${n}M</option>`).join("")}</select>
      <select class="chip" id="vf-free"><option value="">Any availability</option><option value="now" ${f.free === "now" ? "selected" : ""}>Free now</option><option value="30" ${f.free === "30" ? "selected" : ""}>Free within 30 days</option><option value="92" ${f.free === "92" ? "selected" : ""}>Free within 92 days</option></select>
      <select class="chip" id="vf-status"><option value="">Pre-listed + Listed</option><option value="listed" ${f.status === "listed" ? "selected" : ""}>Listed</option><option value="pre" ${f.status === "pre" ? "selected" : ""}>Pre-listed</option></select>
      <button class="chip ${f.drafts ? "on" : ""}" id="vf-drafts">Drafts too</button>
      <input class="in" id="vf-q" placeholder="Code, title, area…" value="${esc(f.q)}" style="width:170px;padding:5px 8px">
      <a class="btn sm" href="https://unicorn-properties.com/rent" target="_blank" rel="noopener">${I.ext} Site</a>`;
    el.innerHTML = `<div class="loading">Loading the catalog…</div>`;
    let all;
    try {
      all = await loadVillas(false, f.drafts);
    } catch (e) {
      el.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
      return;
    }
    const areas = [...new Set(all.map((v) => v.area).filter(Boolean))].sort();
    const areaSel = document.getElementById("vf-area");
    areaSel.innerHTML += areas.map((a) => `<option ${a === f.area ? "selected" : ""}>${esc(a)}</option>`).join("");
    const save = () => store.set("villa-filters", f);
    const bind = (id, k) =>
      (document.getElementById(id).onchange = (e) => {
        f[k] = e.target.value;
        save();
        draw();
      });
    bind("vf-beds", "beds");
    bind("vf-area", "area");
    bind("vf-max", "max");
    bind("vf-free", "free");
    bind("vf-status", "status");
    document.getElementById("vf-drafts").onclick = async (e) => {
      f.drafts = !f.drafts;
      save();
      screens.villas.render({ el, tools });
    };
    let t;
    document.getElementById("vf-q").oninput = (e) => {
      clearTimeout(t);
      t = setTimeout(() => {
        f.q = e.target.value;
        save();
        draw();
      }, 150);
    };
    tools.querySelectorAll("[data-view]").forEach((b) =>
      b.addEventListener("click", () => {
        f.view = b.dataset.view;
        save();
        tools.querySelectorAll("[data-view]").forEach((x) => x.classList.toggle("active", x === b));
        draw();
      }),
    );
    const today = baliToday();
    const filt = () =>
      all.filter((v) => {
        if (f.beds && (f.beds === "5" ? v.bedrooms < 5 : String(v.bedrooms) !== f.beds)) return false;
        if (f.area && v.area !== f.area) return false;
        if (f.max && !(Number(v.monthly_price_idr) > 0 && Number(v.monthly_price_idr) <= Number(f.max) * 1e6)) return false;
        if (f.free === "now" && v.freeFrom && v.freeFrom > today) return false;
        if (f.free && f.free !== "now" && v.freeFrom && v.freeFrom > new Date(Date.now() + Number(f.free) * 86400e3).toISOString().slice(0, 10)) return false;
        if (f.status === "listed" && (v.pre_listed || v.is_draft)) return false;
        if (f.status === "pre" && !v.pre_listed) return false;
        if (f.q) {
          const hay = `${v.id} ${v.title} ${v.area} ${(v.tags || []).join(" ")} ${v.private?.owner_name || ""}`.toLowerCase();
          if (!hay.includes(f.q.toLowerCase())) return false;
        }
        return true;
      });
    const draw = () => {
      const list = filt();
      if (f.view === "table") drawTable(el, list);
      else drawGallery(el, list);
    };
    draw();
  },
};

function drawGallery(el, list) {
  el.innerHTML = `<p class="faint" style="margin:0 0 10px">${list.length} villas · the same rows the website shows</p><div class="gallery">${list
    .map(
      (v) => `<div class="gcard" data-villa="${esc(v.id)}"><img src="${esc(coverUrl(v.images))}" data-raw="${esc(v.images?.[0] || "")}" alt="" loading="lazy">
      <div class="gb"><div class="gt">${esc(v.title)}</div><div class="gm"><span class="mono">${esc(v.id)}</span><span>${v.bedrooms ?? "?"}BR</span><b>${money(v.monthly_price_idr)}</b>${freeLabel(v)}${statusPill(v)}${v.video_url ? I.video : ""}</div>
      <div class="gm">${esc(v.area || "")}${v.min_stay_months ? ` · min ${v.min_stay_months} mo` : ""}${v.private?.drive_folder_url ? ` · <a href="${esc(v.private.drive_folder_url)}" target="_blank" rel="noopener" data-stop>${I.drive} Drive</a>` : ""}</div></div></div>`,
    )
    .join("")}</div>`;
  el.querySelectorAll("img[data-raw]").forEach((img) => img.addEventListener("error", () => img.dataset.raw && img.src !== img.dataset.raw && (img.src = img.dataset.raw), { once: true }));
  on(el, "click", "[data-villa]", (e, c) => {
    if (e.target.closest("[data-stop]")) return;
    emit("open-peek", { type: "villa", id: c.dataset.villa });
  });
}

let vsort = store.get("villa-sort", { k: "updated_at", dir: -1 });
function drawTable(el, list) {
  const cols = [
    ["cover", ""],
    ["id", "Code"],
    ["title", "Title"],
    ["area", "Area"],
    ["bedrooms", "BR"],
    ["bathrooms", "BA"],
    ["monthly_price_idr", "Monthly"],
    ["yearly_price_idr", "Yearly"],
    ["min_stay_months", "Min stay"],
    ["freeFrom", "Free from"],
    ["status", "Status"],
    ["photos", "Photos"],
    ["video", "Video"],
    ["garden", "Garden"],
    ["workspace", "Workspace"],
    ["living_room", "Living"],
    ["owner", "Owner"],
    ["crm", "CRM card"],
    ["updated_at", "Updated"],
  ];
  const val = (v, k) =>
    k === "photos" ? (v.images || []).length : k === "video" ? (v.video_url ? 1 : 0) : k === "owner" ? v.private?.owner_name || null : k === "status" ? (v.is_draft ? "draft" : v.pre_listed ? "pre" : "listed") : k === "crm" ? v.crmLeadId : v[k] ?? null;
  const sorted = [...list].sort((a, b) => {
    const x = val(a, vsort.k);
    const y = val(b, vsort.k);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (x > y ? 1 : x < y ? -1 : 0) * vsort.dir;
  });
  const cell = (v, k) => {
    switch (k) {
      case "cover":
        return `<img class="thumb" src="${esc(coverUrl(v.images, 300))}" alt="" loading="lazy">`;
      case "id":
        return `<span class="mono">${esc(v.id)}</span>`;
      case "monthly_price_idr":
      case "yearly_price_idr":
        return `<span class="num">${money(v[k])}</span>`;
      case "freeFrom":
        return freeLabel(v);
      case "status":
        return statusPill(v);
      case "photos":
        return `<span class="num ${(v.images || []).length < 8 ? "faint" : ""}">${(v.images || []).length}</span>`;
      case "video":
        return v.video_url ? I.video : `<span class="faint">—</span>`;
      case "garden":
      case "workspace":
      case "living_room":
        return v[k] ? esc(v[k]) : `<span class="faint">not checked</span>`;
      case "owner":
        return esc(v.private?.owner_name || "");
      case "crm":
        return v.crmLeadId ? `<a href="#" data-open-lead="${esc(v.crmLeadId)}">#${esc(v.crmLeadId)}</a>` : `<span class="faint">—</span>`;
      case "updated_at":
        return `<span class="age">${esc(rel(v.updated_at))}</span>`;
      default:
        return esc(v[k] ?? "");
    }
  };
  el.innerHTML = `<div class="tbl-wrap"><table class="grid"><thead><tr>${cols.map(([k, l]) => `<th data-sort="${k}" class="${vsort.k === k ? "sorted" : ""}">${esc(l)}${vsort.k === k ? (vsort.dir > 0 ? " ↑" : " ↓") : ""}</th>`).join("")}</tr></thead>
    <tbody>${sorted.map((v) => `<tr data-villa="${esc(v.id)}">${cols.map(([k]) => `<td class="${k === "title" ? "ellip" : ""}">${cell(v, k)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
    <p class="faint" style="font-size:11.5px;margin:8px 2px">${sorted.length} villas · "not checked" is empty in the database, never "no" · free-from is read from the site's availability calendar.</p>`;
  on(el, "click", "[data-sort]", (e, th) => {
    const k = th.dataset.sort;
    if (k === "cover") return;
    vsort = { k, dir: vsort.k === k ? -vsort.dir : -1 };
    store.set("villa-sort", vsort);
    drawTable(el, list);
  });
  on(el, "click", "tr[data-villa]", (e, tr) => {
    if (e.target.closest("[data-open-lead]")) return;
    emit("open-peek", { type: "villa", id: tr.dataset.villa });
  });
  on(el, "click", "[data-open-lead]", (e, a) => {
    e.preventDefault();
    emit("open-peek", { type: "lead", id: a.dataset.openLead });
  });
}

// ── the villa panel ──
const FIELD_UI = [
  ["title", "Title", "text"],
  ["area", "Area", "text"],
  ["bedrooms", "Bedrooms", "number"],
  ["bathrooms", "Bathrooms", "number"],
  ["monthly_price_idr", "Monthly price (IDR, incl. our 10%)", "number"],
  ["yearly_price_idr", "Yearly price (IDR)", "number"],
  ["min_stay_months", "Minimum stay (months)", "number"],
  ["build_size", "Build size m²", "number"],
  ["land_size", "Land size m²", "number"],
  ["garden", "Garden", ["", "none", "small", "large"]],
  ["workspace", "Workspace", ["", "none", "desk", "office_room"]],
  ["living_room", "Living room", ["", "open", "enclosed"]],
  ["quiet_area", "Quiet street", ["", "true", "false"]],
  ["video_url", "Video tour URL", "text"],
  ["tags", "Tags (comma separated)", "list"],
  ["features", "Features (comma separated)", "list"],
  ["rental_included", "Included in the rent", "textarea"],
  ["rental_excluded", "Not included", "textarea"],
  ["description", "Description", "textarea"],
];
const PRIV_UI = [
  ["owner_name", "Owner / manager name", "text"],
  ["owner_phone", "Owner phone", "text"],
  ["owner_email", "Owner email", "text"],
  ["exact_address", "Exact address", "text"],
  ["google_maps_url", "Google Maps pin", "text"],
  ["drive_folder_url", "Google Drive folder", "text"],
  ["construction_nearby", "Construction nearby", ["", "true", "false"]],
  ["construction_checked_on", "Checked on", "date"],
  ["red_flags", "Red flags (one per line)", "textarea"],
  ["green_flags", "Green flags (one per line)", "textarea"],
  ["notes", "Notes", "textarea"],
];

function inputFor([k, label, type], value) {
  const v = value == null ? "" : Array.isArray(value) ? value.join(", ") : String(value);
  if (Array.isArray(type))
    return `<label class="fld"><span>${esc(label)}</span><select class="in" name="${k}">${type.map((o) => `<option value="${esc(o)}" ${o === v ? "selected" : ""}>${o === "" ? "not checked" : esc(o)}</option>`).join("")}</select></label>`;
  if (type === "textarea") return `<label class="fld" style="grid-column:1/-1"><span>${esc(label)}</span><textarea class="in" name="${k}" rows="${k === "description" ? 8 : 3}">${esc(v)}</textarea></label>`;
  return `<label class="fld"><span>${esc(label)}</span><input class="in" name="${k}" type="${type === "number" ? "number" : type === "date" ? "date" : "text"}" value="${esc(v)}"></label>`;
}
function readForm(form, spec, current) {
  const out = {};
  for (const [k, , type] of spec) {
    const el = form.querySelector(`[name="${k}"]`);
    if (!el) continue;
    let v = el.value;
    let cur = current[k];
    if (type === "number") v = v === "" ? null : Number(v);
    else if (type === "list") v = v.split(",").map((s) => s.trim()).filter(Boolean);
    else if (Array.isArray(type) && (v === "true" || v === "false")) v = v === "true";
    else if (Array.isArray(type) && v === "") v = null;
    else if (v === "" && (cur == null || cur === "")) v = cur ?? null;
    if (JSON.stringify(v ?? null) !== JSON.stringify(cur ?? null)) out[k] = v;
  }
  return out;
}

async function refreshVilla(id) {
  const v = await api(`/listings/${encodeURIComponent(id)}`);
  replaceVilla(v);
  return v;
}

peeks.villa = {
  defaultTab: "overview",
  async render(el, st, ctl) {
    let v;
    try {
      v = await refreshVilla(st.id);
    } catch (e) {
      el.innerHTML = `<div class="ph"><h2>${esc(st.id)}</h2><button class="iconbtn" data-close>${I.x}</button></div><div class="empty">${esc(e.message)}</div>`;
      el.querySelector("[data-close]").onclick = ctl.close;
      return;
    }
    const tabs = [
      ["overview", "Overview"],
      ["edit", "Edit"],
      ["photos", `Photos · ${(v.images || []).length}`],
      ["availability", "Availability"],
      ["internal", "Internal data"],
      ["ai", "Edit by voice"],
      ["matches", "Matching clients"],
    ];
    const tab = tabs.some((t) => t[0] === st.tab) ? st.tab : "overview";
    S.peek.tabByType = { ...(S.peek.tabByType || {}), villa: tab };
    el.innerHTML = `<div class="ph"><span class="mono">${esc(v.id)}</span><h2 title="${esc(v.title)}">${esc(v.title)}</h2>${statusPill(v)}<button class="iconbtn" data-close>${I.x}</button></div>
      <div class="tabs">${tabs.map(([k, l]) => `<button class="${k === tab ? "active" : ""}" data-tab="${k}">${esc(l)}</button>`).join("")}</div><div class="pb pad" id="vbody"></div>`;
    el.querySelector("[data-close]").onclick = ctl.close;
    on(el, "click", "[data-tab]", (e, b) => ctl.setTab(b.dataset.tab));
    const body = el.querySelector("#vbody");
    const again = () => ctl.setTab(tab);
    const P = v.private || {};

    if (tab === "overview") {
      const flags = [
        ...String(P.red_flags || "").split("\n").filter(Boolean).map((x) => `<div class="r">${esc(x)}</div>`),
        P.construction_nearby === true ? `<div class="r">Construction nearby</div>` : "",
        ...String(P.green_flags || "").split("\n").filter(Boolean).map((x) => `<div class="g">${esc(x)}</div>`),
      ].join("");
      body.innerHTML = `<img class="hero" src="${esc(coverUrl(v.images, 1200))}" alt="">
        <div class="row"><a class="btn primary" href="${esc(v.url)}" target="_blank" rel="noopener">${I.ext} Open on the site</a>${P.drive_folder_url ? `<a class="btn" href="${esc(P.drive_folder_url)}" target="_blank" rel="noopener">${I.drive} Drive folder</a>` : ""}${P.google_maps_url ? `<a class="btn" href="${esc(P.google_maps_url)}" target="_blank" rel="noopener">Map pin</a>` : ""}${v.video_url ? `<a class="btn" href="${esc(v.video_url)}" target="_blank" rel="noopener">${I.video} Video</a>` : ""}
          <button class="btn" data-copy="${esc(v.url)}">Copy link</button></div>
        <dl class="props"><dt>Area</dt><dd>${esc(v.area || "—")}</dd><dt>Rooms</dt><dd>${v.bedrooms ?? "?"} BR · ${v.bathrooms ?? "?"} BA</dd>
          <dt>Monthly</dt><dd>${money(v.monthly_price_idr)} <span class="faint">incl. our 10%</span></dd><dt>Yearly</dt><dd>${money(v.yearly_price_idr)}</dd>
          <dt>Min stay</dt><dd>${v.min_stay_months ? v.min_stay_months + " months" : "—"}</dd><dt>Free</dt><dd>${freeLabel(v)}</dd>
          <dt>Size</dt><dd>${v.build_size ? v.build_size + " m² build" : "—"}${v.land_size ? ` · ${v.land_size} m² land` : ""}</dd>
          <dt>Checked</dt><dd>garden: ${esc(v.garden || "?")} · workspace: ${esc(v.workspace || "?")} · living: ${esc(v.living_room || "?")} · quiet: ${v.quiet_area == null ? "?" : v.quiet_area ? "yes" : "no"}</dd>
          <dt>Owner</dt><dd>${esc(P.owner_name || "—")}</dd>
          <dt>CRM card</dt><dd>${v.crmLeadId ? `<a href="#" data-open-lead="${esc(v.crmLeadId)}">#${esc(v.crmLeadId)}</a>` : "<span class='faint'>not linked</span>"}</dd>
          <dt>Updated</dt><dd>${esc(rel(v.updated_at))}</dd></dl>
        ${flags ? `<div><div class="sect-h">Flags</div><div class="flags">${flags}</div></div>` : ""}
        ${v.description ? `<div><div class="sect-h">Description</div><div style="white-space:pre-wrap;font-size:12.5px">${esc(v.description)}</div></div>` : ""}`;
      on(body, "click", "[data-copy]", async (e, b) => {
        try {
          await navigator.clipboard.writeText(b.dataset.copy);
          toast("Link copied");
        } catch (err) {
          toast(b.dataset.copy);
        }
      });
      on(body, "click", "[data-open-lead]", (e, a) => {
        e.preventDefault();
        emit("open-peek", { type: "lead", id: a.dataset.openLead });
      });
    } else if (tab === "edit") {
      body.innerHTML = `<form id="vform" class="stack"><div class="grid2">${FIELD_UI.map((f) => inputFor(f, v[f[0]])).join("")}</div>
        <div class="grid2"><label class="fld"><span>Status on the site</span><select class="in" name="pre_listed"><option value="true" ${v.pre_listed ? "selected" : ""}>Pre-listed (not inspected yet)</option><option value="false" ${v.pre_listed ? "" : "selected"}>Listed (inspected — moves the card to live)</option></select></label></div>
        <div class="row"><button class="btn primary" type="submit">Save to the site</button><span class="faint" style="font-size:12px">Saved straight to the live website; the site's own rules check every change.</span></div></form>`;
      const form = body.querySelector("#vform");
      form.onsubmit = async (e) => {
        e.preventDefault();
        const patch = readForm(form, [...FIELD_UI, ["pre_listed", "", ["true", "false"]]], v);
        if (!Object.keys(patch).length) {
          toast("Nothing changed");
          return;
        }
        if ("pre_listed" in patch && patch.pre_listed === false && !(await confirmBox("Switch to Listed?", "Listed means the villa was inspected. The villa's CRM card moves to live automatically.", "Switch to Listed"))) return;
        const b = form.querySelector("button[type=submit]");
        b.disabled = true;
        try {
          const nv = await api(`/listings/${encodeURIComponent(v.id)}`, { method: "PATCH", body: patch });
          replaceVilla(nv);
          toast(`Saved: ${Object.keys(patch).join(", ")}`);
          again();
        } catch (err) {
          fail(err);
          b.disabled = false;
        }
      };
    } else if (tab === "photos") {
      let imgs = [...(v.images || [])];
      const draw = () => {
        body.innerHTML = `<div class="help">Drag to reorder: the first photo is the cover on the site. Remove with ×. Upload adds to the end. Nothing changes until you press Save.</div>
          <div class="photos" id="ph">${imgs.map((u, i) => `<div class="photo" draggable="true" data-i="${i}"><img src="${esc(imgUrl(u, 300))}" alt="" loading="lazy"><span class="n">${i === 0 ? "cover" : i + 1}</span><button class="x" data-rm="${i}" title="Remove">×</button></div>`).join("")}</div>
          <div class="row"><button class="btn primary" id="ph-save">Save order</button><label class="btn">${I.plus} Upload photos<input type="file" accept="image/*" multiple id="ph-up" hidden></label><button class="btn ghost" id="ph-reset">Undo changes</button><span class="faint" id="ph-st" style="font-size:12px"></span></div>`;
        const grid = body.querySelector("#ph");
        let dragI = null;
        grid.addEventListener("dragstart", (e) => {
          const p = e.target.closest(".photo");
          if (p) dragI = Number(p.dataset.i);
        });
        grid.addEventListener("dragover", (e) => {
          const p = e.target.closest(".photo");
          if (!p) return;
          e.preventDefault();
          grid.querySelectorAll(".over").forEach((x) => x.classList.remove("over"));
          p.classList.add("over");
        });
        grid.addEventListener("drop", (e) => {
          const p = e.target.closest(".photo");
          if (!p || dragI == null) return;
          e.preventDefault();
          const to = Number(p.dataset.i);
          const [m] = imgs.splice(dragI, 1);
          imgs.splice(to, 0, m);
          dragI = null;
          draw();
        });
        on(grid, "click", "[data-rm]", (e, b) => {
          imgs.splice(Number(b.dataset.rm), 1);
          draw();
        });
        body.querySelector("#ph-reset").onclick = () => {
          imgs = [...(v.images || [])];
          draw();
        };
        body.querySelector("#ph-save").onclick = async () => {
          try {
            const nv = await api(`/listings/${encodeURIComponent(v.id)}`, { method: "PATCH", body: { images: imgs } });
            replaceVilla(nv);
            v = nv;
            toast("Photos saved to the site");
            again();
          } catch (err) {
            fail(err);
          }
        };
        body.querySelector("#ph-up").onchange = async (e) => {
          const files = [...e.target.files];
          const stEl = body.querySelector("#ph-st");
          for (const [n, file] of files.entries()) {
            stEl.textContent = `Uploading ${n + 1} of ${files.length}…`;
            try {
              const { uploadUrl, publicUrl } = await api(`/listings/${encodeURIComponent(v.id)}/photo-url`, { body: { fileName: file.name } });
              const put = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": file.type || "image/jpeg" }, body: file });
              if (!put.ok) throw new Error(`Upload refused (${put.status})`);
              imgs.push(publicUrl);
            } catch (err) {
              fail(err);
            }
          }
          stEl.textContent = "";
          draw();
          toast("Uploaded — press Save order to put them on the site");
        };
      };
      draw();
    } else if (tab === "availability") {
      const rows = (v.availability || []).map((a) => `<div class="note">${esc(a.status)} ${esc(a.start_date || "")} → ${esc(a.end_date === "2099-12-31" ? "open" : a.end_date || "")}${a.note ? `<br><span class="faint">${esc(a.note)}</span>` : ""}</div>`).join("");
      body.innerHTML = `<dl class="props"><dt>Now</dt><dd>${freeLabel(v)}</dd></dl>
        <div class="panel"><h3>Set when it is free</h3><div class="row"><input class="in" type="date" id="av-date" style="max-width:200px" value="${esc(v.freeFrom || "")}"><button class="btn primary" id="av-save">Free from this date</button><button class="btn" id="av-now">Free now</button><button class="btn danger" id="av-occ">Taken, date unknown</button></div>
        <p class="faint" style="font-size:12px;margin:8px 0 0">Written through the same writer as the weekly owner check, and read back from the site. The Copilot stops offering a villa free more than 92 days out.</p></div>
        <div><div class="sect-h">Calendar rows on the site</div><div class="stack">${rows || `<span class="faint">none — the villa counts as free now</span>`}</div></div>`;
      const run = async (payload, label) => {
        try {
          const r = await api(`/listings/${encodeURIComponent(v.id)}/availability`, { body: payload });
          toast(r.written ? label : r.detail, { bad: !r.written && !/nothing to change/.test(r.detail) });
          if (r.listing) replaceVilla(r.listing);
          again();
        } catch (err) {
          fail(err);
        }
      };
      body.querySelector("#av-save").onclick = () => run({ freeFrom: body.querySelector("#av-date").value || null }, "Saved on the site");
      body.querySelector("#av-now").onclick = () => run({ freeFrom: null }, "Marked free now");
      body.querySelector("#av-occ").onclick = () => run({ occupiedNoDate: true }, "Marked taken");
    } else if (tab === "internal") {
      body.innerHTML = `<form id="pform" class="stack"><div class="help">Internal data never reaches clients. The site will not publish a listing without owner name, phone, address or pin, Drive folder and notes.</div>
        <div class="grid2">${PRIV_UI.map((f) => inputFor(f, P[f[0]] === true ? "true" : P[f[0]] === false ? "false" : P[f[0]])).join("")}</div>
        <div class="row"><button class="btn primary" type="submit">Save internal data</button></div></form>`;
      const form = body.querySelector("#pform");
      form.onsubmit = async (e) => {
        e.preventDefault();
        const patch = readForm(form, PRIV_UI, P);
        if (!Object.keys(patch).length) {
          toast("Nothing changed");
          return;
        }
        try {
          const nv = await api(`/listings/${encodeURIComponent(v.id)}/private`, { method: "PATCH", body: patch });
          replaceVilla(nv);
          toast("Internal data saved");
          again();
        } catch (err) {
          fail(err);
        }
      };
    } else if (tab === "ai") {
      body.innerHTML = `<div class="help">Say or type what to change, in any language: “price 48 million a month, free from 1 November, add a red flag: road noise at night”. The Copilot proposes the exact changes; nothing is saved until you press Apply.</div>
        <textarea class="in" id="ai-text" rows="4" placeholder="What should change?"></textarea>
        <div class="row"><button class="btn" id="ai-mic">${I.mic} Dictate</button><button class="btn primary" id="ai-go">${I.sparkle} Propose changes</button></div><div id="ai-out"></div>`;
      const ta = body.querySelector("#ai-text");
      body.querySelector("#ai-mic").onclick = (e) => recordVoice(e.currentTarget, (t) => (ta.value = (ta.value ? ta.value + " " : "") + t));
      body.querySelector("#ai-go").onclick = async (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        const out = body.querySelector("#ai-out");
        out.innerHTML = `<div class="loading">Reading the listing…</div>`;
        try {
          const r = await api(`/listings/${encodeURIComponent(v.id)}/ai-edit`, { body: { instruction: ta.value } });
          const show = (x) => (x == null || x === "" ? "—" : Array.isArray(x) ? x.join(", ") : String(x));
          out.innerHTML = `<div class="panel"><h3>${esc(r.summary || "Proposed changes")}</h3><div class="diff">${
            r.diff.map((d) => `<div class="d"><b>${esc(d.field)}${d.scope === "private" ? " · internal" : ""}</b><div class="from">${esc(show(d.from)).slice(0, 600)}</div><div class="to">${esc(show(d.to)).slice(0, 1200)}</div></div>`).join("") || `<span class="faint">No field changes.</span>`
          }${r.freeFrom ? `<div class="d"><b>availability</b><div class="to">${r.freeFrom === "now" ? "free now" : "free from " + esc(r.freeFrom)}</div></div>` : ""}</div>
          ${r.questions?.length ? `<div class="note" style="margin-top:8px">${r.questions.map(esc).join("<br>")}</div>` : ""}
          <div class="row" style="margin-top:10px">${r.diff.length || r.freeFrom ? `<button class="btn primary" id="ai-apply">Apply to the site</button>` : ""}<button class="btn ghost" id="ai-discard">Discard</button></div></div>`;
          out.querySelector("#ai-discard").onclick = () => (out.innerHTML = "");
          const ap = out.querySelector("#ai-apply");
          if (ap)
            ap.onclick = async () => {
              ap.disabled = true;
              try {
                if (Object.keys(r.changes || {}).length) await api(`/listings/${encodeURIComponent(v.id)}`, { method: "PATCH", body: r.changes });
                if (Object.keys(r.privateChanges || {}).length) await api(`/listings/${encodeURIComponent(v.id)}/private`, { method: "PATCH", body: r.privateChanges });
                if (r.freeFrom) await api(`/listings/${encodeURIComponent(v.id)}/availability`, { body: { freeFrom: r.freeFrom === "now" ? null : r.freeFrom } });
                await refreshVilla(v.id);
                toast("Applied to the site");
                ctl.setTab("overview");
              } catch (err) {
                fail(err);
                ap.disabled = false;
              }
            };
        } catch (err) {
          out.innerHTML = "";
          fail(err);
        } finally {
          b.disabled = false;
        }
      };
    } else if (tab === "matches") {
      body.innerHTML = `<div class="loading">Finding clients this villa fits…</div>`;
      try {
        const r = await api(`/listings/${encodeURIComponent(v.id)}/matches`);
        body.innerHTML = `<div class="help">Open Rental clients (active in the last 45 days) whose bedrooms, area and budget corridor (70–125%) fit this villa. Open one to send it through the Copilot.</div>
          <div class="stack">${
            r.items
              .map((c) => `<div class="task" style="grid-template-columns:minmax(0,1fr) auto;cursor:pointer" data-open-lead="${esc(c.leadId)}"><div><div class="tt">${esc(c.name)} <span class="pill stage">${esc(c.stage || "")}</span></div><div class="ts">${c.bedrooms ? c.bedrooms + "BR · " : ""}${esc(c.areas || "any area")} · ${money(c.budget)} · ${esc(c.responsible || "")}</div></div><span class="due">${esc(rel(c.lastMessageAt))}</span></div>`)
              .join("") || `<div class="empty">No open client fits this villa right now.</div>`
          }</div>`;
        on(body, "click", "[data-open-lead]", (e, a) => emit("open-peek", { type: "lead", id: a.dataset.openLead, tab: "copilot" }));
      } catch (err) {
        body.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
      }
    }
  },
};
