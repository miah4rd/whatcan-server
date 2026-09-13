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
import { UNDELIVERABLE_LEAD_IDS } from "./undeliverable";
import { brokerLines } from "./amo-messenger-field";

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
 * A brand-new WhatsApp number is warmed up before it gets the full nine: Meta
 * is harshest on a fresh number that opens many conversations at once. Owner,
 * 2026-09-13, for Yudi's second line: 3 a day, then 6, then 9. Day 1 is the
 * date below (Bali calendar).
 */
const LINE_WARMUP_START: Record<number, string> = {
  62585: "2026-09-13",
};

function baliDateString(now: Date): string {
  return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** How many first contacts this line may open today. */
export function dailyCapForLine(line: number | null, now: Date = new Date()): number {
  const start = line !== null ? LINE_WARMUP_START[line] : undefined;
  if (!start) return NEW_CONTACT_DAILY_CAP;
  const day = Math.round((Date.parse(baliDateString(now)) - Date.parse(start)) / 86_400_000) + 1;
  if (day < 1) return 0;
  if (day <= 3) return 3;
  if (day <= 6) return 6;
  return NEW_CONTACT_DAILY_CAP;
}

/**
 * The hours in which the bot may OPEN a conversation with a stranger.
 *
 * The budget resetting at midnight meant the day's nine cold messages could
 * leave at 00:05 Bali, which is the owner's objection in his own words: do not
 * write to people at night. It is also the worst possible first impression from
 * an agency nobody has heard of yet.
 *
 * So no unattended PROACTIVE first contact (autopilot) goes out before 10:00 or
 * after 20:00. This governs COLD outreach only — a reply to someone already
 * talking to us is reactive and has no such window, and a broker tapping
 * Approve is never blocked by any of this.
 *
 * The COUNT is a separate thing and runs by the calendar day (owner,
 * 2026-09-12: "лимит 9 в сутки, новый день — новый лимит"). It used to start
 * at 10:00, so a client who filled the form at 03:30 was still billed to the
 * previous day and got no welcome (Lance, 23547879).
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
 * Leads that received their VERY FIRST message from us today (Bali calendar
 * day, from 00:00) on this broker's line. A lead we have written to before does
 * not count however many messages it got today — repeat contact is not what
 * gets a number flagged.
 */
export type LineBudget = { line: number | null; used: number; cap: number };

/**
 * Today's first contacts per WhatsApp line of this broker, primary line first.
 *
 * The limit belongs to the LINE (owner, 2026-09-13: Yudi got a second number to
 * get a second nine). A first send is billed to the line stamped on it
 * (`sent_messages.source_id`); rows from before the stamp existed, or stamped
 * with a line that is not this broker's, are billed to the primary line — which
 * is exactly how every one of them was counted before. A broker with a single
 * line (or none we know) gets one bucket of nine, as always.
 */
export async function lineBudgets(responsibleUser: string | null, now: Date = new Date()): Promise<LineBudget[]> {
  const who = (responsibleUser ?? "").trim().toLowerCase();
  const lines: Array<number | null> = brokerLines(responsibleUser);
  if (lines.length === 0) lines.push(null);
  const used = new Map<number | null, number>(lines.map((l) => [l, 0]));
  try {
    const res = await db.execute(sql`
      SELECT f.source_id FROM (
        SELECT DISTINCT ON (lead_id) lead_id, created_at, responsible_user, source_id
        FROM sent_messages
        ORDER BY lead_id, created_at ASC
      ) f
      WHERE f.created_at >= (date_trunc('day', now() AT TIME ZONE ${TZ}) AT TIME ZONE ${TZ})
        AND lower(coalesce(f.responsible_user, '')) = ${who}
        -- A number with no WhatsApp on it received nothing. Meta cannot have
        -- scored a conversation that never opened, so it must not spend the
        -- day's budget: "была попытка связаться, но связи не было".
        AND f.lead_id NOT IN ${UNDELIVERABLE_LEAD_IDS}
        -- Sends we know never left (re-keyed after the fact, e.g. the three
        -- Yudi 2 sends of 13.09 that Salesbot had no branch for).
        AND f.lead_id NOT LIKE 'undelivered-%'
    `);
    const rows = ((res as unknown as { rows?: Array<{ source_id: string | null }> }).rows ??
      (Array.isArray(res) ? (res as unknown as Array<{ source_id: string | null }>) : []));
    for (const r of rows) {
      const stamped = r.source_id !== null ? Number(r.source_id) : null;
      const line = stamped !== null && lines.includes(stamped) ? stamped : lines[0]!;
      used.set(line, (used.get(line) ?? 0) + 1);
    }
  } catch (err) {
    // Fail OPEN: this is a politeness cap, not a safety guard. Silently
    // strangling every automatic first message because one query failed would
    // cost real leads, and the broker would see only silence.
    logger.warn({ err, responsibleUser }, "new-contact budget: count failed — allowing the send");
  }
  return lines.map((line) => ({ line, used: used.get(line) ?? 0, cap: dailyCapForLine(line, now) }));
}

/** Leads this broker opened today across all of their lines. */
export async function newContactsToday(responsibleUser: string | null): Promise<number> {
  return (await lineBudgets(responsibleUser)).reduce((n, b) => n + b.used, 0);
}

/**
 * The line a first contact should go out on right now: the first of the
 * broker's lines with budget left, so the primary fills before the second one
 * opens. Null when every line is spent today.
 */
export async function pickLineForNewConversation(responsibleUser: string | null): Promise<number | null> {
  return (await lineBudgets(responsibleUser)).find((b) => b.used < b.cap)?.line ?? null;
}

export type NewContactBudget = { ok: boolean; used: number; cap: number; lines: LineBudget[] };

/**
 * May an UNATTENDED path open a new conversation on one of this broker's lines?
 * Callers that are refused must leave the draft in the inbox, never drop it —
 * the broker can still send it by hand, which is exactly the intended escape.
 * Which line it goes out on is decided at the send itself (resolveSendChannel).
 */
export async function mayOpenNewConversation(
  responsibleUser: string | null,
): Promise<NewContactBudget> {
  const lines = await lineBudgets(responsibleUser);
  const used = lines.reduce((n, b) => n + b.used, 0);
  const cap = lines.reduce((n, b) => n + b.cap, 0);
  if (!lines.some((b) => b.used < b.cap)) {
    logger.warn(
      { responsibleUser, used, cap, lines },
      "new-contact budget spent for today — the draft stays in the inbox for the broker to send by hand",
    );
    return { ok: false, used, cap, lines };
  }
  return { ok: true, used, cap, lines };
}

/** Have we ever sent this lead anything? Cheap, and the only thing that makes a send "new". */
export async function isFirstOutbound(leadId: string): Promise<boolean> {
  try {
    // A first contact is a message to someone NOBODY here has talked to: no
    // send of ours (Copilot), no message of ours in the thread (the broker
    // writing from the phone counts), and nothing from them either — a reply
    // to a person who wrote to us is never budgeted (owner, 09.09.2026:
    // "ограничение только на отправку первым, повторные кто ответил — лимита
    // нет"). Reading sent_messages alone made three owner replies wait for
    // "tomorrow's budget" because Yudi had opened those threads by hand.
    const res = await db.execute(
      sql`SELECT 1 AS x
            WHERE EXISTS (SELECT 1 FROM sent_messages WHERE lead_id = ${leadId})
               OR EXISTS (SELECT 1 FROM lead_messages WHERE lead_id = ${leadId})
            LIMIT 1`,
    );
    return !firstRow<{ x: number }>(res);
  } catch (err) {
    // Unknown — treat as NOT a first contact so a failed lookup cannot spend
    // the day's budget on a lead we have already been talking to.
    logger.warn({ err, leadId }, "new-contact budget: first-outbound check failed");
    return false;
  }
}
