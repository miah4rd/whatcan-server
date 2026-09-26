/**
 * Unicorn OS — the team inside each funnel.
 *
 * Owner, 26.09: each funnel is analysed on its own (Rental clients, Rental
 * Listings, Sales), never mixed. Inside a funnel: every person's numbers for
 * the week, against their own targets and against the team; a ranking; and
 * for each person the step where they lose the most compared with the rest
 * of the team — the "why" a manager asks about. Targets are set per person per
 * funnel, plus one for the whole team.
 *
 * People are whoever holds cards in that funnel in amoCRM (responsible user),
 * so a new agent appears here the day they get cards; nobody is hard-coded.
 */
import { pool } from "@workspace/db";
import { logger } from "../logger";
import { baliDate } from "../kpi-dashboard";
import { site } from "./listings";
import { ensureAnalyticsTables, mondayOf } from "./analytics";
import { tasksFor } from "./data";
import type { OsUser } from "./auth";

export type FunnelKey = "rental" | "rental-listings" | "unicorn";
const PIPELINE_NAME: Record<FunnelKey, string> = { rental: "rental", "rental-listings": "rental listings", unicorn: "unicorn" };

export type Metric = { key: string; label: string; target?: boolean; better?: "up" | "down"; unit?: "min" | "%" };

/** What each funnel counts, in funnel order. `target` marks what a target can be set on. */
export const FUNNEL_METRICS: Record<FunnelKey, Metric[]> = {
  rental: [
    { key: "leads", label: "New clients", target: true },
    { key: "shortlisted", label: "First shortlist sent", target: true },
    { key: "reacted", label: "Reacted to it" },
    { key: "asked", label: "Asked to view" },
    { key: "slot", label: "Slot agreed" },
    { key: "viewings_held", label: "Viewings held", target: true },
    { key: "deals", label: "Contracts signed", target: true },
    { key: "lost", label: "Closed lost", better: "down" },
  ],
  "rental-listings": [
    { key: "leads", label: "New owner cards", target: true },
    { key: "taken", label: "Taken to work" },
    { key: "qualified", label: "Qualified", target: true },
    { key: "inspections_agreed", label: "Inspection agreed" },
    { key: "inspections_held", label: "Inspections held", target: true },
    { key: "reports_done", label: "Inspection reports" },
    { key: "prelisted", label: "Published Pre-listed", target: true },
    { key: "listed", label: "Switched to Listed", target: true },
  ],
  unicorn: [
    { key: "leads", label: "New leads", target: true },
    { key: "contacted", label: "Contact established" },
    { key: "options", label: "Options sent", target: true },
    { key: "viewings", label: "Viewings", target: true },
    { key: "offers", label: "Offers" },
    { key: "won", label: "Deals won", target: true },
    { key: "lost", label: "Closed lost", better: "down" },
  ],
};
/** Work habits, the same in every funnel. */
export const HABITS: Metric[] = [
  { key: "reply_min", label: "Median wait for a reply", better: "down", unit: "min" },
  { key: "overdue_tasks", label: "Overdue tasks", better: "down" },
  { key: "reports_due", label: "Reports not filed", better: "down" },
  { key: "drafts_edited_pct", label: "Drafts rewritten", unit: "%" },
];
/** Steps whose conversion explains a gap, as [from, to] metric pairs. */
const GATES: Record<FunnelKey, Array<[string, string, string]>> = {
  rental: [
    ["shortlisted", "reacted", "client silent after the shortlist"],
    ["reacted", "asked", "reacted, but no viewing asked for"],
    ["asked", "slot", "asked to view, no slot agreed"],
    ["slot", "viewings_held", "slot agreed, viewing not held"],
  ],
  "rental-listings": [
    ["leads", "taken", "owner cards not taken to work"],
    ["taken", "qualified", "taken, not qualified"],
    ["qualified", "inspections_agreed", "qualified, no inspection agreed"],
    ["inspections_agreed", "inspections_held", "inspection agreed, not held"],
    ["prelisted", "listed", "Pre-listed, not switched to Listed"],
  ],
  unicorn: [
    ["leads", "contacted", "no contact established"],
    ["contacted", "options", "contacted, no options sent"],
    ["options", "viewings", "options sent, no viewing"],
    ["viewings", "offers", "viewing, no offer"],
    ["offers", "won", "offer, no deal"],
  ],
};

