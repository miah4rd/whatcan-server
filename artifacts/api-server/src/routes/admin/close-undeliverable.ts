/**
 * One-off sweep for the cards that piled up before the live guard existed.
 *
 * Dry by default — it closes leads in the owner's live CRM, and amoCRM runs its
 * own automations on a status change. Pass ?apply=1 to write.
 */
import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../../lib/logger";
import { closeUndeliverable } from "../../lib/undeliverable";

const router = Router();

router.post("/admin/close-undeliverable", async (req, res) => {
  const apply = String(req.query["apply"] ?? "") === "1";
  const limit = Math.min(Number(req.query["limit"]) || 200, 500);
  // Scoped by funnel on purpose. A delivery failure means the same thing
  // everywhere, but closing cards in the owner's SALES funnel is his call, not
  // a side effect of a listings fix.
  const pipeline = String(req.query["pipeline"] ?? "").trim().toLowerCase();

  // Only cards where the notice is the LAST thing in the conversation: one that
  // later carried a real reply means the owner reached us another way, and that
  // is a live lead however the first attempt went.
  const rows = await db.execute(sql`
    WITH newest AS (
      SELECT DISTINCT ON (m.lead_id) m.lead_id, m.text
        FROM lead_messages m
       WHERE m.sender_type = 'lead'
       ORDER BY m.lead_id, m.sent_at DESC
    )
    SELECT n.lead_id, l.pipeline, l.lead_stage
      FROM newest n
      JOIN leads_sync l ON l.lead_id = n.lead_id
     WHERE (n.text ~* 'на данном номере не установлен (what''?s?app|ватсап)'
            OR n.text ~* 'whatsapp is not installed on this number')
       AND lower(coalesce(l.lead_stage, '')) NOT LIKE '%closed%'
       AND lower(coalesce(l.lead_stage, '')) NOT LIKE '%lost%'
       AND lower(coalesce(l.lead_stage, '')) NOT LIKE '%won%'
       AND (${pipeline} = '' OR lower(coalesce(l.pipeline, '')) = ${pipeline})
     LIMIT ${limit}
  `);

  const targets = (rows.rows ?? []) as Array<{ lead_id: string; pipeline: string; lead_stage: string }>;
  if (!apply) {
    res.json({ dry: true, wouldClose: targets.length, targets });
    return;
  }

  let closed = 0;
  for (const t of targets) {
    if (await closeUndeliverable(t.lead_id)) closed++;
  }
  logger.info({ closed, found: targets.length }, "close-undeliverable sweep finished");
  res.json({ dry: false, found: targets.length, closed });
});

export default router;
