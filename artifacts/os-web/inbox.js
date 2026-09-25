// Unicorn OS — Inbox: the Copilot's queues, the Copilot itself in the middle, the record on the right.
import { S, api, esc, I, screens, store, on, resizer, rel, initials, isStaff, mountCopilot, brokerForLead, queueOf, onBus, fail } from "./core.js";
import { loadLead, summaryHtml, bindSummary, isListingPipe } from "./lead.js";

let st = { tab: store.get("inbox-tab", "live"), sel: null, broker: store.get("inbox-broker", ""), pipe: store.get("inbox-pipe", ""), items: [], timer: null, showCtx: store.get("inbox-ctx", true) };

async function fetchItems() {
  const brokers = isStaff() ? (st.broker ? [st.broker] : S.meta.brokers) : [S.user.brokerKey];
  const lists = await Promise.all(
    brokers.map((b) =>
      api(`/p/suggestions?responsibleUser=${encodeURIComponent(b)}`)
        .then((r) => r.items || [])
        .catch(() => []),
    ),
  );
  const seen = new Set();
  const all = [];
  for (const it of lists.flat()) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    if (st.pipe && String(it.pipeline || "").toLowerCase() !== st.pipe) continue;
    it._q = queueOf(it);
    all.push(it);
  }
  all.sort((a, b) => String(b.triggered_by_message_at || b.created_at).localeCompare(String(a.triggered_by_message_at || a.created_at)));
  st.items = all;
  S.cache["inbox"] = { at: Date.now(), value: all };
  return all;
}

function listHtml() {
  const counts = { live: 0, reach: 0, push: 0 };
  for (const i of st.items) counts[i._q]++;
  const tabs = [
    ["live", "Live"],
    ["reach", "Reach"],
    ["push", "Push"],
    ["all", "All"],
  ]
    .map(([k, l]) => `<button class="qtab ${k} ${st.tab === k ? "active" : ""}" data-qtab="${k}"><span class="n">${k === "all" ? st.items.length : counts[k]}</span>${l}</button>`)
    .join("");
  const list = st.items.filter((i) => st.tab === "all" || i._q === st.tab);
  const rows = list.length
    ? list
        .map((i) => {
          const name = i.lead_name || `#${i.lead_id}`;
          const snippet = i.last_lead_text || i.suggestion_text || "";
          return `<div class="conv ${String(i.lead_id) === String(st.sel) ? "sel" : ""}" data-lead="${esc(i.lead_id)}">
          <div class="avatar sm ${isListingPipe(i.pipeline) ? "villa" : ""}" style="width:30px;height:30px">${esc(initials(name))}</div>
          <div><div class="t"><span class="nm">${esc(name)}</span><span class="q ${i._q}">${i._q}</span></div><div class="s">${esc(snippet)}</div></div>
          <div class="meta"><b>${esc(rel(i.triggered_by_message_at || i.created_at).replace(" ago", ""))}</b>${esc(i.responsible_user || "")}</div></div>`;
        })
        .join("")
    : `<div class="empty">Nothing waiting in ${st.tab === "all" ? "the inbox" : st.tab.toUpperCase()}.</div>`;
  return `<div class="qtabs">${tabs}</div><div class="help" style="margin:8px">
    <b>Live</b>: the client just wrote · <b>Reach</b>: a promise or task is due · <b>Push</b>: quiet, the Copilot proposes the next touch.</div>${rows}`;
}

