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
 * Deliberately ONE draft per outbound message: the guard is "no suggestion row
 * of any status created since our last message". A draft the broker skipped
 * leaves a row behind, so skipping means skipping, not asking again in five
 * minutes.
 */
import { db, leadsSyncTable, leadMessagesTable, pendingSuggestionsTable } from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { generateSuggestion } from "./generate-suggestion";
import { queueSuggestion } from "../routes/amocrm-webhook";
import { getAutopilotSetting, getHandoverStageName } from "./autopilot";

/** One pass may write this many, so a first run cannot become a wall. */
const BATCH_LIMIT = 10;

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
            sql`lower(coalesce(${leadsSyncTable.leadStage},'')) = ${handoverStage.toLowerCase()}`,
            sql`${leadsSyncTable.botExcluded} is not true`,
            sql`${leadsSyncTable.lastOurMessageAt} is not null`,
            // Nothing written for this card since we last spoke — see the note
            // on skipping above.
            sql`NOT EXISTS (
              SELECT 1 FROM pending_suggestions p
               WHERE p.lead_id = ${leadsSyncTable.leadId}
                 AND p.created_at > ${leadsSyncTable.lastOurMessageAt}
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
          // Stamp the verdict so the inbox knows this draft is the broker's and
          // must not be judged by the "have we already answered?" rule — our own
          // message is always the newest one on a card we just handed over.
          await db
            .update(pendingSuggestionsTable)
            .set({ autopilotSkippedReason: "handed over to the broker" })
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
