/**
 * Rental Listings after qualification: the ONE owner of the visit (owner, 14.09.2026).
 *
 *   QUALIFIED (Pre-listed) → Inspection scheduled   a visit to the villa by our side was AGREED for a
 *                                                   concrete day — whatever it is called (inspection,
 *                                                   survey, kunjungan, "jam 12 saya datang", a viewing
 *                                                   with a client at the villa). Scheduled is enough;
 *                                                   nobody has to prove it happened.
 *   Inspection scheduled, a new agreed time         the card's slot is replaced (old row 'rescheduled'),
 *                                                   no stage move; the calendar hook hears "changed".
 *   → live                                          only the site's Pre-listed → Listed switch
 *                                                   (listing-status-pass.ts), not this file.
 *
 * The owner's model: two metrics, Pre-listed and live; Yudi's job is to take qualified cards to
 * live, inspections happen offline, and what the thread shows is enough. The ask for the visit is
 * lib/inspection-booking.ts (drafts for Yudi); this file only reads what was agreed.
 *
 * "Details ased" (87763166) was DELETED by the owner at 15:02 on 14.09.2026, an hour after asking for
 * it. Its id stays in ORDER only so an old amoCRM event still ranks between QUALIFIED and Inspection.
 *
 * Stages are ids, never names: the owner renamed 87763170 "agreement" → "Inspection. done" (09.09) →
 * "Inspection sceduled" (14.09), and string-matched code broke both times.
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
import { diskMap } from "./disk-memo";
import { amoFetch, amoPost, getAmoLead, updateLeadStatus } from "./amo-client";
import { chatCompletionJSON, HELPER_MODEL } from "./ai-client";
import { isUndeliverableNotice } from "./undeliverable";
import { amoStageFor } from "./stage-classifier";
import { DELETED_DETAILS_STAGE_ID, LISTINGS_PIPELINE_ID, LISTING_STAGE, LISTING_STAGE_NAME } from "./listing-status-week";
import { queueInspectionCalendarSync } from "./inspection-calendar";

const BALI = "Asia/Makassar";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** The qualifying reply and the move to QUALIFIED land in the same minute; a visit settled in it counts. */
const WINDOW_SLACK_MS = 5 * MIN;
/** A new reading closer than this to the slot on record is the same visit, not a change. */
const RESCHEDULE_MIN_SHIFT_MS = 30 * MIN;
/**
 * Before this moment QUALIFIED was set by a loose classifier (and flapped), so an arrival then is
 * not qualification. The stage engine became the only mover on 07.09.2026 (CLAUDE.md, "Listing
 * funnel: one owner per stage"). The window starts at the first arrival after it, else the latest.
 */
const ENGINE_ERA = Date.parse("2026-09-07T12:00:00+08:00");

/**
 * `autopilot_skipped_reason` prefix of the booking drafts lib/inspection-booking.ts writes. Lives here
 * because the move to Inspection scheduled retires them (the time is agreed, the ask is obsolete).
 */
export const INSPECTION_ASK_VERDICT = "inspection booking ask";

/** The funnel after qualification, in order. A move from a later one into an earlier one is backward. */
const ORDER: number[] = [
  LISTING_STAGE.QUALIFIED,
  DELETED_DETAILS_STAGE_ID, // old events only
  LISTING_STAGE.INSPECTION_SCHEDULED,
  LISTING_STAGE.LIVE,
  LISTING_STAGE.WEEKLY_CHECK_SENT,
  LISTING_STAGE.AVAILABILITY_RECEIVED,
];
const rank = (id: number | null | undefined) => (id == null ? -1 : ORDER.indexOf(id));

/** Past Inspection scheduled: a visit agreed here is recorded for the calendar, the card never moves. */
/** Words that can call a visit off — only a cue for the yes/no below, never a verdict. */
const CALL_OFF_CUE =
  /\b(cancel|postpone|reschedul|another (time|day)|next time|not (tomorrow|today)|can'?t (come|make)|lain kali|batal|ga jadi|gak jadi|nggak jadi|tidak jadi|belum bisa|tidak bisa|ga bisa|gak bisa|nggak bisa|tunda|diundur|waktu lain|hari lain|jangan dulu|terganggu)\b/i;

/**
 * Is the visit on record now OFF? Asked only when a later message carries a call-off cue. Returns the
 * reason when clearly off, null otherwise (unsure, still on, or moved to a new concrete day).
 */
async function visitCalledOff(messages: ThreadMsg[], slot: { visitAt: Date; timeKnown: boolean }): Promise<string | null> {
  const day = slot.visitAt.toLocaleString("en-GB", { timeZone: BALI, weekday: "long", day: "numeric", month: "long", ...(slot.timeKnown ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}) });
  const out = await chatCompletionJSON<{ off: boolean; why: string }>({
    model: HELPER_MODEL,
    label: "listing:visit-called-off",
    max_tokens: 100,
    temperature: 0,
    system: `Lines start with the weekday, day/month and Bali time. "Us" is our agency (agent Yudi, colleague Amelia, our bot); "Villa side" is the owner, staff or manager. A visit by our side to the villa was agreed for ${day}. Answer ONE question: is that visit now OFF?

true ONLY when a message after the agreement clearly calls it off and nothing later puts it back on: our side says we cannot come then ("jam 11 saya belum bisa", "can't make it tomorrow"), or the villa side declines or asks for another time ("lain kali saja", "not tomorrow, the guests are in", "ga jadi").
false when the visit is still on, when it was moved to a NEW concrete day or time (that is a reschedule), or when you are unsure.

JSON only: {"off": true|false, "why": "<12 words>"}`,
    messages: [{ role: "user", content: transcript(messages, 50).slice(-9000) }],
  }).catch(() => null);
  return out?.off === true ? String(out.why ?? "called off in the thread").slice(0, 160) : null;
}

