/**
 * The message written from a viewing report and not sent within a day: the broker is told once
 * (owner, 27.09.2026: after a viewing everything got lost; in September 3 of 7 "new options" clients
 * heard nothing more from us).
 */
import { pool } from "@workspace/db";
import { logger } from "./logger";
import { leadContact } from "./phone-dedupe";
import { notifyBroker } from "./push-notifications";

async function passOnce(): Promise<void> {
  const rows = (
    await pool.query(
      `SELECT id, lead_id, responsible_user FROM pending_suggestions
        WHERE status = 'pending' AND autopilot_skipped_reason = 'viewing report filed' AND created_at < now() - interval '24 hours' AND created_at > now() - interval '7 days'`,
    )
  ).rows as Array<{ id: string; lead_id: string; responsible_user: string | null }>;
  for (const r of rows) {
    const ins = await pool.query(`INSERT INTO broker_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING RETURNING key`, [`after_viewing_remind:${r.id}`, new Date().toISOString()]);
    if (!ins.rows.length) continue;
    const contact = await leadContact(r.lead_id).catch(() => null);
    const first = String(contact?.name ?? "").trim().split(/\s+/)[0] || "The client";
    void notifyBroker(String(r.responsible_user ?? "").toLowerCase() || null, `📋 ${first}: the message after the viewing is still waiting`, "A day since the report — send it, or the client goes cold", `/m?lead=${encodeURIComponent(r.lead_id)}`).catch(() => 0);
  }
}

export function startAfterViewingReminder(): void {
  setInterval(() => void passOnce().catch((err) => logger.warn({ err }, "after-viewing reminders failed")), 10 * 60_000);
}
