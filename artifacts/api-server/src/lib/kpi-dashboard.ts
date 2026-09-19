/**
 * The owner's daily numbers, one page for the whole business (owner, 19.09.2026): traffic and what it
 * cost, what the autopilot did, what Amelia and Yudi did. The page is /kpi (routes/kpi.ts); the owner
 * posts it to the team chat, so everything here is in English and holds no client names.
 *
 * Every number says where it comes from, because the brokers read it too and one wrong number spoils
 * the page (see the "report-split-bot-vs-broker" lesson): bot and broker sends are always separate
 * rows, and a broker is never billed for what the autopilot did.
 *
 * Sources:
 * - Traffic: amoCRM leads created in the day, classified by the card's Source field (956451), UTM
 *   medium (372079), click ids, tags and the scout's card name. amoCRM is the only place a lead's
 *   source is written, so it is read live (cached 10 min).
 * - Ad spend: `kpi_ad_spend`, pulled every 4 hours from the Make scenario "whatcan KPI: Meta ad spend on
 *   request" (6329721): its webhook (broker_settings `kpi_meta_webhook_url`) reads Meta Ads insights through
 *   the owner's Facebook connection and answers with rows. There is no Meta token on this server.
 * - Autopilot: sent_messages (+ pending_suggestions.auto_sent), stage_events written by the listing
 *   engine (responsible_user 'engine:*'), the weekly check's answer markers in broker_settings.
 * - Brokers: Copilot sends (sent_messages, not auto), phone messages (lead_messages broker/whatsapp on
 *   the broker's cards), viewing_slots / viewing_reports, listing_inspection_slots, the site's
 *   listing_status_log (Pre-listed → Listed), amoCRM tasks and won deals.
 *
 * Days are Bali days.
 */
import { pool } from "@workspace/db";
import { amoFetch } from "./amo-client";
import { buildReport } from "./daily-report";
import { siteGet, LISTINGS_PIPELINE_ID } from "./listing-status-week";
import { logger } from "./logger";

const BALI = "Asia/Makassar";
export const RENTAL_PIPELINE_ID = 11119150;
export const SALES_PIPELINE_ID = 8347534;
const WON_STATUS = 142;

/** amoCRM user ids of the two brokers the page follows. */
export const KPI_BROKERS = [
  { name: "Amelia", amoId: 13372414, pipeline: "Rental", pipelineId: 11119150, role: "Client broker (Rental)" },
  { name: "Yudi", amoId: 13301186, pipeline: "Rental Listings", pipelineId: 11180334, role: "Listing agent (Rental Listings)" },
] as const;

/** Weekly targets set by the owner on 14.09.2026. */
export const WEEKLY_TARGETS = {
  amelia: { deals: 1, viewings: 2 },
  yudi: { prelisted: 10, listed: 10 },
};

// ── Days ─────────────────────────────────────────────────────────────────────

export function baliDate(d = new Date()): string {
  return new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}
function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
}
export function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 62; d = addDays(d, 1)) out.push(d);
  return out;
}
const startSec = (day: string) => Date.parse(`${day}T00:00:00+08:00`) / 1000;
const startIso = (day: string) => new Date(startSec(day) * 1000).toISOString();
/** Monday of the Bali week containing `day`. */
export function weekStartOf(day: string): string {
  const dow = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(day, -dow);
}

type Series = Record<string, number>;
const zero = (days: string[]): Series => Object.fromEntries(days.map((d) => [d, 0]));

/** Runs a grouped count: SQL must return columns `d` (Bali date text), `k` (key) and `n`. */
async function grouped(sql: string, params: unknown[], days: string[]): Promise<Record<string, Series>> {
  const r = await pool.query(sql, params);
  const out: Record<string, Series> = {};
  for (const row of r.rows as { d: string; k: string; n: number }[]) {
    const s = (out[row.k] ??= zero(days));
    if (row.d in s) s[row.d] = Number(row.n);
  }
  return out;
}
const pick = (m: Record<string, Series>, k: string, days: string[]) => m[k] ?? zero(days);

// ── Tables ───────────────────────────────────────────────────────────────────

let ensured: Promise<void> | null = null;
export function ensureKpiTables(): Promise<void> {
  ensured ??= pool
    .query(
      `CREATE TABLE IF NOT EXISTS kpi_ad_spend (
         day date NOT NULL,
         account_id text NOT NULL,
         campaign_id text NOT NULL,
         campaign_name text,
         currency text,
         spend numeric NOT NULL DEFAULT 0,
         impressions bigint NOT NULL DEFAULT 0,
         clicks bigint NOT NULL DEFAULT 0,
         link_clicks bigint NOT NULL DEFAULT 0,
         meta_leads int NOT NULL DEFAULT 0,
         updated_at timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY (day, account_id, campaign_id)
       )`,
    )
    .then(() => undefined)
    .catch((err) => {
      ensured = null;
      throw err;
    });
  return ensured;
}

// ── Ad spend ingest (from Make) ──────────────────────────────────────────────

type MetaAction = { action_type?: string; value?: string | number };
export type AdSpendRow = {
  date_start?: string;
  account_id?: string;
  campaign_id?: string;
  campaign_name?: string;
  account_currency?: string;
  spend?: string | number;
  impressions?: string | number;
  clicks?: string | number;
  inline_link_clicks?: string | number;
  actions?: MetaAction[] | null;
};

