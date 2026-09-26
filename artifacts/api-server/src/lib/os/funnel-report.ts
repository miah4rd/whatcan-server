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
import { teamScorecard, funnelPeople, periodRange, customRange, spanDays, PERIODS, type Period } from "./team";
import { OBJECTION_CATEGORIES } from "./analytics";
import { amoLeadNames, pipelines } from "./data";
import { amoFetch } from "../amo-client";
import { cleanLeadName } from "../lead-display-name";
import { demandMatrix } from "./demand-matrix";

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

/**
 * Card names as the boards show them: a client by the name they wrote under (their first message),
 * a villa card by its amoCRM name. amoCRM's own names of client cards can be anything
 * ("R-UM-024 - qualification" on Melinda Langford's card).
 */
async function cardNames(f: FunnelKey, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  if (f !== "rental-listings") {
    const r = await q(
      `SELECT DISTINCT ON (lead_id) lead_id, sender_name FROM lead_messages WHERE lead_id = ANY($1) AND sender_type = 'lead' AND coalesce(sender_name,'') <> '' ORDER BY lead_id, sent_at ASC`,
      [ids],
    );
    for (const x of r) {
      const nm = cleanLeadName(String(x.sender_name));
      if (nm) out.set(String(x.lead_id), nm);
    }
  }
  const rest = ids.filter((id) => !out.has(id));
  if (rest.length) for (const [id, nm] of await amoLeadNames(rest).catch(() => new Map<string, string>())) out.set(id, nm);
  return out;
}

const PIPELINE_ID: Record<FunnelKey, number> = { rental: 11119150, "rental-listings": 11180334, unicorn: 8347534 };
const moveCache = new Map<string, { at: number; value: Array<{ lead_id: string; stage: string; by: number }> }>();
/**
 * Every stage change into a funnel from amoCRM's own event log (owner, 26.09: "take it straight from
 * the funnel"). Our stage_events table misses moves made by hand in amoCRM and by the site's Listed
 * switch (15 cards sat in live with one recorded move), so the funnel reads amoCRM's log.
 */
async function amoStageMoves(f: FunnelKey, from: string, to: string) {
  const fromSec = Math.floor(Date.parse(`${from}T00:00:00+08:00`) / 1000);
  const toSec = Math.floor(Date.parse(`${to}T00:00:00+08:00`) / 1000);
  const k = `${f}:${fromSec}:${toSec}`;
  const hit = moveCache.get(k);
  const finished = toSec * 1000 < Date.now();
  if (hit && Date.now() - hit.at < (finished ? 6 * 3600_000 : 5 * 60_000)) return hit.value;
  const names = new Map<number, string>();
  for (const pl of await pipelines()) for (const st of pl.stages) names.set(Number(st.id), st.name);
  const out: Array<{ lead_id: string; stage: string; by: number }> = [];
  for (let page = 1; page <= 60; page++) {
    const d = await amoFetch<{ _embedded?: { events?: Array<{ entity_id: number; created_by: number; value_after?: Array<{ lead_status?: { id: number; pipeline_id: number } }> }> } }>(
      `/api/v4/events?filter[type]=lead_status_changed&filter[created_at][from]=${fromSec}&filter[created_at][to]=${toSec - 1}` +
        `&filter[value_after][leads_statuses][0][pipeline_id]=${PIPELINE_ID[f]}&limit=100&page=${page}`,
    );
    if (!d) throw new Error("amoCRM events unavailable");
    const events = d._embedded?.events ?? [];
    for (const e of events) {
      const st = e.value_after?.[0]?.lead_status;
      if (!st || st.pipeline_id !== PIPELINE_ID[f]) continue;
      out.push({ lead_id: String(e.entity_id), stage: names.get(st.id) ?? String(st.id), by: e.created_by });
    }
    if (events.length < 100) break;
  }
  moveCache.set(k, { at: Date.now(), value: out });
  return out;
}

// The page takes seconds to count (amoCRM sources, every broker's Copilot list): two minutes of memory.
const memo = new Map<string, { at: number; value: Promise<unknown> }>();
export function funnelReport(f: FunnelKey, opts: { period?: string; date?: string; who?: string; from?: string; to?: string }) {
  const k = JSON.stringify([f, opts.period, opts.date, opts.who, opts.from, opts.to]);
  const hit = memo.get(k);
  if (hit && Date.now() - hit.at < 120_000) return hit.value as ReturnType<typeof buildReport>;
  const value = buildReport(f, opts);
  memo.set(k, { at: Date.now(), value });
  value.catch(() => memo.delete(k));
  return value;
}

