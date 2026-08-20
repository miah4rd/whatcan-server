import { Router } from "express";
import { processFollowups, processUnansweredLive } from "../../lib/followup-scheduler";
import { syncTaskSchedule } from "../../lib/amo-sync";
import { logger } from "../../lib/logger";
import { db, pendingSuggestionsTable, leadsSyncTable } from "@workspace/db";
import { and, eq, lt, inArray, isNotNull, sql } from "drizzle-orm";
import { reconcileTasksAfterManualReply } from "../../lib/manual-reply-followup";
import { shouldSuppressPush } from "../../lib/stage-routing";
import { refreshLeadProfile } from "../../lib/lead-profile";
import { parseDialogContent, countTrailingOurMessages } from "../../lib/dialog-parser";
import { refreshLeadFromTimeline } from "../../lib/amo-timeline-sync";
import { sendDailyReports } from "../../lib/report-scheduler";
import { testAiOutageAlert } from "../../lib/ai-watchdog";

const router = Router();

/**
 * POST /admin/refresh-lead  { leadId }
 * Re-reads ONE lead straight from the amoCRM timeline and, if the lead has
 * replied since we last knew, queues a LIVE suggestion. Fixes a single
 * out-of-sync lead without waiting on the ~12-minute full sweep.
 */
router.post("/admin/refresh-lead", async (req, res) => {
  const { leadId } = req.body as { leadId?: string };
  if (!leadId) return void res.status(400).json({ error: "leadId required" });
  const result = await refreshLeadFromTimeline(String(leadId).trim());
  res.json(result);
});

/**
 * POST /api/admin/backfill-profiles
 * One-time (idempotent) backfill of the distilled lead profile + discard flag
 * for Robert's active-funnel PUSH leads, so the adaptive ranking has data to
 * work with without waiting for every lead to regenerate. Bounded by ?limit
 * (default 80). refreshLeadProfile is cached, so re-running is cheap.
 */
