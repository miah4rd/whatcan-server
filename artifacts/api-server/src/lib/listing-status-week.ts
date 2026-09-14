/**
 * The listing agent's week, counted from the website's Pre-listed / Listed switch (owner,
 * 2026-09-14). The switch is the inspection result; `listing-status-pass.ts` turns it into a live
 * card. This file holds what the report and the read endpoint need, and nothing that sends
 * anything — so the daily report can import it without pulling the push machinery in.
 *
 * Numbers:
 * - listed: distinct listings switched Pre-listed → Listed this Monday–Sunday Bali week, from the
 *   site's `listing_status_weekly` view over `listing_status_log` (a listing flapped back and forth
 *   counts once);
 * - cardsReachedLive: distinct Rental Listings cards that arrived in live, from amoCRM's own event
 *   log — by anyone, including this pass;
 * - needsAttention: switches the pass did not turn into a live card (parked card, no card, two
 *   candidate cards, switched back).
 */
import { amoFetch } from "./amo-client";

/** The listing agent: inspects villas, owns the switch, hears about switches that did not move a card. */
export const LISTING_AGENT_BROKER = "yudi";
/**
 * Owner, 14.09.2026: Yudi's inspections target — Pre-listed → Listed switches per Monday–Sunday week,
 * Bali time, from the week of 14–20.09.2026. The only place the number lives.
 */
export const WEEKLY_LISTED_TARGET = 10;

export const LISTINGS_PIPELINE_ID = 11180334;
export const LISTING_STAGE = {
  INITIAL_CONTACT: 87738346,
  TAKEN_TO_WORK: 87795530,
  QUALIFIED: 87763162,
  /** "Details" until 14.09.2026, then "Details ased" (owner's spelling): we asked for the listing details. */
  DETAILS_ASKED: 87763166,
  /** "agreement" → "Inspection. done" (09.09) → "Inspection sceduled" (14.09): a visit is agreed. */
  INSPECTION_SCHEDULED: 87763170,
  LIVE: 87763174,
  WEEKLY_CHECK_SENT: 87763178,
  AVAILABILITY_RECEIVED: 88109158,
  LONG_TERM: 88322310,
  CO_BROKE: 88322314,
  WON: 142,
  LOST: 143,
} as const;
export const LISTING_STAGE_NAME: Record<number, string> = {
  [LISTING_STAGE.INITIAL_CONTACT]: "Initial Contact",
  [LISTING_STAGE.TAKEN_TO_WORK]: "TAKEN TO WORK",
  [LISTING_STAGE.QUALIFIED]: "QUALIFIED (Pre-listed)",
  // Fallback labels only — code reads amoCRM's live names where it can (the owner renames stages).
  [LISTING_STAGE.DETAILS_ASKED]: "Details ased",
  [LISTING_STAGE.INSPECTION_SCHEDULED]: "Inspection sceduled",
  [LISTING_STAGE.LIVE]: "live",
  [LISTING_STAGE.WEEKLY_CHECK_SENT]: "Weekly Check Sent",
  [LISTING_STAGE.AVAILABILITY_RECEIVED]: "Update Availability Received",
  [LISTING_STAGE.LONG_TERM]: "long term",
  [LISTING_STAGE.CO_BROKE]: "co-broke Agents",
  [LISTING_STAGE.WON]: "won",
  [LISTING_STAGE.LOST]: "lost",
};

export type Decision =
  | "moved_to_live"
  | "already_live"
  | "not_moved_parked"
  | "not_moved_no_card"
  | "not_moved_ambiguous"
  | "not_moved_other_stage"
  | "back_to_prelisted"
  | "skipped";

/** The decisions a person has to look at; the report lists them. */
export const ATTENTION_DECISIONS: Decision[] = [
  "not_moved_parked",
  "not_moved_no_card",
  "not_moved_ambiguous",
  "not_moved_other_stage",
  "back_to_prelisted",
];

// ── Site database (service key: the three listing-status tables are read-only to browsers) ──

function siteDb(): { url: string; key: string } {
  const url = process.env["SUPABASE_URL"] ?? "";
  const key = process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? "";
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
  return { url, key };
}

export async function siteGet<T>(path: string): Promise<T> {
  const { url, key } = siteDb();
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`site db GET ${path.split("?")[0]} → ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export async function siteInsert(table: string, rows: unknown[]): Promise<void> {
  const { url, key } = siteDb();
  const res = await fetch(`${url}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "resolution=ignore-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`site db insert ${table} → ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
}

