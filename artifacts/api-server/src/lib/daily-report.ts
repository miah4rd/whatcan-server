/**
 * The discipline report: what a broker is sitting on right now, and what they
 * actually did in the period.
 *
 * The deliberate shape of this file is "a to-do list with a few numbers under
 * it", not a dashboard. A morning report full of percentages gets swiped away;
 * "12 people are waiting, 5 of them since yesterday" gets worked. So the state
 * numbers (waiting / overdue / stalled) come FIRST and are what the 8am push
 * says — the activity counts are context underneath, and the trend comparison
 * only exists on week and month, where a trend is a real thing rather than
 * noise.
 *
 * Days are Bali days. A broker's "yesterday" is the day they worked, not a UTC
 * boundary that cuts their evening in half.
 */
import { pool } from "@workspace/db";
import { parseDialogContent } from "./dialog-parser";

const BALI = "Asia/Makassar";

export type ReportPeriod = "day" | "week" | "month";

export interface ReportActivity {
  drafts: number;
  sent: number;
  skipped: number;
  untouched: number;
}

export interface ReportCard {
  broker: string;
  period: ReportPeriod;
  label: string;
  /** Leads whose last word was theirs and we have not answered. */
  waiting: number;
  /** …of those, waiting longer than 24 hours. */
  waitingOverdue: number;
  /** Scheduled follow-ups whose time has passed. */
  overdueFollowups: number;
  /** Hot/warm leads we have not written to in 3+ days. */
  hotStalled: number;
  hotStalledNames: string[];
  /** Waiting, split per pipeline, so Rental and Rental Listings never blur. */
  waitingByPipeline: { pipeline: string; waiting: number; overdue: number }[];
  activity: ReportActivity;
  /** Only on period=day: the day before, because at 8am "today" is empty. */
  yesterday?: ReportActivity;
  newLeads: number;
  medianReplyMin: number | null;
  advanced: number;
  lost: number;
  viewings: number;
  listingsTaken: number;
  previous?: {
    sent: number;
    skipped: number;
    newLeads: number;
    advanced: number;
    lost: number;
    viewings: number;
    listingsTaken: number;
    medianReplyMin: number | null;
  };
  /** One sentence: the single thing to do first. */
  headline: string;
}

/**
 * Stage vocabularies, in funnel order. Each pipeline has its own — the same
 * name means different positions, and Rental Listings runs the opposite way
 * round (we are chasing the owner). A stage that appears in neither list is
 * ignored rather than guessed at, so an administrative move never reads as
 * progress.
 */
const STAGE_ORDER: Record<string, string[]> = {
  rental: ["new lead", "initial contact", "need assessed", "needs assessed", "options sent", "viewing scheduled", "viewing done", "reservation", "contract signed", "won"],
  "rental listings": ["new lead", "initial contact", "qualified", "taken to work", "listing signed", "won"],
  unicorn: [
    "new lead", "in progress", "1st follow up (next day)", "2nd follow up (3 days after)",
    "final follow up (1 week after)", "lead assigned", "taken to work", "contact established",
    "needs assessed", "options sent", "zoom call scheduled", "viewing scheduled",
    "feedback / handling objections", "reservation", "negotiations", "contract signed", "closed - won",
  ],
};

function stageIndex(pipeline: string | null, stage: string | null): number {
  const order = STAGE_ORDER[(pipeline ?? "").trim().toLowerCase()];
  if (!order || !stage) return -1;
  return order.indexOf(stage.trim().toLowerCase());
}

function isLost(stage: string | null): boolean {
  return (stage ?? "").toLowerCase().includes("lost");
}

/** A stage that means someone is actually going to see a villa. */
function isViewing(stage: string | null): boolean {
  return (stage ?? "").toLowerCase().includes("viewing");
}

/** Rental Listings: the point at which an owner's villa becomes ours to rent. */
function isListingWon(pipeline: string | null, stage: string | null): boolean {
  if ((pipeline ?? "").trim().toLowerCase() !== "rental listings") return false;
  const s = (stage ?? "").toLowerCase();
  return s.includes("taken to work") || s.includes("listing signed");
}

/** Same shape the inbox card uses: the lead's own name out of the transcript. */
function leadNameFrom(content: string | null): string | null {
  if (!content) return null;
  try {
    const dialog = parseDialogContent(content);
    const msg = dialog.messages.find(
      (m) => m.from === "lead" && m.senderName && m.senderName.trim().length > 1,
    );
    if (!msg?.senderName) return null;
    return msg.senderName.replace(/\s*\([^)]*\)\s*$/, "").trim() || msg.senderName;
  } catch {
    return null;
  }
}

