import { Router } from "express";
import { db, pendingSuggestionsTable, leadsSyncTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { parseDialogContent, formatDialogForAI } from "../../lib/dialog-parser";
import { generateSuggestion } from "../amocrm-webhook";
import { isStageWhitelisted } from "../../lib/stage-routing";

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
              const text = await generateSuggestion({
                leadId,
                responsibleUser: sync.responsibleUser ?? null,
                kind: "live",
                lastLeadMessage,
                contentSnippet,
                leadNotes: sync.leadNotes ?? null,
                leadStage: sync.leadStage ?? null,
              });

              if (text) {
                await db.insert(pendingSuggestionsTable).values({
                  leadId,
                  responsibleUser: sync.responsibleUser ?? null,
                  kind: "live",
                  followupLevel: null,
                  suggestionText: text,
                  status: "pending",
                });
                req.log.info({ leadId }, "skip: generated live suggestion after push skip");
              }
            }
          } catch (err) {
            req.log.warn({ err, leadId }, "skip: failed to generate live after push skip (non-fatal)");
          }
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
