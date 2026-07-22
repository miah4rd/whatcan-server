import { Router } from "express";
import { db, leadsSyncTable, pendingSuggestionsTable } from "@workspace/db";
import { eq, and, inArray, isNotNull, sql } from "drizzle-orm";
import { shouldSuppressPush, isStageWhitelisted, PUSH_STAGE_WHITELIST } from "../../lib/stage-routing";

const router = Router();

router.post("/admin/refresh-push", async (_req, res) => {
  try {
    // 1. Get all pending push suggestions with lead stages
    const pending = await db
      .select({
        id: pendingSuggestionsTable.id,
        leadId: pendingSuggestionsTable.leadId,
        leadStage: leadsSyncTable.leadStage,
      })
      .from(pendingSuggestionsTable)
      .leftJoin(leadsSyncTable, eq(pendingSuggestionsTable.leadId, leadsSyncTable.leadId))
      .where(
        and(
          eq(pendingSuggestionsTable.status, "pending"),
          eq(pendingSuggestionsTable.kind, "push"),
        ),
      );

    // 2. Split into suppressed vs. active (respects both suppression rules and whitelist)
    const suppressedLeadIds = new Set<string>();
    const activeLeadIds = new Set<string>();
    for (const row of pending) {
      const stage = row.leadStage ?? "";
      if ((stage && shouldSuppressPush(stage)) || !isStageWhitelisted(row.leadStage)) {
        suppressedLeadIds.add(row.leadId);
      } else {
        activeLeadIds.add(row.leadId);
      }
    }

    // 3. Delete ALL pending push suggestions (clear the inbox)
    const allIds = pending.map((r) => r.id);
    let deleted = 0;
    if (allIds.length > 0) {
      await db
        .delete(pendingSuggestionsTable)
        .where(inArray(pendingSuggestionsTable.id, allIds));
      deleted = allIds.length;
    }

    // 4. For suppressed leads (from pending queue): clear nextFollowupAt
    for (const leadId of suppressedLeadIds) {
      await db
        .update(leadsSyncTable)
        .set({ nextFollowupAt: null })
        .where(eq(leadsSyncTable.leadId, leadId));
    }

    // 4b. GLOBAL suppression: null out nextFollowupAt for ALL leads whose known stage
    //     is outside the whitelist. This catches leads not yet in the push queue.
    let globalSuppressed = 0;
    if (PUSH_STAGE_WHITELIST.length > 0) {
      // Build SQL: lower(lead_stage) NOT LIKE any whitelist pattern
      const conditions = PUSH_STAGE_WHITELIST.map(
        (w) => sql`lower(${leadsSyncTable.leadStage}) LIKE ${"%" + w.toLowerCase() + "%"}`,
      );
      const whitelistMatch = conditions.reduce((acc, c) => sql`${acc} OR ${c}`);
      const result = await db
        .update(leadsSyncTable)
        .set({ nextFollowupAt: null })
        .where(and(isNotNull(leadsSyncTable.leadStage), sql`NOT (${whitelistMatch})`));
      globalSuppressed = (result as unknown as { rowCount?: number }).rowCount ?? 0;
    }

    // 5. For active leads: reset nextFollowupAt to now so scheduler regenerates immediately
    const now = new Date();
    for (const leadId of activeLeadIds) {
      await db
        .update(leadsSyncTable)
        .set({ nextFollowupAt: now, followupLevel: 0 })
        .where(eq(leadsSyncTable.leadId, leadId));
    }

    // 5b. Reset ALL whitelist leads (null or future nextFollowupAt) to now
    //     so the scheduler picks them all up immediately.
    if (PUSH_STAGE_WHITELIST.length > 0) {
      const conditions = PUSH_STAGE_WHITELIST.map(
        (w) => sql`lower(${leadsSyncTable.leadStage}) LIKE ${"%" + w.toLowerCase() + "%"}`,
      );
      const whitelistMatch = conditions.reduce((acc, c) => sql`${acc} OR ${c}`);
      await db
        .update(leadsSyncTable)
        .set({ nextFollowupAt: now, followupLevel: 0 })
        .where(sql`(${whitelistMatch}) AND (${leadsSyncTable.nextFollowupAt} IS NULL OR ${leadsSyncTable.nextFollowupAt} > ${now})`);
    }

    const whitelistNote = PUSH_STAGE_WHITELIST.length > 0
      ? ` Stage whitelist active: [${PUSH_STAGE_WHITELIST.join(", ")}].`
      : "";
    res.json({
      ok: true,
      deleted,
      suppressedLeads: suppressedLeadIds.size + globalSuppressed,
      activeLeads: activeLeadIds.size,
      stageWhitelist: PUSH_STAGE_WHITELIST,
      message: `Cleared ${deleted} push messages. ${suppressedLeadIds.size + globalSuppressed} leads suppressed globally. ${activeLeadIds.size} leads reset — scheduler will regenerate.${whitelistNote}`,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

export default router;
