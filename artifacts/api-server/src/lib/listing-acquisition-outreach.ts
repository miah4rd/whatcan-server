/**
 * First-contact outreach for the Rental Listings pipeline.
 *
 * Every other pipeline here is reactive — the bot only ever replies to an
 * inbound message. Rental Listings is the opposite: a separate scouting
 * process creates the amoCRM card (WhatsApp contact + whatever it knows
 * about the listing) with no conversation started at all, and the owner
 * wants OUR bot to write first to qualify owner vs agent.
 *
 * There's already a working "bot writes first" precedent — the amoCRM
 * lead_assigned webhook triggers generateSuggestion({isFirstContact:true})
 * + queueSuggestion directly, no faked inbound message needed (see
 * amocrm-webhook.ts's lead_assigned handler). This pass is the same thing on
 * a poll instead of that webhook event, so a new Rental Listings card still
 * gets its opener even if lead_assigned never fires for it (e.g. the scout
 * process creates the card pre-assigned rather than via a reassignment).
 */
import { db, leadsSyncTable, pendingSuggestionsTable } from "@workspace/db";
import { eq, and, or, isNull, isNotNull, sql } from "drizzle-orm";
import { logger } from "./logger";
import { generateSuggestion } from "./generate-suggestion";
import { queueSuggestion } from "../routes/amocrm-webhook.js";
import { fillMessengerFromResponsibleIfNoMessages } from "./amo-messenger-field";

export async function processListingAcquisitionOutreach(): Promise<number> {
  const candidates = await db
    .select({
      leadId: leadsSyncTable.leadId,
      responsibleUser: leadsSyncTable.responsibleUser,
      leadNotes: leadsSyncTable.leadNotes,
      content: leadsSyncTable.content,
    })
    .from(leadsSyncTable)
    .where(
      and(
        sql`lower(coalesce(${leadsSyncTable.pipeline}, '')) = 'rental listings'`,
        isNull(leadsSyncTable.lastMessageFrom),
        or(isNull(leadsSyncTable.content), eq(leadsSyncTable.content, "")),
        // Recent cards only — same reasoning as sourced-lead-outreach: without
        // this a first pass after deploy would reach back through every old
        // card ever dropped into this pipeline.
        isNotNull(leadsSyncTable.amoCreatedAt),
        sql`${leadsSyncTable.amoCreatedAt} > now() - interval '30 days'`,
      ),
    );

  if (candidates.length === 0) return 0;

  let sent = 0;
  for (const lead of candidates) {
    try {
      // Someone (this pass earlier, the lead_assigned webhook, or a broker by
      // hand) already produced a suggestion for this lead — don't send a
      // second opener on top of it.
      const [everQueued] = await db
        .select({ id: pendingSuggestionsTable.id })
        .from(pendingSuggestionsTable)
        .where(
          and(
            eq(pendingSuggestionsTable.leadId, lead.leadId),
            sql`${pendingSuggestionsTable.status} IN ('pending','approved','edited')`,
          ),
        )
        .limit(1);
      if (everQueued) continue;

      await fillMessengerFromResponsibleIfNoMessages(lead.leadId, lead.responsibleUser).catch(() => null);

      const { text, attachments } = await generateSuggestion({
        leadId: lead.leadId,
        responsibleUser: lead.responsibleUser,
        kind: "push",
        lastLeadMessage: "",
        contentSnippet: lead.content ?? "",
        leadNotes: lead.leadNotes,
        isFirstContact: true,
        pipeline: "Rental Listings",
      });
      if (!text) continue;

      await queueSuggestion({ leadId: lead.leadId, responsibleUser: lead.responsibleUser, kind: "push", text, attachments });
      sent++;
      logger.info({ leadId: lead.leadId }, "listing-acquisition: first-contact opener queued");
    } catch (err) {
      logger.error({ err, leadId: lead.leadId }, "listing-acquisition outreach failed");
    }
  }

  if (sent > 0) logger.info({ sent }, "listing-acquisition outreach pass complete");
  return sent;
}
