import { Router } from "express";
import { db, leadsSyncTable, pendingSuggestionsTable } from "@workspace/db";
import { eq, and, inArray, gte, lte, isNull, or, sql } from "drizzle-orm";
import { getQualificationSteps } from "../../lib/settings";
import { shouldSuppressPush } from "../../lib/stage-routing";
import { getPushStageWhitelist, setPushStageWhitelist } from "../../lib/push-stage-whitelist";
import { parseDialogContent } from "../../lib/dialog-parser";
import { buildFollowupTemplateByLevel } from "../../lib/followup-templates";
import { logger } from "../../lib/logger";

const router = Router();

const ACTIVE_STAGES = [
  "contact established",
  "needs assessed",
  "options sent",
];

/**
 * Map active-stage name → qual script index (0-based).
 * Contact Established → 0, Needs Assessed → 1, Options Sent → 2.
 */
function qualScriptIndexForStage(stage: string | null): number {
  const s = (stage ?? "").toLowerCase();
  if (s.includes("options sent")) return 2;
  if (s.includes("needs assessed")) return 1;
  return 0; // contact established and anything else
}

/**
 * POST /api/admin/bulk-push-active-stages
 *
 * Creates PUSH suggestion slots (template text, no AI) for leads in
 * Contact Established / Needs Assessed / Options Sent that are "actionable now":
 *   - Created in last 3 months (amo_created_at >= 3 months ago)
 *   - No task set (nextFollowupAt IS NULL), OR task is due today or overdue
 *
 * Body: { months?: number (default 3), responsibleUser?: string }
 */
router.post("/admin/bulk-push-active-stages", async (req, res) => {
  const months = Number(req.body?.months ?? 3);
  const responsibleUserFilter: string | undefined = req.body?.responsibleUser;

  const since = new Date();
  since.setMonth(since.getMonth() - months);

  // End of today in Bali time (UTC+8), expressed as UTC
  const BALI_OFFSET_MS = 8 * 60 * 60 * 1000;
  const nowBali = new Date(Date.now() + BALI_OFFSET_MS);
  const endOfTodayBaliAsUtc = new Date(
    Date.UTC(nowBali.getUTCFullYear(), nowBali.getUTCMonth(), nowBali.getUTCDate() + 1) - BALI_OFFSET_MS,
  );

  try {
    // 1. Ensure all 3 active stages are in the push whitelist
    const currentWhitelist = await getPushStageWhitelist();
    const mergedWhitelist = Array.from(
      new Set([...currentWhitelist, ...ACTIVE_STAGES.map((s) => s.toLowerCase())]),
    );
    if (mergedWhitelist.length !== currentWhitelist.length) {
      await setPushStageWhitelist(mergedWhitelist);
      logger.info({ added: mergedWhitelist.length - currentWhitelist.length }, "bulk-push-active-stages: whitelist updated");
    }

    // 2. Query leads in these stages updated within the last N months,
    //    where the task is due today/overdue OR there is no task at all.
    const stageFilter = sql`LOWER(${leadsSyncTable.leadStage}) = ANY(ARRAY[${sql.join(
      ACTIVE_STAGES.map((s) => sql`${s}`),
      sql`, `,
    )}]::text[])`;

    const taskFilter = or(
      isNull(leadsSyncTable.nextFollowupAt),
      lte(leadsSyncTable.nextFollowupAt, endOfTodayBaliAsUtc),
    );

    const conditions = [
      stageFilter,
      taskFilter!,
      // Only leads created in the last N months (default 3) — filters out stale old leads
      gte(leadsSyncTable.amoCreatedAt, since),
      // Only UNICORN pipeline — other pipelines (Shanti Agencies, Main, etc.) are out of scope
      eq(leadsSyncTable.pipeline, "UNICORN"),
    ];
    if (responsibleUserFilter) {
      conditions.push(eq(leadsSyncTable.responsibleUser, responsibleUserFilter));
    }

    const leads = await db
      .select()
      .from(leadsSyncTable)
      .where(and(...conditions));

    // 3. Find leads that already have a pending push suggestion
    const allLeadIds = leads.map((l) => l.leadId);
    const existingPush =
      allLeadIds.length > 0
        ? await db
            .select({ leadId: pendingSuggestionsTable.leadId })
            .from(pendingSuggestionsTable)
            .where(
              and(
                inArray(pendingSuggestionsTable.leadId, allLeadIds),
                eq(pendingSuggestionsTable.status, "pending"),
                eq(pendingSuggestionsTable.kind, "push"),
              ),
            )
        : [];

    const existingLeadIds = new Set(existingPush.map((e) => e.leadId));

    // 4. Get qual scripts (broker-configured messages)
    const qualSteps = await getQualificationSteps();

    let created = 0;
    let skippedExisting = 0;
    let skippedExcluded = 0;
    let skippedNoText = 0;

    for (const lead of leads) {
      if (lead.botExcluded) { skippedExcluded++; continue; }
      if (shouldSuppressPush(lead.leadStage ?? "")) { skippedExcluded++; continue; }
      if (existingLeadIds.has(lead.leadId)) { skippedExisting++; continue; }

      // Extract first name from dialog content
      const leadFirstName = (() => {
        if (!lead.content) return "";
        try {
          const parsed = parseDialogContent(lead.content);
          const msg = parsed.messages.find((m) => m.from === "lead" && m.senderName?.trim());
          if (!msg?.senderName) return "";
          return msg.senderName.replace(/\s*\([^)]*\)\s*$/, "").trim().split(/\s+/)[0] ?? "";
        } catch { return ""; }
      })();

      // Build suggestion text: qual script (free) → template (free), never AI
      const stageIdx = qualScriptIndexForStage(lead.leadStage);
      const qualStep = qualSteps[stageIdx];
      const qualMsg = qualStep?.message?.trim() ?? "";

      let text: string;
      if (qualMsg) {
        text = qualMsg
          .replace(/\[Name\]/g, leadFirstName)
          .replace(/\[name\]/g, leadFirstName);
      } else {
        text = buildFollowupTemplateByLevel(stageIdx + 1, lead.leadId, leadFirstName, lead.responsibleUser ?? "Robert") ?? "";
      }

      if (!text) { skippedNoText++; continue; }

      await db.insert(pendingSuggestionsTable).values({
        leadId: lead.leadId,
        responsibleUser: lead.responsibleUser,
        kind: "push",
        followupLevel: stageIdx + 1,
        suggestionText: text,
        status: "pending",
        objectionCategory: "generic",
        attachments: [],
      });

      created++;
    }

    logger.info(
      { created, skippedExisting, skippedExcluded, skippedNoText, total: leads.length, months, responsibleUserFilter },
      "bulk-push-active-stages: done",
    );

    // Debug: pipeline breakdown to diagnose count mismatches
    const pipelineBreakdown: Record<string, number> = {};
    for (const l of leads) {
      const p = l.pipeline ?? "(null)";
      pipelineBreakdown[p] = (pipelineBreakdown[p] ?? 0) + 1;
    }

    res.json({
      ok: true,
      created,
      skipped_existing: skippedExisting,
      skipped_excluded: skippedExcluded,
      skipped_no_text: skippedNoText,
      total_leads_found: leads.length,
      months,
      filter_user: responsibleUserFilter ?? null,
      stages: ACTIVE_STAGES,
      pipeline_breakdown: pipelineBreakdown,
    });
  } catch (err) {
    logger.error({ err }, "bulk-push-active-stages: error");
    res.status(500).json({ ok: false, error: String(err) });
  }
});

