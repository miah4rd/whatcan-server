/**
 * Unicorn OS — money (owner, 26.09.2026): a manager's money dashboard and the partners' P&L, in IDR
 * with USD in brackets.
 *   · Revenue: won deals from amoCRM (value as amoCRM holds it) until the move; after it, commissions
 *     entered in the OS (os_deal_commissions), which win for any deal they cover.
 *   · Costs: Meta ad spend (kpi_ad_spend), AI (ai_usage, USD), staff and expenses entered here from
 *     scratch (monthly amounts spread over the days of the period).
 *   · Nothing is guessed: a figure with no source shows as not set, never as a made-up number.
 * Who sees what: the dashboard admin, manager and partner; the P&L and staff costs admin and partner.
 */
import { pool } from "@workspace/db";
import { amoFetch } from "../amo-client";
import { amoWonDeals, leadsBySource, ensureKpiTables, baliDate, RENTAL_PIPELINE_ID, SALES_PIPELINE_ID } from "../kpi-dashboard";
import { audit, type OsUser } from "./auth";
import { logger } from "../logger";

let ready: Promise<void> | null = null;
export function ensureMoneyTables(): Promise<void> {
  ready ??= pool
    .query(
      `CREATE TABLE IF NOT EXISTS os_money_settings (key text PRIMARY KEY, value jsonb NOT NULL, updated_by text, updated_at timestamptz NOT NULL DEFAULT now());
       CREATE TABLE IF NOT EXISTS os_staff (
         id serial PRIMARY KEY, name text NOT NULL, role text, monthly_idr bigint NOT NULL DEFAULT 0,
         start_date date NOT NULL, end_date date, note text, created_at timestamptz NOT NULL DEFAULT now());
       CREATE TABLE IF NOT EXISTS os_expenses (
         id serial PRIMARY KEY, name text NOT NULL, category text NOT NULL DEFAULT 'Other', amount_idr bigint NOT NULL,
         recurring boolean NOT NULL DEFAULT false, start_date date NOT NULL, end_date date, note text,
         created_at timestamptz NOT NULL DEFAULT now());
       CREATE TABLE IF NOT EXISTS os_deal_commissions (
         id serial PRIMARY KEY, amo_lead_id bigint, funnel text NOT NULL, title text NOT NULL, broker text,
         deal_value_idr bigint, commission_idr bigint NOT NULL, broker_idr bigint NOT NULL DEFAULT 0,
         status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','earned','received','fell_through')),
         closed_on date NOT NULL, received_on date, note text, created_by text, created_at timestamptz NOT NULL DEFAULT now());`,
    )
    .then(() => undefined);
  ready.catch(() => (ready = null));
  return ready;
}

// ── settings and the exchange rate ───────────────────────────────────────────

export const SETTING_KEYS = ["monthly_gci_target_idr", "fx_manual_idr_per_usd", "broker_share_pct"] as const;
type SettingKey = (typeof SETTING_KEYS)[number];

async function settings(): Promise<Record<string, number | null>> {
  await ensureMoneyTables();
  const r = await pool.query(`SELECT key, value FROM os_money_settings`);
  const out: Record<string, number | null> = {};
  for (const k of SETTING_KEYS) out[k] = null;
  for (const row of r.rows) out[row.key] = row.value == null ? null : Number(row.value);
  return out;
}