/** Period boundaries as Bali dates, inclusive, plus the preceding period. */
function periodRange(period: ReportPeriod, todayBali: string): {
  from: string; to: string; prevFrom: string; prevTo: string; label: string;
} {
  const d = new Date(todayBali + "T00:00:00Z");
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  const shift = (days: number) => { const c = new Date(d); c.setUTCDate(c.getUTCDate() + days); return c; };

  if (period === "day") {
    return {
      from: todayBali, to: todayBali,
      prevFrom: iso(shift(-1)), prevTo: iso(shift(-1)),
      label: d.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" }),
    };
  }
  if (period === "week") {
    // Monday-based week containing today.
    const dow = (d.getUTCDay() + 6) % 7;
    const start = shift(-dow);
    const end = new Date(start); end.setUTCDate(end.getUTCDate() + 6);
    const prevStart = new Date(start); prevStart.setUTCDate(prevStart.getUTCDate() - 7);
    const prevEnd = new Date(start); prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
    return {
      from: iso(start), to: iso(end), prevFrom: iso(prevStart), prevTo: iso(prevEnd),
      label:
        start.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) +
        " – " +
        end.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }),
    };
  }
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  const prevStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  const prevEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0));
  return {
    from: iso(start), to: iso(end), prevFrom: iso(prevStart), prevTo: iso(prevEnd),
    label: start.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }),
  };
}

/** Today's date in Bali, as YYYY-MM-DD. */
export async function baliToday(): Promise<string> {
  const r = await pool.query(`SELECT (now() AT TIME ZONE $1)::date::text AS d`, [BALI]);
  return String(r.rows[0]?.["d"] ?? new Date().toISOString().slice(0, 10));
}

/** Leads this broker is responsible for, optionally narrowed to one pipeline. */
function pipelineClause(pipeline: string | null, param: number): string {
  return pipeline ? ` AND lower(coalesce(pipeline,'')) = lower($${param})` : "";
}

async function activityFor(
  broker: string, pipeline: string | null, from: string, to: string,
): Promise<ReportActivity> {
  const params: unknown[] = [broker, BALI, from, to];
  if (pipeline) params.push(pipeline);
  const r = await pool.query(
    `SELECT count(*)::int                                                    AS drafts,
            count(*) FILTER (WHERE p.status IN ('approved','edited'))::int   AS sent,
            count(*) FILTER (WHERE p.status = 'skipped')::int                AS skipped,
            count(*) FILTER (WHERE p.status = 'pending')::int                AS untouched
       FROM pending_suggestions p
       LEFT JOIN leads_sync l ON l.lead_id = p.lead_id
      WHERE p.responsible_user = $1
        AND (p.created_at AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date
        ${pipeline ? " AND lower(coalesce(l.pipeline,'')) = lower($5)" : ""}`,
    params,
  );
  const row = (r.rows[0] ?? {}) as Record<string, number>;
  return {
    drafts: Number(row["drafts"] ?? 0),
    sent: Number(row["sent"] ?? 0),
    skipped: Number(row["skipped"] ?? 0),
    untouched: Number(row["untouched"] ?? 0),
  };
}

