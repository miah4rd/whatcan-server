/**
 * Unicorn OS — one funnel's analytics page, in the owner's order (26.09): today's red flags, then
 *   1. Targets — per person and the team (team.ts: counted from conversations and reports);
 *   2. Work done — inflow and its cost, every stage (who works it, reached, conversion, messages
 *      sent by the bot and by people, cards now, stuck), the queue, each broker's Copilot work and
 *      reports (viewing reports in Rental, inspection reports in Rental Listings);
 *   3. Bottlenecks — the client's (or owner's) side, our side (bot or broker), the inflow.
 * Every number is split by person, with the team as the sum. Reads only; changes nothing.
 */
import { pool } from "@workspace/db";
import { logger } from "../logger";
import { baliDate, leadsBySource, CHANNEL_LABEL } from "../kpi-dashboard";
import { stageMap, type FunnelKey } from "./automation-map";
import { teamScorecard, funnelPeople, periodRange, PERIODS, type Period } from "./team";
import { OBJECTION_CATEGORIES, supplyGaps } from "./analytics";
import { amoLeadNames } from "./data";

const PIPE: Record<FunnelKey, string> = { rental: "rental", "rental-listings": "rental listings", unicorn: "unicorn" };
const SEGMENT: Record<FunnelKey, "clients" | "owners" | "sales"> = { rental: "clients", "rental-listings": "owners", unicorn: "sales" };
/** A report is due this long after the viewing or inspection started (owner, 26.09: "a few hours"). */
export const REPORT_DUE_HOURS = 3;

const lc = (s: unknown) => String(s ?? "").trim().toLowerCase();
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const at = (day: string) => `${day}T00:00:00+08:00`;
async function q(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  try {
    return (await pool.query(sql, params)).rows;
  } catch (err) {
    logger.warn({ err, sql: sql.slice(0, 90) }, "os funnel report: query failed");
    return [];
  }
}
const n = (v: unknown) => Number(v ?? 0) || 0;

// The page takes seconds to count (amoCRM sources, every broker's Copilot list): two minutes of memory.
const memo = new Map<string, { at: number; value: Promise<unknown> }>();
export function funnelReport(f: FunnelKey, opts: { period?: string; date?: string; who?: string }) {
  const k = JSON.stringify([f, opts.period, opts.date, opts.who]);
  const hit = memo.get(k);
  if (hit && Date.now() - hit.at < 120_000) return hit.value as ReturnType<typeof buildReport>;
  const value = buildReport(f, opts);
  memo.set(k, { at: Date.now(), value });
  value.catch(() => memo.delete(k));
  return value;
}

