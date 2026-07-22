/**
 * Periodic amoCRM → leads_sync stage sync.
 * Fetches ALL leads from amoCRM API and updates lead_stage + pipeline + responsible_user.
 * Runs every 5 minutes in background.
 */
import { db, leadsSyncTable, pendingSuggestionsTable } from "@workspace/db";
import { eq, and, inArray, isNull, or, ilike } from "drizzle-orm";
import { logger } from "./logger";
import { amoFetch, getAccessToken, getAllOpenLeadTasksPaginated } from "./amo-client";
import { shouldSuppressPush } from "./stage-routing";
import { getPushStageWhitelist, isPushStageAllowed } from "./push-stage-whitelist";

type AmoLead = {
  id: number;
  name: string;
  status_id: number;
  pipeline_id: number;
  responsible_user_id: number;
  created_at?: number; // Unix timestamp from amoCRM
};

type AmoStatus = { id: number; name: string };
type AmoPipeline = {
  id: number; name: string;
  _embedded: { statuses: AmoStatus[] };
};
type AmoUser = { id: number; name: string };

// ── Maps: id → name ───────────────────────────────────────────────────────────

type StageInfo = { stageName: string; pipelineName: string };

async function fetchPipelineMap(): Promise<Map<number, StageInfo>> {
  const data = await amoFetch<{ _embedded: { pipelines: AmoPipeline[] } }>("/api/v4/leads/pipelines?limit=50");
  if (!data) return new Map();

  const map = new Map<number, StageInfo>();
  for (const pipeline of data._embedded.pipelines) {
    for (const status of pipeline._embedded.statuses) {
      map.set(status.id, { stageName: status.name, pipelineName: pipeline.name });
    }
  }
  logger.info({ count: map.size }, "amoCRM: pipeline stage map loaded");
  return map;
}

async function fetchUserMap(): Promise<Map<number, string>> {
  const data = await amoFetch<{ _embedded: { users: AmoUser[] } }>("/api/v4/users?limit=50");
  if (!data) return new Map();

  const map = new Map<number, string>();
  for (const u of data._embedded.users) {
    // Use first name only for consistency with broker names already in DB
    const firstName = u.name.split(" ")[0] ?? u.name;
    map.set(u.id, firstName);
  }
  logger.info({ count: map.size }, "amoCRM: user map loaded");
  return map;
}

// ── Lead fetch with pagination ────────────────────────────────────────────────

async function* fetchAllLeads(): AsyncGenerator<AmoLead> {
  let page = 1;
  while (true) {
    const data = await amoFetch<{
      _embedded?: { leads: AmoLead[] };
      _page_count?: number;
    }>(`/api/v4/leads?limit=250&page=${page}&order[updated_at]=desc`);

    if (!data || !data._embedded?.leads?.length) break;

    for (const lead of data._embedded.leads) yield lead;

    if (data._embedded.leads.length < 250) break;
    page++;
    // Small delay to respect rate limit (7 req/s)
    await new Promise((r) => setTimeout(r, 200));
  }
}

// ── Main sync function ────────────────────────────────────────────────────────

