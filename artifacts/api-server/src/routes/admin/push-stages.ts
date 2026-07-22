import { Router } from "express";
import { getPushStageWhitelist, setPushStageWhitelist } from "../../lib/push-stage-whitelist";
import { logger } from "../../lib/logger";

const router = Router();

router.get("/admin/push-stages", async (_req, res) => {
  try {
    const stages = await getPushStageWhitelist();
    res.json({ stages });
  } catch (err) {
    logger.error({ err }, "push-stages GET failed");
    res.status(500).json({ error: "internal error" });
  }
});

router.post("/admin/push-stages", async (req, res) => {
  const { stages } = req.body as { stages?: unknown };
  if (!Array.isArray(stages) || stages.some((s) => typeof s !== "string")) {
    res.status(400).json({ error: "stages must be an array of strings" });
    return;
  }
  try {
    const cleaned = (stages as string[]).map((s) => s.trim().toLowerCase()).filter(Boolean);
    await setPushStageWhitelist(cleaned);
    logger.info({ stages: cleaned }, "push-stages: whitelist updated");
    res.json({ ok: true, stages: cleaned });
  } catch (err) {
    logger.error({ err }, "push-stages POST failed");
    res.status(500).json({ error: "internal error" });
  }
});

export default router;
