/**
 * Unicorn OS — the owner's management analytics: where we are stuck and why.
 *
 * Built from what the owner asked for by hand during 25.08–25.09.2026
 * (analytics spec, scratchpad): target vs fact per broker, the two Rental gates
 * (options → viewing, viewing → deal), Yudi's gate (QUALIFIED → inspection →
 * Listed → live), stage pile-ups, supply gaps by segment, drafts decided,
 * AI cost — and above all client OBJECTIONS.
 *
 * Objections were never recorded anywhere: pending_suggestions.objection_category
 * is the SALES playbook and is mostly a default. A Haiku pass here reads what
 * Rental clients wrote after they got options, and every filed viewing report,
 * and files each objection with its category and the client's own words. It
 * runs every two hours in daytime, so the log grows by itself.
 *
 * Rules the owner set for every number: weeks are Mon–Sun Bali; the bot and
 * the broker are separate rows; denominators are honest; viewings and
 * inspections come from slots and reports, never from stages.
 */
import { pool } from "@workspace/db";
import { chatCompletionJSON, chatCompletion, HELPER_MODEL, WRITER_MODEL } from "../ai-client";
import { weekToDate, baliDate } from "../kpi-dashboard";
import { listListings } from "./listings";
import { logger } from "../logger";

export const OBJECTION_CATEGORIES: Record<string, string> = {
  more_options: "Wants more / different options",
  new_criterion: "New requirement (garden, pets, pool, workspace, enclosed living…)",
  price: "Price / over budget",
  area: "Area / location / distance",
  dates: "Availability / move-in dates",
  terms: "Minimum stay / payment / deposit",
  style: "Style / looks / photos",
  noise: "Construction / noise / busy street",
  villa_not_as_expected: "Villa not as expected (after viewing)",
  needs_time: "Needs time / partner decides / later",
  found_elsewhere: "Found elsewhere / another agent",
  trust: "Agency, fee or trust",
  other: "Other",
};

export const CLOSE_REASONS: Record<string, string> = {
  found_elsewhere: "Found elsewhere / another agent",
  budget: "Budget too low",
  no_stock: "No matching villa",
  area: "Area we do not cover",
  not_responding: "Stopped responding",
  dates: "Dates do not fit",
  duplicate: "Duplicate card",
  not_real: "Not a real request / spam",
  owner_cancelled: "Villa side cancelled",
  other: "Other",
};

// Weekly targets as data, each with the date it took effect, so an old week
// keeps the target of its time. Seeded from the owner's words; admins edit them.
const TARGET_SEED: Array<{ key: string; value: number; floor: number | null; from: string; note: string }> = [
  { key: "amelia.viewings", value: 2, floor: null, from: "2026-09-01", note: "04.09: two viewings a week" },
  { key: "amelia.viewings", value: 4, floor: 2, from: "2026-09-21", note: "21.09: 4 viewings a week, 2–4 acceptable" },
  { key: "amelia.deals", value: 1, floor: null, from: "2026-09-01", note: "21.09: one signed contract a week" },
  { key: "yudi.prelisted", value: 10, floor: null, from: "2026-09-14", note: "14.09: at least 10 Pre-listed a week" },
  { key: "yudi.listed", value: 10, floor: null, from: "2026-09-14", note: "14.09: 10 Pre-listed → Listed a week" },
  { key: "yudi.inspections", value: 10, floor: 8, from: "2026-09-21", note: "21.09: 8–10 villa inspections a week" },
];

let tablesReady: Promise<void> | null = null;
export function ensureAnalyticsTables(): Promise<void> {
  if (!tablesReady) {
    tablesReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS os_objections (
          id          bigserial PRIMARY KEY,
          lead_id     text NOT NULL,
          pipeline    text,
          broker      text,
          source      text NOT NULL,
          source_ref  text NOT NULL,
          category    text NOT NULL,
          quote       text,
          property_code text,
          said_at     timestamptz NOT NULL,
          created_at  timestamptz NOT NULL DEFAULT now(),
          UNIQUE (source, source_ref, category)
        );
        CREATE INDEX IF NOT EXISTS os_objections_said_at ON os_objections (said_at DESC);
        CREATE TABLE IF NOT EXISTS os_objection_scan (
          source      text NOT NULL,
          source_ref  text NOT NULL,
          scanned_at  timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (source, source_ref)
        );
        CREATE TABLE IF NOT EXISTS os_briefs (
          week_start    date PRIMARY KEY,
          generated_at  timestamptz NOT NULL DEFAULT now(),
          generated_by  text,
          content       text NOT NULL,
          data          jsonb
        );
        CREATE TABLE IF NOT EXISTS os_targets (
          id          serial PRIMARY KEY,
          key         text NOT NULL,
          value       numeric NOT NULL,
          floor       numeric,
          effective_from date NOT NULL,
          note        text,
          created_by  text,
          created_at  timestamptz NOT NULL DEFAULT now(),
          UNIQUE (key, effective_from)
        );
        CREATE TABLE IF NOT EXISTS os_close_reasons (
          id          bigserial PRIMARY KEY,
          lead_id     text NOT NULL,
          pipeline    text,
          reason      text NOT NULL,
          detail      text,
          closed_by   text,
          closed_at   timestamptz NOT NULL DEFAULT now()
        );
      `);
      for (const t of TARGET_SEED) {
        await pool.query(
          `INSERT INTO os_targets (key, value, floor, effective_from, note, created_by) VALUES ($1,$2,$3,$4,$5,'owner (chat)') ON CONFLICT (key, effective_from) DO NOTHING`,
          [t.key, t.value, t.floor, t.from, t.note],
        );
      }
    })().catch((err) => {
      tablesReady = null;
      logger.error({ err }, "os: analytics tables failed");
      throw err;
    });
  }
  return tablesReady;
}

export async function targetsAt(day: string): Promise<Record<string, { value: number; floor: number | null; from: string; note: string | null }>> {
  await ensureAnalyticsTables();
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (key) key, value, floor, effective_from, note FROM os_targets WHERE effective_from <= $1 ORDER BY key, effective_from DESC`,
    [day],
  );
  const out: Record<string, { value: number; floor: number | null; from: string; note: string | null }> = {};
  for (const r of rows) out[r.key] = { value: Number(r.value), floor: r.floor == null ? null : Number(r.floor), from: new Date(r.effective_from).toISOString().slice(0, 10), note: r.note ?? null };
  return out;
}

