/**
 * Quality control of the brokers' work (owner, 19.09.2026): every morning a short report on
 * yesterday goes to the team chat — how fast Amelia and Yudi answered, what is still waiting on them,
 * and one or two coaching notes on how they wrote, each with a quote.
 *
 * Three layers, each from its own source:
 * - Speed and discipline: counted by code, no model. Reply time is measured from the first client
 *   message after our last reply to our next reply, in working minutes (Bali 08:00–21:00). A reply is
 *   the broker's when it came from their phone (lead_messages sender 'broker') or from a Copilot draft a
 *   person approved (sent_messages, not auto_sent); an autopilot send is the bot's and never counts
 *   for or against the broker (see the "report-split-bot-vs-broker" lesson).
 * - Writing quality: a model reads the threads where the broker personally wrote that day and grades
 *   only those messages. A note is kept only when its quote is found verbatim in one of the broker's
 *   own messages of that day; a note the model cannot anchor to what the broker actually wrote is dropped.
 * - Results: the week-to-date numbers from lib/kpi-dashboard (Mondays, for the finished week).
 *
 * Nothing here moves a card or punishes anyone: the report is advisory. It goes out only while
 * broker_settings `qc_enabled` = 'on' (the owner switches it on after telling the team), to
 * `qc_chat_id` (default: the Unicorn Rental group), from the owner's WhatsApp through the gateway.
 * Everything in the message is English (product language).
 */
import { pool } from "@workspace/db";
import { logger } from "./logger";
import { chatCompletion, WRITER_MODEL } from "./ai-client";
import { cleanLeadName } from "./lead-display-name";
import { KPI_BROKERS, baliDate, weekToDate } from "./kpi-dashboard";
import { gateway, OWNER_SESSION } from "./wa-bridge";

const UNICORN_RENTAL_GROUP = "120363411017702009@g.us";
const WORK_START_H = 8;
const WORK_END_H = 21;
/** A reply slower than this (working minutes) is named in the report. */
const SLOW_MIN = 30;
const SEND_HOUR_BALI = 9;
const MAX_THREADS_REVIEWED = 6;
const MAX_NOTES_PER_BROKER = 2;

const BALI_OFFSET_MS = 8 * 3600_000;
const dayStart = (day: string) => new Date(`${day}T00:00:00+08:00`);
const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

async function setting(key: string): Promise<string | null> {
  const r = await pool.query(`SELECT value FROM broker_settings WHERE key = $1`, [key]).catch(() => null);
  return (r?.rows[0] as { value?: string } | undefined)?.value ?? null;
}

export function ensureQcTables(): Promise<void> {
  return pool
    .query(
      `CREATE TABLE IF NOT EXISTS qc_reports (
         day date PRIMARY KEY,
         payload jsonb NOT NULL,
         message text NOT NULL,
         sent_to text,
         sent_at timestamptz,
         created_at timestamptz NOT NULL DEFAULT now()
       )`,
    )
    .then(() => undefined)
    .catch((err) => logger.error({ err }, "qc: table setup failed"));
}

// ── Working time ─────────────────────────────────────────────────────────────

/** Minutes between a and b that fall inside Bali working hours. */
export function workMinutes(a: Date, b: Date): number {
  if (b <= a) return 0;
  let total = 0;
  let day = baliDate(a);
  const last = baliDate(b);
  for (let i = 0; day <= last && i < 60; i++, day = addDays(day, 1)) {
    const open = dayStart(day).getTime() + WORK_START_H * 3600_000;
    const close = dayStart(day).getTime() + WORK_END_H * 3600_000;
    const from = Math.max(open, a.getTime());
    const to = Math.min(close, b.getTime());
    if (to > from) total += (to - from) / 60_000;
  }
  return Math.round(total);
}