export async function syncLeadStages(): Promise<{ updated: number; total: number }> {
  const token = await getAccessToken();
  if (!token) {
    logger.info("amoCRM sync skipped: no access token");
    return { updated: 0, total: 0 };
  }

  logger.info("amoCRM stage sync started");

  const [pipelineMap, userMap] = await Promise.all([fetchPipelineMap(), fetchUserMap()]);
  if (pipelineMap.size === 0) {
    logger.warn("amoCRM sync aborted: empty pipeline map");
    return { updated: 0, total: 0 };
  }

  let total = 0;
  let updated = 0;
  let skipped = 0;

  // Only sync leads from these pipelines (case-insensitive)
  const ALLOWED_PIPELINES = new Set(["unicorn", "rental"]);
  // Unicorn pipeline: exclude these stages (case-insensitive)
  const UNICORN_EXCLUDED_STAGES = new Set(["неразобранное", "incorrect information"]);

  // AmoCRM system status IDs that are NOT in the pipeline map
  const AMO_STATUS_WON = 142;
  const AMO_STATUS_LOST = 143;

  for await (const lead of fetchAllLeads()) {
    total++;
    const info = pipelineMap.get(lead.status_id);

    // If status_id is not in pipeline map, the lead is closed/won/lost.
    // Update its stage to "Closed" so it no longer appears in follow-up queries.
    if (!info) {
      const closedStage =
        lead.status_id === AMO_STATUS_WON
          ? "Won"
          : lead.status_id === AMO_STATUS_LOST
            ? "Closed Lost"
            : "Closed";
      try {
        await db
          .update(leadsSyncTable)
          .set({ leadStage: closedStage, updatedAt: new Date() })
          .where(eq(leadsSyncTable.leadId, String(lead.id)));
      } catch (err) {
        logger.error({ err, leadId: lead.id }, "amoCRM sync: closed-stage update failed");
      }
      continue;
    }

    // Pipeline/stage filter: only sync allowed pipelines and stages (case-insensitive)
    const pipelineLower = info.pipelineName.toLowerCase();
    if (!ALLOWED_PIPELINES.has(pipelineLower)) {
      skipped++;
      continue;
    }
    if (pipelineLower === "unicorn" && UNICORN_EXCLUDED_STAGES.has(info.stageName.toLowerCase())) {
      skipped++;
      continue;
    }

    const responsibleUser = userMap.get(lead.responsible_user_id) ?? null;

    try {
      const now = new Date();
      const autoSchedule = !shouldSuppressPush(info.stageName) ? now : null;

      const amoCreatedAt = lead.created_at ? new Date(lead.created_at * 1000) : null;

      await db
        .insert(leadsSyncTable)
        .values({
          leadId: String(lead.id),
          responsibleUser,
          leadStage: info.stageName,
          pipeline: info.pipelineName,
          updatedAt: now,
          nextFollowupAt: autoSchedule, // Auto-queue new leads for push scheduler
          amoCreatedAt,
        })
        .onConflictDoUpdate({
          target: leadsSyncTable.leadId,
          set: {
            leadStage: info.stageName,
            pipeline: info.pipelineName,
            // Update responsibleUser only if we have one from amoCRM
            ...(responsibleUser ? { responsibleUser } : {}),
            updatedAt: now,
            // Always update amoCreatedAt — amoCRM returns created_at for all leads
            amoCreatedAt,
            // Do NOT touch nextFollowupAt for existing leads — preserve scheduler state
          },
        });

      updated++;
    } catch (err) {
      logger.error({ err, leadId: lead.id }, "amoCRM sync: DB upsert failed");
    }
  }

  logger.info({ total, updated, skipped }, "amoCRM stage sync complete");

  // ── Step 1b: Remove leads from DB that no longer match filter ───────────
  // Delete leads from pipelines we don't track, or excluded stages.
  try {
    // Get pipeline/stage map again for the cleanup query
    const allLeads = await db
      .select({ leadId: leadsSyncTable.leadId, pipeline: leadsSyncTable.pipeline, leadStage: leadsSyncTable.leadStage })
      .from(leadsSyncTable);

    const toDelete: string[] = [];
    for (const row of allLeads) {
      if (!row.pipeline) { toDelete.push(row.leadId); continue; }
      const pLower = row.pipeline.toLowerCase();
      if (!ALLOWED_PIPELINES.has(pLower)) { toDelete.push(row.leadId); continue; }
      if (pLower === "unicorn" && row.leadStage && UNICORN_EXCLUDED_STAGES.has(row.leadStage.toLowerCase())) {
        toDelete.push(row.leadId);
      }
    }
    if (toDelete.length > 0) {
      // Also delete pending suggestions for these leads
      await db.delete(pendingSuggestionsTable).where(inArray(pendingSuggestionsTable.leadId, toDelete));
      await db.delete(leadsSyncTable).where(inArray(leadsSyncTable.leadId, toDelete));
      logger.info({ deletedCount: toDelete.length }, "amo-sync: removed leads not matching filter");
    }
  } catch (err) {
    logger.error({ err }, "amo-sync: lead cleanup failed (non-fatal)");
  }

  // ── Step 2: Clear stale warmup suggestions on stage change ───────────────
  // When a lead moves from "NEW LEAD" to a follow-up stage, any pending
  // brochure suggestion (followupLevel=0, the warmup) becomes stale.
  // Delete it so the scheduler regenerates the correct follow-up message.
  try {
    // Raw SQL: delete pending brochure suggestions (followup_level=0) for leads
    // that have moved past "new lead" stage — they need fresh follow-up messages.
    const cleaned = await db.execute(
      `DELETE FROM pending_suggestions
       WHERE status = 'pending'
         AND kind = 'push'
         AND followup_level = 0
         AND lead_id IN (
           SELECT lead_id FROM leads_sync
           WHERE lead_stage IS NOT NULL
             AND lead_stage NOT ILIKE '%new lead%'
         )
       RETURNING lead_id`
    );
    const cleanedCount = (cleaned as { rows?: unknown[] })?.rows?.length ?? 0;
    if (cleanedCount > 0) {
      logger.info({ cleanedCount }, "amo-sync: cleared stale warmup suggestions (lead moved past new-lead stage)");
    }
  } catch (err) {
    logger.error({ err }, "amo-sync: stale warmup cleanup failed (non-fatal)");
  }

  // ── Step 3: Task-driven scheduling ────────────────────────────────────────
  // Read ALL open tasks for leads from amoCRM in one paginated call.
  // For any lead in a follow-up stage whose task is due today or overdue,
  // set nextFollowupAt = now so the scheduler can generate a push suggestion.
  // This replaces the old time-based orphaned rescheduler.
  try {
    await syncTaskSchedule();
  } catch (err) {
    logger.error({ err }, "amo-sync: task-driven scheduling failed (non-fatal)");
  }

  // ── Step 4: Detect broker manual replies via AmoCRM events ────────────────
  // Poll recent outgoing message events from AmoCRM. When broker replies manually
  // (via WhatsApp synced to AmoCRM), WAHelp may not fire our webhook for outgoing
  // messages. This catches those cases so LIVE suggestions are cleared properly.
  try {
    await syncOutgoingEvents();
  } catch (err) {
    logger.error({ err }, "amo-sync: outgoing events sync failed (non-fatal)");
  }

  return { updated, total };
}

