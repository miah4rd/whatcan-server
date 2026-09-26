/**
 * Unicorn OS — the demand and supply matrix, the owner's method of 25.09.2026 (Cowork skill
 * bali-demand-matrix, mirrored in cowork-skills/): what to look for when listing villas.
 *   1. A cell = bedrooms × area × budget band (lt30 / 30-50 / 50-80 / 80+ M IDR a month). Demand =
 *      every Rental lead of the last 14 days, closed ones too; a lead naming several of our areas
 *      counts in each. A lead missing one of the three is not placed, only counted.
 *   2. Supply = live rent listings free within 3 months, by the same cells.
 *   3. Coefficient = % of demand / % of supply (∞ with no listings): > 1 short, < 1 surplus.
 *   Plan: cells with coefficient > 1 and 3+ requests, top down by demand; gap = % demand × all
 *   listings − the cell's listings, at most 4 a cell, 20 a day in all. Plus: surplus, dead stock
 *   (listings in cells no one asks for), and the four numbers of labelling quality.
 * Fields as the method reads them: amoCRM's custom fields first (groups of synonyms), then what the
 * Copilot read from the conversation (leads_sync.req_*) where amoCRM has nothing.
 */
import { pool } from "@workspace/db";
import { baliDate, leadsCreatedWithFields, RENTAL_PIPELINE_ID } from "../kpi-dashboard";
import { listListings } from "./listings";

const F_BEDROOMS = [968489, 512421, 959041, 930557];
const F_AREA = [968491, 959039, 956457, 512215, 930561];
const F_BUDGET = [968497, 956449, 755371, 539057, 921063, 930669, 877631];
const WINDOW_DAYS = 14;
const DAILY_NORM = 20;
const CAP_PER_CELL = 4;
const NOISE = 2;

/** Our areas and their spellings (the method's normalisation). */
const AREA_ALIASES: Array<[RegExp, string]> = [
  [/batu\s*bolong|padang\s*linjong|tibubeneng|babakan|uma\s*buluh|echo\s*beach|canggu/i, "Canggu"],
  [/semer|kerobokan/i, "Kerobokan"],
  [/berawa/i, "Berawa"],
  [/munggu/i, "Munggu"],
  [/seseh/i, "Seseh"],
  [/cemagi/i, "Cemagi"],
  [/tumbak\s*bayuh/i, "Tumbak Bayuh"],
  [/padonan/i, "Padonan"],
  [/pererenan/i, "Pererenan"],
  [/umalas/i, "Umalas"],
  [/seminyak/i, "Seminyak"],
  [/kedungu/i, "Kedungu"],
  [/dalung/i, "Dalung"],
];
const NOT_OURS = /ubud|uluwatu|bukit|sanur|denpasar|tabanan|kuta|legian|jimbaran|nusa|buduk|kediri|beraban|nyanyi|mengwi|balangan|renon|panjer/i;

