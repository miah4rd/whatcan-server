/**
 * Is the Rental board still in step with WhatsApp? A daily check, not a promise.
 *
 * Owner, 14.09.2026, after the same class of bug was fixed for the tenth time
 * ("мы это чиним уже в 10 раз"): the check that proved the stage sync works
 * must keep running on its own and shout the day it stops working. It runs
 * every day at 09:00 Bali, and 40 minutes after a restart when that day's run
 * has not happened yet (so a deploy verifies itself). On demand:
 * GET /api/admin/rental-stage-sync-check?hours=24 (add &alert=1 to push).
 * Any failure pushes the owner through the AI-outage alert path, lead ids in
 * the text.
 *
 * Rental only; amoCRM is the source of truth, never leads_sync:
 *   1. FLOORS: an open card with any outbound message of ours is at least
 *      "need assessed"; one we sent a /property/ link to is at least
 *      "Options sent".
 *   2. STAGE EVENTS: every stage_events row in the window has an amoCRM
 *      lead_status_changed event within ±4 min landing on the same status.
 *   3. PHONE REPLIES: every message the broker typed herself (no sent_messages
 *      row within ±3 min) has a stage_sync_decisions row for that card within
 *      10 minutes.
 * Checks 2 and 3 start no earlier than the first stage-sync decision, so the
 * history from before the fix is not re-reported every morning.
 */
