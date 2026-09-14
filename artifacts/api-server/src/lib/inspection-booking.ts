/**
 * Booking Yudi's inspection visit on a QUALIFIED listing card (owner, 14.09.2026, after a call with
 * Yudi). QUALIFIED means the bot qualified the villa and it is Pre-listed on the site; the next step
 * is an offline inspection: Yudi goes to the villa, walks it, takes his own photos, video and notes.
 * Yudi's bottleneck, in his words the same day: "Scheduling the visit with owners … if there's any way
 * with AI to push on inspection questions/request and once it confirmed by owners to put it into my
 * calendar?"
 *
 * So: drafts for Yudi, never autopilot (QUALIFIED is past the autopilot threshold, which is exclusive).
 *
 * THE TRIGGER IS CODE (`bookingPlan`):
 * - the card is in QUALIFIED (amoCRM status id), its site listing is published (or a draft nothing
 *   blocks) and still Pre-listed, and no visit is on record (`listing_inspection_slots`);
 * - the villa side's stance on a visit, read from the thread (one Haiku call, only when a visit was
 *   talked about, fail-closed): agreed / declined / deferred-until-a-date → no ask;
 * - the ladder: our asks for a visit (bot or Yudi's phone, `isInspectionAsk`) since the villa side
 *   last wrote. One ask, then at most two follow-ups, each ≥ 2 days after the previous ask; after
 *   three unanswered asks the card is Yudi's call and nothing more is drafted;
 * - PUSH only when WE spoke last and the thread has been quiet 12 h, Yudi has no future amoCRM task
 *   on the card (amo-sync deletes PUSH drafts there anyway), the card is not bot-excluded, and no
 *   booking draft was written for it in the last 2 days (at most 3 in 14 days, whatever became of
 *   them: the loop guard, `listing_inspection_asks`).
 * - When the villa side wrote last, the ask rides in the LIVE reply instead
 *   (`inspectionBookingPromptBlock` + `applyInspectionAsk` in listing-acquisition-prompt.ts, which the
 *   handover draft on arrival at QUALIFIED also goes through).
 *
 * THE WORDS ARE YUDI'S: his own phone messages asking to come (lib/yudi-voice.ts), his lessons, his
 * owner's language. No example sentence of ours anywhere.
 *
 * THE TIMES: his usual hours and days from the visits on record, minus times already taken by other
 * scheduled inspections (90 minutes apart, at most 3 a day), preferring a day he is already near the
 * villa. Proposed as a question; the draft is Yudi's to approve or edit, so nothing is promised.
 *
 * When the owner agrees a time, listing-progress.ts moves the card to Inspection scheduled, records
 * the slot, retires any booking draft still pending, and calls the calendar hook.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";
import { getAmoLead } from "./amo-client";
import { chatCompletion, chatCompletionJSON, HELPER_MODEL, WRITER_MODEL } from "./ai-client";
import { correctionsPromptBlock } from "./broker-corrections";
import { sanitizeSuggestion } from "./sanitize-suggestion";
import { notifyBroker } from "./push-notifications";
import { LISTING_AGENT_BROKER, LISTINGS_PIPELINE_ID, LISTING_STAGE, siteGet } from "./listing-status-week";
import { INSPECTION_ASK_VERDICT, loadMessages, ownWords, transcript, VISIT_CUE, type ThreadMsg } from "./listing-progress";
import { isInspectionAsk, ownerThreadLanguage, textLanguage, yudiExamplesBlock, yudiInspectionAskExamples, type OwnerLang } from "./yudi-voice";
import { fetchLeadTitle, fetchOwnerName, villaFromLeadName } from "./weekly-availability-check";

const BALI = "Asia/Makassar";
const BALI_MS = 8 * 3_600_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** At least this long between two asks for a visit on one thread. */
export const ASK_GAP_MS = 2 * DAY;
/** One ask and two follow-ups; then Yudi decides. */
export const MAX_ASKS = 3;
const DRAFTS_PER_14_DAYS = 3;
const QUIET_BEFORE_PUSH_MS = 12 * HOUR;
const LOOKBACK_MS = 21 * DAY;
const PASS_EVERY_MS = 30 * MIN;
const BATCH_LIMIT = 6;
/** Drafts are written in Bali working hours, so Yudi finds them in the morning queue, not at night. */
const DRAFT_HOURS = { open: 8, close: 18 };
/** Yudi, 10.09: "Usually 1-3 inspection" a day. */
const MAX_INSPECTIONS_PER_DAY = 3;
const SLOT_GAP_MIN = 90;
const NEAR_KM = 3;

export type Stance = { stance: "none" | "open" | "deferred" | "declined" | "agreed"; notBefore: Date | null; why: string };
export type ProposedTime = { at: Date; label: string; why: string };
export type BookingListing = { code: string; title: string | null; area: string | null; lat: number | null; lng: number | null; ready: boolean; readiness: string };
/** ask: this message asks for the visit · settle: a visit is being arranged, agree a time if offered · hold: no ask · none: not a booking card */
export type BookingMode = "ask" | "settle" | "hold" | "none";

export type BookingPlan = {
  leadId: string;
  statusId: number | null;
  responsibleUser: string | null;
  mode: BookingMode;
  pushDue: boolean;
  reason: string;
  /** For the model when mode is hold: why no ask, in plain words. */
  holdNote: string;
  round: number;
  lang: OwnerLang;
  listing: BookingListing | null;
  asks: Array<{ at: Date; text: string }>;
  asksSinceOwner: number;
  lastAskAt: Date | null;
  ownerSpokeLast: boolean;
  stance: Stance | null;
  times: ProposedTime[];
  messages: ThreadMsg[];
};

