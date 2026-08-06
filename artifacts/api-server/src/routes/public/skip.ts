import { Router } from "express";
import { db, pendingSuggestionsTable, leadsSyncTable, leadCrmTasksTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { parseDialogContent, formatDialogForAI, nextFollowupDate, countTrailingOurMessages } from "../../lib/dialog-parser";
import { generateSuggestion } from "../amocrm-webhook";
import { isStageWhitelisted } from "../../lib/stage-routing";
import { computeNextFollowupDays, isAdaptiveBroker } from "../../lib/adaptive-followup";
import { createAmoTask, closeAmoTasksForLead, getAmoLead } from "../../lib/amo-client.js";

const router = Router();

router.options("/skip", (_req, res) => res.sendStatus(204));

router.post("/skip", async (req, res) => {
  const body = req.body as { suggestionId?: string };

  if (!body?.suggestionId || typeof body.suggestionId !== "string") {
    res.status(400).json({ error: "Invalid payload" });
    return;
  }

  try {
    // Fetch the suggestion before skipping so we know its kind and leadId
    const [suggestion] = await db
      .select()
      .from(pendingSuggestionsTable)
      .where(
        and(
          eq(pendingSuggestionsTable.id, body.suggestionId as any),
          eq(pendingSuggestionsTable.status, "pending"),
        ),
      )
      .limit(1);

    await db
      .update(pendingSuggestionsTable)
      .set({ status: "skipped" })
      .where(
        and(
          eq(pendingSuggestionsTable.id, body.suggestionId as any),
          eq(pendingSuggestionsTable.status, "pending"),
        ),
      );

    // When a push is skipped: if the lead wrote last and qualifies, immediately
    // generate a live suggestion so the lead moves to the live queue right away
    // (instead of waiting up to 5 min for the scheduler to pick it up).
    if (suggestion?.kind === "push") {
      const leadId = suggestion.leadId;
      const [sync] = await db
        .select()
        .from(leadsSyncTable)
        .where(eq(leadsSyncTable.leadId, leadId))
        .limit(1);

      let becameLive = false;

      if (
        sync?.lastMessageFrom === "lead" &&
        isStageWhitelisted(sync.leadStage) &&
        sync.content
      ) {
        // Check no live suggestion already exists
        const [existingLive] = await db
          .select({ id: pendingSuggestionsTable.id })
          .from(pendingSuggestionsTable)
          .where(
            and(
              eq(pendingSuggestionsTable.leadId, leadId),
              eq(pendingSuggestionsTable.kind, "live"),
              eq(pendingSuggestionsTable.status, "pending"),
            ),
          )
          .limit(1);

        if (!existingLive) {
          try {
            const parsed = parseDialogContent(sync.content);
            const lastLeadMessage = parsed.lastLeadMessage?.text ?? "";
            const contentSnippet = formatDialogForAI(parsed.messages);

            if (lastLeadMessage) {
              const { text, attachments } = await generateSuggestion({
                leadId,
                responsibleUser: sync.responsibleUser ?? null,
                kind: "live",
                lastLeadMessage,
                contentSnippet,
                leadNotes: sync.leadNotes ?? null,
                leadStage: sync.leadStage ?? null,
                pipeline: sync.pipeline,
              });

              if (text) {
                await db.insert(pendingSuggestionsTable).values({
                  leadId,
                  responsibleUser: sync.responsibleUser ?? null,
                  kind: "live",
                  followupLevel: null,
                  suggestionText: text,
                  status: "pending",
                  attachments,
                });
                becameLive = true;
                req.log.info({ leadId }, "skip: generated live suggestion after push skip");
              }
            }
          } catch (err) {
            req.log.warn({ err, leadId }, "skip: failed to generate live after push skip (non-fatal)");
          }
        }
      }

      // Continue auto schedule: this touch was skipped, so ADVANCE the follow-up
      // clock — close the current (due) task and schedule the next one, so the lead
      // re-surfaces later instead of sitting due with nothing changed. (Skipped
      // before: /skip only marked the suggestion, touched no task at all.)
      if (!becameLive) {
        try {
          const isRental = (sync?.pipeline ?? "").toLowerCase() === "rental";
          const stageLower = (sync?.leadStage ?? "").toLowerCase();
          const isReach =
            stageLower.includes("1st follow up") ||
            stageLower.includes("2nd follow up") ||
            stageLower.includes("final follow up");
          let taskDate: Date;
          if (!isRental && !isReach && isAdaptiveBroker(sync?.responsibleUser)) {
            const parsed = parseDialogContent(sync?.content ?? "");
            const streak = countTrailingOurMessages(parsed.messages) + 1;
            const ageDays = sync?.amoCreatedAt ? Math.floor((Date.now() - sync.amoCreatedAt.getTime()) / 86400000) : null;
            const d = computeNextFollowupDays({ streak, leadStage: sync?.leadStage, temperature: (sync?.profileTemperature as "cold" | "warm" | "hot" | null) ?? undefined, ageDays });
            taskDate = new Date(Date.now() + d * 86400000);
          } else {
            const level = Math.max(0, suggestion.followupLevel ?? 0);
            taskDate = nextFollowupDate(new Date(), level) ?? new Date(Date.now() + 3 * 86400000);
          }
          await db.update(leadCrmTasksTable).set({ status: "closed", closedAt: new Date() }).where(and(eq(leadCrmTasksTable.leadId, leadId), eq(leadCrmTasksTable.status, "open")));
          await closeAmoTasksForLead(leadId).catch(() => {});
          await db.update(leadsSyncTable).set({ nextFollowupAt: taskDate }).where(eq(leadsSyncTable.leadId, leadId));
          let amoOk = false;
          try {
            const amoLead = await getAmoLead(leadId);
            amoOk = await createAmoTask(leadId, "Follow-up отложен (skip) — следующий touch по графику", taskDate, amoLead?.responsible_user_id ?? undefined);
          } catch { /* non-fatal */ }
          await db.insert(leadCrmTasksTable).values({ leadId, taskDate, taskText: "Follow-up отложен (skip) — следующий touch", webhookStatus: amoOk ? 200 : 500, webhookResponse: amoOk ? "created via API (skip continue)" : "amo task create failed" });
          req.log.info({ leadId, taskDate }, "skip continue: advanced follow-up schedule");
        } catch (err) {
          req.log.warn({ err, leadId }, "skip continue: reschedule failed (non-fatal)");
        }
      }
    }

    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "skip error");
    res.status(500).json({ error: "DB error" });
  }
});

export default router;