/**
 * Task-driven scheduling: read ALL open amoCRM tasks for leads (one paginated
 * request), then for any lead in a follow-up stage whose task is due today or
 * overdue, set nextFollowupAt = now so the scheduler queues a push suggestion.
 *
 * This is the sole scheduling source — we do NOT use fixed time intervals.
 * The task due date is set by autoCreateCrmTask (on approve) or manually by
 * the broker, so the bot reacts to exactly what's in amoCRM.
 */
export async function syncTaskSchedule(): Promise<void> {
  const [tasks, pushWhitelist] = await Promise.all([
    getAllOpenLeadTasksPaginated(),
    getPushStageWhitelist(),
  ]);

  const now = new Date();
  // "Due today or overdue" = complete_till <= end of today in Bali time (UTC+8).
  const BALI_OFFSET_MS = 8 * 60 * 60 * 1000;
  const nowBali = new Date(now.getTime() + BALI_OFFSET_MS);
  const tomorrowMidnightBaliAsUtc =
    Date.UTC(nowBali.getUTCFullYear(), nowBali.getUTCMonth(), nowBali.getUTCDate() + 1) - BALI_OFFSET_MS;
  const todayMidnight = tomorrowMidnightBaliAsUtc / 1000;

  // Build two maps from AmoCRM tasks:
  //   dueTasks   — leads whose earliest task is due today or overdue → schedule now
  //   futureTasks — leads that have a task due in the FUTURE → snooze until then
  const dueTasks = new Map<string, Date>(); // leadId → earliest overdue/today due date
  const futureTasks = new Map<string, Date>(); // leadId → earliest future task date

  for (const task of tasks) {
    const leadId = String(task.entity_id);
    if (!task.complete_till || task.complete_till > todayMidnight) {
      if (task.complete_till) {
        const futureDate = new Date(task.complete_till * 1000);
        const existing = futureTasks.get(leadId);
        if (!existing || futureDate < existing) futureTasks.set(leadId, futureDate);
      }
      continue;
    }
    const dueDate = new Date(task.complete_till * 1000);
    const existing = dueTasks.get(leadId);
    if (!existing || dueDate < existing) dueTasks.set(leadId, dueDate);
  }
  // A lead can have both an overdue task and a future task — prioritise the overdue one.
  for (const id of dueTasks.keys()) futureTasks.delete(id);

  logger.info(
    {
      totalTasksFromApi: tasks.length,
      dueOrOverdue: dueTasks.size,
      future: futureTasks.size,
    },
    "amo-sync: task maps built",
  );

  // ── Pass 0: Snooze leads with future tasks ────────────────────────────────
  // If a lead has a future amoCRM task, it must NOT appear in PUSH.
  // Two actions:
  //   1. Always delete any pending PUSH — broker has a scheduled task, no need to prompt now.
  //   2. If nextFollowupAt is stale (past or null), advance it to the future task date
  //      so processFollowups won't regenerate a PUSH before the task is due.
  // This runs every sync cycle (5 min) so it continuously enforces the rule.
  let snoozed = 0;
  if (futureTasks.size) {
    const futureLeadIds = [...futureTasks.keys()];
    const futureLeads = await db
      .select({ leadId: leadsSyncTable.leadId, nextFollowupAt: leadsSyncTable.nextFollowupAt })
      .from(leadsSyncTable)
      .where(inArray(leadsSyncTable.leadId, futureLeadIds));

    // Bulk-delete pending PUSH for ALL future-task leads in one query
    if (futureLeads.length > 0) {
      const ids = futureLeads.map((l) => l.leadId);
      await db
        .delete(pendingSuggestionsTable)
        .where(
          and(
            inArray(pendingSuggestionsTable.leadId, ids),
            eq(pendingSuggestionsTable.kind, "push"),
            eq(pendingSuggestionsTable.status, "pending"),
          ),
        );
    }

    // Update nextFollowupAt only where it is stale (past or null) to the future task date.
    // If nextFollowupAt is already set to a future date, leave it — it may have been set
    // by approve.ts to the correct next follow-up date.
    for (const lead of futureLeads) {
      const futureDate = futureTasks.get(lead.leadId)!;
      if (!lead.nextFollowupAt || lead.nextFollowupAt <= now) {
        await db
          .update(leadsSyncTable)
          .set({ nextFollowupAt: futureDate })
          .where(eq(leadsSyncTable.leadId, lead.leadId));
        snoozed++;
      }
    }
    if (snoozed > 0) {
      logger.info({ snoozed }, "amo-sync: snoozed leads whose amoCRM task is in the future");
    }
  }

  // ── Pass 1: Task-driven scheduling (due today / overdue) ─────────────────
  let scheduled = 0;
  if (dueTasks.size) {
    const leadIds = [...dueTasks.keys()];
    const leads = await db
      .select({ leadId: leadsSyncTable.leadId, leadStage: leadsSyncTable.leadStage, nextFollowupAt: leadsSyncTable.nextFollowupAt, amoCreatedAt: leadsSyncTable.amoCreatedAt })
      .from(leadsSyncTable)
      .where(inArray(leadsSyncTable.leadId, leadIds));

    const REACH_KW = ["1st follow up", "2nd follow up", "final follow up"];
    for (const lead of leads) {
      if (shouldSuppressPush(lead.leadStage ?? "")) continue;
      const isReachLead = REACH_KW.some(kw => (lead.leadStage ?? "").toLowerCase().includes(kw));
      const actualTaskDate = dueTasks.get(lead.leadId)!;

      if (!isReachLead) {
        // Active-funnel stages (Contact Established, Needs Assessed, Options Sent):
        //
        // 3-month filter — only show leads created within the last 3 months.
        // Older leads are stale pipeline residue and should not flood the PUSH tab.
        const THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000;
        if (lead.amoCreatedAt && lead.amoCreatedAt < new Date(now.getTime() - THREE_MONTHS_MS)) {
          await db.update(leadsSyncTable).set({ nextFollowupAt: null }).where(eq(leadsSyncTable.leadId, lead.leadId));
          continue;
        }

        // Task date encoding for PUSH-tab sorting:
        //
        // Today's task → nextFollowupAt = now (so scheduler pre-fetches immediately;
        // amoCRM end-of-day = 15:59 UTC, which would miss the 2h scheduler window).
        //
        // Overdue task → nextFollowupAt = actualTaskDate (the real amoCRM due date).
        // This lets suggestions.ts sort PUSH by urgency: today → overdue ascending.
        // The stale guard is removed from the scheduler so overdue leads still generate.
        const todayStartSec = todayMidnight - 86400; // seconds: today midnight Bali as UTC
        const actualTaskSec = actualTaskDate.getTime() / 1000;
        const scheduleAt = actualTaskSec >= todayStartSec ? now : actualTaskDate;
        await db.update(leadsSyncTable).set({ nextFollowupAt: scheduleAt }).where(eq(leadsSyncTable.leadId, lead.leadId));
        scheduled++;
        continue;
      }

      // REACH leads: always schedule immediately (nextFollowupAt = now).
      await db.update(leadsSyncTable).set({ nextFollowupAt: now }).where(eq(leadsSyncTable.leadId, lead.leadId));
      scheduled++;
    }
    if (scheduled > 0) {
      logger.info({ scheduled }, "amo-sync: task-driven — queued leads for follow-up based on amoCRM tasks");
    }
  }

  // ── Pass 2: Orphan sweep — follow-up stage leads with no active task ─────
  // Covers leads where the broker closed the AmoCRM task without following up,
  // or where the task was never created. Only schedules if no FUTURE task exists.
  const orphans = await db
    .select({ leadId: leadsSyncTable.leadId, leadStage: leadsSyncTable.leadStage })
    .from(leadsSyncTable)
    .where(
      and(
        isNull(leadsSyncTable.nextFollowupAt),
        or(
          ilike(leadsSyncTable.leadStage, "%1st follow up%"),
          ilike(leadsSyncTable.leadStage, "%2nd follow up%"),
          ilike(leadsSyncTable.leadStage, "%final follow up%"),
        ),
      ),
    );

  let orphanScheduled = 0;
  for (const lead of orphans) {
    if (shouldSuppressPush(lead.leadStage ?? "")) continue;
    // Skip if they have a future task — broker has already set a due date
    if (futureTasks.has(lead.leadId)) continue;
    await db.update(leadsSyncTable).set({ nextFollowupAt: now }).where(eq(leadsSyncTable.leadId, lead.leadId));
    orphanScheduled++;
  }
  if (orphanScheduled > 0) {
    logger.info({ orphanScheduled }, "amo-sync: orphan sweep — queued follow-up stage leads without active tasks");
  }
}