/** The slot stops being the plan: marked cancelled, a note on the card, the calendar removes the event. */
async function recordCalledOff(leadId: string, slot: { id: string; visitAt: Date }, why: string, source: string): Promise<string> {
  const upd = await db
    .execute(sql`UPDATE listing_inspection_slots SET status = 'cancelled', superseded_at = now() WHERE id = ${slot.id}::uuid AND status = 'scheduled' RETURNING id`)
    .catch((err) => {
      logger.warn({ err, leadId }, "listing-progress: called-off slot not updated");
      return null;
    });
  if (!upd?.rows?.length) return "the slot could not be marked cancelled";
  await amoPost(`/api/v4/leads/${leadId}/notes`, [{ note_type: "common", params: { text: `Inspection called off: ${fmt(slot.visitAt)} Bali — ${why}` } }]).catch(() => null);
  queueInspectionCalendarSync(`slot called off for ${leadId}`);
  logger.info({ leadId, visitAt: slot.visitAt, why, source }, "listing-progress: visit called off");
  return "visit called off";
}

export type ThreadMsg = { senderType: string; text: string | null; sentAt: Date };
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
  visit: Visit | null;
  /** On a card already in Inspection scheduled: the slot on record and the new agreed time. */
  rescheduled: { from: Date | null; to: Date } | null;
  moved: boolean;
  applied: string;
};

