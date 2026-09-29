/**
 * A WhatsApp number that was blocked comes back slowly.
 *
 * Owner, 29.09.2026, after WhatsApp refused Yudi's main number (403 at 10:10 Bali, the day after
 * ~75 messages left it in two hours): "set up a system that checks the account was blocked ... for
 * 24 hours, and to not get the same block again increase the amount of messages per day step by
 * step: first day three, then five, then seven, then nine".
 *
 * So, for every line on our own bridge:
 *   - the moment the gateway reports the number refused (403, "forbidden") or unlinked
 *     ("logged_out"), a block is recorded here;
 *   - a refused number is tried again 24 hours later, then every 6 hours, never sooner — knocking
 *     on a restricted account every minute is what keeps it restricted (an unlinked one needs a
 *     scan and is left to the owner's relink link);
 *   - the Bali day it opens again is day 1: 3 new first contacts, day 2 five, day 3 seven, and from
 *     day 4 the line's usual budget again. Replies to people who wrote to us and a broker's own
 *     Approve are not first contacts and are not held back (see new-contact-budget.ts).
 *
 * The ladder is applied on every line, Amelia's too: her "no limits" (18-19.09) is for a healthy
 * number; a number WhatsApp has just blocked is not one.
 */
import { pool } from "@workspace/db";
import { logger } from "./logger";
import { OWN_LINES } from "./wa-own-line-ids";

/** Day 1, 2, 3 after the number is back; from day 4 the line's own budget. Owner, 29.09.2026. */
export const BLOCK_RECOVERY_STEPS = [3, 5, 7] as const;
/** A refused number is not tried again before this, then at most this often. */
export const BLOCK_RETRY_AFTER_MS = 24 * 3600_000;
export const BLOCK_RETRY_EVERY_MS = 6 * 3600_000;

let ready: Promise<void> | null = null;
function ensure(): Promise<void> {
  if (!ready)
    ready = pool
      .query(
        `CREATE TABLE IF NOT EXISTS wa_line_blocks (
           id serial PRIMARY KEY,
           session text NOT NULL,
           status text NOT NULL,
           blocked_at timestamptz NOT NULL DEFAULT now(),
           last_retry_at timestamptz,
           reopened_at timestamptz
         );
         CREATE INDEX IF NOT EXISTS wa_line_blocks_open ON wa_line_blocks (session) WHERE reopened_at IS NULL;`,
      )
      .then(() => undefined)
      .catch((err) => {
        ready = null;
        throw err;
      });
  return ready;
}

/** The gateway said the number is refused or unlinked. One open block per session. */
export async function recordBlock(session: string, status: string): Promise<void> {
  await ensure();
  const r = await pool.query(
    `INSERT INTO wa_line_blocks (session, status)
     SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM wa_line_blocks WHERE session = $1 AND reopened_at IS NULL)
     RETURNING id`,
    [session, status],
  );
  if (r.rowCount) logger.error({ session, status }, "wa-line-block: number blocked — recovery ladder armed");
  cache = null;
}

/** The session is open again. Returns true when this closed a block (the ladder starts today). */
export async function recordOpen(session: string): Promise<boolean> {
  await ensure();
  const r = await pool.query(`UPDATE wa_line_blocks SET reopened_at = now() WHERE session = $1 AND reopened_at IS NULL RETURNING id`, [session]);
  cache = null;
  return (r.rowCount ?? 0) > 0;
}

/** Refused numbers whose 24 hours are up and whose last try is 6 hours old. Marks the try. */
export async function blocksDueForRetry(): Promise<string[]> {
  await ensure();
  const { rows } = await pool.query(
    `UPDATE wa_line_blocks SET last_retry_at = now()
      WHERE reopened_at IS NULL AND status = 'forbidden'
        AND blocked_at <= now() - make_interval(secs => $1)
        AND (last_retry_at IS NULL OR last_retry_at <= now() - make_interval(secs => $2))
      RETURNING session`,
    [BLOCK_RETRY_AFTER_MS / 1000, BLOCK_RETRY_EVERY_MS / 1000],
  );
  return rows.map((r) => String(r.session));
}

/** Is this session inside an open block (refused or unlinked, not back yet)? */
export async function openBlock(session: string): Promise<{ status: string; blockedAt: Date } | null> {
  await ensure();
  const { rows } = await pool.query(`SELECT status, blocked_at FROM wa_line_blocks WHERE session = $1 AND reopened_at IS NULL ORDER BY id DESC LIMIT 1`, [session]);
  return rows[0] ? { status: String(rows[0].status), blockedAt: new Date(rows[0].blocked_at) } : null;
}

const baliDay = (d: Date) => new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);

/** line → Bali date the number came back (day 1), for blocks closed in the last week. */
let cache: { at: number; back: Map<number, string> } | null = null;
export async function refreshRecoveries(): Promise<void> {
  if (cache && Date.now() - cache.at < 60_000) return;
  const back = new Map<number, string>();
  try {
    await ensure();
    const { rows } = await pool.query(
      `SELECT session, max(reopened_at) AS at FROM wa_line_blocks WHERE reopened_at > now() - interval '7 days' GROUP BY session`,
    );
    for (const r of rows)
      for (const [line, v] of Object.entries(OWN_LINES)) if (v.session === r.session) back.set(Number(line), baliDay(new Date(r.at)));
  } catch (err) {
    logger.warn({ err }, "wa-line-block: could not read recoveries");
  }
  cache = { at: Date.now(), back };
}

/** Today's first-contact ceiling for a line that is coming back from a block, or undefined. */
export function recoveryCap(line: number | null, now: Date = new Date()): number | undefined {
  if (line === null || !cache) return undefined;
  const start = cache.back.get(line);
  if (!start) return undefined;
  const day = Math.round((Date.parse(baliDay(now)) - Date.parse(start)) / 86_400_000) + 1;
  return day >= 1 ? BLOCK_RECOVERY_STEPS[day - 1] : undefined;
}
