import { Router } from "express";
import { amoFetch } from "../../lib/amo-client";

const router = Router();

interface AmoPipeline {
  id: number;
  name: string;
}

// GET /api/public/pipelines — every pipeline that exists in amoCRM right now,
// straight from the source (not filtered to what our own sync tracks). A
// brand new pipeline the owner adds shows up here the moment it's created —
// no code change needed on this end. Whether the bot actually generates
// suggestions for leads in a given pipeline is a separate concern
// (amo-sync.ts's own allowlist) — this endpoint is purely "what can I pick
// in the switcher", matching the owner's own pipeline list 1:1.
router.get("/pipelines", async (req, res) => {
  try {
    const data = await amoFetch<{ _embedded: { pipelines: AmoPipeline[] } }>(
      "/api/v4/leads/pipelines?limit=50",
    );
    if (!data) {
      res.status(502).json({ error: "amoCRM fetch failed" });
      return;
    }
    res.json(data._embedded.pipelines.map((p) => ({ name: p.name })));
  } catch (err) {
    req.log.error({ err }, "get pipelines failed");
    res.status(500).json({ error: "internal" });
  }
});

export default router;