function fmt(d: Date): string {
  return d.toLocaleString("en-GB", { timeZone: BALI, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** With the weekday: "Wednesday pm" is read against the line's own day (23555645 was dated Thursday). */
function fmtDay(d: Date): string {
  return d.toLocaleString("en-GB", { timeZone: BALI, weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
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

/** Worth asking the model about a visit only when the thread talks about one or about time. */
export const VISIT_CUE =
  /\b(inspect\w*|inspeksi\w*|survey|survei|visit\w*|kunjung\w*|datang|come (by|over|and|to)|viewing|view it|lihat|ketemu|meet|photoshoot|ambil (foto|photo|video)|video tour|besok|tomorrow|today|hari ini|jam \d{1,2}|o'?clock|\d{1,2}\s*(am|pm)|morning|afternoon|pagi|siang|sore)\b|\b\d{1,2}[:.]\d{2}\b/i;

export function transcript(messages: ThreadMsg[], n: number): string {
  const rows = messages.filter((m) => (m.text ?? "").trim() && !isUndeliverableNotice(m.text)).slice(-n);
  return rows
    .map((m, i) => {
      // Keep the TAIL of a long message: a WhatsApp reply sits after the quote (CLAUDE.md, 11.09).
      let t = (m.senderType === "lead" ? m.text ?? "" : ownWords(m, rows.slice(Math.max(0, i - 12), i))).replace(/\s+/g, " ").trim();
      if (t.length > 700) t = "…" + t.slice(-700);
      return `${fmtDay(m.sentAt)} ${m.senderType === "lead" ? "Villa side" : "Us"}: ${t}`;
    })
    .join("\n");
}

function parseIso(v: unknown): Date | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const wordsOf = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);

const BALI_MS = 8 * HOUR;
const WEEKDAYS: Array<[RegExp, number]> = [
  [/\b(sunday|sun|hari minggu|minggu(?! (depan|ini|lalu|ke|kemarin)))\b/, 0],
  [/\b(monday|mon|senin)\b/, 1],
  [/\b(tuesday|tues?|selasa)\b/, 2],
  [/\b(wednesday|wed|rabu)\b/, 3],
  [/\b(thursday|thu|thurs?|kamis)\b/, 4],
  [/\b(friday|fri|jumat|jum at)\b/, 5],
  [/\b(saturday|sat|sabtu)\b/, 6],
];
const MONTHS: Record<string, number> = {
  jan: 0, january: 0, januari: 0, feb: 1, february: 1, februari: 1, mar: 2, march: 2, maret: 2, apr: 3, april: 3,
  may: 4, mei: 4, jun: 5, june: 5, juni: 5, jul: 6, july: 6, juli: 6, aug: 7, august: 7, agu: 7, agt: 7, agustus: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, okt: 9, oktober: 9, nov: 10, november: 10, dec: 11, december: 11, des: 11, desember: 11,
};

/**
 * The calendar day that `words` name, read against the Bali date of the line that says them —
 * in code, not by the model. 14.09.2026, 23555645: the owner wrote "You can visit the property on
 * wednesday pm" on Monday 14.09, the model returned Thursday 17.09, the second opinion rightly said no,
 * and a card with an agreed visit stayed in QUALIFIED. Explicit dates first ("15 September", "tgl 13",
 * "13/9", "the 16th"), then relative words (today / hari ini, tomorrow / besok, lusa), then weekdays
 * (the next one on or after the line's day; "next" / "depan" skips the same day). null when nothing
 * resolves.
 */
export function resolveDayWords(words: string, said: Date): { y: number; m: number; d: number } | null {
  const w = ` ${words.toLowerCase().replace(/[’'`]/g, " ").replace(/\s+/g, " ").trim()} `;
  const b = new Date(said.getTime() + BALI_MS);
  const y = b.getUTCFullYear();
  const m = b.getUTCMonth();
  const d = b.getUTCDate();
  const wd = b.getUTCDay();
  const at = (yy: number, mm: number, dd: number) => {
    const t = new Date(Date.UTC(yy, mm, dd));
    return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate() };
  };
  const plus = (n: number) => at(y, m, d + n);
  // A day-of-month without a month: this month, or the next when it is already well past.
  const dayOfMonth = (dd: number) => (dd < 1 || dd > 31 ? null : dd >= d - 3 ? at(y, m, dd) : at(y, m + 1, dd));
  const withMonth = (dd: number, mm: number) => (dd < 1 || dd > 31 ? null : at(mm < m - 6 ? y + 1 : y, mm, dd));
  for (const x of w.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]{3,9})\b/g)) {
    const mm = MONTHS[x[2]!];
    if (mm !== undefined) return withMonth(Number(x[1]), mm);
  }
  for (const x of w.matchAll(/\b([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\b/g)) {
    const mm = MONTHS[x[1]!];
    if (mm !== undefined) return withMonth(Number(x[2]), mm);
  }
  const slash = w.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (slash && Number(slash[2]) >= 1 && Number(slash[2]) <= 12) return withMonth(Number(slash[1]), Number(slash[2]) - 1);
  const tgl = w.match(/\b(?:tgl|tanggal|tnggl|tangal|date|the)\s*(\d{1,2})(?:st|nd|rd|th)?\b/) ?? w.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/);
  if (tgl) return dayOfMonth(Number(tgl[1]));
  if (/\b(lusa|day after tomorrow)\b/.test(w)) return plus(2);
  if (/\b(besok|bsk|besuk|tomorrow|tmr|tmrw|tomorow)\b/.test(w)) return plus(1);
  if (/\b(today|hari ini|tonight|this (morning|afternoon|evening)|pagi ini|siang ini|sore ini|malam ini|now|sekarang)\b/.test(w)) return plus(0);
  const next = /\b(next|depan)\b/.test(w);
  for (const [rx, idx] of WEEKDAYS) {
    if (!rx.test(w)) continue;
    let delta = (idx - wd + 7) % 7;
    if (delta === 0 && next) delta = 7;
    return plus(delta);
  }
  return null;
}

/** Day words that are only a time of day ("jam 1 siang ya", "at 12:00", "this afternoon"). */
const TIME_ONLY = /\bjam\s*\d{1,2}|\b\d{1,2}[:.]\d{2}\b|\b\d{1,2}\s*(am|pm)\b|\b(pagi|siang|sore|morning|afternoon|noon)\b/i;

/** The transcript with each line numbered, so the model can name a line instead of computing a date. */
function numberedTranscript(messages: ThreadMsg[], n: number): { text: string; rows: ThreadMsg[] } {
  const rows = messages.filter((m) => (m.text ?? "").trim() && !isUndeliverableNotice(m.text)).slice(-n);
  const text = rows
    .map((m, i) => {
      let t = (m.senderType === "lead" ? m.text ?? "" : ownWords(m, rows.slice(Math.max(0, i - 12), i))).replace(/\s+/g, " ").trim();
      if (t.length > 700) t = "…" + t.slice(-700);
      return `[${i}] ${fmtDay(m.sentAt)} ${m.senderType === "lead" ? "Villa side" : "Us"}: ${t}`;
    })
    .join("\n");
  return { text, rows };
}

/**
 * The most recent visit to the villa by our side that both sides agreed for a concrete day. The model
 * names the lines (which one names the day, which one settled it) and the time of day; the DATE is
 * computed here from the day words and the Bali date of their line (`resolveDayWords`).
 */
export async function extractAgreedVisit(messages: ThreadMsg[], asOf: Date): Promise<Visit | null> {
  const { text, rows } = numberedTranscript(messages, 50);
  if (!text) return null;
  const out = await chatCompletionJSON<{
    found: boolean;
    day_line: number | null;
    day_words: string | null;
    settle_line: number | null;
    time: string | null;
    time_known: boolean;
    quote: string | null;
    why: string | null;
  }>({
    model: HELPER_MODEL,
    label: "listing:agreed-visit",
    max_tokens: 220,
    temperature: 0,
    system: `Each line starts with its number in brackets, then the weekday, day/month and Bali time it was written. "Us" is our real-estate agency (our agent Yudi, our colleague Amelia, or our bot); "Villa side" is the owner, their staff or manager.

Find the MOST RECENT visit to the villa by our side that BOTH sides AGREED for a concrete calendar day. Whatever it is called counts: inspection / inspeksi, survey, visit / kunjungan, "datang", "come by", a photo or video shoot at the villa, a viewing with our client at the villa.
AGREED means one side named a specific day (maybe a time) and the other accepted it ("ok", "boleh", "bisa", "betul", "aman", "see you", "well noted", "works great", "we'll wait for you"), or the villa side is expecting us on that day ("is the visit still on today?").
NOT agreed: an open offer ("you can come any time", "visit possible from 13 Sept", "tell us one day before"), a request nobody answered, a range ("around the 21st", "next week"), a day the villa side declined or replaced, a visit postponed without a new day. If the agreed visit was later cancelled, found = false.

Do NOT work out calendar dates. Point at the lines:
- day_line: the number of the line whose words name the agreed day
- day_words: those words, copied exactly as written in that line ("wednesday", "besok", "tgl 13", "15 September", "today", "Monday", "hari ini")
- settle_line: the number of the line where the other side accepted it (or where the villa side expects us)
- time: the agreed time as 24h "HH:MM". "after 2pm" → "14:00", "before 11" → "10:00", "morning"/"pagi" → "10:00", "afternoon"/"siang"/"pm" → "13:00", "sore" → "15:00". null when no time was agreed
- time_known: true only when a clock time or a clear part of day was agreed
- quote: the words of the settling line (or the proposal it accepted), copied verbatim, at most 20 words
- why: at most 10 words
JSON only: {"found": true|false, "day_line": 7 | null, "day_words": "wednesday" | null, "settle_line": 8 | null, "time": "13:00" | null, "time_known": true|false, "quote": "..." | null, "why": "..." | null}`,
    messages: [{ role: "user", content: text.slice(-9000) }],
  }).catch(() => null);
  if (!out?.found || out.day_line == null || !out.day_words) return null;
  const dayRow = rows[Number(out.day_line)];
  if (!dayRow) return null;
  // The day words must be in the line they were taken from.
  const dw = wordsOf(out.day_words);
  const lineWords = new Set(wordsOf(dayRow.text ?? ""));
  if (dw.length > 0 && dw.filter((x) => lineWords.has(x)).length / dw.length < 0.5) {
    logger.info({ dayWords: out.day_words, line: out.day_line }, "listing-progress: day words not in their line — ignored");
    return null;
  }
  const tm = String(out.time ?? "").match(/^(\d{1,2}):(\d{2})$/);
  const hh = tm ? Math.min(23, Number(tm[1])) : 12;
  const mi = tm ? Math.min(59, Number(tm[2])) : 0;
  let day = resolveDayWords(out.day_words, dayRow.sentAt);
  if (!day && tm && TIME_ONLY.test(out.day_words)) {
    // "jam 12 saya datang ke lokasi villa ya" written at 10:01 (Ma'Wa, 11.09): a clock time and no day,
    // still ahead on the day it was written → that day. The second opinion still has to agree.
    const b = new Date(dayRow.sentAt.getTime() + BALI_MS);
    const sameDay = { y: b.getUTCFullYear(), m: b.getUTCMonth(), d: b.getUTCDate() };
    if (Date.UTC(sameDay.y, sameDay.m, sameDay.d, hh, mi) - BALI_MS > dayRow.sentAt.getTime()) day = sameDay;
  }
  if (!day) {
    logger.info({ dayWords: out.day_words, said: dayRow.sentAt }, "listing-progress: day words did not resolve to a date — ignored");
    return null;
  }
  const at = new Date(Date.UTC(day.y, day.m, day.d, hh, mi) - BALI_MS);
  const settleRow = out.settle_line != null ? rows[Number(out.settle_line)] : undefined;
  let agreed: Date | null = settleRow ? new Date(Math.max(settleRow.sentAt.getTime(), dayRow.sentAt.getTime())) : dayRow.sentAt;
  if (agreed.getTime() > asOf.getTime() + MIN) agreed = null;
  if (at.getTime() > (agreed ?? asOf).getTime() + 60 * DAY) return null;
  if (agreed && at.getTime() < agreed.getTime() - 12 * HOUR) return null;
  // The quote has to be in the thread: an invented "yes see you tomorrow" moves nothing.
  const quote = String(out.quote ?? "").trim();
  const qw = wordsOf(quote);
  const hay = new Set(wordsOf(text));
  if (qw.length === 0 || qw.filter((x) => hay.has(x)).length / qw.length < 0.6) {
    logger.info({ quote, visitAt: at }, "listing-progress: visit quote not found in the thread — ignored");
    return null;
  }
  return { visitAt: at, timeKnown: out.time_known === true && !!tm, agreedAt: agreed, quote: quote.slice(0, 200), why: String(out.why ?? "").slice(0, 120) };
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
    system: `Lines start with the weekday, day/month and Bali time. "Us" is our agency (agent Yudi, colleague Amelia, our bot); "Villa side" is the owner, staff or manager. Answer ONE question: is it SETTLED between both sides that someone from OUR side (alone or with a client) comes to the villa on ${day}?

true ONLY when one side named that specific day and the other side accepted it ("ok", "boleh", "bisa", "betul", "aman", "see you", "well noted"), or the villa side is clearly expecting us that day, and nothing later cancelled or moved it.
The villa side naming ONE specific day for us to come ("you can visit the property on Wednesday pm", "besok jam 11 bisa") and our side accepting that day ("Wednesday afternoon works great", "ok see you then", "baik kak") IS settled, whoever named it first.
Our side proposing a specific day (and maybe a time) and the villa side answering with a plain yes IS settled: "Us: besok jam 10 bisa ya kak?" → "Villa side: baik kak bisa" / "iya bisa" / "boleh" / "siap" / "aman" / "ok". So is the villa side saying that day is free and giving a time in answer to our ask ("Aman ka, tgl 13 kami masih kosong, setelah jam 2 ya"), and the villa side confirming they have us scheduled ("tanggal 7 kami jadwalkan inspeksi ya"). A short yes is enough; it does not need to repeat the day.

false for:
- an open offer or availability ("you can come to check before the 13th", "visit on 15 September is possible", "tomorrow can be checked") that our side never took up with a day of its own
- the villa side's OWN plans (their photoshoot, their guests)
- a range or a vague time ("around the 21st", "next week", "later")
- our request that the villa side did not accept, or answered with another question
- anything you are unsure about

JSON only: {"agreed": true|false, "why": "<10 words>"}`,
    messages: [{ role: "user", content: `${transcript(messages, 50).slice(-9000)}\n\nReading to check: a visit on ${day}, settled by "${v.quote}"` }],
  }).catch(() => null);
  if (!out?.agreed) logger.info({ visitAt: v.visitAt, quote: v.quote, why: out?.why ?? "no answer" }, "listing-progress: second opinion — not agreed");
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

export async function loadMessages(leadId: string): Promise<ThreadMsg[]> {
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
  /** Backfill: also record a visit whose hour passed up to this many days ago (admin ?past=N). */
  pastDays?: number;
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

type SlotRecord = { id: string; visitAt: Date; timeKnown: boolean; agreedAt: Date | null; createdAt: Date };

/** The card's current slot (not replaced by a reschedule). */
async function currentSlot(leadId: string): Promise<SlotRecord | null> {
  const res = await db
    .execute(sql`SELECT id, visit_at, time_known, agreed_at, created_at FROM listing_inspection_slots
                  WHERE lead_id = ${leadId} AND status = 'scheduled' ORDER BY visit_at DESC LIMIT 1`)
    .catch(() => null);
  const r = (res?.rows?.[0] ?? null) as { id: string; visit_at: string | Date; time_known: boolean; agreed_at: string | Date | null; created_at: string | Date } | null;
  return r
    ? { id: r.id, visitAt: new Date(r.visit_at), timeKnown: !!r.time_known, agreedAt: r.agreed_at ? new Date(r.agreed_at) : null, createdAt: new Date(r.created_at) }
    : null;
}

async function progressOnce(leadId: string, o: ProgressOpts): Promise<ProgressDecision> {
  const apply = o.apply !== false;
  const base: ProgressDecision = {
    leadId, source: o.source, statusId: null, from: null, path: [], to: null, reason: "", windowStart: null,
    visit: null, rescheduled: null, moved: false, applied: apply ? "nothing to apply" : "dry run",
  };
  const done = (d: Partial<ProgressDecision>): ProgressDecision => {
    const r = { ...base, ...d };
    logger.info(
      {
        leadId, source: o.source, from: r.from, to: r.to, path: r.path, moved: r.moved, applied: r.applied, reason: r.reason,
        visit: r.visit ? { at: r.visit.visitAt, agreedAt: r.visit.agreedAt } : null,
        rescheduled: r.rescheduled,
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
  const scheduled = statusId === LISTING_STAGE.INSPECTION_SCHEDULED;
  // Past Inspection scheduled a visit still happens (Villa Markisa, live, 15.09: "kalau jam 10 bisa?" —
  // "Besok bisa diliat" — "saya kesana besok"), and Yudi's calendar needs it. Recorded, never moved.
  // Every other open stage (Initial Contact, TAKEN TO WORK, BACKLOG, long term, co-broke…) only RECORDS an
  // agreed visit for the calendar and the inspection report — never moves. Owner, 25.09.2026: Yudi agreed
  // Ophelia (TAKEN TO WORK), Lestari and Akra (BACKLOG) in the thread and none reached the calendar.
  const closed = statusId === LISTING_STAGE.WON || statusId === LISTING_STAGE.LOST;
  if (closed) return done({ reason: `"${from}" is closed — nothing recorded` });
  const recordOnly = statusId !== LISTING_STAGE.QUALIFIED && !scheduled;

  const messages = await loadMessages(leadId);
  if (messages.length === 0) return done({ reason: "no messages in the thread" });
  const fresh = o.full || !o.checkedAt ? messages : messages.filter((m) => m.sentAt.getTime() > o.checkedAt!.getTime());
  if (fresh.length === 0) return done({ reason: "nothing new in the thread since the last check" });

  const events = recordOnly ? [] : await statusEvents(leadId);
  if (!recordOnly && !events) return done({ reason: "amoCRM events could not be read — nothing decided", applied: "nothing" });
  const qualAt = recordOnly ? null : qualificationStart(events!);
  const arrivedScheduled = scheduled
    ? events!.filter((e) => e.to === LISTING_STAGE.INSPECTION_SCHEDULED).map((e) => e.at).pop() ?? null
    : null;
  const windowStart = recordOnly
    ? new Date(Date.now() - 21 * DAY)
    : qualAt
      ? new Date(qualAt.getTime() - WINDOW_SLACK_MS)
      : new Date(Date.now() - DAY);
  base.windowStart = windowStart;
  const stepBack = recordOnly || scheduled ? null : lastStepBack(events!, statusId);
  /** Cards whose visit is only recorded (and called off), never moved: every open stage but QUALIFIED. */
  const holdsSlot = scheduled || recordOnly;
  const slot = holdsSlot ? await currentSlot(leadId) : null;

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
    } else if (holdsSlot && !isNewTime(v, slot, arrivedScheduled, o.pastDays)) {
      // the visit on record, read again — not a change
    } else if (!(await confirmAgreedVisit(thread, v))) {
      logger.info({ leadId, visitAt: v.visitAt, quote: v.quote }, "listing-progress: second opinion says the visit is not agreed — ignored");
    } else {
      visit = v;
    }
  }
  base.visit = visit;

  // A visit on record that a later message calls off stayed on the calendar as if still on (BK Villa,
  // 14.09 21:09–21:14: "jam 11 saya belum bisa… carikan waktu lain" — "Lain kali saja"). One yes/no on
  // that slot, fail-closed; a new concrete day is a reschedule and is handled above.
  if (holdsSlot && !visit && slot && slot.visitAt.getTime() > Date.now() - 2 * HOUR && fresh.some((m) => CALL_OFF_CUE.test(m.text ?? ""))) {
    const settled = (slot.agreedAt ?? slot.createdAt).getTime();
    if (messages.some((m) => m.sentAt.getTime() > settled)) {
      const off = await visitCalledOff(cueWindow.length ? cueWindow : messages, slot);
      if (off) {
        const reason = `visit ${fmt(slot.visitAt)} called off: ${off}`;
        if (!apply) return done({ reason });
        return done({ reason, applied: await recordCalledOff(leadId, slot, off, o.source) });
      }
    }
  }

  if (holdsSlot) {
    if (!visit) return done({ reason: slot ? `visit on record ${fmt(slot.visitAt)}; no new agreed time` : `"${from}", no slot on record and no agreed time read` });
    const rescheduled = { from: slot?.visitAt ?? null, to: visit.visitAt };
    const reason = slot
      ? `visit moved ${fmt(slot.visitAt)} → ${fmt(visit.visitAt)}${visit.agreedAt ? ` (settled ${fmt(visit.agreedAt)})` : ""}: "${visit.quote}"`
      : `visit agreed for ${fmt(visit.visitAt)} on a card moved here without a slot: "${visit.quote}"`;
    if (!apply) return done({ rescheduled, reason });
    const applied = await recordChangedVisit(leadId, slot, visit, o.source);
    return done({ rescheduled, reason, applied });
  }

  const after = (d: Date | null) => !stepBack || (!!d && d.getTime() > stepBack.getTime());
  let path: number[] = [];
  let reason = "";
  if (visit && after(visit.agreedAt ?? visit.visitAt)) {
    path = [LISTING_STAGE.INSPECTION_SCHEDULED];
    reason = `visit agreed for ${fmt(visit.visitAt)}${visit.agreedAt ? ` (settled ${fmt(visit.agreedAt)})` : ""}: "${visit.quote}"`;
  } else if (visit) {
    reason = `evidence predates a person's step back to "${from}" on ${stepBack ? fmt(stepBack) : "?"} — a person's pick wins`;
  } else {
    reason = `no agreed visit since qualification (${qualAt ? fmt(qualAt) : "unknown"})`;
  }
  if (path.length === 0) return done({ reason });
  const to = stageLabel(path[path.length - 1], where?.all);
  if (!apply) return done({ path, to, reason });

  const moved = await applyForwardPath(leadId, statusId, path, { source: o.source, all: where?.all, visit });
  return done({ path, to, reason, moved: moved.ok, applied: moved.detail });
}

/**
 * On a card already in Inspection scheduled, is this reading a NEW agreed time? Settled after the slot
 * on record (or after the card arrived, when it has none), and a real shift: 30 minutes or more, or a
 * clock time where the record had none.
 */
function isNewTime(v: Visit, slot: SlotRecord | null, arrivedAt: number | null, pastDays?: number): boolean {
  if (v.visitAt.getTime() < Date.now() - (pastDays ? pastDays * DAY : 12 * HOUR)) return false;
  if (!slot) return !arrivedAt || (v.agreedAt ?? v.visitAt).getTime() >= arrivedAt - WINDOW_SLACK_MS;
  const settledAfter = (v.agreedAt?.getTime() ?? 0) > (slot.agreedAt ?? slot.createdAt).getTime() + MIN;
  if (!settledAfter) return false;
  const shift = Math.abs(v.visitAt.getTime() - slot.visitAt.getTime());
  return shift >= RESCHEDULE_MIN_SHIFT_MS || (!slot.timeKnown && v.timeKnown);
}

/** The new agreed time replaces the slot on record; a note on the card; the calendar hears "changed". */
async function recordChangedVisit(leadId: string, slot: SlotRecord | null, v: Visit, source: string): Promise<string> {
  const ins = await db
    .execute(sql`INSERT INTO listing_inspection_slots (lead_id, visit_at, time_known, agreed_at, quote, source)
                 VALUES (${leadId}, ${v.visitAt.toISOString()}, ${v.timeKnown}, ${v.agreedAt ? v.agreedAt.toISOString() : null}, ${v.quote}, ${`${source}:changed`})
                 ON CONFLICT (lead_id, visit_at) DO UPDATE SET status = 'scheduled', superseded_at = NULL, time_known = EXCLUDED.time_known,
                   agreed_at = EXCLUDED.agreed_at, quote = EXCLUDED.quote, source = EXCLUDED.source, created_at = now()
                 RETURNING id`)
    .catch((err) => {
      logger.warn({ err, leadId }, "listing-progress: changed slot not recorded");
      return null;
    });
  const newId = (ins?.rows?.[0] as { id?: string } | undefined)?.id;
  if (!newId) return "the new time could not be recorded";
  if (slot && slot.id !== newId) {
    await db
      .execute(sql`UPDATE listing_inspection_slots SET status = 'rescheduled', superseded_at = now() WHERE id = ${slot.id}::uuid`)
      .catch(() => undefined);
  }
  const text = slot
    ? `Inspection rescheduled: ${fmt(slot.visitAt)} → ${fmt(v.visitAt)} Bali${v.timeKnown ? "" : " (time not fixed)"}${v.agreedAt ? `, agreed ${fmt(v.agreedAt)}` : ""} — "${v.quote}"`
    : `Inspection time recorded: ${fmt(v.visitAt)} Bali${v.timeKnown ? "" : " (time not fixed)"}${v.agreedAt ? `, agreed ${fmt(v.agreedAt)}` : ""} — "${v.quote}"`;
  await amoPost(`/api/v4/leads/${leadId}/notes`, [{ note_type: "common", params: { text } }]).catch(() => null);
  // The calendar pass reads each card's latest 'scheduled' slot (lib/inspection-calendar.ts) and
  // updates the event; this only makes it run now instead of within 5 minutes.
  queueInspectionCalendarSync(`slot ${slot ? "rescheduled" : "recorded"} for ${leadId}`);
  logger.info({ leadId, from: slot?.visitAt ?? null, to: v.visitAt, source }, "listing-progress: visit time changed");
  return slot ? "visit rescheduled" : "visit time recorded";
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
  o: { source: string; all?: Array<{ id: number; name: string }>; visit?: Visit | null; evidenceNote?: string },
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
  let slotId: string | null = null;
  if (o.visit) {
    lines.push(
      `Inspection scheduled: ${fmt(o.visit.visitAt)} Bali${o.visit.timeKnown ? "" : " (time not fixed)"}` +
        `${o.visit.agreedAt ? `, agreed ${fmt(o.visit.agreedAt)}` : ""} — "${o.visit.quote}"`,
    );
    const ins = await db
      .execute(sql`INSERT INTO listing_inspection_slots (lead_id, visit_at, time_known, agreed_at, quote, source)
                   VALUES (${leadId}, ${o.visit.visitAt.toISOString()}, ${o.visit.timeKnown}, ${o.visit.agreedAt ? o.visit.agreedAt.toISOString() : null}, ${o.visit.quote}, ${o.source})
                   ON CONFLICT (lead_id, visit_at) DO NOTHING
                   RETURNING id`)
      .catch((err) => {
        logger.warn({ err, leadId }, "listing-progress: slot not recorded");
        return null;
      });
    slotId = (ins?.rows?.[0] as { id?: string } | undefined)?.id ?? null;
  }
  if (path.includes(LISTING_STAGE.INSPECTION_SCHEDULED)) {
    // The time is agreed: a booking draft still waiting for Yudi would ask for it again.
    await db
      .execute(sql`UPDATE pending_suggestions SET status = 'skipped', autopilot_skipped_at = now(),
                          autopilot_skipped_reason = ${`${INSPECTION_ASK_VERDICT} — retired: visit agreed`}
                    WHERE lead_id = ${leadId} AND status = 'pending'
                      AND coalesce(autopilot_skipped_reason, '') LIKE ${`${INSPECTION_ASK_VERDICT}%`}`)
      .catch(() => undefined);
  }
  if (o.evidenceNote) lines.push(o.evidenceNote);
  const text =
    `Stage moved automatically: ${path.map((id) => stageLabel(id, o.all)).join(" → ")} (owner's rules, 14.09.2026).\n` + lines.join("\n");
  const posted = await amoPost(`/api/v4/leads/${leadId}/notes`, [{ note_type: "common", params: { text } }]).catch(() => null);
  if (!posted) logger.warn({ leadId }, "listing-progress: card moved but the note was not written");
  if (slotId) queueInspectionCalendarSync(`slot recorded for ${leadId}`);
  logger.info({ leadId, path, source: o.source }, "listing-progress: card moved");
  return { ok: true, detail: `moved to ${stageLabel(from, o.all)}` };
}

/**
 * A card amoCRM dropped into the funnel's first stage because the stage it sat in was DELETED (no
 * status event records that drop). 14.09.2026: the owner deleted "Details ased" and 14 cards landed
 * in Initial Contact, where the stage engine owns them and judged two of them down to TAKEN TO WORK.
 * The card goes back to the stage it was in before the deleted one (its last event's `from`), when
 * that stage still exists — the state a person last saw, not a new judgement.
 */
export async function restoreFromDeletedStage(leadId: string, apply: boolean): Promise<{ ok: boolean; detail: string; to?: string }> {
  const lead = await getAmoLead(leadId).catch(() => null);
  if (!lead?.status_id || lead.pipeline_id !== LISTINGS_PIPELINE_ID) return { ok: false, detail: "not a Rental Listings card amoCRM returned" };
  const live = await amoFetch<{ _embedded?: { statuses?: Array<{ id: number; name: string }> } }>(`/api/v4/leads/pipelines/${LISTINGS_PIPELINE_ID}`);
  const all = live?._embedded?.statuses ?? [];
  if (all.length === 0) return { ok: false, detail: "the funnel could not be read" };
  const events = await statusEvents(leadId);
  const last = events?.[events.length - 1];
  if (!last) return { ok: false, detail: "no status history" };
  const has = (id: number | null) => id != null && all.some((s) => s.id === id);
  if (last.to === lead.status_id) return { ok: false, detail: "the card is where its last status event put it — nothing to restore" };
  if (has(last.to)) return { ok: false, detail: `its last event put it in ${stageLabel(last.to, all)}, which still exists — moved by something else, not restored` };
  if (!has(last.from)) return { ok: false, detail: "the stage before the deleted one does not exist either" };
  const target = last.from!;
  const detail = `in ${stageLabel(lead.status_id, all)} after status ${last.to} was deleted; back to ${stageLabel(target, all)} (its stage before, ${new Date(last.at).toISOString()})`;
  if (!apply) return { ok: true, detail: `would restore: ${detail}`, to: stageLabel(target, all) };
  if (!(await updateLeadStatus(leadId, target))) return { ok: false, detail: `amoCRM refused ${stageLabel(target, all)}` };
  const owner = await db
    .execute(sql`SELECT responsible_user FROM leads_sync WHERE lead_id = ${leadId} LIMIT 1`)
    .then((r) => ((r.rows?.[0] as { responsible_user?: string | null } | undefined)?.responsible_user ?? "").trim())
    .catch(() => "");
  await db
    .execute(sql`INSERT INTO stage_events (lead_id, from_stage, to_stage, pipeline, responsible_user)
                 VALUES (${leadId}, ${stageLabel(lead.status_id, all)}, ${stageLabel(target, all)}, 'Rental Listings', ${owner || "engine:listing-progress:restore"})`)
    .catch(() => undefined);
  await db
    .execute(sql`UPDATE leads_sync SET lead_stage = ${stageLabel(target, all)}, lead_stage_id = ${String(target)}, updated_at = now() WHERE lead_id = ${leadId}`)
    .catch(() => undefined);
  await amoPost(`/api/v4/leads/${leadId}/notes`, [
    {
      note_type: "common",
      params: {
        text: `Stage restored to ${stageLabel(target, all)}: the stage this card was in ("Details ased", id ${last.to}) was deleted in amoCRM on 14.09.2026, and amoCRM had dropped the card into ${stageLabel(lead.status_id, all)}.`,
      },
    },
  ]).catch(() => null);
  logger.info({ leadId, detail }, "listing-progress: restored from a deleted stage");
  return { ok: true, detail: `restored: ${detail}`, to: stageLabel(target, all) };
}

/** The card's current agreed visit, for the reply generator and the metrics. */
export async function latestInspectionSlot(leadId: string): Promise<{ visitAt: Date; timeKnown: boolean } | null> {
  const slot = await currentSlot(leadId);
  return slot ? { visitAt: slot.visitAt, timeKnown: slot.timeKnown } : null;
}

/** Every open card in QUALIFIED / Inspection scheduled (and, when asked, TAKEN TO WORK for the report). */
export async function auditListingProgress(o: { apply: boolean; reportTaken?: boolean; source?: string }): Promise<ProgressDecision[]> {
  const ids: string[] = [];
  // Only statuses the funnel still has: a filter on a deleted status id fails the whole list.
  const live = await amoFetch<{ _embedded?: { statuses?: Array<{ id: number }> } }>(`/api/v4/leads/pipelines/${LISTINGS_PIPELINE_ID}`);
  const liveIds = new Set((live?._embedded?.statuses ?? []).map((s) => s.id));
  const statuses = [LISTING_STAGE.QUALIFIED, LISTING_STAGE.INSPECTION_SCHEDULED, ...(o.reportTaken ? [LISTING_STAGE.TAKEN_TO_WORK] : [])].filter(
    (s) => liveIds.size === 0 || liveIds.has(s),
  );
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


// ── The visit the broker sets himself, and the watch that re-reads threads ─────────────────────────

/**
 * Yudi sets the inspection date in Copilot (23.09.2026): a visit agreed by phone or in person leaves
 * nothing in the thread to read (Ortus Bali Villa, 22.09), and his calendar must still show it. His word
 * is the agreement: QUALIFIED / TAKEN TO WORK move to Inspection sceduled with the slot; on Inspection
 * sceduled or live the slot is recorded (or replaces the one on record). The calendar pass follows.
 */
export async function recordBrokerVisit(leadId: string, at: Date, broker: string | null): Promise<{ ok: boolean; detail: string }> {
  if (!/^\d+$/.test(leadId) || Number.isNaN(at.getTime())) return { ok: false, detail: "bad card or date" };
  if (at.getTime() < Date.now() - 14 * DAY || at.getTime() > Date.now() + 120 * DAY) return { ok: false, detail: "the date is too far from today" };
  const lead = await getAmoLead(leadId).catch(() => null);
  if (!lead?.status_id) return { ok: false, detail: "amoCRM did not return this card" };
  if (lead.pipeline_id !== LISTINGS_PIPELINE_ID) return { ok: false, detail: "this card is not in Rental Listings" };
  if (lead.status_id === 142 || lead.status_id === 143) return { ok: false, detail: "this card is closed" };
  const visit: Visit = { visitAt: at, timeKnown: true, agreedAt: new Date(), quote: `set by ${broker || "the broker"} in Copilot`, why: "set by the broker" };
  if (lead.status_id === LISTING_STAGE.QUALIFIED || lead.status_id === LISTING_STAGE.TAKEN_TO_WORK) {
    const moved = await applyForwardPath(leadId, lead.status_id, [LISTING_STAGE.INSPECTION_SCHEDULED], { source: "broker", visit });
    return { ok: moved.ok, detail: moved.detail };
  }
  const slot = await currentSlot(leadId);
  const detail = await recordChangedVisit(leadId, slot, visit, "broker");
  return { ok: !/could not/.test(detail), detail };
}

const WATCH_EVERY_MS = 30 * 60_000;
// On disk: a restart used to forget every card and re-read three days of each thread (disk-memo.ts).
const watched = diskMap<number>("/var/tmp/whatcan-visit-watch.json");
const watchedUpTo = watched.map;
let watching = false;

/**
 * Every 30 minutes: the listing cards where a visit can still be agreed (QUALIFIED, Inspection
 * sceduled, live and after) are read again when their thread has news. Before this the thread was read
 * only when a message arrived through a path that called it, and once a day for QUALIFIED / Inspection
 * sceduled — so a visit agreed from Yudi's phone and synced late, or on a card already live (Casa Bumbak,
 * "tanggal 7 kami jadwalkan inspeksi", 22.09), never reached the calendar. A card with nothing new costs
 * no model call; the first look at a card reads its last three days.
 */
export async function runVisitWatch(): Promise<{ cards: number; decided: number }> {
  if (watching) return { cards: 0, decided: 0 };
  watching = true;
  try {
    // AFTER_LIVE was removed in 5603682 while this line still spread it: every run threw a
    // ReferenceError and late-synced visits never reached the calendar. The stages are listed here.
    const statuses = [LISTING_STAGE.QUALIFIED, LISTING_STAGE.INSPECTION_SCHEDULED, LISTING_STAGE.LIVE, LISTING_STAGE.WEEKLY_CHECK_SENT, LISTING_STAGE.AVAILABILITY_RECEIVED];
    const ids: string[] = [];
    for (let page = 1; page <= 10; page++) {
      const q = statuses.map((st, i) => `filter[statuses][${i}][pipeline_id]=${LISTINGS_PIPELINE_ID}&filter[statuses][${i}][status_id]=${st}`).join("&");
      const d = await amoFetch<{ _embedded?: { leads?: Array<{ id: number }> } }>(`/api/v4/leads?${q}&limit=250&page=${page}`);
      const batch = d?._embedded?.leads ?? [];
      ids.push(...batch.map((l) => String(l.id)));
      if (batch.length < 250) break;
    }
    let decided = 0;
    for (const id of ids) {
      const newest = await db
        .execute(sql`SELECT extract(epoch from max(sent_at)) * 1000 AS at FROM lead_messages WHERE lead_id = ${id}`)
        .then((r) => Number((r.rows?.[0] as { at?: number | string | null } | undefined)?.at ?? 0))
        .catch(() => 0);
      const seen = watchedUpTo.get(id);
      if (!newest || (seen !== undefined && newest <= seen)) continue;
      try {
        await advanceListingProgress(id, { source: "visit-watch", apply: true, checkedAt: new Date(seen ?? Date.now() - 3 * DAY) });
        watchedUpTo.set(id, newest);
        watched.touch();
        decided++;
      } catch (err) {
        logger.warn({ err, leadId: id }, "visit watch: card failed");
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    logger.info({ cards: ids.length, decided }, "visit watch pass complete");
    return { cards: ids.length, decided };
  } finally {
    watching = false;
  }
}

export function startVisitWatch(): void {
  const tick = () => runVisitWatch().catch((err) => logger.warn({ err }, "visit watch failed"));
  setTimeout(tick, 3 * 60_000);
  setInterval(tick, WATCH_EVERY_MS);
}