export async function listTargets() {
  await ensureAnalyticsTables();
  const { rows } = await pool.query(`SELECT key, value, floor, effective_from, note, created_by FROM os_targets ORDER BY key, effective_from DESC`);
  return rows.map((r) => ({ key: r.key, value: Number(r.value), floor: r.floor == null ? null : Number(r.floor), from: new Date(r.effective_from).toISOString().slice(0, 10), note: r.note, by: r.created_by }));
}

export async function setTarget(by: string, input: { key: string; value: number; floor?: number | null; from: string; note?: string }) {
  if (!/^(amelia|yudi|[a-z]+)\.[a-z_]+$/.test(input.key)) throw new Error("Unknown target.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.from)) throw new Error("Pick the date it starts.");
  await ensureAnalyticsTables();
  await pool.query(
    `INSERT INTO os_targets (key, value, floor, effective_from, note, created_by) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (key, effective_from) DO UPDATE SET value = EXCLUDED.value, floor = EXCLUDED.floor, note = EXCLUDED.note, created_by = EXCLUDED.created_by`,
    [input.key, input.value, input.floor ?? null, input.from, input.note ?? null, by],
  );
}

export async function recordCloseReason(by: string, leadId: string, pipeline: string | null, reason: string, detail: string | null) {
  await ensureAnalyticsTables();
  await pool.query(`INSERT INTO os_close_reasons (lead_id, pipeline, reason, detail, closed_by) VALUES ($1,$2,$3,$4,$5)`, [
    leadId, pipeline, reason in CLOSE_REASONS ? reason : "other", detail, by,
  ]);
}

// ── Objection scan ───────────────────────────────────────────────────────────

type Classified = { items?: Array<{ n?: number; objection?: boolean; categories?: string[]; quote?: string }> };

const CLASSIFY_SYSTEM = `You read what a rental client in Bali wrote to our agency (they rent villas long-term, we send them villa options on WhatsApp) and find OBJECTIONS: anything the client says against an offered villa or against moving forward. Examples: asking for more or different options ("anything else?", "not quite my style", "I've seen these", "keep sending"); a new requirement (garden, pets, pool, place to work, enclosed living room, parking); too expensive; wrong area or too far; dates do not fit; minimum stay or payment terms; style, looks or photos; construction or noise; the villa was not as expected at the viewing; needs time or a partner decides; found a place elsewhere; doubts about the agency or fees.
A question about a villa, a greeting, a thank-you, "yes", or a neutral fact is NOT an objection.
Categories (use the keys): ${Object.entries(OBJECTION_CATEGORIES).map(([k, v]) => `${k} = ${v}`).join("; ")}.
Return JSON {"items":[{"n": <line number>, "objection": true|false, "categories": [keys], "quote": "the client's exact words that carry the objection, max 160 chars, original language"}]}. Only objection lines need categories and a quote.`;

async function classify(context: string, lines: Array<{ n: number; text: string }>): Promise<Map<number, { categories: string[]; quote: string }>> {
  const out = new Map<number, { categories: string[]; quote: string }>();
  if (!lines.length) return out;
  const res = await chatCompletionJSON<Classified>({
    model: HELPER_MODEL,
    label: "os-objections",
    max_tokens: 1200,
    system: CLASSIFY_SYSTEM,
    messages: [{ role: "user", content: `${context}\n\nCLIENT LINES:\n${lines.map((l) => `${l.n}. ${l.text.slice(0, 600)}`).join("\n")}` }],
  });
  for (const it of res.items ?? []) {
    if (!it || !it.objection || typeof it.n !== "number") continue;
    const cats = (it.categories ?? []).filter((c) => c in OBJECTION_CATEGORIES);
    if (!cats.length) cats.push("other");
    out.set(it.n, { categories: [...new Set(cats)], quote: String(it.quote ?? "").slice(0, 300) });
  }
  return out;
}

/** A WhatsApp reply to a quote is stored as ">> quote⏎reply" — the reply is what the client said. */
function ownWords(text: string): string {
  const lines = String(text ?? "").split("\n");
  const kept = lines.filter((l) => !l.startsWith(">>"));
  return (kept.join("\n").trim() || String(text ?? "")).slice(0, 800);
}

let scanning = false;
export async function scanObjections(opts: { days?: number; maxLeads?: number } = {}): Promise<{ messages: number; reports: number; found: number }> {
  if (scanning) return { messages: 0, reports: 0, found: 0 };
  scanning = true;
  try {
    await ensureAnalyticsTables();
    const days = String(opts.days ?? 30);
    let found = 0;
    const msgs = await pool.query(
      `WITH first_link AS (
         SELECT lead_id, min(sent_at) AS at FROM lead_messages
          WHERE sender_type <> 'lead' AND text ILIKE '%/property/%'
          GROUP BY lead_id
       )
       SELECT m.lead_id, m.amo_message_id, m.text, m.sent_at, l.pipeline, l.responsible_user
         FROM lead_messages m
         JOIN first_link f ON f.lead_id = m.lead_id AND m.sent_at > f.at
         JOIN leads_sync l ON l.lead_id = m.lead_id
         LEFT JOIN os_objection_scan s ON s.source = 'message' AND s.source_ref = m.amo_message_id
        WHERE m.sender_type = 'lead' AND m.sent_at > now() - ($1 || ' days')::interval
          AND lower(coalesce(l.pipeline,'')) = 'rental' AND s.source_ref IS NULL
          AND length(coalesce(m.text,'')) > 2
        ORDER BY m.lead_id, m.sent_at
        LIMIT 2000`,
      [days],
    );
    const byLead = new Map<string, typeof msgs.rows>();
    for (const r of msgs.rows) byLead.set(String(r.lead_id), [...(byLead.get(String(r.lead_id)) ?? []), r]);
    let leadsDone = 0;
    for (const [leadId, rows] of byLead) {
      if (leadsDone >= (opts.maxLeads ?? 150)) break;
      leadsDone++;
      const lastOurs = await pool
        .query(`SELECT text FROM lead_messages WHERE lead_id = $1 AND sender_type <> 'lead' AND sent_at < $2 ORDER BY sent_at DESC LIMIT 1`, [leadId, rows[0].sent_at])
        .catch(() => ({ rows: [] as Array<{ text: string }> }));
      const lines = rows.map((r, i) => ({ n: i + 1, text: ownWords(r.text) }));
      try {
        const hits = await classify(`OUR LAST MESSAGE BEFORE THESE: ${String(lastOurs.rows[0]?.text ?? "(none)").slice(0, 700)}`, lines);
        for (const [n, hit] of hits) {
          const r = rows[n - 1];
          if (!r) continue;
          for (const cat of hit.categories) {
            const ins = await pool.query(
              `INSERT INTO os_objections (lead_id, pipeline, broker, source, source_ref, category, quote, said_at)
               VALUES ($1,$2,$3,'message',$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
              [leadId, r.pipeline, r.responsible_user, r.amo_message_id, cat, hit.quote || ownWords(r.text).slice(0, 200), r.sent_at],
            );
            found += ins.rowCount ?? 0;
          }
        }
        for (const r of rows) await pool.query(`INSERT INTO os_objection_scan (source, source_ref) VALUES ('message', $1) ON CONFLICT DO NOTHING`, [r.amo_message_id]);
      } catch (err) {
        logger.warn({ err, leadId }, "os: objection scan failed for a lead — retried next pass");
      }
    }

    const reps = await pool.query(
      `SELECT r.id, r.lead_id, r.property_code, r.outcome, r.feedback, coalesce(r.filed_at, r.viewing_at) AS at, l.pipeline, l.responsible_user
         FROM viewing_reports r LEFT JOIN leads_sync l ON l.lead_id = r.lead_id
         LEFT JOIN os_objection_scan s ON s.source = 'viewing-report' AND s.source_ref = r.id::text
        WHERE r.status <> 'due' AND coalesce(r.filed_at, r.viewing_at) > now() - ($1 || ' days')::interval AND s.source_ref IS NULL
        ORDER BY at LIMIT 200`,
      [days],
    );
    for (const r of reps.rows) {
      try {
        const fb = String(r.feedback ?? "").trim();
        if (fb) {
          const hits = await classify(`This is the BROKER's note after a viewing (outcome: ${r.outcome ?? "unknown"}), describing the client's reaction.`, [{ n: 1, text: fb }]);
          const hit = hits.get(1);
          for (const cat of hit?.categories ?? []) {
            const ins = await pool.query(
              `INSERT INTO os_objections (lead_id, pipeline, broker, source, source_ref, category, quote, property_code, said_at)
               VALUES ($1,$2,$3,'viewing-report',$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
              [r.lead_id, r.pipeline, r.responsible_user, String(r.id), cat, hit?.quote || fb.slice(0, 200), r.property_code, r.at],
            );
            found += ins.rowCount ?? 0;
          }
        }
        await pool.query(`INSERT INTO os_objection_scan (source, source_ref) VALUES ('viewing-report', $1) ON CONFLICT DO NOTHING`, [String(r.id)]);
      } catch (err) {
        logger.warn({ err, report: r.id }, "os: viewing report objection scan failed");
      }
    }
    logger.info({ messages: msgs.rows.length, leads: leadsDone, reports: reps.rows.length, found }, "os: objection scan pass");
    return { messages: msgs.rows.length, reports: reps.rows.length, found };
  } finally {
    scanning = false;
  }
}

export async function objectionsSummary(opts: { days: number; broker?: string | null }) {
  await ensureAnalyticsTables();
  const p = [String(opts.days), opts.broker ?? null];
  const w = (a: string) =>
    `${a}said_at > now() - ($1 || ' days')::interval AND ($2::text IS NULL OR lower(coalesce(${a}broker,'')) = lower($2))`;
  const [byCat, byWeek, recent, reports, lost, reasons, scan] = await Promise.all([
    pool.query(`SELECT category, count(*)::int AS n, count(DISTINCT lead_id)::int AS leads FROM os_objections WHERE ${w("")} GROUP BY category ORDER BY n DESC`, p),
    pool.query(
      `SELECT to_char(date_trunc('week', said_at AT TIME ZONE 'Asia/Makassar'), 'YYYY-MM-DD') AS week, category, count(*)::int AS n
         FROM os_objections WHERE ${w("")} GROUP BY 1, 2 ORDER BY 1`, p),
    pool.query(
      `SELECT o.lead_id, o.source, o.category, o.quote, o.property_code, o.said_at, o.broker, l.lead_stage, l.req_bedrooms, l.req_areas, l.req_budget_idr_monthly,
              (SELECT sender_name FROM lead_messages m WHERE m.lead_id = o.lead_id AND m.sender_type = 'lead' AND coalesce(m.sender_name,'') <> '' ORDER BY sent_at LIMIT 1) AS client_name
         FROM os_objections o LEFT JOIN leads_sync l ON l.lead_id = o.lead_id WHERE ${w("o.")}
        ORDER BY o.said_at DESC LIMIT 150`, p),
    pool.query(
      `SELECT r.id AS report_id, r.lead_id, r.property_code, r.viewing_at, r.outcome, r.feedback, r.next_steps, r.next_by, r.filed_by, r.filed_at, l.responsible_user, l.lead_stage,
              (SELECT sender_name FROM lead_messages m WHERE m.lead_id = r.lead_id AND m.sender_type = 'lead' AND coalesce(m.sender_name,'') <> '' ORDER BY sent_at LIMIT 1) AS client_name
         FROM viewing_reports r LEFT JOIN leads_sync l ON l.lead_id = r.lead_id
        WHERE r.status <> 'due' AND r.viewing_at > now() - ($1 || ' days')::interval AND ($2::text IS NULL OR lower(coalesce(l.responsible_user,'')) = lower($2))
        ORDER BY r.viewing_at DESC LIMIT 80`, p),
    pool.query(
      `SELECT e.lead_id, e.from_stage, e.changed_at, l.discard_reason, l.responsible_user
         FROM stage_events e LEFT JOIN leads_sync l ON l.lead_id = e.lead_id
        WHERE e.to_stage ILIKE '%lost%' AND e.changed_at > now() - ($1 || ' days')::interval AND lower(coalesce(e.pipeline,'')) = 'rental'
          AND ($2::text IS NULL OR lower(coalesce(l.responsible_user,'')) = lower($2))
        ORDER BY e.changed_at DESC LIMIT 80`, p),
    pool.query(
      `SELECT reason, count(*)::int AS n FROM os_close_reasons WHERE closed_at > now() - ($1 || ' days')::interval GROUP BY reason ORDER BY n DESC`, [String(opts.days)]),
    pool.query(`SELECT max(scanned_at) AS at, count(*)::int AS n FROM os_objection_scan`),
  ]);
  // The ranking of pains: each kind with how many clients, the change against
  // the period before, the clients who say it most, and a few quotes.
  const [all, prev] = await Promise.all([
    pool.query(
      `SELECT o.category, o.lead_id, o.quote, o.said_at, l.req_bedrooms, l.req_areas, l.req_budget_idr_monthly
         FROM os_objections o LEFT JOIN leads_sync l ON l.lead_id = o.lead_id WHERE ${w("o.")} ORDER BY o.said_at DESC LIMIT 3000`,
      p,
    ),
    pool.query(
      `SELECT category, count(DISTINCT lead_id)::int AS leads FROM os_objections
        WHERE said_at <= now() - ($1 || ' days')::interval AND said_at > now() - (($1::int * 2) || ' days')::interval
          AND ($2::text IS NULL OR lower(coalesce(broker,'')) = lower($2)) GROUP BY category`,
      p,
    ),
  ]);
  const band = (b: number | null) => (b == null ? null : b <= 30e6 ? "≤30M" : b <= 50e6 ? "30–50M" : b <= 70e6 ? "50–70M" : b <= 100e6 ? "70–100M" : "100M+");
  const prevBy = new Map(prev.rows.map((x) => [String(x.category), Number(x.leads)]));
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const x of all.rows) groups.set(String(x.category), [...(groups.get(String(x.category)) ?? []), x]);
  const clientsTotal = new Set(all.rows.map((x) => String(x.lead_id))).size;
  const pains = [...groups.entries()]
    .map(([category, list]) => {
      const leads = new Map<string, Record<string, unknown>>();
      for (const x of list) if (!leads.has(String(x.lead_id))) leads.set(String(x.lead_id), x);
      const seg = new Map<string, number>();
      for (const x of leads.values()) {
        const area = String(x.req_areas ?? "").split(/[,/;]| or /i)[0].trim();
        const parts = [x.req_bedrooms ? `${x.req_bedrooms}BR` : null, area || null, band(x.req_budget_idr_monthly == null ? null : Number(x.req_budget_idr_monthly))].filter(Boolean);
        if (parts.length >= 2) seg.set(parts.join(" · "), (seg.get(parts.join(" · ")) ?? 0) + 1);
      }
      const topSeg = [...seg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, n]) => ({ segment: k, clients: n }));
      const seen = new Set<string>();
      const quotes: Array<{ quote: string; leadId: string; at: unknown }> = [];
      for (const x of list) {
        const q = String(x.quote ?? "").trim();
        if (q.length < 6 || seen.has(q.toLowerCase())) continue;
        seen.add(q.toLowerCase());
        quotes.push({ quote: q, leadId: String(x.lead_id), at: x.said_at });
        if (quotes.length >= 3) break;
      }
      return { category, label: OBJECTION_CATEGORIES[category] ?? category, mentions: list.length, clients: leads.size, prevClients: prevBy.get(category) ?? 0, share: clientsTotal ? Math.round((leads.size / clientsTotal) * 100) : 0, segments: topSeg, quotes };
    })
    .sort((a, b) => b.clients - a.clients);
  return {
    categories: OBJECTION_CATEGORIES,
    closeReasons: CLOSE_REASONS,
    byCategory: byCat.rows,
    byWeek: byWeek.rows,
    recent: recent.rows,
    viewingReports: reports.rows,
    lost: lost.rows,
    lostReasons: reasons.rows,
    lastScanAt: scan.rows[0]?.at ?? null,
    scanned: scan.rows[0]?.n ?? 0,
    pains,
    clientsTotal,
  };
}