async function renderCtx() {
  const pane = document.getElementById("ctx-pane-body");
  if (!pane) return;
  if (!st.sel) {
    pane.innerHTML = `<div class="empty">Pick a conversation.</div>`;
    return;
  }
  const id = st.sel;
  pane.innerHTML = `<div class="loading">Loading the card…</div>`;
  try {
    const d = await loadLead(id);
    if (st.sel !== id) return;
    pane.innerHTML = `<div class="ctx">${await summaryHtml(d)}<button class="btn" data-full>Open the full card</button></div>`;
    bindSummary(pane, d, () => {
      S.cache["lead:" + id] = null;
      renderCtx();
    });
    pane.querySelector("[data-full]").onclick = () => window.UOS.openPeek("lead", id, "overview");
  } catch (e) {
    pane.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

function select(leadId) {
  st.sel = String(leadId);
  const it = st.items.find((x) => String(x.lead_id) === st.sel);
  const host = document.getElementById("copilot-host");
  document.querySelectorAll("#inbox-list .conv").forEach((c) => c.classList.toggle("sel", c.dataset.lead === st.sel));
  if (host) mountCopilot(host, brokerForLead(it?.responsible_user), st.sel);
  document.querySelector(".inbox")?.classList.add("show-copilot");
  const back = document.getElementById("m-back");
  if (back) back.hidden = window.innerWidth > 860;
  renderCtx();
}

async function refreshList(keepSel = true) {
  try {
    await fetchItems();
  } catch (e) {
    fail(e);
  }
  const el = document.getElementById("inbox-list");
  if (!el) return;
  const scroll = el.scrollTop;
  el.innerHTML = listHtml();
  el.scrollTop = scroll;
  if (!keepSel || !st.sel) {
    const first = st.items.find((i) => st.tab === "all" || i._q === st.tab);
    if (first && window.innerWidth > 860) select(first.lead_id);
  }
}

screens.inbox = {
  title: "Inbox",
  flush: true,
  leave() {
    clearInterval(st.timer);
  },
  async render({ el, tools, route, back }) {
    const brokerOpts = isStaff()
      ? `<select class="chip" id="ib-broker"><option value="">Everyone</option>${S.meta.brokers.map((b) => `<option ${b === st.broker ? "selected" : ""}>${esc(b)}</option>`).join("")}</select>`
      : `<span class="chip on">${esc(S.user.brokerKey || S.user.name)}</span>`;
    const pipeOpts = `<select class="chip" id="ib-pipe"><option value="">All funnels</option>${S.meta.pipelines.map((p) => `<option value="${esc(p.name.toLowerCase())}" ${st.pipe === p.name.toLowerCase() ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select>`;
    tools.innerHTML = `${brokerOpts}${pipeOpts}<button class="btn sm ghost hide-m" id="ib-ctx" title="Show or hide the record column">${I.panel} Record</button><button class="btn sm ghost" id="ib-refresh">Refresh</button>`;
    el.innerHTML = `<div class="inbox ${st.showCtx ? "" : "noctx"}">
      <div class="pane list-pane" id="inbox-list"><div class="loading">Loading drafts…</div></div>
      <div class="pane copilot-pane"><div class="resize-x" id="rz-list" style="left:-3px" title="Drag to resize"></div><div class="frame-wrap" id="copilot-host"><div class="frame-note">Pick a conversation on the left.</div></div></div>
      ${st.showCtx ? `<div class="pane ctx-pane"><div class="resize-x" id="rz-ctx" style="left:-3px" title="Drag to resize"></div><div id="ctx-pane-body" style="min-height:100%"></div></div>` : ""}
    </div>`;
    resizer(document.getElementById("rz-list"), { varName: "--list-w", min: 240, max: 560 });
    const rc = document.getElementById("rz-ctx");
    if (rc) resizer(rc, { varName: "--ctx-w", min: 260, max: 560, invert: true });
    document.getElementById("ib-refresh").onclick = () => refreshList();
    document.getElementById("ib-ctx").onclick = () => {
      st.showCtx = !st.showCtx;
      store.set("inbox-ctx", st.showCtx);
      screens.inbox.render({ el, tools, route, back });
    };
    const bsel = document.getElementById("ib-broker");
    if (bsel)
      bsel.onchange = () => {
        st.broker = bsel.value;
        store.set("inbox-broker", st.broker);
        st.sel = null;
        refreshList(false);
      };
    document.getElementById("ib-pipe").onchange = (e) => {
      st.pipe = e.target.value;
      store.set("inbox-pipe", st.pipe);
      refreshList(false);
    };
    const list = document.getElementById("inbox-list");
    on(list, "click", "[data-qtab]", (e, b) => {
      st.tab = b.dataset.qtab;
      store.set("inbox-tab", st.tab);
      list.innerHTML = listHtml();
    });
    on(list, "click", ".conv", (e, c) => select(c.dataset.lead));
    back.onclick = () => {
      document.querySelector(".inbox")?.classList.remove("show-copilot");
      back.hidden = true;
    };
    await refreshList(!!st.sel);
    if (route.q.lead) select(route.q.lead);
    else if (st.sel) select(st.sel);
    clearInterval(st.timer);
    st.timer = setInterval(() => {
      if (!document.hidden) refreshList();
    }, 30_000);
  },
};

onBus("lead-changed", () => {
  if (S.route.screen === "inbox") refreshList();
});
