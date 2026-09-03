/**
 * The draft that exists so a card can never fall between the bot and the broker.
 *
 * The autopilot threshold is a handover point: the bot works every stage before
 * it and gives the card up on arrival. But the inbox is a list of DRAFTS, not of
 * cards, so "handed over" produced nothing anyone could see. A card reaching the
 * threshold had no draft (the bot's last one was sent and closed), and no new
 * one appeared until the owner happened to reply or a nudge matured. Meanwhile
 * the bot no longer touched it, because it was the broker's. The owner's words:
 * "иначе он просто теряется в системе".
 *
 * So the handover itself writes one draft. The broker reads it, approves it, and
 * that approval is what carries the card into the next stage — which is exactly
 * how every other move in this system happens.
 *
 * ONE draft per arrival at the handover stage. The first version of this guard
 * keyed on pending_suggestions.created_at and looped: queueSuggestion rewrites a
 * pending row IN PLACE (a delete+reinsert once changed the id under a broker
 * with the card open), so a card that already carried an old draft kept that
 * row's created_at, the guard never became true, and every pass rewrote the same
 * row and fired another push notification at the broker. The guard now keys on
 * the verdict stamp this pass writes itself (autopilot_skipped_at), compared
 * against when the card ARRIVED at the stage — so a broker who skipped the draft
 * is not asked again until the card re-enters, and a draft already written is
 * never written twice.
 */
import { db, leadsSyncTable, leadMessagesTable, pendingSuggestionsTable } from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { generateSuggestion } from "./generate-suggestion";
import { queueSuggestion } from "../routes/amocrm-webhook";
import { getAutopilotSetting, getHandoverStageName } from "./autopilot";

/** One pass may write this many, so a first run cannot become a wall. */
const BATCH_LIMIT = 10;

export const HANDOVER_VERDICT = "handed over to the broker";

export async function processHandoverDrafts(): Promise<number> {
  let queued = 0;
  try {
    const settings = await db.execute(
      sql`SELECT pipeline FROM autopilot_settings WHERE mode = 'on'`,
    );
    const pipelines = ((settings as { rows?: Array<{ pipeline: string }> }).rows ?? []).map(
      (r) => r.pipeline,
    );

    for (const pipeline of pipelines) {
      const setting = await getAutopilotSetting(pipeline);
      if (setting.mode !== "on") continue;
      const handoverStage = await getHandoverStageName(pipeline);
      if (!handoverStage) continue;
      const stageLower = handoverStage.toLowerCase();

      const candidates = await db
        .select({
          leadId: leadsSyncTable.leadId,
          responsibleUser: leadsSyncTable.responsibleUser,
          content: leadsSyncTable.content,
          leadNotes: leadsSyncTable.leadNotes,
          leadStage: leadsSyncTable.leadStage,
          pipeline: leadsSyncTable.pipeline,
        })
        .from(leadsSyncTable)
        .where(
          and(
            sql`lower(${leadsSyncTable.pipeline}) = ${pipeline.toLowerCase()}`,
            sql`lower(coalesce(${leadsSyncTable.leadStage},'')) = ${stageLower}`,
            sql`${leadsSyncTable.botExcluded} is not true`,
            // The owner spoke last: the LIVE path owns that card and its draft
            // is already visible. Writing over it here would replace a real
            // answer with a generic next step.
            sql`lower(coalesce(${leadsSyncTable.lastMessageFrom},'')) <> 'lead'`,
            // Already handed over since the card arrived here. Arrival is the
            // newest stage_events move INTO this stage; a card that was here
            // before tracking has no such row and falls back to "ever".
            sql`NOT EXISTS (
              SELECT 1 FROM pending_suggestions p
               WHERE p.lead_id = ${leadsSyncTable.leadId}
                 AND p.autopilot_skipped_reason = ${HANDOVER_VERDICT}
                 AND p.autopilot_skipped_at >= coalesce(
                       (SELECT max(e.changed_at) FROM stage_events e
                         WHERE e.lead_id = ${leadsSyncTable.leadId}
                           AND lower(e.to_stage) = ${stageLower}),
                       to_timestamp(0))
            )`,
          ),
        )
        .limit(BATCH_LIMIT);

      for (const lead of candidates) {
        try {
          const [lastIncoming] = await db
            .select({ text: leadMessagesTable.text })
            .from(leadMessagesTable)
            .where(
              and(
                eq(leadMessagesTable.leadId, lead.leadId),
                eq(leadMessagesTable.senderType, "lead"),
              ),
            )
            .orderBy(desc(leadMessagesTable.sentAt))
            .limit(1);

          const { text, attachments } = await generateSuggestion({
            leadId: lead.leadId,
            responsibleUser: lead.responsibleUser,
            kind: "live",
            lastLeadMessage: lastIncoming?.text ?? "",
            contentSnippet: lead.content ?? "",
            leadNotes: lead.leadNotes,
            leadStage: lead.leadStage,
            pipeline: lead.pipeline,
          });
          if (!text) continue;

          await queueSuggestion({
            leadId: lead.leadId,
            responsibleUser: lead.responsibleUser,
            kind: "live",
            text,
            attachments,
            leadMessageText: lastIncoming?.text ?? "",
          });
          // The stamp is BOTH the inbox's reason to show this draft despite our
          // own message being the newest, AND this pass's own memory that the
          // card has been handed over. Without the timestamp the memory has no
          // "since when", and created_at cannot stand in for it (see header).
          await db
            .update(pendingSuggestionsTable)
            .set({ autopilotSkippedReason: HANDOVER_VERDICT, autopilotSkippedAt: new Date() })
            .where(
              and(
                eq(pendingSuggestionsTable.leadId, lead.leadId),
                eq(pendingSuggestionsTable.status, "pending"),
              ),
            );
          queued++;
          logger.info(
            { leadId: lead.leadId, stage: lead.leadStage, pipeline },
            "handover draft: autopilot is done with this card, the broker now has something to act on",
          );
        } catch (err) {
          logger.error({ err, leadId: lead.leadId }, "handover draft: failed for this card");
        }
      }
    }
  } catch (err) {
    logger.error({ err }, "handover draft pass failed");
  }
  if (queued > 0) logger.info({ queued }, "handover draft pass complete");
  return queued;
}