// ── Funnel and stage waits ──────────────────────────────────────────────────

export async function funnelWeeks(opts: { pipeline: string; weeks: number; broker?: string | null }) {
  const { rows } = await pool.query(
    `SELECT to_char(date_trunc('week', changed_at AT TIME ZONE 'Asia/Makassar'), 'YYYY-MM-DD') AS week, to_stage, count(DISTINCT lead_id)::int AS n
       FROM stage_events
      WHERE lower(coalesce(pipeline,'')) = lower($1) AND changed_at > now() - ($2 || ' weeks')::interval
        AND ($3::text IS NULL OR lower(coalesce(responsible_user,'')) = lower($3))
      GROUP BY 1, 2 ORDER BY 1`,
    [opts.pipeline, String(opts.weeks), opts.broker ?? null],
  );
  const created = await pool.query(
    `SELECT to_char(date_trunc('week', amo_created_at AT TIME ZONE 'Asia/Makassar'), 'YYYY-MM-DD') AS week, count(*)::int AS n
       FROM leads_sync WHERE lower(coalesce(pipeline,'')) = lower($1) AND amo_created_at > now() - ($2 || ' weeks')::interval
        AND ($3::text IS NULL OR lower(coalesce(responsible_user,'')) = lower($3))
      GROUP BY 1 ORDER BY 1`,
    [opts.pipeline, String(opts.weeks), opts.broker ?? null],
  );
  return { arrivals: rows, created: created.rows };
}