function areasOf(text: string): { ours: string[]; foreign: boolean } {
  const ours = new Set<string>();
  for (const part of text.split(/[,;/]|\band\b|\s-\s/i)) {
    const hit = AREA_ALIASES.find(([re]) => re.test(part));
    if (hit) ours.add(hit[1]);
  }
  return { ours: [...ours], foreign: ours.size === 0 && NOT_OURS.test(text) };
}
function bedroomsOf(text: string): number | null {
  const m = String(text).match(/\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return n >= 1 && n <= 10 ? n : null;
}
/** Budget in millions IDR a month from "45", "45jt", "45.000.000", "Rp 30-50 million". */
function budgetOf(text: string): number | null {
  const t = String(text).toLowerCase().replace(/\s+/g, " ");
  const range = t.match(/(\d+(?:[.,]\d+)?)\s*-\s*(\d+(?:[.,]\d+)?)\s*(m|mil|million|jt|juta)/);
  if (range) return Number(range[1].replace(",", "."));
  const nums = (t.match(/\d[\d.,]*/g) ?? []).map((x) => Number(x.replace(/[.,](?=\d{3}\b)/g, "").replace(",", ".")));
  const big = nums.find((x) => x >= 1_000_000);
  if (big) return big / 1_000_000;
  const k = nums.find((x) => x >= 1000 && x <= 100000);
  if (k) return k / 1000;
  const small = nums.find((x) => x >= 5 && x < 1000);
  return small ?? null;
}
const bandOf = (m: number) => (m < 30 ? "lt30" : m <= 50 ? "30-50" : m <= 80 ? "50-80" : "80+");
const BAND_LABEL: Record<string, string> = { lt30: "< 30M", "30-50": "30–50M", "50-80": "50–80M", "80+": "80M+" };

let memo: { at: number; value: Promise<unknown> } | null = null;
export function demandMatrix() {
  if (memo && Date.now() - memo.at < 10 * 60_000) return memo.value as ReturnType<typeof build>;
  const value = build();
  memo = { at: Date.now(), value };
  value.catch(() => (memo = null));
  return value;
}

async function build() {
  const to = baliDate();
  const d = new Date(`${to}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (WINDOW_DAYS - 1));
  const from = d.toISOString().slice(0, 10);
  const [amo, req, listings] = await Promise.all([
    leadsCreatedWithFields(from, to),
    pool.query(`SELECT lead_id, req_bedrooms, req_areas, req_budget_idr_monthly FROM leads_sync WHERE lower(coalesce(pipeline,'')) = 'rental' AND amo_created_at >= $1::date - interval '1 day'`, [from]),
    listListings({ type: "rent" }),
  ]);
  const reqBy = new Map(req.rows.map((r) => [String(r.lead_id), r]));

  // ── demand
  const demand = new Map<string, number>();
  let leads = 0;
  let placed = 0;
  let incomplete = 0;
  let foreign = 0;
  let belowFloor = 0;
  for (const l of amo.filter((x) => x.pipelineId === RENTAL_PIPELINE_ID)) {
    leads++;
    const r = reqBy.get(l.id);
    const beds = bedroomsOf(l.field(F_BEDROOMS)) ?? (r?.req_bedrooms ? Number(r.req_bedrooms) : null);
    const areaText = l.field(F_AREA) || String(r?.req_areas ?? "");
    const budgetText = l.field(F_BUDGET);
    const budget = budgetText ? budgetOf(budgetText) : r?.req_budget_idr_monthly ? Number(r.req_budget_idr_monthly) / 1_000_000 : null;
    const areas = areasOf(areaText);
    if (areas.foreign) {
      foreign++;
      continue;
    }
    if (!beds || !budget || !areas.ours.length) {
      incomplete++;
      continue;
    }
    if (budget < 30) belowFloor++;
    placed++;
    for (const a of areas.ours) {
      const k = `${Math.min(beds, 5)}|${a}|${bandOf(budget)}`;
      demand.set(k, (demand.get(k) ?? 0) + 1);
    }
  }
  const placements = [...demand.values()].reduce((a, b) => a + b, 0);

  // ── supply: live rent listings free within 3 months
  const soon = new Date(Date.now() + 92 * 86400_000).toISOString().slice(0, 10);
  const supply = new Map<string, number>();
  let live = 0;
  for (const v of listings as Array<Record<string, unknown>>) {
    const free = (v["freeFrom"] as string | null) ?? null;
    if (free && free > soon) continue;
    const area = areasOf(String(v["area"] ?? "")).ours[0];
    const beds = Number(v["bedrooms"]);
    const price = Number(v["monthly_price_idr"]) / 1_000_000;
    if (!area || !beds || !price) continue;
    live++;
    const k = `${Math.min(beds, 5)}|${area}|${bandOf(price)}`;
    supply.set(k, (supply.get(k) ?? 0) + 1);
  }

  // ── cells, ranked by demand; coefficient; plan top down among short cells
  const keys = new Set([...demand.keys(), ...supply.keys()]);
  const cells = [...keys].map((k) => {
    const [beds, area, band] = k.split("|");
    const dn = demand.get(k) ?? 0;
    const sn = supply.get(k) ?? 0;
    const dPct = placements ? (dn / placements) * 100 : 0;
    const sPct = live ? (sn / live) * 100 : 0;
    const coeff = dn === 0 ? 0 : sn === 0 ? null : dPct / sPct; // null = ∞
    return { cell: `${beds === "5" ? "5+" : beds}BR ${area} ${BAND_LABEL[band]}`, bedrooms: Number(beds), area, band, demand: dn, demandPct: Math.round(dPct * 10) / 10, listings: sn, supplyPct: Math.round(sPct * 10) / 10, coeff: coeff == null ? null : Math.round(coeff * 100) / 100, plan: 0 as number | string };
  });
  cells.sort((a, b) => b.demand - a.demand || (a.coeff ?? 1e9) - (b.coeff ?? 1e9));
  let left = DAILY_NORM;
  for (const c of cells) {
    const short = c.coeff == null || c.coeff > 1;
    if (!short || c.demand <= NOISE || c.bedrooms >= 5 || c.band === "lt30" || left <= 0) continue;
    const gap = Math.round((c.demandPct / 100) * live - c.listings);
    const n = Math.max(1, Math.min(CAP_PER_CELL, gap, left));
    c.plan = n;
    left -= n;
  }
  const deadCells = cells.filter((c) => c.demand === 0 && c.listings > 0);
  const dead = deadCells.reduce((a, c) => a + c.listings, 0);
  return {
    window: { from, to, days: WINDOW_DAYS },
    leads,
    placements,
    live,
    planned: DAILY_NORM - left,
    cells: cells.filter((c) => c.demand > 0).slice(0, 25),
    surplus: cells.filter((c) => c.demand > 0 && c.coeff != null && c.coeff < 1).map((c) => c.cell),
    deadStock: { listings: dead, share: live ? Math.round((dead / live) * 100) : 0, cells: deadCells.sort((a, b) => b.listings - a.listings).slice(0, 8).map((c) => `${c.cell} (${c.listings})`) },
    quality: { leads, placed, incomplete, foreign, belowFloor },
  };
}