async function outcomesFor(
  broker: string, pipeline: string | null, from: string, to: string,
): Promise<{ advanced: number; lost: number; viewings: number; listingsTaken: number; newLeads: number; medianReplyMin: number | null }> {
  const stageParams: unknown[] = [broker, BALI, from, to];
  if (pipeline) stageParams.push(pipeline);
  const [stageRes, newRes, replyRes] = await Promise.all([
    pool.query(
      `SELECT pipeline, from_stage, to_stage
         FROM stage_events
        WHERE responsible_user = $1
          AND (changed_at AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date
          ${pipeline ? " AND lower(coalesce(pipeline,'')) = lower($5)" : ""}`,
      stageParams,
    ),
    pool.query(
      `SELECT count(*)::int AS n
         FROM leads_sync
        WHERE responsible_user = $1
          AND amo_created_at IS NOT NULL
          AND (amo_created_at AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date
          ${pipelineClause(pipeline, 5)}`,
      stageParams,
    ),
    // How long a draft sat before the broker sent it — live drafts only, since
    // a scheduled follow-up's draft is queued ahead of time and its "delay" is
    // the schedule, not the broker.
    pool.query(
      `SELECT percentile_cont(0.5) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (s.created_at - p.created_at)) / 60
              ) AS median_min
         FROM sent_messages s
         JOIN pending_suggestions p ON p.id = s.suggestion_id
         LEFT JOIN leads_sync l ON l.lead_id = p.lead_id
        WHERE p.responsible_user = $1
          AND p.kind = 'live'
          AND (s.created_at AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date
          ${pipeline ? " AND lower(coalesce(l.pipeline,'')) = lower($5)" : ""}`,
      stageParams,
    ),
  ]);

  let advanced = 0, lost = 0, viewings = 0, listingsTaken = 0;
  for (const raw of stageRes.rows as Record<string, string | null>[]) {
    const pipe = raw["pipeline"] ?? null;
    const to_ = raw["to_stage"] ?? null;
    const from_ = raw["from_stage"] ?? null;
    if (isLost(to_)) lost++;
    if (isViewing(to_) && !isViewing(from_)) viewings++;
    if (isListingWon(pipe, to_) && !isListingWon(pipe, from_)) listingsTaken++;
    const fi = stageIndex(pipe, from_);
    const ti = stageIndex(pipe, to_);
    if (fi !== -1 && ti > fi) advanced++;
  }

  const medianRaw = (replyRes.rows[0] ?? {})["median_min"];
  return {
    advanced, lost, viewings, listingsTaken,
    newLeads: Number((newRes.rows[0] ?? {})["n"] ?? 0),
    medianReplyMin: medianRaw == null ? null : Math.round(Number(medianRaw)),
  };
}

/**
 * What the broker is sitting on RIGHT NOW. Closed leads and bot-excluded ones
 * are out — a report that counts dead leads as work owed is a report nobody
 * believes twice.
 */
async function stateNow(broker: string, pipeline: string | null) {
  const params: unknown[] = [broker];
  if (pipeline) params.push(pipeline);
  const where = `responsible_user = $1
      AND NOT coalesce(bot_excluded, false)
      AND lower(coalesce(lead_stage,'')) NOT LIKE '%lost%'
      AND lower(coalesce(lead_stage,'')) NOT LIKE '%won%'
      ${pipelineClause(pipeline, 2)}`;

  const [totals, byPipe, stalled] = await Promise.all([
    pool.query(
      `SELECT
         count(*) FILTER (WHERE last_message_from = 'lead'
                            AND last_message_at > coalesce(last_our_message_at, 'epoch'))::int AS waiting,
         count(*) FILTER (WHERE last_message_from = 'lead'
                            AND last_message_at > coalesce(last_our_message_at, 'epoch')
                            AND last_message_at < now() - interval '24 hours')::int            AS waiting_overdue,
         count(*) FILTER (WHERE next_followup_at IS NOT NULL
                            AND next_followup_at < now())::int                                 AS overdue_followups
       FROM leads_sync WHERE ${where}`,
      params,
    ),
    pool.query(
      `SELECT coalesce(pipeline,'—') AS pipeline,
              count(*) FILTER (WHERE last_message_from = 'lead'
                                 AND last_message_at > coalesce(last_our_message_at, 'epoch'))::int AS waiting,
              count(*) FILTER (WHERE last_message_from = 'lead'
                                 AND last_message_at > coalesce(last_our_message_at, 'epoch')
                                 AND last_message_at < now() - interval '24 hours')::int            AS overdue
         FROM leads_sync WHERE ${where}
        GROUP BY 1 ORDER BY 2 DESC`,
      params,
    ),
    pool.query(
      `SELECT lead_id, content
         FROM leads_sync
        WHERE ${where}
          AND profile_temperature IN ('hot','warm')
          AND coalesce(last_our_message_at, 'epoch') < now() - interval '3 days'
        ORDER BY last_our_message_at ASC NULLS FIRST
        LIMIT 20`,
      params,
    ),
  ]);

  const t = (totals.rows[0] ?? {}) as Record<string, number>;
  const names = (stalled.rows as Record<string, string | null>[])
    .map((r) => leadNameFrom(r["content"] ?? null) || ("#" + String(r["lead_id"])))
    .slice(0, 3);

  return {
    waiting: Number(t["waiting"] ?? 0),
    waitingOverdue: Number(t["waiting_overdue"] ?? 0),
    overdueFollowups: Number(t["overdue_followups"] ?? 0),
    hotStalled: stalled.rows.length,
    hotStalledNames: names,
    waitingByPipeline: (byPipe.rows as Record<string, unknown>[])
      .map((r) => ({
        pipeline: String(r["pipeline"]),
        waiting: Number(r["waiting"] ?? 0),
        overdue: Number(r["overdue"] ?? 0),
      }))
      .filter((p) => p.waiting > 0),
  };
}

