/**
 * Closes WAhelp's duplicate WhatsApp threads on cards that have them.
 *
 * The send path does this on its own now, but only when someone sends. This
 * clears the ones already sitting in the funnel so the block stops appearing
 * before anybody tries.
 *
 * Dry by default (?apply=1 to write) — it closes conversations in the owner's
 * live CRM.
 */
import { Router } from "express";
import { db, leadsSyncTable } from "@workspace/db";
import { and, eq, ne, sql } from "drizzle-orm";
import { logger } from "../../lib/logger";
import { countActiveWhatsappChats, closeStaleDuplicateWhatsappTalks } from "../../lib/amo-client";

const router = Router();

router.post("/admin/dedupe-talks", async (req, res) => {
  const apply = String(req.query["apply"] ?? "") === "1";
  const pipeline = String(req.query["pipeline"] ?? "").trim().toLowerCase();
  const one = String(req.query["lead"] ?? "").trim();
  const limit = Math.min(Number(req.query["limit"]) || 120, 400);

  let leadIds: string[];
  if (one) {
    leadIds = [one];
  } else {
    const rows = await db
      .select({ leadId: leadsSyncTable.leadId })
      .from(leadsSyncTable)
      .where(
        and(
          ne(leadsSyncTable.botExcluded, true),
          sql`lower(coalesce(${leadsSyncTable.leadStage},'')) NOT LIKE '%closed%'`,
          sql`lower(coalesce(${leadsSyncTable.leadStage},'')) NOT LIKE '%lost%'`,
          pipeline ? sql`lower(coalesce(${leadsSyncTable.pipeline},'')) = ${pipeline}` : sql`true`,
        ),
      )
      .limit(limit);
    leadIds = rows.map((r) => r.leadId);
  }

  const affected: string[] = [];
  let closed = 0;
  for (const leadId of leadIds) {
    const n = await countActiveWhatsappChats(leadId);
    if (n < 2) continue;
    affected.push(leadId);
    if (apply) closed += await closeStaleDuplicateWhatsappTalks(leadId);
  }

  logger.info({ scanned: leadIds.length, affected: affected.length, closed, apply }, "dedupe-talks finished");
  res.json({ dry: !apply, scanned: leadIds.length, affected, closedThreads: closed });
});

export default router;