async function buildReport(f: FunnelKey, opts: { period?: string; date?: string; who?: string; from?: string; to?: string }) {
  if (!PIPE[f]) throw new Error("Unknown funnel.");
  const period: Period = (PERIODS as string[]).includes(String(opts.period)) ? (opts.period as Period) : "week";
  const day = opts.date && /^\d{4}-\d{2}-\d{2}$/.test(opts.date) ? opts.date : baliDate();
  const custom = customRange(opts.from, opts.to);
  const range = custom ?? periodRange(period, day);
  const prev = custom ? { from: addDays(custom.from, -spanDays(custom)), to: custom.from } : periodRange(period, addDays(range.from, -1));
  const key = PIPE[f];
  const who = opts.who && opts.who !== "team" ? lc(opts.who) : null;
  const P = [key, at(range.from), at(range.to), who];
  const byWho = `($4::text IS NULL OR lower(l.responsible_user) = $4)`;
  const PP = [key, at(prev.from), at(prev.to), who];
  const SQL_SENDS = `SELECT coalesce(st.to_stage, l.lead_stage) AS stage, l.responsible_user AS who, count(*)::int AS n, count(*) FILTER (WHERE coalesce(p.auto_sent,false))::int AS auto
         FROM sent_messages m JOIN leads_sync l ON l.lead_id = m.lead_id
         LEFT JOIN pending_suggestions p ON p.id = m.suggestion_id
         LEFT JOIN LATERAL (SELECT to_stage FROM stage_events e WHERE e.lead_id = m.lead_id AND e.changed_at <= m.created_at ORDER BY changed_at DESC LIMIT 1) st ON true
        WHERE lower(coalesce(l.pipeline,'')) = $1 AND m.created_at >= $2 AND m.created_at < $3 AND m.webhook_status BETWEEN 200 AND 299 AND ${byWho}
        GROUP BY 1, 2`;
  const SQL_TYPED = `SELECT l.responsible_user AS who, count(*)::int AS n FROM wa_messages w JOIN leads_sync l ON l.lead_id = w.card_lead_id::text
        WHERE w.direction = 'out_phone' AND lower(coalesce(l.pipeline,'')) = $1 AND w.created_at >= $2 AND w.created_at < $3 AND ${byWho} GROUP BY 1`;
  const SQL_DRAFTS = `SELECT l.responsible_user AS who,
              count(*) FILTER (WHERE p.status = 'approved' AND NOT coalesce(p.auto_sent,false))::int AS as_written,
              count(*) FILTER (WHERE p.status = 'edited')::int AS edited,
              count(*) FILTER (WHERE p.status = 'skipped')::int AS skipped,
              count(*) FILTER (WHERE coalesce(p.auto_sent,false))::int AS auto
         FROM pending_suggestions p JOIN leads_sync l ON l.lead_id = p.lead_id
        WHERE lower(coalesce(l.pipeline,'')) = $1 AND p.created_at >= $2 AND p.created_at < $3 AND ${byWho} GROUP BY 1`;
  const SQL_APPROVE = `SELECT l.responsible_user AS who, round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM m.created_at - p.created_at) / 60))::int AS min
         FROM sent_messages m JOIN pending_suggestions p ON p.id = m.suggestion_id JOIN leads_sync l ON l.lead_id = m.lead_id
        WHERE NOT coalesce(p.auto_sent,false) AND lower(coalesce(l.pipeline,'')) = $1 AND m.created_at >= $2 AND m.created_at < $3 AND m.created_at > p.created_at AND ${byWho} GROUP BY 1`;

  const [score, map, people, reached, reachedPrev, nowIn, sends, typed, queueAll, drafts, approve, cards, prevCards, reports, objections, spendRows] = await Promise.all([
    teamScorecard(f, custom ? { from: opts.from, to: opts.to } : { period, date: day }),
    stageMap(f),
    funnelPeople(f),
    // Every stage move in the period, and in the period before: the funnel is built from them below.
    q(
      `SELECT e.lead_id, e.to_stage AS stage, l.responsible_user AS who, (e.responsible_user LIKE 'engine:%') AS bot
         FROM stage_events e JOIN leads_sync l ON l.lead_id = e.lead_id
        WHERE lower(coalesce(e.pipeline,'')) = $1 AND e.changed_at >= $2 AND e.changed_at < $3 AND ${byWho}`,
      P,
    ),
    q(
      `SELECT e.lead_id, e.to_stage AS stage, l.responsible_user AS who
         FROM stage_events e JOIN leads_sync l ON l.lead_id = e.lead_id
        WHERE lower(coalesce(e.pipeline,'')) = $1 AND e.changed_at >= $2 AND e.changed_at < $3 AND ${byWho}`,
      [key, at(prev.from), at(prev.to), who],
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
      SQL_SENDS,
      P,
    ),
    // Messages people typed on the phone themselves (the gateway marks them since the channel move).
    q(
      SQL_TYPED,
      P,
    ),
    copilotQueue(key),
    // Drafts decided in the period, per person: as written, edited, skipped; the autopilot apart.
    q(
      SQL_DRAFTS,
      P,
    ),
    // How long a draft waits for a person's send, per person (median minutes).
    q(
      SQL_APPROVE,
      P,
    ),
    q(`SELECT l.lead_id, l.responsible_user AS who, l.discard_reason, l.req_budget_idr_monthly FROM leads_sync l WHERE lower(coalesce(l.pipeline,'')) = $1 AND l.amo_created_at >= $2 AND l.amo_created_at < $3 AND ${byWho}`, P),
    q(`SELECT l.lead_id, l.responsible_user AS who, l.discard_reason, l.req_budget_idr_monthly FROM leads_sync l WHERE lower(coalesce(l.pipeline,'')) = $1 AND l.amo_created_at >= $2 AND l.amo_created_at < $3 AND ${byWho}`, [key, at(prev.from), at(prev.to), who]),
    reportRows(f, range, who),
    q(
      `SELECT o.lead_id, o.source, o.category, o.quote, o.said_at, coalesce(l.responsible_user, o.broker) AS who
         FROM os_objections o LEFT JOIN leads_sync l ON l.lead_id = o.lead_id
        WHERE lower(coalesce(o.pipeline,'')) = $1 AND o.said_at >= $2 AND o.said_at < $3 AND ($4::text IS NULL OR lower(coalesce(l.responsible_user, o.broker)) = $4)
        ORDER BY o.said_at DESC`,
      P,
    ),
    q(`SELECT campaign_name, currency, sum(spend)::float8 AS spend, sum(meta_leads)::int AS meta_leads FROM kpi_ad_spend WHERE day >= $1 AND day < $2 GROUP BY 1, 2`, [range.from, range.to]),
  ]);

  // The same work in the period before, for every number's change (owner, 26.09).
  const [sendsPrev, typedPrev, draftsPrev, approvePrev, reportsPrev] = await Promise.all([q(SQL_SENDS, PP), q(SQL_TYPED, PP), q(SQL_DRAFTS, PP), q(SQL_APPROVE, PP), reportRows(f, prev, who)]);

  // Objections in the period before (for each reason's change), and the system's own health.
  const [objectionsPrev, tech] = await Promise.all([
    q(
      `SELECT o.source, o.category, count(DISTINCT o.lead_id)::int AS clients FROM os_objections o LEFT JOIN leads_sync l ON l.lead_id = o.lead_id
        WHERE lower(coalesce(o.pipeline,'')) = $1 AND o.said_at >= $2 AND o.said_at < $3 AND ($4::text IS NULL OR lower(coalesce(l.responsible_user, o.broker)) = $4) GROUP BY 1, 2`,
      PP,
    ),
    q(
      `SELECT
         (SELECT count(*) FROM sent_messages m JOIN leads_sync l ON l.lead_id = m.lead_id WHERE lower(coalesce(l.pipeline,'')) = $1 AND m.created_at >= $2 AND m.created_at < $3 AND NOT (m.webhook_status BETWEEN 200 AND 299))::int AS failed,
         (SELECT count(*) FROM sent_messages m JOIN leads_sync l ON l.lead_id = m.lead_id WHERE lower(coalesce(l.pipeline,'')) = $1 AND m.created_at >= $4 AND m.created_at < $5 AND NOT (m.webhook_status BETWEEN 200 AND 299))::int AS failed_prev,
         (SELECT count(*) FROM wa_messages w WHERE w.status = 'error' AND coalesce(w.error,'') <> 'not_on_whatsapp' AND w.created_at >= $2 AND w.created_at < $3)::int AS wa_errors,
         (SELECT extract(epoch FROM now() - max(updated_at)) / 60 FROM leads_sync)::int AS sync_lag_min,
         (SELECT coalesce(sum(cost_usd), 0) FROM ai_usage WHERE created_at > now() - interval '24 hours')::float8 AS ai_24h,
         (SELECT value FROM broker_settings WHERE key = 'ai_daily_cap_usd' LIMIT 1) AS ai_cap`,
      [key, at(range.from), at(range.to), at(prev.from), at(prev.to)],
    ),
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
  // The funnel (owner, 26.09: every stage filled): a card counts at a main-path stage when, in the
  // period, it entered that stage or any later one; a card created in the period counts at the entry
  // stage (New LEAD / Initial Contact) and every stage before its furthest one. Side stages count
  // the cards that entered them. So the numbers only fall along the path and a conversion is ≤ 100%.
  const main = map.stages.filter((st) => !SIDE.test(st.name)).map((st) => lc(st.name));
  const entryIdx = Math.max(0, main.findIndex((x) => /new lead|initial contact/.test(x)));
  const furthest = (events: Record<string, unknown>[], created: Record<string, unknown>[]) => {
    const by = new Map<string, { idx: number; who: string; side: Set<string> }>();
    const get = (id: string, w: unknown) => by.get(id) ?? by.set(id, { idx: -1, who: String(w ?? ""), side: new Set() }).get(id)!;
    for (const c of created) get(String(c.lead_id), c.who).idx = Math.max(get(String(c.lead_id), c.who).idx, entryIdx);
    for (const e of events) {
      const x = get(String(e.lead_id), e.who);
      const k = main.indexOf(lc(e.stage));
      if (k >= 0) x.idx = Math.max(x.idx, k);
      else x.side.add(lc(e.stage));
    }
    return by;
  };
  // The funnel's moves from amoCRM's log; our own stage_events only if amoCRM cannot answer.
  const holder = new Map<string, unknown>();
  for (const r of await q(`SELECT lead_id, responsible_user FROM leads_sync WHERE lower(coalesce(pipeline,'')) = $1`, [key])) holder.set(String(r.lead_id), r.responsible_user);
  const botPairs = new Set(reached.filter((e) => e.bot).map((e) => `${e.lead_id}|${lc(e.stage)}`));
  const fromAmo = async (a: string, b: string, fallback: Record<string, unknown>[]) => {
    try {
      const moves = await amoStageMoves(f, a, b);
      return moves
        .map((m) => ({ lead_id: m.lead_id, stage: m.stage, who: holder.get(m.lead_id) ?? null, bot: botPairs.has(`${m.lead_id}|${lc(m.stage)}`) }))
        .filter((m) => !who || lc(m.who) === who);
    } catch (err) {
      logger.warn({ err }, "os funnel report: amoCRM stage log unavailable, using stage_events");
      return fallback;
    }
  };
  const [movesCur, movesPrev] = await Promise.all([fromAmo(range.from, range.to, reached), fromAmo(prev.from, prev.to, reachedPrev)]);
  const cur = furthest(movesCur as Record<string, unknown>[], cards);
  const bef = furthest(movesPrev as Record<string, unknown>[], prevCards);
  const reachOf = (by: Map<string, { idx: number; who: string; side: Set<string> }>, stage: string, person?: string) => {
    const k = main.indexOf(lc(stage));
    let t = 0;
    for (const v of by.values()) {
      if (person && lc(v.who) !== lc(person)) continue;
      if (k >= 0 ? v.idx >= k : v.side.has(lc(stage))) t++;
    }
    return t;
  };
  const botMoves = (stage: string) => new Set((movesCur as Record<string, unknown>[]).filter((e) => lc(e.stage) === lc(stage) && e.bot).map((e) => String(e.lead_id))).size;
  let prevReached: number | null = null;
  let prevReachedBefore: number | null = null;
  const stages = map.stages.map((s) => {
    const r = reachOf(cur, s.name);
    const ratio = !SIDE.test(s.name) && prevReached != null && prevReached >= 3 ? Math.round((r / prevReached) * 100) : null;
    const conv = ratio;
    if (!SIDE.test(s.name)) prevReached = r;
    // The same step's conversion in the period before.
    const rb = reachOf(bef, s.name);
    const ratioB = !SIDE.test(s.name) && prevReachedBefore != null && prevReachedBefore >= 3 ? Math.round((rb / prevReachedBefore) * 100) : null;
    const convPrev = ratioB;
    if (!SIDE.test(s.name)) prevReachedBefore = rb;
    // Who works the stage now: a person only, a rule in code, the autopilot, or people through the Copilot.
    const workedBy = s.owner === "person" ? "person" : s.owner === "rule" ? "rule" : s.owner === "copilot" ? (s.autopilot === "autopilot" ? "autopilot" : "copilot") : "workflow";
    return {
      name: s.name,
      workedBy,
      reached: r,
      movedByBot: botMoves(s.name),
      // The same stage, card holder by card holder (the funnel by person).
      byPerson: Object.fromEntries(names.map((p) => [p, reachOf(cur, s.name, p)])),
      conv,
      convPrev,
      reachedPrev: rb,
      sent: sum(sends, "n", s.name),
      sentByAutopilot: sum(sends, "auto", s.name),
      sentPrev: sum(sendsPrev, "n", s.name),
      now: sum(nowIn, "n", s.name),
      stuck: sum(nowIn, "stuck", s.name),
    };
  });

  // Targets read the funnel itself (owner, 26.09: "take the data from the funnel, by stage, invent
  // nothing"): each target metric is the number of cards that reached its stage in the period, per
  // person and for the team — the very numbers of the stage table.
  const TARGET_STAGE: Record<FunnelKey, Record<string, RegExp>> = {
    rental: { leads: /^new lead$/i, shortlisted: /^options sent$/i, viewings_held: /^viewing done$/i, deals: /^contract signed$/i },
    "rental-listings": { leads: /^initial contact$/i, taken: /^taken to work$/i, qualified: /^qualified/i, prelisted: /^qualified/i, inspections_agreed: /^inspection sc/i, inspections_held: /^inspection sc/i, listed: /^live$/i },
    unicorn: { leads: /^new lead$/i, options: /^options sent$/i, viewings: /^viewing scheduled$/i, won: /^closed - won$/i },
  };
  for (const [metric, re] of Object.entries(TARGET_STAGE[f])) {
    const st = map.stages.find((x) => re.test(x.name.trim()));
    if (!st) continue;
    for (const p of score.people) {
      p.values[metric] = { v: reachOf(cur, st.name, p.name), prev: reachOf(bef, st.name, p.name) };
    }
    score.team.values[metric] = { v: reachOf(cur, st.name), prev: reachOf(bef, st.name) };
  }
  const targetStage = Object.fromEntries(Object.entries(TARGET_STAGE[f]).map(([m, re]) => [m, map.stages.find((x) => re.test(x.name.trim()))?.name ?? null]));

  // "Stuck" per person counts the funnel's main path only: side stages (co-broke, long term, closed)
  // and stage names amoCRM no longer has are not work waiting to move.
  const mainPath = new Set(map.stages.filter((s) => !SIDE.test(s.name)).map((s) => lc(s.name)));
  const stagesOut = stages.map((s) => (SIDE.test(s.name) ? { ...s, stuck: 0 } : s));

  // ── totals: who did the work
  const autoSent = sends.reduce((s, r) => s + n(r.auto), 0);
  const copilotSent = sends.reduce((s, r) => s + n(r.n) - n(r.auto), 0);
  const phoneTyped = typed.reduce((s, r) => s + n(r.n), 0);
  const allSent = autoSent + copilotSent + phoneTyped;
  const autoPrev = sendsPrev.reduce((t, r) => t + n(r.auto), 0);
  const copilotPrev = sendsPrev.reduce((t, r) => t + n(r.n) - n(r.auto), 0);
  const phonePrev = typedPrev.reduce((t, r) => t + n(r.n), 0);
  const allPrev = autoPrev + copilotPrev + phonePrev;
  const work = {
    prev: { autopilot: autoPrev, approvedInCopilot: copilotPrev, typedOnPhone: phonePrev, botShare: allPrev ? Math.round((autoPrev / allPrev) * 100) : null },
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
    prevNewCards: prevCards.length,
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
    const dp = row(draftsPrev, p)[0] ?? {};
    const decidedPrev = n(dp.as_written) + n(dp.edited) + n(dp.skipped);
    const repPrev = reportsPrev.filter((r) => lc(r.who) === lc(p));
    return {
      prev: {
        replyMin: sc?.values["reply_min"]?.prev ?? null,
        approveMin: row(approvePrev, p)[0]?.min == null ? null : n(row(approvePrev, p)[0].min),
        draftsDecided: decidedPrev,
        asWrittenPct: decidedPrev ? Math.round((n(dp.as_written) / decidedPrev) * 100) : null,
        autopilotSent: n(dp.auto),
        sentByPerson: sendsPrev.filter((r) => lc(r.who) === lc(p)).reduce((t, r) => t + n(r.n) - n(r.auto), 0) + n(row(typedPrev, p)[0]?.n),
        reportsFiled: repPrev.filter((r) => r.filedAt).length,
        reportsPlanned: repPrev.length,
      },
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
  const sumPrev = (k: string) => brokers.reduce((t, b) => t + (Number((b.prev as Record<string, unknown>)[k]) || 0), 0);
  const teamRow = {
    prev: {
      replyMin: score.team.values["reply_min"]?.prev ?? null,
      approveMin: null as number | null,
      draftsDecided: sumPrev("draftsDecided"),
      asWrittenPct: (() => {
        const all = draftsPrev.reduce((t, d) => t + n(d.as_written) + n(d.edited) + n(d.skipped), 0);
        return all ? Math.round((draftsPrev.reduce((t, d) => t + n(d.as_written), 0) / all) * 100) : null;
      })(),
      autopilotSent: sumPrev("autopilotSent"),
      sentByPerson: copilotPrev + phonePrev,
      reportsFiled: reportsPrev.filter((r) => r.filedAt).length,
      reportsPlanned: reportsPrev.length,
    },
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
  // Objections: reasons ranked by clients, each with every objection behind it (owner, 26.09: click in).
  const objNames = await cardNames(f, [...new Set(objections.map((o) => String(o.lead_id)))].slice(0, 400)).catch(() => new Map<string, string>());
  const objectionGroup = (source: string) => {
    const rows = objections.filter((o) => (source === "report" ? o.source === "viewing-report" : o.source !== "viewing-report"));
    const prevRows = objectionsPrev.filter((o) => (source === "report" ? o.source === "viewing-report" : o.source !== "viewing-report"));
    const allClients = new Set(rows.map((r) => String(r.lead_id))).size;
    const cats = new Map<string, Record<string, unknown>[]>();
    for (const r of rows) cats.set(String(r.category), [...(cats.get(String(r.category)) ?? []), r]);
    return [...cats.entries()]
      .map(([category, list]) => {
        const clients = new Set(list.map((r) => String(r.lead_id))).size;
        return {
          category,
          label: OBJECTION_CATEGORIES[category] ?? category,
          clients,
          prevClients: n(prevRows.find((x) => String(x.category) === category)?.clients),
          share: allClients ? Math.round((clients / allClients) * 100) : 0,
          quotes: list.map((r) => String(r.quote ?? "")).filter(Boolean).slice(0, 2),
          items: list.map((r) => ({ leadId: String(r.lead_id), name: objNames.get(String(r.lead_id)) ?? null, quote: String(r.quote ?? ""), at: r.said_at, who: r.who ?? null })),
        };
      })
      .sort((x, y) => y.clients - x.clients);
  };
  // Demand and supply by the owner's method (demand-matrix.ts): the listing search's target.
  let matrix: Awaited<ReturnType<typeof demandMatrix>> | null = null;
  if (f !== "unicorn") {
    try {
      matrix = await demandMatrix();
    } catch (err) {
      logger.warn({ err }, "os funnel report: demand matrix failed");
    }
  }
  const supply = (matrix?.cells ?? []) as unknown as Array<Record<string, unknown>>;

  // Reports against the calendar: every viewing (Rental) or inspection (Rental Listings) of the period,
  // with what the calendar shows, whether a report exists and whether it was filed on time.
  const calendar = f === "unicorn" ? [] : await reportCalendar(f, range, who);

  // Bottlenecks: signals on every side, each against the period before, green / amber / red. They say
  // where to look; the why stays the owner's weekly review with the AI (owner, 26.09).
  type Sig = { side: string; label: string; value: string; was: string | null; status: "ok" | "warn" | "bad"; note?: string };
  const sig: Sig[] = [];
  const pctChange = (a: number, b: number) => (b ? Math.round(((a - b) / b) * 100) : null);
  const volCh = pctChange(inflow.newCards, prevCards.length);
  sig.push({ side: "Inflow", label: "New cards", value: String(inflow.newCards), was: String(prevCards.length), status: volCh != null && volCh <= -40 ? "bad" : volCh != null && volCh <= -20 ? "warn" : "ok", note: volCh != null ? `${volCh > 0 ? "+" : ""}${volCh}%` : undefined });
  if (f === "rental") {
    // Of the new clients who named a budget, the share below the 30M floor.
    const share = (xs: Record<string, unknown>[]) => {
      const named = xs.filter((c) => Number(c.req_budget_idr_monthly) > 0);
      return named.length ? Math.round((named.filter((c) => Number(c.req_budget_idr_monthly) < 30_000_000).length / named.length) * 100) : null;
    };
    const bb = share(cards);
    const bbPrev = share(prevCards);
    if (bb != null) sig.push({ side: "Lead quality", label: "New clients with a budget below 30M", value: `${bb}%`, was: bbPrev == null ? null : `${bbPrev}%`, status: bb >= 45 ? "bad" : bb >= 30 ? "warn" : "ok", note: "of those who named one" });
  }
  const lostNow = stagesOut.find((x) => /closed.*lost/i.test(x.name));
  if (lostNow) {
    const sh = inflow.newCards ? Math.round((lostNow.reached / Math.max(1, stagesOut[0]?.reached || inflow.newCards)) * 100) : 0;
    sig.push({ side: "Lead quality", label: "Closed lost in the period", value: String(lostNow.reached), was: String(lostNow.reachedPrev), status: lostNow.reachedPrev && lostNow.reached > lostNow.reachedPrev * 1.3 ? "warn" : "ok", note: `${sh}% of the funnel's entries` });
  }
  const drops = stagesOut.filter((x) => x.conv != null && x.convPrev != null).map((x) => ({ x, d: (x.conv as number) - (x.convPrev as number) })).sort((a, b) => a.d - b.d);
  if (drops[0]) sig.push({ side: "Funnel", label: `Weakest step: into ${drops[0].x.name}`, value: `${drops[0].x.conv}%`, was: `${drops[0].x.convPrev}%`, status: drops[0].d <= -20 ? "bad" : drops[0].d <= -10 ? "warn" : "ok" });
  sig.push({ side: "Agent", label: "Clients waiting over 4 h now", value: String(teamRow.unanswered), was: null, status: teamRow.unanswered >= 10 ? "bad" : teamRow.unanswered > 0 ? "warn" : "ok" });
  sig.push({ side: "Agent", label: `${f === "rental-listings" ? "Inspection" : "Viewing"} reports not filed`, value: String(teamRow.reports.missing), was: null, status: teamRow.reports.missing > 0 ? "bad" : "ok" });
  sig.push({ side: "Agent", label: "Overdue tasks on live cards", value: String(teamRow.overdueTasks), was: null, status: teamRow.overdueTasks >= 50 ? "bad" : teamRow.overdueTasks >= 10 ? "warn" : "ok" });
  sig.push({ side: "Agent", label: "Cards stuck 7 days on the main path", value: String(teamRow.stuck), was: null, status: teamRow.stuck >= 60 ? "bad" : teamRow.stuck >= 20 ? "warn" : "ok" });
  if (teamRow.asWrittenPct != null) sig.push({ side: "Agent", label: "Drafts sent without an edit", value: `${teamRow.asWrittenPct}%`, was: teamRow.prev.asWrittenPct == null ? null : `${teamRow.prev.asWrittenPct}%`, status: teamRow.prev.asWrittenPct != null && teamRow.asWrittenPct < teamRow.prev.asWrittenPct - 10 ? "warn" : "ok", note: "the bot learning the team's way" });
  if (matrix) {
    const short = matrix.cells.filter((c) => c.demand > 2 && (c.coeff == null || c.coeff > 1));
    sig.push({ side: "Supply", label: "Cells short of villas (coefficient > 1, 3+ requests)", value: String(short.length), was: null, status: short.length >= 4 ? "bad" : short.length ? "warn" : "ok", note: short.slice(0, 3).map((c) => c.cell).join(", ") || undefined });
    sig.push({ side: "Supply", label: "Dead stock: listings no one asks for", value: `${matrix.deadStock.share}%`, was: null, status: matrix.deadStock.share >= 40 ? "bad" : matrix.deadStock.share >= 25 ? "warn" : "ok", note: `${matrix.deadStock.listings} of ${matrix.live}` });
  }
  if (f === "rental-listings") {
    const qn = stagesOut.find((x) => /qualified/i.test(x.name));
    if (qn) sig.push({ side: "Supply", label: "Qualified villas (Pre-listed)", value: String(qn.reached), was: String(qn.reachedPrev), status: qn.reachedPrev && qn.reached < qn.reachedPrev * 0.6 ? "bad" : qn.reachedPrev && qn.reached < qn.reachedPrev * 0.8 ? "warn" : "ok" });
  }
  const t = tech[0] ?? {};
  sig.push({ side: "System", label: "Sends that failed", value: String(n(t.failed)), was: String(n(t.failed_prev)), status: n(t.failed) >= 5 ? "bad" : n(t.failed) > 0 ? "warn" : "ok" });
  sig.push({ side: "System", label: "WhatsApp gateway errors, all lines (not counting numbers without WhatsApp)", value: String(n(t.wa_errors)), was: null, status: n(t.wa_errors) >= 5 ? "bad" : n(t.wa_errors) > 0 ? "warn" : "ok" });
  sig.push({ side: "System", label: "amoCRM sync, minutes since the last update", value: String(n(t.sync_lag_min)), was: null, status: n(t.sync_lag_min) > 60 ? "bad" : n(t.sync_lag_min) > 15 ? "warn" : "ok" });
  const cap = Number(t.ai_cap) > 0 ? Number(t.ai_cap) : 25;
  sig.push({ side: "System", label: "AI spend in the last 24 h", value: `$${n(t.ai_24h).toFixed(2)}`, was: null, status: n(t.ai_24h) >= cap * 0.8 ? "bad" : n(t.ai_24h) >= cap * 0.5 ? "warn" : "ok", note: `cap $${cap}` });

  const bottlenecks = {
    signals: sig,
    clientSide: f === "rental-listings" ? { beforeInspection: objectionGroup("message") } : { beforeViewing: objectionGroup("message"), afterViewing: objectionGroup("report") },
    ourSide: [...brokers.map((b) => ({ name: b.name, unanswered: b.unanswered, stuck: b.stuck, overdueTasks: b.overdueTasks, reportsMissing: b.reports.missing })), { name: "Team", unanswered: teamRow.unanswered, stuck: teamRow.stuck, overdueTasks: teamRow.overdueTasks, reportsMissing: teamRow.reports.missing }],
    stuckByStage: stagesOut.filter((s) => s.stuck > 0).sort((a, b) => b.stuck - a.stuck).slice(0, 4).map((s) => ({ stage: s.name, stuck: s.stuck, workedBy: s.workedBy })),
    inflow: { newCards: inflow.newCards, prevNewCards: inflow.prevNewCards, belowBudget, supply },
    matrix,
  };

  // ── today: the red flags, as of now, whatever the period
  const nameOf = await cardNames(f, [...new Set(reports.filter((x) => !x.filedAt && x.overdue).map((x) => String(x.leadId)))]).catch(() => new Map<string, string>());
  const flags: Array<{ level: "red" | "amber"; text: string; leadId?: string; who?: string }> = [];
  for (const r of reports.filter((x) => !x.filedAt && x.overdue)) flags.push({ level: "red", who: String(r.who ?? ""), leadId: String(r.leadId), text: `${r.who || "Nobody"} has not filed the ${f === "rental-listings" ? "inspection" : "viewing"} report for ${nameOf.get(String(r.leadId)) || "#" + r.leadId} (${r.kind === "inspection" ? "inspection" : "viewing"} ${new Date(String(r.at)).toISOString().slice(0, 16).replace("T", " ")} UTC)` });
  const unBy = new Map<string, number>();
  for (const u of unanswered) unBy.set(String(u.who ?? "nobody"), (unBy.get(String(u.who ?? "nobody")) ?? 0) + 1);
  for (const [p, k] of unBy) flags.push({ level: k >= 5 ? "red" : "amber", who: p, text: `${k} client${k === 1 ? "" : "s"} waiting over 4 hours for ${p}` });
  if (period !== "day" && !custom) {
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
    period: custom ? "custom" : period,
    from: range.from,
    to: range.to,
    who: who ?? "team",
    people,
    reportDueHours: REPORT_DUE_HOURS,
    flags,
    targets: { ...score, targetStage },
    work: { ...work, inflow, stages: stagesOut },
    brokers: [...brokers, teamRow],
    calendar,
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

/**
 * Every viewing or inspection of the period as the calendar, the report table and the funnel see it,
 * so a gap shows: on the calendar with no report form, a report not filed, filed late, or a report
 * with no calendar entry (owner, 26.09: "record every mismatch, e.g. a broker forgot the report").
 */
async function reportCalendar(f: FunnelKey, range: { from: string; to: string }, who: string | null) {
  const rows =
    f === "rental"
      ? await q(
          `WITH cal AS (SELECT lead_id::text AS lead_id, viewing_at AS at, summary FROM viewing_calendar_events WHERE viewing_at >= $1 AND viewing_at < $2),
                rep AS (SELECT lead_id::text AS lead_id, viewing_at AS at, status, outcome, filed_at, property_code FROM viewing_reports WHERE viewing_at >= $1 AND viewing_at < $2)
           SELECT coalesce(c.lead_id, r.lead_id) AS lead_id, coalesce(r.at, c.at) AS at, c.summary, (c.lead_id IS NOT NULL) AS on_calendar,
                  (r.lead_id IS NOT NULL) AS has_report, r.status, r.outcome, r.filed_at, r.property_code, l.responsible_user AS who
             FROM cal c FULL JOIN rep r ON r.lead_id = c.lead_id AND abs(extract(epoch FROM r.at - c.at)) < 3600
             LEFT JOIN leads_sync l ON l.lead_id = coalesce(c.lead_id, r.lead_id)
            WHERE ($3::text IS NULL OR lower(l.responsible_user) = $3) ORDER BY 2`,
          [at(range.from), at(range.to), who],
        )
      : await q(
          `WITH slot AS (SELECT lead_id::text AS lead_id, visit_at AS at, status FROM listing_inspection_slots WHERE superseded_at IS NULL AND visit_at >= $1 AND visit_at < $2),
                cal AS (SELECT trim(unnest(string_to_array(lead_ids, ','))) AS lead_id, visit_at AS at, summary FROM inspection_calendar_events WHERE visit_at >= $1 AND visit_at < $2)
           SELECT s.lead_id, s.at, s.status AS slot_status, c.summary, (c.lead_id IS NOT NULL) AS on_calendar,
                  ir.id IS NOT NULL AS has_report, ir.status, NULL AS outcome, coalesce(ir.filed_at, ir.done_at) AS filed_at, ir.property_code, l.responsible_user AS who
             FROM slot s LEFT JOIN cal c ON c.lead_id = s.lead_id AND abs(extract(epoch FROM c.at - s.at)) < 3600
             LEFT JOIN LATERAL (SELECT * FROM inspection_reports x WHERE x.lead_id::text = s.lead_id ORDER BY coalesce(x.filed_at, x.done_at, x.created_at) DESC LIMIT 1) ir ON true
             LEFT JOIN leads_sync l ON l.lead_id = s.lead_id
            WHERE coalesce(s.status,'') NOT IN ('cancelled') AND ($3::text IS NULL OR lower(l.responsible_user) = $3) ORDER BY 2`,
          [at(range.from), at(range.to), who],
        );
  const names = await cardNames(f, [...new Set(rows.map((r) => String(r.lead_id)))]).catch(() => new Map<string, string>());
  const now = Date.now();
  return rows.map((r) => {
    const start = Date.parse(String(r.at));
    const filed = r.filed_at ? Date.parse(String(r.filed_at)) : null;
    const past = start < now;
    const due = start + REPORT_DUE_HOURS * 3600_000;
    let state: string;
    if (!past) state = "upcoming";
    else if (!r.has_report) state = "no report form";
    else if (r.status === "cancelled") state = "cancelled";
    else if (filed == null) state = now > due ? "not filed" : "due soon";
    else state = filed > due ? "filed late" : "filed";
    return {
      leadId: String(r.lead_id),
      name: names.get(String(r.lead_id)) ?? null,
      who: r.who ?? null,
      at: r.at,
      villa: r.property_code ?? null,
      onCalendar: !!r.on_calendar,
      outcome: r.outcome ?? null,
      state,
      mismatch: past && (!r.on_calendar || state === "no report form" || state === "not filed" || state === "filed late"),
    };
  });
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
