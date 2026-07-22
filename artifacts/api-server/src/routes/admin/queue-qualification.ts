import { Router } from "express";
import { db, leadsSyncTable } from "@workspace/db";
import { isNull, or, lt, sql, and, eq } from "drizzle-orm";

const router = Router();

/**
 * POST /api/admin/queue-qualification
 * Body (optional): { broker: "Robert" }
 *
 * Sets next_followup_at = NOW() only for leads that are:
 *   1. Assigned to the specified broker (default: Robert)
 *   2. In a qualification stage (NEW LEAD, IN PROGRESS, 1ST/2ND/FINAL FOLLOW UP, SHANTI)
 *   3. Don't already have a future followup scheduled
 *
 * The background scheduler will then generate push suggestions for them.
 */
const QUAL_STAGES = [
  "new lead",
  "in progress",
  "1st follow up",
  "2nd follow up",
  "final follow up",
  "shanti",
];

router.post("/admin/queue-qualification", async (req, res) => {
  const broker = (req.body as { broker?: string }).broker ?? "Robert";

  try {
    const now = new Date();

    const stageConditions = QUAL_STAGES.map(
      (w) => sql`lower(${leadsSyncTable.leadStage}) LIKE ${"%" + w + "%"}`,
    );
    const stageMatch = stageConditions.reduce((acc, c) => sql`${acc} OR ${c}`);

    const result = await db
      .update(leadsSyncTable)
      .set({ nextFollowupAt: now, followupLevel: 0 })
      .where(
        and(
          eq(leadsSyncTable.responsibleUser, broker),
          sql`(${stageMatch})`,
          or(
            isNull(leadsSyncTable.nextFollowupAt),
            lt(leadsSyncTable.nextFollowupAt, now),
          ),
        ),
      );

    const rowCount = (result as unknown as { rowCount?: number }).rowCount ?? 0;

    req.log.info({ rowCount, broker, stages: QUAL_STAGES }, "queue-qualification: reset done");

    res.json({
      ok: true,
      broker,
      leadsQueued: rowCount,
      stages: QUAL_STAGES,
      message: `${rowCount} лид(ов) поставлено в очередь для ${broker}. Шедулер сгенерирует подсказки в течение ~15 минут.`,
    });
  } catch (err) {
    req.log.error({ err }, "queue-qualification error");
    res.status(500).json({ ok: false, error: String(err) });
  }
});

export default router;
