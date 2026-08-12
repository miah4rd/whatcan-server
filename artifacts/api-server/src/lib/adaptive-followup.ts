/**
 * Adaptive follow-up cadence + priority ranking for active-funnel PUSH leads
 * (Contact Established / Needs Assessed / Options Sent).
 *
 * Two pure, AI-free pieces:
 *  1. computeNextFollowupDays() — how long to wait before the next touch, based
 *     on the silence streak, stage, freshness and (distilled) temperature. This
 *     replaces the old fixed [1,3,5] cadence. It's a "not before" floor.
 *  2. computePushPriority() — a numeric score for the daily ranking, so the
 *     scarce daily send-capacity goes to the most valuable leads. Includes an
 *     aging boost so nothing starves under load.
 *
 * Everything here is cheap computation over already-stored signals — no tokens.
 */

export type Temperature = "cold" | "warm" | "hot" | null | undefined;

/**
 * Brokers whose entire book of business is the Rental pipeline, not Unicorn.
 * Their leads would be wrongly Unicorn-filtered by the adaptive path below,
 * and pending-visibility.ts scopes them to Rental-only leads (live and push
 * alike) using this same set — one roster, two gates, so onboarding a new
 * 100%-Rental broker is a single-line change instead of a two-file hunt.
 *
 * Only for brokers with NO Unicorn leads at all. A broker who works BOTH
 * pipelines (e.g. Yudi) does not belong here — this is a hard exclusion, not
 * a view preference, and would permanently hide their Unicorn leads. Those
 * brokers instead use the pipeline switcher (?pipeline= on /api/suggestions).
 */
const RENTAL_SCOPED_BROKERS = new Set<string>(["hos"]);

/**
 * Case-insensitive on purpose. The broker name arrives spelled differently
 * depending on the surface: the extension reads it from amoCRM ("HoS"), the
 * mobile page from whatever the broker typed once ("Hos"). An exact match made
 * the same person adaptive on one device and not the other — which, via the
 * Unicorn-only filter downstream, silently emptied their Rental inbox on mobile
 * while the extension showed it fine.
 */
export function isRentalScopedBroker(user: string | null | undefined): boolean {
  return !!user && RENTAL_SCOPED_BROKERS.has(user.trim().toLowerCase());
}

/** Which funnels HoS may see — see lib/pipelines.ts for the single roster. */
export { isHosTrackedPipeline } from "./pipelines";

/**
 * Brokers for whom the adaptive follow-up system (lead profiles, adaptive
 * cadence, priority ranking, discard flags) is enabled. Rolled out from the
 * initial Robert+Amelia pilot to everyone except the Rental-scoped roster
 * above — every other broker is ~100% Unicorn, so the adaptive system is
 * safe and on for them.
 */
export function isAdaptiveBroker(user: string | null | undefined): boolean {
  return !!user && !isRentalScopedBroker(user);
}

// Base wait (days) indexed by silence streak = consecutive unanswered touches.
// streak 0 (just entered / just re-warmed) is fastest; each ignored touch stretches.
export const FOLLOWUP_INTERVAL_BY_STREAK_DAYS = [2, 4, 7, 14, 30];

export function baseFollowupIntervalDays(streak: number): number {
  if (streak <= 0) return FOLLOWUP_INTERVAL_BY_STREAK_DAYS[0]!;
  const i = Math.min(streak, FOLLOWUP_INTERVAL_BY_STREAK_DAYS.length - 1);
  return FOLLOWUP_INTERVAL_BY_STREAK_DAYS[i]!;
}

/** A lead is "fresh" (activation window) if created within this many days.
 * ~1 month = "came in this month" — leads created 22-30 days ago must still
 * count as fresh (they were sinking under the old 21-day cutoff). */
export const FRESH_LEAD_MAX_AGE_DAYS = 30;