// ── small helpers ─────────────────────────────────────────────────────────────

function fmtDay(d: Date): string {
  return d.toLocaleString("en-GB", { timeZone: BALI, weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function timeLabel(d: Date): string {
  return d.toLocaleString("en-GB", { timeZone: BALI, weekday: "long", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}

function ago(d: Date | null, now = Date.now()): string {
  if (!d) return "";
  const h = Math.max(0, Math.round((now - d.getTime()) / HOUR));
  return h < 36 ? `${h} hours ago` : `${Math.round(h / 24)} days ago`;
}

function baliDay(d: Date): { y: number; m: number; day: number } {
  const b = new Date(d.getTime() + BALI_MS);
  return { y: b.getUTCFullYear(), m: b.getUTCMonth(), day: b.getUTCDate() };
}

function baliHour(d: Date): number {
  return new Date(d.getTime() + BALI_MS).getUTCHours();
}

function baliWeekday(d: Date): number {
  return new Date(d.getTime() + BALI_MS).getUTCDay();
}

function km(a: { lat: number | null; lng: number | null } | null, b: { lat: number | null; lng: number | null } | null): number | null {
  if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
  const r = (x: number) => (x * Math.PI) / 180;
  const dLat = r(b.lat - a.lat);
  const dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

const enc = encodeURIComponent;

/** Our messages since `since` that ask the villa side to let us come (quoted owner text removed). */
export function ourInspectionAsks(messages: ThreadMsg[], since: number): Array<{ at: Date; text: string }> {
  const out: Array<{ at: Date; text: string }> = [];
  messages.forEach((m, i) => {
    if (m.senderType === "lead" || m.sentAt.getTime() < since) return;
    const words = ownWords(m, messages.slice(Math.max(0, i - 12), i));
    if (isInspectionAsk(words)) out.push({ at: m.sentAt, text: words.replace(/\s+/g, " ").trim().slice(0, 200) });
  });
  return out;
}

// ── the listing ───────────────────────────────────────────────────────────────

type SiteListing = { code: string | null; title: string | null; area: string | null; lat: number | null; lng: number | null };
const listingCache = new Map<string, { at: number; info: SiteListing }>();

/** The site listing linked to a card (`listing_crm_link`) with its area and coordinates. Cached 10 minutes. */
async function listingForCard(leadId: string): Promise<SiteListing> {
  const hit = listingCache.get(leadId);
  if (hit && Date.now() - hit.at < 10 * MIN) return hit.info;
  const info: SiteListing = { code: null, title: null, area: null, lat: null, lng: null };
  try {
    const [link] = await siteGet<Array<{ property_id: string }>>(`listing_crm_link?select=property_id&amo_lead_id=eq.${enc(leadId)}`);
    if (link?.property_id) {
      info.code = link.property_id.toUpperCase();
      const [p] = await siteGet<Array<{ title: string | null; area: string | null; lat: number | null; lng: number | null }>>(
        `properties?select=title,area,lat,lng&id=eq.${enc(info.code)}`,
      );
      Object.assign(info, { title: p?.title ?? null, area: p?.area ?? null, lat: p?.lat ?? null, lng: p?.lng ?? null });
    }
  } catch (err) {
    logger.warn({ err, leadId }, "inspection booking: site listing could not be read");
  }
  listingCache.set(leadId, { at: Date.now(), info });
  return info;
}

/** The card's site listing and whether it may be booked: published or a draft nothing blocks, still Pre-listed. */
export async function bookingListing(leadId: string): Promise<BookingListing | null> {
  const info = await listingForCard(leadId);
  let code = info.code;
  if (!code) {
    const m = (await fetchLeadTitle(leadId)).match(/\bR-[A-Z]+-\d+\b/i);
    code = m ? m[0].toUpperCase() : null;
  }
  if (!code) return null;
  const rows = await siteGet<Array<{ is_draft: boolean | null; pre_listed: boolean | null; title: string | null; area: string | null; lat: number | null; lng: number | null }>>(
    `properties?select=is_draft,pre_listed,title,area,lat,lng&id=eq.${enc(code)}`,
  ).catch(() => null);
  const p = rows?.[0];
  const base = { code, title: p?.title ?? info.title, area: p?.area ?? info.area, lat: p?.lat ?? info.lat, lng: p?.lng ?? info.lng };
  if (!rows) return { ...base, ready: false, readiness: "the site database could not be read" };
  if (!p) return { ...base, ready: false, readiness: `listing ${code} is not on the site` };
  if (p.pre_listed === false) return { ...base, ready: false, readiness: `${code} is already Listed on the site — the inspection result is in` };
  if (!p.is_draft) return { ...base, ready: true, readiness: `${code} published, Pre-listed` };
  const blockers = await siteGet<string[]>(`rpc/listing_publish_blockers?_property_id=${enc(code)}`).catch(() => null);
  if (blockers && blockers.length === 0) return { ...base, ready: true, readiness: `${code} is a draft that nothing blocks from publishing` };
  return { ...base, ready: false, readiness: `${code} is a draft${blockers ? ` blocked by: ${blockers.join(", ")}` : " (publish blockers unreadable)"}` };
}

// ── the times ─────────────────────────────────────────────────────────────────

/** Yudi's usual inspection hours and weekdays, from the visits on record (defaults 10–14, Mon–Fri). */
export async function yudiUsualHours(): Promise<{ from: number; to: number; weekdays: Set<number>; samples: number }> {
  const res = await db
    .execute(sql`SELECT visit_at, time_known FROM listing_inspection_slots WHERE created_at > now() - interval '90 days'`)
    .catch(() => null);
  const rows = (res?.rows ?? []) as Array<{ visit_at: string | Date; time_known: boolean }>;
  const weekdays = new Set<number>([1, 2, 3, 4, 5]);
  const hours: number[] = [];
  for (const r of rows) {
    const d = new Date(r.visit_at);
    weekdays.add(baliWeekday(d));
    if (r.time_known) hours.push(baliHour(d));
  }
  if (hours.length < 3) return { from: 10, to: 14, weekdays, samples: hours.length };
  const from = Math.min(Math.max(Math.min(...hours), 9), 15);
  const to = Math.max(Math.min(Math.max(...hours), 16), from + 1);
  return { from, to, weekdays, samples: hours.length };
}

/**
 * Two times Yudi can realistically do, from tomorrow over the next five days: his usual hours and
 * weekdays, never within 90 minutes of another scheduled inspection, at most three a day, and the day
 * he is already inspecting within 3 km (or in the same area) first.
 */
export async function proposeInspectionTimes(leadId: string, listing: BookingListing | null, now = new Date()): Promise<ProposedTime[]> {
  const pat = await yudiUsualHours();
  const res = await db
    .execute(sql`SELECT lead_id, visit_at FROM listing_inspection_slots
                  WHERE status = 'scheduled' AND visit_at > now() AND visit_at < now() + interval '8 days' AND lead_id <> ${leadId}`)
    .catch(() => null);
  const booked: Array<{ at: number; lat: number | null; lng: number | null; area: string | null }> = [];
  for (const r of (res?.rows ?? []) as Array<{ lead_id: string; visit_at: string | Date }>) {
    const l = await listingForCard(r.lead_id);
    booked.push({ at: new Date(r.visit_at).getTime(), lat: l.lat, lng: l.lng, area: l.area });
  }
  // Times offered in booking drafts of the last 2 days (still pending, or sent) are tentatively taken:
  // four owners must not all be offered Tuesday 12:00 (replay 14.09: every card got the same two times).
  const offered = await db
    .execute(sql`SELECT a.lead_id, a.times FROM listing_inspection_asks a
                   LEFT JOIN pending_suggestions p ON p.id = a.suggestion_id
                  WHERE a.created_at > now() - interval '2 days' AND a.lead_id <> ${leadId}
                    AND coalesce(p.status, 'pending') IN ('pending', 'approved')`)
    .catch(() => null);
  for (const r of (offered?.rows ?? []) as Array<{ lead_id: string; times: Array<{ at: string }> | null }>) {
    const l = await listingForCard(r.lead_id);
    for (const t of r.times ?? []) {
      const at = new Date(t.at).getTime();
      if (at > now.getTime()) booked.push({ at, lat: l.lat, lng: l.lng, area: l.area });
    }
  }
  const today = baliDay(now);
  const cands: Array<{ at: Date; score: number; why: string; day: number }> = [];
  for (let d = 1; d <= 5; d++) {
    const dayStart = Date.UTC(today.y, today.m, today.day + d) - BALI_MS;
    const wd = new Date(dayStart + BALI_MS).getUTCDay();
    if (!pat.weekdays.has(wd)) continue;
    const sameDay = booked.filter((b) => b.at >= dayStart && b.at < dayStart + DAY);
    if (sameDay.length >= MAX_INSPECTIONS_PER_DAY) continue;
    for (let h = pat.from; h <= pat.to; h++) {
      const at = dayStart + h * HOUR;
      if (sameDay.some((b) => Math.abs(b.at - at) < SLOT_GAP_MIN * MIN)) continue;
      let score = 10 - d * 1.5 + (wd >= 1 && wd <= 5 ? 0.5 : 0) + (h >= 10 && h <= 12 ? 0.3 : 0);
      let why = "free in Yudi's usual inspection hours";
      const near = sameDay
        .map((b) => ({ b, dist: km(listing, b) }))
        .filter((x): x is { b: (typeof booked)[number]; dist: number } => x.dist != null && x.dist <= NEAR_KM)
        .sort((x, y) => x.dist - y.dist)[0];
      if (near) {
        score += 4 + (Math.abs(near.b.at - at) <= 2 * HOUR ? 1 : 0);
        why = `same day as another inspection ${near.dist.toFixed(1)} km away at ${baliHour(new Date(near.b.at))}:00`;
      } else if (listing?.area && sameDay.some((b) => (b.area ?? "").toLowerCase() === listing.area!.toLowerCase())) {
        score += 2;
        why = `same day as another inspection in ${listing.area}`;
      }
      cands.push({ at: new Date(at), score, why, day: d });
    }
  }
  cands.sort((a, b) => b.score - a.score || a.at.getTime() - b.at.getTime());
  const first = cands[0];
  if (!first) return [];
  const second =
    cands.find((c) => c.day !== first.day) ?? cands.find((c) => Math.abs(c.at.getTime() - first.at.getTime()) >= 2 * HOUR);
  return [first, second]
    .filter((c): c is (typeof cands)[number] => !!c)
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map((c) => ({ at: c.at, label: timeLabel(c.at), why: c.why }));
}

// ── the villa side's stance ───────────────────────────────────────────────────

const stanceCache = new Map<string, { key: number; stance: Stance }>();

/**
 * Where a visit by our side stands, from the villa side's words: agreed, declined, deferred (until when),
 * open ("come any time") or none. One Haiku call, only when a visit was talked about in 21 days;
 * cached until a new message arrives. null = could not be read (callers fail closed).
 */
export async function ownerVisitStance(leadId: string, messages: ThreadMsg[], now = new Date()): Promise<Stance | null> {
  const recent = messages.filter((m) => m.sentAt.getTime() >= now.getTime() - LOOKBACK_MS);
  if (!recent.some((m) => VISIT_CUE.test(m.text ?? ""))) return { stance: "none", notBefore: null, why: "no visit talk in 21 days" };
  const key = recent[recent.length - 1]!.sentAt.getTime();
  const hit = stanceCache.get(leadId);
  if (hit && hit.key === key) return hit.stance;
  const out = await chatCompletionJSON<{ stance: string; not_before: string | null; why: string }>({
    model: HELPER_MODEL,
    label: "listing:visit-stance",
    max_tokens: 120,
    temperature: 0,
    system: `Now is ${fmtDay(now)} (Bali time, year ${now.getFullYear()}). Lines start with the weekday, day/month and Bali time. "Us" is our real-estate agency (agent Yudi, colleague Amelia, our bot); "Villa side" is the owner, their staff or manager.

Our agent wants to visit the villa (an inspection: walk it, take his own photos and video; a viewing with a client counts as a visit too). From the VILLA SIDE's words, where does a visit by our side stand now?
- "agreed": both sides settled a concrete day for our visit, and nothing later cancelled it
- "declined": the villa side refused a visit or an inspection (they will send their own photos instead, the tenant does not allow it, not interested) and nothing later reopened it
- "deferred": the villa side said a visit is only possible later: from a date, after guests or a tenant leave, after a renovation, with a client only. not_before = the first possible day as YYYY-MM-DD when they named or clearly implied one, else null
- "open": the villa side invited us to come or said any time works, and no day is fixed
- "none": the villa side has not said anything about a visit by our side (our own unanswered asks are "none")
When a later message changes an earlier one, the later one wins.
JSON only: {"stance": "agreed|declined|deferred|open|none", "not_before": "2026-09-21" | null, "why": "<10 words>"}`,
    messages: [{ role: "user", content: transcript(recent, 40).slice(-9000) }],
  }).catch(() => null);
  const kind = out?.stance;
  if (kind !== "agreed" && kind !== "declined" && kind !== "deferred" && kind !== "open" && kind !== "none") return null;
  const nb = out?.not_before ? new Date(`${out.not_before}T00:00:00+08:00`) : null;
  const stance: Stance = { stance: kind, notBefore: nb && !Number.isNaN(nb.getTime()) ? nb : null, why: String(out?.why ?? "").slice(0, 120) };
  stanceCache.set(leadId, { key, stance });
  return stance;
}

// ── the plan: the one gate ────────────────────────────────────────────────────

export async function bookingPlan(leadId: string, o: { statusId?: number | null; now?: Date } = {}): Promise<BookingPlan> {
  const now = o.now ?? new Date();
  const plan: BookingPlan = {
    leadId, statusId: null, responsibleUser: null, mode: "none", pushDue: false, reason: "", holdNote: "", round: 0, lang: "en",
    listing: null, asks: [], asksSinceOwner: 0, lastAskAt: null, ownerSpokeLast: false, stance: null, times: [], messages: [],
  };
  let statusId = o.statusId;
  if (statusId === undefined) {
    const lead = await getAmoLead(leadId).catch(() => null);
    if (!lead?.status_id || lead.pipeline_id !== LISTINGS_PIPELINE_ID) return { ...plan, reason: "not a Rental Listings card amoCRM returned" };
    statusId = lead.status_id;
  }
  plan.statusId = statusId ?? null;
  if (statusId !== LISTING_STAGE.QUALIFIED) return { ...plan, reason: "not in QUALIFIED" };

  const syncRes = await db
    .execute(sql`SELECT responsible_user, bot_excluded, next_followup_at FROM leads_sync WHERE lead_id = ${leadId} LIMIT 1`)
    .catch(() => null);
  const sync = (syncRes?.rows?.[0] ?? null) as { responsible_user: string | null; bot_excluded: boolean | null; next_followup_at: string | Date | null } | null;
  plan.responsibleUser = sync?.responsible_user ?? null;

  const slotRes = await db
    .execute(sql`SELECT visit_at FROM listing_inspection_slots WHERE lead_id = ${leadId} ORDER BY visit_at DESC LIMIT 1`)
    .catch(() => null);
  const slot = (slotRes?.rows?.[0] ?? null) as { visit_at: string | Date } | null;
  if (slot) {
    return { ...plan, mode: "hold", reason: `a visit is on record (${fmtDay(new Date(slot.visit_at))}) — nothing to book`, holdNote: "a visit to this villa is already on record" };
  }

  plan.messages = await loadMessages(leadId);
  plan.lang = ownerThreadLanguage(plan.messages);
  plan.asks = ourInspectionAsks(plan.messages, now.getTime() - LOOKBACK_MS);
  const lastOwner = [...plan.messages].reverse().find((m) => m.senderType === "lead") ?? null;
  const last = plan.messages[plan.messages.length - 1] ?? null;
  plan.ownerSpokeLast = last?.senderType === "lead";
  plan.asksSinceOwner = plan.asks.filter((a) => !lastOwner || a.at.getTime() > lastOwner.sentAt.getTime()).length;
  plan.lastAskAt = plan.asks.length ? plan.asks[plan.asks.length - 1]!.at : null;

  plan.listing = await bookingListing(leadId).catch(() => null);
  if (!plan.listing) {
    return { ...plan, mode: "hold", reason: "no site listing linked to this card (listing_crm_link, or a code in the card name)", holdNote: "" };
  }
  if (!plan.listing.ready) return { ...plan, mode: "hold", reason: plan.listing.readiness, holdNote: "" };

  plan.stance = await ownerVisitStance(leadId, plan.messages, now);
  const recentAsk = !!plan.lastAskAt && now.getTime() - plan.lastAskAt.getTime() < ASK_GAP_MS;
  const ladderSpent = plan.asksSinceOwner >= MAX_ASKS;
  const s = plan.stance;
  if (!s) {
    plan.mode = plan.ownerSpokeLast ? "settle" : "hold";
    plan.reason = "the villa side's stance on a visit could not be read — no ask (fail-closed)";
  } else if (s.stance === "agreed") {
    plan.mode = "settle";
    plan.reason = `the thread reads as a visit agreed that listing-progress has not recorded (${s.why}) — Yudi's call`;
  } else if (s.stance === "declined") {
    plan.mode = "hold";
    plan.reason = `the villa side declined a visit (${s.why})`;
    plan.holdNote = "the villa side has declined a visit for now";
  } else if (s.stance === "deferred" && (!s.notBefore || s.notBefore.getTime() > now.getTime() + DAY)) {
    plan.mode = "hold";
    plan.reason = `the villa side deferred a visit${s.notBefore ? ` until ${s.notBefore.toISOString().slice(0, 10)}` : ""} (${s.why})`;
    plan.holdNote = `the villa side said a visit is only possible later${s.notBefore ? `, from ${timeLabel(s.notBefore).replace(/,? \d{2}:\d{2}$/, "")}` : ""}`;
  } else if (plan.ownerSpokeLast) {
    plan.mode = s.stance === "open" || (!recentAsk && !ladderSpent) ? "ask" : "settle";
    plan.reason = "the villa side wrote last — the booking rides in the LIVE reply";
  } else if (ladderSpent) {
    plan.mode = "hold";
    plan.reason = `${plan.asksSinceOwner} asks for a visit without an answer — Yudi's call`;
    plan.holdNote = "Yudi has already asked for a visit several times without an answer";
  } else if (recentAsk) {
    plan.mode = "settle";
    plan.reason = `asked for a visit ${ago(plan.lastAskAt, now.getTime())} — the next ask waits 2 days`;
  } else {
    plan.mode = "ask";
    plan.round = plan.asksSinceOwner + 1;
    plan.reason = plan.round === 1 ? "no ask for a visit yet" : `follow-up ${plan.round - 1} of 2: last ask ${ago(plan.lastAskAt, now.getTime())}, no answer`;
    plan.pushDue = true;
  }

  // PUSH-only gates, in the order a person would check them.
  if (plan.pushDue) {
    const block = async (reason: string) => {
      plan.pushDue = false;
      plan.reason = `${plan.reason}; no PUSH: ${reason}`;
    };
    if (sync?.bot_excluded) await block("the card is excluded from the bot");
    else if (sync?.next_followup_at && new Date(sync.next_followup_at).getTime() > now.getTime()) {
      await block(`Yudi has an amoCRM task on the card due ${fmtDay(new Date(sync.next_followup_at))}`);
    } else if (last && now.getTime() - last.sentAt.getTime() < QUIET_BEFORE_PUSH_MS) {
      await block(`the last message is ${ago(last.sentAt, now.getTime())} — waits for 12 h of quiet`);
    } else {
      const logRes = await db
        .execute(sql`SELECT count(*) FILTER (WHERE created_at > now() - interval '2 days')::int AS recent,
                            count(*) FILTER (WHERE created_at > now() - interval '14 days')::int AS fortnight
                       FROM listing_inspection_asks WHERE lead_id = ${leadId}`)
        .catch(() => null);
      const log = (logRes?.rows?.[0] ?? null) as { recent: number; fortnight: number } | null;
      if (!log) await block("the booking draft log could not be read");
      else if (log.recent > 0) await block("a booking draft was written in the last 2 days");
      else if (log.fortnight >= DRAFTS_PER_14_DAYS) await block(`${log.fortnight} booking drafts in 14 days`);
      else {
        const pend = await db
          .execute(sql`SELECT kind, suggestion_text, autopilot_skipped_reason FROM pending_suggestions WHERE lead_id = ${leadId} AND status = 'pending'`)
          .catch(() => null);
        const rows = (pend?.rows ?? []) as Array<{ kind: string; suggestion_text: string; autopilot_skipped_reason: string | null }>;
        if (rows.some((r) => (r.autopilot_skipped_reason ?? "").startsWith(INSPECTION_ASK_VERDICT))) await block("a booking draft is already pending");
        else if (rows.some((r) => isInspectionAsk(r.suggestion_text ?? ""))) await block("a pending draft already asks for the visit");
      }
    }
  }
  if (plan.mode === "ask" || plan.mode === "settle") plan.times = await proposeInspectionTimes(leadId, plan.listing, now);
  return plan;
}

// ── the words ─────────────────────────────────────────────────────────────────

/** Asking again for what the villa side already gave. Checked on every booking text we write. */
const REASK =
  /\b(harga|price|pricing|rates?|komisi|commission|berapa kamar|jumlah kamar|how many bedrooms|minimum stay|minimal sewa|min(imum)? sewa|available from|availability|ketersediaan|tanggal (kosong|tersedia)|kirim(kan)? (foto|video|lokasi|pin)|send (me |us )?(the |some )?(photos|pictures|video|location|pin)|share (the |some )?(photos|pictures|video|location|pin)|pin lokasi|lokasi pin|sertifikat|dokumen|documents?)\b/i;

export function bookingTextProblems(text: string, lang: OwnerLang, before = ""): string[] {
  const p: string[] = [];
  if (!isInspectionAsk(text)) p.push("it does not ask to come and inspect the villa");
  const re = text.match(REASK);
  if (re && !(before && REASK.test(before))) p.push(`it asks about "${re[0]}", which is settled`);
  if (/https?:\/\/|\bR-[A-Z]+-\d+\b/i.test(text)) p.push("it has a link or a listing code");
  if (/[—–]|\s-\s/.test(text)) p.push("it has a dash");
  const l = textLanguage(text);
  if (l && l !== lang) p.push(`it is written in ${l === "id" ? "Indonesian" : "English"}, the villa side writes ${lang === "id" ? "Indonesian" : "English"}`);
  if (text.length > 480) p.push("it is too long");
  if (text.trim().length < 20) p.push("it is empty");
  return p;
}

function timesLines(plan: BookingPlan): string {
  return plan.times.length
    ? plan.times.map((t) => `  · ${t.label}`).join("\n")
    : "  · none free in the next five days: ask which day suits them instead";
}

const LESSON_PRECEDENCE =
  "\n(Where a lesson above asks for photos, documents, pricing or commission terms, it does not apply to this message: the villa is qualified and Yudi takes his own photos and video at the visit.)";

/**
 * The reply generator's block for a QUALIFIED card (LIVE, and the handover draft): nothing about the
 * villa is asked again, and the visit is the next step — asked, settled or held as the plan says.
 */
export async function inspectionBookingPromptBlock(plan: BookingPlan): Promise<string> {
  let block = `
THIS VILLA IS QUALIFIED (card stage: QUALIFIED, Pre-listed on our website). What the thread has given about it stays given: do NOT ask again for photos, a video, the price or our commission, bedrooms, availability or dates, the minimum stay, sizes, documents or the location pin, whatever any line above says is still missing. The next step for this villa is Yudi's inspection visit: he comes to the villa, walks it, takes his own photos and a short video (10 to 15 minutes).
`;
  if (plan.mode === "ask" || plan.mode === "settle") {
    const examples = await yudiInspectionAskExamples({ lang: plan.lang, limit: 6 });
    const style = yudiExamplesBlock(examples, "asks villa owners to let him come and inspect");
    if (plan.mode === "ask") {
      block += `BOOK THE VISIT: this reply also asks the villa side to let Yudi come, the way Yudi asks it himself.${style}
Yudi's free times (from his inspection calendar). Offer one or two as a question, never as a booking:
${timesLines(plan)}
Answer what they wrote first, briefly. If they already named a day or a time, agree that instead when it is one of these or close to one.
`;
    } else {
      block += `A VISIT IS BEING ARRANGED: Yudi has already asked the villa side to let him come${plan.lastAskAt ? ` (${ago(plan.lastAskAt)})` : ""}. If they named a day or a time, agree it in this reply, day AND time; if it clashes, offer the nearest of Yudi's free times:
${timesLines(plan)}
If they did not answer about the visit, do not ask again in this reply.${style}
`;
    }
    block += `Never mention other villas, never call a time booked before they agree, never offer a time outside those listed.
Yudi sends this himself: write the visit in the first person ("I'd like to come", "saya datang"), never "Yudi from our team". No time-of-day greeting (selamat pagi / siang / sore, good morning): it may go out hours later. If the villa side's last line is days old, do not answer it ("Great, thanks for confirming"); open like a new message.\n`;
  } else if (plan.mode === "hold") {
    block += `No visit request in this reply${plan.holdNote ? ` (${plan.holdNote})` : ""}. If the villa side brings a visit up themselves, agree a concrete day and time with them.\n`;
  }
  return block;
}

/**
 * The text half for a LIVE reply whose plan says ask: when the finished draft does not ask for the
 * visit, ONE sentence is inserted in Yudi's voice (his examples, his lessons, his free times) and the
 * rest stays verbatim. A miss goes out as written and is logged.
 */
export async function applyInspectionAsk(text: string, plan: BookingPlan | null): Promise<string> {
  if (!plan || plan.mode !== "ask" || !text.trim() || isInspectionAsk(text)) return text;
  try {
    const [examples, lessons] = await Promise.all([
      yudiInspectionAskExamples({ lang: plan.lang, limit: 6 }),
      correctionsPromptBlock(plan.responsibleUser ?? LISTING_AGENT_BROKER, "owner_intake").catch(() => ""),
    ]);
    const lastOwner = [...plan.messages].reverse().find((m) => m.senderType === "lead")?.text ?? "";
    const out = await chatCompletion({
      model: WRITER_MODEL,
      label: "listing:inspection-ask-insert",
      max_tokens: 500,
      temperature: 0.3,
      system: `You are Yudi, the listing agent at Unicorn Property in Bali, finishing your own WhatsApp reply to a villa owner's side. The draft below is yours and stays as it is: every sentence verbatim. It is missing one thing: asking the villa side to let you come to the villa to inspect it (walk it, take your own photos and a short video). Insert ONE sentence (two at most) that asks it, where it reads naturally, in the draft's language, the way you ask it yourself.${yudiExamplesBlock(examples, "asks villa owners to let him come and inspect")}
Your free times; offer one or two as a question, never as a booking:
${timesLines(plan)}
Do not ask for anything else: no photos, video, price, commission, bedrooms, dates or pin. No dashes, no links.${lessons}${LESSON_PRECEDENCE}
Return the full message and nothing else.`,
      messages: [{ role: "user", content: `Villa side's last message: ${lastOwner.slice(-400)}\n\nYour draft:\n${text}` }],
    });
    const rewritten = sanitizeSuggestion(out.content ?? "").trim();
    const problems = bookingTextProblems(rewritten, plan.lang, text);
    if (rewritten.length >= Math.floor(text.length * 0.8) && problems.length === 0) {
      logger.info({ leadId: plan.leadId }, "inspection booking: one ask added to the LIVE reply in Yudi's voice");
      return rewritten;
    }
    logger.warn({ leadId: plan.leadId, problems, kept: rewritten.length >= Math.floor(text.length * 0.8) }, "inspection booking: LIVE insertion did not pass — reply goes as written");
    return text;
  } catch (err) {
    logger.warn({ err, leadId: plan.leadId }, "inspection booking: LIVE insertion failed (non-fatal)");
    return text;
  }
}

/** The PUSH draft: one message asking to come, in Yudi's words. Two attempts; null when neither passes the checks. */
export async function writeInspectionAskDraft(plan: BookingPlan): Promise<{ text: string | null; problems: string[] }> {
  const villa = villaFromLeadName(await fetchLeadTitle(plan.leadId));
  const owner = await fetchOwnerName(plan.leadId, villa);
  const [examples, lessons] = await Promise.all([
    yudiInspectionAskExamples({ lang: plan.lang, limit: 6 }),
    correctionsPromptBlock(plan.responsibleUser ?? LISTING_AGENT_BROKER, "owner_intake").catch(() => ""),
  ]);
  const round =
    plan.round > 1
      ? `This is follow-up ${plan.round - 1} of 2: you asked ${ago(plan.lastAskAt)} and they have not answered. Open it like a new message (greet them${owner ? `, ${owner}` : ""}), refer to your earlier question in a few words, offer the times, shorter than a first ask.`
      : "This is your first ask for the visit in this conversation. It goes out days after the last message: open with a greeting (and their name if you know it), never with thanks or \"baik\" answering an old line.";
  const system = `You are Yudi, the listing agent at Unicorn Property in Bali. You write ONE WhatsApp message from your own phone to the owner's side of ${villa && villa !== "your villa" ? villa : "their villa"}${owner ? ` (${owner})` : ""}. The villa is qualified and already on our website as pre-listed. Before it goes fully live you visit it yourself: walk it, take your own photos and a short video, note its condition. This message asks the villa side to let you come.${yudiExamplesBlock(examples, "asks villa owners to let him come and inspect")}
Your free times, from your inspection calendar. Offer one or two of them as a question, your way. Never present a time as booked, never mention other villas or why these times are free:
${timesLines(plan)}
${round}
Write in ${plan.lang === "id" ? "Indonesian" : "English"}, the language this villa side writes in, with the honorifics you use. No time-of-day greeting (selamat pagi / siang / sore, good morning): you may send the draft hours later; "Halo" / "Hi" works any time.
Do not say or imply the villa is not listed or not marketed yet: it is already on our website as pre-listed.
Do not ask for anything about the villa: not photos, a video, the price or commission, bedrooms, availability or dates, the minimum stay, sizes, documents or the location pin. It is settled, or you collect it at the visit.
Respect what the thread says about access: guests or a tenant in the villa, notice needed, times the villa side gave. If the thread makes these days impossible, ask which day suits them instead.
No dashes. No links. No listing codes. Do not sign with your name. As short as your own messages.${lessons}${LESSON_PRECEDENCE}
JSON only: {"message": "<the WhatsApp message>"}`;
  let problems: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const retry = attempt === 0 ? "" : `\n\nYour previous draft was rejected because ${problems.join("; ")}. Write it again and fix exactly that.`;
    const out = await chatCompletionJSON<{ message?: string }>({
      model: WRITER_MODEL,
      label: "listing:inspection-ask",
      max_tokens: 400,
      temperature: 0.4,
      system,
      messages: [{ role: "user", content: `THE CONVERSATION SO FAR (oldest first, Bali time):\n${transcript(plan.messages, 30).slice(-7000)}${retry}` }],
    }).catch(() => null);
    const text = sanitizeSuggestion(String(out?.message ?? "")).trim();
    problems = bookingTextProblems(text, plan.lang);
    if (problems.length === 0) return { text, problems };
  }
  logger.warn({ leadId: plan.leadId, problems }, "inspection booking: no draft passed the checks");
  return { text: null, problems };
}

// ── the pass ──────────────────────────────────────────────────────────────────

export type BookingPassDecision = {
  leadId: string;
  card: string;
  mode: BookingMode;
  pushDue: boolean;
  round: number;
  lang: OwnerLang;
  reason: string;
  listing: string | null;
  stance: string | null;
  asks: Array<{ at: string; text: string }>;
  times: Array<{ label: string; why: string }>;
  draft: string | null;
  problems: string[];
  queued: boolean;
};

/** handover-draft.ts HANDOVER_VERDICT, inlined: importing that module here would close an import cycle. */
const HANDOVER_VERDICT = "handed over to the broker";

async function queueAskDraft(plan: BookingPlan, text: string): Promise<string | null> {
  // The handover draft is the handover pass's own marker for "this card has its next step". Retiring it
  // (first live pass, 14.09 16:38) made that pass write a new LIVE draft two minutes later, and a LIVE
  // queueSuggestion deletes every pending PUSH on the card: 3 of the 4 booking drafts vanished. So a
  // pending handover draft is kept and its TEXT becomes the ask, in place; nothing else is written.
  const handRes = await db
    .execute(sql`SELECT id FROM pending_suggestions WHERE lead_id = ${plan.leadId} AND status = 'pending'
                   AND autopilot_skipped_reason = ${HANDOVER_VERDICT} ORDER BY created_at DESC LIMIT 1`)
    .catch(() => null);
  const handoverId = (handRes?.rows?.[0] as { id?: string } | undefined)?.id ?? null;
  // Any other pending draft competes with the ask: an owner nudge (they stop at QUALIFIED since 14.09) or
  // a LIVE draft already answered by a later message of ours.
  await db
    .execute(sql`UPDATE pending_suggestions
                    SET status = 'skipped', autopilot_skipped_at = now(),
                        autopilot_skipped_reason = ${`superseded by the ${INSPECTION_ASK_VERDICT} (round ${plan.round})`}
                  WHERE lead_id = ${plan.leadId} AND status = 'pending'
                    AND coalesce(autopilot_skipped_reason, '') NOT LIKE ${`${INSPECTION_ASK_VERDICT}%`}
                    AND coalesce(autopilot_skipped_reason, '') <> ${HANDOVER_VERDICT}`)
    .catch((err) => logger.warn({ err, leadId: plan.leadId }, "inspection booking: competing drafts not retired"));
  const ins = handoverId
    ? await db
        .execute(sql`UPDATE pending_suggestions SET suggestion_text = ${text}, attachments = NULL, suggested_stage = NULL, suggested_stage_id = NULL,
                            suggested_stage_reason = NULL, suggested_stage_terminal = NULL
                      WHERE id = ${handoverId}::uuid AND status = 'pending' RETURNING id`)
        .catch((err) => {
          logger.error({ err, leadId: plan.leadId }, "inspection booking: handover draft not rewritten");
          return null;
        })
    : await db
        .execute(sql`INSERT INTO pending_suggestions (lead_id, responsible_user, kind, suggestion_text, status, autopilot_skipped_reason, autopilot_skipped_at)
                     VALUES (${plan.leadId}, ${plan.responsibleUser}, 'push', ${text}, 'pending', ${`${INSPECTION_ASK_VERDICT} · round ${plan.round}/${MAX_ASKS}`}, now())
                     RETURNING id`)
        .catch((err) => {
          logger.error({ err, leadId: plan.leadId }, "inspection booking: draft not queued");
          return null;
        });
  const id = (ins?.rows?.[0] as { id?: string } | undefined)?.id ?? null;
  if (!id) return null;
  await db
    .execute(sql`INSERT INTO listing_inspection_asks (lead_id, round, suggestion_id, text, times, lang)
                 VALUES (${plan.leadId}, ${plan.round}, ${id}::uuid, ${text}, ${JSON.stringify(plan.times.map((t) => ({ at: t.at.toISOString(), label: t.label, why: t.why })))}::jsonb, ${plan.lang})`)
    .catch((err) => logger.warn({ err, leadId: plan.leadId }, "inspection booking: ask log row not written"));
  return id;
}

/**
 * Every QUALIFIED listing card (or `leads`): decide, and with `generate` write the draft, with `apply`
 * queue it for Yudi. Dry by default. Never sends anything.
 */
export async function runInspectionBookingPass(o: { apply: boolean; generate?: boolean; leads?: string[] }): Promise<BookingPassDecision[]> {
  let ids = o.leads ?? [];
  if (!o.leads) {
    const res = await db.execute(sql`
      SELECT lead_id FROM leads_sync
       WHERE lower(coalesce(pipeline, '')) = 'rental listings' AND lead_stage ILIKE '%qualified%'
       ORDER BY last_our_message_at NULLS FIRST`);
    ids = ((res.rows ?? []) as Array<{ lead_id: string }>).map((r) => r.lead_id);
  }
  const out: BookingPassDecision[] = [];
  let drafted = 0;
  for (const leadId of ids) {
    try {
      const plan = await bookingPlan(leadId);
      const d: BookingPassDecision = {
        leadId,
        card: `https://unicornproperty.amocrm.ru/leads/detail/${leadId}`,
        mode: plan.mode,
        pushDue: plan.pushDue,
        round: plan.round,
        lang: plan.lang,
        reason: plan.reason,
        listing: plan.listing ? `${plan.listing.code}: ${plan.listing.readiness}` : null,
        stance: plan.stance ? `${plan.stance.stance}${plan.stance.notBefore ? ` from ${plan.stance.notBefore.toISOString().slice(0, 10)}` : ""} (${plan.stance.why})` : null,
        asks: plan.asks.map((a) => ({ at: fmtDay(a.at), text: a.text })),
        times: plan.times.map((t) => ({ label: t.label, why: t.why })),
        draft: null,
        problems: [],
        queued: false,
      };
      if (plan.pushDue && (o.generate || o.apply) && drafted < BATCH_LIMIT) {
        drafted++;
        const w = await writeInspectionAskDraft(plan);
        d.draft = w.text;
        d.problems = w.problems;
        if (o.apply && w.text) d.queued = !!(await queueAskDraft(plan, w.text));
      }
      logger.info(
        { leadId, mode: d.mode, pushDue: d.pushDue, round: d.round, queued: d.queued, listing: d.listing, stance: d.stance },
        `inspection booking: ${leadId} ${d.mode}${d.queued ? " — draft queued" : ""} — ${d.reason}`,
      );
      out.push(d);
    } catch (err) {
      logger.error({ err, leadId }, "inspection booking: card failed");
    }
  }
  const queued = out.filter((d) => d.queued).length;
  if (o.apply && queued > 0) {
    await notifyBroker(
      LISTING_AGENT_BROKER,
      "Inspection asks ready",
      `${queued} villa owner${queued === 1 ? "" : "s"} to book an inspection with: drafts in PUSH`,
    ).catch(() => 0);
  }
  return out;
}

let running = false;

export function startInspectionBookingPass(): void {
  const tick = () => {
    const h = new Date(Date.now() + BALI_MS).getUTCHours();
    if (running || h < DRAFT_HOURS.open || h >= DRAFT_HOURS.close) return;
    running = true;
    runInspectionBookingPass({ apply: true })
      .then((ds) => logger.info({ cards: ds.length, due: ds.filter((d) => d.pushDue).length, queued: ds.filter((d) => d.queued).length }, "inspection booking pass complete"))
      .catch((err) => logger.error({ err }, "inspection booking pass failed"))
      .finally(() => {
        running = false;
      });
  };
  setTimeout(tick, 2 * MIN);
  setInterval(tick, PASS_EVERY_MS);
}