const fmtMin = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`);
const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
};

// ── Speed ────────────────────────────────────────────────────────────────────

type Episode = { leadId: string; name: string; at: Date; repliedAt: Date | null; by: "broker" | "bot" | null; workMin: number };

/**
 * Every "client is waiting" moment that began on the broker's cards during `day`, with who ended it.
 * Closed cards (won / lost) and cards the bot is excluded from are left out; a LIVE the broker marked
 * "No reply needed" after the message counts as handled, not as waiting.
 */
async function episodes(broker: string, day: string): Promise<Episode[]> {
  const from = dayStart(day);
  const to = dayStart(addDays(day, 1));
  const r = await pool.query(
    `WITH our AS (
       SELECT s.lead_id, s.created_at AS t, NOT coalesce(p.auto_sent, false) AS human
         FROM sent_messages s LEFT JOIN pending_suggestions p ON p.id = s.suggestion_id
        WHERE s.webhook_status = 200 AND s.created_at >= $2::timestamptz - interval '14 days'
       UNION ALL
       SELECT lead_id, sent_at, true FROM lead_messages
        WHERE sender_type = 'broker' AND sent_at >= $2::timestamptz - interval '14 days'
     ), inb AS (
       SELECT m.lead_id, m.sent_at AS t,
              lag(m.sent_at) OVER (PARTITION BY m.lead_id ORDER BY m.sent_at) AS prev_in
         FROM lead_messages m
        WHERE m.sender_type = 'lead' AND m.sent_at >= $2::timestamptz - interval '14 days' AND m.sent_at < $3
     )
     SELECT i.lead_id, i.t, r.t AS replied_at, r.human, d.name, l.live_dismissed_at
       FROM inb i
       JOIN leads_sync l ON l.lead_id = i.lead_id
       LEFT JOIN amo_deals d ON d.id::text = i.lead_id
       LEFT JOIN LATERAL (SELECT o.t, o.human FROM our o WHERE o.lead_id = i.lead_id AND o.t > i.t ORDER BY o.t LIMIT 1) r ON true
      WHERE i.t >= $2 AND i.t < $3
        AND lower(l.responsible_user) = lower($1)
        AND NOT coalesce(l.bot_excluded, false)
        AND coalesce(d.status_id, 0) NOT IN (142, 143)
        AND (i.prev_in IS NULL OR EXISTS (SELECT 1 FROM our o WHERE o.lead_id = i.lead_id AND o.t > i.prev_in AND o.t < i.t))`,
    [broker, from, to],
  );
  const now = new Date();
  const out: Episode[] = [];
  for (const row of r.rows as Array<{ lead_id: string; t: Date; replied_at: Date | null; human: boolean | null; name: string | null; live_dismissed_at: Date | null }>) {
    const dismissed = row.live_dismissed_at && row.live_dismissed_at > row.t && (!row.replied_at || row.live_dismissed_at < row.replied_at);
    if (dismissed) continue;
    const end = row.replied_at ?? now;
    out.push({
      leadId: row.lead_id,
      name: cleanLeadName(row.name) ?? `#${row.lead_id}`,
      at: row.t,
      repliedAt: row.replied_at,
      by: row.replied_at ? (row.human ? "broker" : "bot") : null,
      workMin: workMinutes(row.t, end),
    });
  }
  return out;
}

async function draftActions(broker: string, day: string) {
  const r = await pool.query(
    `SELECT p.status, count(*)::int AS n FROM sent_messages s JOIN pending_suggestions p ON p.id = s.suggestion_id
      WHERE lower(s.responsible_user) = lower($1) AND NOT coalesce(p.auto_sent, false) AND s.webhook_status = 200
        AND s.created_at >= $2 AND s.created_at < $3
      GROUP BY 1
     UNION ALL
     SELECT 'skipped', count(*)::int FROM pending_suggestions
      WHERE lower(responsible_user) = lower($1) AND status = 'skipped' AND NOT coalesce(auto_sent, false)
        AND created_at >= $2 AND created_at < $3`,
    [broker, dayStart(day), dayStart(addDays(day, 1))],
  );
  const by = Object.fromEntries((r.rows as { status: string; n: number }[]).map((x) => [x.status, x.n]));
  const phone = await pool.query(
    `SELECT count(*)::int AS n FROM lead_messages m JOIN leads_sync l ON l.lead_id = m.lead_id
      WHERE m.sender_type = 'broker' AND lower(l.responsible_user) = lower($1) AND m.sent_at >= $2 AND m.sent_at < $3`,
    [broker, dayStart(day), dayStart(addDays(day, 1))],
  );
  return {
    approvedAsIs: by["approved"] ?? 0,
    edited: by["edited"] ?? 0,
    skipped: by["skipped"] ?? 0,
    fromPhone: (phone.rows[0] as { n: number }).n,
  };
}

