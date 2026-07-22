/**
 * Daily funnel snapshots — records current lead distribution per stage
 * so we can compare "было vs стало" for any period.
 * Runs at server startup and every night at midnight.
 */
import { pool } from "@workspace/db";
import { logger } from "./logger";

export async function takeFunnelSnapshot(): Promise<void> {
  const today = new Date().toISOString().split("T")[0]!;
  try {
    const result = await pool.query(`
      INSERT INTO funnel_snapshots (snapshot_date, responsible_user, stage, count)
      SELECT
        $1::text,
        COALESCE(responsible_user, '') AS responsible_user,
        lead_stage AS stage,
        COUNT(*)::int AS count
      FROM leads_sync
      WHERE lead_stage IS NOT NULL
        AND lead_id != 'test123'
      GROUP BY responsible_user, lead_stage
      ON CONFLICT ON CONSTRAINT funnel_snapshots_uniq
      DO UPDATE SET count = EXCLUDED.count
    `, [today]);
    logger.info({ date: today, rows: result.rowCount }, "funnel snapshot saved");
  } catch (err) {
    logger.error({ err }, "funnel snapshot failed");
  }
}

export function startFunnelSnapshotScheduler(): void {
  // First snapshot 15s after startup (let DB migrations finish first)
  setTimeout(() => {
    takeFunnelSnapshot().catch((err) => logger.error({ err }, "startup snapshot error"));
  }, 15_000);

  // Check every 5 min; fire at midnight (hour 0, first 5 min window)
  setInterval(() => {
    const now = new Date();
    if (now.getHours() === 0 && now.getMinutes() < 5) {
      takeFunnelSnapshot().catch((err) => logger.error({ err }, "midnight snapshot error"));
    }
  }, 5 * 60 * 1000);

  logger.info("funnel snapshot scheduler started (daily + startup)");
}