/**
 * The one sentence at the bottom. Ordered by what costs a deal soonest: a
 * client waiting a day beats an unopened draft, which beats an idle stat.
 */
function buildHeadline(c: Omit<ReportCard, "headline">): string {
  if (c.waitingOverdue > 0) {
    return c.waitingOverdue + " client" + (c.waitingOverdue === 1 ? " has" : "s have") +
      " been waiting over a day. Start there.";
  }
  if (c.waiting > 0) return c.waiting + " client" + (c.waiting === 1 ? "" : "s") + " waiting for an answer.";
  const untouched = (c.yesterday?.untouched ?? 0) + c.activity.untouched;
  if (untouched > 0) return untouched + " draft" + (untouched === 1 ? "" : "s") + " never opened. Clear them.";
  if (c.overdueFollowups > 0) return c.overdueFollowups + " follow-up" + (c.overdueFollowups === 1 ? " is" : "s are") + " overdue.";
  if (c.hotStalled > 0) return c.hotStalled + " warm lead" + (c.hotStalled === 1 ? "" : "s") + " with no contact for 3 days.";
  return "Inbox clear. Nobody is waiting on you.";
}

export async function buildReport(
  broker: string,
  period: ReportPeriod = "day",
  pipeline: string | null = null,
): Promise<ReportCard> {
  const today = await baliToday();
  const range = periodRange(period, today);

  const [now, activity, yesterday, outcomes, prevActivity, prevOutcomes] = await Promise.all([
    stateNow(broker, pipeline),
    activityFor(broker, pipeline, range.from, range.to),
    period === "day" ? activityFor(broker, pipeline, range.prevFrom, range.prevTo) : Promise.resolve(undefined),
    outcomesFor(broker, pipeline, range.from, range.to),
    period === "day" ? Promise.resolve(undefined) : activityFor(broker, pipeline, range.prevFrom, range.prevTo),
    period === "day" ? Promise.resolve(undefined) : outcomesFor(broker, pipeline, range.prevFrom, range.prevTo),
  ]);

  const card: Omit<ReportCard, "headline"> = {
    broker,
    period,
    label: range.label,
    ...now,
    activity,
    ...(yesterday ? { yesterday } : {}),
    newLeads: outcomes.newLeads,
    medianReplyMin: outcomes.medianReplyMin,
    advanced: outcomes.advanced,
    lost: outcomes.lost,
    viewings: outcomes.viewings,
    listingsTaken: outcomes.listingsTaken,
    ...(prevActivity && prevOutcomes
      ? {
          previous: {
            sent: prevActivity.sent,
            skipped: prevActivity.skipped,
            newLeads: prevOutcomes.newLeads,
            advanced: prevOutcomes.advanced,
            lost: prevOutcomes.lost,
            viewings: prevOutcomes.viewings,
            listingsTaken: prevOutcomes.listingsTaken,
            medianReplyMin: prevOutcomes.medianReplyMin,
          },
        }
      : {}),
  };

  return { ...card, headline: buildHeadline(card) };
}

/** Brokers with live leads worth reporting on — the roster the report covers. */
export async function reportableBrokers(pipeline: string | null = null): Promise<string[]> {
  const params: unknown[] = [];
  if (pipeline) params.push(pipeline);
  const r = await pool.query(
    `SELECT responsible_user AS broker, count(*)::int AS n
       FROM leads_sync
      WHERE responsible_user IS NOT NULL
        AND NOT coalesce(bot_excluded, false)
        AND lower(coalesce(lead_stage,'')) NOT LIKE '%lost%'
        ${pipeline ? " AND lower(coalesce(pipeline,'')) = lower($1)" : ""}
      GROUP BY 1 HAVING count(*) > 0 ORDER BY 2 DESC`,
    params,
  );
  return (r.rows as Record<string, unknown>[]).map((x) => String(x["broker"]));
}