/** Meta reports the same lead under several action types; the form lead is the one we pay for. */
function metaLeads(actions: MetaAction[] | null | undefined): number {
  if (!Array.isArray(actions)) return 0;
  const by = new Map(actions.map((a) => [String(a.action_type ?? ""), Number(a.value ?? 0)]));
  return by.get("lead") ?? by.get("onsite_conversion.lead_grouped") ?? by.get("offsite_conversion.fb_pixel_lead") ?? 0;
}

export async function ingestAdSpend(rows: AdSpendRow[]): Promise<number> {
  await ensureKpiTables();
  let n = 0;
  for (const r of rows) {
    // Make hands the account-timezone midnight as an ISO instant (2026-09-11T17:00Z = 12.09 in Jakarta);
    // half a day forward lands on the right date for any offset.
    const raw = String(r.date_start ?? "");
    const day = raw.includes("T") ? new Date(Date.parse(raw) + 12 * 3600_000).toISOString().slice(0, 10) : raw.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !r.campaign_id) continue;
    await pool.query(
      `INSERT INTO kpi_ad_spend (day, account_id, campaign_id, campaign_name, currency, spend, impressions, clicks, link_clicks, meta_leads, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
       ON CONFLICT (day, account_id, campaign_id) DO UPDATE SET
         campaign_name = EXCLUDED.campaign_name, currency = EXCLUDED.currency, spend = EXCLUDED.spend,
         impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks, link_clicks = EXCLUDED.link_clicks,
         meta_leads = EXCLUDED.meta_leads, updated_at = now()`,
      [
        day,
        String(r.account_id ?? ""),
        String(r.campaign_id),
        r.campaign_name ?? null,
        r.account_currency ?? null,
        Number(r.spend ?? 0) || 0,
        Math.round(Number(r.impressions ?? 0) || 0),
        Math.round(Number(r.clicks ?? 0) || 0),
        Math.round(Number(r.inline_link_clicks ?? 0) || 0),
        Math.round(metaLeads(r.actions)),
      ],
    );
    n++;
  }
  return n;
}

// ── Traffic ──────────────────────────────────────────────────────────────────

export type Channel =
  | "paid_meta_form"
  | "paid_website"
  | "organic_website"
  | "fb_groups"
  | "instagram"
  | "direct"
  | "owner_outreach"
  | "owner_referral"
  | "owner_other";

export const CHANNEL_LABEL: Record<Channel, string> = {
  paid_meta_form: "Meta lead form (paid)",
  paid_website: "Website, paid click",
  organic_website: "Website, organic",
  fb_groups: "Facebook groups (scout)",
  instagram: "Instagram",
  direct: "Direct / WhatsApp / other",
  owner_outreach: "Owner outreach (AI scout)",
  owner_referral: "Owner referral",
  owner_other: "Other owner leads",
};
export const PAID_CHANNELS: Channel[] = ["paid_meta_form", "paid_website"];

type AmoLead = {
  id: number;
  name: string | null;
  pipeline_id: number;
  created_at: number;
  custom_fields_values?: { field_id: number; values: { value?: unknown }[] }[] | null;
  _embedded?: { tags?: { name: string }[] };
};

const PAID_MEDIUM = /^(paid|cpc|ppc|paid[_-]?social|cpm|ads?)$/i;

export function classifyLead(l: AmoLead): { segment: "clients" | "sales" | "owners"; channel: Channel } {
  const f = (id: number) => {
    const v = l.custom_fields_values?.find((x) => x.field_id === id)?.values?.[0]?.value;
    return v == null ? "" : String(v);
  };
  const tags = (l._embedded?.tags ?? []).map((t) => t.name.toLowerCase());
  const name = l.name ?? "";
  const source = f(956451).toLowerCase();

  if (l.pipeline_id === LISTINGS_PIPELINE_ID) {
    if (source.includes("facebook lead ads")) return { segment: "owners", channel: "paid_meta_form" };
    if (tags.includes("referral")) return { segment: "owners", channel: "owner_referral" };
    if (tags.includes("src:ai")) return { segment: "owners", channel: "owner_outreach" };
    return { segment: "owners", channel: "owner_other" };
  }
  const segment = l.pipeline_id === SALES_PIPELINE_ID ? "sales" : "clients";
  if (source.includes("facebook lead ads")) return { segment, channel: "paid_meta_form" };
  if (source.startsWith("website") || tags.includes("website") || /^WEB-/.test(name)) {
    const paid = PAID_MEDIUM.test(f(372079)) || f(372109) !== "" || f(372113) !== "";
    return { segment, channel: paid ? "paid_website" : "organic_website" };
  }
  if (/^FB Lead/i.test(name)) return { segment, channel: "fb_groups" };
  if (tags.some((t) => t.includes("instagram"))) return { segment, channel: "instagram" };
  return { segment, channel: "direct" };
}

const amoCache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = amoCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await fn();
  amoCache.set(key, { at: Date.now(), value });
  return value;
}

