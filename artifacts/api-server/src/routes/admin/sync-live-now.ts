import { Router } from "express";
import { db, leadsSyncTable, pendingSuggestionsTable, leadMessagesTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { syncOutgoingEvents } from "../../lib/amo-sync";
import { parseDialogContent } from "../../lib/dialog-parser";
import { logger } from "../../lib/logger";

const router = Router();

/**
 * POST /api/admin/sync-live-now
 *
 * Deep-sync LIVE suggestions:
 * 1. Polls amoCRM outgoing events for the last 24h (catches phone WhatsApp messages
 *    that the 30-min periodic poller may have missed).
 * 2. Also re-checks DB content for every remaining LIVE suggestion — if the stored
 *    dialog shows "us" sent the last message, clears the LIVE entry immediately.
 *
 * Safe to call any time. Does not delete LIVE suggestions for leads that genuinely
 * still have an unanswered incoming message.
 */
router.post("/admin/sync-live-now", async (req, res) => {
  try {
    // Step 1: deep outgoing-event poll (last 24 h)
    const clearedByEvents = await syncOutgoingEvents(24 * 60 * 60 * 1000);

    // Step 2: content-based stale check for all remaining LIVE suggestions
    const pending = await db
      .select({
        id: pendingSuggestionsTable.id,
        leadId: pendingSuggestionsTable.leadId,
      })
      .from(pendingSuggestionsTable)
      .where(
        and(
          eq(pendingSuggestionsTable.status, "pending"),
          eq(pendingSuggestionsTable.kind, "live"),
        ),
      );

    let clearedByContent = 0;
    for (const row of pending) {
      const [sync] = await db
        .select({ content: leadsSyncTable.content, lastMessageFrom: leadsSyncTable.lastMessageFrom })
        .from(leadsSyncTable)
        .where(eq(leadsSyncTable.leadId, row.leadId))
        .limit(1);

      if (!sync) continue;

      // If DB already marks broker replied, or content shows broker last — clear LIVE
      let shouldClear = sync.lastMessageFrom === "us";
      let contentLastMs = 0;
      if (sync.content) {
        try {
          const parsed = parseDialogContent(sync.content);
          contentLastMs = parsed.lastMessage?.at?.getTime() ?? 0;
          if (!shouldClear && parsed.lastMessage?.from === "us") shouldClear = true;
        } catch { /* ignore */ }
      }

      // Both signals above come from leads_sync, which is webhook-fed and for
      // some channels (Instagram) silently stops updating. If the timeline has a
      // lead message newer than content knows about, the lead really is waiting
      // on us — deleting their LIVE here would lose a valid suggestion.
      if (shouldClear) {
        const [newest] = await db
          .select({ senderType: leadMessagesTable.senderType, sentAt: leadMessagesTable.sentAt })
          .from(leadMessagesTable)
          .where(eq(leadMessagesTable.leadId, row.leadId))
          .orderBy(desc(leadMessagesTable.sentAt))
          .limit(1);
        if (newest && newest.senderType === "lead" && newest.sentAt.getTime() > contentLastMs + 60_000) {
          shouldClear = false;
        }
      }

      if (!shouldClear) continue;

      await db
        .delete(pendingSuggestionsTable)
        .where(
          and(
            eq(pendingSuggestionsTable.id, row.id),
            eq(pendingSuggestionsTable.status, "pending"),
            eq(pendingSuggestionsTable.kind, "live"),
          ),
        );

      clearedByContent++;
      logger.info({ leadId: row.leadId }, "sync-live-now: stale LIVE cleared by content check");
    }

    logger.info({ clearedByEvents, clearedByContent }, "sync-live-now: done");

    res.json({
      ok: true,
      cleared_by_outgoing_events: clearedByEvents,
      cleared_by_content_check: clearedByContent,
      total_cleared: clearedByEvents + clearedByContent,
    });
  } catch (err) {
    logger.error({ err }, "sync-live-now: error");
    res.status(500).json({ ok: false, error: String(err) });
  }
});

export default router;
