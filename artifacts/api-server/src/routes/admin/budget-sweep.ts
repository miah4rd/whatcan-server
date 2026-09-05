/**
 * Applies the rental budget floor to leads already in the funnel.
 *
 * The filter runs when a message ARRIVES; a parser gap ("25mil" read as no
 * budget at all) let leads through, and once they carried a pending draft
 * nothing re-evaluated them. This walks the open Rental leads once, parses the
 * budget the same way the live filter does, and closes those below the floor.
 *
 * Dry by default (?apply=1 to close) — it closes leads in the owner's live CRM.
 */
import { Router } from "express";
import { db, leadsSyncTable, leadMessagesTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "../../lib/logger";
import { extractBudgetIdr } from "../../lib/property-catalog";
import { getBudgetFilterSetting, enforceBudgetFilter } from "../../lib/budget-filter";
import { getLeadCardCriteria } from "../../lib/lead-card-fields";

const router = Router();

router.post("/admin/budget-sweep", async (req, res) => {
  const apply = String(req.query["apply"] ?? "") === "1";
  const setting = await getBudgetFilterSetting("rental");
  if (!setting.enabled || !setting.minMonthlyIdr) {
    res.json({ skipped: "budget filter is off for rental" });
    return;
  }
  const floor = setting.minMonthlyIdr;

  const leads = await db
    .select({ leadId: leadsSyncTable.leadId, stage: leadsSyncTable.leadStage, owner: leadsSyncTable.responsibleUser })
    .from(leadsSyncTable)
    .where(
      and(
        sql`lower(${leadsSyncTable.pipeline}) = 'rental'`,
        sql`lower(coalesce(${leadsSyncTable.leadStage},'')) NOT LIKE '%lost%'`,
        sql`lower(coalesce(${leadsSyncTable.leadStage},'')) NOT LIKE '%closed%'`,
        sql`lower(coalesce(${leadsSyncTable.leadStage},'')) NOT LIKE '%won%'`,
        sql`${leadsSyncTable.botExcluded} IS NOT TRUE`,
      ),
    );

  const below: Array<Record<string, unknown>> = [];
  for (const l of leads) {
    const msgs = await db
      .select({ text: leadMessagesTable.text })
      .from(leadMessagesTable)
      .where(and(eq(leadMessagesTable.leadId, l.leadId), eq(leadMessagesTable.senderType, "lead")));
    const texts = msgs.map((m) => m.text ?? "").filter(Boolean);
    const card = await getLeadCardCriteria(l.leadId).catch(() => null);
    const budget = extractBudgetIdr(texts) ?? card?.budgetIdrMonthly ?? null;
    if (budget && budget < floor) {
      let closed = false;
      if (apply) closed = await enforceBudgetFilter(l.leadId).catch(() => false);
      below.push({ lead: l.leadId, stage: l.stage, owner: l.owner, budgetIdr: budget, closed });
    }
  }
  logger.info({ scanned: leads.length, below: below.length, apply, floor }, "budget-sweep finished");
  res.json({ dry: !apply, floor, scanned: leads.length, below });
});

export default router;