async function buildReport(f: FunnelKey, opts: { period?: string; date?: string; who?: string }) {
  if (!PIPE[f]) throw new Error("Unknown funnel.");
  const period: Period = (PERIODS as string[]).includes(String(opts.period)) ? (opts.period as Period) : "week";
  const day = opts.date && /^\d{4}-\d{2}-\d{2}$/.test(opts.date) ? opts.date : baliDate();
  const range = periodRange(period, day);
  const prev = periodRange(period, addDays(range.from, -1));
  const key = PIPE[f];
  const who = opts.who && opts.who !== "team" ? lc(opts.who) : null;
  const P = [key, at(range.from), at(range.to), who];
  const byWho = `($4::text IS NULL OR lower(l.responsible_user) = $4)`;

  const [score, map, people, reached, nowIn, sends, typed, queueAll, drafts, approve, cards, prevCards, reports, objections, spendRows] = await Promise.all([
    teamScorecard(f, { period, date: day }),
    stageMap(f),
    funnelPeople(f),
    // Cards that reached each stage in the period, and how many of those moves the bot made.
    q(
      `SELECT e.to_stage AS stage, l.responsible_user AS who, count(DISTINCT e.lead_id)::int AS n, count(DISTINCT e.lead_id) FILTER (WHERE e.responsible_user LIKE 'engine:%')::int AS bot
         FROM stage_events e JOIN leads_sync l ON l.lead_id = e.lead_id
        WHERE lower(coalesce(e.pipeline,'')) = $1 AND e.changed_at >= $2 AND e.changed_at < $3 AND ${byWho} GROUP BY 1, 2`,
      P,
    ),
    // Cards in each stage now, per person, and those with no stage move for 7 days.
    q(
      `SELECT l.lead_stage AS stage, l.responsible_user AS who, count(*)::int AS n,
              count(*) FILTER (WHERE coalesce(last.changed_at, l.amo_created_at) < now() - interval '7 days')::int AS stuck
         FROM leads_sync l LEFT JOIN LATERAL (SELECT changed_at FROM stage_events e WHERE e.lead_id = l.lead_id ORDER BY changed_at DESC LIMIT 1) last ON true
        WHERE lower(coalesce(l.pipeline,'')) = $1 AND ${byWho.replaceAll("$4", "$2")}
          -- live work only, as on the board: a message or creation in the last 60 days
          AND greatest(coalesce(l.last_message_at, 'epoch'), coalesce(l.amo_created_at, 'epoch')) > now() - interval '60 days'
        GROUP BY 1, 2`,
      [key, who],
    ),
    // Messages sent through the Copilot, by the stage the card was in: by the autopilot or approved by a person.
    q(
      `SELECT coalesce(st.to_stage, l.lead_stage) AS stage, l.responsible_user AS who, count(*)::int AS n, count(*) FILTER (WHERE coalesce(p.auto_sent,false))::int AS auto
         FROM sent_messages m JOIN leads_sync l ON l.lead_id = m.lead_id
         LEFT JOIN pending_suggestions p ON p.id = m.suggestion_id
         LEFT JOIN LATERAL (SELECT to_stage FROM stage_events e WHERE e.lead_id = m.lead_id AND e.changed_at <= m.created_at ORDER BY changed_at DESC LIMIT 1) st ON true
        WHERE lower(coalesce(l.pipeline,'')) = $1 AND m.created_at >= $2 AND m.created_at < $3 AND m.webhook_status BETWEEN 200 AND 299 AND ${byWho}
        GROUP BY 1, 2`,
      P,
    ),
    // Messages people typed on the phone themselves (the gateway marks them since the channel move).
    q(
      `SELECT l.responsible_user AS who, count(*)::int AS n FROM wa_messages w JOIN leads_sync l ON l.lead_id = w.card_lead_id::text
        WHERE w.direction = 'out_phone' AND lower(coalesce(l.pipeline,'')) = $1 AND w.created_at >= $2 AND w.created_at < $3 AND ${byWho} GROUP BY 1`,
      P,
    ),
    copilotQueue(key),
    // Drafts decided in the period, per person: as written, edited, skipped; the autopilot apart.
    q(
      `SELECT l.responsible_user AS who,
              count(*) FILTER (WHERE p.status = 'approved' AND NOT coalesce(p.auto_sent,false))::int AS as_written,
              count(*) FILTER (WHERE p.status = 'edited')::int AS edited,
              count(*) FILTER (WHERE p.status = 'skipped')::int AS skipped,
              count(*) FILTER (WHERE coalesce(p.auto_sent,false))::int AS auto
         FROM pending_suggestions p JOIN leads_sync l ON l.lead_id = p.lead_id
        WHERE lower(coalesce(l.pipeline,'')) = $1 AND p.created_at >= $2 AND p.created_at < $3 AND ${byWho} GROUP BY 1`,
      P,
    ),
    // How long a draft waits for a person's send, per person (median minutes).
    q(
      `SELECT l.responsible_user AS who, round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM m.created_at - p.created_at) / 60))::int AS min
         FROM sent_messages m JOIN pending_suggestions p ON p.id = m.suggestion_id JOIN leads_sync l ON l.lead_id = m.lead_id
        WHERE NOT coalesce(p.auto_sent,false) AND lower(coalesce(l.pipeline,'')) = $1 AND m.created_at >= $2 AND m.created_at < $3 AND m.created_at > p.created_at AND ${byWho} GROUP BY 1`,
      P,
    ),
    q(`SELECT l.lead_id, l.responsible_user AS who, l.discard_reason FROM leads_sync l WHERE lower(coalesce(l.pipeline,'')) = $1 AND l.amo_created_at >= $2 AND l.amo_created_at < $3 AND ${byWho}`, P),
    q(`SELECT count(*)::int AS n FROM leads_sync l WHERE lower(coalesce(l.pipeline,'')) = $1 AND l.amo_created_at >= $2 AND l.amo_created_at < $3 AND ${byWho}`, [key, at(prev.from), at(prev.to), who]),
    reportRows(f, range, who),
    q(
      `SELECT o.source, o.category, count(DISTINCT o.lead_id)::int AS clients, (array_agg(o.quote ORDER BY o.said_at DESC))[1:2] AS quotes
         FROM os_objections o LEFT JOIN leads_sync l ON l.lead_id = o.lead_id
        WHERE lower(coalesce(o.pipeline,'')) = $1 AND o.said_at >= $2 AND o.said_at < $3 AND ($4::text IS NULL OR lower(coalesce(l.responsible_user, o.broker)) = $4)
        GROUP BY 1, 2 ORDER BY 3 DESC`,
      P,
    ),
    q(`SELECT campaign_name, currency, sum(spend)::float8 AS spend, sum(meta_leads)::int AS meta_leads FROM kpi_ad_spend WHERE day >= $1 AND day < $2 GROUP BY 1, 2`, [range.from, range.to]),
  ]);

  // The queue and who waits on us come from the Copilot's own list: what the brokers see.
  const queue = who ? queueAll.filter((x) => lc(x.who) === who) : queueAll;
  const unanswered = queue.filter((x) => x.kind === "live" && x.since != null && Date.now() - x.since > 4 * 3600_000);

  // ── people: those who hold cards here, or the one asked for
  const names = who ? people.filter((p) => lc(p) === who) : people;
  const personOf = (w: unknown) => names.find((p) => lc(p) === lc(w)) ?? null;

  // ── 2. stages: every stage of the funnel, in order
  const sum = (rows: Record<string, unknown>[], k: string, stage: string) => rows.filter((r) => lc(r.stage) === lc(stage)).reduce((s, r) => s + n(r[k]), 0);
  // Side stages (closed, co-broke, long term, the reserve, the weekly check) are not steps of the main
  // path: no conversion is read into them. Entries in a period are not a cohort, so a ratio over 100%
  // or on fewer than 3 cards says nothing and is not shown.
  const SIDE = /closed|lost|won|успешно|закрыто|co-?broke|long term|backlog|weekly check|update availability/i;
  let prevReached: number | null = null;
  const stages = map.stages.map((s) => {
    const r = sum(reached, "n", s.name);
    const ratio = !SIDE.test(s.name) && prevReached != null && prevReached >= 3 ? Math.round((r / prevReached) * 100) : null;
    const conv = ratio != null && ratio <= 100 ? ratio : null;
    if (!SIDE.test(s.name) && r > 0) prevReached = r;
    // Who works the stage now: a person only, a rule in code, the autopilot, or people through the Copilot.
    const workedBy = s.owner === "person" ? "person" : s.owner === "rule" ? "rule" : s.owner === "copilot" ? (s.autopilot === "autopilot" ? "autopilot" : "copilot") : "workflow";
    return {
      name: s.name,
      workedBy,
      reached: r,
      movedByBot: sum(reached, "bot", s.name),
      // The same stage, card holder by card holder (the funnel by person).
      byPerson: Object.fromEntries(names.map((p) => [p, reached.filter((r) => lc(r.stage) === lc(s.name) && lc(r.who) === lc(p)).reduce((t, r) => t + n(r.n), 0)])),
      conv,
      sent: sum(sends, "n", s.name),
      sentByAutopilot: sum(sends, "auto", s.name),
      now: sum(nowIn, "n", s.name),
      stuck: sum(nowIn, "stuck", s.name),
    };
  });

  // "Stuck" per person counts the funnel's main path only: side stages (co-broke, long term, closed)
  // and stage names amoCRM no longer has are not work waiting to move.
  const mainPath = new Set(map.stages.filter((s) => !SIDE.test(s.name)).map((s) => lc(s.name)));
  const stagesOut = stages.map((s) => (SIDE.test(s.name) ? { ...s, stuck: 0 } : s));

  // ── totals: who did the work
  const autoSent = sends.reduce((s, r) => s + n(r.auto), 0);
  const copilotSent = sends.reduce((s, r) => s + n(r.n) - n(r.auto), 0);
  const phoneTyped = typed.reduce((s, r) => s + n(r.n), 0);
  const allSent = autoSent + copilotSent + phoneTyped;
  const work = {
    autopilot: autoSent,
    approvedInCopilot: copilotSent,
    typedOnPhone: phoneTyped,
    botShare: allSent ? Math.round((autoSent / allSent) * 100) : null,
    // A message the bot wrote and a person only approved is half the work saved; one it sent alone, all of it.
    hoursSaved: Math.round(((autoSent * 3 + copilotSent * 2) / 60) * 10) / 10,
    queue: { live: queue.filter((x) => x.kind === "live").length, push: queue.filter((x) => x.kind !== "live").length },
  };

  // ── inflow: new cards, their sources, what they cost
  let sources: Array<{ channel: string; label: string; n: number }> = [];
  try {
    const src = await leadsBySource(range.from, addDays(range.to, -1));
    const inFunnel = new Map(cards.map((c) => [String(c.lead_id), c]));
    const counts = new Map<string, number>();
    for (const l of src) if (l.segment === SEGMENT[f] && (!who || inFunnel.has(l.id))) counts.set(l.channel, (counts.get(l.channel) ?? 0) + 1);
    sources = [...counts.entries()].map(([channel, k]) => ({ channel, label: CHANNEL_LABEL[channel as keyof typeof CHANNEL_LABEL] ?? channel, n: k })).sort((a, b) => b.n - a.n);
  } catch (err) {
    logger.warn({ err }, "os funnel report: sources failed");
  }
  // Ad spend belongs to the funnel its campaign is named for.
  const campaignFunnel = (name: string): FunnelKey => (/listing|owner|villa owner/i.test(name) ? "rental-listings" : /sale|unicorn|invest/i.test(name) ? "unicorn" : "rental");
  const spend = spendRows.filter((r) => campaignFunnel(String(r.campaign_name ?? "")) === f);
  const spendTotal = spend.reduce((s, r) => s + n(r.spend), 0);
  const paidLeads = sources.filter((s) => s.channel === "paid_meta_form" || s.channel === "paid_website").reduce((s, x) => s + x.n, 0);
  const belowBudget = cards.filter((c) => /budget/i.test(String(c.discard_reason ?? ""))).length;
  const inflow = {
    newCards: cards.length,
    prevNewCards: n(prevCards[0]?.n),
    sources,
    belowBudget,
    spend: spendTotal ? { amount: Math.round(spendTotal), currency: String(spend[0]?.currency ?? ""), campaigns: spend.map((r) => String(r.campaign_name)), perPaidLead: paidLeads ? Math.round(spendTotal / paidLeads) : null, perCard: cards.length ? Math.round(spendTotal / cards.length) : null } : null,
  };

  // ── per person: the Copilot work and the reports
  const row = (rows: Record<string, unknown>[], p: string) => rows.filter((r) => lc(r.who) === lc(p));
  const brokersAll = names.map((p) => {
    const d = row(drafts, p)[0] ?? {};
    const decided = n(d.as_written) + n(d.edited) + n(d.skipped);
    const sc = score.people.find((x) => lc(x.name) === lc(p));
    const rep = reports.filter((r) => lc(r.who) === lc(p));
    return {
      name: p,
      replyMin: sc?.values["reply_min"]?.v ?? null,
      approveMin: row(approve, p)[0]?.min == null ? null : n(row(approve, p)[0].min),
      draftsDecided: decided,
      asWrittenPct: decided ? Math.round((n(d.as_written) / decided) * 100) : null,
      autopilotSent: n(d.auto),
      overdueTasks: sc?.values["overdue_tasks"]?.v ?? 0,
      reports: { planned: rep.length, filed: rep.filter((r) => r.filedAt).length, late: rep.filter((r) => r.late).length, missing: rep.filter((r) => !r.filedAt && r.overdue).length },
      unanswered: row(unanswered, p).length,
      stuck: nowIn.filter((r) => lc(r.who) === lc(p) && mainPath.has(lc(r.stage))).reduce((s, r) => s + n(r.stuck), 0),
      sentByPerson: sends.filter((r) => lc(r.who) === lc(p)).reduce((s, r) => s + n(r.n) - n(r.auto), 0) + n(row(typed, p)[0]?.n),
    };
  });
  // Card holders with no work and no target in the period (an admin account, a manager's login) are not rows.
  const brokers = brokersAll.filter((b) => b.draftsDecided || b.sentByPerson || b.reports.planned || b.unanswered || b.stuck || score.people.some((x) => lc(x.name) === lc(b.name) && Object.keys(x.targets).length));
  const teamRow = {
    name: "Team",
    replyMin: score.team.values["reply_min"]?.v ?? null,
    approveMin: null as number | null,
    draftsDecided: brokers.reduce((s, b) => s + b.draftsDecided, 0),
    asWrittenPct: (() => {
      const all = drafts.reduce((s, d) => s + n(d.as_written) + n(d.edited) + n(d.skipped), 0);
      return all ? Math.round((drafts.reduce((s, d) => s + n(d.as_written), 0) / all) * 100) : null;
    })(),
    autopilotSent: brokers.reduce((s, b) => s + b.autopilotSent, 0),
    overdueTasks: brokers.reduce((s, b) => s + b.overdueTasks, 0),
    reports: { planned: reports.length, filed: reports.filter((r) => r.filedAt).length, late: reports.filter((r) => r.late).length, missing: reports.filter((r) => !r.filedAt && r.overdue).length },
    unanswered: unanswered.length,
    stuck: nowIn.filter((r) => mainPath.has(lc(r.stage))).reduce((s, r) => s + n(r.stuck), 0),
    sentByPerson: copilotSent + phoneTyped,
  };

  // ── 3. bottlenecks
  const objectionGroup = (source: string) => {
    const rows = objections.filter((o) => (source === "report" ? o.source === "viewing-report" : o.source !== "viewing-report"));
    const clients = rows.reduce((s, r) => s + n(r.clients), 0);
    return rows.slice(0, 6).map((r) => ({ category: String(r.category), label: OBJECTION_CATEGORIES[String(r.category)] ?? String(r.category), clients: n(r.clients), share: clients ? Math.round((n(r.clients) / clients) * 100) : 0, quotes: ((r.quotes as string[]) ?? []).filter(Boolean) }));
  };
  let supply: Array<Record<string, unknown>> = [];
  if (f === "rental") {
    try {
      supply = ((await supplyGaps(14)).segments as Array<Record<string, unknown>>).slice(0, 5);
    } catch {
      supply = [];
    }
  }
  const bottlenecks = {
    clientSide: f === "rental-listings" ? { beforeInspection: objectionGroup("message") } : { beforeViewing: objectionGroup("message"), afterViewing: objectionGroup("report") },
    ourSide: [...brokers.map((b) => ({ name: b.name, unanswered: b.unanswered, stuck: b.stuck, overdueTasks: b.overdueTasks, reportsMissing: b.reports.missing })), { name: "Team", unanswered: teamRow.unanswered, stuck: teamRow.stuck, overdueTasks: teamRow.overdueTasks, reportsMissing: teamRow.reports.missing }],
    stuckByStage: stagesOut.filter((s) => s.stuck > 0).sort((a, b) => b.stuck - a.stuck).slice(0, 4).map((s) => ({ stage: s.name, stuck: s.stuck, workedBy: s.workedBy })),
    inflow: { newCards: inflow.newCards, prevNewCards: inflow.prevNewCards, belowBudget, supply },
  };

  // ── today: the red flags, as of now, whatever the period
  const nameOf = await amoLeadNames([...new Set(reports.filter((x) => !x.filedAt && x.overdue).map((x) => String(x.leadId)))]).catch(() => new Map<string, string>());
  const flags: Array<{ level: "red" | "amber"; text: string; leadId?: string; who?: string }> = [];
  for (const r of reports.filter((x) => !x.filedAt && x.overdue)) flags.push({ level: "red", who: String(r.who ?? ""), leadId: String(r.leadId), text: `${r.who || "Nobody"} has not filed the ${f === "rental-listings" ? "inspection" : "viewing"} report for ${nameOf.get(String(r.leadId)) || "#" + r.leadId} (${r.kind === "inspection" ? "inspection" : "viewing"} ${new Date(String(r.at)).toISOString().slice(0, 16).replace("T", " ")} UTC)` });
  const unBy = new Map<string, number>();
  for (const u of unanswered) unBy.set(String(u.who ?? "nobody"), (unBy.get(String(u.who ?? "nobody")) ?? 0) + 1);
  for (const [p, k] of unBy) flags.push({ level: k >= 5 ? "red" : "amber", who: p, text: `${k} client${k === 1 ? "" : "s"} waiting over 4 hours for ${p}` });
  if (period !== "day") {
    const elapsed = Math.min(1, Math.max(0, (Date.now() - Date.parse(at(range.from))) / (Date.parse(at(range.to)) - Date.parse(at(range.from)))));
    for (const p of score.people) {
      for (const m of score.metrics.filter((x) => x.target)) {
        const t = p.targets[m.key];
        if (!t || t.value <= 0) continue;
        const v = p.values[m.key]?.v ?? 0;
        if (elapsed > 0.3 && v < t.value * elapsed * 0.7) flags.push({ level: "amber", who: p.name, text: `${p.name}: ${m.label.toLowerCase()} ${v} of ${t.value}, behind the pace` });
      }
    }
  }

  return {
    funnel: f,
    period,
    from: range.from,
    to: range.to,
    who: who ?? "team",
    people,
    reportDueHours: REPORT_DUE_HOURS,
    flags,
    targets: score,
    work: { ...work, inflow, stages: stagesOut },
    brokers: [...brokers, teamRow],
    bottlenecks,
  };
}

