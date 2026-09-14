/**
 * The CRM stage follows the WhatsApp thread — whoever wrote the message.
 *
 * Owner, 14.09.2026: "всё должно быть синхронно вацап и копилот". The audit of
 * 07–13.09 found 29 Rental cards on a wrong stage, for reasons that all had
 * the same shape: one behaviour living in several copies that disagreed.
 *   - A reply typed on the broker's phone was noticed first by amo-sync, which
 *     stamped last_our_message_at in "repair" mode (no stage). The timeline
 *     sweep and the webhook then compared against that stamp, saw nothing new,
 *     and the stage logic never ran: Lorenzo's second viewing, Remi's viewing,
 *     links sent from the phone on five cards.
 *   - The echo of our own send reached the webhook as "the broker replied" and
 *     re-classified a thread whose links were not stored yet: cards moved BACK.
 *   - approve applied a classification made before the send, from the frozen
 *     content column, with a stale stage id.
 *   - The first message never set "need assessed".
 *   - A card could hold one viewing only.
 *
 * Now every path that sees a new message calls onThreadChanged(). It waits
 * for the thread to settle, re-reads it from amoCRM into lead_messages, and
 * makes ONE decision with its own watermark (leads_sync.stage_checked_at):
 *   1. a no-WhatsApp notice → the existing close path (undeliverableVerdict);
 *   2. floors in code: anything we sent → at least "need assessed"; a
 *      /property/ link we sent → at least "Options sent"; never lower;
 *   3. viewing slots: every concrete slot agreed is recorded in viewing_slots
 *      (the report pass works from it); a new slot after a held viewing starts
 *      a new cycle;
 *   4. the classifier for the rest. Forward moves are free; a backward move
 *      needs a focused yes/no from the thread (fail-closed); an echo of our own
 *      send never moves a card back. Closed won/lost and CHECK IN are never
 *      set here, and a card on them is never moved.
 * One log line per run: "stage-sync decision".
 */
import { db, leadsSyncTable, leadMessagesTable, sentMessagesTable, stageEventsTable, stageSyncDecisionsTable, viewingSlotsTable } from "@workspace/db";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { logger } from "./logger";
import { pipelineKind, isConversationalPipeline, isListingAcquisition } from "./pipelines";
import { classifyStage, safeStageIdForLead, amoStageFor, type StageDef } from "./stage-classifier";
import { getAmoLead, updateLeadStatus } from "./amo-client";
import { chatCompletionJSON, HELPER_MODEL } from "./ai-client";
import { undeliverableVerdict, closeUndeliverable, isUndeliverableNotice } from "./undeliverable";
import { shouldSuppressPush } from "./stage-routing";
import { refreshLeadMessages } from "./amo-timeline-sync";

const BALI = "Asia/Makassar";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Quiet time after the newest message before the thread is judged. Long
 *  enough for a Salesbot text and its links, or a burst typed on the phone. */
