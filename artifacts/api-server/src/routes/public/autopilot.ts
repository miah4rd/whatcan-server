/**
 * The broker's staged-delegation dial. GET returns the current setting plus the
 * funnel's stage list (so the UI never hardcodes stages); POST saves it.
 * See lib/autopilot.ts for what the modes mean.
 */
import { Router } from "express";
import { getAutopilotSetting, setAutopilotSetting, type AutopilotMode } from "../../lib/autopilot";
import { getPipelineStages, listAutopilotPipelines } from "../../lib/stage-classifier";

const router = Router();

router.options("/autopilot", (_req, res) => res.sendStatus(204));

router.get("/autopilot", async (req, res) => {
  const pipeline = String(req.query["pipeline"] ?? "rental").toLowerCase();
  try {
    const [setting, stages, pipelines] = await Promise.all([
      getAutopilotSetting(pipeline),
      getPipelineStages(pipeline),
      listAutopilotPipelines(),
    ]);
    res.json({
      setting,
      // The funnels the bot can be handed at all. Offering the rest is offering
      // a dial with nothing behind it: seven of the ten funnels amoCRM reports
      // have no stage list here, so their stage dropdown came up holding only
      // "Off" and read as the stage picker having disappeared.
      pipelines,
      // Only stages the bot may ever act in — the closes carry money and
      // reporting weight and are never delegated, same as the auto-stage rule.
      stages: (stages?.selectable ?? [])
        .map((s) => s.name)
        .filter((n) => !/closed|won|lost|сделка|лост/i.test(n)),
    });
  } catch (err) {
    req.log.error({ err }, "autopilot get failed");
    res.status(500).json({ error: "settings unavailable" });
  }
});

router.post("/autopilot", async (req, res) => {
  const body = req.body as {
    pipeline?: string;
    mode?: string;
    upToStageName?: string | null;
    dailyCap?: number;
  };
  const pipeline = (body.pipeline ?? "rental").toLowerCase();
  const mode = ["off", "dry", "on"].includes(body.mode ?? "") ? (body.mode as AutopilotMode) : "off";

  try {
    // The threshold must be a real stage of this funnel — a typo must not
    // silently delegate nothing (or everything).
    let upToStageName: string | null = null;
    if (mode !== "off") {
      const stages = await getPipelineStages(pipeline);
      const found = stages?.selectable
        .filter((s) => !/closed|won|lost|сделка|лост/i.test(s.name))
        .find(
          (s) => s.name.trim().toLowerCase() === (body.upToStageName ?? "").trim().toLowerCase(),
        );
      if (!found) {
        res.status(400).json({ error: "upToStageName must be one of the funnel's stages" });
        return;
      }
      upToStageName = found.name;
    }

    const dailyCap = Math.min(100, Math.max(1, Number(body.dailyCap) || 30));
    await setAutopilotSetting({ pipeline, mode, upToStageName, dailyCap });
    res.json({ ok: true, setting: { pipeline, mode, upToStageName, dailyCap } });
  } catch (err) {
    req.log.error({ err }, "autopilot set failed");
    res.status(500).json({ error: "could not save" });
  }
});

export default router;
