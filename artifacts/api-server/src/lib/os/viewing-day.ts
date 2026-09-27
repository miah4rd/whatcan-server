/**
 * Around a booked viewing, the way Amelia works (owner, 27.09.2026: «посмотреть как чаще брокеры делают и
 * применить сюда практику»). Her 9 viewings of 45 days: a client's "thanks, see you there" is not answered;
 * on the viewing day, in the morning or 1–3 hours before, one short line — "See you at 2PM Lorenzo!",
 * "Hey Solène! I will see you at 2PM today! Location: <map>" (4 of 9; twice the client used it to move
 * the time). Copilot OS first.
 */
import { pool } from "@workspace/db";
import { logger } from "../logger";
import { OS_MODE } from "../amo-client";
import { leadContact } from "../phone-dedupe";
import { notifyBroker } from "../push-notifications";
import { siteGet } from "../listing-status-week";
import { villaLinks } from "../villa-maps";

/** "Thank you see you there", "ok 👍", "great, thanks!" — nothing to answer. */
const CLOSING =
  /^\s*(ok(ay)?|oke|sure|cool|great|perfect|awesome|noted|got it|sounds good|thanks?|thank you( so much| very much)?|thx|ty|cheers|see (you|u)( there| then| tomorrow| soon)?|baik|siap|sip|makasih|terima ?kasih|👍|🙏|🙂|😊|❤️|[!.,\s])+\s*$/i;

export function isClosingOnly(text: string | null | undefined): boolean {
  const t = String(text ?? "").replace(/^>>.*\n/, "").trim();
  return !!t && t.length <= 80 && !t.includes("?") && CLOSING.test(t);
}

/** A viewing on record for this card that is still ahead. */
export async function hasUpcomingViewing(leadId: string): Promise<boolean> {
  const r = await pool
    .query(`SELECT 1 FROM viewing_slots WHERE lead_id = $1 AND coalesce(status,'scheduled') = 'scheduled' AND viewing_at > now() LIMIT 1`, [leadId])
    .catch(() => ({ rows: [] as unknown[] }));
  return r.rows.length > 0;
}

const DAY_CONFIRM_VERDICT = "viewing day confirmation";
const bali = (d: Date) => new Date(d.getTime() + 8 * 3_600_000);
const timeLabel = (d: Date) => {
  const b = bali(d);
  const h = b.getUTCHours(), m = b.getUTCMinutes();
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "AM" : "PM"}`;
};

/** A draft written from a viewing report and not sent within a day: the broker is told once. */
async function afterViewingReminders(): Promise<void> {
  const rows = (
    await pool.query(
      `SELECT id, lead_id, responsible_user FROM pending_suggestions
        WHERE status = 'pending' AND autopilot_skipped_reason = 'viewing report filed' AND created_at < now() - interval '24 hours' AND created_at > now() - interval '7 days'`,
    )
  ).rows as Array<{ id: string; lead_id: string; responsible_user: string | null }>;
  for (const r of rows) {
    const key = `after_viewing_remind:${r.id}`;
    const ins = await pool.query(`INSERT INTO broker_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING RETURNING key`, [key, new Date().toISOString()]);
    if (!ins.rows.length) continue;
    const contact = await leadContact(r.lead_id).catch(() => null);
    const first = String(contact?.name ?? "").trim().split(/\s+/)[0] || "The client";
    void notifyBroker(String(r.responsible_user ?? "").toLowerCase() || null, `📋 ${first}: the message after the viewing is still waiting`, "A day since the report — send it, or the client goes cold", `/m?lead=${encodeURIComponent(r.lead_id)}`).catch(() => 0);
  }
}

async function passOnce(): Promise<void> {
  await afterViewingReminders().catch((err) => logger.warn({ err }, "after-viewing reminders failed"));
  const nowB = bali(new Date());
  if (nowB.getUTCHours() * 60 + nowB.getUTCMinutes() < 8 * 60 + 30) return;
  const today = nowB.toISOString().slice(0, 10);
  const slots = (
    await pool.query(
      `SELECT s.id, s.lead_id, s.viewing_at, s.property_code, l.responsible_user
         FROM viewing_slots s JOIN leads_sync l ON l.lead_id = s.lead_id
        WHERE coalesce(s.status,'scheduled') = 'scheduled'
          AND s.viewing_at > now() + interval '45 minutes'
          AND to_char(s.viewing_at AT TIME ZONE 'Asia/Makassar', 'YYYY-MM-DD') = $1
          AND lower(coalesce(l.pipeline,'')) = 'rental'`,
      [today],
    )
  ).rows as Array<{ id: string; lead_id: string; viewing_at: Date; property_code: string | null; responsible_user: string | null }>;
  for (const s of slots) {
    const key = `viewing_day:${s.id}`;
    const done = await pool.query(`SELECT 1 FROM broker_settings WHERE key = $1`, [key]);
    if (done.rows.length) continue;
    // Already in touch today (the broker wrote, or a draft is waiting): nothing to add.
    const touched = await pool.query(
      `SELECT 1 FROM lead_messages WHERE lead_id = $1 AND sender_type <> 'lead' AND (sent_at AT TIME ZONE 'Asia/Makassar')::date = $2::date
       UNION ALL SELECT 1 FROM pending_suggestions WHERE lead_id = $1 AND status = 'pending' AND autopilot_skipped_reason = $3 LIMIT 1`,
      [s.lead_id, today, DAY_CONFIRM_VERDICT],
    );
    await pool.query(`INSERT INTO broker_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, [key, new Date().toISOString()]);
    if (touched.rows.length) continue;
    const contact = await leadContact(s.lead_id).catch(() => null);
    const first = String(contact?.name ?? "").trim().split(/\s+/)[0] ?? "";
    let where = "the villa";
    let map: string | null = null;
    if (s.property_code) {
      const [p] = await siteGet<Array<{ area: string | null }>>(`properties?select=area&id=eq.${encodeURIComponent(s.property_code)}`).catch((): Array<{ area: string | null }> => []);
      if (p?.area) where = `the villa in ${String(p.area).split(",")[0]!.trim()}`;
      map = (await villaLinks([s.property_code]).catch(() => []))[0]?.maps ?? null;
    }
    const text = `Hi${first && !/^test$/i.test(first) ? ` ${first}` : ""}! See you at ${timeLabel(new Date(s.viewing_at))} today at ${where}.${map ? `\n${map}` : ""}`;
    await pool.query(
      `INSERT INTO pending_suggestions (lead_id, responsible_user, kind, suggestion_text, status, requested_at, autopilot_skipped_reason, autopilot_skipped_at, attachments)
       VALUES ($1,$2,'push',$3,'pending',now(),$4,now(),'[]'::jsonb)`,
      [s.lead_id, s.responsible_user, text, DAY_CONFIRM_VERDICT],
    );
    logger.info({ leadId: s.lead_id, slot: s.id }, "viewing day: confirmation drafted");
    void notifyBroker(String(s.responsible_user ?? "").toLowerCase() || null, `📅 Viewing today at ${timeLabel(new Date(s.viewing_at))}`, `The confirmation to ${first || "the client"} is ready`, `/m?lead=${encodeURIComponent(s.lead_id)}`).catch(() => 0);
  }
}

export function startViewingDayPass(): void {
  setInterval(() => void passOnce().catch((err) => logger.warn({ err }, "viewing day pass failed")), 10 * 60_000);
}
