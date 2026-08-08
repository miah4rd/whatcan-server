import { Router } from "express";
import { sql } from "drizzle-orm";
import { db, leadsSyncTable } from "@workspace/db";

const router = Router();

// GET /api/public/pipelines — unique pipelines actually present among tracked
// leads. Sourced from our own synced data (not amoCRM's raw pipeline list,
// which also includes pipelines we deliberately don't sync, e.g. "Shanti
// Agencies") — so the picker only ever offers something that can return
// results, and a newly-tracked pipeline appears here automatically the
// moment amo-sync starts syncing it, no code change needed on this end.
router.get("/pipelines", async (_req, res) => {
  try {
    const rows = await db
      .select({
        pipeline: leadsSyncTable.pipeline,
        count: sql<number>`count(*)::int`,
      })
      .from(leadsSyncTable)
      .where(sql`${leadsSyncTable.pipeline} IS NOT NULL AND ${leadsSyncTable.pipeline} != ''`)
      .groupBy(leadsSyncTable.pipeline)
      .orderBy(sql`count(*) DESC`);

    res.json(rows.map((r) => ({
      name: r.pipeline,
      leadCount: r.count,
    })));
  } catch (err) {
    _req.log.error({ err }, "get pipelines failed");
    res.status(500).json({ error: "internal" });
  }
});

export default router;
