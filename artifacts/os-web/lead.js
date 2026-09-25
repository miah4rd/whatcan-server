// Unicorn OS — one card: the side panel (Copilot, chat, overview, viewings, tasks) and its summary.
import { S, api, esc, I, peeks, fmtDT, fmtDay, rel, money, dialog, confirmBox, toast, fail, on, brokerForLead, emit, dropCache, imgUrl, daysSince, resizer } from "./core.js";
import { mountNativeCopilot } from "./copilot.js";
import { loadVillas } from "./listings.js";

export async function loadLead(id, force) {
  const key = "lead:" + id;
  const c = S.cache[key];
  if (!force && c && Date.now() - c.at < 20_000) return c.value;
  const v = await api("/leads/" + encodeURIComponent(id));
  S.cache[key] = { at: Date.now(), value: v };
  return v;
}

export function pipelineKey(name) {
  return String(name || "").trim().toLowerCase().replace(/\s+/g, "-");
}
export function pipelineOf(name) {
  return (S.meta.pipelines || []).find((p) => pipelineKey(p.name) === pipelineKey(name)) || null;
}
export const isListingPipe = (name) => /listing/i.test(String(name || ""));

/** Stage move by a person: amoCRM first, our copy after; "lost" asks why. */
export async function moveStage(leadId, stage, from) {
  let body = { stage };
  if (/closed/i.test(stage) && /lost/i.test(stage)) {
    const reasons = S.meta.closeReasons || {};
    const r = await dialog({
      title: "Why is this card lost?",
      body: `<div class="stack"><label class="fld"><span>Reason</span><select class="in" name="reason" required>${Object.entries(reasons)
        .map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`)
        .join("")}</select></label><label class="fld"><span>Details (optional)</span><input class="in" name="detail" placeholder="e.g. rented with another agent in Canggu"></label></div>`,
      actions: [{ label: "Cancel", value: null }, { label: "Close as lost", value: "ok", primary: true, danger: true }],
    });
    if (!r) return false;
    body = { stage, reason: r.values.reason, detail: r.values.detail || null };
  } else if (/closed|won|contract|check/i.test(stage)) {
    if (!(await confirmBox("Move the card?", `${from || "—"} → ${stage}. This is written to amoCRM.`, "Move"))) return false;
  }
  try {
    await api(`/leads/${encodeURIComponent(leadId)}/stage`, { body });
    dropCache("board");
    dropCache("lead:" + leadId);
    toast(`Moved to ${stage}`);
    emit("lead-changed", { leadId });
    return true;
  } catch (e) {
    fail(e);
    return false;
  }
}

export async function setTemp(leadId, t) {
  try {
    await api(`/leads/${encodeURIComponent(leadId)}/temperature`, { body: { temperature: t } });
    dropCache("board");
    dropCache("lead:" + leadId);
    emit("lead-changed", { leadId });
  } catch (e) {
    fail(e);
  }
}

export async function newTask(leadId) {
  const tomorrow = new Date(Date.now() + 86400e3 + 8 * 3600e3).toISOString().slice(0, 10);
  const r = await dialog({
    title: "New task",
    body: `<div class="stack"><label class="fld"><span>What needs doing</span><input class="in" name="text" required placeholder="Call the owner about the deposit"></label>
      <div class="grid2"><label class="fld"><span>Day</span><input class="in" type="date" name="day" value="${tomorrow}" required></label>
      <label class="fld"><span>Time (Bali)</span><input class="in" type="time" name="time" value="10:00" required></label></div>
      <p class="faint" style="margin:0;font-size:12px">The task is created in amoCRM, where the follow-up clock reads it.</p></div>`,
    actions: [{ label: "Cancel", value: null }, { label: "Create task", value: "ok", primary: true }],
  });
  if (!r) return false;
  try {
    await api("/tasks", { body: { leadId, text: r.values.text, due: new Date(`${r.values.day}T${r.values.time}:00+08:00`).toISOString() } });
    toast("Task created");
    dropCache("tasks");
    dropCache("lead:" + leadId);
    emit("lead-changed", { leadId });
    return true;
  } catch (e) {
    fail(e);
    return false;
  }
}

export async function taskAction(t, action, leadId) {
  try {
    if (action === "done") {
      if (t.protected) {
        toast("This task closes itself when the report is filed.", { bad: true });
        return;
      }
      await api(`/tasks/${t.id}/complete`, { body: { result: "Done in Unicorn OS" } });
      toast("Task done");
    } else {
      const days = { d1: 1, d3: 3, d7: 7 }[action];
      let due;
      if (days) {
        due = new Date(new Date(t.due).getTime() + days * 86400e3);
        if (due < new Date()) due = new Date(Date.now() + days * 86400e3);
      } else {
        const r = await dialog({
          title: "Move the task",
          body: `<div class="grid2"><label class="fld"><span>Day</span><input class="in" type="date" name="day" value="${new Date(Date.now() + 8 * 3600e3 + 86400e3).toISOString().slice(0, 10)}"></label><label class="fld"><span>Time (Bali)</span><input class="in" type="time" name="time" value="10:00"></label></div>`,
          actions: [{ label: "Cancel", value: null }, { label: "Move", value: "ok", primary: true }],
        });
        if (!r) return;
        due = new Date(`${r.values.day}T${r.values.time}:00+08:00`);
      }
      await api(`/tasks/${t.id}/reschedule`, { body: { due: due.toISOString() } });
      toast(`Moved to ${fmtDT(due.toISOString())}`);
    }
    dropCache("tasks");
    if (leadId) dropCache("lead:" + leadId);
    emit("lead-changed", { leadId: leadId || t.leadId });
  } catch (e) {
    fail(e);
  }
}

export function taskRow(t, opts = {}) {
  const over = new Date(t.due) < new Date();
  return `<div class="task" data-task="${t.id}">
    <button class="cb ${t.protected ? "lock" : ""}" data-tact="done" title="${t.protected ? "Closes when the report is filed" : "Mark done"}"></button>
    <div><div class="tt">${esc(t.text)}</div><div class="ts">${opts.showLead ? `<a href="#" data-open-lead="${esc(t.leadId)}">${esc(t.leadName || "#" + t.leadId)}</a>` : ""}${t.stage ? `<span class="pill stage">${esc(t.stage)}</span>` : ""}${t.responsible ? `<span>${esc(t.responsible)}</span>` : ""}</div>
      <div class="acts"><button class="btn sm ghost" data-tact="d1">+1 day</button><button class="btn sm ghost" data-tact="d3">+3</button><button class="btn sm ghost" data-tact="d7">+7</button><button class="btn sm ghost" data-tact="pick">Pick…</button></div></div>
    <span class="due ${over ? "over" : ""}">${fmtDT(t.due)}</span></div>`;
}
export function bindTasks(root, getTasks, leadId, after) {
  on(root, "click", "[data-tact]", async (e, b) => {
    const row = b.closest("[data-task]");
    const t = getTasks().find((x) => String(x.id) === row.dataset.task);
    if (!t) return;
    b.disabled = true;
    await taskAction(t, b.dataset.tact, leadId || t.leadId);
    b.disabled = false;
    if (after) after();
  });
  on(root, "click", "[data-open-lead]", (e, a) => {
    e.preventDefault();
    emit("open-peek", { type: "lead", id: a.dataset.openLead });
  });
}

export function villaCardHtml(v, extra = "") {
  if (!v) return "";
  return `<div class="vcard" data-open-villa="${esc(v.id)}"><img src="${esc(imgUrl(v.images?.[0], 300))}" alt="" loading="lazy"><div><div class="vt">${esc(v.title)}</div><div class="vs">${v.bedrooms ?? "?"}BR · ${esc(v.area || "")} · ${money(v.monthly_price_idr)}/mo · <span class="mono">${esc(v.id)}</span>${extra}</div></div></div>`;
}

function stageSelect(d) {
  const p = pipelineOf(d.pipeline);
  const stages = (p?.stages || []).map((s) => s.name);
  if (d.stage && !stages.includes(d.stage)) stages.unshift(d.stage);
  return `<select class="in" data-stage-select style="padding:4px 6px">${stages.map((s) => `<option ${s === d.stage ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>`;
}

/** The card's facts: the top of the Card panel. */
export async function summaryHtml(d) {
  const villas = await loadVillas().catch(() => []);
  const byId = new Map(villas.map((v) => [String(v.id).toUpperCase(), v]));
  const r = d.request || {};
  const listing = isListingPipe(d.pipeline);
  const facts = d.facts || {};
  const promises = (d.commitments || []).filter((c) => c.status === "open");
  const sent = (d.sentPropertyIds || []).map((id) => byId.get(id)).filter(Boolean);
  const temp = d.temperature || "";
  return `
  ${listing ? `<div><div class="sect-h">Villa facts <span class="faint">from the owner's words</span></div><dl class="props">
      <dt>Bedrooms</dt><dd>${esc(facts.bedrooms ?? "—")}</dd>
      <dt>Price</dt><dd>${facts.monthlyIdr ? money(facts.monthlyIdr) + "/mo" : "—"} <span class="faint">${esc(facts.commission || "")}</span></dd>
      <dt>Min stay</dt><dd>${esc(facts.minStayMonths ?? "—")}${facts.minStayMonths ? " mo" : ""}</dd>
      <dt>Free from</dt><dd>${esc(facts.availableFrom || facts.freeFromIso || "—")}</dd>
      <dt>Viewable</dt><dd>${esc(facts.viewableFrom || "—")}</dd>
      <dt>Counterpart</dt><dd>${esc(facts.counterpart || "—")}</dd>
      <dt>Area</dt><dd>${esc(facts.area || "—")}</dd></dl></div>`
  : `<div><div class="sect-h">Request <span class="faint">from the client's words</span></div><dl class="props">
      <dt>Bedrooms</dt><dd>${esc(r.bedrooms ?? "—")}</dd><dt>Areas</dt><dd>${esc(r.areas || "—")}</dd>
      <dt>Budget</dt><dd>${r.budget ? `${money(r.budget)}/mo <span class="faint">ladder ${money(r.budget * 0.7)}–${money(r.budget * 1.25)}</span>` : "—"}</dd>
      <dt>Move-in</dt><dd>${esc(r.moveIn || "—")}</dd><dt>Stay</dt><dd>${esc(r.stay || "—")}</dd><dt>People</dt><dd>${esc(r.pax ?? "—")}</dd></dl></div>`}
  <div><div class="sect-h">Card</div><dl class="props">
    <dt>Stage</dt><dd>${stageSelect(d)}</dd>
    ${listing ? "" : `<dt>Temperature</dt><dd class="row" style="gap:4px">${["hot", "warm", "cold"].map((t) => `<button class="pill ${t}" data-temp="${t}" style="${temp === t ? "" : "opacity:.4"}">${t}</button>`).join("")}</dd>`}
    <dt>Broker</dt><dd>${esc(d.responsible || "—")}</dd>
    <dt>Phone</dt><dd class="mono">${esc(d.phone || "—")}</dd>
    ${d.tags?.length ? `<dt>Tags</dt><dd>${d.tags.map((t) => `<span class="pill">${esc(t)}</span>`).join(" ")}</dd>` : ""}
    <dt>Created</dt><dd>${fmtDay(d.createdAt)}</dd>
    <dt>Last message</dt><dd>${rel(d.lastMessageAt)}</dd>
    ${d.nextFollowupAt ? `<dt>Next touch</dt><dd>${fmtDT(d.nextFollowupAt)}</dd>` : ""}
    ${d.viewingAt ? `<dt>Viewing</dt><dd>${fmtDT(d.viewingAt)}</dd>` : ""}
    <dt>amoCRM</dt><dd><a href="https://unicornproperty.amocrm.ru/leads/detail/${esc(d.leadId)}" target="_blank" rel="noopener">#${esc(d.leadId)} ${I.ext}</a></dd>
  </dl></div>
  ${d.summary ? `<div><div class="sect-h">Copilot's read</div><div class="note">${esc(d.summary)}${d.intent ? `<br><span class="faint">${esc(d.intent)}</span>` : ""}</div></div>` : ""}
  ${promises.length ? `<div><div class="sect-h">Open promises</div><div class="stack">${promises.map((p) => `<div class="note"><b>${esc(p.promise_text)}</b><br><span class="faint">due ${fmtDT(p.due_at)}</span></div>`).join("")}</div></div>` : ""}
  ${!listing ? `<div><div class="sect-h">Villas sent <span class="faint">${(d.sentPropertyIds || []).length} · never re-sent</span></div><div class="stack">${sent.length ? sent.map((v) => villaCardHtml(v)).join("") : `<span class="faint">none yet</span>`}</div></div>` : ""}`;
}

export function bindSummary(root, d, refresh) {
  const sel = root.querySelector("[data-stage-select]");
  if (sel) {
    sel.onchange = async () => {
      const ok = await moveStage(d.leadId, sel.value, d.stage);
      if (!ok) sel.value = d.stage;
      else if (refresh) refresh();
    };
  }
  on(root, "click", "[data-temp]", async (e, b) => {
    await setTemp(d.leadId, b.dataset.temp);
    if (refresh) refresh();
  });
  on(root, "click", "[data-open-villa]", (e, el) => emit("open-peek", { type: "villa", id: el.dataset.openVilla }));
}

/**
 * A message the gateway sent also comes back through amoCRM's channel, so the
 * store holds it twice. Same side, same text, within 20 minutes: shown once.
 */
function dedupeMessages(list) {
  const out = [];
  const norm = (t) => String(t || "").replace(/\s+/g, " ").trim().toLowerCase();
  for (const m of list) {
    const side = m.from === "client" ? "in" : "out";
    const key = norm(m.text);
    const t = new Date(m.at).getTime();
    const twin = out.find((o) => (o.from === "client" ? "in" : "out") === side && norm(o.text) === key && Math.abs(new Date(o.at).getTime() - t) < 20 * 60e3);
    if (!twin) out.push(m);
  }
  return out;
}
function threadHtml(d) {
  if (!d.messages?.length) return `<div class="empty">No messages stored for this card yet.</div>`;
  return `<div class="thread">${dedupeMessages(d.messages.slice(-300))
    .slice(-250)
    .map((m) => {
      const cls = m.from === "client" ? "in" : m.from === "bot" ? "bot" : m.from === "system" ? "sys" : "out";
      const who = m.from === "client" ? m.name || "Client" : m.from === "bot" ? "Copilot / bot" : m.from === "system" ? "System" : m.name || d.responsible || "Broker";
      const text = esc(m.text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
      return `<div class="msg ${cls}"><div class="by">${esc(who)}${m.channel ? " · " + esc(m.channel) : ""}</div>${text}<div class="at">${fmtDT(m.at)}</div></div>`;
    })
    .join("")}</div>`;
}

const OUTCOME = {
  go: ["Going ahead", "ok"],
  think: ["Liked it, needs time", "warn"],
  no: ["Not this one", "bad"],
  no_show: ["Client didn't show", "bad"],
  cancelled: ["Cancelled by the villa", ""],
  rescheduled: ["Rescheduled", ""],
};
/** A viewing report, whole: how it went, the client's words, what did not work, the next step. */
export function reportHtml(r, { client } = {}) {
  const cats = S.meta.objectionCategories || {};
  const [label, cls] = OUTCOME[r.outcome] || [r.outcome || (r.status === "due" ? "Report not filed yet" : "—"), r.status === "due" ? "bad" : ""];
  const objections = r.objections || [];
  const steps = r.nextSteps || r.next_steps || [];
  const by = r.nextBy || r.next_by;
  return `<div class="report">
    <div class="rh"><b>${esc(fmtDT(r.viewingAt || r.viewing_at))}</b>${(r.propertyCode || r.property_code) ? ` · <a href="#" data-open-villa="${esc(r.propertyCode || r.property_code)}" class="mono">${esc(r.propertyCode || r.property_code)}</a>` : ""}<span class="pill ${cls}">${esc(label)}</span></div>
    ${client ? `<div class="faint">${client}</div>` : ""}
    <div class="rf"><div class="sect-h">What the client said</div><div class="rtext">${esc(r.feedback || "") || `<span class="faint">No feedback written.</span>`}</div></div>
    ${objections.length ? `<div class="rf"><div class="sect-h">What did not work for them</div><div class="stack">${objections.map((o) => `<div class="robj"><span class="pill">${esc(cats[o.category] || o.category)}</span>${o.quote ? ` “${esc(o.quote)}”` : ""}</div>`).join("")}</div></div>` : ""}
    <div class="rf"><div class="sect-h">Next step</div>${steps.length ? `${esc(steps.join(", "))}${by ? ` <span class="faint">by ${esc(by)}</span>` : ""}` : `<span class="faint">none set</span>`}</div>
    ${(r.filedBy || r.filed_by) ? `<div class="faint rby">Filed by ${esc(r.filedBy || r.filed_by)}${(r.filedAt || r.filed_at) ? ` · ${esc(fmtDT(r.filedAt || r.filed_at))}` : ""}</div>` : ""}
  </div>`;
}

function viewingsSection(d, { open } = {}) {
  const slots = d.viewings?.slots || [];
  const reps = d.viewings?.reports || [];
  if (!slots.length && !reps.length) return open ? `<div class="empty">No viewing agreed yet. After a shortlist every Copilot draft asks for one; the slot is read from the chat.</div>` : "";
  const seen = new Set();
  const items = slots.map((s) => {
    const rp = reps.find((r) => r.viewing_at === s.viewing_at);
    if (rp) seen.add(rp.id);
    return rp
      ? reportHtml(rp)
      : `<div class="report"><div class="rh"><b>${esc(fmtDT(s.viewing_at))}</b>${s.property_code ? ` · <a href="#" data-open-villa="${esc(s.property_code)}" class="mono">${esc(s.property_code)}</a>` : ""}<span class="pill ${s.status === "scheduled" ? "ok" : ""}">${esc(s.status)}</span></div><div class="faint">Agreed ${esc(fmtDT(s.agreed_at))} · the report opens 30 minutes after the slot.</div></div>`;
  });
  for (const r of reps) if (!seen.has(r.id)) items.push(reportHtml(r));
  return `<div><div class="sect-h">Viewings <span class="faint">${Math.max(slots.length, reps.length)}</span></div><div class="stack">${items.join("")}</div></div>`;
}

function historyHtml(d) {
  const evs = [
    ...(d.stageEvents || []).map((e) => ({ at: e.changed_at, cls: /engine|bot/.test(e.responsible_user || "") ? "code" : "person", text: `${esc(e.from_stage || "—")} → <b>${esc(e.to_stage)}</b>`, sub: esc(e.responsible_user || "") })),
    ...(d.sends || []).map((s) => ({ at: s.created_at, cls: "bot", text: `Sent (${esc(s.kind || "message")}) ${s.webhook_status >= 200 && s.webhook_status < 300 ? "" : "<span class='pill bad'>not delivered</span>"}`, sub: esc(String(s.message_text || "").slice(0, 120)) })),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  if (!evs.length) return `<div class="faint" style="margin-top:6px">No recorded moves yet.</div>`;
  return `<div class="timeline" style="margin-top:8px">${evs.map((e) => `<div class="ev"><i class="${e.cls}"></i><div>${e.text}<small>${fmtDT(e.at)} ${e.sub ? "· " + e.sub : ""}</small></div></div>`).join("")}</div>`;
}

// ── the peek ──
peeks.lead = {
  defaultTab: "card",
  async render(el, st, ctl) {
    let d;
    try {
      d = await loadLead(st.id, true);
    } catch (e) {
      el.innerHTML = `<div class="ph"><h2>Card #${esc(st.id)}</h2><button class="iconbtn" data-close>${I.x}</button></div><div class="empty">${esc(e.message)}</div>`;
      el.querySelector("[data-close]").onclick = ctl.close;
      return;
    }
    // One place for each thing (owner, 26.09). In Tasks the Copilot is the
    // middle column, so this panel is only the card. On boards and elsewhere
    // the panel holds both: the Copilot (conversation and reply) and the card.
    const inInbox = (S.route?.screen || "") === "tasks";
    const draft = d.drafts?.[0];
    const nView = Math.max((d.viewings?.slots || []).length, (d.viewings?.reports || []).length);
    const tabs = inInbox
      ? []
      : [
          ["copilot", "Copilot"],
          ["chat", `Chat · ${d.messages?.length || 0}`],
          ["overview", "Overview"],
          ["viewings", `Viewings${nView ? " · " + nView : ""}`],
          ["tasks", `Tasks · ${(d.tasks || []).length}`],
          ["history", "History"],
        ];
    const tab = inInbox ? "card" : tabs.some((t) => t[0] === st.tab) ? st.tab : st.tab === "card" ? "overview" : draft ? "copilot" : "overview";
    if (!inInbox) S.peek.tabByType = { ...(S.peek.tabByType || {}), lead: tab };
    el.innerHTML = `<div class="resize-x" id="peek-resize2" title="Drag to resize"></div>
      <div class="ph"><div class="avatar ${isListingPipe(d.pipeline) ? "villa" : ""}">${esc((d.name || "?").slice(0, 2).toUpperCase())}</div>
        <div style="min-width:0;flex:1"><h2>${esc(d.name)}</h2><div class="faint" style="font-size:12px">${esc(d.pipeline || "")} · ${esc(d.stage || "")} · ${esc(d.responsible || "")}</div></div>
        ${draft ? `<span class="q ${draft.kind === "live" ? "live" : "push"}">${esc(draft.kind)}</span>` : ""}
        <button class="iconbtn" data-close title="Close (Esc)">${I.x}</button></div>
      ${tabs.length ? `<div class="tabs">${tabs.map(([k, l]) => `<button class="${k === tab ? "active" : ""}" data-tab="${k}">${esc(l)}</button>`).join("")}</div>` : ""}
      <div class="pb" id="peek-body"></div>`;
    el.querySelector("[data-close]").onclick = ctl.close;
    on(el, "click", "[data-tab]", (e, b) => ctl.setTab(b.dataset.tab));
    resizer(el.querySelector("#peek-resize2"), { varName: "--peek-w", min: 360, max: Math.max(420, window.innerWidth - 200), invert: true });
    const body = el.querySelector("#peek-body");
    const refresh = () => ctl.setTab(tab);
    on(el, "click", "a[data-open-villa]", (e, a) => {
      e.preventDefault();
      emit("open-peek", { type: "villa", id: a.dataset.openVilla });
    });
    if (tab === "chat") {
      body.innerHTML = `${threadHtml(d)}<div class="help" style="margin:0 12px 12px">Replies go out from the Copilot tab (draft, then Approve), so every message passes the same checks and is recorded.</div>`;
      setTimeout(() => (body.scrollTop = body.scrollHeight), 0);
      return;
    }
    if (tab === "overview") {
      body.classList.add("pad");
      body.innerHTML = await summaryHtml(d);
      bindSummary(body, d, refresh);
      return;
    }
    if (tab === "viewings") {
      body.classList.add("pad");
      body.innerHTML = viewingsSection(d, { open: true });
      return;
    }
    if (tab === "tasks") {
      body.classList.add("pad");
      body.innerHTML = `<div class="row"><button class="btn primary sm" id="new-task">${I.plus} New task</button><span class="faint" style="font-size:12px">amoCRM tasks: the follow-up scheduler reads them.</span></div>
        <div class="stack" id="card-tasks">${(d.tasks || []).map((t) => taskRow(t)).join("") || `<div class="empty">No open tasks.</div>`}</div>`;
      body.querySelector("#new-task").onclick = async () => {
        if (await newTask(d.leadId)) refresh();
      };
      bindTasks(body, () => d.tasks || [], d.leadId, refresh);
      return;
    }
    if (tab === "history") {
      body.classList.add("pad");
      body.innerHTML = historyHtml(d);
      return;
    }
    if (tab === "copilot") {
      if (draft) {
        body.innerHTML = `<div class="cp-host" id="peek-copilot"></div>`;
        body.style.overflow = "hidden";
        // The peek's header already names the card and its stage: the Copilot skips its own.
        mountNativeCopilot(body.querySelector("#peek-copilot"), { leadId: d.leadId, broker: brokerForLead(d.responsible), compact: true, onDone: () => ctl.setTab("chat") });
      } else {
        // No draft to approve: the conversation, read-only, and why there is no reply box.
        body.innerHTML = `<div class="help" style="margin:10px 12px 0">No draft on this card now. The Copilot writes one when the client writes or a follow-up falls due; a task brings the card back sooner. The conversation is on the Chat tab.</div>`;
        setTimeout(() => (body.scrollTop = body.scrollHeight), 0);
      }
      return;
    }
    // The card: one scroll, like the record column of a CRM card.
    body.classList.add("pad");
    const vs = viewingsSection(d);
    body.innerHTML = `${await summaryHtml(d)}
      <div id="card-tasks"><div class="sect-h">Tasks <span class="row" style="gap:6px"><span class="faint">${(d.tasks || []).length} open · amoCRM</span><button class="btn sm" id="new-task">${I.plus} Task</button></span></div>
        <div class="stack">${(d.tasks || []).map((t) => taskRow(t)).join("") || `<span class="faint">No open tasks.</span>`}</div></div>
      ${vs}
      <details class="hist"><summary class="sect-h" style="cursor:pointer">History <span class="faint">stages and sends</span></summary>${historyHtml(d)}</details>`;
    bindSummary(body, d, refresh);
    body.querySelector("#new-task").onclick = async () => {
      if (await newTask(d.leadId)) refresh();
    };
    bindTasks(body.querySelector("#card-tasks"), () => d.tasks || [], d.leadId, refresh);
  },
};

// ── one viewing report in the side panel ──
peeks.vreport = {
  defaultTab: "report",
  async render(el, st, ctl) {
    let r;
    try {
      r = await api(`/viewing-reports/${encodeURIComponent(st.id)}`);
    } catch (e) {
      el.innerHTML = `<div class="ph"><h2>Viewing report</h2><button class="iconbtn" data-close>${I.x}</button></div><div class="empty">${esc(e.message)}</div>`;
      el.querySelector("[data-close]").onclick = ctl.close;
      return;
    }
    const who = r.clientName || r.leadName || "#" + r.leadId;
    const req = r.request || {};
    el.innerHTML = `<div class="resize-x" id="vr-resize" title="Drag to resize"></div>
      <div class="ph"><div style="min-width:0;flex:1"><h2>Viewing report · ${esc(who)}</h2><div class="faint" style="font-size:12px">${esc(r.stage || "")} · ${esc(r.responsible || "")}${req.bedrooms || req.areas ? ` · asked for ${esc([req.bedrooms ? req.bedrooms + "BR" : null, req.areas, req.budget ? money(req.budget) : null].filter(Boolean).join(" · "))}` : ""}</div></div>
        <button class="btn sm" id="vr-card">Client's card</button><button class="iconbtn" data-close title="Close (Esc)">${I.x}</button></div>
      <div class="pb pad">${reportHtml(r)}</div>`;
    el.querySelector("[data-close]").onclick = ctl.close;
    el.querySelector("#vr-card").onclick = () => emit("open-peek", { type: "lead", id: r.leadId, tab: "overview" });
    resizer(el.querySelector("#vr-resize"), { varName: "--peek-w", min: 360, max: Math.max(420, window.innerWidth - 200), invert: true });
    on(el, "click", "a[data-open-villa]", (e, a) => {
      e.preventDefault();
      emit("open-peek", { type: "villa", id: a.dataset.openVilla });
    });
  },
};

export function daysInStage(card) {
  return daysSince(card.stageSince || card.createdAt);
}