async function amoLeadsCreated(from: string, to: string): Promise<AmoLead[]> {
  const today = baliDate();
  // A finished day never changes; today is refreshed every 10 minutes.
  return cached(`leads:${from}:${to}`, to >= today ? 10 * 60_000 : 6 * 3600_000, async () => {
    const out: AmoLead[] = [];
    const fromSec = startSec(from);
    const toSec = startSec(addDays(to, 1)) - 1;
    for (let page = 1; page <= 20; page++) {
      const d = await amoFetch<{ _embedded?: { leads?: AmoLead[] } }>(
        `/api/v4/leads?filter[created_at][from]=${fromSec}&filter[created_at][to]=${toSec}&limit=250&page=${page}`,
      );
      const leads = d?._embedded?.leads ?? [];
      out.push(...leads);
      if (leads.length < 250) break;
    }
    return out;
  });
}

type WonDeal = { id: number; closed_at: number; responsible_user_id: number; price: number };

async function amoWonDeals(from: string, to: string): Promise<{ id: number; closed_at: number; responsible_user_id: number; price: number }[]> {
  return cached(`won:${from}:${to}`, 10 * 60_000, async () => {
    const out: { id: number; closed_at: number; responsible_user_id: number; price: number }[] = [];
    for (const pipeline of [RENTAL_PIPELINE_ID, SALES_PIPELINE_ID]) {
      for (let page = 1; page <= 5; page++) {
        const d = await amoFetch<{ _embedded?: { leads?: { id: number; closed_at: number; responsible_user_id: number; price: number }[] } }>(
          `/api/v4/leads?filter[statuses][0][pipeline_id]=${pipeline}&filter[statuses][0][status_id]=${WON_STATUS}` +
            `&filter[closed_at][from]=${startSec(from)}&filter[closed_at][to]=${startSec(addDays(to, 1)) - 1}&limit=250&page=${page}`,
        );
        const leads = d?._embedded?.leads ?? [];
        out.push(...leads);
        if (leads.length < 250) break;
      }
    }
    return out;
  });
}

async function traffic(days: string[]) {
  const from = days[0]!;
  const to = days[days.length - 1]!;
  const [leads, spendRows] = await Promise.all([
    amoLeadsCreated(from, to),
    ensureKpiTables().then(() =>
      pool.query(
        `SELECT day::text AS d, campaign_name, currency, spend::float8 AS spend, impressions::int, clicks::int,
                link_clicks::int, meta_leads, updated_at
           FROM kpi_ad_spend WHERE day BETWEEN $1 AND $2`,
        [from, to],
      ),
    ),
  ]);

  const bySeg: Record<string, Record<string, Series>> = { clients: {}, sales: {}, owners: {} };
  for (const l of leads) {
    const d = baliDate(new Date(l.created_at * 1000));
    if (!days.includes(d)) continue;
    const { segment, channel } = classifyLead(l);
    const s = (bySeg[segment]![channel] ??= zero(days));
    s[d] = (s[d] ?? 0) + 1;
  }

  const spend = zero(days);
  const impressions = zero(days);
  const linkClicks = zero(days);
  const metaLeadsS = zero(days);
  const campaigns = new Map<string, { spend: number; metaLeads: number }>();
  let currency: string | null = null;
  let spendUpdatedAt: string | null = null;
  for (const r of spendRows.rows as Record<string, unknown>[]) {
    const d = String(r["d"]);
    spend[d] = (spend[d] ?? 0) + Number(r["spend"]);
    impressions[d] = (impressions[d] ?? 0) + Number(r["impressions"]);
    linkClicks[d] = (linkClicks[d] ?? 0) + Number(r["link_clicks"]);
    metaLeadsS[d] = (metaLeadsS[d] ?? 0) + Number(r["meta_leads"]);
    currency ??= (r["currency"] as string) ?? null;
    const u = new Date(r["updated_at"] as string).toISOString();
    if (!spendUpdatedAt || u > spendUpdatedAt) spendUpdatedAt = u;
    const name = String(r["campaign_name"] ?? "campaign");
    const c = campaigns.get(name) ?? { spend: 0, metaLeads: 0 };
    c.spend += Number(r["spend"]);
    c.metaLeads += Number(r["meta_leads"]);
    campaigns.set(name, c);
  }

  return {
    leads: bySeg,
    ads: {
      currency,
      spendUpdatedAt,
      spend,
      impressions,
      linkClicks,
      metaLeads: metaLeadsS,
      campaigns: [...campaigns.entries()]
        .map(([name, v]) => ({ name, ...v }))
        .filter((c) => c.spend > 0 || c.metaLeads > 0)
        .sort((a, b) => b.spend - a.spend),
    },
  };
}

// ── Autopilot ────────────────────────────────────────────────────────────────

