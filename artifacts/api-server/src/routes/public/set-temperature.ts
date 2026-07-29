import { Router } from "express";
import { db, leadsSyncTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

const VALID = new Set(["cold", "warm", "hot"]);

router.options("/set-temperature", (_req, res) => res.sendStatus(204));

/**
 * POST /set-temperature  { leadId, temperature, brokerId? }
 *
 * The broker manually corrects the bot's temperature read from the extension.
 * Their call is authoritative and STICKY: profile_temperature_source becomes
 * "broker", so the periodic profile refresh keeps their value instead of
 * overwriting it (lib/lead-profile.ts). The AI's own latest read is preserved in
 * profile_temperature_ai, and the disagreement (ai vs broker) is later fed back
 * into the profile prompt as calibration so the bot learns this broker's lens.
 *
 * The value drives the daily PUSH ranking (computePushPriority) the moment the
 * next /suggestions poll runs — no extra wiring needed.
 */
router.post("/set-temperature", async (req, res) => {
  const { leadId, temperature } = req.body as {
    leadId?: string;
    temperature?: string;
    brokerId?: string;
  };

  if (!leadId || typeof leadId !== "string") {
    return void res.status(400).json({ error: "leadId required" });
  }
  const temp = String(temperature ?? "").toLowerCase().trim();
  if (!VALID.has(temp)) {
    return void res.status(400).json({ error: "temperature must be one of cold | warm | hot" });
  }

  try {
    // Read the current AI read first so we don't clobber it — it's the "what the
    // bot thought" half of the calibration pair. If we've never profiled this
    // lead, seed the AI column with the prior effective value (may be null).
    const [cur] = await db
      .select({
        temp: leadsSyncTable.profileTemperature,
        ai: leadsSyncTable.profileTemperatureAi,
      })
      .from(leadsSyncTable)
      .where(eq(leadsSyncTable.leadId, leadId))
      .limit(1);

    if (!cur) {
      return void res.status(404).json({ error: "lead not found" });
    }

    const aiRead = cur.ai ?? cur.temp ?? null;

    await db
      .update(leadsSyncTable)
      .set({
        profileTemperature: temp,
        profileTemperatureSource: "broker",
        profileTemperatureAi: aiRead,
        profileTemperatureOverrideAt: new Date(),
      })
      .where(eq(leadsSyncTable.leadId, leadId));

    req.log.info({ leadId, temperature: temp, previousAi: aiRead }, "broker set lead temperature");
    res.json({ ok: true, temperature: temp });
  } catch (err) {
    req.log.error({ err, leadId }, "set-temperature failed");
    res.status(500).json({ error: "internal error" });
  }
});

export default router;
