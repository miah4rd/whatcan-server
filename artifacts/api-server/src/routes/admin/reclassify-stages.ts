import { Router } from "express";
import { db, leadsSyncTable, stageEventsTable } from "@workspace/db";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { classifyStage, getPipelineStages } from "../../lib/stage-classifier";
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
  // Scope to leads CURRENTLY sitting in one named stage. Exists for the case
  // this docstring didn't cover: a funnel restructure that RENAMES an
  // existing status_id inherits that status's old leads under the new label
  // without moving a single card. "Viewing Suggested" on the 2026-08-22
  // restructure absorbed leads from whatever it used to be called — most had
  // never had a viewing suggested at all, they were mid-budget-qualifying or
  // even a soft close ("we don't have much matching that budget"). The
  // pipeline-wide backfill above is forward-only and correctly leaves them
  // alone (they're already at-or-past this stage's rank); this scope lets a
  // specific mislabelled stage be re-checked with allowBackward on ITS OWN,
  // without touching the rest of the funnel.
  const onlyStage = req.query.stage ? String(req.query.stage).trim().toLowerCase() : null;
  const limit = Math.min(Number(req.query.limit ?? 200) || 200, 500);
  const apply = req.query.apply === "1" || req.query.apply === "true";
  // A backfill only promotes. Deciding in bulk that 50 conversations have
  // REGRESSED is a different and much riskier claim than noticing they moved
  // on — and the first dry run made it on a lead whose only sin was saying
  // the options were expensive ("Options sent" → "need assessed"). Day-to-day
  // classification keeps its ability to move a card back; this does not.
  const allowBackward = req.query.allowBackward === "1";

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
          ...(onlyStage ? [sql`lower(trim(${leadsSyncTable.leadStage})) = ${onlyStage}`] : []),
        ),
      )
      .limit(limit);

    // Funnel order, so "is this a step forward?" is answered by the funnel
    // itself rather than by a hardcoded list that goes stale on a rename.
    const stages = await getPipelineStages(pipeline);
    const orderOf = (name: string | null): number =>
      name && stages
        ? stages.all.findIndex((st) => st.name.trim().toLowerCase() === name.trim().toLowerCase())
        : -1;

    const moves: Array<{ leadId: string; broker: string | null; from: string | null; to: string; reason: string }> = [];
    const skipped = { deadStage: 0, noChange: 0, terminal: 0, emptyDialog: 0, backward: 0, failed: 0 };
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

      if (!allowBackward) {
        const fromIdx = orderOf(lead.leadStage);
        const toIdx = orderOf(state.stage.name);
        if (fromIdx >= 0 && toIdx >= 0 && toIdx <= fromIdx) {
          skipped.backward++;
          continue;
        }
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
      { pipeline, broker, scanned: rows.length, proposed: moves.length, applied, apply, allowBackward },
      "reclassify-stages finished",
    );

    res.json({
      mode: apply ? "applied" : "dry run — pass ?apply=1 to move the cards",
      direction: allowBackward ? "forward and backward" : "forward only (?allowBackward=1 to lift)",
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
