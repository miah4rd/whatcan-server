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
 * Brokers for whom the adaptive follow-up system (lead profiles, adaptive
 * cadence, priority ranking, discard flags) is enabled. Roll out to a new
 * broker by adding their exact amoCRM name here — every gate reads this set.
 */
export const ADAPTIVE_BROKERS = new Set<string>(["Robert", "Amelia"]);

export function isAdaptiveBroker(user: string | null | undefined): boolean {
  return !!user && ADAPTIVE_BROKERS.has(user);
}

// Base wait (days) indexed by silence streak = consecutive unanswered touches.
// streak 0 (just entered / just re-warmed) is fastest; each ignored touch stretches.
export const FOLLOWUP_INTERVAL_BY_STREAK_DAYS = [2, 4, 7, 14, 30];

export function baseFollowupIntervalDays(streak: number): number {
  if (streak <= 0) return FOLLOWUP_INTERVAL_BY_STREAK_DAYS[0]!;
  const i = Math.min(streak, FOLLOWUP_INTERVAL_BY_STREAK_DAYS.length - 1);
  return FOLLOWUP_INTERVAL_BY_STREAK_DAYS[i]!;
}

/** A lead is "fresh" (activation window) if created within this many days. */
export const FRESH_LEAD_MAX_AGE_DAYS = 21;

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
  const isFresh = (opts.ageDays ?? 9999) <= FRESH_LEAD_MAX_AGE_DAYS;
  const isNearClosing = /zoom call|viewing|reservation|negotiat|feedback|handling objection/.test(stage);

  // Cadence mirrors "cost of delay": the faster a lead decays if untouched, the
  // shorter the interval.
  //   • Fresh lead → speed-to-lead is the #1 conversion lever; keep it tight
  //     regardless of streak (activation window).
  //   • Hot / near-closing → strike while the intent/momentum is there.
  //   • Deal-progression stages → tight on the first touches.
  //   • Cold AND old → decays slowly, don't burn sends → stretch.
  if (stage.includes("needs assessed") && opts.streak <= 1) days = Math.min(days, 2);
  else if (stage.includes("options sent") && opts.streak === 0) days = Math.min(days, 3);

  if (isFresh) days = Math.min(days, 3);
  if (opts.temperature === "hot" || isNearClosing) days = Math.min(days, 2);

  // Cold + old → stretch. A FRESH lead is never stretched (freshness wins).
  if (opts.temperature === "cold" && !isFresh) days = Math.round(days * 1.5);

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
  // Big, well-separated tier boosts make it behave like a clear hierarchy while
  // the aging term keeps it smooth and starvation-free.
  let score = 0;
  const stage = (opts.leadStage ?? "").toLowerCase();
  const isFresh = (opts.ageDays ?? 9999) <= FRESH_LEAD_MAX_AGE_DAYS;
  const isNearClosing = /zoom call|viewing|reservation|negotiat|feedback|handling objection/.test(stage);

  // ── Top tiers (well separated so they dominate) ──────────────────────────
  if (opts.manualTask) score += 100;        // broker explicitly said "work this today"
  if (opts.temperature === "hot") score += 60;  // active buying intent — money on the table
  if (isNearClosing) score += 55;               // deal in motion, momentum at risk
  if (isFresh) score += 50;                      // speed-to-lead: freshness decays fastest

  // ── Mid ──────────────────────────────────────────────────────────────────
  if (opts.temperature === "warm") score += 25;
  if (typeof opts.potential === "number") score += opts.potential * 0.2; // up to +20
  if (opts.openQuestion) score += 8;            // an unanswered real question is waiting

  // Task urgency: due today > overdue > none.
  if (opts.taskGroup === 1) score += 20;
  else if (opts.taskGroup === 2) score += 12;

  // Light funnel-progression bias (CE freshness already boosted above).
  if (stage.includes("needs assessed")) score += 15;
  else if (stage.includes("options sent")) score += 12;
  else if (stage.includes("contact established")) score += 8;

  // ── Penalties: low cost of delay (fine to wait) ──────────────────────────
  if (opts.temperature === "cold" && !isFresh) score -= 12; // dormant, decays slowly
  score -= Math.min(15, Math.max(0, (opts.streak ?? 0) - 2) * 3); // many ignored touches

  // ── Aging fairness: the longer a ready lead waits unserved, the higher it
  // climbs — nothing starves at the bottom. ────────────────────────────────
  score += Math.min(50, Math.max(0, opts.daysWaitingPastEligible ?? 0) * 3);

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
