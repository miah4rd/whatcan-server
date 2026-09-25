// Unicorn OS — one table for every list: pick the columns, drag their order, drag their width,
// sort by any of them, wrap long text (owner, 26.09: "as in Notion"). The layout is a per-viewer
// convenience and lives in this browser.
import { esc, I, store, on } from "./core.js";

/**
 * gridTable(el, spec) draws the table into `el` and redraws itself on every change.
 * spec: {
 *   id: storage key, rows, rowAttr(row) → 'data-x="…"',
 *   columns: [{ k, label, group, w, val(row) (sort), cell(row) → html, sortable?: false, defaultOn?: true, align?: "right" }],
 *   note: text under the column menu, count(n) → "107 listings", onRow(e, tr)
 * }
 */
export function gridTable(el, spec) {
  const key = "grid:" + spec.id;
  const cols = spec.columns;
  const byK = new Map(cols.map((c) => [c.k, c]));
  const fresh = () => ({ order: cols.filter((c) => c.defaultOn).map((c) => c.k), widths: {}, sort: spec.sort || null, wrap: false });
  let cfg = { ...fresh(), ...store.get(key, {}) };
  cfg.order = (cfg.order || []).filter((k) => byK.has(k));
  if (!cfg.order.length) cfg.order = fresh().order;
  const save = () => store.set(key, cfg);
  const width = (c) => cfg.widths[c.k] || c.w || 140;

  const sorted = () => {
    const s = cfg.sort && byK.get(cfg.sort.k);
    if (!s) return spec.rows;
    const val = s.val || ((r) => r[s.k]);
    return [...spec.rows].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      const nx = x == null || x === "";
      const ny = y == null || y === "";
      if (nx && ny) return 0;
      if (nx) return 1;
      if (ny) return -1;
      return (typeof x === "string" ? x.localeCompare(y) : x > y ? 1 : x < y ? -1 : 0) * cfg.sort.dir;
    });
  };

  function draw() {
    const shown = cfg.order.map((k) => byK.get(k));
    const total = shown.reduce((s, c) => s + width(c), 0);
    const rows = sorted();
    el.innerHTML = `<div class="grid-bar"><span class="faint">${esc(spec.count ? spec.count(rows.length) : rows.length + " rows")}</span><span class="spacer"></span>
        <button class="btn sm ghost" data-g="cols">${I.table} Columns · ${shown.length}</button></div>
      <div class="grid-scroll"><table class="grid gt ${cfg.wrap ? "wrap" : ""}" style="width:${total}px">
        <colgroup>${shown.map((c) => `<col style="width:${width(c)}px">`).join("")}</colgroup>
        <thead><tr>${shown
          .map((c) => {
            const on = cfg.sort?.k === c.k;
            return `<th data-k="${c.k}" draggable="true" class="${on ? "sorted" : ""} ${c.align === "right" ? "r" : ""}" title="${esc(c.label || "")}${c.sortable === false ? "" : " · click to sort, drag to move"}"><span class="gl">${esc(c.label || "")}${on ? (cfg.sort.dir > 0 ? " ↑" : " ↓") : ""}</span><span class="col-rs" data-rs="${c.k}" title="Drag to resize · double-click to reset"></span></th>`;
          })
          .join("")}</tr></thead>
        <tbody>${rows.map((r) => `<tr ${spec.rowAttr ? spec.rowAttr(r) : ""}>${shown.map((c) => `<td class="${c.align === "right" ? "r" : ""}">${c.cell ? c.cell(r) : esc(r[c.k] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody>
      </table>${rows.length ? "" : `<div class="empty">Nothing matches these filters.</div>`}</div>`;
    bind();
  }

  function bind() {
    const table = el.querySelector("table.gt");
    // widths: drag the right edge of a header
    el.querySelectorAll("[data-rs]").forEach((h) => {
      h.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const k = h.dataset.rs;
        const th = h.parentElement;
        const i = [...th.parentElement.children].indexOf(th);
        const colEl = table.querySelectorAll("col")[i];
        const x0 = e.clientX;
        const w0 = width(byK.get(k));
        const t0 = table.offsetWidth;
        th.draggable = false;
        document.body.classList.add("col-resizing");
        const mv = (ev) => {
          const w = Math.max(44, Math.min(900, w0 + ev.clientX - x0));
          colEl.style.width = w + "px";
          table.style.width = t0 + (w - w0) + "px";
          cfg.widths[k] = w;
        };
        const up = () => {
          document.removeEventListener("pointermove", mv);
          document.removeEventListener("pointerup", up);
          document.body.classList.remove("col-resizing");
          th.draggable = true;
          th._justResized = true;
          setTimeout(() => (th._justResized = false), 50);
          save();
        };
        document.addEventListener("pointermove", mv);
        document.addEventListener("pointerup", up);
      });
      h.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        delete cfg.widths[h.dataset.rs];
        save();
        draw();
      });
    });
    // sort: click a header
    on(el, "click", "th[data-k]", (e, th) => {
      if (th._justResized || e.target.closest("[data-rs]")) return;
      const c = byK.get(th.dataset.k);
      if (c.sortable === false) return;
      // Text sorts A→Z first, numbers and dates largest/newest first; a second click flips it.
      const val = c.val || ((r) => r[c.k]);
      const sample = spec.rows.map(val).find((x) => x != null && x !== "");
      const textual = typeof sample === "string" && !/^\d{4}-\d\d-\d\d/.test(sample);
      cfg.sort = { k: c.k, dir: cfg.sort?.k === c.k ? -cfg.sort.dir : textual ? 1 : -1 };
      save();
      draw();
    });
    // order: drag a header onto another
    let dragK = null;
    el.querySelectorAll("th[data-k]").forEach((th) => {
      th.addEventListener("dragstart", (e) => {
        dragK = th.dataset.k;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", dragK);
        th.classList.add("dragging");
      });
      th.addEventListener("dragend", () => th.classList.remove("dragging"));
      th.addEventListener("dragover", (e) => {
        if (!dragK || dragK === th.dataset.k) return;
        e.preventDefault();
        const b = th.getBoundingClientRect();
        const after = e.clientX > b.left + b.width / 2;
        el.querySelectorAll("th.drop-l,th.drop-r").forEach((x) => x.classList.remove("drop-l", "drop-r"));
        th.classList.add(after ? "drop-r" : "drop-l");
      });
      th.addEventListener("dragleave", () => th.classList.remove("drop-l", "drop-r"));
      th.addEventListener("drop", (e) => {
        e.preventDefault();
        const after = th.classList.contains("drop-r");
        th.classList.remove("drop-l", "drop-r");
        if (!dragK || dragK === th.dataset.k) return;
        const order = cfg.order.filter((k) => k !== dragK);
        order.splice(order.indexOf(th.dataset.k) + (after ? 1 : 0), 0, dragK);
        cfg.order = order;
        dragK = null;
        save();
        draw();
      });
    });
    if (spec.onRow) on(el, "click", "tbody tr", (e, tr) => (e.target.closest("a,button,input,select") ? undefined : spec.onRow(e, tr)));
    el.querySelector('[data-g="cols"]').onclick = (e) => columnMenu(e.currentTarget);
  }

  function columnMenu(anchor) {
    document.querySelector(".gmenu")?.remove();
    const m = document.createElement("div");
    m.className = "gmenu";
    const groups = [...new Set(cols.map((c) => c.group || ""))];
    const paint = (q = "") => {
      const hit = (c) => !q || (c.label || c.k).toLowerCase().includes(q.toLowerCase());
      m.querySelector(".gm-list").innerHTML = groups
        .map((g) => {
          const cs = cols.filter((c) => (c.group || "") === g && c.label && hit(c));
          if (!cs.length) return "";
          return `${g ? `<div class="gm-h">${esc(g)}</div>` : ""}${cs.map((c) => `<label class="gm-row"><input type="checkbox" data-col="${c.k}" ${cfg.order.includes(c.k) ? "checked" : ""}><span>${esc(c.label)}</span></label>`).join("")}`;
        })
        .join("");
    };
    m.innerHTML = `<input class="in" placeholder="Find a field…" id="gm-q"><div class="gm-list"></div>
      <div class="gm-foot"><label class="gm-row"><input type="checkbox" id="gm-wrap" ${cfg.wrap ? "checked" : ""}><span>Wrap long text</span></label>
      <div class="row"><button class="btn sm ghost" id="gm-reset">Reset to default</button></div>
      ${spec.note ? `<div class="faint gm-note">${esc(spec.note)}</div>` : ""}</div>`;
    document.body.appendChild(m);
    const b = anchor.getBoundingClientRect();
    m.style.top = Math.min(b.bottom + 6, window.innerHeight - 200) + "px";
    m.style.left = Math.max(8, Math.min(b.right - 280, window.innerWidth - 288)) + "px";
    paint();
    m.querySelector("#gm-q").oninput = (e) => paint(e.target.value);
    m.querySelector("#gm-q").focus();
    m.addEventListener("change", (e) => {
      const k = e.target.dataset?.col;
      if (k) {
        if (e.target.checked) {
          // A column switched on lands where it sits in the full list, not at the far end.
          const idx = cols.findIndex((c) => c.k === k);
          const after = cfg.order.filter((x) => cols.findIndex((c) => c.k === x) < idx);
          const at = after.length ? cfg.order.indexOf(after[after.length - 1]) + 1 : 0;
          cfg.order.splice(at, 0, k);
        } else cfg.order = cfg.order.filter((x) => x !== k);
      }
      if (e.target.id === "gm-wrap") cfg.wrap = e.target.checked;
      save();
      draw();
    });
    m.querySelector("#gm-reset").onclick = () => {
      cfg = fresh();
      save();
      draw();
      paint(m.querySelector("#gm-q").value);
      m.querySelectorAll("[data-col]").forEach((x) => (x.checked = cfg.order.includes(x.dataset.col)));
    };
    const close = (e) => {
      if (e.type === "keydown" ? e.key !== "Escape" : m.contains(e.target) || e.target.closest('[data-g="cols"]')) return;
      m.remove();
      document.removeEventListener("mousedown", close, true);
      document.removeEventListener("keydown", close, true);
    };
    setTimeout(() => {
      document.addEventListener("mousedown", close, true);
      document.addEventListener("keydown", close, true);
    }, 0);
  }

  draw();
  return { redraw: (rows) => ((spec.rows = rows), draw()) };
}