export type Period = "day" | "week" | "month" | "quarter" | "half" | "year";
export const PERIODS: Period[] = ["day", "week", "month", "quarter", "half", "year"];
/** Periods a target can be set for (owner, 26.09): a day is read against its week. */
export const TARGET_PERIODS: Period[] = ["week", "month", "quarter", "half", "year"];
/** The calendar period holding a day, as [first day, first day after]. */
export function periodRange(period: Period, day: string): { from: string; to: string } {
  const [y, m] = day.split("-").map(Number);
  const iso = (Y: number, M: number) => new Date(Date.UTC(Y, M - 1, 1)).toISOString().slice(0, 10);
  if (period === "month") return { from: iso(y, m), to: iso(y, m + 1) };
  if (period === "quarter") {
    const q = Math.floor((m - 1) / 3) * 3 + 1;
    return { from: iso(y, q), to: iso(y, q + 3) };
  }
  if (period === "year") return { from: iso(y, 1), to: iso(y + 1, 1) };
  if (period === "half") return m <= 6 ? { from: iso(y, 1), to: iso(y, 7) } : { from: iso(y, 7), to: iso(y + 1, 1) };
  if (period === "day") return { from: day, to: addDays(day, 1) };
  const ws = mondayOf(day);
  return { from: ws, to: addDays(ws, 7) };
}
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const baliStart = (day: string) => new Date(`${day}T00:00:00+08:00`);
const who = (s: unknown) => String(s ?? "").trim();
const lc = (s: unknown) => who(s).toLowerCase();

type Counts = Map<string, Map<string, number>>; // person(lc) -> metric -> n
function bump(c: Counts, person: string, metric: string, n = 1) {
  const p = lc(person);
  if (!p) return;
  const m = c.get(p) ?? new Map<string, number>();
  m.set(metric, (m.get(metric) ?? 0) + n);
  c.set(p, m);
}
async function rows(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  try {
    return (await pool.query(sql, params)).rows;
  } catch (err) {
    logger.warn({ err, sql: sql.slice(0, 80) }, "os team: query failed");
    return [];
  }
}

/** Which person a listing code belongs to: R-YUD-071 → the name starting "yud". */
function ownerOfCode(code: string, names: string[]): string | null {
  const m = /^R-([A-Z]+)-/i.exec(code);
  if (!m) return null;
  const p = m[1].toLowerCase();
  return names.find((n) => lc(n).startsWith(p)) ?? null;
}

/** People working a funnel: holders of cards active in the last 60 days, and anyone with a target there. */
export async function funnelPeople(f: FunnelKey): Promise<string[]> {
  const r = await rows(
    `SELECT responsible_user AS who, count(*)::int AS n FROM leads_sync
      WHERE lower(coalesce(pipeline,'')) = $1 AND coalesce(responsible_user,'') <> ''
        AND greatest(coalesce(last_message_at,'epoch'), coalesce(amo_created_at,'epoch')) > now() - interval '60 days'
      GROUP BY 1 HAVING count(*) >= 2 ORDER BY 2 DESC`,
    [PIPELINE_NAME[f]],
  );
  const names = r.map((x) => who(x.who));
  const t = await rows(`SELECT DISTINCT split_part(key, ':', 3) AS who FROM os_targets WHERE key LIKE $1`, [`${f}:%`]);
  for (const x of t) {
    const n = who(x.who);
    if (n && n !== "team" && !names.some((m) => lc(m) === lc(n))) names.push(n.charAt(0).toUpperCase() + n.slice(1));
  }
  return names;
}

