import { Router } from "express";
import { getServerSettings, setFollowupSteps, setFollowupDelays, setBrokerPicks, setQualificationSteps, type BrokerPicksSegment, type FollowupStep, type QualificationStep } from "../../lib/settings";

const router = Router();

router.options("/settings", (_req, res) => res.sendStatus(204));

router.get("/settings", async (req, res) => {
  try {
    const settings = await getServerSettings();
    res.json(settings);
  } catch (err) {
    req.log.error({ err }, "failed to get settings");
    res.status(500).json({ error: "Internal error" });
  }
});

router.post("/settings", async (req, res) => {
  try {
    const { followupDelays, followupSteps, brokerPicks, qualificationSteps } = req.body as {
      followupDelays?: unknown;
      followupSteps?: unknown;
      brokerPicks?: unknown;
      qualificationSteps?: unknown;
    };

    const saves: Promise<void>[] = [];

    // ── followupSteps (new format — per-step delay + optional preset message) ──
    if (followupSteps !== undefined) {
      if (
        !Array.isArray(followupSteps) ||
        followupSteps.length === 0 ||
        !(followupSteps as unknown[]).every(
          (s) =>
            typeof (s as FollowupStep).delayMs === "number" &&
            (s as FollowupStep).delayMs > 0 &&
            (
              (s as FollowupStep).message === undefined ||
              (s as FollowupStep).message === null ||
              typeof (s as FollowupStep).message === "string"
            ),
        )
      ) {
        res.status(400).json({
          error: "followupSteps must be a non-empty array of {delayMs: number, message?: string}",
        });
        return;
      }
      saves.push(setFollowupSteps(followupSteps as FollowupStep[]));
      req.log.info({ steps: (followupSteps as FollowupStep[]).length }, "follow-up steps updated");
    }

    // ── followupDelays (legacy plain-number array) — still accepted ──────────
    if (followupDelays !== undefined) {
      if (
        !Array.isArray(followupDelays) ||
        followupDelays.length === 0 ||
        !(followupDelays as unknown[]).every((d) => typeof d === "number" && d > 0)
      ) {
        res.status(400).json({ error: "followupDelays must be a non-empty array of positive numbers (milliseconds)" });
        return;
      }
      saves.push(setFollowupDelays(followupDelays as number[]));
      req.log.info({ followupDelays }, "follow-up delays updated (legacy)");
    }

    if (brokerPicks !== undefined) {
      if (
        !Array.isArray(brokerPicks) ||
        !(brokerPicks as unknown[]).every(
          (s) => typeof (s as BrokerPicksSegment).label === "string" &&
                 typeof (s as BrokerPicksSegment).picks === "string"
        )
      ) {
        res.status(400).json({ error: "brokerPicks must be array of {label, picks}" });
        return;
      }
      saves.push(setBrokerPicks(brokerPicks as BrokerPicksSegment[]));
      req.log.info({ segments: (brokerPicks as BrokerPicksSegment[]).length }, "broker picks updated");
    }

    if (qualificationSteps !== undefined) {
      if (
        !Array.isArray(qualificationSteps) ||
        !(qualificationSteps as unknown[]).every(
          (s) =>
            typeof (s as QualificationStep).label === "string" &&
            typeof (s as QualificationStep).message === "string",
        )
      ) {
        res.status(400).json({
          error: "qualificationSteps must be array of {label: string, message: string}",
        });
        return;
      }
      saves.push(setQualificationSteps(qualificationSteps as QualificationStep[]));
      req.log.info({ steps: (qualificationSteps as QualificationStep[]).length }, "qualification steps updated");
    }

    await Promise.all(saves);
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "failed to save settings");
    res.status(500).json({ error: "Internal error" });
  }
});

export default router;
