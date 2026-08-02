/**
 * Detects when a broker's outgoing message promises to come back with
 * specific information they don't have yet — "I'll check with the owner and
 * get back to you", "let me confirm availability and let you know". In that
 * case the client is left waiting on US, not the other way around, so the
 * standard "wait 24h for the client to reply" follow-up clock never fires:
 * nothing to fire. The broker has no way to see amoCRM tasks (he doesn't use
 * the CRM UI at all — he lives in the bot), so nothing ever reminded him
 * either. See lib/commitment-scheduler.ts for the delivery side.
 */
import { HELPER_MODEL, chatCompletionJSON } from "./ai-client";
import { logger } from "./logger";

export interface CommitmentCheck {
  /** Short RU phrase describing what was promised — shown back to the broker
   * in the reminder, so it must be enough to jog memory on its own: "уточнить
   * у хозяина, можно ли с животными", not just "уточнить детали". */
  promiseText: string;
  /** Broker-stated delay in hours if they named one ("к вечеру", "завтра"),
   * else null — caller applies the default. */
  hoursUntilDue: number | null;
}

const BALI_OFFSET_MS = 8 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const WAKING_START_HOUR = 8;
const WAKING_END_HOUR = 21;

/**
 * Pushes a due time that lands outside Bali waking hours (21:00–08:00) to the
 * next 08:00 Bali — a reminder that fires at 3am helps no one and trains the
 * broker to ignore push notifications from the bot.
 */
export function clampToBaliWakingHours(date: Date): Date {
  const baliMs = date.getTime() + BALI_OFFSET_MS;
  const baliHour = Math.floor((baliMs % (24 * HOUR_MS)) / HOUR_MS);
  if (baliHour >= WAKING_START_HOUR && baliHour < WAKING_END_HOUR) return date;

  const baliDayStart = Math.floor(baliMs / (24 * HOUR_MS)) * (24 * HOUR_MS);
  const targetBaliMs =
    baliHour < WAKING_START_HOUR
      ? baliDayStart + WAKING_START_HOUR * HOUR_MS
      : baliDayStart + 24 * HOUR_MS + WAKING_START_HOUR * HOUR_MS;
  return new Date(targetBaliMs - BALI_OFFSET_MS);
}

/**
 * Returns null when the message makes no such promise (the common case —
 * this must stay cheap and silent for ordinary replies).
 */
export async function detectCommitment(messageText: string): Promise<CommitmentCheck | null> {
  const text = messageText.trim();
  if (!text) return null;

  try {
    const parsed = await chatCompletionJSON<{
      isCommitment?: boolean;
      promiseText?: string;
      hoursUntilDue?: number | null;
    }>({
      model: HELPER_MODEL,
      label: "commitment-detect",
      system: `You read ONE outgoing message a real-estate broker just sent a client on WhatsApp.

Decide: does this message promise to come back LATER with a SPECIFIC piece of information the broker does not have right now — e.g. checking with the villa owner, confirming availability or price, verifying a document, asking someone else? Only that kind of promise counts.

Do NOT count: sending more listing options, generic closings ("let me know if you have questions"), answers that already contain the information, or vague friendliness with no concrete thing owed.

If the broker named a timeframe ("к вечеру", "завтра", "in an hour", "through 2 weeks"), convert it to hoursUntilDue (a number of hours from now). If no timeframe was named, hoursUntilDue is null.

promiseText: a short RUSSIAN phrase specific enough to jog the broker's memory later — name what info and about what (e.g. "уточнить у хозяина, можно ли с животными" not "уточнить детали").

Respond with JSON: {"isCommitment": boolean, "promiseText": string, "hoursUntilDue": number | null}`,
      messages: [{ role: "user", content: text }],
      max_tokens: 150,
      temperature: 0,
    });

    if (!parsed.isCommitment || !parsed.promiseText?.trim()) return null;

    const hours =
      typeof parsed.hoursUntilDue === "number" && Number.isFinite(parsed.hoursUntilDue)
        ? Math.min(72, Math.max(0.5, parsed.hoursUntilDue))
        : null;

    return { promiseText: parsed.promiseText.trim(), hoursUntilDue: hours };
  } catch (err) {
    logger.error({ err }, "detectCommitment failed (non-fatal)");
    return null;
  }
}
