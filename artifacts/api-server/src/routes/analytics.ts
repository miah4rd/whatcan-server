import { Router } from "express";
import { db, stageEventsTable, contactEventsTable, leadCrmTasksTable } from "@workspace/db";
import { sql, desc, gte, lte, and, eq } from "drizzle-orm";

const router = Router();

const STAGE_ORDER = [
  // Follow-up / Nurture series
  "New Lead",
  "In Progress",
  "1st Follow Up (Next Day)",
  "2nd Follow Up (3 Days After)",
  "Final Follow Up (1 Week After)",
  "Shanti 5th MSG (After 5 Days)",
  // Qualification
  "Lead Assigned",
  "Taken to Work",
  "Contact Established",
  "Mailing",
  "Long-term Cycle",
  "Needs Assessed",
  // Active sales
  "Options Sent",
  "Option Send", // alt spelling in DB
  "Zoom Call Scheduled",
  "Viewing Scheduled",
  "Feedback / Handling Objections",
  // Closing
  "Reservation",
  "Negotiations",
  "Contract Signed",
  "Closed - Won",
];

function parseDate(s: string | undefined, fallback: Date): Date {
  if (!s) return fallback;
  const d = new Date(s);
  return isNaN(d.getTime()) ? fallback : d;
}

function buildDays(from: Date, to: Date): string[] {
  const days: string[] = [];
  const cur = new Date(from);
  cur.setUTCHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setUTCHours(23, 59, 59, 999);
  while (cur <= end) {
    days.push(cur.toISOString().split("T")[0]);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

router.get("/analytics/brokers", async (_req, res) => {
  try {
    const rows = await db.execute(sql`
      SELECT DISTINCT responsible_user AS broker
      FROM sent_messages
      WHERE responsible_user IS NOT NULL
      UNION
      SELECT DISTINCT responsible_user AS broker
      FROM pending_suggestions
      WHERE responsible_user IS NOT NULL
      ORDER BY broker
    `);
    const brokers = (rows.rows as Record<string, unknown>[]).map((r) => String(r["broker"]));
    res.json({ brokers });
  } catch {
    res.json({ brokers: ["Robert"] });
  }
});

router.get("/analytics", async (req, res) => {
  try {
    const now = new Date();
    const defaultFrom = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
    const from = parseDate(req.query["from"] as string, defaultFrom);
    const to = parseDate(req.query["to"] as string, now);
    const broker = (req.query["broker"] as string) || null;

    from.setUTCHours(0, 0, 0, 0);
    to.setUTCHours(23, 59, 59, 999);

    const fromStr = from.toISOString().split("T")[0]!;
    const brokerFilter = broker ? sql`AND responsible_user = ${broker}` : sql``;
    const brokerFilterStage = broker ? sql`AND responsible_user = ${broker}` : sql``;
    const snapshotBrokerFilter = broker ? sql`AND responsible_user = ${broker}` : sql``;

    const [suggestedByDay, sentByDay, outcomesByDay, funnelRows, recentEvents, stageMovementsRows, totalMovedRow, directionRows, reactivationRow, prevSnapshotRows] = await Promise.all([
      db.execute(sql`
        SELECT
          DATE(created_at)::text AS date,
          COUNT(*)::int AS count,
          COUNT(*) FILTER (WHERE kind = 'live')::int AS live,
          COUNT(*) FILTER (WHERE kind = 'push')::int AS push
        FROM pending_suggestions
        WHERE created_at >= ${from} AND created_at <= ${to}
        ${brokerFilter}
        GROUP BY DATE(created_at)
        ORDER BY date ASC
      `),
      db.execute(sql`
        SELECT
          date,
          SUM(cnt)::int        AS count,
          SUM(live_cnt)::int   AS live,
          SUM(push_cnt)::int   AS push
        FROM (
          SELECT
            DATE(created_at)::text AS date,
            COUNT(*)               AS cnt,
            COUNT(*) FILTER (WHERE kind = 'live') AS live_cnt,
            COUNT(*) FILTER (WHERE kind = 'push') AS push_cnt
          FROM sent_messages
          WHERE created_at >= ${from} AND created_at <= ${to}
          ${brokerFilter}
          GROUP BY DATE(created_at)

          UNION ALL

          SELECT
            DATE(sent_at)::text AS date,
            COUNT(*)            AS cnt,
            0                   AS live_cnt,
            COUNT(*)            AS push_cnt
          FROM contact_events
          WHERE sent_at >= ${from} AND sent_at <= ${to}
          AND source = 'direct'
          ${brokerFilter}
          GROUP BY DATE(sent_at)
        ) t
        GROUP BY date
        ORDER BY date ASC
      `).catch(() => ({ rows: [] })),
      db.execute(sql`
        SELECT
          DATE(changed_at)::text AS date,
          COUNT(*)::int AS count
        FROM stage_events
        WHERE changed_at >= ${from} AND changed_at <= ${to}
        ${brokerFilterStage}
        GROUP BY DATE(changed_at)
        ORDER BY date ASC
      `).catch(() => ({ rows: [] })),
      db.execute(sql`
        SELECT lead_stage AS stage, COUNT(*)::int AS count
        FROM leads_sync
        WHERE lead_stage IS NOT NULL AND lead_id != 'test123'
        ${broker ? sql`AND responsible_user = ${broker}` : sql``}
        GROUP BY lead_stage
        ORDER BY count DESC
      `),
      (broker
        ? db.select().from(stageEventsTable)
            .where(
              and(
                gte(stageEventsTable.changedAt, from),
                lte(stageEventsTable.changedAt, to),
                eq(stageEventsTable.responsibleUser, broker)
              )
            )
            .orderBy(desc(stageEventsTable.changedAt)).limit(30)
        : db.select().from(stageEventsTable)
            .where(and(gte(stageEventsTable.changedAt, from), lte(stageEventsTable.changedAt, to)))
            .orderBy(desc(stageEventsTable.changedAt)).limit(30)
      ).catch(() => []),
      db.execute(sql`
        SELECT
          stage,
          SUM(came_in)::int  AS came_in,
          SUM(went_out)::int AS went_out
        FROM (
          SELECT to_stage AS stage, COUNT(*) AS came_in, 0 AS went_out
          FROM stage_events
          WHERE changed_at >= ${from} AND changed_at <= ${to}
          ${brokerFilterStage}
          GROUP BY to_stage

          UNION ALL

          SELECT from_stage AS stage, 0 AS came_in, COUNT(*) AS went_out
          FROM stage_events
          WHERE from_stage IS NOT NULL
            AND changed_at >= ${from} AND changed_at <= ${to}
          ${brokerFilterStage}
          GROUP BY from_stage
        ) t
        GROUP BY stage
      `).catch(() => ({ rows: [] })),
      db.execute(sql`
        SELECT COUNT(DISTINCT lead_id)::int AS total_moved
        FROM stage_events
        WHERE changed_at >= ${from} AND changed_at <= ${to}
        ${brokerFilterStage}
      `).catch(() => ({ rows: [{ total_moved: 0 }] })),
      db.execute(sql`
        SELECT lead_id, from_stage, to_stage
        FROM stage_events
        WHERE changed_at >= ${from} AND changed_at <= ${to}
        AND from_stage IS NOT NULL
        ${brokerFilterStage}
      `).catch(() => ({ rows: [] })),
      db.execute(sql`
        SELECT
          (SELECT COUNT(DISTINCT lead_id)
           FROM sent_messages
           WHERE kind = 'push' AND created_at >= ${from} AND created_at <= ${to}
           ${brokerFilter}) AS push_leads,
          (SELECT COUNT(DISTINCT s1.lead_id)
           FROM sent_messages s1
           WHERE s1.kind = 'push' AND s1.created_at >= ${from} AND s1.created_at <= ${to}
           ${brokerFilter}
           AND EXISTS (
             SELECT 1 FROM sent_messages s2
             WHERE s2.lead_id = s1.lead_id AND s2.kind = 'live' AND s2.created_at > s1.created_at
           )) AS reactivated
      `).catch(() => ({ rows: [{ push_leads: 0, reactivated: 0 }] })),
      db.execute(
        broker
          ? sql`
              SELECT stage, count::int
              FROM funnel_snapshots
              WHERE snapshot_date = (
                SELECT MAX(snapshot_date) FROM funnel_snapshots
                WHERE snapshot_date <= ${fromStr}
              )
              AND responsible_user = ${broker}
            `
          : sql`
              SELECT stage, SUM(count)::int AS count
              FROM funnel_snapshots
              WHERE snapshot_date = (
                SELECT MAX(snapshot_date) FROM funnel_snapshots
                WHERE snapshot_date <= ${fromStr}
              )
              GROUP BY stage
            `
      ).catch(() => ({ rows: [] })),
    ]);

    const days = buildDays(from, to);

    type DayEntry = {
      suggested: number; suggested_live: number; suggested_push: number;
      sent: number; sent_live: number; sent_push: number; outcomes: number;
    };
    const empty = (): DayEntry => ({ suggested: 0, suggested_live: 0, suggested_push: 0, sent: 0, sent_live: 0, sent_push: 0, outcomes: 0 });
    const byDay = new Map<string, DayEntry>();
    days.forEach((d) => byDay.set(d, empty()));

    for (const row of suggestedByDay.rows as Record<string, unknown>[]) {
      const e = byDay.get(String(row["date"]));
      if (e) {
        e.suggested = Number(row["count"]);
        e.suggested_live = Number(row["live"]);
        e.suggested_push = Number(row["push"]);
      }
    }
    for (const row of sentByDay.rows as Record<string, unknown>[]) {
      const e = byDay.get(String(row["date"]));
      if (e) {
        e.sent = Number(row["count"]);
        e.sent_live = Number(row["live"]);
        e.sent_push = Number(row["push"]);
      }
    }
    for (const row of outcomesByDay.rows as Record<string, unknown>[]) {
      const e = byDay.get(String(row["date"]));
      if (e) e.outcomes = Number(row["count"]);
    }

    const dailyActivity = days.map((date) => {
      const d = new Date(date + "T12:00:00Z");
      const label = d.toLocaleDateString("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });
      return { date, label, ...(byDay.get(date) ?? empty()) };
    });

    const totals = dailyActivity.reduce(
      (acc, d) => ({
        suggested: acc.suggested + d.suggested,
        suggested_live: acc.suggested_live + d.suggested_live,
        suggested_push: acc.suggested_push + d.suggested_push,
        sent: acc.sent + d.sent,
        sent_live: acc.sent_live + d.sent_live,
        sent_push: acc.sent_push + d.sent_push,
        outcomes: acc.outcomes + d.outcomes,
      }),
      { suggested: 0, suggested_live: 0, suggested_push: 0, sent: 0, sent_live: 0, sent_push: 0, outcomes: 0 }
    );
    const conversionRate = totals.suggested > 0
      ? Math.round((totals.sent / totals.suggested) * 100)
      : 0;

    const reactivationData = (reactivationRow.rows[0] ?? {}) as Record<string, unknown>;
    const pushLeads = Number(reactivationData["push_leads"] ?? 0);
    const pushReactivated = Number(reactivationData["reactivated"] ?? 0);
    const pushReactivationRate = pushLeads > 0 ? Math.round((pushReactivated / pushLeads) * 100) : 0;

    // Compute forward/backward movement from direction rows
    const stageIdx = new Map(STAGE_ORDER.map((s, i) => [s.toLowerCase(), i]));
    let forwardMoves = 0;
    let backwardMoves = 0;
    const advancedLeads = new Set<string>();
    for (const row of directionRows.rows as Record<string, unknown>[]) {
      const from = String(row["from_stage"] ?? "").toLowerCase();
      const to = String(row["to_stage"] ?? "").toLowerCase();
      const fi = stageIdx.get(from) ?? -1;
      const ti = stageIdx.get(to) ?? -1;
      if (fi === -1 || ti === -1) continue;
      if (ti > fi) { forwardMoves++; advancedLeads.add(String(row["lead_id"])); }
      else if (ti < fi) backwardMoves++;
    }
    const netProgress = forwardMoves - backwardMoves;

    const funnelMap = new Map(
      (funnelRows.rows as Record<string, unknown>[]).map((r) => [
        String(r["stage"]).toLowerCase(),
        { stage: String(r["stage"]), count: Number(r["count"]) },
      ])
    );

    const movementMap = new Map(
      (stageMovementsRows.rows as Record<string, unknown>[]).map((r) => [
        String(r["stage"]).toLowerCase(),
        { cameIn: Number(r["came_in"]), wentOut: Number(r["went_out"]) },
      ])
    );

    const prevMap = new Map(
      (prevSnapshotRows.rows as Record<string, unknown>[]).map((r) => [
        String(r["stage"]).toLowerCase(),
        Number(r["count"]),
      ])
    );
    const hasPrevious = prevSnapshotRows.rows.length > 0;

    const funnel = STAGE_ORDER
      .map((s) => {
        const f = funnelMap.get(s.toLowerCase()) ?? { stage: s, count: 0 };
        const m = movementMap.get(s.toLowerCase()) ?? { cameIn: 0, wentOut: 0 };
        const previous = prevMap.get(s.toLowerCase()) ?? 0;
        const delta = f.count - previous;
        return {
          stage: f.stage || s,
          count: f.count,
          previous,
          delta,
          hasPrevious,
          cameIn: m.cameIn,
          wentOut: m.wentOut,
        };
      })
      .filter((s) => s.count > 0 || s.previous > 0);

    const totalMoved = Number(
      ((totalMovedRow.rows[0] ?? {}) as Record<string, unknown>)["total_moved"] ?? 0
    );

    res.json({
      dailyActivity,
      totals: { ...totals, conversionRate, pushLeads, pushReactivated, pushReactivationRate },
      funnel,
      totalMoved,
      progress: { forwardMoves, backwardMoves, netProgress, leadsAdvanced: advancedLeads.size },
      recentStageEvents: recentEvents,
    });
  } catch (err) {
    req.log.error({ err }, "analytics error");
    res.status(500).json({ error: "DB error" });
  }
});

/**
 * GET /api/analytics/broker-daily?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Returns per-day, per-broker activity so the dashboard can render
 * a comparison table across all brokers.
 */
router.get("/analytics/broker-daily", async (req, res) => {
  try {
    const now = new Date();
    const defaultFrom = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
    const from = parseDate(req.query["from"] as string, defaultFrom);
    const to   = parseDate(req.query["to"]   as string, now);
    from.setUTCHours(0, 0, 0, 0);
    to.setUTCHours(23, 59, 59, 999);

    const [sentRows, contactRows, stageRows] = await Promise.all([
      // sent_messages: live + push from broker approvals
      db.execute(sql`
        SELECT
          DATE(created_at)::text  AS date,
          responsible_user        AS broker,
          COUNT(*) FILTER (WHERE kind = 'live')::int AS live,
          COUNT(*) FILTER (WHERE kind = 'push')::int AS push,
          COUNT(DISTINCT lead_id)::int               AS leads
        FROM sent_messages
        WHERE created_at >= ${from} AND created_at <= ${to}
          AND responsible_user IS NOT NULL
        GROUP BY DATE(created_at), responsible_user
        ORDER BY date ASC, broker ASC
      `),
      // contact_events (source='direct'): push messages sent directly from extension
      db.execute(sql`
        SELECT
          DATE(sent_at)::text     AS date,
          responsible_user        AS broker,
          COUNT(*)::int           AS push
        FROM contact_events
        WHERE sent_at >= ${from} AND sent_at <= ${to}
          AND source = 'direct'
          AND responsible_user IS NOT NULL
        GROUP BY DATE(sent_at), responsible_user
        ORDER BY date ASC, broker ASC
      `).catch(() => ({ rows: [] })),
      // stage_events: how many leads were moved per broker per day
      db.execute(sql`
        SELECT
          DATE(changed_at)::text  AS date,
          responsible_user        AS broker,
          COUNT(DISTINCT lead_id)::int AS stage_moves
        FROM stage_events
        WHERE changed_at >= ${from} AND changed_at <= ${to}
          AND responsible_user IS NOT NULL
        GROUP BY DATE(changed_at), responsible_user
        ORDER BY date ASC, broker ASC
      `).catch(() => ({ rows: [] })),
    ]);

    // Collect all brokers seen across all sources
    const brokersSet = new Set<string>();
    for (const r of sentRows.rows    as Record<string, unknown>[]) brokersSet.add(String(r["broker"]));
    for (const r of contactRows.rows as Record<string, unknown>[]) brokersSet.add(String(r["broker"]));
    for (const r of stageRows.rows   as Record<string, unknown>[]) brokersSet.add(String(r["broker"]));
    const brokers = [...brokersSet].sort();

    // Build nested map: date → broker → { live, push, leads, stage_moves }
    type Cell = { live: number; push: number; leads: number; stage_moves: number };
    const map = new Map<string, Map<string, Cell>>();

    const getCell = (date: string, broker: string): Cell => {
      if (!map.has(date)) map.set(date, new Map());
      const dayMap = map.get(date)!;
      if (!dayMap.has(broker)) dayMap.set(broker, { live: 0, push: 0, leads: 0, stage_moves: 0 });
      return dayMap.get(broker)!;
    };

    for (const r of sentRows.rows as Record<string, unknown>[]) {
      const cell = getCell(String(r["date"]), String(r["broker"]));
      cell.live  += Number(r["live"]  ?? 0);
      cell.push  += Number(r["push"]  ?? 0);
      cell.leads += Number(r["leads"] ?? 0);
    }
    // Add contact_events push counts on top of sent_messages
    for (const r of contactRows.rows as Record<string, unknown>[]) {
      const cell = getCell(String(r["date"]), String(r["broker"]));
      cell.push += Number(r["push"] ?? 0);
    }
    for (const r of stageRows.rows as Record<string, unknown>[]) {
      const cell = getCell(String(r["date"]), String(r["broker"]));
      cell.stage_moves = Number(r["stage_moves"] ?? 0);
    }

    const days = buildDays(from, to)
      .filter((d) => map.has(d))  // only include days with actual activity
      .map((date) => {
        const d = new Date(date + "T12:00:00Z");
        const label = d.toLocaleDateString("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });
        const dayMap = map.get(date) ?? new Map<string, Cell>();
        const byBroker: Record<string, Cell> = {};
        for (const b of brokers) {
          byBroker[b] = dayMap.get(b) ?? { live: 0, push: 0, leads: 0, stage_moves: 0 };
        }
        return { date, label, brokers: byBroker };
      });

    res.json({ brokers, days });
  } catch (err) {
    req.log.error({ err }, "broker-daily analytics error");
    res.status(500).json({ error: "DB error" });
  }
});

// ── CRM Tasks list ────────────────────────────────────────────────────────────
// GET /api/analytics/tasks?status=open|closed|all&leadId=X&from=YYYY-MM-DD&to=YYYY-MM-DD&limit=100&offset=0
router.get("/analytics/tasks", async (req, res) => {
  try {
    const { status, leadId, from, to } = req.query as Record<string, string>;
    const limit = Math.min(Number(req.query["limit"] ?? 100), 500);
    const offset = Number(req.query["offset"] ?? 0);

    const conditions: ReturnType<typeof eq>[] = [];
    if (status && status !== "all") {
      conditions.push(eq(leadCrmTasksTable.status, status));
    }
    if (leadId) {
      conditions.push(eq(leadCrmTasksTable.leadId, leadId));
    }
    if (from) {
      conditions.push(gte(leadCrmTasksTable.createdAt, new Date(from)) as ReturnType<typeof eq>);
    }
    if (to) {
      const toDate = new Date(to);
      toDate.setDate(toDate.getDate() + 1);
      conditions.push(lte(leadCrmTasksTable.createdAt, toDate) as ReturnType<typeof eq>);
    }

    const where = conditions.length ? and(...conditions) : undefined;

    const [rows, totalRows] = await Promise.all([
      db
        .select()
        .from(leadCrmTasksTable)
        .where(where)
        .orderBy(desc(leadCrmTasksTable.createdAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(leadCrmTasksTable)
        .where(where),
    ]);

    res.json({ tasks: rows, total: totalRows[0]?.count ?? 0 });
  } catch (err) {
    req.log.error({ err }, "analytics/tasks error");
    res.status(500).json({ error: "DB error" });
  }
});

export default router;
