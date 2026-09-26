// Unicorn OS — Playbooks (owner, 26.09): the funnels' regulations, as in Cowork.
// One source: skills/*.md in the repository as GitHub's master has them (the server fetches every
// two minutes), the files the code obeys and the deploy's law gate guards; skills/README.md is the
// pool listing every regulation and where it lives. The OS shows them and keeps no copy. A change is a proposal; only the owner approves it; a
// Claude session then writes the approved words into the file (and the code) in a commit that
// names the proposal, and the proposal shows as applied.
import { S, api, esc, screens, on, toast, fail, dialog, rel, fmtDT, store } from "./core.js";

/** The regulation of each funnel. A file that does not exist yet is created by its first approved proposal. */
export const PLAYBOOK_OF = { "rental-listings": "rental-listings.md", rental: "rental.md", unicorn: "sales.md", general: "general.md" };

const isOwner = () => S.user?.role === "admin";

/** Propose a change to a regulation; `current` is what stands now, shown for reference. */
export async function proposeChange({ file, section = "", current = "" }) {
  const r = await dialog({
    title: "Propose a change",
    wide: true,
    body: `<p class="muted" style="margin:0 0 10px">The regulation <b>${esc(file)}</b> changes only with the owner's approval. Say what the bot should do, in plain words.</p>
      ${current ? `<div class="help" style="white-space:pre-wrap"><b>Now:</b> ${esc(current)}</div>` : ""}
      <label class="fld"><span>Where (section or stage)</span><input class="in" name="section" value="${esc(section)}"></label>
      <label class="fld" style="margin-top:10px"><span>The change</span><textarea class="in" name="text" rows="5" placeholder="From now on the bot asks the price with our 10% first, then whether they are the owner." required></textarea></label>
      <label class="fld" style="margin-top:10px"><span>Why</span><textarea class="in" name="reason" rows="2" placeholder="What happened that asks for it"></textarea></label>`,
    actions: [{ label: "Cancel", value: null }, { label: "Send to the owner", value: "ok", primary: true }],
  });
  if (!r) return null;
  try {
    const out = await api("/playbooks/proposals", { body: { file, section: r.values.section, text: r.values.text, reason: r.values.reason } });
    toast(`Proposal #${out.id} sent to the owner`);
    return out;
  } catch (e) {
    fail(e);
    return null;
  }
}

