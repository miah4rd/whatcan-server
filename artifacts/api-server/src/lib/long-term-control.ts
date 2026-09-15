/**
 * The standing check of the long term regulation (15.09.2026, §9).
 *
 * Read live from amoCRM, not from leads_sync: on 15.09 amoCRM held 33 cards on the stage and
 * leads_sync 32. Every row it returns is a defect of the bot's behaviour, not a property of the villa;
 * the expected answer is four empty lists:
 *   - no price in "Listing price incl commission" (968831);
 *   - no date in "Listing: available from" (968835) — a phrase ("next year") is not a date;
 *   - no open task due in the future;
 *   - untouched for more than 30 days.
 */
import { amoFetch } from "./amo-client";
import { LISTINGS_PIPELINE_ID, LISTING_STAGE } from "./listing-status-week";
import { dateFromAvailableLine } from "./listing-card-fields";

const PRICE_FIELD = 968831;
const AVAILABLE_FROM_FIELD = 968835;
const STALE_DAYS = 30;

type AmoLead = {
  id: number;
  name: string;
  updated_at: number;
  custom_fields_values?: Array<{ field_id: number; values?: Array<{ value?: unknown }> }> | null;
};
type AmoTask = { entity_id: number; complete_till: number };
export type ControlRow = { leadId: number; name: string; detail: string };
export type LongTermControl = {
  total: number;
  noPrice: ControlRow[];
  noDate: ControlRow[];
  noFutureTask: ControlRow[];
  stale: ControlRow[];
};

export async function longTermControl(): Promise<LongTermControl> {
  const leads: AmoLead[] = [];
  for (let page = 1; page <= 10; page++) {
    const d = await amoFetch<{ _embedded?: { leads?: AmoLead[] } }>(
      `/api/v4/leads?filter[statuses][0][pipeline_id]=${LISTINGS_PIPELINE_ID}&filter[statuses][0][status_id]=${LISTING_STAGE.LONG_TERM}&limit=250&page=${page}`,
    );
    // amoCRM answers an empty list with 204, which reads as null exactly like a failure. An empty
    // stage is a fine answer, a failure is not a clean one: tell them apart before reporting.
    if (d === null && page === 1) {
      const alive = await amoFetch<{ id?: number }>(`/api/v4/leads/pipelines/${LISTINGS_PIPELINE_ID}`);
      if (!alive?.id) throw new Error("amoCRM did not answer: long term control not read");
    }
    const batch = d?._embedded?.leads ?? [];
    leads.push(...batch);
    if (batch.length < 250) break;
  }

  const nowSec = Date.now() / 1000;
  const withTask = new Set<number>();
  for (let i = 0; i < leads.length; i += 40) {
    const q = leads.slice(i, i + 40).map((l) => `filter[entity_id][]=${l.id}`).join("&");
    const d = await amoFetch<{ _embedded?: { tasks?: AmoTask[] } }>(`/api/v4/tasks?filter[entity_type]=leads&filter[is_completed]=0&${q}&limit=250`);
    for (const t of d?._embedded?.tasks ?? []) if (t.complete_till > nowSec) withTask.add(t.entity_id);
  }

  const field = (l: AmoLead, id: number): string =>
    String(l.custom_fields_values?.find((c) => c.field_id === id)?.values?.[0]?.value ?? "").trim();
  const row = (l: AmoLead, detail: string): ControlRow => ({ leadId: l.id, name: l.name, detail });
  const out: LongTermControl = { total: leads.length, noPrice: [], noDate: [], noFutureTask: [], stale: [] };
  for (const l of leads) {
    if (!field(l, PRICE_FIELD)) out.noPrice.push(row(l, "price field empty"));
    const avail = field(l, AVAILABLE_FROM_FIELD);
    if (!dateFromAvailableLine(avail) && !/^\d{4}-\d{2}-\d{2}$/.test(avail)) {
      out.noDate.push(row(l, avail ? `not a date: "${avail.slice(0, 60)}"` : "available-from empty"));
    }
    if (!withTask.has(l.id)) out.noFutureTask.push(row(l, "no open task due in the future"));
    const days = Math.floor((nowSec - l.updated_at) / 86_400);
    if (days > STALE_DAYS) out.stale.push(row(l, `untouched ${days} days`));
  }
  return out;
}
