// Unicorn OS — Listings: the website itself inside the OS, and a list view the site has no need of.
// Nothing about a listing is re-implemented here: pages, photos, editing and
// the admin all come from the site (unicorn-properties.com); the OS adds the
// list with every criterion and the clients a listing fits.
import { S, api, esc, I, screens, peeks, store, on, money, fmtDate, rel, coverUrl, emit, baliToday } from "./core.js";

// On the agency's domain the site is same-origin; on the Copilot host it is the full address.
export const SITE = location.hostname.endsWith("unicorn-properties.com") ? "" : "https://unicorn-properties.com";
const SITE_ABS = "https://unicorn-properties.com";

export async function loadVillas(force, drafts) {
  const key = drafts ? "villas:rent+drafts" : "villas:rent";
  const c = S.cache[key];
  if (!force && c && Date.now() - c.at < 5 * 60_000) return c.value;
  const r = await api(`/listings?type=rent${drafts ? "&drafts=1" : ""}`);
  S.cache[key] = { at: Date.now(), value: r.items };
  return r.items;
}

const soonLimit = () => new Date(Date.now() + 92 * 86400e3).toISOString().slice(0, 10);
function freeLabel(v) {
  if (!v.freeFrom) return `<span class="pill ok">free now</span>`;
  const far = v.freeFrom > soonLimit();
  return `<span class="pill ${far ? "bad" : "warn"}" title="${far ? "beyond 92 days — not offered" : ""}">from ${esc(fmtDate(v.freeFrom))}</span>`;
}
const statusPill = (v) => (v.is_draft ? `<span class="pill">Draft</span>` : v.pre_listed ? `<span class="pill">Pre-listed</span>` : `<span class="pill ok">Listed</span>`);

const SECTIONS = [
  ["rent", "Rent", "/rent"],
  ["sale", "Sale", "/"],
  ["map", "Map", "/map"],
  ["admin", "Admin", "/admin"],
];