import { db, brokerSettingsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { amoFetch } from "./amo-client";
import { alertEveryone } from "./ai-watchdog";

const RUN_HOUR_BALI = 9;
const RAN_ON_KEY = "rental_stage_sync_check_on";
const LAST_RESULT_KEY = "rental_stage_sync_check_last";
const CLOSED = new Set([142, 143]);

export type StageSyncCheckResult = {
  ranAt: string;
  hours: number;
  windowFrom: string;
  floors: { checked: number; failures: Array<{ lead: string; stage: string; floor: string; lastMessage: string }> };
  stageEvents: { checked: number; failures: Array<{ lead: string; at: string; from: string | null; to: string }> };
  phoneReplies: { checked: number; failures: Array<{ lead: string; at: string; text: string }> };
  owedReports: Array<{ lead: string; viewingAt: string }>;
  ok: boolean;
  alerted: number | null;
};

type Row = Record<string, unknown>;
const rowsOf = (r: unknown): Row[] => ((r as { rows?: Row[] }).rows ?? []) as Row[];
const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

function bali(d: Date | string): string {
  return new Date(d).toLocaleString("en-GB", { timeZone: "Asia/Makassar", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

type AmoStatus = { id: number; name: string; sort: number };
type AmoLeadLite = { id: number; status_id: number; pipeline_id: number };
type AmoEvent = { entity_id: number; created_at: number; value_after?: Array<{ lead_status?: { id?: number } }> };

async function amoPages<T>(path: string, key: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 20; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const data = await amoFetch<{ _embedded?: Record<string, T[]> }>(`${path}${sep}limit=250&page=${page}`);
    const items = data?._embedded?.[key] ?? [];
    out.push(...items);
    if (items.length < 250) break;
  }
  return out;
}

export async function runStageSyncCheck(opts: { hours?: number; alert?: boolean } = {}): Promise<StageSyncCheckResult> {
  const hours = Math.min(Math.max(Math.round(opts.hours ?? 24), 1), 24 * 14);
  const now = Date.now();

  const pipes = await amoFetch<{ _embedded?: { pipelines?: Array<{ id: number; name: string; _embedded?: { statuses?: AmoStatus[] } }> } }>(
    "/api/v4/leads/pipelines?limit=50",
  );
  const rental = pipes?._embedded?.pipelines?.find((p) => p.name.trim().toLowerCase() === "rental");
  if (!rental) throw new Error("amoCRM did not return the Rental funnel");
  const statuses = [...(rental._embedded?.statuses ?? [])].sort((a, b) => a.sort - b.sort);
  const order = new Map(statuses.map((s, i) => [s.id, i]));
  const nameOf = new Map(statuses.map((s) => [s.id, s.name]));
  const NEED = statuses.find((s) => /need.?s?\s*assess/i.test(s.name))?.id ?? null;
  const OPTIONS = statuses.find((s) => /option/i.test(s.name))?.id ?? null;
  const UNSORTED = statuses[0]?.id ?? null;

  const [first] = rowsOf(await db.execute(sql`SELECT min(created_at) AS at FROM stage_sync_decisions`));
  const firstAt = first?.["at"] ? new Date(first["at"] as string).getTime() : now;
  const since = new Date(Math.max(now - hours * 3_600_000, firstAt));

  // ── 1. Floors ──────────────────────────────────────────────────────────────
  const threads = rowsOf(
    await db.execute(sql`
      SELECT m.lead_id,
             bool_or(m.sender_type IN ('bot','broker') AND coalesce(m.text,'') <> '') AS outbound,
             bool_or(m.sender_type IN ('bot','broker') AND m.text ~* '/property/[A-Za-z0-9-]+') AS link,
             max(m.sent_at) AS last_at
        FROM lead_messages m JOIN leads_sync l ON l.lead_id = m.lead_id
       WHERE lower(coalesce(l.pipeline,'')) = 'rental' AND l.bot_excluded IS NOT TRUE
       GROUP BY m.lead_id
      HAVING max(m.sent_at) > now() - interval '30 days'`),
  );
  const amoLeads = new Map<string, AmoLeadLite>();
  const threadIds = threads.map((t) => String(t["lead_id"]));
  for (let i = 0; i < threadIds.length; i += 50) {
    const q = threadIds.slice(i, i + 50).map((id) => `filter[id][]=${id}`).join("&");
    for (const l of await amoPages<AmoLeadLite>(`/api/v4/leads?${q}`, "leads")) amoLeads.set(String(l.id), l);
  }
  const floorFailures: StageSyncCheckResult["floors"]["failures"] = [];
  let floorsChecked = 0;
  for (const t of threads) {
    const lead = amoLeads.get(String(t["lead_id"]));
    if (!lead || lead.pipeline_id !== rental.id || CLOSED.has(lead.status_id) || lead.status_id === UNSORTED) continue;
    floorsChecked++;
    const floor = t["link"] ? OPTIONS : t["outbound"] ? NEED : null;
    if (floor && (order.get(lead.status_id) ?? 99) < (order.get(floor) ?? 0)) {
      floorFailures.push({
        lead: String(lead.id),
        stage: nameOf.get(lead.status_id) ?? String(lead.status_id),
        floor: nameOf.get(floor) ?? String(floor),
        lastMessage: bali(t["last_at"] as string),
      });
    }
  }

  // ── 2. Every stage write reached amoCRM ───────────────────────────────────
  const stageRows = rowsOf(
    await db.execute(sql`
      SELECT e.lead_id, e.changed_at, e.from_stage, e.to_stage
        FROM stage_events e LEFT JOIN leads_sync l ON l.lead_id = e.lead_id
       WHERE lower(coalesce(e.pipeline, l.pipeline, '')) = 'rental'
         AND e.changed_at > ${since}
         AND e.changed_at < now() - interval '2 minutes'
       ORDER BY e.changed_at`),
  );
  const events = new Map<string, Array<{ at: number; status: number | undefined }>>();
  const eventLeadIds = [...new Set(stageRows.map((r) => String(r["lead_id"])))];
  for (let i = 0; i < eventLeadIds.length; i += 10) {
    const ids = eventLeadIds.slice(i, i + 10).map((id) => `filter[entity_id][]=${id}`).join("&");
    const from = Math.floor(since.getTime() / 1000) - 900;
    for (const ev of await amoPages<AmoEvent>(
      `/api/v4/events?filter[type]=lead_status_changed&filter[entity]=lead&${ids}&filter[created_at][from]=${from}`,
      "events",
    )) {
      const list = events.get(String(ev.entity_id)) ?? [];
      list.push({ at: ev.created_at * 1000, status: ev.value_after?.[0]?.lead_status?.id });
      events.set(String(ev.entity_id), list);
    }
  }
  const sameStatus = (status: number | undefined, toStage: string) =>
    status === 142 ? /won/i.test(toStage) : status === 143 ? /lost/i.test(toStage) : !!status && norm(nameOf.get(status)) === norm(toStage);
  const stageFailures: StageSyncCheckResult["stageEvents"]["failures"] = [];
  for (const r of stageRows) {
    const at = new Date(r["changed_at"] as string).getTime();
    const ok = (events.get(String(r["lead_id"])) ?? []).some((e) => Math.abs(e.at - at) <= 4 * 60_000 && sameStatus(e.status, String(r["to_stage"])));
    if (!ok) stageFailures.push({ lead: String(r["lead_id"]), at: bali(new Date(at)), from: (r["from_stage"] as string) ?? null, to: String(r["to_stage"]) });
  }

  // ── 3. Every phone reply reached the stage decision ───────────────────────
  const phoneRows = rowsOf(
    await db.execute(sql`
      SELECT m.lead_id, m.sent_at, left(regexp_replace(coalesce(m.text,''), '[[:space:]]+', ' ', 'g'), 60) AS text,
             EXISTS (SELECT 1 FROM stage_sync_decisions d
                      WHERE d.lead_id = m.lead_id
                        AND d.created_at BETWEEN m.sent_at - interval '1 minute' AND m.sent_at + interval '10 minutes') AS decided
        FROM lead_messages m JOIN leads_sync l ON l.lead_id = m.lead_id
       WHERE lower(coalesce(l.pipeline,'')) = 'rental' AND l.bot_excluded IS NOT TRUE
         AND m.sender_type = 'broker'
         AND m.sent_at > ${since}
         AND m.sent_at < now() - interval '10 minutes'
         AND NOT EXISTS (SELECT 1 FROM sent_messages s WHERE s.lead_id = m.lead_id
               AND s.created_at BETWEEN m.sent_at - interval '3 minutes' AND m.sent_at + interval '3 minutes')
       ORDER BY m.sent_at`),
  );
  const phoneFailures = phoneRows
    .filter((r) => !r["decided"])
    .map((r) => ({ lead: String(r["lead_id"]), at: bali(r["sent_at"] as string), text: String(r["text"] ?? "") }));

  const owed = rowsOf(
    await db.execute(sql`
      SELECT lead_id, viewing_at FROM viewing_slots
       WHERE status = 'scheduled' AND viewing_at + interval '3 hours 30 minutes' < now()
         AND viewing_at > now() - interval '14 days'`),
  ).map((r) => ({ lead: String(r["lead_id"]), viewingAt: bali(r["viewing_at"] as string) }));

  const ok = floorFailures.length + stageFailures.length + phoneFailures.length === 0;
  let alerted: number | null = null;
  if (!ok && opts.alert) {
    const ids = (list: Array<{ lead: string }>) => [...new Set(list.map((x) => x.lead))].join(", ");
    const parts: string[] = [];
    if (phoneFailures.length) parts.push(`${phoneFailures.length} phone replies with no stage decision: ${ids(phoneFailures)}`);
    if (stageFailures.length) parts.push(`${stageFailures.length} stage writes amoCRM never got: ${ids(stageFailures)}`);
    if (floorFailures.length) parts.push(`${floorFailures.length} cards below their floor: ${ids(floorFailures)}`);
    alerted = await alertEveryone("Rental stages out of sync with WhatsApp", parts.join(" · "));
  }

  const result: StageSyncCheckResult = {
    ranAt: new Date(now).toISOString(),
    hours,
    windowFrom: since.toISOString(),
    floors: { checked: floorsChecked, failures: floorFailures },
    stageEvents: { checked: stageRows.length, failures: stageFailures },
    phoneReplies: { checked: phoneRows.length, failures: phoneFailures },
    owedReports: owed,
    ok,
    alerted,
  };
  await setKey(LAST_RESULT_KEY, JSON.stringify(result).slice(0, 60_000));
  logger.info(
    {
      ok,
      floors: `${floorFailures.length}/${floorsChecked}`,
      stageEvents: `${stageFailures.length}/${stageRows.length}`,
      phoneReplies: `${phoneFailures.length}/${phoneRows.length}`,
      owedReports: owed.length,
      alerted,
      leads: [...new Set([...floorFailures, ...stageFailures, ...phoneFailures].map((x) => x.lead))],
    },
    "rental stage sync check",
  );
  return result;
}

async function getKey(key: string): Promise<string | null> {
  const [row] = await db.select().from(brokerSettingsTable).where(eq(brokerSettingsTable.key, key)).limit(1).catch(() => []);
  return row?.value ?? null;
}

async function setKey(key: string, value: string): Promise<void> {
  await db
    .insert(brokerSettingsTable)
    .values({ key, value })
    .onConflictDoUpdate({ target: brokerSettingsTable.key, set: { value, updatedAt: new Date() } })
    .catch(() => undefined);
}

export async function lastStageSyncCheck(): Promise<unknown> {
  const raw = await getKey(LAST_RESULT_KEY);
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return raw;
  }
}

function baliDay(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar" }).format(new Date());
}

function baliHour(): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Makassar", hour: "numeric", hour12: false }).format(new Date()));
}

let started = false;

/**
 * Once a Bali day, from 09:00. The day is stored, not held in memory: this
 * process restarts on every deploy, and a check that ran again on each restart
 * would push the owner the same list several times a day.
 */
export function startStageSyncCheckScheduler(): void {
  if (started) return;
  started = true;
  const tick = async (afterRestart: boolean) => {
    try {
      const today = baliDay();
      if ((await getKey(RAN_ON_KEY)) === today) return;
      if (!afterRestart && baliHour() < RUN_HOUR_BALI) return;
      // Marked before running: a failure mid-run must not re-alert every ten minutes.
      await setKey(RAN_ON_KEY, today);
      logger.info({ day: today, afterRestart }, "rental stage sync check: scheduled run");
      await runStageSyncCheck({ hours: 24, alert: true });
    } catch (err) {
      logger.error({ err }, "rental stage sync check: scheduled run failed");
    }
  };
  setTimeout(() => void tick(true), 40 * 60_000);
  setInterval(() => void tick(false), 10 * 60_000);
  logger.info({ hourBali: RUN_HOUR_BALI }, "rental stage sync check scheduler started");
}