type AmoEvent = {
  type: string;
  entity_id: number;
  entity_type: string;
  created_at: number;
  created_by?: number;
};

/**
 * Polls AmoCRM events API for recent outgoing messages.
 * When a broker manually replies to a lead (not via the plugin), AmoCRM records
 * an outgoing_lead_message event. We use this to:
 *   1. Mark the lead's lastMessageFrom as "us"
 *   2. Clear any pending LIVE suggestions
 *   3. Schedule the next follow-up if none is queued
 */
export async function syncOutgoingEvents(lookbackMs = 30 * 60 * 1000): Promise<number> {
  const token = await getAccessToken();
  if (!token) return 0;

  // Poll both outgoing_lead_message AND outgoing_chat_message so that messages
  // sent directly from WhatsApp on the phone (which AmoCRM records as chat events,
  // not lead events) are also caught and clear the LIVE suggestion.
  const fromTs = Math.floor((Date.now() - lookbackMs) / 1000);

  const data = await amoFetch<{ _embedded?: { events?: AmoEvent[] } }>(
    `/api/v4/events?filter[type][]=outgoing_lead_message&filter[type][]=outgoing_chat_message&filter[created_at][from]=${fromTs}&limit=250`,
  );

  const events = data?._embedded?.events ?? [];
  if (!events.length) return 0;

  logger.info({ count: events.length }, "amo-sync: outgoing events found");

  let cleared = 0;
  for (const event of events) {
    if (event.entity_type !== "lead") continue;
    const leadId = String(event.entity_id);

    const [existing] = await db
      .select({
        lastMessageFrom: leadsSyncTable.lastMessageFrom,
        lastOurMessageAt: leadsSyncTable.lastOurMessageAt,
        nextFollowupAt: leadsSyncTable.nextFollowupAt,
        followupLevel: leadsSyncTable.followupLevel,
        leadStage: leadsSyncTable.leadStage,
      })
      .from(leadsSyncTable)
      .where(eq(leadsSyncTable.leadId, leadId))
      .limit(1);

    if (!existing) continue; // Lead not in our DB yet — amo-sync will add it next cycle

    const eventAt = new Date(event.created_at * 1000);
    const knownOurAt = existing.lastOurMessageAt;

    // Skip if we already know about a more recent broker message
    if (knownOurAt && knownOurAt.getTime() >= eventAt.getTime()) continue;

    await db
      .update(leadsSyncTable)
      .set({
        lastMessageFrom: "us",
        lastOurMessageAt: eventAt,
        nextFollowupAt: null,
        updatedAt: new Date(),
      })
      .where(eq(leadsSyncTable.leadId, leadId));

    // Clear any pending LIVE suggestions for this lead (broker already replied)
    await db
      .delete(pendingSuggestionsTable)
      .where(
        and(
          eq(pendingSuggestionsTable.leadId, leadId),
          eq(pendingSuggestionsTable.status, "pending"),
          eq(pendingSuggestionsTable.kind, "live"),
        ),
      );

    cleared++;
    logger.info({ leadId, eventAt }, "amo-sync: broker outgoing event detected, LIVE cleared");
  }
  return cleared;
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export function startAmoSyncScheduler(): void {
  // First sync after 10 seconds (let server boot first)
  setTimeout(async () => {
    try { await syncLeadStages(); } catch (err) { logger.error({ err }, "amoCRM initial sync error"); }
  }, 10_000);

  setInterval(async () => {
    try { await syncLeadStages(); } catch (err) { logger.error({ err }, "amoCRM periodic sync error"); }
  }, SYNC_INTERVAL_MS);

  logger.info("amoCRM sync scheduler started (every 5 min)");
}