// A small Markdown reader for the regulations: headings, lists, tables, bold, code, paragraphs.
function inline(t) {
  return esc(t)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\[(no decision|нет решения)\]/gi, '<span class="pill warn">$1</span>');
}
function md(text) {
  const lines = String(text || "").split("\n");
  let out = "";
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^#{1,4}\s/.test(l)) {
      const n = l.match(/^#+/)[0].length;
      out += `<h${n + 1} class="pb-h${n}">${inline(l.replace(/^#+\s*/, ""))}</h${n + 1}>`;
      i++;
    } else if (/^\|/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const body = rows.filter((r) => !/^\|[\s:|-]+\|?$/.test(r));
      out += `<table class="pb-table"><thead><tr>${cells(body[0]).map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body
        .slice(1)
        .map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
        .join("")}</tbody></table>`;
    } else if (/^\s*([-*]|\d+\.)\s/.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      let items = "";
      while (i < lines.length && /^\s*([-*]|\d+\.)\s/.test(lines[i])) {
        let item = lines[i++].replace(/^\s*([-*]|\d+\.)\s/, "");
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s/.test(lines[i])) item += " " + lines[i++].trim();
        items += `<li>${inline(item)}</li>`;
      }
      out += ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`;
    } else if (!l.trim()) {
      i++;
    } else {
      let p = l;
      i++;
      while (i < lines.length && lines[i].trim() && !/^(#|\||\s*([-*]|\d+\.)\s)/.test(lines[i])) p += " " + lines[i++].trim();
      out += `<p>${inline(p)}</p>`;
    }
  }
  return out;
}

const STATUS = { pending: ["waiting for the owner", "warn"], approved: ["approved, waiting to be written in", "ok"], applied: ["in the regulation", "ok"], rejected: ["rejected", ""] };
const SITUATION = { style: "Style (every message)", first_contact: "First contact", qualifying: "Qualifying", options: "Options and shortlists", objection: "Objections", viewing: "Viewings", followup: "Follow-ups", owner_intake: "Villa owners (Rental Listings)", closing: "Closing" };

function proposalHtml(p) {
  const [label, cls] = STATUS[p.status] || [p.status, ""];
  return `<div class="panel pb-prop" data-prop="${p.id}">
    <h3><span>#${p.id} · ${esc(p.file)}${p.section ? ` · ${esc(p.section)}` : ""}</span><span class="pill ${cls}">${esc(label)}</span></h3>
    <div class="pb-text">${esc(p.text)}</div>
    ${p.reason ? `<div class="faint" style="margin-top:6px"><b>Why:</b> ${esc(p.reason)}</div>` : ""}
    <div class="faint" style="margin-top:6px;font-size:12px">Proposed by ${esc(p.by || p.source)} · ${esc(fmtDT(p.at))}${p.decidedBy ? ` · ${p.status === "rejected" ? "rejected" : "approved"} by ${esc(p.decidedBy)} ${esc(rel(p.decidedAt))}` : ""}${p.appliedCommit ? ` · written in (commit ${esc(p.appliedCommit)})` : ""}${p.note ? ` · note: ${esc(p.note)}` : ""}</div>
    ${p.status === "pending" && isOwner() ? `<div class="row" style="margin-top:10px"><button class="btn sm primary" data-decide="approve">Approve</button><button class="btn sm ghost" data-decide="reject">Reject</button></div>` : ""}
  </div>`;
}

screens.playbooks = {
  title: "Playbooks",
  async render({ el, tools, route }) {
    const tab = ["rules", "proposals", "lessons"].includes(route.parts[0]) ? route.parts[0] : "rules";
    const [list, props] = await Promise.all([api("/playbooks"), api("/playbooks/proposals")]);
    const waiting = props.items.filter((p) => p.status === "pending").length;
    tools.innerHTML = `<div class="views"><button data-pbt="rules" class="${tab === "rules" ? "active" : ""}">Regulations</button><button data-pbt="proposals" class="${tab === "proposals" ? "active" : ""}">Proposals${waiting ? ` · ${waiting}` : ""}</button><button data-pbt="lessons" class="${tab === "lessons" ? "active" : ""}">What the Copilot learned</button></div>`;
    on(tools, "click", "[data-pbt]", (e, b) => (location.hash = `#/playbooks/${b.dataset.pbt}`));

    if (tab === "proposals") {
      el.innerHTML = `<div class="page"><h1 class="pt">Proposals</h1><p class="pd">A regulation changes only with the owner's approval. After “Approve”, a Claude session writes the approved words into the file and the code, in a commit that names the proposal; the deploy refuses a change to the regulation without the owner's approval.</p>
        <div class="stack" style="gap:10px">${props.items.map(proposalHtml).join("") || `<div class="empty">No proposals yet.</div>`}</div></div>`;
      on(el, "click", "[data-decide]", async (e, b) => {
        const id = b.closest("[data-prop]").dataset.prop;
        const action = b.dataset.decide;
        const r = await dialog({
          title: `${action === "approve" ? "Approve" : "Reject"} proposal #${id}`,
          body: `<label class="fld"><span>A note (optional)</span><textarea class="in" name="note" rows="2"></textarea></label>`,
          actions: [{ label: "Cancel", value: null }, { label: action === "approve" ? "Approve" : "Reject", value: "ok", primary: true, danger: action === "reject" }],
        });
        if (!r) return;
        try {
          await api(`/playbooks/proposals/${id}/decide`, { body: { action, note: r.values.note } });
          toast(action === "approve" ? `#${id} approved` : `#${id} rejected`);
          screens.playbooks.render({ el, tools, route });
        } catch (err) {
          fail(err);
        }
      });
      return;
    }

    if (tab === "lessons") {
      el.innerHTML = `<div class="loading">Reading the lessons…</div>`;
      const L = await api("/playbooks/lessons");
      el.innerHTML = `<div class="page"><h1 class="pt">What the Copilot learned</h1>
        <p class="pd">Every edit a broker makes to a draft becomes a lesson for that moment of the conversation; the bot reads them when it writes the next draft there. They are how the Copilot learns to write like the team, not the regulation: the rules stay in the regulations above. ${L.asWritten14d == null ? "" : `In the last 14 days <b>${L.asWritten14d}%</b> of ${L.decided14d} decided drafts went out as written.`}</p>
        ${L.situations
          .map(
            (s) => `<details class="panel pb-less"><summary><b>${esc(SITUATION[s.situation] || s.situation)}</b> <span class="faint">${s.count} lesson${s.count === 1 ? "" : "s"}</span></summary>
            <ul>${s.items.map((x) => `<li>${esc(x.text)} <span class="faint">· ${esc(x.broker || "")} · ${esc(rel(x.at))}</span></li>`).join("")}</ul></details>`,
          )
          .join("") || `<div class="empty">No lessons yet.</div>`}</div>`;
      return;
    }

    const file = route.parts[1] ? decodeURIComponent(route.parts[1]) : store.get("pb-file", list.items[0]?.file);
    store.set("pb-file", file);
    const cur = list.items.find((x) => x.file === file) || list.items[0];
    const GROUPS = [
      ["pool", "The pool"],
      ["bot", "The bot's regulations"],
      ["claude-md", "Sections of CLAUDE.md"],
      ["cowork", "Cowork skills (edited in Cowork)"],
    ];
    const sub = (x) =>
      x.kind === "cowork"
        ? `${x.mirrored ? `Cowork · changed ${esc(x.updatedAt || "")}` : "named in the pool, not found in Cowork"}${x.pendingProposals ? ` · ${x.pendingProposals} waiting` : ""}`
        : x.missing
          ? `${x.status ? esc(x.status) + " · " : ""}not written yet`
          : [x.approved ? `approved ${esc(x.approved)}` : x.status ? esc(x.status) : "", x.pendingProposals ? `${x.pendingProposals} waiting` : "", x.openQuestions ? `${x.openQuestions} open question${x.openQuestions === 1 ? "" : "s"}` : "", x.notInPool ? "not in the pool" : ""].filter(Boolean).join(" · ");
    el.innerHTML = `<div class="pb-wrap"><div class="pb-list">${GROUPS.map(([k, l]) => {
      const xs = list.items.filter((x) => x.kind === k);
      return xs.length ? `<div class="pb-grp">${esc(l)}</div>${xs.map((x) => `<a class="pb-item ${x.file === cur?.file ? "on" : ""}" href="#/playbooks/rules/${encodeURIComponent(x.file)}"><b>${esc(x.title)}</b><span class="faint">${sub(x)}</span></a>`).join("")}` : "";
    }).join("")}<div class="faint pb-sync">From ${esc(list.source)}${list.checkedAt ? ` · checked ${esc(fmtDT(list.checkedAt))}` : ""}</div></div><div class="pb-doc" id="pb-doc"><div class="loading">Opening…</div></div></div>`;
    if (!cur) return;
    const doc = await api(`/playbooks/${encodeURIComponent(cur.file)}`);
    const box = el.querySelector("#pb-doc");
    box.innerHTML = `<div class="row pb-docbar"><span class="faint">${esc(doc.file)}${doc.versions[0] ? ` · last change ${esc(fmtDT(doc.versions[0].at))}` : ""}</span><span class="spacer"></span>
        <button class="btn sm primary" id="pb-propose">Propose a change</button>${doc.versions.length ? `<select class="chip" id="pb-ver"><option value="">Current version</option>${doc.versions.map((v) => `<option value="${esc(v.commit)}">${esc(fmtDT(v.at))} · ${esc(v.subject.slice(0, 60))}</option>`).join("")}</select>` : ""}</div>
      ${doc.note ? `<div class="help">${esc(doc.note)}</div>` : ""}
      <article class="pb-md" id="pb-md">${doc.exists ? md(doc.text) : doc.kind === "cowork" ? "" : `<div class="empty">This regulation is not written yet. Its first approved proposal starts it.</div>`}</article>`;
    box.querySelector("#pb-propose").onclick = () => proposeChange({ file: doc.file });
    const ver = box.querySelector("#pb-ver");
    if (ver)
      ver.onchange = async () => {
        const art = box.querySelector("#pb-md");
        if (!ver.value) return (art.innerHTML = md(doc.text));
        art.innerHTML = `<div class="loading">Opening that version…</div>`;
        const v = await api(`/playbooks/${encodeURIComponent(doc.file)}/versions/${ver.value}`);
        art.innerHTML = `<div class="help">An earlier version, read only.</div>${md(v.text)}`;
      };
  },
};
