import { logger } from "./logger";

/**
 * Whether the model is answering at all.
 *
 * On 2026-08-20 the Anthropic credit balance ran out and generation stopped
 * dead for roughly two hours. 38 leads got no draft. Nothing anywhere said so:
 * from the outside a broken bot and a quiet morning look identical, and the
 * owner only found out because someone happened to read the logs. This module
 * is the half that notices; ai-watchdog.ts is the half that tells someone.
 *
 * State is in memory on purpose. It answers "is it working RIGHT NOW", which a
 * restart cannot make stale — a restarted process re-learns within one call.
 */

export type AiFailureKind = "credit" | "auth" | "rate_limit" | "overloaded" | "bad_request" | "other";

/** Failures older than this stop counting toward "it is broken". */
const WINDOW_MS = 15 * 60 * 1000;
/** One blip is not an outage. */
const FAILURES_FOR_OUTAGE = 3;

let lastSuccessAt: number | null = null;
let lastFailureAt: number | null = null;
let lastFailureKind: AiFailureKind | null = null;
let lastFailureMessage: string | null = null;
let failureTimes: number[] = [];
let totalSuccesses = 0;
let totalFailures = 0;

/**
 * The kind decides what the alert tells the owner to DO. "Top up the balance"
 * and "the key is wrong" are different mornings, and a generic "AI is down"
 * makes him go and find that out himself.
 */
export function classifyAiFailure(err: unknown): AiFailureKind {
  const message = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
  const status = (err as { status?: number } | null)?.status;

  if (message.includes("credit balance") || message.includes("billing")) return "credit";
  if (status === 401 || status === 403 || message.includes("invalid x-api-key") || message.includes("authentication")) return "auth";
  if (status === 429 || message.includes("rate limit")) return "rate_limit";
  if (status === 529 || message.includes("overloaded")) return "overloaded";
  if (status === 400) return "bad_request";
  return "other";
}

export function recordAiSuccess(): void {
  lastSuccessAt = Date.now();
  totalSuccesses += 1;
  failureTimes = [];
}

export function recordAiFailure(err: unknown): void {
  const now = Date.now();
  lastFailureAt = now;
  lastFailureKind = classifyAiFailure(err);
  lastFailureMessage = (err instanceof Error ? err.message : String(err ?? "")).slice(0, 300);
  totalFailures += 1;
  failureTimes.push(now);
  if (failureTimes.length > 200) failureTimes = failureTimes.slice(-200);
}

export type AiHealth = {
  ok: boolean;
  /** True only when calls are being MADE and failing — silence is not a fault. */
  outage: boolean;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastFailureKind: AiFailureKind | null;
  lastFailureMessage: string | null;
  recentFailures: number;
  minutesSinceLastSuccess: number | null;
  totalSuccesses: number;
  totalFailures: number;
};

export function aiHealth(): AiHealth {
  const now = Date.now();
  const recent = failureTimes.filter((t) => now - t <= WINDOW_MS);
  // A period with no traffic at all must never raise an alarm: at 04:00 nobody
  // is writing to us and there is nothing wrong. An outage is failures piling
  // up while nothing succeeds.
  const succeededRecently = lastSuccessAt !== null && now - lastSuccessAt <= WINDOW_MS;
  const outage = recent.length >= FAILURES_FOR_OUTAGE && !succeededRecently;

  return {
    ok: !outage,
    outage,
    lastSuccessAt,
    lastFailureAt,
    lastFailureKind,
    lastFailureMessage,
    recentFailures: recent.length,
    minutesSinceLastSuccess: lastSuccessAt === null ? null : Math.round((now - lastSuccessAt) / 60000),
    totalSuccesses,
    totalFailures,
  };
}

/** What to tell the owner, in the words that name the fix. */
export function outageHeadline(h: AiHealth): { title: string; body: string } {
  const mins = h.minutesSinceLastSuccess;
  const since = mins === null ? "since this server started" : `for ${mins} min`;
  switch (h.lastFailureKind) {
    case "credit":
      return {
        title: "Copilot is down — top up Anthropic",
        body: `No AI replies ${since}. The Anthropic credit balance is empty. Add funds in the Console and it resumes on its own.`,
      };
    case "auth":
      return {
        title: "Copilot is down — API key rejected",
        body: `No AI replies ${since}. Anthropic is refusing the API key. Check ANTHROPIC_API_KEY on the server.`,
      };
    case "rate_limit":
      return {
        title: "Copilot is throttled",
        body: `No AI replies ${since}. Anthropic is rate-limiting us. It usually clears itself; if not, the workspace limit needs raising.`,
      };
    case "overloaded":
      return {
        title: "Copilot is down — Anthropic overloaded",
        body: `No AI replies ${since}. Anthropic is overloaded and rejecting calls. Nothing to do on our side yet.`,
      };
    default:
      return {
        title: "Copilot is down",
        body: `No AI replies ${since}. Last error: ${h.lastFailureMessage ?? "unknown"}`,
      };
  }
}

export function logAiHealth(h: AiHealth): void {
  logger.error(
    {
      kind: h.lastFailureKind,
      recentFailures: h.recentFailures,
      minutesSinceLastSuccess: h.minutesSinceLastSuccess,
      lastError: h.lastFailureMessage,
    },
    "AI OUTAGE — no successful model call",
  );
}