/**
 * DELETE /api/admin/bulk-push-active-stages
 *
 * Removes all pending PUSH suggestions that were created for the 3 active stages
 * (Contact Established / Needs Assessed / Options Sent) with objectionCategory = 'generic'.
 * Used to clean up a bulk-push run before re-running with corrected filters.
 *
 * Body: { responsibleUser?: string } — optional: delete only for a specific broker
 */
router.delete("/admin/bulk-push-active-stages", async (req, res) => {
  const responsibleUserFilter: string | undefined = req.body?.responsibleUser;
  try {
    // Find lead IDs that are currently in the 3 active stages
    const stageFilter = sql`LOWER(${leadsSyncTable.leadStage}) = ANY(ARRAY[${sql.join(
      ACTIVE_STAGES.map((s) => sql`${s}`),
      sql`, `,
    )}]::text[])`;

    const leadsInStages = await db
      .select({ leadId: leadsSyncTable.leadId })
      .from(leadsSyncTable)
      .where(responsibleUserFilter
        ? and(stageFilter, eq(leadsSyncTable.responsibleUser, responsibleUserFilter))
        : stageFilter,
      );

    if (!leadsInStages.length) {
      res.json({ ok: true, deleted: 0 });
      return;
    }

    const leadIds = leadsInStages.map((r) => r.leadId);

    const deleted = await db
      .delete(pendingSuggestionsTable)
      .where(
        and(
          inArray(pendingSuggestionsTable.leadId, leadIds),
          eq(pendingSuggestionsTable.status, "pending"),
          eq(pendingSuggestionsTable.kind, "push"),
          // Delete ALL pending pushes for active stages (both scheduler-generated
          // and generic bulk-push ones) so the queue resets cleanly.
        ),
      )
      .returning({ id: pendingSuggestionsTable.id });

    logger.info({ deleted: deleted.length, responsibleUserFilter }, "bulk-push-active-stages: DELETE cleanup done");
    res.json({ ok: true, deleted: deleted.length });
  } catch (err) {
    logger.error({ err }, "bulk-push-active-stages DELETE: error");
    res.status(500).json({ ok: false, error: String(err) });
  }
});

export default router;