async function autopilot(days: string[]) {
  const from = startIso(days[0]!);
  const to = startIso(addDays(days[days.length - 1]!, 1));
  const params = [BALI, from, to];

  const sends = await grouped(
    `SELECT (s.created_at AT TIME ZONE $1)::date::text AS d,
            CASE WHEN l.pipeline = 'Rental Listings' THEN 'listings' ELSE 'rental' END
              || ':' || CASE WHEN s.kind = 'weekly-availability' THEN 'weekly'
                             WHEN s.kind = 'ad_auto' THEN 'ad_auto'
                             ELSE coalesce(s.kind, 'other') END AS k,
            count(*)::int AS n
       FROM sent_messages s
       LEFT JOIN pending_suggestions p ON p.id = s.suggestion_id
       LEFT JOIN leads_sync l ON l.lead_id = s.lead_id
      WHERE s.created_at >= $2 AND s.created_at < $3 AND s.webhook_status = 200
        AND (coalesce(p.auto_sent, false) OR s.kind IN ('ad_auto', 'weekly-availability'))
      GROUP BY 1, 2`,
    params,
    days,
  );
  const ownersTouched = await grouped(
    `SELECT (s.created_at AT TIME ZONE $1)::date::text AS d, 'owners' AS k, count(DISTINCT s.lead_id)::int AS n
       FROM sent_messages s
       JOIN pending_suggestions p ON p.id = s.suggestion_id AND p.auto_sent
       JOIN leads_sync l ON l.lead_id = s.lead_id AND l.pipeline = 'Rental Listings'
      WHERE s.created_at >= $2 AND s.created_at < $3 AND s.webhook_status = 200
      GROUP BY 1, 2`,
    params,
    days,
  );
  const firstContacts = await grouped(
    `SELECT (first_at AT TIME ZONE $1)::date::text AS d, 'first' AS k, count(*)::int AS n
       FROM (SELECT s.lead_id, min(s.created_at) AS first_at
               FROM sent_messages s JOIN leads_sync l ON l.lead_id = s.lead_id AND l.pipeline = 'Rental Listings'
              WHERE s.webhook_status = 200 GROUP BY 1) f
      WHERE first_at >= $2 AND first_at < $3
      GROUP BY 1, 2`,
    params,
    days,
  );
  const ownerReplies = await grouped(
    `SELECT (m.sent_at AT TIME ZONE $1)::date::text AS d, 'replies' AS k, count(DISTINCT m.lead_id)::int AS n
       FROM lead_messages m JOIN leads_sync l ON l.lead_id = m.lead_id AND l.pipeline = 'Rental Listings'
      WHERE m.sent_at >= $2 AND m.sent_at < $3 AND m.sender_type = 'lead'
      GROUP BY 1, 2`,
    params,
    days,
  );
  const engine = await grouped(
    `SELECT (changed_at AT TIME ZONE $1)::date::text AS d,
            CASE WHEN to_stage ILIKE 'TAKEN TO WORK%' THEN 'taken'
                 WHEN to_stage ILIKE 'QUALIFIED%' THEN 'qualified'
                 WHEN to_stage ILIKE '%lost%' THEN 'lost'
                 WHEN to_stage ILIKE 'co-broke%' THEN 'cobroke'
                 WHEN to_stage ILIKE 'long term%' THEN 'longterm'
                 ELSE 'other' END AS k,
            count(DISTINCT lead_id)::int AS n
       FROM stage_events
      WHERE changed_at >= $2 AND changed_at < $3 AND pipeline = 'Rental Listings' AND responsible_user LIKE 'engine:%'
      GROUP BY 1, 2`,
    params,
    days,
  );
  const weeklyAnswers = await pool.query(`SELECT value FROM broker_settings WHERE key LIKE 'weekly_check:answer:%'`);
  const answered = zero(days);
  const clear = zero(days);
  const siteUpdated = zero(days);
  for (const row of weeklyAnswers.rows as { value: string }[]) {
    try {
      const v = JSON.parse(row.value) as { at?: string; answer?: string; result?: string };
      if (!v.at) continue;
      const d = baliDate(new Date(v.at));
      if (!(d in answered)) continue;
      answered[d]!++;
      if (v.answer && v.answer !== "unclear") clear[d]!++;
      if (/\b(set|marked|already shows)\b/.test(v.result ?? "")) siteUpdated[d]!++;
    } catch {
      /* a marker that is not JSON is the older 'handled' form — not counted */
    }
  }
  const coverage = await pool.query(
    `SELECT count(*)::int AS live,
            count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM sent_messages s WHERE s.lead_id = l.lead_id AND s.webhook_status = 200
                 AND s.created_at > now() - interval '7 days'))::int AS asked_7d,
            count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM sent_messages s WHERE s.lead_id = l.lead_id AND s.webhook_status = 200
                 AND s.kind = 'weekly-availability' AND s.created_at > now() - interval '7 days'))::int AS weekly_7d
       FROM leads_sync l
      WHERE l.pipeline = 'Rental Listings'
        AND l.lead_stage IN ('live', 'Weekly Check Sent', 'Update Availability Received')`,
  );
  const cov = coverage.rows[0] as { live: number; asked_7d: number; weekly_7d: number };
  const mode = await pool.query(`SELECT value FROM broker_settings WHERE key = 'weekly_availability_mode'`);

  return {
    rental: {
      adInstantReplies: pick(sends, "rental:ad_auto", days),
      autoSent: sumSeries(days, pick(sends, "rental:live", days), pick(sends, "rental:push", days)),
    },
    listings: {
      messagesSent: sumSeries(days, pick(sends, "listings:live", days), pick(sends, "listings:push", days)),
      ownersMessaged: pick(ownersTouched, "owners", days),
      firstContacts: pick(firstContacts, "first", days),
      ownersReplied: pick(ownerReplies, "replies", days),
      takenToWork: pick(engine, "taken", days),
      qualified: pick(engine, "qualified", days),
      closedLost: pick(engine, "lost", days),
      coBroke: pick(engine, "cobroke", days),
      longTerm: pick(engine, "longterm", days),
    },
    weeklyCheck: {
      mode: (mode.rows[0] as { value?: string } | undefined)?.value ?? "dry",
      sent: pick(sends, "listings:weekly", days),
      answered,
      clearAnswers: clear,
      siteUpdated,
      liveListings: cov?.live ?? 0,
      liveAskedLast7d: cov?.asked_7d ?? 0,
      liveWeeklyCheckLast7d: cov?.weekly_7d ?? 0,
    },
  };
}

