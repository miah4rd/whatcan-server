import { Router } from "express";
import { db, brokerCorrectionsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

const router = Router();

router.options("/correction", (_req, res) => res.sendStatus(204));

router.post("/correction", async (req, res) => {
  const body = req.body as {
    brokerId?: string;
    instruction?: string;
    situationContext?: string;
  };

  if (
    !body?.brokerId ||
    !body?.instruction ||
    typeof body.instruction !== "string" ||
    body.instruction.trim().length < 3 ||
    body.instruction.length > 2000
  ) {
    res.status(400).json({ error: "Invalid payload" });
    return;
  }

  const brokerId = body.brokerId.toLowerCase().slice(0, 64);
  const instruction = body.instruction.trim();
  const situationContext = body.situationContext?.trim() ?? null;

  try {
    await db.insert(brokerCorrectionsTable).values({ brokerId, instruction, situationContext });
    req.log.info({ brokerId }, "broker correction saved");
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "correction insert error");
    res.status(500).json({ error: "DB error" });
  }
});

// GET /correction — return recent corrections for a broker (used by admin/debug)
router.get("/correction", async (req, res) => {
  const brokerId = (req.query["brokerId"] as string | undefined)?.toLowerCase().slice(0, 64);
  if (!brokerId) {
    res.status(400).json({ error: "brokerId required" });
    return;
  }
  try {
    const rows = await db
      .select()
      .from(brokerCorrectionsTable)
      .where(eq(brokerCorrectionsTable.brokerId, brokerId))
      .orderBy(desc(brokerCorrectionsTable.createdAt))
      .limit(50);
    res.json({ corrections: rows });
  } catch (err) {
    req.log.error({ err }, "correction fetch error");
    res.status(500).json({ error: "DB error" });
  }
});

export default router;
