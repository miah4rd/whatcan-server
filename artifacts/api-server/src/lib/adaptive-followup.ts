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

  // Deal-progression stages stay tighter on the first touches — move it forward.
  if (stage.includes("needs assessed") && opts.streak <= 1) days = Math.min(days, 2);
  else if (stage.includes("options sent") && opts.streak === 0) days = Math.min(days, 3);

  // Cold AND old → stretch (stop wasting sends). But a FRESH lead is the
  // activation window — never stretch it, even if terse/cold. Freshness wins.
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
}): number {
  let score = 0;
  const stage = (opts.leadStage ?? "").toLowerCase();
  const isFresh = (opts.ageDays ?? 9999) <= FRESH_LEAD_MAX_AGE_DAYS;

  // Stage value (funnel progression bias). Fresh Contact Established is the
  // activation window and ranks high; stale CE ranks lower.
  if (stage.includes("needs assessed")) score += 40;
  else if (stage.includes("options sent")) score += 30;
  else if (stage.includes("contact established")) score += isFresh ? 35 : 20;
  else score += 15;

  // Temperature / latent potential (from the distilled profile).
  if (opts.temperature === "hot") score += 25;
  else if (opts.temperature === "warm") score += 12;
  if (typeof opts.potential === "number") score += opts.potential * 0.15; // up to +15

  // Unanswered real question waiting → nudge up.
  if (opts.openQuestion) score += 8;

  // Task urgency.
  if (opts.taskGroup === 1) score += 15;
  else if (opts.taskGroup === 2) score += 10;

  // Warmer streak (fewer ignored) ranks slightly higher.
  score += Math.max(0, 6 - opts.streak);

  // Aging fairness: the longer a ready lead waits unserved, the higher it climbs.
  score += Math.min(40, Math.max(0, opts.daysWaitingPastEligible ?? 0) * 2);

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
