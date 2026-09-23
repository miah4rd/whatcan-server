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
import { ownLineSession } from "./wa-own-line-ids";

/** Meta tolerates far more than this; the point is to stay unremarkable. */
/**
 * Opening a conversation with a stranger is the only outbound Meta actually
 * polices: a number that starts many new threads a day gets read as spam and
 * blocked. Replying to someone who has written to us is not the same act and
 * carries no such ceiling, which is why this budget counts FIRST messages only.
 * Nine is the owner's figure (2026-09-03).
 *
 * LIFTED FOR AMELIA'S LINE ONLY, owner, 18-19.09.2026: "снять лимит только у
 * Амелии в воронке рентал, у Юди лимит остается" — ad-lead volume is controlled
 * at the source (lead generation). See UNCAPPED_LINES below; every other line
 * keeps this nine.
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

/**
 * Yudi 2 (900002, own bridge) after WhatsApp's 403 of 21.09.2026 — nine cold first contacts in one
 * 10:00 burst on a three-day-old number. Owner, 22.09: start at 3 a day and climb slowly to nine.
 * Warm-up practice for a fresh number (Green API, Whapi, WADesk guides): under ten new chats a day,
 * spread over the day, at least ten days before full volume, "25-30 days of no suspicious activity"
 * before the number is trusted. So: 3 for three days, 5 for four, 7 for four, then 9 from day 12.
 * Day 1 = the Bali date the line is re-linked (set it here the day Yudi scans the QR again).
 */
const LINE_WARMUP_LADDER: Record<number, { start: string; steps: Array<[lastDay: number, cap: number]> }> = {
  // Owner, 22.09: "номер работает сегодня, аккуратно начинать".
  900002: { start: "2026-09-22", steps: [[3, 3], [7, 5], [11, 7]] },
};

/**
 * Minutes between two first contacts on a warming line. The 403 came ten minutes after nine cold
 * messages left inside one minute; a person opens chats one at a time over the day. A line listed
 * here opens its next conversation only this long after its previous one (plus up to half again
 * at random, so the pattern is not a metronome).
 */
const LINE_MIN_GAP_MIN: Record<number, number> = {
  900002: 45,
};

