/**
 * What happened after the viewing?
 *
 * "Viewing scheduled" is a promise with a time on it. Once that time has
 * passed, the card must become one of two things: "Viewing done" (the client
 * stood in the villa) or a question to the broker. Nobody set "Viewing done"
 * on any card in the funnel's history, so the one number that leads to a deal
 * — viewings held — was unmeasurable.
 *
 * Three hours after the slot: if the thread since then says the viewing
 * happened, the classifier moves the card; if nothing was said, the broker
 * gets a ready "how did it go?" draft, stamped so the inbox shows it and
 * autopilot leaves it alone. One draft per viewing.
 */
import { db, leadsSyncTable, leadMessagesTable, pendingSuggestionsTable } from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { classifyAndApplyStage } from "./stage-on-reply";

export const VIEWING_FOLLOWUP_VERDICT = "viewing follow-up due";
const GRACE_HOURS = 3;

function firstName(raw: string | null | undefined): string {
  const s = (raw ?? "").replace(/\(.*$/, "").trim().split(/\s+/)[0] ?? "";
  return /^[A-Za-zÀ-ÿ'’-]{2,}$/.test(s) ? s : "";
}

export async function processViewingOutcomes(): Promise<{ moved: number; drafted: number }> {
  let moved = 0;
  let drafted = 0;
  try {
    const due = await db
      .select({
        leadId: leadsSyncTable.leadId,
        responsibleUser: leadsSyncTable.responsibleUser,
        viewingAt: leadsSyncTable.viewingAt,
      })
      .from(leadsSyncTable)
      .where(
        and(
          sql`lower(coalesce(${leadsSyncTable.leadStage},'')) LIKE 'viewing scheduled%'`,
          sql`${leadsSyncTable.viewingAt} IS NOT NULL`,
          sql`${leadsSyncTable.viewingAt} + make_interval(hours => ${GRACE_HOURS}) <= now()`,
          sql`${leadsSyncTable.botExcluded} IS NOT TRUE`,
          sql`NOT EXISTS (SELECT 1 FROM pending_suggestions p WHERE p.lead_id = ${leadsSyncTable.leadId}
                 AND p.autopilot_skipped_reason = ${VIEWING_FOLLOWUP_VERDICT}
                 AND p.autopilot_skipped_at >= ${leadsSyncTable.viewingAt})`,
        ),
      )
      .limit(20);

    for (const lead of due) {
      try {
        // Anything said since the slot? Let the classifier read it.
        const [after] = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(leadMessagesTable)
          .where(and(eq(leadMessagesTable.leadId, lead.leadId), sql`${leadMessagesTable.sentAt} > ${lead.viewingAt}`));
        if ((after?.n ?? 0) > 0) {
          const r = await classifyAndApplyStage(lead.leadId, { source: "viewing-outcome" });
          if (r.moved) { moved++; continue; }
        }
        // Silence, or the thread did not settle it: ask the broker to ask.
        // The client's name is read in its own query: a correlated subquery
        // in the select above rendered `lead_id = lead_id` and greeted Liu as
        // "Fengshui" — the newest client in the whole table.
        const [nameRow] = await db
          .select({ name: leadMessagesTable.senderName })
          .from(leadMessagesTable)
          .where(and(eq(leadMessagesTable.leadId, lead.leadId), eq(leadMessagesTable.senderType, "lead")))
          .orderBy(desc(leadMessagesTable.sentAt))
          .limit(1);
        const name = firstName(nameRow?.name);
        const text =
          `Hi${name ? ` ${name}` : ""}, how did the viewing go? ` +
          `If it felt right, I can check the next steps with the owner, and if not, tell me what was missing and I'll find closer matches.`;
        await db.insert(pendingSuggestionsTable).values({
          leadId: lead.leadId,
          responsibleUser: lead.responsibleUser,
          kind: "push",
          suggestionText: text,
          status: "pending",
          autopilotSkippedReason: VIEWING_FOLLOWUP_VERDICT,
          autopilotSkippedAt: new Date(),
        });
        // One open push per card: an older follow-up written before the slot
        // ("we still have the 5PM visit set up") is now wrong, and two drafts
        // for one client is the clutter the broker asked us to stop.
        await db
          .update(pendingSuggestionsTable)
          .set({ status: "skipped" })
          .where(
            and(
              eq(pendingSuggestionsTable.leadId, lead.leadId),
              eq(pendingSuggestionsTable.kind, "push"),
              eq(pendingSuggestionsTable.status, "pending"),
              sql`${pendingSuggestionsTable.autopilotSkippedReason} IS DISTINCT FROM ${VIEWING_FOLLOWUP_VERDICT}`,
            ),
          );
        drafted++;
        logger.info({ leadId: lead.leadId, viewingAt: lead.viewingAt }, "viewing outcome: no word since the slot — 'how did it go?' draft written for the broker");
      } catch (err) {
        logger.error({ err, leadId: lead.leadId }, "viewing outcome: failed for this card");
      }
    }
  } catch (err) {
    logger.error({ err }, "viewing outcome pass failed");
  }
  if (moved + drafted > 0) logger.info({ moved, drafted }, "viewing outcome pass complete");
  return { moved, drafted };
}
