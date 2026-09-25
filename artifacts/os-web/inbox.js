// Unicorn OS — Inbox: the Copilot's queues, the Copilot itself in the middle, the card docked on the right.
import { S, api, esc, I, screens, store, on, resizer, rel, initials, isStaff, mountCopilot, brokerForLead, queueOf, onBus, fail } from "./core.js";
import { isListingPipe } from "./lead.js";

// A tab saved as "reach" (before 26.09) opens Live: that queue is gone.
let st = { tab: ["live", "push", "all"].includes(store.get("inbox-tab", "live")) ? store.get("inbox-tab", "live") : "live", sel: null, broker: store.get("inbox-broker", ""), pipe: store.get("inbox-pipe", ""), items: [], timer: null, showCtx: store.get("inbox-ctx", true) };

async function fetchItems() {
  const brokers = isStaff() ? (st.broker ? [st.broker] : S.meta.brokers) : [S.user.brokerKey];
  const lists = await Promise.all(
    brokers.map((b) =>
      api(`/p/suggestions?lite=1&responsibleUser=${encodeURIComponent(b)}`)
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
  const counts = { live: 0, push: 0 };
  for (const i of st.items) counts[i._q]++;
  const tabs = [
    ["live", "Live"],
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
    <b>Live</b>: the client just wrote · <b>Push</b>: we start the touch, a follow-up, a promise or a task that fell due.</div>${rows}`;
}

/**
 * The card on the right is the side panel, docked beside the Copilot: one
 * place for the card's facts, viewings, tasks and history. It has no Copilot
 * or chat tab here, because the Copilot in the middle already shows both.
 */
const desktop = () => window.innerWidth > 860;
function showCard() {
  if (!st.sel || !st.showCtx || !desktop()) return;
  window.UOS.openPeek("lead", st.sel);
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
  showCard();
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
    tools.innerHTML = `${brokerOpts}${pipeOpts}<button class="btn sm ghost hide-m ${st.showCtx ? "on" : ""}" id="ib-ctx" title="Show or hide the card on the right">${I.panel} Card</button><button class="btn sm ghost" id="ib-refresh">Refresh</button>`;
    el.innerHTML = `<div class="inbox">
      <div class="pane list-pane" id="inbox-list"><div class="loading">Loading drafts…</div></div>
      <div class="pane copilot-pane"><div class="resize-x" id="rz-list" style="left:-3px" title="Drag to resize"></div><div class="frame-wrap" id="copilot-host"><div class="frame-note">Pick a conversation on the left.</div></div></div>
    </div>`;
    resizer(document.getElementById("rz-list"), { varName: "--list-w", min: 240, max: 560 });
    document.getElementById("ib-refresh").onclick = () => refreshList();
    const ctxBtn = document.getElementById("ib-ctx");
    ctxBtn.onclick = () => {
      st.showCtx = !st.showCtx;
      store.set("inbox-ctx", st.showCtx);
      ctxBtn.classList.toggle("on", st.showCtx);
      if (st.showCtx) showCard();
      else window.UOS.closePeek();
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
    // The list from the last visit shows at once; the fresh one replaces it.
    if (st.items.length) {
      list.innerHTML = listHtml();
      if (route.q.lead) select(route.q.lead);
      else if (st.sel) select(st.sel);
      refreshList(true);
    } else {
      await refreshList(!!st.sel);
      if (route.q.lead) select(route.q.lead);
      else if (st.sel) select(st.sel);
    }
    clearInterval(st.timer);
    st.timer = setInterval(() => {
      if (!document.hidden) refreshList();
    }, 30_000);
  },
};

onBus("lead-changed", () => {
  if (S.route.screen === "inbox") refreshList();
});
// Closing the card with its × keeps it closed until the Card button opens it
// again. Leaving the Inbox also closes the panel; that is not the person's choice.
onBus("peek-close", (p) => {
  if (p?.type !== "lead" || !location.hash.startsWith("#/inbox") || !st.showCtx) return;
  st.showCtx = false;
  store.set("inbox-ctx", false);
  document.getElementById("ib-ctx")?.classList.remove("on");
});
