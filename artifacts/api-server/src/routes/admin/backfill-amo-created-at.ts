/**
 * POST /api/admin/backfill-amo-created-at
 *
 * Fetches ALL leads from amoCRM and backfills amo_created_at in leads_sync
 * using raw SQL (pool.query) to guarantee it runs regardless of Drizzle
 * schema state. Safe to run multiple times (idempotent).
 *
 * Returns: { updated, skipped_no_created_at, sample_lead }
 */
import { Router } from "express";
import { amoFetch } from "../../lib/amo-client";
import { pool } from "@workspace/db";
import { logger } from "../../lib/logger";

const router = Router();

type AmoLeadRaw = {
  id: number;
  name?: string;
  status_id?: number;
  created_at?: number;
  [key: string]: unknown;
};

async function* fetchAllLeadsRaw(): AsyncGenerator<AmoLeadRaw> {
  let page = 1;
  while (true) {
    const data = await amoFetch<{
      _embedded?: { leads: AmoLeadRaw[] };
    }>(`/api/v4/leads?limit=250&page=${page}&order[updated_at]=desc`);

    if (!data || !data._embedded?.leads?.length) break;

    for (const lead of data._embedded.leads) yield lead;

    if (data._embedded.leads.length < 250) break;
    page++;
    await new Promise((r) => setTimeout(r, 200));
  }
}

router.post("/admin/backfill-amo-created-at", async (req, res) => {
  let updated = 0;
  let skippedNoCreatedAt = 0;
  let sampleLead: AmoLeadRaw | null = null;
  let sampleLeadCount = 0;

  try {
    for await (const lead of fetchAllLeadsRaw()) {
      // Capture first 3 leads for diagnostic sample
      if (sampleLeadCount < 3) {
        if (!sampleLead) sampleLead = lead;
        sampleLeadCount++;
        logger.info(
          {
            leadId: lead.id,
            created_at: lead.created_at,
            keys: Object.keys(lead),
          },
          "backfill-amo-created-at: sample lead"
        );
      }

      if (!lead.created_at) {
        skippedNoCreatedAt++;
        continue;
      }

      const amoCreatedAt = new Date(lead.created_at * 1000);

      // Raw SQL — guaranteed to work regardless of Drizzle schema cache
      await pool.query(
        `UPDATE leads_sync SET amo_created_at = $1 WHERE lead_id = $2`,
        [amoCreatedAt.toISOString(), String(lead.id)]
      );
      updated++;
    }

    logger.info({ updated, skippedNoCreatedAt }, "backfill-amo-created-at: complete");

    res.json({
      ok: true,
      updated,
      skipped_no_created_at: skippedNoCreatedAt,
      sample_first_lead_fields: sampleLead ? Object.keys(sampleLead) : null,
      sample_created_at: sampleLead?.created_at ?? null,
    });
  } catch (err) {
    logger.error({ err }, "backfill-amo-created-at: failed");
    res.status(500).json({ ok: false, error: String(err) });
  }
});

export default router;