/** Counts for one period [fromDay, toDay), per person. */
async function periodCounts(f: FunnelKey, fromDay: string, toDay: string, names: string[]): Promise<Counts> {
  const from = baliStart(fromDay);
  const to = baliStart(toDay);
  const p = PIPELINE_NAME[f];
  const c: Counts = new Map();
  const add = (list: Record<string, unknown>[], metric: string) => list.forEach((x) => bump(c, who(x.who), metric, Number(x.n ?? 1)));

  add(await rows(`SELECT responsible_user AS who, count(*)::int AS n FROM leads_sync WHERE lower(coalesce(pipeline,'')) = $3 AND amo_created_at >= $1 AND amo_created_at < $2 GROUP BY 1`, [from, to, p]), "leads");
  const stage = async (metric: string, like: string) =>
    add(
      await rows(
        `SELECT responsible_user AS who, count(DISTINCT lead_id)::int AS n FROM stage_events
          WHERE lower(coalesce(pipeline,'')) = $3 AND changed_at >= $1 AND changed_at < $2 AND to_stage ~* $4 GROUP BY 1`,
        [from, to, p, like],
      ),
      metric,
    );
  await stage("lost", "closed.*lost|закрыто");

  if (f === "rental") {
    // The shortlist cohort: clients whose first villa link went out this week, and how far each got.
    const cohort = await rows(
      `WITH first_link AS (SELECT lead_id, min(sent_at) AS at FROM lead_messages WHERE sender_type <> 'lead' AND text ILIKE '%/property/%' GROUP BY lead_id)
       SELECT l.responsible_user AS who,
              (SELECT min(sent_at) FROM lead_messages m WHERE m.lead_id = f.lead_id AND m.sender_type = 'lead' AND m.sent_at > f.at) AS reacted,
              (SELECT min(sent_at) FROM lead_messages m WHERE m.lead_id = f.lead_id AND m.sender_type = 'lead' AND m.sent_at > f.at
                  AND m.text ~* '(viewing|to view|view (it|them|the|some)|visit|come and see|see (it|the villa|them) in person|lihat villa|survey)') AS asked,
              (SELECT min(coalesce(agreed_at, created_at)) FROM viewing_slots s WHERE s.lead_id = f.lead_id AND s.status <> 'cancelled') AS slot
         FROM first_link f JOIN leads_sync l ON l.lead_id = f.lead_id
        WHERE lower(coalesce(l.pipeline,'')) = 'rental' AND f.at >= $1 AND f.at < $2`,
      [from, to],
    );
    for (const x of cohort) {
      bump(c, who(x.who), "shortlisted");
      if (x.reacted) bump(c, who(x.who), "reacted");
      if (x.asked) bump(c, who(x.who), "asked");
      if (x.slot) bump(c, who(x.who), "slot");
    }
    add(
      await rows(
        `SELECT l.responsible_user AS who, count(*)::int AS n FROM viewing_slots s JOIN leads_sync l ON l.lead_id = s.lead_id
          WHERE s.viewing_at >= $1 AND s.viewing_at < $2 AND s.viewing_at < now() AND s.status NOT IN ('cancelled','rescheduled')
            AND NOT EXISTS (SELECT 1 FROM viewing_reports r WHERE r.lead_id = s.lead_id AND r.viewing_at = s.viewing_at AND r.outcome IN ('cancelled','no_show','rescheduled'))
          GROUP BY 1`,
        [from, to],
      ),
      "viewings_held",
    );
    await stage("deals", "contract signed|closed.*won|успешно");
  }

  if (f === "rental-listings") {
    await stage("taken", "^taken to work");
    await stage("qualified", "^qualified");
    add(
      await rows(
        `SELECT l.responsible_user AS who, count(DISTINCT s.lead_id)::int AS n FROM listing_inspection_slots s JOIN leads_sync l ON l.lead_id = s.lead_id
          WHERE s.agreed_at >= $1 AND s.agreed_at < $2 GROUP BY 1`,
        [from, to],
      ),
      "inspections_agreed",
    );
    add(
      await rows(
        `SELECT l.responsible_user AS who, count(DISTINCT s.lead_id)::int AS n FROM listing_inspection_slots s JOIN leads_sync l ON l.lead_id = s.lead_id
          WHERE s.visit_at >= $1 AND s.visit_at < $2 AND s.visit_at < now() AND coalesce(s.status,'scheduled') = 'scheduled' AND s.superseded_at IS NULL GROUP BY 1`,
        [from, to],
      ),
      "inspections_held",
    );
    add(
      await rows(
        `SELECT l.responsible_user AS who, count(*)::int AS n FROM inspection_reports r JOIN leads_sync l ON l.lead_id = r.lead_id
          WHERE r.visit_at >= $1 AND r.visit_at < $2 AND r.status = 'done' GROUP BY 1`,
        [from, to],
      ),
      "reports_done",
    );
    // Published and Listed live on the site; the listing code names its manager (R-YUD = Yudi).
    try {
      const enc = encodeURIComponent;
      const [props, log] = await Promise.all([
        site<Array<{ id: string }>>(`properties?select=id&is_draft=eq.false&listing_type=eq.rent&created_at=gte.${enc(from.toISOString())}&created_at=lt.${enc(to.toISOString())}`),
        site<Array<{ property_id: string; pre_listed_old: boolean | null; pre_listed_new: boolean | null }>>(
          `listing_status_log?select=property_id,pre_listed_old,pre_listed_new&changed_at=gte.${enc(from.toISOString())}&changed_at=lt.${enc(to.toISOString())}`,
        ),
      ]);
      for (const x of props) {
        const o = ownerOfCode(x.id, names);
        if (o) bump(c, o, "prelisted");
      }
      const listed = new Set(log.filter((e) => e.pre_listed_old === true && e.pre_listed_new === false).map((e) => e.property_id));
      for (const id of listed) {
        const o = ownerOfCode(id, names);
        if (o) bump(c, o, "listed");
      }
    } catch (err) {
      logger.warn({ err }, "os team: site counts failed");
    }
  }

  if (f === "unicorn") {
    await stage("contacted", "contact");
    await stage("options", "options");
    await stage("viewings", "viewing");
    await stage("offers", "offer|negotiat");
    await stage("won", "closed.*won|успешно|contract signed");
  }

  // Habits: how long a client waited for the first answer to a message (median, minutes).
  const reply = await rows(
    `WITH m AS (
       SELECT lm.lead_id, lm.sender_type, lm.sent_at, lag(lm.sender_type) OVER (PARTITION BY lm.lead_id ORDER BY lm.sent_at) AS prev_type
         FROM lead_messages lm JOIN leads_sync l ON l.lead_id = lm.lead_id
        WHERE lower(coalesce(l.pipeline,'')) = $3 AND lm.sent_at >= $1::timestamptz - interval '3 days' AND lm.sent_at < $2)
     SELECT l.responsible_user AS who,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (r.at - m.sent_at)) / 60) AS med
       FROM m JOIN leads_sync l ON l.lead_id = m.lead_id
       CROSS JOIN LATERAL (SELECT min(x.sent_at) AS at FROM lead_messages x WHERE x.lead_id = m.lead_id AND x.sender_type IN ('broker','bot') AND x.sent_at > m.sent_at) r
      WHERE m.sender_type = 'lead' AND coalesce(m.prev_type,'') <> 'lead' AND m.sent_at >= $1 AND m.sent_at < $2 AND r.at IS NOT NULL
      GROUP BY 1`,
    [from, to, p],
  );
  for (const x of reply) if (x.med != null) bump(c, who(x.who), "reply_min", Math.round(Number(x.med)));

  const drafts = await rows(
    `SELECT l.responsible_user AS who,
            count(*) FILTER (WHERE p.status = 'edited')::int AS edited,
            count(*) FILTER (WHERE p.status IN ('approved','edited') AND NOT coalesce(p.auto_sent,false))::int AS decided
       FROM pending_suggestions p JOIN leads_sync l ON l.lead_id = p.lead_id
      WHERE lower(coalesce(l.pipeline,'')) = $3 AND p.created_at >= $1 AND p.created_at < $2 GROUP BY 1`,
    [from, to, p],
  );
  for (const x of drafts) if (Number(x.decided) > 0) bump(c, who(x.who), "drafts_edited_pct", Math.round((Number(x.edited) / Number(x.decided)) * 100));
  return c;
}

