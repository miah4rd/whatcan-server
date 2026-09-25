// Unicorn OS — Tasks (called Inbox until 26.09): the day's work, one client at a time.
// The Copilot here is the amoCRM Copilot page itself, dressed as the OS by the server
// (routes/mobile.ts, host=os); its logic is not copied anywhere.
//   · Wide screen: the queues on the left, the Copilot for the picked client in the middle,
//     the card's fields docked on the right. When the Copilot is done with a client (sent,
//     skipped, put off), the next one opens.
//   · Phone (owner, 26.09): the Copilot alone, whole, with its own list, as in amoCRM.
import { S, api, esc, I, screens, store, on, resizer, rel, initials, isStaff, mountCopilot, brokerForLead, queueOf, onBus, fail, isPhone } from "./core.js";
import { isListingPipe } from "./lead.js";

// A tab saved as "reach" (before 26.09) opens Live: that queue is gone from the list.
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

const visible = () => st.items.filter((i) => st.tab === "all" || i._q === st.tab);

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
  const list = visible();
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
    : `<div class="empty">${st.tab === "all" ? "Nothing to do: every client is handled." : `Nothing in ${st.tab.toUpperCase()}.`}</div>`;
  return `<div class="qtabs">${tabs}</div><div class="help" style="margin:8px">
    <b>Live</b>: the client just wrote · <b>Push</b>: we start the touch, a follow-up, a promise or a task that fell due.</div>${rows}`;
}

/** The card's fields on the right: the side panel, docked beside the Copilot (wide screens). */
function showCard() {
  if (!st.sel || !st.showCtx || isPhone()) return;
  window.UOS.openPeek("lead", st.sel);
}

function select(leadId) {
  st.sel = String(leadId);
  const it = st.items.find((x) => String(x.lead_id) === st.sel);
  const host = document.getElementById("copilot-host");
  document.querySelectorAll("#inbox-list .conv").forEach((c) => c.classList.toggle("sel", c.dataset.lead === st.sel));
  if (host) mountCopilot(host, brokerForLead(it?.responsible_user), st.sel, true);
  showCard();
}

/** The Copilot is done with a client: it leaves the list and the next one opens. */
function nextAfter(leadId) {
  const list = visible();
  const at = list.findIndex((i) => String(i.lead_id) === String(leadId));
  st.items = st.items.filter((i) => String(i.lead_id) !== String(leadId));
  const rest = list.filter((i) => String(i.lead_id) !== String(leadId));
  const el = document.getElementById("inbox-list");
  if (el) el.innerHTML = listHtml();
  const nxt = rest[Math.min(Math.max(at, 0), rest.length - 1)];
  if (nxt) return select(nxt.lead_id);
  st.sel = null;
  const host = document.getElementById("copilot-host");
  if (host) host.innerHTML = `<div class="frame-note">All done here.</div>`;
  window.UOS.closePeek();
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
    const first = visible()[0];
    if (first) select(first.lead_id);
  }
}

function renderPhone(el, tools, route) {
  tools.innerHTML = "";
  el.innerHTML = `<div class="frame-wrap" id="tasks-phone"></div>`;
  mountCopilot(el.querySelector("#tasks-phone"), brokerForLead(null), route.q.lead || null, false);
}

screens.tasks = {
  title: "Tasks",
  flush: true,
  leave() {
    clearInterval(st.timer);
  },
  async render({ el, tools, route }) {
    clearInterval(st.timer);
    if (isPhone()) return renderPhone(el, tools, route);
    const brokerOpts = isStaff()
      ? `<select class="chip" id="ib-broker"><option value="">Everyone</option>${S.meta.brokers.map((b) => `<option ${b === st.broker ? "selected" : ""}>${esc(b)}</option>`).join("")}</select>`
      : `<span class="chip on">${esc(S.user.brokerKey || S.user.name)}</span>`;
    const pipeOpts = `<select class="chip" id="ib-pipe"><option value="">All funnels</option>${S.meta.pipelines.map((p) => `<option value="${esc(p.name.toLowerCase())}" ${st.pipe === p.name.toLowerCase() ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select>`;
    tools.innerHTML = `${brokerOpts}${pipeOpts}<button class="btn sm ghost ${st.showCtx ? "on" : ""}" id="ib-ctx" title="Show or hide the card on the right">${I.panel} Card</button><button class="btn sm ghost" id="ib-refresh">Refresh</button>`;
    el.innerHTML = `<div class="inbox show-copilot">
      <div class="pane list-pane" id="inbox-list"><div class="loading">Loading drafts…</div></div>
      <div class="pane copilot-pane"><div class="resize-x" id="rz-list" style="left:-3px" title="Drag to resize"></div><div class="frame-wrap" id="copilot-host"><div class="frame-note">Pick a client on the left.</div></div></div>
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
    // The list from the last visit shows at once; the fresh one replaces it.
    if (st.items.length) {
      list.innerHTML = listHtml();
      if (route.q.lead) select(route.q.lead);
      else if (st.sel) select(st.sel);
      refreshList(true);
    } else {
      await refreshList(!!st.sel || !!route.q.lead);
      if (route.q.lead) select(route.q.lead);
      else if (st.sel) select(st.sel);
    }
    st.timer = setInterval(() => {
      if (!document.hidden) refreshList();
    }, 30_000);
  },
};

// Links saved before the rename (#/inbox, the push notifications) open Tasks.
screens.inbox = {
  title: "Tasks",
  render: ({ route }) => location.replace("#/tasks" + (route.q.lead ? `?lead=${encodeURIComponent(route.q.lead)}` : "")),
};

// The middle Copilot says when it has finished with the client it showed (host=os only):
// back on its list means sent, skipped or put off. The next client opens.
window.addEventListener("message", (e) => {
  if (!S.meta || e.origin !== S.meta.copilotOrigin || S.route.screen !== "tasks") return;
  const d = e.data;
  if (!d || d.source !== "copilot-embed") return;
  const f = document.querySelector("#copilot-host iframe.copilot-frame");
  if (!f || e.source !== f.contentWindow) return;
  if (d.type === "list" && st.sel) nextAfter(st.sel);
  else if (d.type === "open" && d.leadId && String(d.leadId) !== st.sel) {
    st.sel = String(d.leadId);
    document.querySelectorAll("#inbox-list .conv").forEach((c) => c.classList.toggle("sel", c.dataset.lead === st.sel));
    showCard();
  }
});

// Crossing between a phone and a wide layout draws Tasks again in the other form.
matchMedia("(max-width: 860px)").addEventListener?.("change", () => {
  if (S.route.screen === "tasks") window.dispatchEvent(new HashChangeEvent("hashchange"));
});

onBus("lead-changed", () => {
  if (S.route.screen === "tasks" && !isPhone()) refreshList();
});
// Closing the card with its × keeps it closed until the Card button opens it
// again. Leaving Tasks also closes the panel; that is not the person's choice.
onBus("peek-close", (p) => {
  if (p?.type !== "lead" || !location.hash.startsWith("#/tasks") || !st.showCtx || isPhone()) return;
  if (!st.sel) return;
  st.showCtx = false;
  store.set("inbox-ctx", false);
  document.getElementById("ib-ctx")?.classList.remove("on");
});