export type StageWait = { stage: string; count: number; over3: number; over7: number; over14: number; medianDays: number; cards: Array<{ leadId: string; days: number; lastFrom: string | null; temperature: string | null }> };

export async function stageWaits(opts: { pipeline: string; broker?: string | null }): Promise<StageWait[]> {
  const { rows } = await pool.query(
    `SELECT l.lead_id, l.lead_stage, l.responsible_user, l.last_message_at, l.last_message_from, l.profile_temperature,
            coalesce(e.changed_at, l.amo_created_at) AS since
       FROM leads_sync l
       LEFT JOIN (SELECT DISTINCT ON (lead_id) lead_id, changed_at FROM stage_events ORDER BY lead_id, changed_at DESC) e ON e.lead_id = l.lead_id
      WHERE lower(coalesce(l.pipeline,'')) = lower($1) AND coalesce(l.lead_stage,'') NOT ILIKE '%closed%'
        AND ($2::text IS NULL OR lower(coalesce(l.responsible_user,'')) = lower($2))`,
    [opts.pipeline, opts.broker ?? null],
  );
  const now = Date.now();
  const byStage = new Map<string, StageWait>();
  for (const r of rows) {
    const stage = String(r.lead_stage ?? "—");
    const days = r.since ? Math.max(0, (now - new Date(r.since).getTime()) / 86400_000) : 0;
    const s = byStage.get(stage) ?? { stage, count: 0, over3: 0, over7: 0, over14: 0, medianDays: 0, cards: [] };
    s.count++;
    if (days > 3) s.over3++;
    if (days > 7) s.over7++;
    if (days > 14) s.over14++;
    s.cards.push({ leadId: String(r.lead_id), days: Math.round(days * 10) / 10, lastFrom: r.last_message_from ?? null, temperature: r.profile_temperature ?? null });
    byStage.set(stage, s);
  }
  for (const s of byStage.values()) {
    const d = s.cards.map((c) => c.days).sort((a, b) => a - b);
    s.medianDays = d.length ? d[Math.floor(d.length / 2)] : 0;
    s.cards.sort((a, b) => b.days - a.days);
    s.cards = s.cards.slice(0, 20);
  }
  return [...byStage.values()];
}

