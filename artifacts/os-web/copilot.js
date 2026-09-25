// Unicorn OS — the Copilot, drawn as part of the OS (owner, 26.09).
// The logic is the Copilot's own and lives on the server: the same drafts, /approve, /suggest,
// /skip, /no-reply-needed, viewing and inspection reports and villa links the /m page uses in
// amoCRM. Only the screen is new. The /m page stays as it is for amoCRM, and one click away here.
import { S, api, esc, I, on, toast, fail, dialog, confirmBox, rel, fmtDT, recordVoice, emit, store, brokerForLead, money, mountCopilot } from "./core.js";
import { loadVillas, SITE } from "./listings.js";

const SITE_ABS = "https://unicorn-properties.com";
const VR_STEPS = ["Send price & terms", "Deposit to hold it", "Second visit", "Contract", "Counter-offer to owner", "New shortlist", "Wait for client's decision", "Close"];
const INTERRUPTED =
  "Connection to the server dropped while sending. Part of the message may already have reached the client: open the chat and check before you press Send again.";

let guide = null;
async function getGuide() {
  if (!guide) guide = (await api("/copilot/guide")).guide;
  return guide;
}
const stageCache = {};
async function stagesOf(pipeline) {
  const k = String(pipeline || "");
  if (!stageCache[k]) stageCache[k] = api(`/p/stage-options${k ? `?pipeline=${encodeURIComponent(k)}` : ""}`).then((r) => r.stages || []).catch(() => []);
  return stageCache[k];
}
const stageName = (s) => (typeof s === "object" && s ? s.name || "" : String(s || ""));
const stageId = (stages, name) => {
  const s = stages.find((x) => stageName(x).toLowerCase() === String(name || "").toLowerCase());
  return s && typeof s === "object" ? s.id || null : null;
};
async function post(path, body) {
  const res = await fetch("/os/api/p" + path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  return { res, json };
}
function sendError(status, json) {
  if (json?.message) return json.message;
  if ([502, 503, 504].includes(status)) return INTERRUPTED;
  const hook = json?.hookStatus;
  if (hook != null && hook !== 0 && (hook < 200 || hook >= 300)) return `amoCRM refused the send (code ${hook}): the message was NOT sent. Try again; if it repeats, send it from amoCRM.`;
  return `Could not send (code ${status}): the message was NOT sent. Try again.`;
}
function dueBadge(at) {
  if (!at) return `<span class="pill">no task</span>`;
  const d = Math.round((new Date(new Date(at).toDateString()) - new Date(new Date().toDateString())) / 86400e3);
  return d < 0 ? `<span class="pill bad">overdue ${-d}d</span>` : d === 0 ? `<span class="pill warn">today</span>` : `<span class="pill">in ${d}d</span>`;
}
const linkify = (t) => esc(t).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');

/**
 * Mounts the Copilot for one card into `host`. opts: { leadId, broker, onDone } — onDone runs
 * after the draft is sent, skipped or put off, so the Inbox can move to the next client.
 */
export async function mountNativeCopilot(host, opts) {
  const leadId = String(opts.leadId);
  if (store.get("copilot-classic", false)) {
    host.innerHTML = `<div class="frame-wrap" id="cp-classic"></div>`;
    mountCopilot(host.querySelector("#cp-classic"), opts.broker, leadId);
    host.insertAdjacentHTML("afterbegin", `<div class="cp-classic-bar"><span class="faint">Classic Copilot</span><button class="btn sm ghost" id="cp-back-native">Back to the OS view</button></div>`);
    host.querySelector("#cp-back-native").onclick = () => (store.set("copilot-classic", false), mountNativeCopilot(host, opts));
    return;
  }
  host.innerHTML = `<div class="loading">Opening the Copilot…</div>`;
  host.dataset.lead = leadId;
  let item;
  try {
    const r = await api(`/p/suggestions?responsibleUser=${encodeURIComponent(opts.broker || "")}&leadId=${encodeURIComponent(leadId)}`);
    item = (r.items || []).find((x) => String(x.lead_id) === leadId) || null;
  } catch (e) {
    host.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  if (host.dataset.lead !== leadId) return;
  if (!item) {
    host.innerHTML = `<div class="cp-none"><div class="empty">No draft on this card now. The Copilot writes one when the client writes or a follow-up falls due.</div><div class="row" style="justify-content:center"><button class="btn sm" id="cp-open-card">Open the card</button></div></div>`;
    host.querySelector("#cp-open-card").onclick = () => emit("open-peek", { type: "lead", id: leadId, tab: "chat" });
    return;
  }
  const st = {
    text: item.suggestion_text || "",
    original: item.suggestion_text || "",
    attachments: Array.isArray(item.attachments) ? item.attachments.slice() : [],
    curated: false,
    chain: [],
    image: null,
    // As /m: only a closing stage comes pre-picked; any other move is the Copilot's own on send.
    stage: item.suggested_stage_terminal ? item.suggested_stage || "" : "",
    busy: false,
    loading: false,
    error: "",
    contact: null,
    ai: "",
  };
  const broker = brokerForLead(item.responsible_user);
  const stages = await stagesOf(item.pipeline);
  if (host.dataset.lead !== leadId) return;
  let villaOptions = "";
  const next = (() => {
    const i = stages.findIndex((s) => stageName(s).toLowerCase() === String(item.lead_stage || "").toLowerCase());
    return (i === -1 ? stages : stages.slice(i + 1)).map(stageName);
  })();
  api(`/p/lead-contact?leadId=${encodeURIComponent(leadId)}`)
    .then((c) => {
      st.contact = c;
      const box = host.querySelector("#cp-contact");
      if (box) box.innerHTML = contactHtml();
    })
    .catch(() => undefined);

  const contactHtml = () => {
    const c = st.contact;
    if (!c) return `<span class="faint">loading the contact…</span>`;
    if (!c.phone && !c.name) return `<span class="faint">no contact on this card</span>`;
    const pretty = c.phoneRaw || (c.phone ? "+" + c.phone : "");
    return `${c.name ? `<span>${esc(c.name)}</span>` : ""}${c.phone ? `<a href="https://wa.me/${esc(c.phone)}" target="_blank" rel="noopener" class="mono">${esc(pretty)}</a><button class="btn sm ghost" data-copy="${esc(pretty)}">copy</button>` : ""}`;
  };
  const threadHtml = () => {
    const msgs = item.recent_messages || [];
    if (!msgs.length) return `<div class="faint cp-empty-thread">No messages yet.</div>`;
    return msgs.map((m) => `<div class="msg ${m.from === "us" ? "out" : "in"}"><div class="by">${m.from === "us" ? "You" : esc(item.lead_name || "Client")}</div>${linkify(m.text || "")}${m.at ? `<div class="at">${esc(fmtDT(m.at))}</div>` : ""}</div>`).join("");
  };
  const attHtml = () => {
    if (!st.attachments.length) return "";
    let h = "";
    st.attachments.forEach((a, i) => {
      if (a.type === "reminder") return (h += `<div class="cp-att note"><b>Reminder</b> ${esc(a.label || "")}</div>`);
      if (a.type === "image") return (h += `<div class="cp-att">${a.url ? `<img src="${esc(a.url)}" alt="">` : ""}<span>${esc(a.label || a.name || "image")}${a.url ? "" : " · not uploaded yet"}</span><button class="iconbtn" data-rm="${i}" title="Remove">${I.x}</button></div>`);
      if (a.type !== "link") return;
      const lad = a.ladder && a.ladder.caption ? a.ladder : null;
      if (lad) {
        const prev = st.attachments.slice(0, i).reverse().find((x) => x.type === "link");
        if (!prev || !prev.ladder || prev.ladder.band !== lad.band) h += `<div class="cp-lad-h">${esc((lad.headers && lad.headers[lad.band]) || "")}</div>`;
        h += `<div class="cp-lad-cap">${esc(lad.caption).replace(/\n/g, "<br>")}</div>`;
      }
      const code = (String(a.url).match(/\/property\/([A-Za-z0-9-]+)/i) || [])[1];
      const flag = item.villa_flags && item.villa_flags[a.url];
      h += `<div class="cp-att link">${I.villa}<a href="#" ${code ? `data-villa="${esc(code)}"` : `data-href="${esc(a.url)}"`}>${esc(a.label || code || a.url)}</a>${flag?.constructionNearby ? `<span class="pill bad">construction nearby</span>` : ""}<button class="iconbtn" data-rm="${i}" title="Remove">${I.x}</button></div>`;
      const later = st.attachments.slice(i + 1).some((x) => x.type === "link");
      if (lad && !later && lad.closing) h += `<div class="cp-lad-cap">${esc(lad.closing)}</div>`;
    });
    return `<div class="cp-atts">${h}</div>`;
  };
  const reportHtml = () => {
    const vr = item.viewing_report;
    if (st.vrFiled) return `<div class="help">Viewing report filed. It is saved on the card and the draft is being rewritten from it; it refreshes in a moment.</div>`;
    if (!vr) return "";
    return `<div class="cp-vr panel"><h3>Viewing report · ${esc(vr.property_code || "villa")} · ${esc(fmtDT(vr.viewing_at))}</h3>
      ${vr.open_count > 1 ? `<p class="faint" style="margin:0 0 6px">${vr.open_count} viewings of this client have no report; this is the latest.</p>` : ""}
      ${vr.property_code ? "" : `<label class="fld"><span>Which villa was viewed</span><input class="in" id="vr-code" placeholder="R-YUD-071"></label>`}
      <div class="sect-h">How it went</div>
      <div class="cp-chips" id="vr-out">${[["go", "Going ahead", "ok"], ["think", "Liked it, needs time", "warn"], ["no", "Not this one", "bad"]].map(([v, l, c]) => `<button class="chip" data-out="${v}" data-c="${c}">${l}</button>`).join("")}
        <span class="faint" style="margin:0 4px">or</span>${[["no_show", "Client didn't show"], ["cancelled", "Cancelled by the villa"], ["rescheduled", "Rescheduled"]].map(([v, l]) => `<button class="chip" data-out="${v}">${l}</button>`).join("")}</div>
      <label class="fld" id="vr-re-row" hidden><span>New slot</span><input class="in" type="datetime-local" id="vr-re"></label>
      <div class="sect-h" style="margin-top:8px">What the client said <button class="btn sm ghost" id="vr-dict">${I.mic} Dictate</button></div>
      <textarea class="in" id="vr-fb" rows="3" placeholder="What they liked, what is not right: price, dates, condition…"></textarea>
      <div class="sect-h" style="margin-top:8px">Next steps</div>
      <div class="cp-chips" id="vr-steps">${VR_STEPS.map((x) => `<button class="chip" data-step="${esc(x)}">${esc(x)}</button>`).join("")}</div>
      <div class="row" style="margin-top:8px"><label class="fld" style="flex:0 0 auto"><span>By when</span><input class="in" type="date" id="vr-by"></label>
        <label class="btn sm" style="align-self:flex-end">${I.gallery} Photos<input type="file" id="vr-pics" accept="image/*" multiple hidden></label>
        <label class="btn sm" style="align-self:flex-end">${I.video} Video<input type="file" id="vr-vid" accept="video/*" hidden></label>
        <span class="faint" id="vr-media" style="align-self:flex-end"></span><span class="spacer"></span>
        <button class="btn primary" id="vr-send" disabled style="align-self:flex-end">File the report</button></div></div>`;
  };
  const inspectionHtml = () => {
    const ir = item.inspection_report;
    const listings = String(item.pipeline || "").toLowerCase().includes("listing");
    if (ir) {
      const failed = ir.status === "failed";
      return `<div class="cp-vr panel"><h3>Inspection report · ${esc(ir.property_code || "villa")} · ${esc(fmtDT(ir.visit_at))}</h3><p class="faint" style="margin:0 0 8px">${failed ? "Filed, but some checks did not pass: open it to see what, and check again." : ir.status === "checking" ? "Being applied and checked…" : "Listed, red and green flags, notes, photos and video. Filing it moves the villa to live."}</p><a class="btn sm primary" href="${esc(S.meta.copilotOrigin)}/m/inspection/${encodeURIComponent(ir.id)}?broker=${encodeURIComponent(broker)}" target="_blank" rel="noopener">${failed ? "Open and check again" : "Open the report"}</a></div>`;
    }
    if (!listings || /live|weekly|availability/i.test(item.lead_stage || "")) return "";
    return `<div class="cp-vr panel"><div class="row"><button class="btn sm" id="ir-start">Inspected this villa? File the report</button><button class="btn sm ghost" id="sch-open">${I.cal} Set the inspection date</button><span class="faint" id="ir-st"></span></div>
      <div class="row" id="sch-row" hidden style="margin-top:8px"><input class="in" type="datetime-local" id="sch-at" style="width:auto"><button class="btn sm primary" id="sch-save">Save</button><span class="faint" id="sch-st"></span></div></div>`;
  };

  const draw = () => {
    const temp = item.profile_temperature;
    host.innerHTML = `<div class="cp">
      <div class="cp-scroll" id="cp-scroll">
        <div class="cp-head">
          <div class="cp-title">${opts.compact ? "" : `<h2>${esc(item.lead_name || "Card " + leadId)}</h2>`}${dueBadge(item.next_followup_at)}${opts.compact ? "" : `<span class="pill stage">${esc(item.lead_stage || "")}</span>`}<span class="spacer"></span>
            <a class="iconbtn" href="https://unicornproperty.amocrm.ru/leads/detail/${esc(leadId)}" target="_blank" rel="noopener" title="Open in amoCRM">${I.ext}</a>
            <button class="iconbtn" id="cp-classic" title="Classic Copilot">${I.panel}</button></div>
          <div class="cp-contact row" id="cp-contact">${contactHtml()}</div>
          <div class="row cp-temp"><span class="faint">Temperature${item.profile_temperature_source === "ai" ? " (read by the Copilot)" : ""}</span>${["hot", "warm", "cold"].map((t) => `<button class="pill ${t}" data-temp="${t}" style="${temp === t ? "" : "opacity:.35"}">${t}</button>`).join("")}</div>
        </div>
        ${(item.form_answers || []).length ? `<div class="cp-form">${item.form_answers.map((f) => `<span class="chip on"><b>${esc(f.label)}</b>&nbsp;${esc(f.value)}</span>`).join("")}</div>` : ""}
        <div class="thread cp-thread" id="cp-thread">${threadHtml()}</div>
        <div class="resize-y" id="cp-rs" title="Drag to resize"></div>
        ${reportHtml()}${inspectionHtml()}
        <div class="cp-draft">
          <div class="sect-h">Reply <span class="row" style="gap:6px"><span class="q ${item.kind === "live" ? "live" : "push"}">${esc(item.kind)}</span><span class="faint">written ${esc(rel(item.created_at))}</span></span></div>
          ${st.loading ? `<div class="loading" style="padding:16px">Rewriting…</div>` : `<textarea class="in cp-text" id="cp-text" rows="4">${esc(st.text)}</textarea>`}
          ${attHtml()}
          <div class="row cp-add"><button class="btn sm" id="cp-pick">${I.villa} Choose on site</button><input class="in" id="cp-find" list="cp-villas" placeholder="Add a listing: code or name, or paste a link"><datalist id="cp-villas">${villaOptions}</datalist><button class="btn sm" id="cp-add">${I.plus} Add</button></div>
          <div class="cp-ai"><textarea class="in" id="cp-ai" rows="1" placeholder="Tell the Copilot what to change, then Enter">${esc(st.ai)}</textarea>
            <button class="btn sm ghost" id="cp-dict" title="Dictate the instruction">${I.mic}</button>
            <label class="btn sm ghost" title="A screenshot of the real chat, read as context">${I.gallery}<input type="file" id="cp-shot" accept="image/*" hidden></label>
            <button class="btn sm" id="cp-rewrite" ${st.loading ? "disabled" : ""}>${I.sparkle} Rewrite</button></div>
          ${st.image ? `<div class="faint cp-shot">Screenshot attached as context <a href="#" id="cp-shot-x">remove</a></div>` : ""}
          ${item.suggested_stage ? `<div class="help cp-hint">${item.suggested_stage_terminal ? "Confirm to close: " : "On send the card moves to "}<b>${esc(item.suggested_stage)}</b>${item.suggested_stage_reason ? ` <span class="faint">${esc(item.suggested_stage_reason)}</span>` : ""}</div>` : ""}
        </div>
      </div>
      <div class="cp-actions">
        ${st.error ? `<div class="cp-err">${esc(st.error)}</div>` : ""}
        <div class="row">
          <button class="btn primary cp-send" id="cp-send" title="Send (⌘ Enter)" ${st.busy || st.loading ? "disabled" : ""}>${st.busy ? "Sending…" : "Send"}</button>
          <select class="chip" id="cp-stage" title="Move the card when sending"><option value="">Stage stays</option>${next.map((n) => `<option ${n === st.stage ? "selected" : ""}>${esc(n)}</option>`).join("")}</select>
          <span class="spacer"></span>
          <button class="btn sm ghost" id="cp-later" ${st.busy ? "disabled" : ""}>Not now</button>
          <button class="btn sm ghost" id="cp-more" ${st.busy ? "disabled" : ""}>More</button>
        </div>
      </div></div>`;
    const th = host.querySelector("#cp-thread");
    const saved = store.get("cp-thread-h", 260);
    th.style.height = saved + "px";
    th.scrollTop = th.scrollHeight;
    const rs = host.querySelector("#cp-rs");
    rs.onpointerdown = (e) => {
      e.preventDefault();
      const y0 = e.clientY;
      const h0 = th.offsetHeight;
      const mv = (ev) => (th.style.height = Math.max(90, Math.min(700, h0 + ev.clientY - y0)) + "px");
      const up = () => {
        document.removeEventListener("pointermove", mv);
        document.removeEventListener("pointerup", up);
        store.set("cp-thread-h", th.offsetHeight);
      };
      document.addEventListener("pointermove", mv);
      document.addEventListener("pointerup", up);
    };
    const ta = host.querySelector("#cp-text");
    if (ta) {
      const fit = () => ((ta.style.height = "auto"), (ta.style.height = Math.min(420, ta.scrollHeight + 2) + "px"));
      fit();
      ta.oninput = () => ((st.text = ta.value), fit());
      // ⌘/Ctrl+Enter sends, as the fastest path through a day of drafts.
      ta.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          host.querySelector("#cp-send")?.click();
        }
      });
    }
    // The catalog for the "add a listing" box: codes and titles from the site's own rows, read once.
    if (!villaOptions)
      loadVillas()
        .then((vs) => {
          villaOptions = vs.map((v) => `<option value="${esc(v.id)}">${esc(v.id)} · ${esc(v.title)} · ${v.bedrooms ?? "?"}BR · ${esc(money(v.monthly_price_idr))}</option>`).join("");
          const dl = host.querySelector("#cp-villas");
          if (dl) dl.innerHTML = villaOptions;
        })
        .catch(() => undefined);
    bind();
  };

  const addLink = (url) => {
    if (st.attachments.some((a) => a.type === "link" && String(a.url || "").split("?")[0] === String(url).split("?")[0])) return false;
    const m = String(url).match(/\/property\/([A-Za-z0-9-]+)/i);
    st.attachments.push({ type: "link", label: m ? m[1] : url, url, _broker: true });
    st.curated = true;
    const n = st.attachments.filter((a) => a.type === "link").length;
    if (n > 3) toast(`${n} links attached: clients are usually shown 2 or 3, worth a check`);
    return true;
  };
  const done = (msg) => {
    toast(msg);
    emit("lead-changed", { leadId });
    if (opts.onDone) opts.onDone();
  };

  async function approve(skipMessage, stageOverride) {
    if (st.busy) return;
    st.busy = true;
    st.error = "";
    draw();
    const newStage = stageOverride || st.stage || undefined;
    try {
      const { res, json } = await post("/approve", {
        suggestionId: item.id,
        message: st.text,
        edited: st.text.trim() !== st.original.trim(),
        originalText: st.original,
        brokerId: broker,
        attachments: st.attachments.filter((a) => a.type === "link" && a.url),
        attachmentsCurated: st.curated,
        newStage,
        stageId: newStage ? stageId(stages, newStage) || undefined : undefined,
        ...(skipMessage ? { skipMessage: true } : {}),
      });
      if (!res.ok || !json.ok) {
        st.error = sendError(res.status, json);
        st.busy = false;
        return draw();
      }
      done(skipMessage ? `Moved to ${newStage}` : json.message || "Sent");
    } catch (e) {
      st.error = INTERRUPTED;
      st.busy = false;
      draw();
    }
  }

  async function rewrite(feedback) {
    const fb = feedback.trim() || "Rewrite this draft using the manual edits as guidance.";
    st.chain.push({ draft: st.text, feedback: fb });
    st.loading = true;
    st.error = "";
    draw();
    try {
      const { res, json } = await post("/suggest", {
        guide: await getGuide(),
        lead: { name: item.lead_name || "Lead " + leadId, company: "", stage: item.lead_stage || item.kind || "" },
        messages: (item.recent_messages || []).map((m) => ({ from: m.from === "us" ? "broker" : "lead", text: m.text })),
        brokerName: broker,
        brokerId: broker,
        leadId,
        pendingId: item.id,
        revisionChain: st.chain,
        image: st.image || undefined,
        outputLanguage: "English",
        attachments: st.attachments.filter((a) => a.type === "link" && a.url),
        attachmentsCurated: st.curated,
      });
      if (!res.ok) throw new Error(json.error || `The Copilot could not rewrite (code ${res.status})`);
      if (json.text) st.text = json.text;
      st.ai = "";
      if (Array.isArray(json.attachments)) {
        const list = st.curated ? json.attachments : json.attachments.concat(st.attachments.filter((a) => a._broker));
        const seen = new Set();
        st.attachments = list.filter((a) => (a.url ? (seen.has(a.url) ? false : seen.add(a.url)) : true));
        st.curated = true;
        toast(`Options updated: ${st.attachments.filter((a) => a.type === "link").length} link(s)`);
      }
    } catch (e) {
      st.error = e.message;
    }
    st.loading = false;
    draw();
  }

  function openPicker() {
    // The site itself, in picker mode (same handshake as /m and the extension).
    const ov = document.createElement("div");
    ov.className = "overlay cp-picker";
    ov.innerHTML = `<div class="cp-picker-box"><div class="ph"><b>Choose listings on the site</b><span class="faint">tick villas, then “Send to Copilot”</span><span class="spacer"></span><button class="iconbtn" data-x>${I.x}</button></div><iframe src="${SITE}/rent" title="Choose listings"></iframe></div>`;
    document.body.appendChild(ov);
    const fr = ov.querySelector("iframe");
    const close = () => (window.removeEventListener("message", onMsg), ov.remove());
    const onMsg = (e) => {
      if (e.source !== fr.contentWindow) return;
      const d = e.data;
      if (d?.source === "unicorn-site" && d.type === "ready") fr.contentWindow.postMessage({ source: "unicorn-picker-host", type: "activate" }, "*");
      if (d?.source === "unicorn-picker" && d.type === "selection" && Array.isArray(d.urls)) {
        d.urls.forEach(addLink);
        close();
        draw();
      }
    };
    window.addEventListener("message", onMsg);
    ov.querySelector("[data-x]").onclick = close;
    ov.addEventListener("mousedown", (e) => e.target === ov && close());
  }

  async function moreMenu() {
    const r = await dialog({
      title: "Not sending this draft",
      body: `<div class="stack">
        <div class="row"><span class="faint" style="width:120px">Follow up in</span>${[1, 3, 5, 7].map((d) => `<button type="button" class="btn sm" data-resched="${d}">+${d} day${d > 1 ? "s" : ""}</button>`).join("")}</div>
        <label class="fld"><span>Or set a task in your words</span><textarea class="in" name="task" rows="2" placeholder="Call her on Monday about the second viewing"></textarea></label></div>`,
      actions: [
        { label: "Cancel", value: null },
        { label: "Remove from the bot", value: "exclude", danger: true },
        { label: "Close as lost", value: "lost", danger: true },
        { label: "Set the task", value: "task", primary: true },
      ],
      onMount: (form) =>
        on(form, "click", "[data-resched]", async (e, b) => {
          form.closest(".overlay").remove();
          const d = new Date();
          d.setDate(d.getDate() + Number(b.dataset.resched));
          d.setHours(9, 0, 0, 0);
          try {
            await post("/reschedule-task", { leadId, taskDate: d.toISOString() });
            done(`Follow-up moved +${b.dataset.resched}d`);
          } catch (err) {
            fail(err);
          }
        }),
    });
    if (!r) return;
    try {
      if (r.action === "task") {
        if (!r.values.task.trim()) return toast("Write the task first", { bad: true });
        const { res, json } = await post("/parse-task", { text: r.values.task });
        if (!res.ok || !json.taskDate) throw new Error(json.error || "The task could not be read");
        await post("/schedule-task", { leadId, taskDate: json.taskDate, taskText: json.taskText });
        await post("/skip", { suggestionId: item.id });
        done(`Task set: ${json.taskText}`);
      } else if (r.action === "lost") {
        if (!(await confirmBox("Close this card as lost?", "No message is sent.", "Close as lost", true))) return;
        await approve(true, "Closed - lost");
      } else if (r.action === "exclude") {
        if (!(await confirmBox("Remove this card from the bot?", "It will no longer get drafts in Live or Push. The card stays in amoCRM.", "Remove", true))) return;
        await post("/bot-exclude", { leadId });
        done("Removed from the bot");
      }
    } catch (e) {
      fail(e);
    }
  }

  function bind() {
    host.querySelector("#cp-classic").onclick = () => (store.set("copilot-classic", true), mountNativeCopilot(host, opts));
    on(host, "click", "[data-copy]", async (e, b) => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy);
        toast("Copied");
      } catch (err) {
        toast(b.dataset.copy);
      }
    });
    on(host, "click", "[data-temp]", async (e, b) => {
      const t = b.dataset.temp;
      if (item.profile_temperature === t) return;
      const prev = [item.profile_temperature, item.profile_temperature_source];
      item.profile_temperature = t;
      item.profile_temperature_source = "broker";
      draw();
      try {
        await post("/set-temperature", { leadId, temperature: t, brokerId: broker });
      } catch (err) {
        [item.profile_temperature, item.profile_temperature_source] = prev;
        draw();
        fail(err);
      }
    });
    on(host, "click", "[data-rm]", (e, b) => {
      st.attachments.splice(Number(b.dataset.rm), 1);
      st.curated = true;
      draw();
    });
    on(host, "click", "a[data-villa]", (e, a) => (e.preventDefault(), emit("open-peek", { type: "villa", id: a.dataset.villa })));
    on(host, "click", "a[data-href]", (e, a) => (e.preventDefault(), window.open(a.dataset.href, "_blank", "noopener")));
    host.querySelector("#cp-pick").onclick = openPicker;
    const find = host.querySelector("#cp-find");
    const add = () => {
      const v = find.value.trim();
      if (!v) return;
      const url = /^https?:\/\//i.test(v) ? v : /^[A-Za-z]+-[A-Za-z]+-\d+$|^[A-Za-z]+-\d+$/.test(v) ? `${SITE_ABS}/property/${v.toUpperCase()}` : null;
      if (!url) return toast("Type a listing code (R-YUD-071) or paste a full link", { bad: true });
      if (addLink(url)) draw();
      else toast("That listing is already attached");
    };
    host.querySelector("#cp-add").onclick = add;
    find.addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), add()));
    const ai = host.querySelector("#cp-ai");
    ai.oninput = () => (st.ai = ai.value);
    ai.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        rewrite(ai.value);
      }
    });
    ai.addEventListener("paste", (e) => {
      const f = [...(e.clipboardData?.items || [])].find((x) => x.type?.startsWith("image"))?.getAsFile();
      if (!f) return;
      e.preventDefault();
      const r = new FileReader();
      r.onload = () => ((st.image = r.result), draw(), toast("Screenshot pasted as context"));
      r.readAsDataURL(f);
    });
    host.querySelector("#cp-rewrite").onclick = () => rewrite(ai.value);
    host.querySelector("#cp-dict").onclick = (e) => recordVoice(e.currentTarget, (t) => t && ((ai.value = st.ai = (ai.value ? ai.value + " " : "") + t), ai.focus()));
    host.querySelector("#cp-shot").onchange = (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => ((st.image = r.result), draw(), toast("Screenshot added as context"));
      r.readAsDataURL(f);
    };
    const shotX = host.querySelector("#cp-shot-x");
    if (shotX) shotX.onclick = (e) => (e.preventDefault(), (st.image = null), draw());
    host.querySelector("#cp-stage").onchange = (e) => (st.stage = e.target.value);
    host.querySelector("#cp-send").onclick = async () => {
      if (st.stage) {
        const r = await dialog({
          title: `Move the card to “${st.stage}”`,
          body: `<p class="muted" style="margin:0">Send the message and move the card, or only move it.</p>`,
          actions: [
            { label: "Cancel", value: null },
            { label: "Only move", value: "move" },
            { label: "Send and move", value: "send", primary: true },
          ],
        });
        if (!r) return;
        return approve(r.action === "move");
      }
      approve(false);
    };
    host.querySelector("#cp-later").onclick = async () => {
      // As /m: a live draft books the next touch (/no-reply-needed); a push draft is skipped.
      try {
        if (item.kind === "live") {
          const { json } = await post("/no-reply-needed", { leadId });
          done(json?.terminal ? "Dismissed: the client is done, no follow-up. Close the card when ready." : "Not now: the Copilot follows up later");
        } else {
          await post("/skip", { suggestionId: item.id });
          done("Skipped");
        }
      } catch (e) {
        fail(e);
      }
    };
    host.querySelector("#cp-more").onclick = moreMenu;
    bindReport();
    bindInspection();
  }

  function bindReport() {
    const box = host.querySelector(".cp-vr");
    if (!box || !item.viewing_report) return;
    let outcome = null;
    const steps = new Set();
    const media = [];
    let uploads = 0;
    const sendBtn = host.querySelector("#vr-send");
    const refresh = () => {
      sendBtn.disabled = !outcome || uploads > 0;
      host.querySelector("#vr-media").textContent = uploads ? `uploading ${uploads}…` : media.length ? `${media.length} file(s) attached` : "";
    };
    on(box, "click", "[data-out]", (e, b) => {
      outcome = b.dataset.out;
      box.querySelectorAll("[data-out]").forEach((x) => x.classList.toggle("on", x === b));
      host.querySelector("#vr-re-row").hidden = outcome !== "rescheduled";
      refresh();
    });
    on(box, "click", "[data-step]", (e, b) => {
      const v = b.dataset.step;
      if (steps.has(v)) steps.delete(v);
      else steps.add(v);
      b.classList.toggle("on", steps.has(v));
    });
    host.querySelector("#vr-dict").onclick = (e) => {
      const fb = host.querySelector("#vr-fb");
      recordVoice(e.currentTarget, (t) => t && (fb.value = (fb.value ? fb.value + " " : "") + t));
    };
    const upload = async (file, kind) => {
      uploads++;
      refresh();
      try {
        const { json } = await post("/viewing-report/upload", { reportId: item.viewing_report.id, kind, name: file.name });
        if (!json.uploadUrl) throw new Error(json.error || "no upload slot");
        const put = await fetch(json.uploadUrl, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
        if (!put.ok) throw new Error("upload " + put.status);
        media.push(json.publicUrl);
      } catch (err) {
        fail(err);
      }
      uploads--;
      refresh();
    };
    host.querySelector("#vr-pics").onchange = (e) => [...e.target.files].forEach((f) => upload(f, "photo"));
    host.querySelector("#vr-vid").onchange = (e) => e.target.files[0] && upload(e.target.files[0], "video");
    sendBtn.onclick = async () => {
      sendBtn.disabled = true;
      const code = host.querySelector("#vr-code")?.value?.trim().toUpperCase() || null;
      const re = host.querySelector("#vr-re")?.value;
      try {
        const { res, json } = await post("/viewing-report", {
          reportId: item.viewing_report.id,
          outcome,
          feedback: host.querySelector("#vr-fb").value || "",
          nextSteps: [...steps],
          nextBy: host.querySelector("#vr-by").value || null,
          rescheduledTo: outcome === "rescheduled" && re ? new Date(re + ":00+08:00").toISOString() : null,
          propertyCode: code,
          brokerId: broker,
          media,
        });
        if (!res.ok || !json.ok) throw new Error(json.error || `The report was not filed (code ${res.status})`);
        st.vrFiled = true;
        toast("Viewing report filed");
        draw();
        emit("lead-changed", { leadId });
        setTimeout(() => mountNativeCopilot(host, opts), 3000);
      } catch (err) {
        fail(err);
        sendBtn.disabled = false;
      }
    };
  }

  function bindInspection() {
    const start = host.querySelector("#ir-start");
    if (start)
      start.onclick = async () => {
        start.disabled = true;
        host.querySelector("#ir-st").textContent = "opening the report…";
        try {
          const { json } = await post("/inspection-report/start", { leadId, broker });
          if (!json.ok || !json.id) throw new Error(json.error || "could not start");
          window.open(`${S.meta.copilotOrigin}/m/inspection/${encodeURIComponent(json.id)}?broker=${encodeURIComponent(broker)}`, "_blank", "noopener");
          host.querySelector("#ir-st").textContent = "opened in a new tab";
        } catch (err) {
          host.querySelector("#ir-st").textContent = err.message;
        }
        start.disabled = false;
      };
    const so = host.querySelector("#sch-open");
    if (so) {
      so.onclick = () => (host.querySelector("#sch-row").hidden = !host.querySelector("#sch-row").hidden);
      host.querySelector("#sch-save").onclick = async () => {
        const v = host.querySelector("#sch-at").value;
        const out = host.querySelector("#sch-st");
        if (!v) return (out.textContent = "pick a date and time");
        const { json } = await post("/inspection-report/schedule", { leadId, at: new Date(v + ":00+08:00").toISOString(), broker });
        out.textContent = json.ok ? "Saved; it reaches the calendar in a minute" : json.detail || "not saved";
      };
    }
  }

  draw();
}
