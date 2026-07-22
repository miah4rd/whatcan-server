import { Router } from "express";
import { sql } from "drizzle-orm";
import { db, leadsSyncTable } from "@workspace/db";

const router = Router();

// GET /api/responsible-users — unique responsible users from tracked leads
router.get("/responsible-users", async (_req, res) => {
  try {
    const rows = await db
      .select({
        responsibleUser: leadsSyncTable.responsibleUser,
        count: sql<number>`count(*)::int`,
      })
      .from(leadsSyncTable)
      .where(sql`${leadsSyncTable.responsibleUser} IS NOT NULL AND ${leadsSyncTable.responsibleUser} != ''`)
      .groupBy(leadsSyncTable.responsibleUser)
      .orderBy(sql`count(*) DESC`);

    res.json(rows.map((r) => ({
      name: r.responsibleUser,
      leadCount: r.count,
    })));
  } catch (err) {
    _req.log.error({ err }, "get responsible-users failed");
    res.status(500).json({ error: "internal" });
  }
});

export default router;