// ── Weeks ────────────────────────────────────────────────────────────────────

export function mondayOf(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** Bali midnight of a day as an instant. */
const baliStart = (day: string) => new Date(`${day}T00:00:00+08:00`);

// ── Gate: Options → Viewing (Amelia) ────────────────────────────────────────

const VIEW_WORDS = "(viewing|to view|view (it|them|the|some)|visit|come and see|show you|see (it|the villa|them) in person|lihat villa|survey)";

export async function gateOptionsToViewing(ws: string, broker: string | null = null) {
  const from = baliStart(ws);
  const to = baliStart(addDays(ws, 7));
  const { rows } = await pool.query(
    `WITH first_link AS (
       SELECT lead_id, min(sent_at) AS at FROM lead_messages WHERE sender_type <> 'lead' AND text ILIKE '%/property/%' GROUP BY lead_id
     )
     SELECT f.lead_id, f.at AS shortlist_at, l.lead_stage, l.responsible_user, l.req_bedrooms, l.req_areas, l.req_budget_idr_monthly,
            (SELECT min(sent_at) FROM lead_messages m WHERE m.lead_id = f.lead_id AND m.sender_type = 'lead' AND m.sent_at > f.at) AS reacted_at,
            (SELECT min(sent_at) FROM lead_messages m WHERE m.lead_id = f.lead_id AND m.sender_type <> 'lead' AND m.sent_at > f.at AND m.text ~* $3) AS offered_at,
            (SELECT sender_type FROM lead_messages m WHERE m.lead_id = f.lead_id AND m.sender_type <> 'lead' AND m.sent_at > f.at AND m.text ~* $3 ORDER BY sent_at LIMIT 1) AS offered_by,
            (SELECT min(sent_at) FROM lead_messages m WHERE m.lead_id = f.lead_id AND m.sender_type = 'lead' AND m.sent_at > f.at AND m.text ~* $3) AS asked_at,
            (SELECT min(coalesce(agreed_at, created_at)) FROM viewing_slots s WHERE s.lead_id = f.lead_id AND s.status <> 'cancelled') AS slot_at,
            (SELECT min(s.viewing_at) FROM viewing_slots s WHERE s.lead_id = f.lead_id AND s.viewing_at < now() AND s.status NOT IN ('cancelled','rescheduled')
                AND NOT EXISTS (SELECT 1 FROM viewing_reports r WHERE r.lead_id = s.lead_id AND r.viewing_at = s.viewing_at AND r.outcome IN ('cancelled','no_show','rescheduled'))) AS held_at,
            (SELECT content FROM (SELECT left(text, 200) AS content, sent_at FROM lead_messages m WHERE m.lead_id = f.lead_id AND m.sender_type = 'lead' ORDER BY sent_at DESC LIMIT 1) x) AS last_client_text,
            (SELECT max(sent_at) FROM lead_messages m WHERE m.lead_id = f.lead_id AND m.sender_type = 'lead') AS last_client_at,
            (SELECT sender_name FROM lead_messages m WHERE m.lead_id = f.lead_id AND m.sender_type = 'lead' AND coalesce(m.sender_name,'') <> '' ORDER BY sent_at LIMIT 1) AS client_name
       FROM first_link f JOIN leads_sync l ON l.lead_id = f.lead_id
      WHERE lower(coalesce(l.pipeline,'')) = 'rental' AND f.at >= $1 AND f.at < $2
        AND l.lead_id NOT IN ('23509507','23499347')
        AND ($4::text IS NULL OR lower(coalesce(l.responsible_user,'')) = lower($4))`,
    [from, to, VIEW_WORDS, broker],
  );
  const n = (k: string) => rows.filter((r) => r[k]).length;
  const steps = [
    { key: "shortlisted", label: "Got a shortlist", n: rows.length },
    { key: "reacted", label: "Reacted", n: n("reacted_at") },
    { key: "offered", label: "Viewing offered by us", n: n("offered_at"), note: "read from our messages (viewing / visit words)" },
    { key: "asked", label: "Client asked to view", n: n("asked_at") },
    { key: "slot", label: "Slot confirmed", n: n("slot_at") },
    { key: "held", label: "Viewing held", n: n("held_at") },
  ];
  const stuck = rows
    .filter((r) => !r.held_at)
    .map((r) => ({
      leadId: String(r.lead_id),
      name: r.client_name ?? null,
      stage: r.lead_stage,
      step: !r.reacted_at ? "silent after options" : !r.offered_at && !r.asked_at ? "reacted, no viewing offered" : !r.slot_at ? "viewing talked about, no slot" : "slot, not held yet",
      lastClientText: r.last_client_text,
      lastClientAt: r.last_client_at,
      offeredBy: r.offered_by,
      request: { bedrooms: r.req_bedrooms, areas: r.req_areas, budget: r.req_budget_idr_monthly },
    }));
  return { weekStart: ws, steps, stuck };
}

// ── Gate: Viewing → Deal (Amelia) ───────────────────────────────────────────

export async function gateViewingToDeal(ws: string, broker: string | null = null) {
  const { rows } = await pool.query(
    `SELECT s.lead_id, s.viewing_at, s.property_code, r.id AS report_id, r.filed_by, r.status AS report_status, r.outcome, r.feedback, r.next_steps, r.next_by, r.filed_at,
            l.lead_stage, l.responsible_user,
            (SELECT sender_name FROM lead_messages m WHERE m.lead_id = s.lead_id AND m.sender_type = 'lead' AND coalesce(m.sender_name,'') <> '' ORDER BY sent_at LIMIT 1) AS client_name
       FROM viewing_slots s
       LEFT JOIN viewing_reports r ON r.lead_id = s.lead_id AND r.viewing_at = s.viewing_at
       LEFT JOIN leads_sync l ON l.lead_id = s.lead_id
      WHERE s.viewing_at >= $1 AND s.viewing_at < $2 AND s.viewing_at < now() AND s.status NOT IN ('cancelled','rescheduled')
        AND ($3::text IS NULL OR lower(coalesce(l.responsible_user,'')) = lower($3))
      ORDER BY s.viewing_at`,
    [baliStart(ws), baliStart(addDays(ws, 7)), broker],
  );
  const outcomes: Record<string, number> = {};
  for (const r of rows) outcomes[String(r.outcome ?? (r.report_status === "due" ? "report missing" : "no report"))] = (outcomes[String(r.outcome ?? (r.report_status === "due" ? "report missing" : "no report"))] ?? 0) + 1;
  const deals = await pool.query(
    `SELECT count(DISTINCT lead_id)::int AS n FROM stage_events WHERE lower(coalesce(pipeline,'')) = 'rental' AND (to_stage ILIKE '%contract signed%' OR to_stage ILIKE '%closed%won%' OR to_stage ILIKE 'успешно%')
      AND changed_at >= $1 AND changed_at < $2 AND ($3::text IS NULL OR lower(coalesce(responsible_user,'')) = lower($3))`,
    [baliStart(ws), baliStart(addDays(ws, 7)), broker],
  );
  return { weekStart: ws, viewings: rows, outcomes, contractsSigned: deals.rows[0]?.n ?? 0 };
}

// ── Gate: QUALIFIED → inspection → Listed → live (Yudi) ─────────────────────

export async function gateYudi(ws: string) {
  const from = baliStart(ws);
  const to = baliStart(addDays(ws, 7));
  const q = async (sql: string, params: unknown[] = [from, to]) => (await pool.query(sql, params).catch((err) => {
    logger.warn({ err }, "os: yudi gate query failed");
    return { rows: [{ n: null }] };
  })).rows[0]?.n ?? null;
  const qualified = await q(`SELECT count(*)::int AS n FROM leads_sync WHERE lower(coalesce(pipeline,'')) = 'rental listings' AND lead_stage ILIKE 'qualified%'`, []);
  const asksDrafted = await q(`SELECT count(DISTINCT lead_id)::int AS n FROM listing_inspection_asks WHERE created_at >= $1 AND created_at < $2`);
  const asksSent = await q(
    `SELECT count(DISTINCT a.lead_id)::int AS n FROM listing_inspection_asks a JOIN pending_suggestions p ON p.id::text = a.suggestion_id::text
      WHERE a.created_at >= $1 AND a.created_at < $2 AND (p.status IN ('approved','edited') OR p.auto_sent)`,
  );
  const agreed = await q(`SELECT count(DISTINCT lead_id)::int AS n FROM listing_inspection_slots WHERE agreed_at >= $1 AND agreed_at < $2`);
  const held = await q(
    `SELECT count(DISTINCT lead_id)::int AS n FROM listing_inspection_slots WHERE visit_at >= $1 AND visit_at < $2 AND visit_at < now() AND coalesce(status,'scheduled') = 'scheduled' AND superseded_at IS NULL`,
  );
  const reportsDone = await q(`SELECT count(*)::int AS n FROM inspection_reports WHERE visit_at >= $1 AND visit_at < $2 AND status = 'done'`);
  const reportsDue = await q(`SELECT count(*)::int AS n FROM inspection_reports WHERE status = 'due'`, []);
  const live = await q(
    `SELECT count(DISTINCT lead_id)::int AS n FROM stage_events WHERE lower(coalesce(pipeline,'')) = 'rental listings' AND lower(to_stage) = 'live' AND changed_at >= $1 AND changed_at < $2`,
  );
  const week = await weekToDate(addDays(ws, 6) < baliDate() ? addDays(ws, 6) : baliDate()).catch(() => null);
  return {
    weekStart: ws,
    steps: [
      { key: "qualified", label: "QUALIFIED now (stock)", n: qualified },
      { key: "asks", label: "Inspection asks drafted", n: asksDrafted },
      { key: "asksSent", label: "Asks sent", n: asksSent },
      { key: "agreed", label: "Visit agreed", n: agreed },
      { key: "held", label: "Inspection held", n: held },
      { key: "reports", label: "Report done", n: reportsDone },
      { key: "listed", label: "Switched to Listed", n: week?.yudi.listed ?? null },
      { key: "live", label: "Card reached live", n: live },
    ],
    reportsDue,
    published: week?.yudi.published ?? null,
  };
}

// ── Supply gaps by segment ──────────────────────────────────────────────────

const band = (b: number | null) => (b == null ? "no budget" : b <= 30e6 ? "≤30M" : b <= 50e6 ? "30–50M" : b <= 70e6 ? "50–70M" : b <= 100e6 ? "70–100M" : "100M+");
const bandRange: Record<string, [number, number]> = { "≤30M": [0, 30e6], "30–50M": [30e6, 50e6], "50–70M": [50e6, 70e6], "70–100M": [70e6, 100e6], "100M+": [100e6, 1e12] };

export async function supplyGaps(days = 14) {
  const { rows } = await pool.query(
    `SELECT req_areas, req_bedrooms, req_budget_idr_monthly FROM leads_sync
      WHERE lower(coalesce(pipeline,'')) = 'rental' AND amo_created_at > now() - ($1 || ' days')::interval AND (req_areas IS NOT NULL OR req_bedrooms IS NOT NULL)`,
    [String(days)],
  );
  const listings = await listListings({ type: "rent" }).catch(() => []);
  const today = baliDate();
  const soon = addDays(today, 92);
  const seg = new Map<string, { area: string; bedrooms: number | null; band: string; requests: number }>();
  for (const r of rows) {
    const area = String(r.req_areas ?? "any").split(/[,/;]| or /i)[0].trim() || "any";
    const key = `${area.toLowerCase()}|${r.req_bedrooms ?? "?"}|${band(r.req_budget_idr_monthly)}`;
    const s = seg.get(key) ?? { area, bedrooms: r.req_bedrooms ?? null, band: band(r.req_budget_idr_monthly), requests: 0 };
    s.requests++;
    seg.set(key, s);
  }
  const out = [...seg.values()]
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 12)
    .map((s) => {
      const [lo, hi] = bandRange[s.band] ?? [0, 1e12];
      const fits = listings.filter((l) => {
        const L = l as Record<string, unknown>;
        const areaText = `${L["area"] ?? ""} ${L["title"] ?? ""}`.toLowerCase();
        if (s.area !== "any" && !areaText.includes(s.area.toLowerCase())) return false;
        if (s.bedrooms != null && Number(L["bedrooms"]) !== s.bedrooms) return false;
        const price = Number(L["monthly_price_idr"] ?? 0);
        if (s.band !== "no budget" && (price <= 0 || price > hi * 1.25 || price < lo * 0.7)) return false;
        const ff = (L["freeFrom"] as string | null) ?? null;
        return !ff || ff <= soon;
      });
      return { ...s, matchingVillas: fits.length, examples: fits.slice(0, 4).map((l) => (l as Record<string, unknown>)["id"]) };
    });
  return { days, segments: out };
}