async function overdue(broker: string) {
  const [reports, promises] = await Promise.all([
    pool
      .query(
        `SELECT v.lead_id, d.name, v.viewing_at FROM viewing_reports v
           JOIN leads_sync l ON l.lead_id = v.lead_id LEFT JOIN amo_deals d ON d.id::text = v.lead_id
          WHERE v.status = 'due' AND v.viewing_at < now() - interval '24 hours' AND v.viewing_at > now() - interval '30 days'
            AND lower(l.responsible_user) = lower($1)
          ORDER BY v.viewing_at`,
        [broker],
      )
      .catch(() => ({ rows: [] })),
    pool
      .query(
        `SELECT c.lead_id, d.name, c.promise_text, c.due_at FROM lead_commitments c LEFT JOIN amo_deals d ON d.id::text = c.lead_id
          WHERE c.status = 'open' AND c.due_at < now() AND c.due_at > now() - interval '14 days' AND lower(c.responsible_user) = lower($1)
          ORDER BY c.due_at`,
        [broker],
      )
      .catch(() => ({ rows: [] })),
  ]);
  return {
    viewingReports: (reports.rows as { lead_id: string; name: string | null }[]).map((x) => cleanLeadName(x.name) ?? `#${x.lead_id}`),
    promises: (promises.rows as { lead_id: string; name: string | null; promise_text: string }[]).map((x) => ({
      name: cleanLeadName(x.name) ?? `#${x.lead_id}`,
      promise: x.promise_text,
    })),
  };
}

// ── Writing quality ──────────────────────────────────────────────────────────

type Note = { kind: "fix" | "good"; severity: "critical" | "minor"; client: string; quote: string; issue: string; better: string };

const RUBRIC: Record<string, string> = {
  amelia: `Amelia is a rental broker. Her clients are tenants looking for a villa in Bali (monthly/yearly rent).
Good work looks like:
1. Answers the client's actual question first, with correct facts (price, availability, bedrooms) that match what the thread says.
2. Moves the deal forward: every reply ends with a concrete next step — a viewing with a proposed day/time, a call, or one precise question.
3. Fills what is missing in the request: move-in date, length of stay, budget, area, number of people — asked naturally, not as a questionnaire.
4. The villas she sends or approves fit the request (area, bedrooms, budget, dates). Approving a shortlist that clearly misses the request is her responsibility.
5. When the client pushes back softly ("more options", "not my style"), she sends new options instead of giving up.
6. Keeps promises: "I'll check with the owner" is followed by an answer.
7. Clear, warm, short English (or the client's language). No walls of text, no wrong names.`,
  yudi: `Yudi is a listing agent. He writes to villa OWNERS (often in Indonesian) to get their villa listed for rent with us.
Good work looks like:
1. Gets the facts we need to list: number of bedrooms, monthly price and whether it includes our 10% commission, availability date, photos/area.
2. Books an inspection visit with a concrete day and time, and confirms it.
3. Answers the owner's questions correctly (how we work, commission, who the tenants are).
4. Moves the card forward: every message ends with a next step or one precise question.
5. Keeps promises and follows up when the owner goes quiet.
6. Polite and short; professional Indonesian or English.`,
};

type Thread = { leadId: string; name: string; transcript: string; mine: string[] };