function sumSeries(days: string[], ...s: Series[]): Series {
  const out = zero(days);
  for (const d of days) out[d] = s.reduce((a, x) => a + (x[d] ?? 0), 0);
  return out;
}

// ── Brokers ──────────────────────────────────────────────────────────────────

type AmoTaskRow = { id: number; entity_id: number; entity_type: string | null; complete_till: number; updated_at: number; result?: { text?: string } | null };

async function amoTasks(userId: number, completed: boolean, sinceSec?: number): Promise<AmoTaskRow[]> {
  return cached(`tasks:${userId}:${completed}:${sinceSec ?? ""}`, 5 * 60_000, async () => {
    const out: AmoTaskRow[] = [];
    for (let page = 1; page <= 20; page++) {
      const d = await amoFetch<{ _embedded?: { tasks?: AmoTaskRow[] } }>(
        `/api/v4/tasks?filter[responsible_user_id]=${userId}&filter[is_completed]=${completed ? 1 : 0}` +
          (sinceSec ? `&filter[updated_at][from]=${sinceSec}` : "") +
          `&limit=250&page=${page}`,
      );
      const tasks = d?._embedded?.tasks ?? [];
      out.push(...tasks);
      if (tasks.length < 250) break;
    }
    return out;
  });
}

/** Where each task's card sits in amoCRM now (our leads_sync does not hold every old card); absent = deleted. */
async function leadStatuses(ids: string[]): Promise<Map<string, { pipeline: number; status: number }>> {
  const out = new Map<string, { pipeline: number; status: number }>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const q = chunk.map((id) => `filter[id][]=${encodeURIComponent(id)}`).join("&");
    const d = await cached(`status:${chunk.join(",")}`, 30 * 60_000, () =>
      amoFetch<{ _embedded?: { leads?: { id: number; status_id: number; pipeline_id: number }[] } }>(`/api/v4/leads?${q}&limit=250`),
    );
    if (!d) throw new Error("amoCRM leads status read failed");
    for (const l of d._embedded?.leads ?? []) out.set(String(l.id), { pipeline: l.pipeline_id, status: l.status_id });
  }
  return out;
}

/** Stages that are archives, not work: a task there is clean-up. */
const ARCHIVE_STATUSES = new Set<number>([142, 143, 88322314 /* co-broke Agents */]);

async function taskState(userId: number, pipelineId: number, days: string[]) {
  const [open, done] = await Promise.all([amoTasks(userId, false), amoTasks(userId, true, startSec(days[0]!))]);
  // Only a task on an open card of the broker's own funnel is work owed. The rest (old UNICORN sales
  // cards still assigned to them, won/lost, co-broke archive, deleted cards) is shown as clean-up.
  const leadIds = [...new Set(open.filter((t) => t.entity_type === "leads").map((t) => String(t.entity_id)))];
  const statuses = await leadStatuses(leadIds);
  let otherFunnels = 0;
  let archived = 0;
  const active: AmoTaskRow[] = [];
  for (const t of open) {
    const st = t.entity_type === "leads" ? statuses.get(String(t.entity_id)) : undefined;
    if (!st || ARCHIVE_STATUSES.has(st.status)) archived++;
    else if (st.pipeline !== pipelineId) otherFunnels++;
    else active.push(t);
  }
  const now = Date.now() / 1000;
  const overdueDays = active.filter((t) => t.complete_till < now).map((t) => (now - t.complete_till) / 86400);
  const sorted = [...overdueDays].sort((a, b) => a - b);
  const doneByBroker = zero(days);
  const doneAuto = zero(days);
  for (const t of done) {
    const d = baliDate(new Date(t.updated_at * 1000));
    if (!(d in doneByBroker)) continue;
    if (/closed automatically/i.test(t.result?.text ?? "")) doneAuto[d]!++;
    else doneByBroker[d]!++;
  }
  return {
    open: active.length,
    overdue: overdueDays.length,
    overdue1d: overdueDays.filter((x) => x > 1).length,
    overdue3d: overdueDays.filter((x) => x > 3).length,
    overdue7d: overdueDays.filter((x) => x > 7).length,
    medianOverdueDays: sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]! * 10) / 10 : 0,
    oldestOverdueDays: sorted.length ? Math.round(sorted[sorted.length - 1]!) : 0,
    cleanupOtherFunnels: otherFunnels,
    cleanupArchived: archived,
    doneByBroker,
    doneAuto,
  };
}

