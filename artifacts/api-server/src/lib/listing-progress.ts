/**
 * Rental Listings after qualification: the ONE owner of two moves (owner, 14.09.2026).
 *
 *   QUALIFIED (Pre-listed) → Details asked      our side asked the villa side for anything that
 *                                               completes the listing (photos, video, sizes,
 *                                               documents / agreement, availability, pin, a visit)
 *   QUALIFIED / Details asked → Inspection      a visit to the villa by our side was AGREED for a
 *   scheduled                                   concrete day — whatever it is called (inspection,
 *                                               survey, kunjungan, "jam 12 saya datang", a viewing
 *                                               with a client at the villa). Scheduled is enough;
 *                                               nobody has to prove it happened.
 *   → live                                      only the site's Pre-listed → Listed switch
 *                                               (listing-status-pass.ts), not this file.
 *
 * The owner's model: two metrics, Pre-listed and live; Yudi's job is to take qualified cards to
 * live, inspections happen offline, and what the thread shows is enough.
 *
 * Stages are ids, never names: the owner renamed 87763166 "Details" → "Details ased" and 87763170
 * "Inspection. done" → "Inspection sceduled" on 14.09, and the one before that ("agreement" →
 * "Inspection. done", 09.09) had already broken string-matched code once.
 *
 * Called from `syncStageFromThread` (every path that sees a new message on a listing card:
 * approve / autopilot sends, the timeline sweep, amo-sync's outgoing feed, incoming detection,
 * the webhook) and once a day from the listing audit. Forward only; a card a person moved back
 * is not moved forward again on evidence older than that move; nothing past Inspection scheduled,
 * nothing parked, closed or live is touched.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";
import { amoFetch, amoPost, getAmoLead, updateLeadStatus } from "./amo-client";
import { chatCompletionJSON, HELPER_MODEL } from "./ai-client";
import { isUndeliverableNotice } from "./undeliverable";
import { amoStageFor } from "./stage-classifier";
import { LISTINGS_PIPELINE_ID, LISTING_STAGE, LISTING_STAGE_NAME } from "./listing-status-week";

const BALI = "Asia/Makassar";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Two status changes this far apart, so amoCRM's event log shows the path. */
const STEP_GAP_MS = 4000;
/** The qualifying reply and the move to QUALIFIED land in the same minute; the ask in it counts. */
const WINDOW_SLACK_MS = 5 * MIN;
/**
 * Before this moment QUALIFIED was set by a loose classifier (and flapped), so an arrival then is
 * not qualification. The stage engine became the only mover on 07.09.2026 (CLAUDE.md, "Listing
 * funnel: one owner per stage"). The window starts at the first arrival after it, else the latest.
 */
const ENGINE_ERA = Date.parse("2026-09-07T12:00:00+08:00");

/** The funnel after qualification, in order. A move from a later one into an earlier one is backward. */
const ORDER: number[] = [
  LISTING_STAGE.QUALIFIED,
  LISTING_STAGE.DETAILS_ASKED,
  LISTING_STAGE.INSPECTION_SCHEDULED,
  LISTING_STAGE.LIVE,
  LISTING_STAGE.WEEKLY_CHECK_SENT,
  LISTING_STAGE.AVAILABILITY_RECEIVED,
];
const rank = (id: number | null | undefined) => (id == null ? -1 : ORDER.indexOf(id));

export type ThreadMsg = { senderType: string; text: string | null; sentAt: Date };
export type DetailsAsk = { at: Date; quote: string; how: "rule" | "model" };
export type Visit = { visitAt: Date; timeKnown: boolean; agreedAt: Date | null; quote: string; why: string };

export type ProgressDecision = {
  leadId: string;
  source: string;
  statusId: number | null;
  from: string | null;
  /** The ids the card would pass through, in order; empty = stays. */
  path: number[];
  to: string | null;
  reason: string;
  windowStart: Date | null;
  detailsAsk: DetailsAsk | null;
  visit: Visit | null;
  moved: boolean;
  applied: string;
};

