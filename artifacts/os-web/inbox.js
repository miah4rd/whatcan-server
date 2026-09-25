// Unicorn OS — Tasks (called Inbox until 26.09): the day's work, one client at a time.
// Owner, 26.09: the Copilot here is the amoCRM Copilot itself, whole: its queues (Live, Push,
// All), the card it opens, every action and its behaviour on a phone. Only its look is the OS's
// (the server dresses the page, routes/mobile.ts). On a wide screen the open client's card docks
// on the right; on a phone the Copilot is all there is, as in amoCRM.
import { S, I, screens, store, brokerForLead, mountCopilot, onBus, isPhone } from "./core.js";

let showCtx = store.get("inbox-ctx", true);
let openLead = null;
let closingForList = false;

const tasksFrame = () => document.querySelector("#tasks-host iframe.copilot-frame");

function showCard() {
  if (!openLead || !showCtx || isPhone()) return;
  window.UOS.openPeek("lead", openLead);
}

screens.tasks = {
  title: "Tasks",
  flush: true,
  render({ el, tools, route }) {
    tools.innerHTML = `<button class="btn sm ghost hide-m ${showCtx ? "on" : ""}" id="ib-ctx" title="Show the open client's card on the right">${I.panel} Card</button>`;
    // The Copilot keeps its place across visits: the same frame is reused while it lives.
    let host = document.getElementById("tasks-host");
    if (!host || !el.contains(host)) {
      el.innerHTML = `<div class="frame-wrap" id="tasks-host"></div>`;
      host = el.querySelector("#tasks-host");
    }
    mountCopilot(host, brokerForLead(null), route.q.lead || null);
    const ctxBtn = document.getElementById("ib-ctx");
    ctxBtn.onclick = () => {
      showCtx = !showCtx;
      store.set("inbox-ctx", showCtx);
      ctxBtn.classList.toggle("on", showCtx);
      if (showCtx) showCard();
      else window.UOS.closePeek();
    };
  },
};

// Links saved before the rename (#/inbox, the push notifications) open Tasks.
screens.inbox = {
  title: "Tasks",
  render: ({ route }) => location.replace("#/tasks" + (route.q.lead ? `?lead=${encodeURIComponent(route.q.lead)}` : "")),
};

// The Copilot says which card it opened and when it is back on its list (host=os only).
window.addEventListener("message", (e) => {
  if (!S.meta || e.origin !== S.meta.copilotOrigin) return;
  const d = e.data;
  if (!d || d.source !== "copilot-embed") return;
  const f = tasksFrame();
  if (!f || e.source !== f.contentWindow || S.route.screen !== "tasks") return;
  if (d.type === "open" && d.leadId) {
    openLead = String(d.leadId);
    showCard();
  } else if (d.type === "list") {
    openLead = null;
    if (S.peek?.type === "lead") {
      closingForList = true;
      window.UOS.closePeek();
      closingForList = false;
    }
  }
});

// Closing the card with its × keeps it closed until the Card button opens it again. The
// Copilot going back to its list closes it too; that is not the person's choice.
onBus("peek-close", (p) => {
  if (closingForList || p?.type !== "lead" || !location.hash.startsWith("#/tasks") || !showCtx) return;
  showCtx = false;
  store.set("inbox-ctx", false);
  document.getElementById("ib-ctx")?.classList.remove("on");
});