async function threadsToReview(broker: string, day: string): Promise<Thread[]> {
  const from = dayStart(day);
  const to = dayStart(addDays(day, 1));
  // What the broker is accountable for that day: phone messages and Copilot drafts a person approved.
  const r = await pool.query(
    `SELECT lead_id, text, t FROM (
       SELECT m.lead_id, m.text, m.sent_at AS t FROM lead_messages m JOIN leads_sync l ON l.lead_id = m.lead_id
        WHERE m.sender_type = 'broker' AND lower(l.responsible_user) = lower($1) AND m.sent_at >= $2 AND m.sent_at < $3
       UNION ALL
       SELECT s.lead_id, s.message_text, s.created_at FROM sent_messages s JOIN pending_suggestions p ON p.id = s.suggestion_id
        WHERE lower(s.responsible_user) = lower($1) AND NOT coalesce(p.auto_sent, false) AND s.webhook_status = 200
          AND s.created_at >= $2 AND s.created_at < $3
     ) x WHERE coalesce(text, '') <> '' ORDER BY t`,
    [broker, from, to],
  );
  const mine = new Map<string, string[]>();
  for (const row of r.rows as { lead_id: string; text: string }[]) {
    if (!mine.has(row.lead_id)) mine.set(row.lead_id, []);
    mine.get(row.lead_id)!.push(row.text);
  }
  const picked = [...mine.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, MAX_THREADS_REVIEWED);
  const out: Thread[] = [];
  for (const [leadId, texts] of picked) {
    const [msgs, deal] = await Promise.all([
      pool.query(
        `SELECT sender_type, text, sent_at FROM lead_messages WHERE lead_id = $1 AND sent_at < $2 AND coalesce(text, '') <> ''
          ORDER BY sent_at DESC LIMIT 30`,
        [leadId, to],
      ),
      pool.query(`SELECT name FROM amo_deals WHERE id::text = $1`, [leadId]).catch(() => ({ rows: [] })),
    ]);
    const lines = (msgs.rows as { sender_type: string; text: string; sent_at: Date }[])
      .reverse()
      .map((m) => {
        const who = m.sender_type === "lead" ? "CLIENT" : m.sender_type === "broker" ? "BROKER (phone)" : "US (Copilot/bot)";
        const when = new Date(m.sent_at.getTime() + BALI_OFFSET_MS).toISOString().slice(5, 16).replace("T", " ");
        return `[${when}] ${who}: ${m.text.slice(0, 1500)}`;
      });
    out.push({
      leadId,
      name: cleanLeadName((deal.rows[0] as { name?: string } | undefined)?.name) ?? `#${leadId}`,
      transcript: lines.join("\n"),
      mine: texts,
    });
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[“”«»"']/g, "").replace(/\s+/g, " ").trim();

async function reviewThread(broker: string, t: Thread): Promise<Note[]> {
  const rubric = RUBRIC[broker.toLowerCase()] ?? RUBRIC["amelia"]!;
  const system = `You are the quality controller of a Bali real-estate agency. You review how a broker handled one conversation and give short, fair coaching notes.

${rubric}

Rules:
- Grade ONLY the messages listed under "BROKER'S MESSAGES TODAY". Everything else is context. Messages marked "US (Copilot/bot)" in the transcript may be the bot's own; never blame the broker for them unless they appear in the list.
- Read every message to the end before judging: an answer can come after a quoted part.
- Be fair: if the thread gives no chance to do something (the client has not replied, the catalogue has nothing matching, the owner already answered), it is not a fault.
- "quote" must be copied EXACTLY, character for character, from one of the broker's messages today (at most 20 words). Notes without an exact quote are discarded.
- "critical" only for: wrong facts given to the client/owner (price, availability, bedrooms), a promise broken, rudeness, or a clear request ignored. Everything else is "minor".
- Also give at most one "good" note when something was done genuinely well.
- If there is nothing worth saying, return an empty list.

Answer with JSON only: {"notes":[{"kind":"fix"|"good","severity":"critical"|"minor","quote":"...","issue":"what happened, one sentence","better":"what to do instead, one sentence (empty for good)"}]}`;
  const user = `CONVERSATION with ${t.name} (oldest first):
${t.transcript}

BROKER'S MESSAGES TODAY:
${t.mine.map((m, i) => `(${i + 1}) ${m}`).join("\n\n")}`;
  let raw: string;
  try {
    raw = (await chatCompletion({ model: WRITER_MODEL, system, messages: [{ role: "user", content: user }], max_tokens: 1200, label: "qc-review" })).content;
  } catch (err) {
    logger.warn({ err, leadId: t.leadId }, "qc: review failed");
    return [];
  }
  const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  let parsed: { notes?: Array<Partial<Note>> };
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const mine = t.mine.map(norm);
  const out: Note[] = [];
  for (const n of parsed.notes ?? []) {
    const q = norm(String(n.quote ?? ""));
    if (q.length < 4 || !mine.some((m) => m.includes(q))) continue;
    out.push({
      kind: n.kind === "good" ? "good" : "fix",
      severity: n.severity === "critical" ? "critical" : "minor",
      client: t.name,
      quote: String(n.quote).trim(),
      issue: String(n.issue ?? "").trim(),
      better: String(n.better ?? "").trim(),
    });
  }
  return out;
}

// ── The report ───────────────────────────────────────────────────────────────

export type BrokerQc = {
  name: string;
  role: string;
  speed: {
    clientWaits: number;
    byBroker: number;
    byBot: number;
    medianBrokerMin: number | null;
    slow: { name: string; min: number }[];
    stillWaiting: { name: string; min: number }[];
  };
  drafts: Awaited<ReturnType<typeof draftActions>>;
  overdue: Awaited<ReturnType<typeof overdue>>;
  reviewed: number;
  notes: Note[];
};

export async function buildQc(day: string, opts: { review?: boolean } = {}) {
  const brokers: BrokerQc[] = [];
  for (const b of KPI_BROKERS) {
    const eps = await episodes(b.name, day);
    const mineEps = eps.filter((e) => e.by !== "bot");
    const answered = mineEps.filter((e) => e.by === "broker");
    const threads = opts.review === false ? [] : await threadsToReview(b.name, day);
    const notes: Note[] = [];
    for (const t of threads) notes.push(...(await reviewThread(b.name, t)));
    // Critical fixes first, then minor fixes; at most one "good".
    const fixes = notes.filter((n) => n.kind === "fix").sort((x, y) => (x.severity === y.severity ? 0 : x.severity === "critical" ? -1 : 1));
    const good = notes.filter((n) => n.kind === "good").slice(0, 1);
    brokers.push({
      name: b.name,
      role: b.role,
      speed: {
        clientWaits: eps.length,
        byBroker: answered.length,
        byBot: eps.filter((e) => e.by === "bot").length,
        medianBrokerMin: median(answered.map((e) => e.workMin)),
        slow: answered.filter((e) => e.workMin > SLOW_MIN).sort((x, y) => y.workMin - x.workMin).slice(0, 3).map((e) => ({ name: e.name, min: e.workMin })),
        stillWaiting: mineEps.filter((e) => !e.repliedAt).sort((x, y) => y.workMin - x.workMin).map((e) => ({ name: e.name, min: e.workMin })),
      },
      drafts: await draftActions(b.name, day),
      overdue: await overdue(b.name),
      reviewed: threads.length,
      notes: [...fixes.slice(0, MAX_NOTES_PER_BROKER), ...good],
    });
  }
  // Monday: the finished week against the owner's targets.
  const isMonday = new Date(`${addDays(day, 1)}T00:00:00Z`).getUTCDay() === 1;
  const week = isMonday ? await weekToDate(day).catch(() => null) : null;
  return { day, brokers, week };
}

const dayLabel = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

export function composeMessage(qc: Awaited<ReturnType<typeof buildQc>>): string {
  const L: string[] = [`*Quality check · ${dayLabel(qc.day)}*`];
  for (const b of qc.brokers) {
    L.push("", `*${b.name}*`);
    const s = b.speed;
    if (s.clientWaits === 0) {
      L.push("⏱ No one wrote in on your cards.");
    } else {
      const med = s.medianBrokerMin === null ? "—" : fmtMin(s.medianBrokerMin);
      L.push(
        `⏱ Reply time: median *${med}* (working hours) · ${s.byBroker} answered by you` +
          (s.byBot ? `, ${s.byBot} by the bot` : ""),
      );
      if (s.slow.length) L.push(`   Slow (> ${SLOW_MIN} min): ${s.slow.map((x) => `${x.name} ${fmtMin(x.min)}`).join(", ")}`);
      if (s.stillWaiting.length)
        L.push(`   ⚠️ Still waiting for you: ${s.stillWaiting.slice(0, 5).map((x) => `${x.name} (${fmtMin(x.min)})`).join(", ")}` +
          (s.stillWaiting.length > 5 ? ` +${s.stillWaiting.length - 5} more` : ""));
    }
    const d = b.drafts;
    L.push(`✉️ Sent: ${d.fromPhone} from phone · ${d.approvedAsIs + d.edited} via Copilot (${d.edited} edited)` + (d.skipped ? ` · ${d.skipped} drafts skipped` : ""));
    if (b.overdue.viewingReports.length) L.push(`📝 Viewing report missing: ${b.overdue.viewingReports.join(", ")}`);
    if (b.overdue.promises.length)
      L.push(`🤝 Promise overdue: ${b.overdue.promises.slice(0, 3).map((p) => `${p.name} — "${p.promise.slice(0, 60)}"`).join("; ")}`);
    for (const n of b.notes) {
      if (n.kind === "good") L.push(`👍 ${n.client}: "${n.quote}" — ${n.issue}`);
      else L.push(`${n.severity === "critical" ? "❗" : "💡"} ${n.client}: "${n.quote}" — ${n.issue}${n.better ? ` → ${n.better}` : ""}`);
    }
    if (b.reviewed > 0 && b.notes.length === 0) L.push(`✅ ${b.reviewed} conversation${b.reviewed === 1 ? "" : "s"} reviewed, nothing to fix.`);
  }
  if (qc.week) {
    const w = qc.week;
    L.push(
      "",
      `*Week ${dayLabel(w.weekStart)} – ${dayLabel(qc.day)}*`,
      `Amelia: viewings ${w.amelia.viewings}/${w.amelia.viewingsTarget} · deals ${w.amelia.deals}/${w.amelia.dealsTarget}`,
      `Yudi: published ${w.yudi.published}/${w.yudi.publishedTarget} · Pre-listed → Listed ${w.yudi.listed}/${w.yudi.listedTarget}`,
    );
  }
  L.push("", "_Bot replies are counted separately and never against you. Disagree with a note? Reply here._");
  return L.join("\n");
}

// ── Sending ──────────────────────────────────────────────────────────────────

export async function runQc(day: string, opts: { send: boolean; to?: string; force?: boolean }) {
  await ensureQcTables();
  const prev = await pool.query(`SELECT sent_at FROM qc_reports WHERE day = $1`, [day]);
  if (opts.send && !opts.force && (prev.rows[0] as { sent_at?: Date } | undefined)?.sent_at) {
    return { skipped: "already sent", day };
  }
  const qc = await buildQc(day);
  const message = composeMessage(qc);
  let sentTo: string | null = null;
  let error: string | null = null;
  if (opts.send) {
    const to = opts.to ?? (await setting("qc_chat_id")) ?? UNICORN_RENTAL_GROUP;
    const r = await gateway("POST", "/send", { session: OWNER_SESSION, to, text: message }).catch((err) => ({ status: 503, data: { ok: false, error: String(err) } }));
    if (r.data?.ok) sentTo = to;
    else error = String(r.data?.error ?? r.status);
    await pool
      .query(
        `INSERT INTO wa_messages (session, wa_id, direction, phone, type, text, status, error) VALUES ($1, $2, 'out_api', $3, 'text', $4, $5, $6)
         ON CONFLICT (session, wa_id) WHERE wa_id IS NOT NULL DO NOTHING`,
        [OWNER_SESSION, r.data?.id ?? null, to, message, sentTo ? "sent" : "error", error],
      )
      .catch(() => null);
  }
  // Only a real send to the team chat marks the day as done; a test send to someone else does not.
  const markSent = sentTo !== null && !opts.to;
  await pool.query(
    `INSERT INTO qc_reports (day, payload, message, sent_to, sent_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (day) DO UPDATE SET payload = EXCLUDED.payload, message = EXCLUDED.message,
       sent_to = coalesce(EXCLUDED.sent_to, qc_reports.sent_to), sent_at = coalesce(EXCLUDED.sent_at, qc_reports.sent_at)`,
    [day, JSON.stringify(qc), message, markSent ? sentTo : null, markSent ? new Date() : null],
  );
  logger.info({ day, sentTo, error, notes: qc.brokers.map((b) => b.notes.length) }, "qc report built");
  return { day, message, sentTo, error, qc };
}

let handle: ReturnType<typeof setInterval> | null = null;
let running = false;

export function startQcScheduler(): void {
  if (handle) return;
  ensureQcTables();
  handle = setInterval(async () => {
    if (running) return;
    const now = new Date();
    if (new Date(now.getTime() + BALI_OFFSET_MS).getUTCHours() !== SEND_HOUR_BALI) return;
    if ((await setting("qc_enabled")) !== "on") return;
    running = true;
    try {
      await runQc(addDays(baliDate(now), -1), { send: true });
    } catch (err) {
      logger.error({ err }, "qc scheduler failed");
    } finally {
      running = false;
    }
  }, 60_000);
  logger.info({ hourBali: SEND_HOUR_BALI }, "qc scheduler started (sends only while qc_enabled = on)");
}