function fmt(d: Date): string {
  return d.toLocaleString("en-GB", { timeZone: BALI, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function stageLabel(id: number | null | undefined, all?: Array<{ id: number; name: string }>): string {
  if (id == null) return "unknown";
  return all?.find((s) => s.id === id)?.name ?? LISTING_STAGE_NAME[id] ?? `stage ${id}`;
}

// ── Reading the thread ─────────────────────────────────────────────────────────

/**
 * Our message without the owner's words it quotes. A WhatsApp reply is stored as
 * `>> quote⏎reply`; an owner's "photos are in the drive" quoted under Yudi's "thanks" must not read
 * as Yudi asking for photos.
 */
export function ownWords(m: ThreadMsg, earlier: ThreadMsg[]): string {
  let t = m.text ?? "";
  if (!t.trimStart().startsWith(">>")) return t;
  for (const p of earlier) {
    const q = (p.text ?? "").trim();
    if (q.length >= 8 && t.includes(q)) t = t.replace(q, " ");
  }
  return t.replace(/^\s*>>\s*/, "").replace(/Комментарий к (видео|изображению)/g, " ");
}

/** Things that complete a listing, asked in the same sentence as a request. */
const STRONG_ITEM =
  /\b(photos?|photoshoot|pictures?|pics|foto\w*|gambar|videos?|room ?tour|walk ?through|watermark|sizes?|sqm|m2|m²|luas|land size|building size|dokumen\w*|documents?|docs|perjanjian|agreement|kontrak|contract|sertifikat|certificates?|pin|lokasi\w*|location|google maps|maps link|alamat|address|inspect\w*|inspeksi\w*|survey|survei|visit\w*|kunjung\w*|berkunjung|datang|come (by|and|to|over)|floor ?plan|denah|double check|periksa)\b/i;
/** Weak items: asked after qualification they usually complete a listing, but a model confirms. */
const WEAK_ITEM = /\b(availab\w*|tanggal|dates?|details?|detailnya|spesifikasi|specifications?)\b/i;
const MONEY = /\b(harga|price|pricing|rate|rates|komisi|commission|juta|jt|million|mio|idr|usd|rp)\b/i;
const ASK_CUE =
  /\?|\b(could|can|would|will) you\b|\b(please|pls|kindly|mohon|boleh|bisa|minta|tolong|kirim\w*|share|send|apakah|dibantu|sekalian|let me know|any chance|is it possible)\b/i;

function sentences(t: string): string[] {
  return t.split(/(?<=[.!?\n])\s+/).map((s) => s.trim()).filter(Boolean);
}

async function modelConfirmsAsk(ours: string, before: string): Promise<boolean> {
  const out = await chatCompletionJSON<{ asks: boolean; why: string }>({
    model: HELPER_MODEL,
    label: "listing:details-ask-check",
    max_tokens: 100,
    temperature: 0,
    system: `We list villas for rent. Below is OUR latest message to a villa owner's side, after the lines before it. Answer ONE question: does OUR message ASK the villa side for something that completes the villa's listing — photos, a video, sizes, documents or the listing agreement, availability dates, the location pin, a visit or inspection of the villa, or checking the listing details?

true only when our message requests or asks for one of those.
false for: thanks or confirmations of what they sent, promises ("I'll get back to you"), questions about who they are, about our client, and the qualification questions — price, commission, minimum stay, when the villa is free, the earliest day a CLIENT could view it — and anything you are unsure about.

JSON only: {"asks": true|false, "why": "<8 words>"}`,
    messages: [{ role: "user", content: `${before.slice(-1500)}\n\nOUR MESSAGE:\n${ours.slice(-1200)}` }],
  }).catch(() => null);
  return !!out && out.asks === true;
}

/** The first message of ours at or after `since` that asks for listing details. */
export async function findDetailsAsk(messages: ThreadMsg[], since: Date): Promise<DetailsAsk | null> {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.senderType === "lead" || m.sentAt.getTime() < since.getTime() || !(m.text ?? "").trim()) continue;
    if (isUndeliverableNotice(m.text)) continue;
    const words = ownWords(m, messages.slice(Math.max(0, i - 12), i));
    // "Could you share the monthly rate for the client who will visit on the 9th?" names a visit but
    // asks a price: a sentence about money is never decided by the rule (replay 14.09, Uma Avaya).
    const strong = sentences(words).find((s) => STRONG_ITEM.test(s) && ASK_CUE.test(s) && !MONEY.test(s));
    if (strong) return { at: m.sentAt, quote: strong.slice(0, 160), how: "rule" };
    const weak = sentences(words).find((s) => (WEAK_ITEM.test(s) || STRONG_ITEM.test(s)) && ASK_CUE.test(s));
    if (weak) {
      const before = messages
        .slice(Math.max(0, i - 3), i)
        .map((p) => `${p.senderType === "lead" ? "Villa side" : "Us"}: ${(p.text ?? "").slice(-500)}`)
        .join("\n");
      if (await modelConfirmsAsk(words, before)) return { at: m.sentAt, quote: weak.slice(0, 160), how: "model" };
    }
  }
  return null;
}

/** Worth asking the model about a visit only when the thread talks about one or about time. */
const VISIT_CUE =
  /\b(inspect\w*|inspeksi\w*|survey|survei|visit\w*|kunjung\w*|datang|come (by|over|and|to)|viewing|view it|lihat|ketemu|meet|photoshoot|ambil (foto|photo|video)|video tour|besok|tomorrow|today|hari ini|jam \d{1,2}|o'?clock|\d{1,2}\s*(am|pm)|morning|afternoon|pagi|siang|sore)\b|\b\d{1,2}[:.]\d{2}\b/i;

function transcript(messages: ThreadMsg[], n: number): string {
  const rows = messages.filter((m) => (m.text ?? "").trim() && !isUndeliverableNotice(m.text)).slice(-n);
  return rows
    .map((m, i) => {
      // Keep the TAIL of a long message: a WhatsApp reply sits after the quote (CLAUDE.md, 11.09).
      let t = (m.senderType === "lead" ? m.text ?? "" : ownWords(m, rows.slice(Math.max(0, i - 12), i))).replace(/\s+/g, " ").trim();
      if (t.length > 700) t = "…" + t.slice(-700);
      return `${fmt(m.sentAt)} ${m.senderType === "lead" ? "Villa side" : "Us"}: ${t}`;
    })
    .join("\n");
}

function parseIso(v: unknown): Date | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const wordsOf = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);

/** The most recent visit to the villa by our side that both sides agreed for a concrete day. */
export async function extractAgreedVisit(messages: ThreadMsg[], asOf: Date): Promise<Visit | null> {
  const text = transcript(messages, 50);
  if (!text) return null;
  const out = await chatCompletionJSON<{ visit_at: string | null; time_known: boolean; agreed_at: string | null; quote: string | null; why: string | null }>({
    model: HELPER_MODEL,
    label: "listing:agreed-visit",
    max_tokens: 220,
    temperature: 0,
    system: `Now is ${fmt(asOf)} (day/month, Bali time, year ${asOf.getFullYear()}). Each line starts with the day/month and time it was written, Bali time. "Us" is our real-estate agency (our agent Yudi, our colleague Amelia, or our bot); "Villa side" is the owner, their staff or manager.

Find the MOST RECENT visit to the villa by our side that BOTH sides AGREED for a concrete calendar day. Whatever it is called counts: inspection / inspeksi, survey, visit / kunjungan, "datang", "come by", a photo or video shoot at the villa, a viewing with our client at the villa.
AGREED means one side named a specific day (maybe a time) and the other accepted it ("ok", "boleh", "bisa", "betul", "aman", "see you", "well noted", "we'll wait for you"), or the villa side is expecting us on that day ("is the visit still on today?").
NOT agreed: an open offer ("you can come any time", "visit possible from 13 Sept", "tell us one day before"), a request nobody answered, a range ("around the 21st", "next week"), a day the villa side declined or replaced, a visit postponed without a new day. If the agreed visit was later cancelled, answer null.

- visit_at: that visit as ISO datetime +08:00. Use the stated time; "after 2pm" → 14:00, "before 11" → 10:00, "morning"/"pagi" → 10:00, "afternoon"/"siang" → 13:00, no time → 12:00. null if no agreed visit.
- time_known: true only when a clock time or a clear part of day was agreed.
- agreed_at: when it was settled — the date and time of the line that settled it, ISO +08:00.
- quote: the words of that settling line (or the proposal it accepted), copied verbatim, at most 20 words.
- why: at most 10 words.
Relative words ("tomorrow", "besok", "Monday") are relative to the line they appear in.
JSON only: {"visit_at": "2026-09-14T11:00:00+08:00" | null, "time_known": true|false, "agreed_at": "2026-09-13T12:05:00+08:00" | null, "quote": "..." | null, "why": "..." | null}`,
    messages: [{ role: "user", content: text.slice(-9000) }],
  }).catch(() => null);
  const at = parseIso(out?.visit_at);
  if (!at) return null;
  let agreed = parseIso(out?.agreed_at);
  if (agreed && agreed.getTime() > asOf.getTime() + MIN) agreed = null;
  if (at.getTime() > (agreed ?? asOf).getTime() + 60 * DAY) return null;
  if (agreed && at.getTime() < agreed.getTime() - 12 * HOUR) return null;
  // The quote has to be in the thread: an invented "yes see you tomorrow" moves nothing.
  const quote = String(out?.quote ?? "").trim();
  const qw = wordsOf(quote);
  const hay = new Set(wordsOf(text));
  if (qw.length === 0 || qw.filter((w) => hay.has(w)).length / qw.length < 0.6) {
    logger.info({ quote, visitAt: at }, "listing-progress: visit quote not found in the thread — ignored");
    return null;
  }
  return { visitAt: at, timeKnown: out?.time_known === true, agreedAt: agreed, quote: quote.slice(0, 200), why: String(out?.why ?? "").slice(0, 120) };
}

/**
 * One question about one reading: did both sides really settle that WE come to the villa that day?
 * The extraction is one field among five in a broad prompt; a move rests on this answer. Fail-closed.
 */
export async function confirmAgreedVisit(messages: ThreadMsg[], v: Visit): Promise<boolean> {
  const day = v.visitAt.toLocaleString("en-GB", { timeZone: BALI, weekday: "long", day: "numeric", month: "long" });
  const out = await chatCompletionJSON<{ agreed: boolean; why: string }>({
    model: HELPER_MODEL,
    label: "listing:visit-confirm",
    max_tokens: 100,
    temperature: 0,
    system: `Lines start with day/month and Bali time. "Us" is our agency (agent Yudi, colleague Amelia, our bot); "Villa side" is the owner, staff or manager. Answer ONE question: is it SETTLED between both sides that someone from OUR side (alone or with a client) comes to the villa on ${day}?

true ONLY when one side named that specific day and the other side accepted it ("ok", "boleh", "bisa", "betul", "aman", "see you", "well noted"), or the villa side is clearly expecting us that day, and nothing later cancelled or moved it.

false for:
- an open offer or availability ("you can come to check before the 13th", "visit on 15 September is possible", "tomorrow can be checked") that our side never took up with a day of its own
- the villa side's OWN plans (their photoshoot, their guests)
- a range or a vague time ("around the 21st", "next week", "later")
- our request that the villa side did not accept, or answered with another question
- anything you are unsure about

JSON only: {"agreed": true|false, "why": "<10 words>"}`,
    messages: [{ role: "user", content: `${transcript(messages, 50).slice(-9000)}\n\nReading to check: a visit on ${day}, settled by "${v.quote}"` }],
  }).catch(() => null);
  return !!out && out.agreed === true;
}

// ── amoCRM history of the card ─────────────────────────────────────────────────

type StatusEvent = { at: number; from: number | null; to: number | null; by: number | null };

async function statusEvents(leadId: string): Promise<StatusEvent[] | null> {
  const out: StatusEvent[] = [];
  for (let page = 1; page <= 5; page++) {
    const d = await amoFetch<{
      _embedded?: {
        events?: Array<{
          created_at: number;
          created_by?: number;
          value_before?: Array<{ lead_status?: { id?: number } }>;
          value_after?: Array<{ lead_status?: { id?: number } }>;
        }>;
      };
    }>(`/api/v4/events?filter[entity]=lead&filter[entity_id][]=${leadId}&filter[type]=lead_status_changed&limit=100&page=${page}`);
    if (!d && page === 1) return null;
    const ev = d?._embedded?.events ?? [];
    for (const e of ev) {
      out.push({
        at: e.created_at * 1000,
        from: e.value_before?.[0]?.lead_status?.id ?? null,
        to: e.value_after?.[0]?.lead_status?.id ?? null,
        by: e.created_by ?? null,
      });
    }
    if (ev.length < 100) break;
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Where "since qualification" starts for this card. */
export function qualificationStart(events: StatusEvent[]): Date | null {
  const arrivals = events.filter((e) => e.to === LISTING_STAGE.QUALIFIED).map((e) => e.at);
  const engineEra = arrivals.find((t) => t >= ENGINE_ERA);
  const at = engineEra ?? arrivals[arrivals.length - 1];
  if (at != null) return new Date(at);
  // Moved straight past QUALIFIED by a person: from its first arrival anywhere after it.
  const later = events.find((e) => rank(e.to) > 0);
  return later ? new Date(later.at) : null;
}

/** The latest move INTO the current stage from a later one — a person's step back. */
function lastStepBack(events: StatusEvent[], current: number): Date | null {
  const back = events.filter((e) => e.to === current && rank(e.from) > rank(current));
  return back.length ? new Date(back[back.length - 1]!.at) : null;
}

async function loadMessages(leadId: string): Promise<ThreadMsg[]> {
  const res = await db.execute(sql`
    SELECT sender_type, text, sent_at FROM lead_messages
     WHERE lead_id = ${leadId} AND text IS NOT NULL
     ORDER BY sent_at DESC LIMIT 300
  `);
  return ((res.rows ?? []) as Array<{ sender_type: string; text: string | null; sent_at: string | Date }>)
    .map((r) => ({ senderType: r.sender_type, text: r.text, sentAt: new Date(r.sent_at) }))
    .reverse();
}

// ── Decide and apply ───────────────────────────────────────────────────────────

export type ProgressOpts = {
  source: string;
  apply?: boolean;
  /** Judge the whole window even when nothing new arrived (audit, backfill). */
  full?: boolean;
  /** Messages newer than this are "new" (live runs). */
  checkedAt?: Date | null;
  /** Report a scheduled visit on a TAKEN TO WORK card (never moved). */
  reportTaken?: boolean;
};

const inFlight = new Map<string, Promise<ProgressDecision>>();

/** Serialised per card: the send path and the timeline sweep can both arrive for one message. */
export async function advanceListingProgress(leadId: string, o: ProgressOpts): Promise<ProgressDecision> {
  const prev = inFlight.get(leadId);
  const run = (prev ? prev.catch(() => undefined) : Promise.resolve(undefined)).then(() => progressOnce(leadId, o));
  inFlight.set(leadId, run);
  try {
    return await run;
  } finally {
    if (inFlight.get(leadId) === run) inFlight.delete(leadId);
  }
}

async function progressOnce(leadId: string, o: ProgressOpts): Promise<ProgressDecision> {
  const apply = o.apply !== false;
  const base: ProgressDecision = {
    leadId, source: o.source, statusId: null, from: null, path: [], to: null, reason: "", windowStart: null,
    detailsAsk: null, visit: null, moved: false, applied: apply ? "nothing to apply" : "dry run",
  };
  const done = (d: Partial<ProgressDecision>): ProgressDecision => {
    const r = { ...base, ...d };
    logger.info(
      {
        leadId, source: o.source, from: r.from, to: r.to, path: r.path, moved: r.moved, applied: r.applied, reason: r.reason,
        detailsAsk: r.detailsAsk ? { at: r.detailsAsk.at, how: r.detailsAsk.how } : null,
        visit: r.visit ? { at: r.visit.visitAt, agreedAt: r.visit.agreedAt } : null,
      },
      "listing-progress decision",
    );
    return r;
  };

  const lead = await getAmoLead(leadId).catch(() => null);
  if (!lead?.status_id) return done({ reason: "amoCRM did not return the card — nothing decided", applied: "nothing" });
  const statusId = lead.status_id;
  const where = await amoStageFor(lead.pipeline_id, statusId).catch(() => null);
  const from = where?.stage ?? stageLabel(statusId);
  Object.assign(base, { statusId, from });
  if (lead.pipeline_id !== LISTINGS_PIPELINE_ID) return done({ reason: "not a Rental Listings card" });
  const taken = statusId === LISTING_STAGE.TAKEN_TO_WORK;
  if (statusId !== LISTING_STAGE.QUALIFIED && statusId !== LISTING_STAGE.DETAILS_ASKED && !(taken && o.reportTaken)) {
    return done({ reason: `"${from}" is not QUALIFIED or Details asked — nothing here moves it` });
  }

  const messages = await loadMessages(leadId);
  if (messages.length === 0) return done({ reason: "no messages in the thread" });
  const fresh = o.full || !o.checkedAt ? messages : messages.filter((m) => m.sentAt.getTime() > o.checkedAt!.getTime());
  if (fresh.length === 0) return done({ reason: "nothing new in the thread since the last check" });

  const events = taken ? [] : await statusEvents(leadId);
  if (!taken && !events) return done({ reason: "amoCRM events could not be read — nothing decided", applied: "nothing" });
  const qualAt = taken ? null : qualificationStart(events!);
  const windowStart = taken
    ? new Date(Date.now() - 21 * DAY)
    : qualAt
      ? new Date(qualAt.getTime() - WINDOW_SLACK_MS)
      : new Date(Date.now() - DAY);
  base.windowStart = windowStart;
  const stepBack = taken ? null : lastStepBack(events!, statusId);

  // Visit first: it is the further stage.
  let visit: Visit | null = null;
  const cueWindow = messages.filter((m) => m.sentAt.getTime() >= windowStart.getTime() - 7 * DAY);
  const freshCue = fresh.some((m) => VISIT_CUE.test(m.text ?? "")) || (o.full && cueWindow.some((m) => VISIT_CUE.test(m.text ?? "")));
  if (freshCue) {
    const thread = cueWindow.length ? cueWindow : messages;
    const v = await extractAgreedVisit(thread, new Date());
    // Guards from the dry replay of 14.09 (13 visits read, 6 wrong):
    // - a visit held before this card qualified was a different chapter (Namaste: a client viewing
    //   two hours before qualification);
    // - an offer nobody accepted has no settling line (Mimoza: "earliest Sunday October 13 at 2");
    // - a day settled long before qualification is the viewability answer, not a planned visit
    //   (Adels: "Bsk bisa di cek" to "the earliest day a client could view");
    // - and a separate yes/no on the one reading, fail-closed, for open offers, the owner's own
    //   photoshoot and "around the 21st" (Yoshi, Aquamarine, Elara, Forest Bloom, Umbala).
    if (!v) {
      // nothing agreed
    } else if (v.visitAt.getTime() < windowStart.getTime()) {
      logger.info({ leadId, visitAt: v.visitAt, windowStart }, "listing-progress: agreed visit predates qualification — ignored");
    } else if (!v.agreedAt || v.agreedAt.getTime() < windowStart.getTime() - DAY) {
      logger.info({ leadId, visitAt: v.visitAt, agreedAt: v.agreedAt, windowStart }, "listing-progress: no settling line after qualification — ignored");
    } else if (!(await confirmAgreedVisit(thread, v))) {
      logger.info({ leadId, visitAt: v.visitAt, quote: v.quote }, "listing-progress: second opinion says the visit is not agreed — ignored");
    } else {
      visit = v;
    }
  }
  base.visit = visit;

  if (taken) {
    return done({
      reason: visit ? `TAKEN TO WORK with a visit agreed for ${fmt(visit.visitAt)} — reported, never moved` : "TAKEN TO WORK, no agreed visit",
      applied: "report only",
    });
  }

  let detailsAsk: DetailsAsk | null = null;
  if (statusId === LISTING_STAGE.QUALIFIED) detailsAsk = await findDetailsAsk(messages, windowStart);
  base.detailsAsk = detailsAsk;

  const after = (d: Date | null) => !stepBack || (!!d && d.getTime() > stepBack.getTime());
  let path: number[] = [];
  let reason = "";
  if (visit && after(visit.agreedAt ?? visit.visitAt)) {
    path = statusId === LISTING_STAGE.QUALIFIED && detailsAsk
      ? [LISTING_STAGE.DETAILS_ASKED, LISTING_STAGE.INSPECTION_SCHEDULED]
      : [LISTING_STAGE.INSPECTION_SCHEDULED];
    reason = `visit agreed for ${fmt(visit.visitAt)}${visit.agreedAt ? ` (settled ${fmt(visit.agreedAt)})` : ""}: "${visit.quote}"`;
  } else if (statusId === LISTING_STAGE.QUALIFIED && detailsAsk && after(detailsAsk.at)) {
    path = [LISTING_STAGE.DETAILS_ASKED];
    reason = `details asked ${fmt(detailsAsk.at)} (${detailsAsk.how}): "${detailsAsk.quote}"`;
  } else if (visit || detailsAsk) {
    reason = `evidence predates a person's step back to "${from}" on ${stepBack ? fmt(stepBack) : "?"} — a person's pick wins`;
  } else {
    reason = statusId === LISTING_STAGE.QUALIFIED
      ? `no ask for details from us since qualification (${qualAt ? fmt(qualAt) : "unknown"}) and no agreed visit`
      : "no agreed visit";
  }
  if (path.length === 0) return done({ reason });
  const to = stageLabel(path[path.length - 1], where?.all);
  if (!apply) return done({ path, to, reason });

  const moved = await applyForwardPath(leadId, statusId, path, {
    source: o.source,
    all: where?.all,
    detailsAsk: path.includes(LISTING_STAGE.DETAILS_ASKED) ? detailsAsk : null,
    visit: path.includes(LISTING_STAGE.INSPECTION_SCHEDULED) ? visit : null,
  });
  return done({ path, to, reason, moved: moved.ok, applied: moved.detail });
}

/**
 * Walk the card forward through `path` (ids), writing each status to amoCRM first and to our tables
 * only after amoCRM accepted it, plus one note carrying the evidence. Shared by the live rule and the
 * admin endpoint's hand-checked moves.
 */
export async function applyForwardPath(
  leadId: string,
  current: number,
  path: number[],
  o: { source: string; all?: Array<{ id: number; name: string }>; detailsAsk?: DetailsAsk | null; visit?: Visit | null; evidenceNote?: string },
): Promise<{ ok: boolean; detail: string }> {
  let from = current;
  // stage_events carry the card's broker, as Rental's thread sync does: the daily report counts a
  // broker's moves by `responsible_user = <broker>`, and Yudi's Inspection-scheduled arrivals are his
  // metric whoever typed the message. The mechanism is in the log line and the card's note.
  const owner = await db
    .execute(sql`SELECT responsible_user FROM leads_sync WHERE lead_id = ${leadId} LIMIT 1`)
    .then((r) => ((r.rows?.[0] as { responsible_user?: string | null } | undefined)?.responsible_user ?? "").trim())
    .catch(() => "");
  const responsible = owner || `engine:listing-progress:${o.source}`;
  for (let i = 0; i < path.length; i++) {
    const to = path[i]!;
    if (rank(to) <= rank(from)) return { ok: i > 0, detail: `refused: ${stageLabel(to, o.all)} is not ahead of ${stageLabel(from, o.all)}` };
    if (i > 0) await new Promise((r) => setTimeout(r, STEP_GAP_MS));
    if (!(await updateLeadStatus(leadId, to))) {
      return { ok: i > 0, detail: `amoCRM refused ${stageLabel(to, o.all)}${i > 0 ? ` (reached ${stageLabel(from, o.all)})` : ""}` };
    }
    await db
      .execute(sql`INSERT INTO stage_events (lead_id, from_stage, to_stage, pipeline, responsible_user)
                   VALUES (${leadId}, ${stageLabel(from, o.all)}, ${stageLabel(to, o.all)}, 'Rental Listings', ${responsible})`)
      .catch(() => undefined);
    await db
      .execute(sql`UPDATE leads_sync SET lead_stage = ${stageLabel(to, o.all)}, lead_stage_id = ${String(to)}, updated_at = now() WHERE lead_id = ${leadId}`)
      .catch(() => undefined);
    from = to;
  }
  const lines: string[] = [];
  if (o.detailsAsk) lines.push(`Details asked — ${fmt(o.detailsAsk.at)} Bali, our message: "${o.detailsAsk.quote}"`);
  if (o.visit) {
    lines.push(
      `Inspection scheduled: ${fmt(o.visit.visitAt)} Bali${o.visit.timeKnown ? "" : " (time not fixed)"}` +
        `${o.visit.agreedAt ? `, agreed ${fmt(o.visit.agreedAt)}` : ""} — "${o.visit.quote}"`,
    );
    await db
      .execute(sql`INSERT INTO listing_inspection_slots (lead_id, visit_at, time_known, agreed_at, quote, source)
                   VALUES (${leadId}, ${o.visit.visitAt.toISOString()}, ${o.visit.timeKnown}, ${o.visit.agreedAt ? o.visit.agreedAt.toISOString() : null}, ${o.visit.quote}, ${o.source})
                   ON CONFLICT (lead_id, visit_at) DO NOTHING`)
      .catch((err) => logger.warn({ err, leadId }, "listing-progress: slot not recorded"));
  }
  if (o.evidenceNote) lines.push(o.evidenceNote);
  const text =
    `Stage moved automatically: ${path.map((id) => stageLabel(id, o.all)).join(" → ")} (owner's rules, 14.09.2026).\n` + lines.join("\n");
  const posted = await amoPost(`/api/v4/leads/${leadId}/notes`, [{ note_type: "common", params: { text } }]).catch(() => null);
  if (!posted) logger.warn({ leadId }, "listing-progress: card moved but the note was not written");
  logger.info({ leadId, path, source: o.source }, "listing-progress: card moved");
  return { ok: true, detail: `moved to ${stageLabel(from, o.all)}` };
}

/** The latest agreed visit on record for a card, for the reply generator and the metrics. */
export async function latestInspectionSlot(leadId: string): Promise<{ visitAt: Date; timeKnown: boolean } | null> {
  const res = await db
    .execute(sql`SELECT visit_at, time_known FROM listing_inspection_slots WHERE lead_id = ${leadId} ORDER BY visit_at DESC LIMIT 1`)
    .catch(() => null);
  const row = (res?.rows?.[0] ?? null) as { visit_at: string | Date; time_known: boolean } | null;
  return row ? { visitAt: new Date(row.visit_at), timeKnown: !!row.time_known } : null;
}

/** Every open card in QUALIFIED / Details asked (and, when asked, TAKEN TO WORK for the report). */
export async function auditListingProgress(o: { apply: boolean; reportTaken?: boolean; source?: string }): Promise<ProgressDecision[]> {
  const ids: string[] = [];
  const statuses = [LISTING_STAGE.QUALIFIED, LISTING_STAGE.DETAILS_ASKED, ...(o.reportTaken ? [LISTING_STAGE.TAKEN_TO_WORK] : [])];
  for (let page = 1; page <= 10; page++) {
    const q = statuses.map((s, i) => `filter[statuses][${i}][pipeline_id]=${LISTINGS_PIPELINE_ID}&filter[statuses][${i}][status_id]=${s}`).join("&");
    const d = await amoFetch<{ _embedded?: { leads?: Array<{ id: number }> } }>(`/api/v4/leads?${q}&limit=250&page=${page}`);
    const batch = d?._embedded?.leads ?? [];
    ids.push(...batch.map((l) => String(l.id)));
    if (batch.length < 250) break;
  }
  const out: ProgressDecision[] = [];
  for (const id of ids) {
    try {
      out.push(await advanceListingProgress(id, { source: o.source ?? "audit", apply: o.apply, full: true, reportTaken: o.reportTaken }));
    } catch (err) {
      logger.error({ err, leadId: id }, "listing-progress audit: card failed");
    }
  }
  return out;
}