async function brokers(days: string[]) {
  const from = startIso(days[0]!);
  const to = startIso(addDays(days[days.length - 1]!, 1));
  const params = [BALI, from, to];

  const copilot = await grouped(
    `SELECT (s.created_at AT TIME ZONE $1)::date::text AS d, lower(s.responsible_user) AS k, count(*)::int AS n
       FROM sent_messages s LEFT JOIN pending_suggestions p ON p.id = s.suggestion_id
      WHERE s.created_at >= $2 AND s.created_at < $3 AND s.webhook_status = 200
        AND s.kind IN ('live', 'push') AND NOT coalesce(p.auto_sent, false)
      GROUP BY 1, 2`,
    params,
    days,
  );
  const phone = await grouped(
    `SELECT (m.sent_at AT TIME ZONE $1)::date::text AS d, lower(l.responsible_user) AS k, count(*)::int AS n
       FROM lead_messages m JOIN leads_sync l ON l.lead_id = m.lead_id
      WHERE m.sent_at >= $2 AND m.sent_at < $3 AND m.sender_type = 'broker'
      GROUP BY 1, 2`,
    params,
    days,
  );
  // People the broker personally wrote to (Copilot or phone), bot sends excluded.
  const people = await grouped(
    `SELECT d, k, count(DISTINCT lead_id)::int AS n FROM (
       SELECT (s.created_at AT TIME ZONE $1)::date::text AS d, lower(s.responsible_user) AS k, s.lead_id
         FROM sent_messages s LEFT JOIN pending_suggestions p ON p.id = s.suggestion_id
        WHERE s.created_at >= $2 AND s.created_at < $3 AND s.webhook_status = 200
          AND s.kind IN ('live', 'push') AND NOT coalesce(p.auto_sent, false)
       UNION ALL
       SELECT (m.sent_at AT TIME ZONE $1)::date::text, lower(l.responsible_user), m.lead_id
         FROM lead_messages m JOIN leads_sync l ON l.lead_id = m.lead_id
        WHERE m.sent_at >= $2 AND m.sent_at < $3 AND m.sender_type = 'broker') x
      GROUP BY 1, 2`,
    params,
    days,
  );
  const inbound = await grouped(
    `SELECT (m.sent_at AT TIME ZONE $1)::date::text AS d, lower(l.responsible_user) AS k, count(DISTINCT m.lead_id)::int AS n
       FROM lead_messages m JOIN leads_sync l ON l.lead_id = m.lead_id
      WHERE m.sent_at >= $2 AND m.sent_at < $3 AND m.sender_type = 'lead'
      GROUP BY 1, 2`,
    params,
    days,
  );
  const [viewings, inspections] = await Promise.all([viewingEvents(days), inspectionEvents(days)]);

  // The site: listings published (Pre-listed) and switched Pre-listed → Listed after an inspection.
  const published = zero(days);
  const listed = zero(days);
  try {
    const enc = encodeURIComponent;
    const [props, log] = await Promise.all([
      siteGet<{ id: string; created_at: string }[]>(
        `properties?select=id,created_at&id=like.R-YUD*&is_draft=eq.false&created_at=gte.${enc(from)}&created_at=lt.${enc(to)}`,
      ),
      siteGet<{ property_id: string; pre_listed_old: boolean | null; pre_listed_new: boolean | null; changed_at: string }[]>(
        `listing_status_log?select=property_id,pre_listed_old,pre_listed_new,changed_at&changed_at=gte.${enc(from)}&changed_at=lt.${enc(to)}`,
      ),
    ]);
    for (const p of props) {
      const d = baliDate(new Date(p.created_at));
      if (d in published) published[d]!++;
    }
    const seen = new Set<string>();
    for (const e of log) {
      if (e.pre_listed_old !== true || e.pre_listed_new !== false) continue;
      const d = baliDate(new Date(e.changed_at));
      const key = `${d}:${e.property_id}`;
      if (!(d in listed) || seen.has(key)) continue;
      seen.add(key);
      listed[d]!++;
    }
  } catch (err) {
    logger.warn({ err }, "kpi: site listing numbers unavailable");
  }

  const won = await amoWonDeals(days[0]!, days[days.length - 1]!).catch((): WonDeal[] => []);

  const out = [];
  for (const b of KPI_BROKERS) {
    const k = b.name.toLowerCase();
    const wonS = zero(days);
    for (const w of won) {
      if (w.responsible_user_id !== b.amoId) continue;
      const d = baliDate(new Date(w.closed_at * 1000));
      if (d in wonS) wonS[d]!++;
    }
    const [tasks, report] = await Promise.all([
      taskState(b.amoId, b.pipelineId, days).catch((err) => {
        logger.warn({ err, broker: b.name }, "kpi: amoCRM tasks unavailable");
        return null;
      }),
      buildReport(b.name, "day", b.pipeline).catch(() => null),
    ]);
    out.push({
      name: b.name,
      role: b.role,
      pipeline: b.pipeline,
      messages: {
        viaCopilot: pick(copilot, k, days),
        fromPhone: pick(phone, k, days),
        peopleWritten: pick(people, k, days),
        peopleWroteIn: pick(inbound, k, days),
      },
      ...(k === "amelia"
        ? {
            viewings: {
              agreed: viewings.agreed,
              held: viewings.held,
              reportsFiled: viewings.reportsFiled,
            },
          }
        : {
            inspections: {
              agreed: inspections.agreed,
              held: inspections.held,
              listed,
              published,
            },
          }),
      dealsWon: wonS,
      tasks,
      inbox: report
        ? {
            waiting: report.waiting,
            waitingOverdue: report.waitingOverdue,
            overdueFollowups: report.overdueFollowups,
            openPromises: report.openPromises,
            untouchedDrafts: report.activity.untouched,
          }
        : null,
    });
  }
  return out;
}

