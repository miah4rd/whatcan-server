/**
 * The rental area gate: a client asking only for an area we do not work yet
 * goes silently to Closed Lost — no welcome, no draft, no AI token.
 *
 * Owner, 18.09.2026: "фильтр на районы, по которым мы пока не работаем —
 * Улувату, Убуд и Санур... такие заявки в корзину и не обслуживать вообще. Это
 * временно, пока мы там не работаем, я сообщу, когда начнём". Until then the
 * welcome withheld by area-coverage.ts still left a draft in the inbox, and the
 * bot answered those clients with "nothing in Uluwatu right now, would another
 * area work?" (Dima, 23594667, 17.09).
 *
 * A sibling of the budget gate (budget-filter.ts) and scoped the same way:
 * Rental only, called at the same entry points, amoCRM closed first. Narrower
 * in two ways, on purpose:
 * - only a FIRST touch: once anything of ours reached the client, a
 *   conversation exists and a card rule never ends it;
 * - only when EVERY place the client named is in an excluded area. "Sanur or
 *   Canggu" is a Canggu client; a place we cannot read is no evidence at all.
 *
 * Lifting it = emptying EXCLUDED_AREAS, on the owner's word only.
 */
import { db, leadsSyncTable, pendingSuggestionsTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { closeLeadAsLost } from "./amo-client";
import { getLeadCardCriteria } from "./lead-card-fields";
import { districtOfPlace, isNonAnswer, placesAsked } from "./area-coverage";

/** Districts we do not work yet (owner, 18.09.2026, temporary). */
export const EXCLUDED_AREAS = new Set(["uluwatu", "ubud", "sanur"]);

/** The places the client asked for, and whether every one is excluded. */
export function excludedAreaVerdict(
  areaAnswer: string | null | undefined,
  notes: string | null | undefined,
): { places: string[]; excluded: boolean } {
  const places = placesAsked(areaAnswer, notes);
  const excluded =
    places.length > 0 && places.every((p) => EXCLUDED_AREAS.has(districtOfPlace(p).toLowerCase()));
  return { places, excluded };
}

async function anythingOfOursSent(leadId: string): Promise<boolean> {
  const res = await db.execute(sql`
    SELECT 1 AS x WHERE
      EXISTS (SELECT 1 FROM sent_messages WHERE lead_id = ${leadId} AND lead_id NOT LIKE 'undelivered-%')
      OR EXISTS (SELECT 1 FROM lead_messages WHERE lead_id = ${leadId} AND direction = 'outbound')
    LIMIT 1`);
  const rows = (res as unknown as { rows?: unknown[] }).rows ?? (Array.isArray(res) ? (res as unknown[]) : []);
  return rows.length > 0;
}

/**
 * Checks one lead and closes it when it asks only for an excluded area.
 * Returns true when the lead was closed (callers then skip all further work).
 * `extraNotes` lets the seeding pass hand in a note not yet in the DB.
 */
export async function enforceExcludedAreaFilter(leadId: string, extraNotes?: string[]): Promise<boolean> {
  if (EXCLUDED_AREAS.size === 0) return false;
  try {
    const [lead] = await db
      .select({
        pipeline: leadsSyncTable.pipeline,
        leadStage: leadsSyncTable.leadStage,
        leadNotes: leadsSyncTable.leadNotes,
        botExcluded: leadsSyncTable.botExcluded,
      })
      .from(leadsSyncTable)
      .where(eq(leadsSyncTable.leadId, leadId))
      .limit(1);
    if (!lead || lead.botExcluded) return false;
    if ((lead.pipeline ?? "").trim().toLowerCase() !== "rental") return false;
    if (/closed|lost|won/i.test(lead.leadStage ?? "")) return false;

    // The form first (area answer, then its notes when the answer is "Other");
    // a scout lead has no form, and its request is the card note.
    const card = await getLeadCardCriteria(leadId).catch(() => null);
    const answers = card?.answers ?? null;
    let verdict = excludedAreaVerdict(answers?.areas ?? null, answers?.notes ?? null);
    if (verdict.places.length === 0 && isNonAnswer(answers?.areas ?? null)) {
      const note = [lead.leadNotes ?? "", ...(extraNotes ?? [])]
        .join("\n")
        .replace(/Ad enquiry:[^\n]*/gi, " ");
      verdict = excludedAreaVerdict(null, note);
    }
    if (!verdict.excluded) return false;

    if (await anythingOfOursSent(leadId)) {
      logger.info({ leadId, places: verdict.places }, "excluded-area filter: asks only for an excluded area, but a conversation already exists — kept");
      return false;
    }

    const closed = await closeLeadAsLost(leadId);
    if (!closed) {
      logger.error({ leadId, places: verdict.places }, "excluded-area filter: amoCRM refused the close — lead kept active");
      return false;
    }
    await db
      .update(leadsSyncTable)
      .set({ leadStage: "Closed Lost", nextFollowupAt: null, updatedAt: new Date() })
      .where(eq(leadsSyncTable.leadId, leadId));
    await db
      .delete(pendingSuggestionsTable)
      .where(and(eq(pendingSuggestionsTable.leadId, leadId), eq(pendingSuggestionsTable.status, "pending")));
    logger.warn(
      { leadId, places: verdict.places },
      "excluded-area filter: rental lead auto-closed to Lost — asks only for an area we do not work yet (Uluwatu / Ubud / Sanur)",
    );
    return true;
  } catch (err) {
    logger.error({ err, leadId }, "excluded-area filter failed (non-fatal, lead worked normally)");
    return false;
  }
}
