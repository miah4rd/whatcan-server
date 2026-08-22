/**
 * Writes the client's distilled request back onto the amoCRM lead card.
 *
 * Why this exists: amoCRM already IS a table of leads, and the brokers already
 * live in it — what it could not do was show what a client actually asked for,
 * because those columns are only filled by the Meta ad form. A client who wrote
 * on WhatsApp leaves every field blank, and nobody fills them in by hand. So the
 * list view, which should have been the spreadsheet the brokers wanted, showed
 * empty columns for exactly the conversations that mattered most.
 *
 * These six fields are the bot's own. The form's original fields (Budget,
 * Number of Bedrooms, Preferred Area, Move-in Timeline) are never touched: what
 * the client typed themselves stays as evidence, and what the model concluded
 * lives beside it, labelled. Anyone reading a card can tell the two apart.
 *
 * Created 2026-08-21 via POST /api/v4/leads/custom_fields.
 */
import { amoFetch, amoPatch } from "./amo-client";
import { logger } from "./logger";

export const REQUEST_FIELDS = {
  pax: 968487,        // "Request: people"        numeric
  bedrooms: 968489,   // "Request: bedrooms"      numeric
  areas: 968491,      // "Request: area"          text
  moveIn: 968493,     // "Request: move-in"       text
  stay: 968495,       // "Request: stay length"   text
  budgetJt: 968497,   // "Request: budget (jt/mo)" numeric
} as const;

export type RequestFieldValues = {
  pax: number | null;
  bedrooms: number | null;
  areas: string | null;
  moveIn: string | null;
  stay: string | null;
  /** Monthly budget in rupiah; written to the card in millions, as brokers speak. */
  budgetIdrMonthly: number | null;
};

/** Rupiah in, "juta" out — 45000000 becomes 45, which is what a broker reads. */
function toJuta(idr: number | null): number | null {
  return idr && idr > 0 ? Math.round(idr / 1_000_000) : null;
}

/**
 * What our six fields currently hold on the card.
 *
 * The comparison MUST be against the card and not against our own row: the row
 * is written first and would always look "already up to date", which is exactly
 * how the first rollout wrote one field of six and left five blank cards behind.
 * The card is the thing we are mirroring, so the card is the thing we diff.
 */
async function readRequestFieldsFromCard(leadId: string): Promise<Partial<RequestFieldValues>> {
  type AmoLead = { custom_fields_values?: Array<{ field_id?: number; values?: Array<{ value?: unknown }> }> };
  const lead = await amoFetch<AmoLead>(`/api/v4/leads/${encodeURIComponent(leadId)}`);
  const out: Record<number, string> = {};
  for (const f of lead?.custom_fields_values ?? []) {
    const v = f?.values?.[0]?.value;
    if (f?.field_id != null && v != null && String(v).trim() !== "") out[f.field_id] = String(v).trim();
  }
  const num = (id: number): number | null => {
    const raw = out[id];
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const jt = num(REQUEST_FIELDS.budgetJt);
  return {
    pax: num(REQUEST_FIELDS.pax),
    bedrooms: num(REQUEST_FIELDS.bedrooms),
    areas: out[REQUEST_FIELDS.areas] ?? null,
    moveIn: out[REQUEST_FIELDS.moveIn] ?? null,
    stay: out[REQUEST_FIELDS.stay] ?? null,
    budgetIdrMonthly: jt !== null ? jt * 1_000_000 : null,
  };
}

/**
 * Push the request onto the card, writing ONLY what the card does not already
 * say.
 *
 * Two rules, both deliberate:
 *  - A null is never written. The model re-reads the whole conversation every
 *    time, and a field it does not mention this round is "not stated", not
 *    "retracted" — blanking the card on that would make the column flicker and
 *    lose a value a broker had already acted on.
 *  - Nothing is sent when nothing differs. Every PATCH lands in the lead's
 *    change log, and a card whose history is thousands of identical bot edits is
 *    a card nobody can read.
 *
 * Failure is non-fatal: the row in our own database is already saved, and the
 * card catches up on the next distillation.
 */
export async function syncRequestToAmoCard(leadId: string, next: RequestFieldValues): Promise<boolean> {
  let onCard: Partial<RequestFieldValues>;
  try {
    onCard = await readRequestFieldsFromCard(leadId);
  } catch (err) {
    logger.warn({ err, leadId }, "request fields: could not read the card (non-fatal)");
    return false;
  }

  const values: Array<{ field_id: number; values: Array<{ value: string | number }> }> = [];

  const put = (fieldId: number, nextVal: string | number | null, cardVal: string | number | null | undefined) => {
    if (nextVal === null || nextVal === "") return;
    if (cardVal !== null && cardVal !== undefined && String(cardVal) === String(nextVal)) return;
    values.push({ field_id: fieldId, values: [{ value: nextVal }] });
  };

  put(REQUEST_FIELDS.pax, next.pax, onCard.pax);
  put(REQUEST_FIELDS.bedrooms, next.bedrooms, onCard.bedrooms);
  put(REQUEST_FIELDS.areas, next.areas, onCard.areas);
  put(REQUEST_FIELDS.moveIn, next.moveIn, onCard.moveIn);
  put(REQUEST_FIELDS.stay, next.stay, onCard.stay);
  put(REQUEST_FIELDS.budgetJt, toJuta(next.budgetIdrMonthly), toJuta(onCard.budgetIdrMonthly ?? null));

  if (values.length === 0) return false;

  try {
    const res = await amoPatch(`/api/v4/leads/${encodeURIComponent(leadId)}`, {
      custom_fields_values: values,
    });
    if (!res) {
      logger.warn({ leadId, fields: values.length }, "request fields: amoCRM did not accept the card update");
      return false;
    }
    logger.info({ leadId, fields: values.length }, "request fields written to the amoCRM card");
    return true;
  } catch (err) {
    logger.warn({ err, leadId }, "request fields: card update failed (non-fatal)");
    return false;
  }
}