// ── Weeks ─────────────────────────────────────────────────────────────────────

/** Monday (YYYY-MM-DD) of the Bali week that contains `at`. Bali is UTC+8 all year. */
export function baliWeekStart(at = new Date()): string {
  const bali = new Date(at.getTime() + 8 * 3600 * 1000);
  const back = (bali.getUTCDay() + 6) % 7;
  return new Date(bali.getTime() - back * 86400000).toISOString().slice(0, 10);
}

const liveCache = new Map<string, { at: number; value: { count: number; leadIds: number[] } }>();

/**
 * Throwaway cards that really went through live for a test and must not count as villas:
 * 23561499 "TEST listed-switch check" (14.09.2026, closed lost the same minute).
 */
const TEST_LEADS = new Set<number>([23561499]);

/** Distinct Rental Listings cards that ARRIVED in live in [from, to), from amoCRM's own event log. */
export async function cardsReachedLive(fromSec: number, toSec: number): Promise<{ count: number; leadIds: number[] }> {
  const key = `${fromSec}-${toSec}`;
  const hit = liveCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
  const ids = new Set<number>();
  for (let page = 1; page <= 20; page++) {
    const d = await amoFetch<{ _embedded?: { events?: { entity_id: number }[] } }>(
      `/api/v4/events?filter[type]=lead_status_changed&filter[created_at][from]=${fromSec}&filter[created_at][to]=${toSec - 1}` +
        `&filter[value_after][leads_statuses][0][pipeline_id]=${LISTINGS_PIPELINE_ID}` +
        `&filter[value_after][leads_statuses][0][status_id]=${LISTING_STAGE.LIVE}&limit=100&page=${page}`,
    );
    const events = d?._embedded?.events ?? [];
    for (const e of events) if (!TEST_LEADS.has(e.entity_id)) ids.add(e.entity_id);
    if (events.length < 100) break;
  }
  const value = { count: ids.size, leadIds: [...ids] };
  liveCache.set(key, { at: Date.now(), value });
  return value;
}

export type ListingWeek = {
  weekStart: string;
  weekEnd: string;
  /** Distinct listings switched Pre-listed → Listed on the site this week. */
  listed: number;
  listedIds: string[];
  target: number;
  /** Distinct Rental Listings cards that arrived in live (amoCRM events), by anyone. */
  cardsReachedLive: number;
  switchedBack: number;
  /** Switches the pass could not turn into a live card — someone has to look. */
  needsAttention: { propertyId: string; decision: string; detail: string; decidedAt: string }[];
};

export async function listingWeek(weekStart = baliWeekStart()): Promise<ListingWeek> {
  const fromSec = Date.parse(`${weekStart}T00:00:00+08:00`) / 1000;
  const toSec = fromSec + 7 * 86400;
  const weekEnd = new Date((toSec - 86400) * 1000 + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const enc = encodeURIComponent;
  const [weekly, live, attention] = await Promise.all([
    siteGet<{ prelisted_to_listed: number; listed_to_prelisted: number; listed_ids: string[] | null }[]>(
      `listing_status_weekly?week_start_bali=eq.${weekStart}`,
    ),
    cardsReachedLive(fromSec, toSec),
    siteGet<{ property_id: string; decision: string; detail: string | null; decided_at: string }[]>(
      `listing_status_actions?select=property_id,decision,detail,decided_at` +
        `&decision=in.(${ATTENTION_DECISIONS.join(",")})` +
        `&decided_at=gte.${enc(new Date(fromSec * 1000).toISOString())}&decided_at=lt.${enc(new Date(toSec * 1000).toISOString())}` +
        `&order=decided_at.desc`,
    ),
  ]);
  const w = weekly[0];
  return {
    weekStart,
    weekEnd,
    listed: Number(w?.prelisted_to_listed ?? 0),
    listedIds: w?.listed_ids ?? [],
    target: WEEKLY_LISTED_TARGET,
    cardsReachedLive: live.count,
    switchedBack: Number(w?.listed_to_prelisted ?? 0),
    needsAttention: attention.map((a) => ({
      propertyId: a.property_id,
      decision: a.decision,
      detail: a.detail ?? "",
      decidedAt: a.decided_at,
    })),
  };
}