/** Now-state habits (not per week): overdue tasks and reports owed. */
async function nowHabits(f: FunnelKey, c: Counts) {
  const p = PIPELINE_NAME[f];
  try {
    const admin = { id: 0, login: "system", name: "system", role: "admin", brokerKey: null, mustChangePassword: false } as OsUser;
    const tasks = await tasksFor(admin, { all: true });
    const cards = await rows(`SELECT lead_id FROM leads_sync WHERE lower(coalesce(pipeline,'')) = $1`, [p]);
    const inFunnel = new Set(cards.map((x) => String(x.lead_id)));
    for (const t of tasks) if (inFunnel.has(String(t.leadId)) && new Date(t.due) < new Date() && new Date(t.due).getUTCFullYear() >= 2000) bump(c, who(t.responsible), "overdue_tasks");
  } catch (err) {
    logger.warn({ err }, "os team: tasks failed");
  }
  const reports =
    f === "rental-listings"
      ? await rows(`SELECT l.responsible_user AS who, count(*)::int AS n FROM inspection_reports r JOIN leads_sync l ON l.lead_id = r.lead_id WHERE r.status = 'due' GROUP BY 1`, [])
      : f === "rental"
        ? await rows(`SELECT l.responsible_user AS who, count(*)::int AS n FROM viewing_reports r JOIN leads_sync l ON l.lead_id = r.lead_id WHERE r.status = 'due' GROUP BY 1`, [])
        : [];
  for (const x of reports) bump(c, who(x.who), "reports_due", Number(x.n));
}

