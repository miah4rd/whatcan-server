import { Router } from "express";
import { db, leadsSyncTable, pendingSuggestionsTable, stageEventsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { shouldSuppressPush } from "../lib/stage-routing";
import { getTemplateForStage } from "../lib/followup-templates";

const router = Router();

router.post("/amocrm/sync-stage", async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const leadId = body["leadId"] as string | undefined;
  const responsibleUser = (body["responsibleUser"] as string | undefined) ?? null;
  const pipeline = (body["pipeline"] as string | undefined) ?? null;
  const stage = (body["stage"] as string | undefined) ?? null;

  if (!leadId || typeof leadId !== "string") {
    res.status(400).json({ error: "leadId required" });
    return;
  }

  req.log.info({ leadId, pipeline, stage }, "amocrm sync-stage received");

  res.json({ ok: true, leadId });

  try {
    const existing = await db
      .select({ leadStage: leadsSyncTable.leadStage, responsibleUser: leadsSyncTable.responsibleUser })
      .from(leadsSyncTable)
      .where(eq(leadsSyncTable.leadId, leadId))
      .limit(1);

    const prevStage = existing[0]?.leadStage ?? null;

    await db
      .insert(leadsSyncTable)
      .values({
        leadId,
        responsibleUser,
        pipeline: pipeline ?? undefined,
        leadStage: stage ?? undefined,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: leadsSyncTable.leadId,
        set: {
          ...(responsibleUser !== null ? { responsibleUser } : {}),
          ...(pipeline !== null ? { pipeline } : {}),
          ...(stage !== null ? { leadStage: stage } : {}),
          updatedAt: new Date(),
        },
      });

    req.log.info({ leadId, pipeline, stage }, "sync-stage: leads_sync updated");

    if (stage !== null && stage !== prevStage) {
      await db.insert(stageEventsTable).values({
        leadId,
        fromStage: prevStage,
        toStage: stage,
        pipeline: pipeline ?? undefined,
        responsibleUser: responsibleUser ?? existing[0]?.responsibleUser ?? undefined,
      });
    }

    // If lead moved to a dead stage — immediately cancel all pending suggestions
    if (stage && shouldSuppressPush(stage)) {
      await db
        .update(pendingSuggestionsTable)
        .set({ status: "skipped" })
        .where(
          and(
            eq(pendingSuggestionsTable.leadId, leadId),
            eq(pendingSuggestionsTable.status, "pending"),
          ),
        );
      req.log.info({ leadId, stage }, "sync-stage dead-stage: all pending suggestions cancelled");
      return;
    }

    // If lead moved to a new stage that has a pre-written template AND the stage
    // actually changed — cancel stale pending suggestions and schedule immediate
    // regeneration so the broker sees the correct message for the new stage.
    if (stage && stage !== prevStage && getTemplateForStage(stage)) {
      await db
        .update(pendingSuggestionsTable)
        .set({ status: "skipped" })
        .where(
          and(
            eq(pendingSuggestionsTable.leadId, leadId),
            eq(pendingSuggestionsTable.status, "pending"),
          ),
        );
      await db
        .update(leadsSyncTable)
        .set({ nextFollowupAt: new Date() })
        .where(eq(leadsSyncTable.leadId, leadId));
      req.log.info({ leadId, stage }, "sync-stage: stale suggestions cleared, rescheduled for immediate regeneration");
    }
  } catch (err) {
    req.log.error({ err, leadId }, "sync-stage: DB error");
  }
});

export default router;
