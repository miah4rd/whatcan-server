/**
 * How many people the bot may write to FOR THE FIRST TIME in one day.
 *
 * WhatsApp/Meta scores a number by how many conversations it OPENS, not by how
 * much it talks: replying to people who already wrote to us is normal traffic,
 * but a burst of first messages to strangers is what gets a line limited or
 * blocked. A broker paces that instinctively. The bot has no instinct, and the
 * paths that open conversations — the ad-lead welcome and autopilot — fire the
 * moment a lead lands, so a busy ad day could open dozens in an hour.
 *
 * Deliberately NOT applied to a broker tapping Approve: they know the state of
 * their own line and a refusal there would be the tool arguing with the person
 * responsible for it. This budget governs unattended sends only.
 *
 * Counted per responsible user, because each broker sends on their own
 * WhatsApp line and the limit is a property of the line, not of the company.
 *
 * Honest limit of this count: it can only see messages THIS system sent. A
 * first message a broker typed on their own phone is invisible here, so the
 * real number of conversations that line opened today can be higher.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

/** Meta tolerates far more than this; the point is to stay unremarkable. */
/**
 * Opening a conversation with a stranger is the only outbound Meta actually
 * polices: a number that starts many new threads a day gets read as spam and
 * blocked. Replying to someone who has written to us is not the same act and
 * carries no such ceiling, which is why this budget counts FIRST messages only.
 * Nine is the owner's figure (2026-09-03).
 */
export const NEW_CONTACT_DAILY_CAP = 9;

/** Bali — the day boundary the brokers actually live in. */
const TZ = "Asia/Makassar";

/**
 * The hours in which the bot may OPEN a conversation with a stranger.
 *
 * The budget resetting at midnight meant the day's nine cold messages could
 * leave at 00:05 Bali, which is the owner's objection in his own words: do not
 * write to people at night. It is also the worst possible first impression from
 * an agency nobody has heard of yet.
 *
 * So the counting day starts at 10:00 rather than at midnight, and no unattended
 * first contact goes out before 10:00 or after 20:00. This governs COLD outreach
 * only — a reply to someone already talking to us is reactive and has no such
 * window, and a broker tapping Approve is never blocked by any of this.
 */
export const OUTREACH_OPEN_HOUR = 10;
export const OUTREACH_CLOSE_HOUR = 20;

/** Bali's wall-clock hour right now. */
function baliHour(): number {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).getUTCHours();
}

/** Is it a decent hour in Bali to write to someone for the first time? */
export function withinOutreachHours(): boolean {
  const h = baliHour();
  return h >= OUTREACH_OPEN_HOUR && h < OUTREACH_CLOSE_HOUR;
}

function firstRow<T>(res: unknown): T | undefined {
  const withRows = res as { rows?: T[] };
  if (Array.isArray(withRows.rows)) return withRows.rows[0];
  if (Array.isArray(res)) return (res as T[])[0];
  return undefined;
}

/**
 * Leads that received their VERY FIRST message from us in the current outreach
 * day — which starts at 10:00 Bali, not at midnight — on this broker's line. A lead we have written to before does not count however many messages
 * it got today — repeat contact is not what gets a number flagged.
 */
export async function newContactsToday(responsibleUser: string | null): Promise<number> {
  const who = (responsibleUser ?? "").trim().toLowerCase();
  try {
    const res = await db.execute(sql`
      SELECT count(*)::int AS n FROM (
        SELECT DISTINCT ON (lead_id) lead_id, created_at, responsible_user
        FROM sent_messages
        ORDER BY lead_id, created_at ASC
      ) f
      WHERE f.created_at >= (
              CASE WHEN (now() AT TIME ZONE ${TZ})::time >= time '10:00'
                   THEN date_trunc('day', now() AT TIME ZONE ${TZ}) + interval '10 hours'
                   ELSE date_trunc('day', now() AT TIME ZONE ${TZ}) - interval '14 hours'
              END AT TIME ZONE ${TZ})
        AND lower(coalesce(f.responsible_user, '')) = ${who}
    `);
    return Number(firstRow<{ n: number }>(res)?.n ?? 0);
  } catch (err) {
    // Fail OPEN: this is a politeness cap, not a safety guard. Silently
    // strangling every automatic first message because one query failed would
    // cost real leads, and the broker would see only silence.
    logger.warn({ err, responsibleUser }, "new-contact budget: count failed — allowing the send");
    return 0;
  }
}

export type NewContactBudget = { ok: true; used: number } | { ok: false; used: number };

/**
 * May an UNATTENDED path open a new conversation on this broker's line?
 * Callers that are refused must leave the draft in the inbox, never drop it —
 * the broker can still send it by hand, which is exactly the intended escape.
 */
export async function mayOpenNewConversation(
  responsibleUser: string | null,
): Promise<NewContactBudget> {
  const used = await newContactsToday(responsibleUser);
  if (used >= NEW_CONTACT_DAILY_CAP) {
    logger.warn(
      { responsibleUser, used, cap: NEW_CONTACT_DAILY_CAP },
      "new-contact budget spent for today — the draft stays in the inbox for the broker to send by hand",
    );
    return { ok: false, used };
  }
  return { ok: true, used };
}

/** Have we ever sent this lead anything? Cheap, and the only thing that makes a send "new". */
export async function isFirstOutbound(leadId: string): Promise<boolean> {
  try {
    const res = await db.execute(
      sql`SELECT 1 AS x FROM sent_messages WHERE lead_id = ${leadId} LIMIT 1`,
    );
    return !firstRow<{ x: number }>(res);
  } catch (err) {
    // Unknown — treat as NOT a first contact so a failed lookup cannot spend
    // the day's budget on a lead we have already been talking to.
    logger.warn({ err, leadId }, "new-contact budget: first-outbound check failed");
    return false;
  }
}
