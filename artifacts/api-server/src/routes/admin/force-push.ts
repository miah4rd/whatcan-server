import { Router } from "express";
import { db, leadsSyncTable, pendingSuggestionsTable, aiSuggestionsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { isStageWhitelisted, shouldSuppressPush } from "../../lib/stage-routing";
import { generateFollowup } from "../../lib/followup-scheduler";
import { getFollowupSteps } from "../../lib/settings";

const router = Router();

/**
 * POST /api/admin/force-push
 * Immediately generates a warmup push suggestion for a single lead,
 * bypassing the 15-min scheduler timer. Useful when a lead was created
 * before the warmup rule was deployed, or for manual intervention.
 *
 * Body: { leadId: string }
 */
router.post("/admin/force-push", async (req, res) => {
  const { leadId } = req.body as { leadId?: string };
  if (!leadId) {
    res.status(400).json({ error: "leadId required" });
    return;
  }

  try {
    const [lead] = await db
      .select()
      .from(leadsSyncTable)
      .where(eq(leadsSyncTable.leadId, String(leadId)))
      .limit(1);

    if (!lead) {
      res.status(404).json({ error: "lead not found" });
      return;
    }

    if (lead.leadStage && shouldSuppressPush(lead.leadStage)) {
      res.json({ ok: false, skipped: true, reason: "stage suppressed", stage: lead.leadStage });
      return;
    }

    if (!isStageWhitelisted(lead.leadStage)) {
      res.json({ ok: false, skipped: true, reason: "stage not in whitelist", stage: lead.leadStage });
      return;
    }

    // Check no pending push already exists
    const existing = await db
      .select({ id: pendingSuggestionsTable.id })
      .from(pendingSuggestionsTable)
      .where(
        and(
          eq(pendingSuggestionsTable.leadId, String(leadId)),
          eq(pendingSuggestionsTable.status, "pending"),
          eq(pendingSuggestionsTable.kind, "push"),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      res.json({ ok: false, skipped: true, reason: "push suggestion already pending for this lead" });
      return;
    }

    const steps = await getFollowupSteps();

    const generated = await generateFollowup({
      leadId: String(leadId),
      responsibleUser: lead.responsibleUser,
      followupLevel: 1,
      lastContent: lead.content ?? "",
      leadNotes: lead.leadNotes,
    });

    if (!generated.text) {
      res.status(500).json({ error: "AI returned empty text" });
      return;
    }

    const brokerId = (lead.responsibleUser ?? "unknown").toLowerCase().slice(0, 64);

    await db.insert(aiSuggestionsTable).values({
      brokerId,
      leadId: String(leadId),
      leadName: `Lead #${leadId}`,
      promptMessages: [],
      suggestionText: generated.text,
      rationale: `Warmup (manual) — first follow-up forced via admin. ${generated.entry.label}.`,
      model: "claude-sonnet-4-20250514",
    });

    await db.insert(pendingSuggestionsTable).values({
      leadId: String(leadId),
      responsibleUser: lead.responsibleUser,
      kind: "push",
      followupLevel: 0,
      suggestionText: generated.text,
      status: "pending",
      objectionCategory: generated.entry.id,
      attachments: [],
    });

    // Advance lead to level 0 so next scheduler step is follow-up #1 in 23h
    const nextAt = new Date(Date.now() + steps[0]!.delayMs);
    await db
      .update(leadsSyncTable)
      .set({ followupLevel: 0, nextFollowupAt: nextAt })
      .where(eq(leadsSyncTable.leadId, String(leadId)));

    req.log.info({ leadId, objection: generated.entry.id, nextAt }, "force-push: warmup queued");

    res.json({
      ok: true,
      leadId,
      preview: generated.text.slice(0, 120),
      nextFollowupAt: nextAt,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err, leadId }, "force-push failed");
    res.status(500).json({ error: msg.slice(0, 300) });
  }
});

export default router;