// ── Drafts decided, AI cost ─────────────────────────────────────────────────

export async function draftsDecided(ws: string) {
  const { rows } = await pool.query(
    `SELECT coalesce(responsible_user,'?') AS broker, kind,
            count(*) FILTER (WHERE auto_sent)::int AS bot_sent,
            count(*) FILTER (WHERE status = 'approved' AND NOT coalesce(auto_sent,false))::int AS sent_as_is,
            count(*) FILTER (WHERE status = 'edited')::int AS edited,
            count(*) FILTER (WHERE status = 'skipped')::int AS skipped,
            count(*) FILTER (WHERE status = 'pending')::int AS untouched
       FROM pending_suggestions WHERE created_at >= $1 AND created_at < $2
      GROUP BY 1, 2 ORDER BY 1, 2`,
    [baliStart(ws), baliStart(addDays(ws, 7))],
  );
  return rows;
}

export async function aiCost(days = 7) {
  const { rows } = await pool.query(
    `SELECT to_char((created_at AT TIME ZONE 'Asia/Makassar')::date, 'YYYY-MM-DD') AS day, coalesce(label,'other') AS label, round(sum(cost_usd)::numeric, 2)::float AS usd, count(*)::int AS calls
       FROM ai_usage WHERE created_at > now() - ($1 || ' days')::interval GROUP BY 1, 2 ORDER BY 1, 3 DESC`,
    [String(days)],
  );
  return rows;
}