/**
 * Daily PUSH cap — OFF (0 disables it entirely).
 *
 * It used to be 25 per broker. It came from the owner's own complaint that the
 * list never drained ("I follow up 5 and it still shows 30"), but it hid more
 * than it helped: the budget was per BROKER while the filtering happens per
 * PIPELINE, so one funnel could eat the whole day's allowance and a second
 * would show an empty tab with finished drafts sitting behind it — with no
 * indication that anything was being withheld. Owner's call: no caps.
 *
 * Set a number here again only with a way for the broker to SEE what is being
 * held back; silently withholding work is what made this a bug.
 */
export const PUSH_DAILY_CAP = 0;

/**
 * Days to wait before the next follow-up. `streak` should be the number of
 * consecutive unanswered touches INCLUDING the one just sent.
 */
export function computeNextFollowupDays(opts: {
  streak: number;
  leadStage: string | null | undefined;
  temperature?: Temperature;
  ageDays?: number | null;
}): number {
  let days = baseFollowupIntervalDays(opts.streak);
  const stage = (opts.leadStage ?? "").toLowerCase();
  const age = opts.ageDays ?? 9999;
  const isFresh = age <= FRESH_LEAD_MAX_AGE_DAYS;
  const isNearClosing = /zoom call|viewing|reservation|negotiat|feedback|handling objection/.test(stage);
  // A lead that's been in the funnel well past the activation window and is NOT
  // in a deal-progression stage: any "hot"/"warm" label it still carries is very
  // likely stale (nobody re-profiled it). Re-engaging such a lead every 2 days is
  // exactly what looked "non-adaptive" — a lead untouched for ~2 months should be
  // spaced out, not machine-gunned. So we (a) don't let a stale hot label collapse
  // the interval, and (b) give it real breathing room.
  const isStaleOld = age > 45 && !isFresh && !isNearClosing;

  // Cadence mirrors "cost of delay": the faster a lead decays if untouched, the
  // shorter the interval.
  //   • Fresh lead → speed-to-lead is the #1 conversion lever; keep it tight
  //     regardless of streak (activation window).
  //   • Hot / near-closing → strike while the intent/momentum is there — but only
  //     when the signal is credible (not a months-stale "hot" on a dormant lead).
  //   • Deal-progression stages → tight on the first touches.
  //   • Cold AND old → decays slowly, don't burn sends → stretch.
  if (stage.includes("needs assessed") && opts.streak <= 1 && !isStaleOld) days = Math.min(days, 2);
  else if (stage.includes("options sent") && opts.streak === 0 && !isStaleOld) days = Math.min(days, 3);

  if (isFresh) days = Math.min(days, 3);
  if (isNearClosing || (opts.temperature === "hot" && !isStaleOld)) days = Math.min(days, 2);

  // Cold + old → stretch. A FRESH lead is never stretched (freshness wins).
  if (opts.temperature === "cold" && !isFresh) days = Math.round(days * 1.5);

  // Long-dormant, non-progressing lead: give it a real gap (≥1 week) so a stale
  // warm/hot label can't keep it on a 2-3 day drip. Streak still stretches it
  // further from here (7 → 14 → 30) if it keeps ignoring us.
  if (isStaleOld) days = Math.max(days, 7);

  return Math.max(1, Math.min(days, 35));
}

/**
 * Priority score for the daily PUSH ranking. Higher = worked sooner.
 * Pure function of stored signals — safe to run over the whole base every day.
 */
