/**
 * The lead card's own fields as a source of truth for the core criteria.
 *
 * The ad form (Facebook → Albato → amoCRM) fills "Budget", "Number of Bedrooms"
 * and "Preferred Area or District" on the card itself — but the bot only ever
 * parsed the conversation text, so a form-filled budget was invisible: the
 * budget gate saw "no budget stated" and worked a lead that had already
 * disqualified itself, and the matcher re-asked for criteria the client had
 * typed into the form minutes earlier.
 *
 * Precedence, unchanged from everywhere else: what the client SAYS in the
 * conversation always beats what a form once recorded — this only fills the
 * gaps. Failures are non-fatal: no card data simply means we know less.
 */
import { amoFetch } from "./amo-client";
import { extractBudgetIdr } from "./property-catalog";
import { areaNamesInText } from "./bali-areas";
import { logger } from "./logger";

/** amoCRM lead custom-field ids on this account (GET /api/v4/leads/custom_fields). */
const FIELD_BUDGET = 956449; // "Budget" (text)
const FIELD_BUDGET_UNTIL = 755371; // "Budget Until" (numeric)
const FIELD_BEDROOMS_TEXT = 959041; // "Number of Bedrooms" (text)
const FIELD_BEDROOMS_SELECT = 512421; // "Bedrooms" (multiselect: 1BR…5BR)
const FIELD_AREA_TEXT = 959039; // "Preferred Area or District" (text)
const FIELD_AREA_SELECT = 512215; // "Location/District" (multiselect)
const FIELD_LOCATIONS_TEXT = 956457; // "Preferred Locations" (text)
const FIELD_BUDGET_FREEFORM = [539057, 921063, 930669, 877631]; // older budget questions

export type LeadCardCriteria = {
  /** Monthly rupiah budget as stated on the card, when it parses to one. */
  budgetIdrMonthly: number | null;
  bedrooms: number | null;
  areas: string[];
  /** Every budget-ish string found — handed to the gate so it parses them itself. */
  budgetTexts: string[];
};

type AmoField = { field_id?: number; values?: Array<{ value?: unknown }> };

const EMPTY: LeadCardCriteria = { budgetIdrMonthly: null, bedrooms: null, areas: [], budgetTexts: [] };

// A lead's card is read on the gate AND on matching within the same second —
// a tiny cache keeps that to one API call without ever going stale in practice.
const cache = new Map<string, { at: number; value: LeadCardCriteria }>();
const TTL_MS = 60_000;

function textOf(fields: AmoField[], id: number): string {
  const f = fields.find((x) => x.field_id === id);
  const vals = (f?.values ?? []).map((v) => String(v?.value ?? "").trim()).filter(Boolean);
  return vals.join(", ");
}

export async function getLeadCardCriteria(leadId: string): Promise<LeadCardCriteria> {
  const hit = cache.get(leadId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  try {
    const lead = await amoFetch<{ custom_fields_values?: AmoField[] }>(`/api/v4/leads/${leadId}`);
    const fields = lead?.custom_fields_values ?? [];
    if (fields.length === 0) {
      cache.set(leadId, { at: Date.now(), value: EMPTY });
      return EMPTY;
    }

    const budgetTexts = [
      textOf(fields, FIELD_BUDGET),
      textOf(fields, FIELD_BUDGET_UNTIL),
      ...FIELD_BUDGET_FREEFORM.map((id) => textOf(fields, id)),
    ].filter(Boolean);

    // A bare "40" in a budget field means 40 million rupiah a month — that is how
    // the form asks it and how brokers here speak. Without this a plain number
    // parsed to nothing and the gate stayed blind.
    const normalised = budgetTexts.map((t) =>
      /^\s*\d{1,4}([.,]\d+)?\s*$/.test(t) ? `${t.trim()} million` : t,
    );
    const budgetIdrMonthly = extractBudgetIdr(normalised);

    const bedroomsRaw = [textOf(fields, FIELD_BEDROOMS_TEXT), textOf(fields, FIELD_BEDROOMS_SELECT)]
      .filter(Boolean)
      .join(" ");
    const bedMatch = bedroomsRaw.match(/(\d+)/);
    const bedrooms = bedMatch?.[1] ? parseInt(bedMatch[1], 10) : null;

    const areaRaw = [
      textOf(fields, FIELD_AREA_TEXT),
      textOf(fields, FIELD_AREA_SELECT),
      textOf(fields, FIELD_LOCATIONS_TEXT),
    ]
      .filter(Boolean)
      .join(", ");
    const areas = areaRaw ? areaNamesInText(areaRaw) : [];

    const value: LeadCardCriteria = {
      budgetIdrMonthly,
      bedrooms: bedrooms && bedrooms > 0 && bedrooms < 15 ? bedrooms : null,
      areas,
      budgetTexts,
    };
    cache.set(leadId, { at: Date.now(), value });
    if (budgetIdrMonthly || bedrooms || areas.length) {
      logger.info({ leadId, ...value, budgetTexts: undefined }, "lead card fields read from amoCRM");
    }
    return value;
  } catch (err) {
    logger.warn({ err, leadId }, "could not read the lead card fields (non-fatal)");
    return EMPTY;
  }
}
