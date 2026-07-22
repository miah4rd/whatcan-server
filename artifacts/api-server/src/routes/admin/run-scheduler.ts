import { Router } from "express";
import { processFollowups } from "../../lib/followup-scheduler";
import { syncTaskSchedule } from "../../lib/amo-sync";
import { logger } from "../../lib/logger";
import { db, pendingSuggestionsTable, leadsSyncTable } from "@workspace/db";
import { and, eq, lt, inArray } from "drizzle-orm";

const router = Router();

/**
 * POST /api/admin/run-scheduler
 * Immediately runs one full followup-scheduler tick on PROD.
 * Use when push suggestions need to be regenerated without waiting 5 min.
 */
router.post("/admin/run-scheduler", async (_req, res) => {
  try {
    logger.info("admin: manual scheduler run triggered");
    await processFollowups();
    logger.info("admin: manual scheduler run complete");
    res.json({ ok: true, message: "Scheduler run complete. Check PUSH tab in extension." });
  } catch (err) {
    logger.error({ err }, "admin: manual scheduler run error");
    res.status(500).json({ error: String(err) });
  }
});

/**
 * POST /api/admin/sync-tasks
 * Re-syncs amoCRM task due dates → nextFollowupAt in DB.
 * Use to restore "Today/Overdue/In Nd" badges in REACH tab after nextFollowupAt was cleared.
 */
router.post("/admin/sync-tasks", async (_req, res) => {
  try {
    logger.info("admin: manual sync-tasks triggered");
    await syncTaskSchedule();
    logger.info("admin: manual sync-tasks complete");
    res.json({ ok: true, message: "Task schedule synced from amoCRM. Reload extension." });
  } catch (err) {
    logger.error({ err }, "admin: manual sync-tasks error");
    res.status(500).json({ error: String(err) });
  }
});

/**
 * POST /api/admin/clean-stale-pushes
 * Deletes pending push suggestions for leads whose nextFollowupAt is older than
 * today midnight Bali time. These are stale suggestions generated from old
 * bulk-push dates when no active amoCRM task exists today.
 */
router.post("/admin/clean-stale-pushes", async (_req, res) => {
  try {
    const BALI_OFFSET_MS = 8 * 60 * 60 * 1000;
    const now = new Date();
    const nowBali = new Date(now.getTime() + BALI_OFFSET_MS);
    const todayStartBali = new Date(
      Date.UTC(nowBali.getUTCFullYear(), nowBali.getUTCMonth(), nowBali.getUTCDate()) - BALI_OFFSET_MS
    );

    // Find leads with stale nextFollowupAt (before today midnight Bali)
    const staleLeads = await db
      .select({ leadId: leadsSyncTable.leadId })
      .from(leadsSyncTable)
      .where(lt(leadsSyncTable.nextFollowupAt, todayStartBali));

    if (staleLeads.length === 0) {
      return res.json({ ok: true, deleted: 0, message: "No stale leads found." });
    }

    const staleIds = staleLeads.map((l) => l.leadId);
    const result = await db
      .delete(pendingSuggestionsTable)
      .where(
        and(
          inArray(pendingSuggestionsTable.leadId, staleIds),
          eq(pendingSuggestionsTable.status, "pending"),
          eq(pendingSuggestionsTable.kind, "push"),
        ),
      );

    const deleted = (result as unknown as { rowCount?: number }).rowCount ?? 0;
    logger.info({ deleted, staleLeadCount: staleLeads.length, cutoff: todayStartBali }, "admin: clean-stale-pushes complete");
    return res.json({ ok: true, deleted, staleLeads: staleLeads.length, cutoff: todayStartBali });
  } catch (err) {
    logger.error({ err }, "admin: clean-stale-pushes error");
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
