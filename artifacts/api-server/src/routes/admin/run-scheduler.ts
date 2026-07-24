import { Router } from "express";
import { processFollowups, processUnansweredLive } from "../../lib/followup-scheduler";
import { syncTaskSchedule } from "../../lib/amo-sync";
import { logger } from "../../lib/logger";
import { db, pendingSuggestionsTable, leadsSyncTable } from "@workspace/db";
import { and, eq, lt, inArray, isNotNull, sql } from "drizzle-orm";
import { refreshLeadProfile } from "../../lib/lead-profile";
import { parseDialogContent, countTrailingOurMessages } from "../../lib/dialog-parser";

const router = Router();

/**
 * POST /api/admin/backfill-profiles
 * One-time (idempotent) backfill of the distilled lead profile + discard flag
 * for Robert's active-funnel PUSH leads, so the adaptive ranking has data to
 * work with without waiting for every lead to regenerate. Bounded by ?limit
 * (default 80). refreshLeadProfile is cached, so re-running is cheap.
 */
router.post("/admin/backfill-profiles", async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query["limit"]) || 80));
  try {
    const rows = await db
      .select()
      .from(leadsSyncTable)
      .where(
        and(
          eq(leadsSyncTable.responsibleUser, "Robert"),
          eq(leadsSyncTable.botExcluded, false),
          isNotNull(leadsSyncTable.content),
        ),
      )
      .orderBy(sql`CASE WHEN ${leadsSyncTable.leadId} ~ '^[0-9]+$' THEN ${leadsSyncTable.leadId}::bigint ELSE 0 END DESC`)
      .limit(limit);

    const active = rows.filter((r) => {
      const s = (r.leadStage ?? "").toLowerCase();
      return s.includes("contact established") || s.includes("needs assessed") || s.includes("options sent") || s.includes("option send");
    });

    let profiled = 0;
    let flagged = 0;
    const now = new Date();
    for (const lead of active) {
      try {
        const profile = await refreshLeadProfile({
          leadId: lead.leadId,
          responsibleUser: lead.responsibleUser,
          content: lead.content,
          leadStage: lead.leadStage,
          leadNotes: lead.leadNotes,
          profileSourceMsgAt: lead.profileSourceMsgAt,
          stored: lead,
        });
        if (profile) profiled++;

        const parsed = parseDialogContent(lead.content ?? "");
        const streak = countTrailingOurMessages(parsed.messages);
        const ageDays = lead.amoCreatedAt ? Math.floor((now.getTime() - lead.amoCreatedAt.getTime()) / 86400000) : 0;
        const everEngaged = parsed.messages.some((m) => m.from === "lead" && m.text.trim().length > 25);
        const deadByContent = profile?.alive === "dead_candidate";
        const deadBySilence = !everEngaged && streak >= 5 && ageDays > 60;
        if ((deadByContent || deadBySilence) && !lead.discardFlaggedAt) {
          await db
            .update(leadsSyncTable)
            .set({
              discardFlaggedAt: new Date(),
              discardReason: deadByContent ? (profile?.summary || "content indicates the lead is no longer active") : "long silence, never engaged, many unanswered touches",
            })
            .where(eq(leadsSyncTable.leadId, lead.leadId));
          flagged++;
        }
      } catch (err) {
        logger.error({ err, leadId: lead.leadId }, "backfill-profiles: lead failed (non-fatal)");
      }
    }
    logger.info({ scanned: active.length, profiled, flagged }, "admin: backfill-profiles complete");
    res.json({ ok: true, scanned: active.length, profiled, flagged });
  } catch (err) {
    logger.error({ err }, "admin: backfill-profiles error");
    res.status(500).json({ error: String(err) });
  }
});

/**
 * POST /api/admin/run-scheduler
 * Immediately runs one full followup-scheduler tick on PROD (both the
 * task-driven PUSH pass and the unanswered-LIVE pass, same as the periodic
 * background scheduler). Use when suggestions need to be regenerated
 * without waiting 5 min.
 */
router.post("/admin/run-scheduler", async (_req, res) => {
  try {
    logger.info("admin: manual scheduler run triggered");
    await processFollowups();
    await processUnansweredLive();
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