// ── Viewings and inspections: one visit = one event ─────────────────────────

/**
 * One visit is often recorded on several cards: the client's, and a card amoCRM opened for the villa's
 * owner or staff when the broker wrote to them to book it (18.09: one viewing of R-YUD-042 sat on three
 * cards). Slots within two hours of each other on the same villa (or with the villa unknown) are one
 * visit. A viewing whose report says it did not happen is not a viewing held.
 */
type Slot = { lead: string; code: string | null; at: number; agreedAt: number | null };
function clusterVisits(slots: Slot[]): Slot[] {
  const sorted = [...slots].sort((a, b) => a.at - b.at);
  const out: Slot[][] = [];
  for (const s of sorted) {
    const hit = out.find((c) =>
      c.some((x) => Math.abs(x.at - s.at) <= 2 * 3600_000 && (!x.code || !s.code || x.code === s.code)),
    );
    if (hit) hit.push(s);
    else out.push([s]);
  }
  // The visit's own time is the earliest slot; agreed = the earliest agreement among its cards.
  return out.map((c) => ({
    lead: c[0]!.lead,
    code: c.find((x) => x.code)?.code ?? null,
    at: c[0]!.at,
    agreedAt: c.map((x) => x.agreedAt).filter((x): x is number => x != null).sort((a, b) => a - b)[0] ?? null,
  }));
}

function countByDay(times: (number | null)[], days: string[]): Series {
  const s = zero(days);
  for (const t of times) {
    if (t == null) continue;
    const d = baliDate(new Date(t));
    if (d in s) s[d]!++;
  }
  return s;
}

async function viewingEvents(days: string[]) {
  const from = startIso(addDays(days[0]!, -14));
  const to = startIso(addDays(days[days.length - 1]!, 1));
  // Visits agreed in the period may take place weeks later: read ahead for the "agreed" count.
  const ahead = startIso(addDays(days[days.length - 1]!, 60));
  const r = await pool.query(
    `SELECT vs.lead_id, vs.property_code, vs.viewing_at, vs.agreed_at, vs.status, vr.outcome
       FROM viewing_slots vs LEFT JOIN viewing_reports vr ON vr.id = vs.report_id
      WHERE vs.viewing_at >= $1 AND vs.viewing_at < $2 AND vs.status IN ('scheduled', 'reported')`,
    [from, ahead],
  );
  const rows = r.rows as { lead_id: string; property_code: string | null; viewing_at: string; agreed_at: string | null; outcome: string | null }[];
  const notHeld = new Set(["cancelled", "no_show", "rescheduled"]);
  const slots = rows.filter((x) => !notHeld.has(String(x.outcome ?? ""))).map((x) => ({
    lead: String(x.lead_id),
    code: x.property_code || null,
    at: new Date(x.viewing_at).getTime(),
    agreedAt: x.agreed_at ? new Date(x.agreed_at).getTime() : null,
  }));
  const now = Date.now();
  const visits = clusterVisits(slots);
  const filed = await pool.query(
    `SELECT filed_at FROM viewing_reports WHERE status = 'filed' AND filed_at >= $1 AND filed_at < $2
        AND coalesce(outcome, '') NOT IN ('cancelled', 'no_show', 'rescheduled')`,
    [startIso(days[0]!), to],
  );
  return {
    agreed: countByDay(visits.map((v) => v.agreedAt), days),
    held: countByDay(visits.filter((v) => v.at <= now).map((v) => v.at), days),
    reportsFiled: countByDay((filed.rows as { filed_at: string }[]).map((x) => new Date(x.filed_at).getTime()), days),
  };
}

async function inspectionEvents(days: string[]) {
  const from = startIso(addDays(days[0]!, -14));
  const to = startIso(addDays(days[days.length - 1]!, 1));
  const ahead = startIso(addDays(days[days.length - 1]!, 60));
  const r = await pool.query(
    `SELECT lead_id, visit_at, agreed_at FROM listing_inspection_slots
      WHERE visit_at >= $1 AND visit_at < $2 AND status IN ('scheduled', 'rescheduled') AND superseded_at IS NULL`,
    [from, ahead],
  );
  // Duplicate cards of one villa (Umbala 23305115 / 23541159) share the slot: same time = one visit.
  const slots = (r.rows as { lead_id: string; visit_at: string; agreed_at: string | null }[]).map((x) => ({
    lead: String(x.lead_id),
    code: String(x.lead_id),
    at: new Date(x.visit_at).getTime(),
    agreedAt: x.agreed_at ? new Date(x.agreed_at).getTime() : null,
  }));
  const sorted = [...slots].sort((a, b) => a.at - b.at);
  const visits: Slot[] = [];
  for (const s of sorted) if (!visits.some((v) => Math.abs(v.at - s.at) <= 30 * 60_000)) visits.push(s);
  return {
    agreed: countByDay(visits.map((v) => v.agreedAt), days),
    // Owner, 19.09: a visit scheduled and not cancelled counts as held once its time has passed.
    held: countByDay(visits.filter((v) => v.at <= Date.now()).map((v) => v.at), days),
  };
}

