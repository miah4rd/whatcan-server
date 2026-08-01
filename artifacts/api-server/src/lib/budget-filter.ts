/**
 * The rental budget gate: leads below the broker's threshold go straight to
 * Closed Lost, before a single AI token is spent on them.
 *
 * The owner's traffic problem, verbatim: "лидов много, толку мало... если
 * меньше сорока миллионов — в корзину, чтобы не тратить ни время, ни энергию,
 * ни токены". This is his EXPLICIT exception to the standing rule that Closed
 * Lost is never applied automatically — scoped hard: Rental pipeline only,
 * only when the filter is switched on, and only when a rupiah budget was
 * confidently parsed from the LEAD'S OWN words (or the scout/ad form note).
 * No budget found = no decision = the lead is worked normally (fail-open).
 *
 * Ranges parse to their UPPER bound ("30-40 million" → 40M), so a client whose
 * range touches the threshold is kept. Equal to the threshold is kept; only
 * strictly below closes.
 *
 * The check runs at the entry points where money would otherwise start being
 * spent: a new inbound message (both LIVE detectors), the unanswered-lead pass,
 * and the scout/ad seeding pass.
 */
import { db, leadsSyncTable, pendingSuggestionsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { logger } from "./logger";
import { extractBudgetIdr } from "./property-catalog";
import { parseDialogContent } from "./dialog-parser";
import { closeLeadAsLost } from "./amo-client";

export type BudgetFilterSetting = {
  pipeline: string;
  enabled: boolean;
  minMonthlyIdr: number;
};

function firstRow<T>(res: unknown): T | undefined {
  const withRows = res as { rows?: T[] };
  if (Array.isArray(withRows.rows)) return withRows.rows[0];
  if (Array.isArray(res)) return (res as T[])[0];
  return undefined;
}

export async function getBudgetFilter(pipeline: string): Promise<BudgetFilterSetting> {
  const key = pipeline.trim().toLowerCase();
  try {
    const res = await db.execute(
      sql`SELECT pipeline, enabled, min_monthly_idr FROM budget_filter_settings WHERE pipeline = ${key}`,
    );
    const r = firstRow<Record<string, unknown>>(res);
    if (!r) return { pipeline: key, enabled: false, minMonthlyIdr: 0 };
    return {
      pipeline: key,
      enabled: r["enabled"] === true,
      minMonthlyIdr: Number(r["min_monthly_idr"]) || 0,
    };
  } catch (err) {
    logger.warn({ err, pipeline: key }, "budget filter: could not read setting — treating as off");
    return { pipeline: key, enabled: false, minMonthlyIdr: 0 };
  }
}

export async function setBudgetFilter(s: BudgetFilterSetting): Promise<void> {
  const key = s.pipeline.trim().toLowerCase();
  await db.execute(sql`
    INSERT INTO budget_filter_settings (pipeline, enabled, min_monthly_idr, updated_at)
    VALUES (${key}, ${s.enabled}, ${s.minMonthlyIdr}, now())
    ON CONFLICT (pipeline) DO UPDATE
      SET enabled = ${s.enabled}, min_monthly_idr = ${s.minMonthlyIdr}, updated_at = now()
  `);
  logger.info({ setting: { ...s, pipeline: key } }, "budget filter: setting saved");
}

/**
 * Checks one lead against the filter and closes it when it fails.
 * Returns true when the lead was closed (callers then skip all further work).
 *
 * `extraTexts` lets the seeding pass hand in a note that is not in the DB yet.
 */
export async function enforceBudgetFilter(leadId: string, extraTexts?: string[]): Promise<boolean> {
  try {
    const [lead] = await db
      .select({
        pipeline: leadsSyncTable.pipeline,
        leadStage: leadsSyncTable.leadStage,
        content: leadsSyncTable.content,
        leadNotes: leadsSyncTable.leadNotes,
        botExcluded: leadsSyncTable.botExcluded,
      })
      .from(leadsSyncTable)
      .where(eq(leadsSyncTable.leadId, leadId))
      .limit(1);
    if (!lead || lead.botExcluded) return false;

    const pipeline = (lead.pipeline ?? "").trim().toLowerCase();
    if (pipeline !== "rental") return false; // owner: rentals only, other funnels untouched

    const setting = await getBudgetFilter(pipeline);
    if (!setting.enabled || setting.minMonthlyIdr <= 0) return false;

    const stage = (lead.leadStage ?? "").toLowerCase();
    if (/closed|lost|won/.test(stage)) return false;

    // The LEAD'S own words, newest first, so a revised budget wins; the card
    // note (scout/ad form) is the fallback source when they never typed one.
    const leadTexts = parseDialogContent(lead.content ?? "")
      .messages.filter((m) => m.from === "lead")
      .map((m) => m.text)
      .reverse();
    const texts = [...leadTexts, ...(extraTexts ?? []), lead.leadNotes ?? ""].filter(Boolean);
    const budget = extractBudgetIdr(texts);
    if (!budget) return false; // no stated budget → no decision → work the lead
    if (budget >= setting.minMonthlyIdr) return false;

    // Below the bar — into the bin, exactly as ordered. amoCRM first: if the
    // CRM refuses the close, the lead stays active everywhere rather than
    // half-closed.
    const closed = await closeLeadAsLost(leadId);
    if (!closed) {
      logger.error({ leadId, budget }, "budget filter: amoCRM refused the close — lead kept active");
      return false;
    }
    await db
      .update(leadsSyncTable)
      .set({ leadStage: "Closed Lost", nextFollowupAt: null, updatedAt: new Date() })
      .where(eq(leadsSyncTable.leadId, leadId));
    await db
      .delete(pendingSuggestionsTable)
      .where(
        and(eq(pendingSuggestionsTable.leadId, leadId), eq(pendingSuggestionsTable.status, "pending")),
      );
    logger.warn(
      { leadId, budgetIdr: budget, minIdr: setting.minMonthlyIdr },
      "budget filter: rental lead auto-closed to Lost — budget below the broker's threshold",
    );
    return true;
  } catch (err) {
    logger.error({ err, leadId }, "budget filter failed (non-fatal, lead worked normally)");
    return false;
  }
}
