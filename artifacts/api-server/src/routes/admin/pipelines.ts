import { Router } from "express";
import { amoFetch } from "../../lib/amo-client";
import { logger } from "../../lib/logger";

const router = Router();

interface AmoStatus {
  id: number;
  name: string;
  sort: number;
}
interface AmoPipeline {
  id: number;
  name: string;
  _embedded: { statuses: AmoStatus[] };
}

/**
 * GET /api/admin/pipelines
 * Read-only dump of amoCRM pipelines + their stage IDs, for configuring
 * pipeline-specific automation (e.g. FOLLOWUP_STAGE_ADVANCE maps).
 */
router.get("/admin/pipelines", async (_req, res) => {
  try {
    const data = await amoFetch<{ _embedded: { pipelines: AmoPipeline[] } }>(
      "/api/v4/leads/pipelines?limit=50",
    );
    if (!data) {
      res.status(502).json({ error: "amoCRM fetch failed" });
      return;
    }
    const result = data._embedded.pipelines.map((p) => ({
      id: p.id,
      name: p.name,
      statuses: p._embedded.statuses
        .sort((a, b) => a.sort - b.sort)
        .map((s) => ({ id: s.id, name: s.name })),
    }));
    res.json({ pipelines: result });
  } catch (err) {
    logger.error({ err }, "admin/pipelines error");
    res.status(500).json({ error: "internal error" });
  }
});

/**
 * GET /api/admin/raw-lead/:id
 * Read-only dump of a single amoCRM lead (tags, custom fields, embedded contact/company),
 * for inspecting what data is available to distinguish ad campaigns / listing sources.
 */
router.get("/admin/raw-lead/:id", async (req, res) => {
  try {
    const data = await amoFetch(
      `/api/v4/leads/${req.params.id}?with=contacts,companies,catalog_elements`,
    );
    if (!data) {
      res.status(502).json({ error: "amoCRM fetch failed" });
      return;
    }
    res.json(data);
  } catch (err) {
    logger.error({ err }, "admin/raw-lead error");
    res.status(500).json({ error: "internal error" });
  }
});

export default router;