const DEBOUNCE_MS = 75_000;
/** A chat that never pauses is still judged at least this often. */
const MAX_WAIT_MS = 5 * MIN;
/** A message within this of a sent_messages row is ours (approve, auto-send). */
const ECHO_WINDOW_MS = 3 * MIN;
const CLOSED_STATUS_IDS = new Set([142, 143]);
const PROPERTY_LINK = /\/property\/([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/i;
const PROPERTY_LINKS = /\/property\/([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/gi;
/** Stages only a person sets and only a person leaves. */
const HANDS_OFF = /check[-\s]?in|inventory|contract\s*signed/i;
const REACH_LADDER = /1st follow up|2nd follow up|final follow up/i;
/** Worth asking "was a slot agreed?" only when the new messages talk about time. */
const SLOT_CUE = /\b(view|viewing|visit|come by|come over|come around|see (it|the villa|the house|you)|meet|tomorrow|today|tonight|this (morning|afternoon|evening)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|o'?clock|besok|hari ini)\b|\b\d{1,2}[:.]\d{2}\b|\b\d{1,2}\s*(am|pm)\b/i;
const STAGE = {
  need: /need.?s?\s*assess/i,
  options: /option/i,
  suggested: /viewing\s*suggest/i,
  scheduled: /viewing\s*(scheduled|booked|arranged)/i,
  done: /viewing\s*(done|held|completed)/i,
};

export type ThreadSource =
  | "inbound"
  | "approve"
  | "auto-send"
  | "phone"
  | "webhook"
  | "amo-outgoing-event"
  | "timeline"
  | "viewing-outcome"
  | "backfill";

export type ThreadMessage = { senderType: string; text: string | null; sentAt: Date };

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

function fmt(d: Date): string {
  return d.toLocaleString("en-GB", { timeZone: BALI, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function propertyCodes(text: string | null | undefined): string[] {
  return [...(text ?? "").matchAll(PROPERTY_LINKS)].map((m) => m[1]!.toUpperCase());
}

/** Rental's stages follow every message; other client funnels only the broker's own replies. */
export function threadDrivesStage(pipeline: string | null | undefined): boolean {
  return pipelineKind(pipeline) === "rental";
}

/** The thread as the models read it: one line per message, oldest first, the integration's notices left out. */
export function transcriptOf(messages: ThreadMessage[], n = 30): string {
  return messages
    .filter((m) => (m.text ?? "").trim() && !isUndeliverableNotice(m.text))
    .slice(-n)
    .map((m) => `${fmt(m.sentAt)} ${m.senderType === "lead" ? "Client" : "Broker"}: ${(m.text ?? "").replace(/\s+/g, " ").trim()}`)
    .join("\n");
}

export async function loadThread(leadId: string, asOf?: Date, limit = 200): Promise<ThreadMessage[]> {
  const rows = await db
    .select({ senderType: leadMessagesTable.senderType, text: leadMessagesTable.text, sentAt: leadMessagesTable.sentAt })
    .from(leadMessagesTable)
    .where(and(eq(leadMessagesTable.leadId, leadId), asOf ? lte(leadMessagesTable.sentAt, asOf) : undefined))
    .orderBy(desc(leadMessagesTable.sentAt))
    .limit(limit);
  return rows.reverse();
}

/** The transcript every stage reader uses: lead_messages, never the frozen content column. */
export async function threadTranscript(leadId: string, n = 30): Promise<string> {
  return transcriptOf(await loadThread(leadId, undefined, n + 20), n);
}

/** Is a message at this moment the echo of a send we recorded (approve, the automatic welcome)? */
export async function isEchoOfOurSend(leadId: string, at: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: sentMessagesTable.id })
    .from(sentMessagesTable)
    .where(
      and(
        eq(sentMessagesTable.leadId, leadId),
        gte(sentMessagesTable.createdAt, new Date(at.getTime() - ECHO_WINDOW_MS)),
        lte(sentMessagesTable.createdAt, new Date(at.getTime() + ECHO_WINDOW_MS)),
      ),
    )
    .limit(1);
  return !!row;
}

// ── Viewing slot and evidence readers ────────────────────────────────────────

export type ExtractedSlot = { viewingAt: Date; agreedAt: Date | null; propertyCode: string | null };

function parseIso(v: unknown): Date | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The most recent viewing slot AGREED in the thread, when it was settled, and
 * which villa it is for. The villa comes from the messages that agree the slot
 * — the last code sent before the slot named the wrong villa in 2 of 3 reports
 * (Lorenzo R-YUD-074 for R-AME-028) — and is null when that exchange does not
 * make it clear: the broker picks it in the report form instead.
 */
export async function extractViewingSlot(threadText: string, asOf: Date = new Date()): Promise<ExtractedSlot | null> {
  const out = await chatCompletionJSON<{ viewing_at: string | null; agreed_at: string | null; property: string | null }>({
    model: HELPER_MODEL,
    label: "viewing:extract-slot",
    max_tokens: 160,
    temperature: 0,
    system: `Now is ${fmt(asOf)} (day/month, Bali time, year ${asOf.getFullYear()}). Every line in the thread starts with the day/month and time it was written, Bali time. Our messages carry the links we sent (.../property/<CODE>).
Find the MOST RECENT property viewing in this thread that was AGREED for a concrete date and time: a slot the client accepted, or one both sides confirmed ("tomorrow at 2:30 works", "Yes 2pm", "See you at 2PM"). An offer, a request, "I'll check availability", or a time proposed and not accepted is not agreed. If that viewing was later cancelled or called off, answer null.
- viewing_at: the slot as an ISO datetime in +08:00, or null.
- agreed_at: when the slot was settled (the date and time of the line that settled it), ISO +08:00, or null.
- property: the code of the villa this slot is for (like R-YUD-071), ONLY when the messages that agree the slot make it clear: the client answering under one link, the broker naming it, one villa being discussed in that exchange. null when two or more villas could be meant or none is named.
Relative words ("tomorrow", "Wednesday") are relative to the line they appear in, not to now.
JSON only: {"viewing_at": "2026-09-07T15:00:00+08:00" | null, "agreed_at": "2026-09-06T11:20:00+08:00" | null, "property": "R-YUD-071" | null}`,
    messages: [{ role: "user", content: threadText.slice(-7000) }],
  }).catch(() => null);
  const at = parseIso(out?.viewing_at);
  if (!at) return null;
  let agreed = parseIso(out?.agreed_at);
  if (agreed && agreed.getTime() > asOf.getTime() + MIN) agreed = null;
  // Danny 23538877, 14.09: the broker's offer "R-YUD-085 … available to visit
  // tomorrow" (no time, never accepted) came back as 12.09 00:00 and produced a
  // report form for a viewing that never happened, and a "how did it go?" PUSH
  // right after her real message. A slot needs the line that settled it and a
  // stated time: no agreed_at, or exactly midnight Bali, is not an agreed slot.
  if (!agreed) return null;
  const baliMinutes = (at.getUTCHours() * 60 + at.getUTCMinutes() + 8 * 60) % (24 * 60);
  if (baliMinutes === 0) return null;
  // A slot two months past its agreement, or long before it, is a misread.
  if (at.getTime() > (agreed ?? asOf).getTime() + 60 * DAY) return null;
  if (agreed ? at.getTime() < agreed.getTime() - 12 * HOUR : at.getTime() < asOf.getTime() - 2 * DAY) return null;
  let code = typeof out?.property === "string" ? out.property.trim().toUpperCase() : null;
  if (code && (!/^(R-[A-Z]+-\d+|YUDR-\d+)$/.test(code) || !threadText.toUpperCase().includes(code))) code = null;
  return { viewingAt: at, agreedAt: agreed, propertyCode: code };
}

/**
 * The villa a slot was for, when a report is created without one on record (an
 * admin backdate, a slot copied from leads_sync). Read from the thread as it
 * stood an hour after the slot; null unless that reading lands on the same slot.
 */
export async function propertyForSlot(leadId: string, viewingAt: Date): Promise<string | null> {
  const [row] = await db
    .select({ code: viewingSlotsTable.propertyCode })
    .from(viewingSlotsTable)
    .where(and(eq(viewingSlotsTable.leadId, leadId), eq(viewingSlotsTable.viewingAt, viewingAt)))
    .limit(1);
  if (row?.code) return row.code;
  const asOf = new Date(viewingAt.getTime() + HOUR);
  const ex = await extractViewingSlot(transcriptOf(await loadThread(leadId, asOf), 40), asOf);
  return ex && Math.abs(ex.viewingAt.getTime() - viewingAt.getTime()) <= 90 * MIN ? ex.propertyCode : null;
}

/** The slot alone, for the send path's canon: ahead, or at most two days past. */
export async function extractViewingAt(threadText: string): Promise<Date | null> {
  const s = await extractViewingSlot(threadText);
  return s && s.viewingAt.getTime() >= Date.now() - 2 * DAY ? s.viewingAt : null;
}

/**
 * Second opinion before a card moves BACK. One question, counter-examples in
 * view, fail-closed: a field inside a broad classification is not enough to
 * undo a booked viewing or a negotiation.
 */
export async function backwardEvidence(from: string, to: string, threadText: string): Promise<{ confirmed: boolean; why: string }> {
  const viewing = /viewing/i.test(from);
  const question = viewing
    ? "did the viewing stop being the current state — was it CANCELLED, MISSED (no-show), or did the client REJECT the property they saw / RESTART their search after it?"
    : "did the client go BACK — withdraw a decision they had made, reject everything offered and restart the search, or return to basic requirements?";
  const trueWhen = viewing
    ? `"let's cancel", "I can't make it" with no new slot, "didn't like it, show me others", "we chose another place", the broker confirming the viewing fell through.`
    : `"we changed our minds, show us something else", "forget that one, we now need 3 bedrooms", "not ready to talk terms, still looking".`;
  const falseFor = viewing
    ? "- the client asking about OTHER villas while the viewing is still booked\n- rescheduling to another slot (that is still a booked viewing)\n"
    : "- a clarifying question inside the current stage\n";
  const out = await chatCompletionJSON<{ regressed: boolean; why: string }>({
    model: HELPER_MODEL,
    label: "stage:backward-check",
    max_tokens: 120,
    temperature: 0,
    system: `The CRM card is in "${from}"; a classifier proposes moving it back to "${to}". Answer ONE question about the thread: ${question}

true ONLY when the thread states it: ${trueWhen}

false for everything else, including:
${falseFor}- silence, or a slot that simply passed with no word
- anything you are unsure about

JSON only: {"regressed": true|false, "why": "<8 words>"}`,
    messages: [{ role: "user", content: threadText.slice(-6000) }],
  }).catch(() => null);
  if (!out || typeof out.regressed !== "boolean") return { confirmed: false, why: "check failed — staying put" };
  return { confirmed: out.regressed, why: out.why ?? "" };
}

// ── The decision (reads, model calls; no writes) ─────────────────────────────

export type SlotRecord = { viewingAt: Date; status: string; propertyCode: string | null };
export type SlotChange = { viewingAt: Date; agreedAt: Date | null; propertyCode: string | null; replaces: Date | null; newCycle: boolean };

export type DecideInput = {
  leadId: string;
  pipeline: string | null;
  /** amoCRM's own stage name and id for the card — never leads_sync's copy. */
  stage: string | null;
  statusId: number | null;
  funnel: StageDef[];
  storedViewingAt: Date | null;
  slots: SlotRecord[];
  /** Oldest first, up to asOf. */
  messages: ThreadMessage[];
  /** sent_messages.created_at for the lead: what WE sent through approve or an automatic path. */
  sentAt: Date[];
  checkedAt: Date | null;
  asOf: Date;
  sources: ThreadSource[];
};

export type StageDecision = {
  action: "move" | "stay" | "close-undeliverable";
  from: string | null;
  to: string | null;
  direction: "forward" | "backward" | "new-cycle" | null;
  reason: string;
  /** Value for leads_sync.viewing_at; undefined leaves it alone. */
  viewingAt?: Date | null;
  slot: SlotChange | null;
  /** A confirmed cancellation: slots after this moment are no longer owed a report. */
  cancelSlotsAfter?: Date | null;
  newestAt: Date | null;
  echoOnly: boolean;
  counts: { fresh: number; inbound: number; phone: number; ours: number };
};

export async function decideStage(i: DecideInput): Promise<StageDecision> {
  const rental = pipelineKind(i.pipeline) === "rental";
  const full = i.sources.includes("backfill") || i.sources.includes("viewing-outcome");
  const newestAt = i.messages.length ? i.messages[i.messages.length - 1]!.sentAt : null;
  const since = i.checkedAt ?? new Date(i.asOf.getTime() - 6 * HOUR);
  const fresh = i.messages.filter((m) => m.sentAt.getTime() > (full ? i.asOf.getTime() - 14 * DAY : since.getTime()));
  const inbound = fresh.filter((m) => m.senderType === "lead" && !isUndeliverableNotice(m.text) && (m.text ?? "").trim());
  const ours = fresh.filter((m) => m.senderType !== "lead");
  const isOurSend = (m: ThreadMessage) =>
    m.senderType === "bot" || i.sentAt.some((s) => Math.abs(s.getTime() - m.sentAt.getTime()) <= ECHO_WINDOW_MS);
  const phone = ours.filter((m) => !isOurSend(m));
  const echoOnly = !full && inbound.length === 0 && phone.length === 0;
  const base = {
    from: i.stage,
    newestAt,
    echoOnly,
    counts: { fresh: fresh.length, inbound: inbound.length, phone: phone.length, ours: ours.length },
  };
  let slot: SlotChange | null = null;
  const stay = (reason: string, extra: Partial<StageDecision> = {}): StageDecision => ({
    ...base, action: "stay", to: null, direction: null, reason, slot, ...extra,
  });

  if (fresh.length === 0) return stay("nothing new in the thread since the last check");

  const closed = i.statusId != null && CLOSED_STATUS_IDS.has(i.statusId);
  if (!closed) {
    const v = undeliverableVerdict(i.messages);
    if (v.close && v.noticeAt && (full || v.noticeAt.getTime() > since.getTime())) {
      return { ...base, action: "close-undeliverable", to: "Closed - lost", direction: null, reason: v.why, slot: null };
    }
  }

  const all = i.funnel;
  const cur = all.findIndex((s) => norm(s.name) === norm(i.stage));
  const at = (re: RegExp) => all.findIndex((s) => re.test(s.name));
  const NEED = at(STAGE.need), OPTIONS = at(STAGE.options), SUGGESTED = at(STAGE.suggested), SCHEDULED = at(STAGE.scheduled), DONE = at(STAGE.done);

  // ── Viewing slot: recorded even where the stage cannot move (a closed card,
  //    a negotiation), because every held viewing is owed a report. ──────────
  const liveSlots = i.slots.filter((s) => s.status === "scheduled" || s.status === "reported");
  const known = [...liveSlots.map((s) => s.viewingAt), ...(i.storedViewingAt ? [i.storedViewingAt] : [])].sort((a, b) => a.getTime() - b.getTime());
  const previous = known.length ? known[known.length - 1]! : null;
  let latest = previous;
  const notes: string[] = [];
  const cue = fresh.some((m) => SLOT_CUE.test(m.text ?? "")) || (cur >= 0 && (cur === SUGGESTED || cur === SCHEDULED));
  if (SCHEDULED >= 0 && (cue || full)) {
    const ex = await extractViewingSlot(transcriptOf(i.messages, 40), i.asOf);
    if (ex) {
      if (previous && Math.abs(ex.viewingAt.getTime() - previous.getTime()) <= 45 * MIN) {
        // The slot the card already holds.
      } else if (previous && ex.viewingAt.getTime() < previous.getTime() && previous.getTime() <= i.asOf.getTime()) {
        notes.push(`the thread's newest agreed slot (${fmt(ex.viewingAt)}) is older than the one on record — ignored`);
      } else {
        // The earlier slot had passed before this one was agreed: it was held
        // (or missed) and keeps its claim to a report — a new cycle. Otherwise
        // this slot replaces it: a reschedule.
        const newCycle = !!previous && previous.getTime() + HOUR <= (ex.agreedAt ?? i.asOf).getTime();
        slot = { viewingAt: ex.viewingAt, agreedAt: ex.agreedAt, propertyCode: ex.propertyCode, replaces: previous && !newCycle ? previous : null, newCycle };
        latest = ex.viewingAt;
      }
    }
  }
  const slotStillValid = (d: Date | null) => !!d && d.getTime() >= i.asOf.getTime() - 2 * DAY;
  const hasPassed = (d: Date | null) => !!d && d.getTime() <= i.asOf.getTime();

  // ── Cards nothing automatic may move ────────────────────────────────────────
  if (closed) return stay("the card is closed — closing and reopening are the broker's taps");
  if (cur < 0) return stay(`stage "${i.stage}" is not in the card's funnel map`);
  if (cur === 0 || shouldSuppressPush(i.stage ?? "")) return stay(`"${i.stage}" is not a conversation stage`);
  if (HANDS_OFF.test(i.stage ?? "")) return stay(`"${i.stage}" is set and left by the broker only`);
  if (REACH_LADDER.test(i.stage ?? "")) return stay("on the REACH ladder — never pulled off it by the thread");
  if (!rental && phone.length === 0 && !full) return stay(`${i.pipeline}: the stage follows the broker's own replies and sends only`);

  // ── Floors: facts in code, not a reading of prose ──────────────────────────
  let floor = -1;
  let floorWhy = "";
  if (rental) {
    const anyLink = i.messages.some((m) => m.senderType !== "lead" && PROPERTY_LINK.test(m.text ?? ""));
    const anyOurs = i.messages.some((m) => m.senderType !== "lead" && (m.text ?? "").trim());
    if (anyLink && OPTIONS >= 0) { floor = OPTIONS; floorWhy = "floor: a property link went out"; }
    else if (anyOurs && NEED >= 0) { floor = NEED; floorWhy = "floor: our first message went out"; }
  }

  // ── After a held viewing the card never goes back (owner, 14.09) ───────────
  // The 09.09 canon moved Viewing done back to Options sent when a new
  // shortlist went out; the owner reversed it: "пусть там же остаётся —
  // просто подбирается новая вилла, но этап тот же". It also fought the
  // classifier — Searra and Alena went Viewing done → Options sent → Viewing
  // done within a minute on 14.09. A new viewing is a new cycle (below); a new
  // shortlist changes nothing.
  const pastViewing = rental && DONE >= 0 && cur >= DONE;

  // ── The classifier, told what code knows for certain ───────────────────────
  const facts: string[] = [];
  if (latest) {
    const hrs = (i.asOf.getTime() - latest.getTime()) / HOUR;
    facts.push(hrs < 0
      ? `A viewing is booked for ${fmt(latest)} Bali — still ahead (${Math.round(-hrs)}h from now).`
      : `A viewing was booked for ${fmt(latest)} Bali — that time passed ${Math.round(hrs)}h ago.`);
  }
  if (latest && hasPassed(latest)) {
    // Replay of Lorenzo 12.09 16:02 ("keen to lock the house in… deposit?"):
    // the model wrote "now discussing terms" and still picked Viewing done.
    facts.push(
      "After a held viewing, a client already discussing terms for that villa (price or a discount, deposit, move-in date, contract length, how to lock it in) is in Negotiation done, not Viewing done.",
    );
  }
  if (slot?.newCycle && previous) facts.push(`That slot was agreed after an earlier viewing on ${fmt(previous)}: it is a second viewing.`);
  if (floor >= 0) facts.push(floor === OPTIONS ? "Property links have been sent to this client." : "We have already written to this client.");
  const cls = await classifyStage({
    pipeline: i.pipeline,
    currentStage: i.stage,
    conversationText: transcriptOf(i.messages, 30),
    replyText: "",
    attachmentsCount: 0,
    facts,
  });

  type Candidate = { idx: number; why: string };
  const forward: Candidate[] = [];
  if (floor > cur) forward.push({ idx: floor, why: floorWhy });
  let newCycleMove = false;
  if (slot && SCHEDULED >= 0 && slotStillValid(slot.viewingAt)) {
    if (cur < SCHEDULED) forward.push({ idx: SCHEDULED, why: `viewing agreed for ${fmt(slot.viewingAt)}` });
    else if (cur === DONE && slot.newCycle) newCycleMove = true;
    else if (cur > DONE) notes.push(`another viewing agreed for ${fmt(slot.viewingAt)} while on "${i.stage}" — stage kept, the slot is recorded for its report`);
  }
  let back: StageDef | null = null;
  if (cls?.terminal) {
    notes.push(`classifier says "${cls.stage.name}" — closing is the broker's tap`);
  } else if (cls) {
    const li = all.findIndex((s) => s.id === cls.stage.id);
    if (li > cur) {
      if (li === SCHEDULED && !slotStillValid(latest)) notes.push(`classifier says Viewing scheduled, but no concrete agreed slot is readable (canon)`);
      else if (li === DONE && latest && !hasPassed(latest)) notes.push(`classifier says Viewing done, but the booked slot ${fmt(latest)} has not come yet (canon)`);
      else if (HANDS_OFF.test(cls.stage.name)) notes.push(`classifier says "${cls.stage.name}" — the broker's stage`);
      else forward.push({ idx: li, why: `classifier: ${cls.reason}` });
    } else if (li >= 0 && li < cur) {
      back = cls.stage;
    }
  }
  const tail = () => (notes.length ? ` (${notes.join("; ")})` : "");

  if (forward.length > 0) {
    const best = forward.reduce((a, b) => (b.idx > a.idx ? b : a));
    return {
      ...base, slot, action: "move", to: all[best.idx]!.name, direction: "forward", reason: best.why + tail(),
      viewingAt: best.idx === SCHEDULED ? (slot?.viewingAt ?? latest) : undefined,
    };
  }
  if (newCycleMove && slot) {
    return {
      ...base, slot, action: "move", to: all[SCHEDULED]!.name, direction: "new-cycle",
      reason: `a new viewing agreed for ${fmt(slot.viewingAt)} after the one on ${previous ? fmt(previous) : "record"} — a new cycle, no regression check${tail()}`,
      viewingAt: slot.viewingAt,
    };
  }
  if (back) {
    if (echoOnly) return stay(`classifier says "${back.name}", but only our own send is new — an echo never moves a card back${tail()}`);
    if (pastViewing && all.findIndex((s) => s.id === back!.id) < DONE) {
      return stay(`classifier says "${back.name}", but a held viewing keeps the card on "${i.stage}" — a new shortlist or a rejection does not move it back (owner, 14.09)${tail()}`);
    }
    const target = Math.max(all.findIndex((s) => s.id === back!.id), floor);
    if (target >= cur) return stay(`classifier says "${back.name}", held by the floor (${floorWhy})${tail()}`);
    const ev = await backwardEvidence(i.stage ?? "", all[target]!.name, transcriptOf(i.messages, 30));
    if (!ev.confirmed) return stay(`classifier says "${back.name}" — a move back needs the thread to state it; not found (${ev.why})${tail()}`);
    const leavesViewing = cur === SCHEDULED || cur === DONE;
    return {
      ...base, slot, action: "move", to: all[target]!.name, direction: "backward",
      reason: `back, stated in the thread: ${ev.why}${tail()}`,
      viewingAt: leavesViewing ? null : undefined,
      cancelSlotsAfter: cur === SCHEDULED ? new Date(i.asOf.getTime() - 3 * HOUR) : null,
    };
  }
  if (slot && cur === SCHEDULED) {
    return stay(`still Viewing scheduled; slot now ${fmt(slot.viewingAt)}${slot.replaces ? ` (replaces ${fmt(slot.replaces)})` : ""}${tail()}`, { viewingAt: slot.viewingAt });
  }
  return stay(`${cls ? "classifier: no move" : "classifier: nothing to change"}${tail()}`);
}

// ── Apply ────────────────────────────────────────────────────────────────────

export async function recordViewingSlot(
  leadId: string,
  s: { viewingAt: Date; agreedAt?: Date | null; propertyCode?: string | null; replaces?: Date | null },
  source: string,
): Promise<void> {
  await db
    .insert(viewingSlotsTable)
    .values({ leadId, viewingAt: s.viewingAt, agreedAt: s.agreedAt ?? null, propertyCode: s.propertyCode ?? null, source, status: "scheduled" })
    .onConflictDoUpdate({
      target: [viewingSlotsTable.leadId, viewingSlotsTable.viewingAt],
      set: {
        propertyCode: sql`coalesce(${viewingSlotsTable.propertyCode}, excluded.property_code)`,
        status: sql`CASE WHEN ${viewingSlotsTable.status} = 'reported' THEN 'reported' ELSE 'scheduled' END`,
        updatedAt: new Date(),
      },
    });
  if (s.replaces) {
    await db
      .update(viewingSlotsTable)
      .set({ status: "rescheduled", updatedAt: new Date() })
      .where(and(eq(viewingSlotsTable.leadId, leadId), eq(viewingSlotsTable.viewingAt, s.replaces), eq(viewingSlotsTable.status, "scheduled")));
  }
}

export type SyncResult = StageDecision & { leadId: string; source: string; moved: boolean; applied: string };

function logDecision(r: SyncResult): void {
  logger.info(
    {
      leadId: r.leadId,
      source: r.source,
      from: r.from,
      decided: r.to,
      action: r.action,
      direction: r.direction,
      moved: r.moved,
      applied: r.applied,
      reason: r.reason,
      echoOnly: r.echoOnly,
      ...r.counts,
      newestAt: r.newestAt,
      viewingAt: r.viewingAt,
      slot: r.slot ? { at: r.slot.viewingAt, property: r.slot.propertyCode, newCycle: r.slot.newCycle, replaces: r.slot.replaces } : null,
    },
    "stage-sync decision",
  );
  void db
    .insert(stageSyncDecisionsTable)
    .values({
      leadId: r.leadId,
      source: r.source,
      fromStage: r.from,
      toStage: r.to,
      action: r.action,
      direction: r.direction,
      moved: r.moved,
      applied: r.applied,
      reason: r.reason.slice(0, 600),
      newestAt: r.newestAt,
    })
    .catch(() => undefined);
}

/**
 * Judge the thread and apply the decision. Idempotent: a thread with nothing
 * newer than stage_checked_at is a no-op. `asOf` replays a past moment and
 * never writes; `forwardOnly` is for bulk repair.
 */
export async function syncStageFromThread(
  leadId: string,
  o: { sources: ThreadSource[]; apply?: boolean; forwardOnly?: boolean; refresh?: boolean; recordSlots?: boolean },
): Promise<SyncResult> {
  const apply = o.apply !== false;
  const source = [...new Set(o.sources)].join("+");
  const nothing = (reason: string): SyncResult => {
    const r: SyncResult = {
      leadId, source, action: "stay", from: null, to: null, direction: null, reason, slot: null, newestAt: null,
      echoOnly: false, counts: { fresh: 0, inbound: 0, phone: 0, ours: 0 }, moved: false, applied: "nothing",
    };
    logDecision(r);
    return r;
  };

  const [row] = await db
    .select({
      pipeline: leadsSyncTable.pipeline,
      leadStage: leadsSyncTable.leadStage,
      responsibleUser: leadsSyncTable.responsibleUser,
      botExcluded: leadsSyncTable.botExcluded,
      viewingAt: leadsSyncTable.viewingAt,
      stageCheckedAt: leadsSyncTable.stageCheckedAt,
    })
    .from(leadsSyncTable)
    .where(eq(leadsSyncTable.leadId, leadId))
    .limit(1);
  if (!row) return nothing("no leads_sync row");
  if (row.botExcluded) return nothing("excluded from the bot");
  if (isListingAcquisition(row.pipeline)) return nothing("listing funnel — the stage engine owns its stages");
  if (!isConversationalPipeline(row.pipeline)) return nothing(`funnel "${row.pipeline}" is not worked by the bot`);

  if (o.refresh !== false) {
    await refreshLeadMessages(leadId).catch((err) => logger.warn({ err, leadId }, "stage-sync: timeline refresh failed — judging what is stored"));
  }
  const amo = await getAmoLead(leadId).catch(() => null);
  if (!amo?.status_id || !amo.pipeline_id) return nothing("amoCRM did not return the card — nothing decided");
  const where = await amoStageFor(amo.pipeline_id, amo.status_id);
  if (!where) return nothing(`amoCRM status ${amo.status_id} is not in the funnel map`);

  const asOf = new Date();
  const [messages, sentRows, slotRows] = await Promise.all([
    loadThread(leadId, asOf),
    db.select({ createdAt: sentMessagesTable.createdAt }).from(sentMessagesTable).where(eq(sentMessagesTable.leadId, leadId)),
    db.select({ viewingAt: viewingSlotsTable.viewingAt, status: viewingSlotsTable.status, propertyCode: viewingSlotsTable.propertyCode })
      .from(viewingSlotsTable).where(eq(viewingSlotsTable.leadId, leadId)),
  ]);
  const decision = await decideStage({
    leadId,
    pipeline: where.pipeline,
    stage: where.stage,
    statusId: amo.status_id,
    funnel: where.all,
    storedViewingAt: row.viewingAt,
    slots: slotRows,
    messages,
    sentAt: sentRows.map((r) => r.createdAt),
    checkedAt: row.stageCheckedAt,
    asOf,
    sources: o.sources,
  });

  let moved = false;
  let applied = apply ? "nothing to apply" : "dry run";
  if (apply) {
    if (decision.action === "close-undeliverable") {
      moved = await closeUndeliverable(leadId);
      applied = moved ? "closed as unreachable" : "amoCRM refused the close";
    } else if (decision.action === "move" && decision.to) {
      if (o.forwardOnly && decision.direction !== "forward") {
        applied = `not applied: forward-only run (${decision.direction})`;
      } else {
        const { id } = await safeStageIdForLead({ pipelineId: amo.pipeline_id, stageId: null, stageName: decision.to });
        if (!id) {
          applied = `"${decision.to}" is not in the card's funnel`;
        } else if (await updateLeadStatus(leadId, Number(id))) {
          moved = true;
          applied = "moved";
          // Written only after amoCRM accepted the status: a stage name amoCRM
          // never received is how stage_events and the board disagreed (12.09).
          await db
            .update(leadsSyncTable)
            .set({
              leadStage: decision.to,
              leadStageId: id,
              ...(decision.viewingAt !== undefined ? { viewingAt: decision.viewingAt } : {}),
              updatedAt: new Date(),
            })
            .where(eq(leadsSyncTable.leadId, leadId));
          await db
            .insert(stageEventsTable)
            .values({ leadId, fromStage: where.stage, toStage: decision.to, pipeline: where.pipeline, responsibleUser: row.responsibleUser })
            .catch(() => undefined);
        } else {
          applied = "amoCRM refused the status change";
        }
      }
    } else if (decision.viewingAt !== undefined) {
      await db.update(leadsSyncTable).set({ viewingAt: decision.viewingAt, updatedAt: new Date() }).where(eq(leadsSyncTable.leadId, leadId));
      applied = "slot updated";
    }
    if (decision.slot && o.recordSlots !== false) {
      await recordViewingSlot(leadId, decision.slot, source).catch((err) => logger.warn({ err, leadId }, "stage-sync: slot not recorded"));
    }
    if (moved && decision.cancelSlotsAfter) {
      await db
        .update(viewingSlotsTable)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(and(eq(viewingSlotsTable.leadId, leadId), eq(viewingSlotsTable.status, "scheduled"), gte(viewingSlotsTable.viewingAt, decision.cancelSlotsAfter)));
    }
    // leads_sync mirrors amoCRM: a name that drifted is corrected from the card itself.
    if (!moved && decision.action !== "close-undeliverable" && norm(row.leadStage) !== norm(where.stage) && !CLOSED_STATUS_IDS.has(amo.status_id)) {
      await db.update(leadsSyncTable).set({ leadStage: where.stage, leadStageId: String(amo.status_id) }).where(eq(leadsSyncTable.leadId, leadId));
    }
    if (decision.newestAt && !o.sources.includes("backfill")) {
      await db
        .update(leadsSyncTable)
        .set({ stageCheckedAt: decision.newestAt })
        .where(and(eq(leadsSyncTable.leadId, leadId), sql`(${leadsSyncTable.stageCheckedAt} IS NULL OR ${leadsSyncTable.stageCheckedAt} < ${decision.newestAt})`));
      lastChecked.set(leadId, decision.newestAt.getTime());
    }
  }
  const result: SyncResult = { ...decision, leadId, source, moved, applied };
  logDecision(result);
  return result;
}

// ── The entry point every path calls ─────────────────────────────────────────

const pending = new Map<string, { timer: NodeJS.Timeout; firstAt: number; sources: Set<ThreadSource> }>();
const running = new Set<string>();
const lastChecked = new Map<string, number>();

/**
 * A message was added to this lead's thread — by the client, by approve, by an
 * automatic send, or by the broker's own phone. Debounced per lead, so a text
 * and its links, or a burst of phone messages, are judged once, together.
 * `messageAt` lets a detector that re-reports old events (a 30-minute feed)
 * skip what this process already judged.
 */
export function onThreadChanged(leadId: string, o: { source: ThreadSource; messageAt?: Date | null; delayMs?: number }): void {
  if (!leadId) return;
  if (o.messageAt && (lastChecked.get(leadId) ?? 0) >= o.messageAt.getTime()) return;
  const now = Date.now();
  const cur = pending.get(leadId);
  const sources = cur?.sources ?? new Set<ThreadSource>();
  sources.add(o.source);
  if (cur) {
    // A chat that never pauses: the run already due will read it all.
    if (now - cur.firstAt >= MAX_WAIT_MS) return;
    clearTimeout(cur.timer);
  }
  const firstAt = cur?.firstAt ?? now;
  const delay = Math.max(0, Math.min(o.delayMs ?? DEBOUNCE_MS, firstAt + MAX_WAIT_MS - now));
  const timer = setTimeout(() => {
    pending.delete(leadId);
    void runOnce(leadId, [...sources]);
  }, delay);
  pending.set(leadId, { timer, firstAt, sources });
}

async function runOnce(leadId: string, sources: ThreadSource[]): Promise<void> {
  if (running.has(leadId)) {
    for (const s of sources) onThreadChanged(leadId, { source: s, delayMs: 30_000 });
    return;
  }
  running.add(leadId);
  try {
    await syncStageFromThread(leadId, { sources });
  } catch (err) {
    logger.error({ err, leadId, sources }, "stage-sync: run failed");
  } finally {
    running.delete(leadId);
  }
}
