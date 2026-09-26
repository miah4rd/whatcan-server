/**
 * The weekly learning digest to the owner (owner, 26.09.2026): what the bot learned from Copilot
 * this week and how clean each situation's approvals were. Information, not a request — the owner
 * turns autopilot on by hand, stage by stage, when he sees a situation run without edits.
 *
 * Sent Monday 09:00 Bali to the owner's own WhatsApp (self-chat, the same path as the session
 * watchdog); once per ISO week (broker_settings key `learning_digest:<year>-W<week>`).
 * Preview: GET /api/admin/learning-digest — send now: POST /api/admin/learning-digest?send=1.
 */
import { db, brokerSettingsTable } from "@workspace/db";
import { sql, eq } from "drizzle-orm";
import { SITUATION_CASE } from "./situation-sql";
import { gateway, OWNER_SESSION } from "./wa-bridge";
import { getAutopilotSetting } from "./autopilot";
import { logger } from "./logger";

type Row = { broker: string; situation: string; judged: number; clean: number; edited: number; skipped: number };
type Lesson = { broker: string; situation: string | null; instruction: string };

function rows<T>(res: unknown): T[] {
  return ((res as { rows?: T[] }).rows ?? (Array.isArray(res) ? (res as T[]) : [])) as T[];
}

export async function buildLearningDigest(days = 7): Promise<string> {
  const stats = rows<Row>(
    await db.execute(sql`
      SELECT coalesce(p.responsible_user, '?') AS broker, (${sql.raw(SITUATION_CASE)}) AS situation,
             count(*)::int AS judged,
             count(*) FILTER (WHERE p.status = 'approved' AND (coalesce(p.final_text,'') = '' OR p.final_text = p.suggestion_text))::int AS clean,
             count(*) FILTER (WHERE p.status = 'edited' OR (p.status = 'approved' AND coalesce(p.final_text,'') <> '' AND p.final_text <> p.suggestion_text))::int AS edited,
             count(*) FILTER (WHERE p.status = 'skipped' AND p.autopilot_skipped_reason IS NULL)::int AS skipped
        FROM pending_suggestions p JOIN leads_sync l ON l.lead_id = p.lead_id
       WHERE coalesce(p.auto_sent, false) = false
         -- a person's verdicts only: a 'skipped' that carries the autopilot's own reason was
         -- retired by the bot (duplicate reply, parked stage, answered by hand), not judged
         AND (p.status IN ('approved', 'edited') OR (p.status = 'skipped' AND p.autopilot_skipped_reason IS NULL))
         AND p.created_at > now() - make_interval(days => ${days})
         AND lower(coalesce(p.responsible_user,'')) IN ('amelia', 'yudi')
       GROUP BY 1, 2 ORDER BY 1, 3 DESC`),
  );
  const auto = rows<{ broker: string; n: number }>(
    await db.execute(sql`
      SELECT coalesce(p.responsible_user,'?') AS broker, count(*)::int AS n
        FROM pending_suggestions p WHERE p.auto_sent = true AND p.created_at > now() - make_interval(days => ${days})
       GROUP BY 1`),
  );
  const lessons = rows<Lesson>(
    await db.execute(sql`
      SELECT broker_id AS broker, situation, instruction FROM broker_corrections
       WHERE created_at > now() - make_interval(days => ${days}) AND superseded_at IS NULL
       ORDER BY created_at DESC LIMIT 12`),
  );
  const [rl, rn] = await Promise.all([getAutopilotSetting("rental listings"), getAutopilotSetting("rental")]);

  const lines: string[] = [`📚 Copilot learning, last ${days} days`];
  for (const broker of ["Amelia", "Yudi"]) {
    const mine = stats.filter((r) => r.broker.toLowerCase() === broker.toLowerCase());
    const a = auto.find((r) => r.broker.toLowerCase() === broker.toLowerCase())?.n ?? 0;
    lines.push(`\n${broker}: autopilot sent ${a}, person judged ${mine.reduce((n, r) => n + r.judged, 0)}`);
    for (const r of mine) {
      const pct = r.judged ? Math.round((100 * r.clean) / r.judged) : 0;
      lines.push(`• ${r.situation}: ${r.judged} drafts, ${pct}% approved unchanged, ${r.edited} edited, ${r.skipped} skipped`);
    }
  }
  lines.push(`\nNew lessons from edits: ${lessons.length}`);
  for (const l of lessons.slice(0, 8)) lines.push(`• [${l.broker}/${l.situation ?? "style"}] ${l.instruction.slice(0, 140)}`);
  lines.push(`\nAutopilot now: Rental Listings ${rl.mode} up to "${rl.upToStageName ?? "-"}"; Rental ${rn.mode}${rn.upToStageName ? ` up to "${rn.upToStageName}"` : ""}.`);
  lines.push(`Rules live in skills/ and change only on your word.`);
  return lines.join("\n");
}

export async function sendLearningDigest(text?: string): Promise<boolean> {
  const body = text ?? (await buildLearningDigest());
  const list = await gateway("GET", "/sessions").then((r) => (Array.isArray(r.data) ? r.data : [])).catch(() => []);
  const owner = (list as Array<{ name: string; status: string; me: string | null }>).find((x) => x.name === OWNER_SESSION);
  if (!owner || owner.status !== "open" || !owner.me) {
    logger.warn({ owner: OWNER_SESSION }, "learning digest: owner session not open — not sent");
    return false;
  }
  const r = await gateway("POST", "/send", { session: OWNER_SESSION, to: owner.me, text: body }).catch(() => null);
  return !!r && r.status === 200;
}

function baliNow(): Date {
  return new Date(Date.now() + 8 * 3600_000);
}
function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return `learning_digest:${y}-W${week}`;
}

async function tick(): Promise<void> {
  const now = baliNow();
  if (now.getUTCDay() !== 1 || now.getUTCHours() !== 9) return; // Monday 09:xx Bali
  const key = isoWeekKey(now);
  const [done] = await db.select({ v: brokerSettingsTable.value }).from(brokerSettingsTable).where(eq(brokerSettingsTable.key, key)).limit(1);
  if (done) return;
  const ok = await sendLearningDigest();
  if (ok) {
    await db.insert(brokerSettingsTable).values({ key, value: new Date().toISOString() }).onConflictDoNothing();
    logger.info({ key }, "learning digest sent to the owner");
  }
}

export function startLearningDigest(): void {
  setInterval(() => void tick().catch((err) => logger.error({ err }, "learning digest failed")), 60_000);
}