screens.listings = {
  title: "Listings",
  flush: true,
  async render({ el, tools }) {
    const f = store.get("listing-filters", { view: "site", section: "rent", beds: "", area: "", max: "", free: "", status: "", q: "", drafts: false });
    if (!["site", "list"].includes(f.view)) f.view = "site";
    const save = () => store.set("listing-filters", f);
    const views = `<div class="views"><button data-view="site" class="${f.view === "site" ? "active" : ""}">${I.villa}Site</button><button data-view="list" class="${f.view === "list" ? "active" : ""}">${I.table}List</button></div>`;
    tools.querySelectorAll("[data-view]").forEach(() => undefined);
    if (f.view === "site") {
      const sec = SECTIONS.find((x) => x[0] === f.section) || SECTIONS[0];
      tools.innerHTML = `${views}<div class="views">${SECTIONS.map(([k, l]) => `<button data-sec="${k}" class="${k === sec[0] ? "active" : ""}">${l}</button>`).join("")}</div>
        <a class="btn sm ghost" id="site-tab" href="${SITE_ABS}${sec[2]}" target="_blank" rel="noopener">${I.ext} New tab</a>`;
      el.innerHTML = `<iframe class="site-frame" id="site-frame" title="unicorn-properties.com" src="${SITE}${esc(f.path || sec[2])}"></iframe>`;
      const frame = el.querySelector("#site-frame");
      // Same origin on the agency's domain: remember where the broker was on the site.
      frame.addEventListener("load", () => {
        try {
          const p = frame.contentWindow.location.pathname + frame.contentWindow.location.search;
          f.path = p;
          save();
          document.getElementById("site-tab")?.setAttribute("href", SITE_ABS + p);
        } catch (e) {
          /* another origin: nothing to remember */
        }
      });
      tools.querySelectorAll("[data-sec]").forEach((b) =>
        b.addEventListener("click", () => {
          f.section = b.dataset.sec;
          f.path = null;
          save();
          screens.listings.render({ el, tools });
        }),
      );
    } else {
      tools.innerHTML = `${views}
        <select class="chip" id="vf-beds"><option value="">Any BR</option>${[1, 2, 3, 4, 5].map((n) => `<option ${String(n) === f.beds ? "selected" : ""} value="${n}">${n} BR${n === 5 ? "+" : ""}</option>`).join("")}</select>
        <select class="chip" id="vf-area"><option value="">Any area</option></select>
        <select class="chip" id="vf-max"><option value="">Any price</option>${[30, 40, 50, 60, 80, 100, 150].map((n) => `<option value="${n}" ${String(n) === f.max ? "selected" : ""}>≤ Rp ${n}M</option>`).join("")}</select>
        <select class="chip" id="vf-free"><option value="">Any availability</option><option value="now" ${f.free === "now" ? "selected" : ""}>Free now</option><option value="30" ${f.free === "30" ? "selected" : ""}>Free within 30 days</option><option value="92" ${f.free === "92" ? "selected" : ""}>Free within 92 days</option></select>
        <select class="chip" id="vf-status"><option value="">Pre-listed + Listed</option><option value="listed" ${f.status === "listed" ? "selected" : ""}>Listed</option><option value="pre" ${f.status === "pre" ? "selected" : ""}>Pre-listed</option></select>
        <button class="chip ${f.drafts ? "on" : ""}" id="vf-drafts">Drafts too</button>
        <input class="in" id="vf-q" placeholder="Code, title, area…" value="${esc(f.q)}" style="width:170px;padding:5px 8px">`;
      el.innerHTML = `<div class="list-wrap"><div class="loading">Loading the catalog…</div></div>`;
      const wrap = el.querySelector(".list-wrap");
      let all;
      try {
        all = await loadVillas(false, f.drafts);
      } catch (e) {
        wrap.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
        return;
      }
      const areas = [...new Set(all.map((v) => v.area).filter(Boolean))].sort();
      document.getElementById("vf-area").innerHTML += areas.map((a) => `<option ${a === f.area ? "selected" : ""}>${esc(a)}</option>`).join("");
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
      document.getElementById("vf-drafts").onclick = () => {
        f.drafts = !f.drafts;
        save();
        screens.listings.render({ el, tools });
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
      const draw = () => drawTable(wrap, filt());
      draw();
    }
    tools.querySelectorAll("[data-view]").forEach((b) =>
      b.addEventListener("click", () => {
        f.view = b.dataset.view;
        save();
        screens.listings.render({ el, tools });
      }),
    );
  },
};
// Old links (#/villas) land on Listings.
screens.villas = { title: "Listings", render: () => (location.hash = "#/listings") };

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
    <p class="faint" style="font-size:11.5px;margin:8px 2px">${sorted.length} listings · "not checked" is empty in the database, never "no" · free-from is read from the site's availability calendar · a row opens the listing's page from the site.</p>`;
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

// ── a listing in the side panel: its page from the site, and the clients it fits ──
peeks.villa = {
  defaultTab: "page",
  async render(el, st, ctl) {
    const id = st.id;
    const tabs = [
      ["page", "Page"],
      ["matches", "Clients who fit"],
    ];
    const tab = tabs.some((t) => t[0] === st.tab) ? st.tab : "page";
    S.peek.tabByType = { ...(S.peek.tabByType || {}), villa: tab };
    el.innerHTML = `<div class="resize-x" id="vp-resize" title="Drag to resize"></div>
      <div class="ph"><div class="avatar villa">${I.villa}</div><div style="min-width:0;flex:1"><h2 class="mono">${esc(id)}</h2><div class="faint" style="font-size:12px">From unicorn-properties.com</div></div>
        <a class="btn sm ghost" href="${SITE_ABS}/admin/property/${encodeURIComponent(id)}" target="_blank" rel="noopener" title="The site's edit form">Edit on the site</a>
        <a class="iconbtn" href="${SITE_ABS}/property/${encodeURIComponent(id)}" target="_blank" rel="noopener" title="Open in a new tab">${I.ext}</a>
        <button class="iconbtn" data-close title="Close (Esc)">${I.x}</button></div>
      <div class="tabs">${tabs.map(([k, l]) => `<button class="${k === tab ? "active" : ""}" data-tab="${k}">${esc(l)}</button>`).join("")}</div>
      <div class="pb" id="vp-body"></div>`;
    el.querySelector("[data-close]").onclick = ctl.close;
    on(el, "click", "[data-tab]", (e, b) => ctl.setTab(b.dataset.tab));
    const { resizer } = await import("./core.js");
    resizer(el.querySelector("#vp-resize"), { varName: "--peek-w", min: 360, max: Math.max(420, window.innerWidth - 200), invert: true });
    const body = el.querySelector("#vp-body");
    if (tab === "page") {
      body.style.overflow = "hidden";
      body.innerHTML = `<iframe class="site-frame" title="${esc(id)}" src="${SITE}/property/${encodeURIComponent(id)}"></iframe>`;
      return;
    }
    body.classList.add("pad");
    body.innerHTML = `<div class="loading">Finding clients this listing fits…</div>`;
    try {
      const r = await api(`/listings/${encodeURIComponent(id)}/matches`);
      body.innerHTML = `<div class="help">Open Rental clients (active in the last 45 days) whose bedrooms, area and budget corridor (70–125%) fit this listing. Open one to send it through the Copilot.</div>
        <div class="stack">${
          r.items
            .map((c) => `<div class="task" style="grid-template-columns:minmax(0,1fr) auto;cursor:pointer" data-open-lead="${esc(c.leadId)}"><div><div class="tt">${esc(c.name)} <span class="pill stage">${esc(c.stage || "")}</span></div><div class="ts">${c.bedrooms ? c.bedrooms + "BR · " : ""}${esc(c.areas || "any area")} · ${money(c.budget)} · ${esc(c.responsible || "")}</div></div><span class="due">${esc(rel(c.lastMessageAt))}</span></div>`)
            .join("") || `<div class="empty">No open client fits this listing right now.</div>`
        }</div>`;
      on(body, "click", "[data-open-lead]", (e, a) => emit("open-peek", { type: "lead", id: a.dataset.openLead, tab: "copilot" }));
    } catch (err) {
      body.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    }
  },
};
