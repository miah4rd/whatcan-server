import { Router } from "express";
import { exec } from "child_process";
import { promisify } from "util";
import { logger } from "../lib/logger";

const execAsync = promisify(exec);
const router = Router();

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "whatcan-deploy-2026";

router.post("/webhook/deploy", async (req, res) => {
  const secret = req.headers["x-webhook-secret"] as string;
  
  if (secret !== WEBHOOK_SECRET) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  res.json({ ok: true, status: "deploy started" });

  try {
    logger.info("deploy webhook received — starting deploy");
    
    const { stdout: pullOut } = await execAsync(
      "cd /opt/whatcan && git pull github master"
    );
    logger.info({ stdout: pullOut.trim() }, "git pull done");

    const { stdout: buildOut } = await execAsync(
      "cd /opt/whatcan/artifacts/api-server && node build.mjs"
    );
    logger.info({ stdout: buildOut.trim() }, "build done");

    const { stdout: pmOut } = await execAsync("pm2 restart whatcan");
    logger.info({ stdout: pmOut.trim() }, "pm2 restart done");

    logger.info("deploy complete");
  } catch (err) {
    logger.error({ err }, "deploy failed");
  }
});

export default router;
