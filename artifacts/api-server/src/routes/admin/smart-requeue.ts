import { Router } from "express";
import { db, leadsSyncTable, pendingSuggestionsTable } from "@workspace/db";
import { eq, and, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { parseDialogContent } from "../../lib/dialog-parser";
import { shouldSuppressPush } from "../../lib/stage-routing";
import { getPushStageWhitelist, isPushStageAllowed } from "../../lib/push-stage-whitelist";

const router = Router();

/**
 * POST /api/admin/smart-requeue
 *
 * 1. Clears ALL pending push + live suggestions
 * 2. Resets nextFollowupAt for all leads
 * 3. Parses each lead's conversation content to determine who wrote last
 * 4. Updates lastMessageFrom in DB based on actual content (corrects stale values)
 * 5. For leads where WE wrote last (or no messages) + stage is in whitelist →
 *    sets nextFollowupAt=NOW() so scheduler generates push suggestions
 * 6. For leads where the LEAD wrote last → scheduler's processUnansweredLive()
 *    will generate live suggestions on next tick
 *
 * Optional body: { broker?: string }  (default: all brokers)
 */
router.post("/admin/smart-requeue", async (req, res) => {
  const { broker } = (req.body ?? {}) as { broker?: string };

  try {
    // ── 1. Clear ALL pending suggestions ─────────────────────────────────────
    const deleted = await db
      .delete(pendingSuggestionsTable)
      .where(eq(pendingSuggestionsTable.status, "pending"));
    const deletedCount = (deleted as unknown as { rowCount?: number }).rowCount ?? 0;

    // ── 2. Reset nextFollowupAt for all leads ─────────────────────────────────
    const resetResult = await db
      .update(leadsSyncTable)
      .set({ nextFollowupAt: null });
    const resetCount = (resetResult as unknown as { rowCount?: number }).rowCount ?? 0;

    // ── 3. Fetch all active leads with content ────────────────────────────────
    const allLeads = await db
      .select({
        leadId: leadsSyncTable.leadId,
        responsibleUser: leadsSyncTable.responsibleUser,
        content: leadsSyncTable.content,
        leadStage: leadsSyncTable.leadStage,
        botExcluded: leadsSyncTable.botExcluded,
        lastMessageFrom: leadsSyncTable.lastMessageFrom,
      })
      .from(leadsSyncTable)
      .where(isNotNull(leadsSyncTable.leadStage));

    const pushWhitelist = await getPushStageWhitelist();

    let pushQueued = 0;
    let liveQueued = 0;
    let suppressed = 0;
    let contentFixed = 0;

    const now = new Date();

    const pushLeadIds: string[] = [];
    const liveLeadIds: string[] = [];

    for (const lead of allLeads) {
      if (lead.botExcluded) { suppressed++; continue; }

      // Filter by broker if specified
      if (broker && lead.responsibleUser !== broker) continue;

      const stage = lead.leadStage ?? "";

      // Skip permanently dead stages (NOT ACTIVE, COLD LEADS, closed, lost, etc.)
      if (stage && shouldSuppressPush(stage)) { suppressed++; continue; }

      // ── 4. Parse content to find who wrote last ───────────────────────────
      let lastFrom: "us" | "lead" | null = null;
      if (lead.content) {
        try {
          const parsed = parseDialogContent(lead.content);
          if (parsed.lastMessage) {
            lastFrom = parsed.lastMessage.from === "lead" ? "lead" : "us";
          }
        } catch { /* ignore parse errors */ }
      }

      // Update DB if content-based value differs from stored value
      if (lastFrom !== null && lastFrom !== lead.lastMessageFrom) {
        await db
          .update(leadsSyncTable)
          .set({ lastMessageFrom: lastFrom })
          .where(eq(leadsSyncTable.leadId, lead.leadId));
        contentFixed++;
      }

      const effectiveLastFrom = lastFrom ?? lead.lastMessageFrom;

      if (effectiveLastFrom === "lead") {
        // Lead wrote last → needs LIVE response (all non-suppressed stages)
        liveLeadIds.push(lead.leadId);
        liveQueued++;
      } else {
        // We wrote last (or no messages) → PUSH only if stage is in whitelist
        if (!isPushStageAllowed(pushWhitelist, stage)) { suppressed++; continue; }
        pushLeadIds.push(lead.leadId);
        pushQueued++;
      }
    }

    // ── 5. Set nextFollowupAt=NOW() ONLY for push leads with no scheduled time ─
    // Leads that already have a future nextFollowupAt keep their existing schedule;
    // the scheduler will generate their suggestion 2h before it's due automatically.
    if (pushLeadIds.length > 0) {
      for (let i = 0; i < pushLeadIds.length; i += 200) {
        const chunk = pushLeadIds.slice(i, i + 200);
        await db
          .update(leadsSyncTable)
          .set({ nextFollowupAt: now, followupLevel: 0 })
          .where(
            and(
              inArray(leadsSyncTable.leadId, chunk),
              isNull(leadsSyncTable.nextFollowupAt),
            ),
          );
      }
    }

    // ── 6. Mark live leads so processUnansweredLive() will pick them up ──────
    if (liveLeadIds.length > 0) {
      for (let i = 0; i < liveLeadIds.length; i += 200) {
        const chunk = liveLeadIds.slice(i, i + 200);
        await db
          .update(leadsSyncTable)
          .set({ lastMessageFrom: "lead" })
          .where(inArray(leadsSyncTable.leadId, chunk));
      }
    }

    req.log.info(
      { deletedCount, resetCount, pushQueued, liveQueued, suppressed, contentFixed, broker: broker ?? "all" },
      "smart-requeue complete",
    );

    res.json({
      ok: true,
      broker: broker ?? "all",
      deletedSuggestions: deletedCount,
      resetLeads: resetCount,
      pushQueued,
      liveQueued,
      suppressed,
      contentFixed,
      message: `Очередь очищена (${deletedCount} suggestions). ${pushQueued} лидов → push, ${liveQueued} → live, ${suppressed} пропущено. Исправлено lastMessageFrom по контенту: ${contentFixed}. Шедулер обработает за ~5 мин.`,
    });
  } catch (err) {
    req.log.error({ err }, "smart-requeue error");
    res.status(500).json({ ok: false, error: String(err) });
  }
});

export default router;
