/**
 * The 8am Bali nudge.
 *
 * Discipline does not come from a report existing somewhere — it comes from it
 * arriving before the day starts, with one instruction in it. So this sends the
 * headline (and only the headline) as a push; the numbers live behind the tap.
 *
 * Deliberately guarded by a stored date rather than an in-memory flag: this
 * process restarts on every deploy, and an in-memory "already sent today" would
 * re-send the report to every broker on each restart between 08:00 and 08:59.
 */
import { db, brokerSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { buildReport, baliToday } from "./daily-report";
import { brokersWithPush, sendPushToBroker } from "./push-notifications";

const SENT_KEY = "daily_report_sent_on";
const SEND_HOUR_BALI = 8;

async function lastSentOn(): Promise<string | null> {
  try {
    const rows = await db
      .select()
      .from(brokerSettingsTable)
      .where(eq(brokerSettingsTable.key, SENT_KEY))
      .limit(1);
    return rows[0]?.value ?? null;
  } catch {
    return null;
  }
}

async function markSent(day: string): Promise<void> {
  await db
    .insert(brokerSettingsTable)
    .values({ key: SENT_KEY, value: day })
    .onConflictDoUpdate({ target: brokerSettingsTable.key, set: { value: day, updatedAt: new Date() } })
    .catch(() => {});
}

function baliHour(): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Makassar",
      hour: "numeric",
      hour12: false,
    }).format(new Date()),
  );
}

/** Body of the morning push: the headline, plus the two numbers behind it. */
function pushBody(card: Awaited<ReturnType<typeof buildReport>>): string {
  const bits: string[] = [];
  if (card.waiting > 0) bits.push(card.waiting + " waiting");
  if (card.overdueFollowups > 0) bits.push(card.overdueFollowups + " follow-ups due");
  if (card.hotStalled > 0) bits.push(card.hotStalled + " warm going cold");
  return bits.length > 0 ? card.headline + "\n" + bits.join(" · ") : card.headline;
}

export async function sendDailyReports(force = false): Promise<number> {
  const today = await baliToday();
  if (!force && (await lastSentOn()) === today) return 0;

  const covered = await brokersWithPush();
  if (covered.size === 0) {
    logger.warn("daily report: nobody has notifications enabled — nothing sent");
    await markSent(today);
    return 0;
  }

  let sent = 0;
  for (const brokerId of covered) {
    try {
      const card = await buildReport(brokerId, "day", null);
      await sendPushToBroker(brokerId, {
        title: "Your day · " + card.label,
        body: pushBody(card),
        url: "/m?view=report",
      });
      sent++;
    } catch (err) {
      logger.error({ err, brokerId }, "daily report push failed");
    }
  }

  await markSent(today);
  logger.info({ sent, day: today }, "daily reports sent");
  return sent;
}

let handle: ReturnType<typeof setInterval> | null = null;

export function startReportScheduler(): void {
  if (handle) return;
  logger.info({ hourBali: SEND_HOUR_BALI }, "daily report scheduler started");
  handle = setInterval(() => {
    if (baliHour() !== SEND_HOUR_BALI) return;
    sendDailyReports().catch((err) => logger.error({ err }, "daily report scheduler error"));
  }, 60_000);
}