router.post("/admin/backfill-profiles", async (req, res) => {
  const limit = Math.min(300, Math.max(1, Number(req.query["limit"]) || 80));
  const broker = (req.query["broker"] as string | undefined)?.trim() || "Robert";
  try {
    const rows = await db
      .select()
      .from(leadsSyncTable)
      .where(
        and(
          eq(leadsSyncTable.responsibleUser, broker),
          eq(leadsSyncTable.botExcluded, false),
          isNotNull(leadsSyncTable.content),
        ),
      )
      .orderBy(sql`CASE WHEN ${leadsSyncTable.leadId} ~ '^[0-9]+$' THEN ${leadsSyncTable.leadId}::bigint ELSE 0 END DESC`)
      .limit(limit);

    const active = rows.filter((r) => {
      const s = (r.leadStage ?? "").toLowerCase();
      // All active-funnel stages (CE → Negotiation), not just the first three.
      // Mirrors the expanded push whitelist so the later stages (Zoom / Viewing /
      // Feedback / Contract / Reservation / Negotiation) also get profiles.
      return (
        s.includes("contact established") ||
        s.includes("needs assessed") ||
        s.includes("options sent") || s.includes("option send") ||
        s.includes("zoom call") ||
        s.includes("viewing") ||
        s.includes("feedback") || s.includes("handling objection") ||
        s.includes("reservation") || s.includes("negotiation") || s.includes("contract")
      );
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
    logger.info({ broker, scanned: active.length, profiled, flagged }, "admin: backfill-profiles complete");
    res.json({ ok: true, broker, scanned: active.length, profiled, flagged });
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
 * POST /api/admin/send-daily-report[?broker=hos]
 * Sends the morning report push now instead of waiting for 08:00 Bali.
 * With ?broker it goes to that one person only and does NOT mark the day as
 * done, so a test send never swallows the real one.
 */
router.post("/admin/send-daily-report", async (req, res) => {
  const only = (req.query["broker"] as string | undefined)?.trim();
  try {
    const sent = await sendDailyReports(only ? { only } : { force: true });
    res.json({ ok: true, sent, only: only ?? null });
  } catch (err) {
    logger.error({ err }, "admin: send-daily-report error");
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

/**
 * POST /api/admin/repair-manual-reply-overdue[?dry=1]
 * One-time sweep for leads pinned "Overdue Nd" by a stale open amoCRM task:
 * the broker's own manual reply IS recorded (lastOurMessageAt), but the clock
 * sits before it in the past because syncTaskSchedule re-pins it to the open
 * overdue task every 5 minutes. The forward fix (manual-reply-followup.ts,
 * called from the timeline sweep) only fires on NEW replies — this clears the
 * backlog that accumulated before it shipped. Closes the stale task, creates
 * a fresh chase task from the reply (clamped to now), and unpins the clock.
 * Never moves a stage ("repair" mode). ?dry=1 lists candidates only.
 */
router.post("/admin/repair-manual-reply-overdue", async (req, res) => {
  const dry = req.query["dry"] === "1";
  try {
    const now = new Date();
    const rows = await db
      .select({
        leadId: leadsSyncTable.leadId,
        pipeline: leadsSyncTable.pipeline,
        leadStage: leadsSyncTable.leadStage,
        responsibleUser: leadsSyncTable.responsibleUser,
        lastOurMessageAt: leadsSyncTable.lastOurMessageAt,
        nextFollowupAt: leadsSyncTable.nextFollowupAt,
      })
      .from(leadsSyncTable)
      .where(
        and(
          // Deliberately NOT filtered on lastMessageFrom: the pinned state has
          // been seen with that flag stuck on 'lead' while our own message was
          // provably newer (Anna / 23195927).
          sql`${leadsSyncTable.botExcluded} IS NOT TRUE`,
          isNotNull(leadsSyncTable.nextFollowupAt),
          lt(leadsSyncTable.nextFollowupAt, now),
          isNotNull(leadsSyncTable.lastOurMessageAt),
          // "The clock does not reflect our last reply." A healthy lead is
          // chased ~24h AFTER we wrote, so next_followup_at sits at least a day
          // past last_our_message_at. Anything closer means the clock was set by
          // an EARLIER send and the reply never moved it — both the reply-after-
          // due case (Anna) and the reply-before-due case this misses otherwise
          // (Larissalara / 23213079: answered 12:59, task due 13:28, overdue for
          // four days). A genuine pending follow-up — bot wrote, client silent,
          // broker has not approved the draft yet — is ~24h out and not touched.
          sql`${leadsSyncTable.nextFollowupAt} < ${leadsSyncTable.lastOurMessageAt} + interval '20 hours'`,
        ),
      );

    const candidates = rows.filter((r) => !shouldSuppressPush(r.leadStage ?? ""));
    if (dry) {
      return void res.json({
        ok: true,
        dry: true,
        candidates: candidates.map((c) => ({
          leadId: c.leadId,
          pipeline: c.pipeline,
          leadStage: c.leadStage,
          responsibleUser: c.responsibleUser,
          lastOurMessageAt: c.lastOurMessageAt,
          nextFollowupAt: c.nextFollowupAt,
        })),
      });
    }

    const results: Array<{ leadId: string; action: string; due?: Date }> = [];
    for (const c of candidates) {
      try {
        const r = await reconcileTasksAfterManualReply({
          leadId: c.leadId,
          sentAt: c.lastOurMessageAt ?? now,
          pipeline: c.pipeline,
          leadStage: c.leadStage,
          responsibleUser: c.responsibleUser,
          mode: "repair",
        });
        if (r.due) {
          await db
            .update(leadsSyncTable)
            .set({ nextFollowupAt: r.due, updatedAt: new Date() })
            .where(eq(leadsSyncTable.leadId, c.leadId));
        }
        // lastMessageFrom stuck on 'lead' while OUR message is provably newer
        // makes the report bill the broker for a client they already answered.
        // Fix it only from hard evidence — both timestamps in the same row.
        await db
          .update(leadsSyncTable)
          .set({ lastMessageFrom: "us" })
          .where(
            and(
              eq(leadsSyncTable.leadId, c.leadId),
              eq(leadsSyncTable.lastMessageFrom, "lead"),
              sql`${leadsSyncTable.lastOurMessageAt} > ${leadsSyncTable.lastMessageAt}`,
            ),
          );
        results.push({ leadId: c.leadId, action: r.action, due: r.due });
      } catch (err) {
        logger.error({ err, leadId: c.leadId }, "repair-manual-reply-overdue: lead failed");
        results.push({ leadId: c.leadId, action: "error" });
      }
    }
    logger.info({ repaired: results.length }, "admin: repair-manual-reply-overdue complete");
    res.json({ ok: true, dry: false, results });
  } catch (err) {
    logger.error({ err }, "admin: repair-manual-reply-overdue error");
    res.status(500).json({ error: String(err) });
  }
});

/**
 * POST /admin/test-ai-alert
 * Sends the outage alert through its real delivery path and reports how many
 * devices took it. Without this the first time the alarm ever runs is during an
 * actual outage — and if the push path is broken we would learn nothing, which
 * is precisely the failure it was built to end.
 */
router.post("/admin/test-ai-alert", async (_req, res) => {
  try {
    const result = await testAiOutageAlert();
    res.json({
      ...result,
      note: result.delivered > 0
        ? `Delivered to ${result.delivered} device(s). The alarm works.`
        : "NOBODY received it. The alarm would be silent during a real outage — check push enrolment.",
    });
  } catch (err) {
    logger.error({ err }, "test-ai-alert failed");
    res.status(500).json({ error: String(err) });
  }
});

export default router;