// ── Whole page ───────────────────────────────────────────────────────────────

async function weekToDate(day: string) {
  const ws = weekStartOf(day);
  const days = dayRange(ws, day);
  const from = startIso(ws);
  const to = startIso(addDays(day, 1));
  const v = await viewingEvents(days);
  const won = await amoWonDeals(ws, day).catch((): WonDeal[] => []);
  const insp = await inspectionEvents(days);
  let listed = 0;
  let published = 0;
  try {
    const enc = encodeURIComponent;
    const [props, log] = await Promise.all([
      siteGet<{ id: string }[]>(`properties?select=id&id=like.R-YUD*&is_draft=eq.false&created_at=gte.${enc(from)}&created_at=lt.${enc(to)}`),
      siteGet<{ property_id: string; pre_listed_old: boolean | null; pre_listed_new: boolean | null }[]>(
        `listing_status_log?select=property_id,pre_listed_old,pre_listed_new&changed_at=gte.${enc(from)}&changed_at=lt.${enc(to)}`,
      ),
    ]);
    published = props.length;
    listed = new Set(log.filter((e) => e.pre_listed_old === true && e.pre_listed_new === false).map((e) => e.property_id)).size;
  } catch {
    /* shown as 0 with the site note */
  }
  return {
    weekStart: ws,
    daysIn: days.length,
    amelia: {
      viewings: Object.values(v.held).reduce((a, n) => a + n, 0),
      viewingsTarget: WEEKLY_TARGETS.amelia.viewings,
      deals: won.filter((w) => w.responsible_user_id === KPI_BROKERS[0].amoId).length,
      dealsTarget: WEEKLY_TARGETS.amelia.deals,
    },
    yudi: {
      published,
      publishedTarget: WEEKLY_TARGETS.yudi.prelisted,
      inspections: Object.values(insp.held).reduce((a, n) => a + n, 0),
      listed,
      listedTarget: WEEKLY_TARGETS.yudi.listed,
    },
  };
}

export async function buildKpi(to: string, span = 7) {
  const from = addDays(to, -(Math.max(1, Math.min(31, span)) - 1));
  const days = dayRange(from, to);
  const [t, a, b, w] = await Promise.all([traffic(days), autopilot(days), brokers(days), weekToDate(to)]);
  return {
    generatedAt: new Date().toISOString(),
    today: baliDate(),
    days,
    traffic: t,
    autopilot: a,
    brokers: b,
    week: w,
    channelLabels: CHANNEL_LABEL,
    paidChannels: PAID_CHANNELS,
  };
}

// ── Meta pull (Make webhook) ─────────────────────────────────────────────────

/** Ad accounts the Make scenario has a branch for (it cannot take an account from the request). */
const META_ACCOUNTS = ["act_778356744500892", "act_553520974005703"];
const PULL_EVERY_MS = 4 * 3600_000;

export async function pullMetaSpend(): Promise<{ account: string; rows: number; error?: string }[]> {
  const r = await pool.query(`SELECT value FROM broker_settings WHERE key = 'kpi_meta_webhook_url'`);
  const url = (r.rows[0] as { value?: string } | undefined)?.value;
  if (!url) return [{ account: "*", rows: 0, error: "kpi_meta_webhook_url not set" }];
  const until = baliDate();
  const since = addDays(until, -8);
  const out: { account: string; rows: number; error?: string }[] = [];
  for (const account of META_ACCOUNTS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account, since, until }),
        signal: AbortSignal.timeout(120_000),
      });
      const text = await res.text();
      let body: { ok?: boolean; rows?: AdSpendRow[] } | null = null;
      try {
        body = JSON.parse(text);
      } catch {
        /* "Accepted" = the scenario is off */
      }
      if (!res.ok || !body?.ok) {
        out.push({ account, rows: 0, error: `HTTP ${res.status} ${text.slice(0, 80)}` });
        continue;
      }
      out.push({ account, rows: await ingestAdSpend(body.rows ?? []) });
    } catch (err) {
      out.push({ account, rows: 0, error: String(err).slice(0, 120) });
    }
  }
  return out;
}

let pullTimer: NodeJS.Timeout | null = null;
export function startMetaSpendPull(): void {
  if (pullTimer) return;
  const run = () =>
    pullMetaSpend()
      .then((r) => logger.info({ result: r }, "kpi: Meta spend pulled"))
      .catch((err) => logger.warn({ err }, "kpi: Meta spend pull failed"));
  setTimeout(run, 90_000);
  pullTimer = setInterval(run, PULL_EVERY_MS);
}
