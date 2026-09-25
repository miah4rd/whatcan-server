// Unicorn OS — Listings: the website itself inside the OS, and a list view the site has no need of.
// Nothing about a listing is re-implemented here: pages, photos, editing and
// the admin all come from the site (unicorn-properties.com); the OS adds the
// list with every criterion and the clients a listing fits.
import { S, api, esc, I, screens, peeks, store, on, money, fmtDate, rel, coverUrl, emit, baliToday } from "./core.js";
import { gridTable } from "./grid.js";

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

// The list: every field of a listing, the internal data included; the person picks the columns,
// their order and width (grid.js). Defaults are what the owner asked for on 26.09.
const P = (v) => v.private || {};
const faintDash = `<span class="faint">—</span>`;
const checked = (x) => (x == null || x === "" ? `<span class="faint">not checked</span>` : x === true ? "yes" : x === false ? "no" : esc(x));
const link = (url, label) => (url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${label}</a>` : faintDash);
const lines = (x) => (x ? esc(String(x).replace(/\n+/g, " · ")) : faintDash);
const waDigits = (p) => String(p || "").replace(/[^0-9]/g, "");
const LISTING_COLUMNS = [
  { k: "cover", label: "", w: 64, sortable: false, defaultOn: true, cell: (v) => `<img class="thumb" src="${esc(coverUrl(v.images, 300))}" alt="" loading="lazy">` },
  { k: "id", label: "Code", group: "Listing", w: 110, defaultOn: true, cell: (v) => `<span class="mono">${esc(v.id)}</span>` },
  { k: "title", label: "Title", group: "Listing", w: 260, defaultOn: true },
  { k: "area", label: "Area", group: "Listing", w: 120, defaultOn: true },
  { k: "type", label: "Type", group: "Listing", w: 90 },
  { k: "bedrooms", label: "BR", group: "Listing", w: 56, align: "right", defaultOn: true },
  { k: "bathrooms", label: "BA", group: "Listing", w: 56, align: "right" },
  { k: "land_size", label: "Land m²", group: "Listing", w: 84, align: "right", cell: (v) => (v.land_size ? esc(v.land_size) : faintDash) },
  { k: "build_size", label: "Build m²", group: "Listing", w: 84, align: "right", cell: (v) => (v.build_size ? esc(v.build_size) : faintDash) },
  { k: "tags", label: "Highlights", group: "Listing", w: 200, val: (v) => (v.tags || []).join(", "), cell: (v) => ((v.tags || []).length ? esc(v.tags.join(", ")) : faintDash) },
  { k: "status", label: "Status", group: "Listing", w: 100, defaultOn: true, val: (v) => (v.is_draft ? "draft" : v.pre_listed ? "pre" : "listed"), cell: statusPill },
  { k: "listing_source", label: "Source", group: "Listing", w: 90 },
  { k: "ownership", label: "Ownership", group: "Listing", w: 100 },
  { k: "monthly_price_idr", label: "Monthly", group: "Price and terms", w: 104, align: "right", defaultOn: true, cell: (v) => `<span class="num">${money(v.monthly_price_idr)}</span>` },
  { k: "yearly_price_idr", label: "Yearly", group: "Price and terms", w: 110, align: "right", cell: (v) => `<span class="num">${money(v.yearly_price_idr)}</span>` },
  { k: "min_stay_months", label: "Min stay", group: "Price and terms", w: 80, align: "right", cell: (v) => (v.min_stay_months ? `${esc(v.min_stay_months)} mo` : faintDash) },
  { k: "rental_included", label: "Included", group: "Price and terms", w: 220, cell: (v) => lines(v.rental_included) },
  { k: "rental_excluded", label: "Excluded", group: "Price and terms", w: 200, cell: (v) => lines(v.rental_excluded) },
  { k: "freeFrom", label: "Free from", group: "Availability", w: 130, defaultOn: true, val: (v) => v.freeFrom || "0000", cell: freeLabel },
  { k: "photos", label: "Photos", group: "Media", w: 70, align: "right", val: (v) => (v.images || []).length, cell: (v) => `<span class="num ${(v.images || []).length < 8 ? "faint" : ""}">${(v.images || []).length}</span>` },
  { k: "video", label: "Video", group: "Media", w: 64, val: (v) => (v.video_url ? 1 : 0), cell: (v) => (v.video_url ? I.video : faintDash) },
  { k: "garden", label: "Garden", group: "Checked on site", w: 96, cell: (v) => checked(v.garden) },
  { k: "workspace", label: "Workspace", group: "Checked on site", w: 100, cell: (v) => checked(v.workspace) },
  { k: "living_room", label: "Living", group: "Checked on site", w: 96, cell: (v) => checked(v.living_room) },
  { k: "pool_sun", label: "Pool sun", group: "Checked on site", w: 96, cell: (v) => checked(v.pool_sun) },
  { k: "quiet_area", label: "Quiet area", group: "Checked on site", w: 96, cell: (v) => checked(v.quiet_area) },
  { k: "owner_name", label: "Owner", group: "Internal data", w: 200, defaultOn: true, val: (v) => P(v).owner_name || null, cell: (v) => (P(v).owner_name ? esc(P(v).owner_name) : faintDash) },
  { k: "owner_phone", label: "Owner phone", group: "Internal data", w: 160, defaultOn: true, val: (v) => P(v).owner_phone || null, cell: (v) => (P(v).owner_phone ? `<a href="https://wa.me/${esc(waDigits(P(v).owner_phone))}" target="_blank" rel="noopener" class="mono" title="Open in WhatsApp">${esc(P(v).owner_phone)}</a>` : faintDash) },
  { k: "owner_email", label: "Owner email", group: "Internal data", w: 200, val: (v) => P(v).owner_email || null, cell: (v) => (P(v).owner_email ? `<a href="mailto:${esc(P(v).owner_email)}">${esc(P(v).owner_email)}</a>` : faintDash) },
  { k: "drive_folder_url", label: "Drive", group: "Internal data", w: 76, defaultOn: true, val: (v) => (P(v).drive_folder_url ? 1 : 0), cell: (v) => link(P(v).drive_folder_url, `${I.drive} Open`) },
  { k: "google_maps_url", label: "Maps", group: "Internal data", w: 76, defaultOn: true, val: (v) => (P(v).google_maps_url ? 1 : 0), cell: (v) => link(P(v).google_maps_url, "Map") },
  { k: "exact_address", label: "Address", group: "Internal data", w: 240, val: (v) => P(v).exact_address || null, cell: (v) => lines(P(v).exact_address) },
  { k: "notes", label: "Notes", group: "Internal data", w: 260, val: (v) => P(v).notes || null, cell: (v) => lines(P(v).notes) },
  { k: "red_flags", label: "Red flags", group: "Internal data", w: 220, val: (v) => P(v).red_flags || null, cell: (v) => lines(P(v).red_flags) },
  { k: "green_flags", label: "Green flags", group: "Internal data", w: 220, val: (v) => P(v).green_flags || null, cell: (v) => lines(P(v).green_flags) },
  { k: "construction_nearby", label: "Construction nearby", group: "Internal data", w: 120, val: (v) => P(v).construction_nearby ?? null, cell: (v) => (P(v).construction_nearby === true ? `<span class="pill bad">yes</span>` : checked(P(v).construction_nearby)) },
  { k: "construction_checked_on", label: "Construction checked", group: "Internal data", w: 120, val: (v) => P(v).construction_checked_on || null, cell: (v) => (P(v).construction_checked_on ? esc(fmtDate(P(v).construction_checked_on)) : faintDash) },
  { k: "crm", label: "CRM card", group: "Links", w: 100, defaultOn: true, val: (v) => v.crmLeadId, cell: (v) => (v.crmLeadId ? `<a href="#" data-open-lead="${esc(v.crmLeadId)}">#${esc(v.crmLeadId)}</a>` : faintDash) },
  { k: "url", label: "Site page", group: "Links", w: 84, sortable: false, cell: (v) => link(`${SITE_ABS}/property/${encodeURIComponent(v.id)}`, `${I.ext} Open`) },
  { k: "views", label: "Page views", group: "Activity", w: 90, align: "right" },
  { k: "created_at", label: "Created", group: "Activity", w: 100, cell: (v) => `<span class="age">${esc(rel(v.created_at))}</span>` },
  { k: "updated_at", label: "Updated", group: "Activity", w: 100, defaultOn: true, cell: (v) => `<span class="age">${esc(rel(v.updated_at))}</span>` },
];

function drawTable(el, list) {
  gridTable(el, {
    id: "listings",
    rows: list,
    columns: LISTING_COLUMNS,
    sort: { k: "updated_at", dir: -1 },
    rowAttr: (v) => `data-villa="${esc(v.id)}"`,
    count: (n) => `${n} listing${n === 1 ? "" : "s"}`,
    note: '"not checked" is empty in the database, never "no". Free-from is read from the site\'s availability calendar. A row opens the listing\'s page from the site.',
    onRow: (e, tr) => emit("open-peek", { type: "villa", id: tr.dataset.villa }),
  });
  on(el, "click", "[data-open-lead]", (e, a) => {
    e.preventDefault();
    e.stopPropagation();
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
