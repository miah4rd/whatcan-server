import { Router } from "express";
import { db, leadsSyncTable, stageEventsTable } from "@workspace/db";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { classifyStage } from "../../lib/stage-classifier";
import { parseDialogContent, formatDialogForAI } from "../../lib/dialog-parser";
import { updateLeadStatus } from "../../lib/amo-client";
import { shouldSuppressPush } from "../../lib/stage-routing";
import { logger } from "../../lib/logger";

const router = Router();

/**
 * One-off backfill: re-read every open conversation in a funnel and put the
 * card where the conversation actually is.
 *
 * Written for the 2026-08-18 Rental restructure — "Viewing scheduled" and
 * "Viewing done" were added and everything piled up in Options sent (50 of 53
 * leads), because until then there was nowhere else for a booked viewing to
 * go. Ongoing moves happen by themselves on every reply; this is only for the
 * backlog that predates a funnel change.
 *
 * DRY BY DEFAULT. Unlike the other repair endpoints this one writes to the
 * owner's live CRM — moving a card can fire amoCRM's own automations — so it
 * previews unless you pass ?apply=1, rather than the other way round.
 *
 *   POST /api/admin/reclassify-stages?pipeline=rental            → preview
 *   POST /api/admin/reclassify-stages?pipeline=rental&apply=1    → move them
 *   ...&broker=Amelia&limit=25                                   → narrower
 */
router.post("/admin/reclassify-stages", async (req, res) => {
  const pipeline = String(req.query.pipeline ?? "rental").trim();
  const broker = req.query.broker ? String(req.query.broker).trim() : null;
  const limit = Math.min(Number(req.query.limit ?? 200) || 200, 500);
  const apply = req.query.apply === "1" || req.query.apply === "true";

  try {
    const rows = await db
      .select({
        leadId: leadsSyncTable.leadId,
        leadStage: leadsSyncTable.leadStage,
        pipeline: leadsSyncTable.pipeline,
        responsibleUser: leadsSyncTable.responsibleUser,
        content: leadsSyncTable.content,
      })
      .from(leadsSyncTable)
      .where(
        and(
          sql`lower(trim(${leadsSyncTable.pipeline})) = ${pipeline.toLowerCase()}`,
          isNotNull(leadsSyncTable.content),
          // IS NOT TRUE, not `= false`: older rows have a NULL here and a
          // backfill that silently skips most of the funnel is worse than none.
          sql`${leadsSyncTable.botExcluded} IS NOT TRUE`,
          ...(broker ? [sql`lower(${leadsSyncTable.responsibleUser}) = ${broker.toLowerCase()}`] : []),
        ),
      )
      .limit(limit);

    const moves: Array<{ leadId: string; broker: string | null; from: string | null; to: string; reason: string }> = [];
    const skipped = { deadStage: 0, noChange: 0, terminal: 0, emptyDialog: 0, failed: 0 };
    let applied = 0;

    for (const lead of rows) {
      // A closed / dead / handover stage is not ours to re-decide.
      if (lead.leadStage && shouldSuppressPush(lead.leadStage)) {
        skipped.deadStage++;
        continue;
      }
      const dialog = parseDialogContent(lead.content ?? "");
      if (!dialog.messages.length) {
        skipped.emptyDialog++;
        continue;
      }

      // "Where is this conversation RIGHT NOW" — no pending reply, so nothing
      // credits us with outreach that has not happened.
      const state = await classifyStage({
        pipeline: lead.pipeline,
        currentStage: lead.leadStage,
        conversationText: formatDialogForAI(dialog.messages),
        replyText: "",
        attachmentsCount: 0,
      }).catch(() => null);

      if (!state) {
        skipped.noChange++;
        continue;
      }
      // Closed-won / closed-lost stay a one-tap broker decision, in bulk too.
      if (state.terminal) {
        skipped.terminal++;
        continue;
      }

      moves.push({
        leadId: lead.leadId,
        broker: lead.responsibleUser,
        from: lead.leadStage,
        to: state.stage.name,
        reason: state.reason,
      });

      if (!apply) continue;

      const ok = await updateLeadStatus(lead.leadId, state.stage.id).catch(() => false);
      if (!ok) {
        skipped.failed++;
        continue;
      }
      await db
        .update(leadsSyncTable)
        .set({
          leadStage: state.stage.name,
          leadStageId: String(state.stage.id),
          updatedAt: new Date(),
        })
        .where(eq(leadsSyncTable.leadId, lead.leadId));
      await db
        .insert(stageEventsTable)
        .values({
          leadId: lead.leadId,
          fromStage: lead.leadStage,
          toStage: state.stage.name,
          pipeline: lead.pipeline,
          responsibleUser: lead.responsibleUser ?? null,
        })
        .catch(() => {});
      applied++;
    }

    logger.info(
      { pipeline, broker, scanned: rows.length, proposed: moves.length, applied, apply },
      "reclassify-stages finished",
    );

    res.json({
      mode: apply ? "applied" : "dry run — pass ?apply=1 to move the cards",
      pipeline,
      broker,
      scanned: rows.length,
      proposed: moves.length,
      applied,
      skipped,
      moves,
    });
  } catch (err) {
    logger.error({ err, pipeline }, "reclassify-stages failed");
    res.status(500).json({ error: String(err) });
  }
});

export default router;