// ── The weekly review and its brief ─────────────────────────────────────────

export function lastFullWeek(): string {
  return mondayOf(addDays(baliDate(), -7));
}

export async function weeklyReview(weekStart?: string) {
  const ws = weekStart ?? lastFullWeek();
  const we = addDays(ws, 6);
  const today = baliDate();
  const lastDay = we < today ? we : today;
  const prevWs = addDays(ws, -7);
  const safe = async <T,>(p: Promise<T>, fallback: T): Promise<T> => p.catch((err) => {
    logger.warn({ err }, "os: weekly review section failed");
    return fallback;
  });
  const [targets, facts, prevFacts, gate1, gate1prev, gate2, yudi, yudiPrev, rentalFunnel, listingFunnel, rentalWaits, listingWaits, objections, supply, drafts, leads] = await Promise.all([
    targetsAt(ws),
    safe(weekToDate(lastDay), null),
    safe(weekToDate(addDays(prevWs, 6)), null),
    safe(gateOptionsToViewing(ws), null),
    safe(gateOptionsToViewing(prevWs), null),
    safe(gateViewingToDeal(ws), null),
    safe(gateYudi(ws), null),
    safe(gateYudi(prevWs), null),
    safe(funnelWeeks({ pipeline: "Rental", weeks: 6 }), null),
    safe(funnelWeeks({ pipeline: "Rental Listings", weeks: 6 }), null),
    safe(stageWaits({ pipeline: "Rental" }), []),
    safe(stageWaits({ pipeline: "Rental Listings" }), []),
    safe(objectionsSummary({ days: 14 }), null),
    safe(supplyGaps(14), null),
    safe(draftsDecided(ws), []),
    safe(
      pool
        .query(
          `SELECT lower(coalesce(pipeline,'')) AS pipeline, count(*)::int AS n FROM leads_sync WHERE amo_created_at >= $1 AND amo_created_at < $2 GROUP BY 1`,
          [baliStart(ws), baliStart(addDays(ws, 7))],
        )
        .then((r) => r.rows),
      [],
    ),
  ]);
  return {
    weekStart: ws,
    weekEnd: we,
    partial: we >= today,
    targets,
    facts,
    prevFacts,
    gateOptionsToViewing: gate1,
    gateOptionsToViewingPrev: gate1prev ? { steps: gate1prev.steps } : null,
    gateViewingToDeal: gate2,
    gateYudi: yudi,
    gateYudiPrev: yudiPrev ? { steps: yudiPrev.steps } : null,
    rentalFunnel,
    listingFunnel,
    rentalWaits,
    listingWaits,
    objections,
    supply,
    drafts,
    leadsCreated: leads,
  };
}