export function computePushPriority(opts: {
  leadStage: string | null | undefined;
  temperature?: Temperature;
  potential?: number | null;
  openQuestion?: boolean | null;
  taskGroup: 1 | 2 | 3; // 1 = due today, 2 = overdue, 3 = no task
  streak: number;
  ageDays?: number | null;
  /** days a ready lead has been waiting past its eligible date (aging fairness) */
  daysWaitingPastEligible?: number;
  /** broker set this task by hand (not the bot) — strongest "work this now" signal */
  manualTask?: boolean | null;
}): number {
  // "Cost of delay" ranking: score ≈ how much we lose by NOT touching today.
  // Fresh leads must sit at the top (speed-to-lead is the #1 conversion lever);
  // the aging term is deliberately SMALL so an old overdue backlog can't bury
  // this month's leads (that inversion was the bug).
  let score = 0;
  const stage = (opts.leadStage ?? "").toLowerCase();
  const age = opts.ageDays ?? 9999;
  const isNearClosing = /zoom call|viewing|reservation|negotiat|feedback|handling objection/.test(stage);

  // ── Top boosts ────────────────────────────────────────────────────────────
  if (opts.manualTask) score += 100;            // broker explicitly said "work this"
  if (opts.temperature === "hot") score += 55;  // active buying intent — money on the table
  if (isNearClosing) score += 50;               // deal in motion, momentum at risk

  // Freshness — smooth decay by age: brand-new decays fastest, so it ranks
  // highest and fades over ~a month. day0 ≈ +55, day30 ≈ +1, older → 0.
  score += Math.max(0, 55 - age * 1.8);

  // Funnel intent — a lead who left a request / got options is more valuable
  // than a cold intro (they engaged), so these outrank plain Contact Established.
  if (stage.includes("options sent") || stage.includes("option send")) score += 30;
  else if (stage.includes("needs assessed")) score += 25;
  else if (stage.includes("contact established")) score += 10;

  // ── Temperature / potential ───────────────────────────────────────────────
  if (opts.temperature === "warm") score += 22;
  if (typeof opts.potential === "number") score += opts.potential * 0.25; // up to +25
  if (opts.openQuestion) score += 8;            // an unanswered real question is waiting

  // Task urgency is the broker's COMMITTED work — it must dominate. Due today is
  // top; recently overdue (yesterday / 2 days ago) is nearly as urgent and decays
  // as it ages, so an ancient overdue backlog can't bury today's and fresh leads
  // (that inversion — old dormant leads floating to the top — was the reported bug).
  const daysOverdue = Math.max(0, opts.daysWaitingPastEligible ?? 0);
  if (opts.taskGroup === 1) score += 50;                              // due today
  else if (opts.taskGroup === 2) score += Math.max(8, 45 - daysOverdue * 4); // overdue, recent first

  // ── Penalties: low cost of delay (dormant, fine to wait / cull candidates) ─
  if (opts.temperature === "cold" && age > 30) score -= 20;
  score -= Math.min(20, Math.max(0, (opts.streak ?? 0) - 2) * 4); // many ignored touches
  // Long-dormant lead with no live task is the lowest cost of delay — push it down
  // so this month's leads and today's tasks sit above it.
  if (age > 45 && opts.taskGroup === 3) score -= 15;

  // NOTE: the old "aging nudge" (+score the longer a lead waited) is deliberately
  // GONE — it rewarded staleness and floated the ancient backlog above today's
  // leads. Recent-overdue weighting above gives fairness without that inversion.

  return score;
}

/**
 * Adaptive daily cap. Base 25, flexes toward 30 when the pool is rich with
 * high-value leads, toward 20 when it's mostly low-value cold leads — so a busy
 * day of fresh leads gets a little more room and a stale day sends fewer
 * (WhatsApp-ban-safe). Returns 0 when disabled.
 */
export function computeDailyCap(opts: {
  configuredCap: number; // 0 = disabled (no hiding)
  eligibleCount: number;
  highValueCount: number; // leads scoring above the high-value threshold
}): number {
  if (opts.configuredCap <= 0) return 0;
  const base = opts.configuredCap;
  if (opts.eligibleCount === 0) return base;
  const highRatio = opts.highValueCount / opts.eligibleCount;
  // Rich day → +5, poor day → -5, around the configured base, clamped 20..30.
  const adjusted = highRatio >= 0.5 ? base + 5 : highRatio <= 0.2 ? base - 5 : base;
  return Math.max(20, Math.min(30, adjusted));
}

export const HIGH_VALUE_PRIORITY_THRESHOLD = 55;