/**
 * The Copilot's drafts list for this funnel, as the brokers see it (the same handler the Copilot page
 * calls, asked over the loopback), one row per draft: whose, which kind, since when the client waits.
 */
async function copilotQueue(key: string): Promise<Array<{ who: string; kind: string; since: number | null; leadId: string }>> {
  const port = process.env["PORT"] || "5000";
  const holders = await q(
    `SELECT DISTINCT l.responsible_user AS who FROM pending_suggestions p JOIN leads_sync l ON l.lead_id = p.lead_id
      WHERE p.status = 'pending' AND lower(coalesce(l.pipeline,'')) = $1 AND l.responsible_user IS NOT NULL`,
    [key],
  );
  const out: Array<{ who: string; kind: string; since: number | null; leadId: string }> = [];
  await Promise.all(
    holders.map(async (h) => {
      const person = String(h.who);
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/public/suggestions?responsibleUser=${encodeURIComponent(person)}`, { signal: AbortSignal.timeout(20_000) });
        const j = (await r.json()) as { items?: Array<Record<string, unknown>> };
        for (const it of j.items ?? []) {
          if (lc(it["pipeline"]) !== key) continue;
          const since = it["triggered_by_message_at"] ?? it["created_at"];
          out.push({ who: person, kind: String(it["kind"] ?? ""), since: since ? Date.parse(String(since)) : null, leadId: String(it["lead_id"]) });
        }
      } catch (err) {
        logger.warn({ err, person }, "os funnel report: Copilot list failed");
      }
    }),
  );
  return out;
}

/** Viewings (Rental) or inspections (Rental Listings) held in the period, with their report's state. */
async function reportRows(f: FunnelKey, range: { from: string; to: string }, who: string | null) {
  const due = `interval '${REPORT_DUE_HOURS} hours'`;
  if (f === "rental") {
    const rows = await q(
      `SELECT r.lead_id, l.responsible_user AS who, r.viewing_at AS at, r.filed_at, r.status
         FROM viewing_reports r JOIN leads_sync l ON l.lead_id = r.lead_id
        WHERE r.status <> 'cancelled' AND r.viewing_at >= $1 AND r.viewing_at < $2 AND r.viewing_at <= now() AND ($3::text IS NULL OR lower(l.responsible_user) = $3)`,
      [at(range.from), at(range.to), who],
    );
    return rows.map((r) => shape(r, "viewing", due));
  }
  if (f === "rental-listings") {
    const rows = await q(
      `SELECT s.lead_id, l.responsible_user AS who, s.visit_at AS at,
              (SELECT min(coalesce(ir.filed_at, ir.done_at)) FROM inspection_reports ir WHERE ir.lead_id = s.lead_id AND coalesce(ir.filed_at, ir.done_at) >= s.visit_at - interval '12 hours') AS filed_at
         FROM listing_inspection_slots s JOIN leads_sync l ON l.lead_id = s.lead_id
        WHERE s.superseded_at IS NULL AND coalesce(s.status,'') NOT IN ('cancelled','superseded') AND s.visit_at >= $1 AND s.visit_at < $2 AND s.visit_at <= now()
          AND ($3::text IS NULL OR lower(l.responsible_user) = $3)`,
      [at(range.from), at(range.to), who],
    );
    return rows.map((r) => shape(r, "inspection", due));
  }
  return [];
}
function shape(r: Record<string, unknown>, kind: "viewing" | "inspection", _due: string) {
  const start = Date.parse(String(r.at));
  const dueAt = start + REPORT_DUE_HOURS * 3600_000;
  const filed = r.filed_at ? Date.parse(String(r.filed_at)) : null;
  return {
    kind,
    leadId: String(r.lead_id),
    who: r.who ? String(r.who) : null,
    at: r.at,
    filedAt: r.filed_at ?? null,
    late: filed != null && filed > dueAt,
    overdue: filed == null && Date.now() > dueAt,
  };
}