export async function latestBrief() {
  await ensureAnalyticsTables();
  const { rows } = await pool.query(`SELECT week_start, generated_at, generated_by, content FROM os_briefs ORDER BY week_start DESC LIMIT 8`);
  return rows.map((r) => ({
    weekStart: r.week_start instanceof Date ? r.week_start.toISOString().slice(0, 10) : String(r.week_start).slice(0, 10),
    generatedAt: r.generated_at,
    generatedBy: r.generated_by,
    content: r.content,
  }));
}

export async function generateBrief(by: string, weekStart?: string) {
  await ensureAnalyticsTables();
  const review = await weeklyReview(weekStart);
  const slim = {
    ...review,
    rentalWaits: review.rentalWaits.map((s) => ({ ...s, cards: s.cards.slice(0, 4) })),
    listingWaits: review.listingWaits.map((s) => ({ ...s, cards: s.cards.slice(0, 4) })),
    gateOptionsToViewing: review.gateOptionsToViewing ? { ...review.gateOptionsToViewing, stuck: review.gateOptionsToViewing.stuck.slice(0, 15) } : null,
    objections: review.objections ? { ...review.objections, recent: review.objections.recent.slice(0, 40), viewingReports: review.objections.viewingReports.slice(0, 15), lost: review.objections.lost.slice(0, 20) } : null,
  };
  const res = await chatCompletion({
    model: WRITER_MODEL,
    label: "os-weekly-brief",
    max_tokens: 2800,
    system: `You are the operations analyst of Unicorn Property (Bali, long-term villa rentals). Rental clients: Amelia. Villa owners and listings: Yudi. Write the owner's weekly BOTTLENECK review for the week ${review.weekStart}–${review.weekEnd}${review.partial ? " (week still running)" : ""} in English markdown. Say "bottleneck", never "screw-up". Honest denominators; the bot is never counted as the broker. 12–20 lines per broker: not a wall, not bare.

### Amelia
Target: viewings held <target> → <fact> (last week <fact>) · signed contracts <target> → <fact>.
Focus this week: one line — the single action with the biggest gap.
Bottlenecks (2–3, one line each): <gate/step>: <n of N> (<%>) — why. e.g. <first name>: "<client quote>" → what happened. Fix: what the broker or the system does.
Funnel: stage n → stage n (%) · pile-up: stage, n cards, median days.
Objections: category n · category n (vs last week if known).
### Yudi
Target: inspections, Pre-listed published, Listed — target → fact (last week).
Focus, bottlenecks, funnel as above, using the QUALIFIED → inspection → Listed → live chain.
### Supply
Which segments clients ask for with no matching villa (area, bedrooms, budget), and how many requests.

Use ONLY numbers present in the data. If something is missing write "no data", never invent.`,
    messages: [{ role: "user", content: JSON.stringify(slim).slice(0, 70000) }],
  });
  const content = String(res.content ?? "").trim();
  await pool.query(
    `INSERT INTO os_briefs (week_start, generated_by, content, data) VALUES ($1, $2, $3, $4)
     ON CONFLICT (week_start) DO UPDATE SET content = EXCLUDED.content, generated_at = now(), generated_by = EXCLUDED.generated_by, data = EXCLUDED.data`,
    [review.weekStart, by, content, JSON.stringify(slim).slice(0, 800000)],
  );
  return { weekStart: review.weekStart, content };
}

// ── Schedules: objections every 2 h in daytime; the brief on Monday 08:30 Bali ──

let started = false;
export function startOsAnalytics(): void {
  if (started || process.env["OS_ANALYTICS_DISABLED"] === "1") return;
  started = true;
  let lastScanKey = "";
  const tick = async () => {
    try {
      const bali = new Date(Date.now() + 8 * 3600_000);
      const hour = bali.getUTCHours();
      const key = `${bali.toISOString().slice(0, 10)}:${Math.floor(hour / 2)}`;
      if (hour >= 7 && hour <= 22 && key !== lastScanKey) {
        lastScanKey = key;
        await scanObjections({ days: 30 });
      }
      if (bali.getUTCDay() === 1 && (hour > 8 || (hour === 8 && bali.getUTCMinutes() >= 30))) {
        await ensureAnalyticsTables();
        const ws = lastFullWeek();
        const have = await pool.query(`SELECT 1 FROM os_briefs WHERE week_start = $1`, [ws]);
        if (!have.rows.length) await generateBrief("schedule", ws);
      }
    } catch (err) {
      logger.warn({ err }, "os: analytics tick failed");
    }
  };
  setTimeout(tick, 4 * 60_000);
  setInterval(tick, 10 * 60_000);
}