export async function saveSettings(user: OsUser, body: Record<string, unknown>) {
  await ensureMoneyTables();
  for (const k of SETTING_KEYS) {
    if (!(k in body)) continue;
    const raw = body[k];
    const v = raw === "" || raw == null ? null : Number(raw);
    if (v != null && (!Number.isFinite(v) || v < 0)) throw new Error(`${k}: not a number`);
    await pool.query(
      `INSERT INTO os_money_settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [k as SettingKey, JSON.stringify(v), user.name],
    );
  }
  await audit(user, "money.settings", null, body);
  return { ok: true };
}

let fx: { rate: number; at: number; source: string } | null = null;
/** IDR per USD: the owner's own rate if set, else the day's market rate (open.er-api.com), else none. */
async function usdRate(manual: number | null): Promise<{ rate: number | null; source: string }> {
  if (manual) return { rate: manual, source: "set in Money settings" };
  if (!fx || Date.now() - fx.at > 6 * 3600_000) {
    try {
      const r = await fetch("https://open.er-api.com/v6/latest/USD", { signal: AbortSignal.timeout(5000) });
      const d = (await r.json()) as { rates?: Record<string, number>; time_last_update_utc?: string };
      if (d.rates?.["IDR"]) fx = { rate: d.rates["IDR"], at: Date.now(), source: `market rate ${d.time_last_update_utc?.slice(5, 16) ?? ""}`.trim() };
    } catch (err) {
      logger.warn({ err }, "money: exchange rate unavailable");
    }
  }
  return fx ? { rate: Math.round(fx.rate), source: fx.source } : { rate: null, source: "no rate" };
}

// ── periods ──────────────────────────────────────────────────────────────────

const DAY = 86400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysIn = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1;
const monthDays = (d: string) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7), 0)).getUTCDate();

/** `from`..`to` inclusive; default this month so far. The previous period is the same length right before. */
export function moneyPeriod(q: { from?: unknown; to?: unknown }) {
  const today = baliDate();
  const ok = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
  let from = ok(q.from) ? String(q.from) : `${today.slice(0, 8)}01`;
  let to = ok(q.to) ? String(q.to) : today;
  if (to < from) [from, to] = [to, from];
  if (daysIn(from, to) > 400) from = addDays(to, -399);
  const n = daysIn(from, to);
  return { from, to, days: n, prev: { from: addDays(from, -n), to: addDays(from, -1) } };
}

/** A monthly amount over [from, to]: each day carries 1/(days in its month); `start`..`end` bound it. */
function spread(monthly: number, start: string, end: string | null, from: string, to: string): number {
  const a = start > from ? start : from;
  const b = end && end < to ? end : to;
  let sum = 0;
  for (let d = a; d <= b; d = addDays(d, 1)) sum += monthly / monthDays(d);
  return sum;
}

// ── sources ──────────────────────────────────────────────────────────────────

let amoUsers: { at: number; names: Map<number, string> } | null = null;
async function amoUserNames(): Promise<Map<number, string>> {
  if (amoUsers && Date.now() - amoUsers.at < 6 * 3600_000) return amoUsers.names;
  const d = await amoFetch<{ _embedded?: { users?: Array<{ id: number; name: string }> } }>(`/api/v4/users?limit=250`).catch(() => null);
  const names = new Map((d?._embedded?.users ?? []).map((u) => [u.id, u.name] as [number, string]));
  amoUsers = { at: Date.now(), names };
  return names;
}

const funnelOf = (pipelineId: number) => (pipelineId === SALES_PIPELINE_ID ? "Sales" : pipelineId === RENTAL_PIPELINE_ID ? "Rental" : "Other");

async function revenue(from: string, to: string) {
  await ensureMoneyTables();
  const [won, entered, users] = await Promise.all([
    amoWonDeals(from, to),
    pool.query(`SELECT * FROM os_deal_commissions WHERE closed_on BETWEEN $1 AND $2`, [from, to]),
    amoUserNames(),
  ]);
  const covered = new Set(entered.rows.map((r) => Number(r.amo_lead_id)).filter(Boolean));
  const deals = [
    ...won
      .filter((w) => !covered.has(w.id))
      .map((w) => ({
        source: "amoCRM" as const,
        funnel: funnelOf(w.pipeline_id),
        broker: users.get(w.responsible_user_id) ?? `amoCRM user ${w.responsible_user_id}`,
        value: Number(w.price) || 0,
        commission: null as number | null,
        brokerCut: null as number | null,
        status: "won",
      })),
    ...entered.rows.map((r) => ({
      source: "OS" as const,
      funnel: String(r.funnel),
      broker: r.broker ? String(r.broker) : "—",
      value: r.deal_value_idr == null ? null : Number(r.deal_value_idr),
      commission: Number(r.commission_idr),
      brokerCut: Number(r.broker_idr),
      status: String(r.status),
    })),
  ];
  return deals;
}

async function adSpend(from: string, to: string): Promise<number> {
  await ensureKpiTables();
  const r = await pool.query(`SELECT coalesce(sum(spend), 0)::float8 AS s FROM kpi_ad_spend WHERE day BETWEEN $1 AND $2 AND upper(coalesce(currency,'IDR')) = 'IDR'`, [from, to]);
  return Number(r.rows[0]?.s ?? 0);
}
async function aiUsd(from: string, to: string): Promise<number> {
  const r = await pool.query(
    `SELECT coalesce(sum(cost_usd), 0)::float8 AS s FROM ai_usage WHERE (created_at AT TIME ZONE 'Asia/Makassar')::date BETWEEN $1 AND $2`,
    [from, to],
  );
  return Number(r.rows[0]?.s ?? 0);
}
async function paidLeads(from: string, to: string): Promise<{ all: number; paid: number }> {
  const leads = await leadsBySource(from, to).catch(() => [] as Awaited<ReturnType<typeof leadsBySource>>);
  const clients = leads.filter((l) => l.segment !== "owners");
  return { all: clients.length, paid: clients.filter((l) => l.channel.startsWith("paid_")).length };
}

// ── the dashboard ────────────────────────────────────────────────────────────

async function dashboardFor(from: string, to: string) {
  const [deals, spend, leads] = await Promise.all([revenue(from, to), adSpend(from, to), paidLeads(from, to)]);
  const sum = (xs: Array<number | null>) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);
  const live = deals.filter((d) => d.status !== "fell_through");
  const gciEntered = sum(live.filter((d) => d.source === "OS").map((d) => d.commission));
  const byBroker = new Map<string, { deals: number; value: number; commission: number }>();
  for (const d of live) {
    const b = byBroker.get(d.broker) ?? { deals: 0, value: 0, commission: 0 };
    b.deals++;
    b.value += d.value ?? 0;
    b.commission += d.commission ?? 0;
    byBroker.set(d.broker, b);
  }
  const byFunnel = new Map<string, { deals: number; value: number }>();
  for (const d of live) {
    const f = byFunnel.get(d.funnel) ?? { deals: 0, value: 0 };
    f.deals++;
    f.value += d.value ?? 0;
    byFunnel.set(d.funnel, f);
  }
  return {
    wonDeals: live.length,
    wonValue: sum(live.map((d) => d.value)),
    fromAmo: live.filter((d) => d.source === "amoCRM").length,
    amoValue: sum(live.filter((d) => d.source === "amoCRM").map((d) => d.value)),
    gciEntered,
    received: sum(live.filter((d) => d.status === "received").map((d) => d.commission)),
    pending: sum(live.filter((d) => d.status === "pending" || d.status === "earned").map((d) => d.commission)),
    fellThrough: deals.filter((d) => d.status === "fell_through").length,
    avgDealValue: live.length ? sum(live.map((d) => d.value)) / live.length : null,
    adSpend: spend,
    leads: leads.all,
    paidLeads: leads.paid,
    cpl: leads.paid ? spend / leads.paid : null,
    costPerDeal: live.length ? spend / live.length : null,
    byBroker: [...byBroker].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.value - a.value),
    byFunnel: [...byFunnel].map(([name, v]) => ({ name, ...v })),
  };
}

const memo = new Map<string, { at: number; value: Promise<unknown> }>();
function remember<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.value as Promise<T>;
  const value = fn();
  memo.set(key, { at: Date.now(), value });
  value.catch(() => memo.delete(key));
  return value;
}
const forget = () => memo.clear();

export async function moneyDashboard(q: { from?: unknown; to?: unknown }) {
  const p = moneyPeriod(q);
  return remember(`dash:${p.from}:${p.to}`, async () => {
    const s = await settings();
    const [now, prev, rate] = await Promise.all([dashboardFor(p.from, p.to), dashboardFor(p.prev.from, p.prev.to), usdRate(s["fx_manual_idr_per_usd"] ?? null)]);
    const monthly = s["monthly_gci_target_idr"];
    const target = monthly ? spread(monthly, p.from, null, p.from, p.to) : null;
    return { period: p, fx: rate, target, now, prev };
  });
}

// ── the P&L ──────────────────────────────────────────────────────────────────

async function pnlFor(from: string, to: string, usd: number | null, brokerSharePct: number | null) {
  const [dash, ai, staff, expenses] = await Promise.all([
    dashboardFor(from, to),
    aiUsd(from, to),
    pool.query(`SELECT * FROM os_staff WHERE start_date <= $2 AND (end_date IS NULL OR end_date >= $1)`, [from, to]),
    pool.query(`SELECT * FROM os_expenses WHERE start_date <= $2 AND (recurring OR start_date >= $1) AND (end_date IS NULL OR end_date >= $1)`, [from, to]),
  ]);
  // Revenue = commissions entered in the OS; before the move amoCRM deal values stand in, marked as such.
  const gci = dash.gciEntered + dash.amoValue;
  const osBrokerCut = await pool
    .query(`SELECT coalesce(sum(broker_idr),0)::float8 AS s FROM os_deal_commissions WHERE closed_on BETWEEN $1 AND $2 AND status <> 'fell_through'`, [from, to])
    .then((r) => Number(r.rows[0].s));
  const amoPart = gci - dash.gciEntered;
  const brokerCut = osBrokerCut + (brokerSharePct != null ? (amoPart * brokerSharePct) / 100 : 0);
  const staffLines = staff.rows.map((r) => ({ name: `${r.name}${r.role ? ` · ${r.role}` : ""}`, amount: spread(Number(r.monthly_idr), iso(r.start_date), r.end_date ? iso(r.end_date) : null, from, to) }));
  const expenseLines = expenses.rows.map((r) => ({
    name: String(r.name),
    category: String(r.category),
    recurring: !!r.recurring,
    amount: r.recurring ? spread(Number(r.amount_idr), iso(r.start_date), r.end_date ? iso(r.end_date) : null, from, to) : Number(r.amount_idr),
  }));
  const byCategory = new Map<string, number>();
  for (const e of expenseLines) byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + e.amount);
  const aiIdr = usd ? ai * usd : null;
  const staffTotal = staffLines.reduce((a, b) => a + b.amount, 0);
  const expensesTotal = expenseLines.reduce((a, b) => a + b.amount, 0);
  const opex = dash.adSpend + (aiIdr ?? 0) + staffTotal + expensesTotal;
  const companyDollar = gci - brokerCut;
  const net = companyDollar - opex;
  return {
    revenue: { gci, entered: dash.gciEntered, fromAmoValue: amoPart, amoDeals: dash.fromAmo },
    costOfSales: { brokers: brokerCut, fromShare: brokerSharePct != null && amoPart > 0 },
    companyDollar,
    opex: {
      ads: dash.adSpend,
      ai: aiIdr,
      aiUsd: ai,
      staff: staffTotal,
      staffLines,
      expenses: expensesTotal,
      expenseCategories: [...byCategory].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount),
      total: opex,
    },
    net,
    margin: gci ? (net / gci) * 100 : null,
    breakEvenGci: companyDollar > 0 && gci > 0 ? opex / (companyDollar / gci) : null,
    deals: dash.wonDeals,
  };
}
const iso = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

export async function moneyPnl(q: { from?: unknown; to?: unknown }) {
  const p = moneyPeriod(q);
  return remember(`pnl:${p.from}:${p.to}`, async () => {
    const s = await settings();
    const rate = await usdRate(s["fx_manual_idr_per_usd"] ?? null);
    const share = s["broker_share_pct"] ?? null;
    const [now, prev] = await Promise.all([pnlFor(p.from, p.to, rate.rate, share), pnlFor(p.prev.from, p.prev.to, rate.rate, share)]);
    return { period: p, fx: rate, settings: s, now, prev };
  });
}

// ── entered by hand: staff, expenses, commissions ────────────────────────────

const text = (v: unknown, max = 200) => String(v ?? "").trim().slice(0, max);
const money = (v: unknown, name: string, required = true): number | null => {
  const s = String(v ?? "").replace(/[\s,._]/g, "");
  if (!s) {
    if (required) throw new Error(`${name} is required.`);
    return null;
  }
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name}: not an amount.`);
  return Math.round(n);
};
const date = (v: unknown, name: string, required = true): string | null => {
  const s = text(v, 10);
  if (!s) {
    if (required) throw new Error(`${name} is required.`);
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`${name}: use YYYY-MM-DD.`);
  return s;
};

export async function listEntries() {
  await ensureMoneyTables();
  const [staff, expenses, commissions, s] = await Promise.all([
    pool.query(`SELECT * FROM os_staff ORDER BY end_date IS NOT NULL, name`),
    pool.query(`SELECT * FROM os_expenses ORDER BY recurring DESC, start_date DESC`),
    pool.query(`SELECT * FROM os_deal_commissions ORDER BY closed_on DESC LIMIT 500`),
    settings(),
  ]);
  const rate = await usdRate(s["fx_manual_idr_per_usd"] ?? null);
  return { staff: staff.rows, expenses: expenses.rows, commissions: commissions.rows, settings: s, fx: rate };
}

type Kind = "staff" | "expenses" | "commissions";
const TABLE: Record<Kind, string> = { staff: "os_staff", expenses: "os_expenses", commissions: "os_deal_commissions" };

function rowOf(kind: Kind, b: Record<string, unknown>, user: OsUser): Record<string, unknown> {
  if (kind === "staff")
    return { name: text(b["name"]) || null, role: text(b["role"]) || null, monthly_idr: money(b["monthly_idr"], "Monthly cost"), start_date: date(b["start_date"], "Start"), end_date: date(b["end_date"], "End", false), note: text(b["note"], 500) || null };
  if (kind === "expenses")
    return { name: text(b["name"]) || null, category: text(b["category"], 60) || "Other", amount_idr: money(b["amount_idr"], "Amount"), recurring: b["recurring"] === true || b["recurring"] === "true" || b["recurring"] === "on", start_date: date(b["start_date"], "Date"), end_date: date(b["end_date"], "End", false), note: text(b["note"], 500) || null };
  const status = text(b["status"], 20) || "pending";
  if (!["pending", "earned", "received", "fell_through"].includes(status)) throw new Error("Unknown status.");
  const lead = text(b["amo_lead_id"], 20);
  return {
    amo_lead_id: lead ? Number(lead) || null : null,
    funnel: text(b["funnel"], 40) || "Rental",
    title: text(b["title"]) || null,
    broker: text(b["broker"], 80) || null,
    deal_value_idr: money(b["deal_value_idr"], "Deal value", false),
    commission_idr: money(b["commission_idr"], "Commission"),
    broker_idr: money(b["broker_idr"], "Broker's share", false) ?? 0,
    status,
    closed_on: date(b["closed_on"], "Closed on"),
    received_on: date(b["received_on"], "Received on", false),
    note: text(b["note"], 500) || null,
    created_by: user.name,
  };
}

export async function saveEntry(user: OsUser, kind: Kind, id: number | null, body: Record<string, unknown>) {
  if (!TABLE[kind]) throw new Error("Unknown list.");
  if (kind !== "commissions" && !["admin", "partner"].includes(user.role)) throw new Error("Only the owner and partners enter staff and expenses.");
  await ensureMoneyTables();
  const row = rowOf(kind, body, user);
  if (!row["name"] && kind !== "commissions") throw new Error("Name is required.");
  if (kind === "commissions" && !row["title"]) throw new Error("Deal is required.");
  if (id) delete row["created_by"];
  const cols = Object.keys(row);
  const vals = Object.values(row);
  if (id) {
    await pool.query(`UPDATE ${TABLE[kind]} SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")} WHERE id = $1`, [id, ...vals]);
  } else {
    const r = await pool.query(`INSERT INTO ${TABLE[kind]} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`, vals);
    id = Number(r.rows[0].id);
  }
  await audit(user, `money.${kind}.save`, String(id), kind === "staff" ? { name: row["name"] } : row);
  forget();
  return { ok: true, id };
}

export async function deleteEntry(user: OsUser, kind: Kind, id: number) {
  if (!TABLE[kind]) throw new Error("Unknown list.");
  if (kind !== "commissions" && !["admin", "partner"].includes(user.role)) throw new Error("Only the owner and partners change staff and expenses.");
  await ensureMoneyTables();
  await pool.query(`DELETE FROM ${TABLE[kind]} WHERE id = $1`, [id]);
  await audit(user, `money.${kind}.delete`, String(id), null);
  forget();
  return { ok: true };
}