function baliDateString(now: Date): string {
  return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * Lines that keep their existing conversations but open no new ones. Yudi 2
 * (62585), 13.09 15:10–15:30: 4 of its first 6 contacts got WAhelp's "WhatsApp
 * is not installed on this number" — all ordinary Indonesian mobiles — where
 * Yudi's first line saw 0–3 of 9–13 a day all week. Held until that is
 * explained; a card that notice closes may be a live owner.
 */
// 900002 (Yudi 2, own bridge): WhatsApp refused the session (403) on 21.09.2026
// at 10:12 Bali, ten minutes after nine cold first contacts left in a burst on a
// three-day-old number. Held until the owner decides.
// Lifted 22.09 onto the warm-up ladder above.
const NO_NEW_CONTACTS = new Set<number>([62585]);

/**
 * A ONE-DAY exception, granted by name, never a new rule.
 *
 * Owner, 2026-09-16: five cards of the 2BR / 30-50M / Seseh belt — the deficit
 * cell the scout scored at up to 5.00 (five requests against one listing) —
 * were all stamped "waiting for tomorrow's new-contact budget" while the day's
 * nine had gone to Kerobokan, Pererenan and Umalas. He approved going past the
 * nine for THIS Bali day only, and said in the same breath not to break the
 * rule systemically. So the rule above is untouched and this is keyed by the
 * Bali DATE: it expires by itself at midnight, nobody has to remember to undo
 * it, and a forgotten override cannot quietly become the standing limit.
 *
 * Anything here needs a date, a line, and a number someone actually approved.
 */
const ONE_DAY_CAP: Record<string, Record<number, number>> = {
  // Yudi's primary line: the usual nine plus the five Seseh-belt 2BR cards.
  "2026-09-16": { 59537: 14 },
  // Owner, 17.09: Aloma Villa (Cemagi 2BR) and Oemah David (Munggu 2BR) — the
  // Seseh-belt replacements for the two undeliverable cards — out of turn, now.
  "2026-09-17": { 59537: 10 },
  // Owner, 19.09: Yudi 2 (own bridge, 900002) went live today with one first
  // contact (23608383, delivered, in the card's chat), then the rest of its nine.
  "2026-09-19": { 900002: 9 },
};

/**
 * Lines with no daily ceiling. Owner, 18-19.09.2026: only Amelia's line (Rental
 * clients from the ads, whose volume he controls from lead generation). Yudi's
 * line opens cold conversations with villa owners — the outreach Meta polices —
 * and keeps its nine.
 */
const UNCAPPED_LINES = new Set<number>([56811, 900001]);

/** How many first contacts this line may open today. */
export function dailyCapForLine(line: number | null, now: Date = new Date()): number {
  if (line !== null && NO_NEW_CONTACTS.has(line)) return 0;
  if (line !== null && UNCAPPED_LINES.has(line)) return Number.MAX_SAFE_INTEGER;
  // A held line stays held: the exception raises a cap, it never opens a line
  // that was deliberately closed.
  const granted = line !== null ? ONE_DAY_CAP[baliDateString(now)]?.[line] : undefined;
  if (granted !== undefined) return granted;
  const ladder = line !== null ? LINE_WARMUP_LADDER[line] : undefined;
  if (ladder) {
    const d = Math.round((Date.parse(baliDateString(now)) - Date.parse(ladder.start)) / 86_400_000) + 1;
    if (d < 1) return 0;
    for (const [lastDay, cap] of ladder.steps) if (d <= lastDay) return cap;
    return NEW_CONTACT_DAILY_CAP;
  }
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
/**
 * A line on our own bridge opens nothing while its WhatsApp session is not linked and open: on 21.09
 * WhatsApp unlinked Yudi 2 (403) and the gateway dropped the session, so a first contact routed there
 * would only fail. Read from the gateway, cached a minute; unreadable = not open (fail closed — the
 * primary line still sends).
 */
let bridgeCache: { at: number; open: Set<string> } | null = null;
async function openBridgeSessions(): Promise<Set<string>> {
  if (bridgeCache && Date.now() - bridgeCache.at < 60_000) return bridgeCache.open;
  const open = new Set<string>();
  try {
    const res = await fetch(`${process.env.WA_GATEWAY_URL ?? "http://127.0.0.1:3100"}/sessions`, {
      headers: { "x-wa-secret": process.env.WA_GATEWAY_SECRET ?? "" },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) for (const x of (await res.json()) as Array<{ name: string; status: string }>) if (x.status === "open") open.add(x.name);
  } catch {
    /* gateway down: nothing on it is open */
  }
  bridgeCache = { at: Date.now(), open };
  return open;
}

export type LineBudget = {
  line: number | null;
  used: number;
  cap: number;
  /** May this line open a conversation RIGHT NOW: budget left and, on a warming line, its gap since the last one passed. */
  open: boolean;
  /** When a spaced line may open its next one (epoch ms), if it is waiting on the gap. */
  nextAt?: number;
};

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
  const lastAt = new Map<number | null, number>();
  try {
    const res = await db.execute(sql`
      SELECT f.source_id, (extract(epoch from f.created_at) * 1000)::float8 AS at_ms FROM (
        SELECT DISTINCT ON (lead_id) lead_id, created_at, responsible_user, source_id
        FROM sent_messages
        -- Only a send the channel accepted. A number with no WhatsApp, or a send our
        -- own line could not make, opened no conversation and must not spend the day's
        -- budget (owner, 23.09.2026; the same rule the hardcoded list below encodes).
        WHERE webhook_status BETWEEN 200 AND 299
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
    type Row = { source_id: string | null; at_ms: number | null };
    const rows = ((res as unknown as { rows?: Row[] }).rows ?? (Array.isArray(res) ? (res as unknown as Row[]) : []));
    for (const r of rows) {
      const stamped = r.source_id !== null ? Number(r.source_id) : null;
      const line = stamped !== null && lines.includes(stamped) ? stamped : lines[0]!;
      used.set(line, (used.get(line) ?? 0) + 1);
      const at = r.at_ms !== null ? Number(r.at_ms) : 0;
      if (at > (lastAt.get(line) ?? 0)) lastAt.set(line, at);
    }
  } catch (err) {
    // Fail OPEN: this is a politeness cap, not a safety guard. Silently
    // strangling every automatic first message because one query failed would
    // cost real leads, and the broker would see only silence.
    logger.warn({ err, responsibleUser }, "new-contact budget: count failed — allowing the send");
  }
  const bridgeOpen = lines.some((l) => ownLineSession(l)) ? await openBridgeSessions() : new Set<string>();
  return lines.map((line) => {
    const u = used.get(line) ?? 0;
    const session = ownLineSession(line);
    if (session && !bridgeOpen.has(session)) return { line, used: u, cap: dailyCapForLine(line, now), open: false };
    const cap = dailyCapForLine(line, now);
    const gapMin = line !== null ? LINE_MIN_GAP_MIN[line] : undefined;
    const last = lastAt.get(line);
    if (!gapMin || !last || u >= cap) return { line, used: u, cap, open: u < cap };
    // Up to half the gap again, derived from the last send's own time so it is stable between
    // checks (a random draw per check would let the next one through on the first lucky roll).
    const jitter = ((last / 1000) % 97) / 97 / 2;
    const nextAt = last + gapMin * 60_000 * (1 + jitter);
    return { line, used: u, cap, open: now.getTime() >= nextAt, nextAt };
  });
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
  return (await lineBudgets(responsibleUser)).find((b) => b.open)?.line ?? null;
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
  if (!lines.some((b) => b.open)) {
    const spaced = lines.find((b) => b.used < b.cap && b.nextAt);
    if (spaced) {
      logger.info(
        { responsibleUser, line: spaced.line, nextAt: new Date(spaced.nextAt!).toISOString() },
        "new-contact budget: a warming line is waiting out its gap between first contacts",
      );
      return { ok: false, used, cap, lines };
    }
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
