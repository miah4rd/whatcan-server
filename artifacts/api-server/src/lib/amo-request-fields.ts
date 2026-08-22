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
import { amoPatch } from "./amo-client";
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
 * Push the request onto the card, writing ONLY what changed.
 *
 * Two rules, both deliberate:
 *  - A null is never written. The model re-reads the whole conversation every
 *    time, and a field it does not mention this round is "not stated", not
 *    "retracted" — blanking the card on that would make the column flicker and
 *    lose a value a broker had already acted on.
 *  - Nothing is sent when nothing changed. Every PATCH lands in the lead's
 *    change log, and a card whose history is thousands of identical bot edits is
 *    a card nobody can read.
 *
 * Failure is non-fatal: the row in our own database is already saved, and the
 * card catches up on the next distillation.
 */
export async function syncRequestToAmoCard(
  leadId: string,
  next: RequestFieldValues,
  prev: Partial<RequestFieldValues>,
): Promise<boolean> {
  const values: Array<{ field_id: number; values: Array<{ value: string | number }> }> = [];

  const put = (fieldId: number, nextVal: string | number | null, prevVal: string | number | null | undefined) => {
    if (nextVal === null || nextVal === "") return;
    if (prevVal !== null && prevVal !== undefined && String(prevVal) === String(nextVal)) return;
    values.push({ field_id: fieldId, values: [{ value: nextVal }] });
  };

  put(REQUEST_FIELDS.pax, next.pax, prev.pax);
  put(REQUEST_FIELDS.bedrooms, next.bedrooms, prev.bedrooms);
  put(REQUEST_FIELDS.areas, next.areas, prev.areas);
  put(REQUEST_FIELDS.moveIn, next.moveIn, prev.moveIn);
  put(REQUEST_FIELDS.stay, next.stay, prev.stay);
  put(REQUEST_FIELDS.budgetJt, toJuta(next.budgetIdrMonthly), toJuta(prev.budgetIdrMonthly ?? null));

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