// ── Targets: per person per funnel metric, and one for the whole team ───────

/** Targets set before 26.09 under the old keys, read as the new ones. */
const LEGACY: Record<string, string> = {
  "amelia.viewings": "rental:viewings_held:amelia",
  "amelia.deals": "rental:deals:amelia",
  "yudi.prelisted": "rental-listings:prelisted:yudi",
  "yudi.listed": "rental-listings:listed:yudi",
  "yudi.inspections": "rental-listings:inspections_held:yudi",
};
export type Target = { value: number; floor: number | null; from: string; note: string | null };
/** Targets of one period type in force on a day for a funnel: person(lc) or "team" -> metric -> target. */
export async function funnelTargets(f: FunnelKey, day: string, period: Period = "week"): Promise<Record<string, Record<string, Target>>> {
  await ensureAnalyticsTables();
  const legacyKeys = Object.keys(LEGACY).filter((k) => LEGACY[k].startsWith(`${f}:`));
  const r = await rows(
    `SELECT key, value, floor, effective_from, note FROM os_targets WHERE effective_from <= $1 AND (key LIKE $2 OR key = ANY($3::text[])) ORDER BY effective_from`,
    [day, `${f}:%`, legacyKeys],
  );
  const out: Record<string, Record<string, Target>> = {};
  for (const x of r) {
    const key = LEGACY[String(x.key)] ?? String(x.key);
    const [, metric, person, per] = key.split(":");
    if (!metric || !person || (per || "week") !== period) continue;
    // Rows come oldest first: the latest one in force wins.
    (out[person] ??= {})[metric] = { value: Number(x.value), floor: x.floor == null ? null : Number(x.floor), from: new Date(String(x.effective_from)).toISOString().slice(0, 10), note: (x.note as string) ?? null };
  }
  return out;
}
export async function setFunnelTarget(by: string, input: { funnel: string; metric: string; who: string; value: number | null; floor?: number | null; from: string; period?: string; note?: string }) {
  const period = (TARGET_PERIODS as string[]).includes(String(input.period ?? "week")) ? (String(input.period ?? "week") as Period) : null;
  if (!period) throw new Error("Pick week, month, quarter, half or year.");
  const f = input.funnel as FunnelKey;
  if (!FUNNEL_METRICS[f]) throw new Error("Unknown funnel.");
  if (!FUNNEL_METRICS[f].some((m) => m.key === input.metric && m.target)) throw new Error("No target can be set on that number.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.from)) throw new Error("Pick the week it starts.");
  const person = lc(input.who);
  if (!person || !/^[\p{L}\p{N} ._-]{1,40}$/u.test(person)) throw new Error("Pick a person or the team.");
  if (input.value != null && (!Number.isFinite(input.value) || input.value < 0 || input.value > 100000)) throw new Error("The target is a count per week.");
  await ensureAnalyticsTables();
  // A target starts with its period: a month target set on the 17th counts from the 1st.
  input.from = periodRange(period, input.from).from;
  const key = period === "week" ? `${f}:${input.metric}:${person}` : `${f}:${input.metric}:${person}:${period}`;
  if (input.value == null) {
    // "No target" from that week on: a zero row would read as a target of 0, so the row says so in its note.
    await pool.query(
      `INSERT INTO os_targets (key, value, floor, effective_from, note, created_by) VALUES ($1, -1, NULL, $2, 'cleared', $3)
       ON CONFLICT (key, effective_from) DO UPDATE SET value = -1, floor = NULL, note = 'cleared', created_by = EXCLUDED.created_by`,
      [key, input.from, by],
    );
    return;
  }
  await pool.query(
    `INSERT INTO os_targets (key, value, floor, effective_from, note, created_by) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (key, effective_from) DO UPDATE SET value = EXCLUDED.value, floor = EXCLUDED.floor, note = EXCLUDED.note, created_by = EXCLUDED.created_by`,
    [key, input.value, input.floor ?? null, input.from, input.note ?? null, by],
  );
}

// ── The scorecard ────────────────────────────────────────────────────────────

export async function teamScorecard(f: FunnelKey, opts: { period?: string; date?: string } = {}) {
  if (!FUNNEL_METRICS[f]) throw new Error("Unknown funnel.");
  const period: Period = (PERIODS as string[]).includes(String(opts.period)) ? (opts.period as Period) : "week";
  const day = opts.date && /^\d{4}-\d{2}-\d{2}$/.test(opts.date) ? opts.date : baliDate();
  const range = periodRange(period, day);
  const prevRange = periodRange(period, addDays(range.from, -1));
  const ws = range.from;
  const lastDay = addDays(range.to, -1);
  const names = await funnelPeople(f);
  const [cur, prev, targetsRaw, weekly] = await Promise.all([
    periodCounts(f, range.from, range.to, names),
    periodCounts(f, prevRange.from, prevRange.to, names),
    period === "day" ? Promise.resolve({} as Record<string, Record<string, Target>>) : funnelTargets(f, lastDay, period),
    period === "week" ? Promise.resolve({} as Record<string, Record<string, Target>>) : funnelTargets(f, lastDay, "week"),
  ]);
  await nowHabits(f, cur);
  // A cleared target (value -1) means none. With no target for a longer period,
  // the weekly one scaled to its length stands in, marked as implied.
  const days = Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86400_000);
  const targets: Record<string, Record<string, Target & { implied?: boolean }>> = {};
  // A day keeps one decimal (2 a week is 0.3 a day, not 0).
  const scale = (v: number) => (days < 7 ? Math.round(((v * days) / 7) * 10) / 10 : Math.round((v * days) / 7));
  for (const [p, ms] of Object.entries(weekly)) for (const [m, t] of Object.entries(ms)) if (t.value > 0) (targets[p] ??= {})[m] = { ...t, value: scale(t.value), floor: t.floor == null ? null : scale(t.floor), implied: true };
  for (const [p, ms] of Object.entries(targetsRaw)) for (const [m, t] of Object.entries(ms)) {
    if (t.value >= 0) (targets[p] ??= {})[m] = t;
    else if (targets[p]) delete targets[p][m];
  }

  const metrics = FUNNEL_METRICS[f];
  const val = (c: Counts, p: string, m: string) => c.get(lc(p))?.get(m) ?? 0;
  const teamSum = (c: Counts, m: string) => names.reduce((s, p) => s + val(c, p, m), 0);
  const rate = (c: Counts, p: string | null, a: string, b: string) => {
    const x = p ? val(c, p, a) : teamSum(c, a);
    const y = p ? val(c, p, b) : teamSum(c, b);
    return x > 0 ? y / x : null;
  };

  const people = names.map((name) => {
    const t = targets[lc(name)] ?? {};
    const values: Record<string, { v: number; prev: number }> = {};
    for (const m of [...metrics, ...HABITS]) values[m.key] = { v: val(cur, name, m.key), prev: val(prev, name, m.key) };
    // Score: target attainment where targets exist (capped at 150%), else share of the team's average.
    const withTarget = metrics.filter((m) => t[m.key] && t[m.key].value > 0);
    let score: number | null = null;
    let basis = "";
    if (withTarget.length) {
      score = withTarget.reduce((s, m) => s + Math.min(1.5, values[m.key].v / t[m.key].value), 0) / withTarget.length;
      basis = "against own targets";
    } else {
      const primary = metrics.filter((m) => m.target);
      const shares = primary.map((m) => {
        const avg = teamSum(cur, m.key) / Math.max(1, names.length);
        return avg > 0 ? Math.min(1.5, values[m.key].v / avg) : null;
      }).filter((x): x is number => x != null);
      score = shares.length ? shares.reduce((a, b) => a + b, 0) / shares.length : null;
      basis = "against the team's average";
    }
    // The step where this person loses the most against the rest of the team.
    let weakest: { step: string; rate: number; teamRate: number; base: number } | null = null;
    for (const [a, b, label] of GATES[f]) {
      const base = val(cur, name, a);
      const r = rate(cur, name, a, b);
      const others = names.filter((n) => n !== name);
      const oa = others.reduce((s, n) => s + val(cur, n, a), 0);
      const ob = others.reduce((s, n) => s + val(cur, n, b), 0);
      const tr = oa > 0 ? ob / oa : rate(cur, null, a, b);
      if (r == null || tr == null || base < 3) continue;
      const gap = tr - r;
      if (gap > 0.1 && (!weakest || gap > weakest.teamRate - weakest.rate)) weakest = { step: label, rate: r, teamRate: tr, base };
    }
    return { name, values, targets: t, score, basis, weakest };
  });
  people.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  people.forEach((p, i) => Object.assign(p, { rank: i + 1 }));

  const teamValues: Record<string, { v: number; prev: number }> = {};
  for (const m of metrics) teamValues[m.key] = { v: teamSum(cur, m.key), prev: teamSum(prev, m.key) };
  for (const m of ["overdue_tasks", "reports_due"]) teamValues[m] = { v: teamSum(cur, m), prev: teamSum(prev, m) };
  // The team's own target, or else the sum of its people's.
  const teamTargets: Record<string, Target & { summed?: boolean }> = { ...(targets["team"] ?? {}) };
  for (const m of metrics.filter((x) => x.target)) {
    if (teamTargets[m.key]) continue;
    const parts = people.map((p) => p.targets[m.key]?.value).filter((x): x is number => x != null && x > 0);
    if (parts.length) teamTargets[m.key] = { value: parts.reduce((a, b) => a + b, 0), floor: null, from: ws, note: null, summed: true };
  }
  const gates = GATES[f].map(([a, b, label]) => ({ from: a, to: b, label, teamRate: rate(cur, null, a, b), base: teamSum(cur, a) }));
  return { funnel: f, period, from: range.from, to: range.to, weekStart: ws, metrics, habits: HABITS, people, team: { values: teamValues, targets: teamTargets }, gates };
}
