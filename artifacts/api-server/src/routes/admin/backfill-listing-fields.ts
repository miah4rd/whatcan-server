/**
 * Fills every Rental Listings card from the conversation already on it.
 *
 * The funnel has been running for weeks and the cards hold a villa name and
 * nothing else, while the bedrooms, the price and the availability sit in the
 * WhatsApp threads. Going forward every owner reply fills its own card
 * (listing-acquisition-prompt.ts); this is the one-off pass over everything
 * that was said before that existed.
 *
 * DRY BY DEFAULT (`?apply=1` to write), like reclassify-stages and for the same
 * reason: it edits cards in the owner's live CRM, and those edits are visible to
 * every person working the funnel.
 */
import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../../lib/logger";
import {
  ensureListingFields,
  extractListingFacts,
  syncListingFactsToCard,
  promoteIfQualified,
  meetsQualified,
  routeUnqualified,
  priceLine,
} from "../../lib/listing-card-fields";

const router = Router();

type Row = { lead_id: string; lead_stage: string | null; convo: string | null };

router.post("/admin/backfill-listing-fields", async (req, res) => {
  const apply = String(req.query["apply"] ?? "") === "1";
  // `&route=1` also MOVES cards: qualified ones forward, the rest into the two
  // parking stages. Separate from `apply` on purpose — filling a field and
  // moving a card in the owner's live CRM are different sizes of act.
  const route = String(req.query["route"] ?? "") === "1";
  const limit = Math.min(Number(req.query["limit"] ?? 400) || 400, 400);
  const only = String(req.query["lead"] ?? "").trim();
  // `&stage=` audits one stage only — "do the cards sitting here actually meet
  // the bar they claim?", which is a different question from filling blanks.
  const onlyStage = String(req.query["stage"] ?? "").trim().toLowerCase();

  const { created, ids } = await ensureListingFields();
  if (!ids.bedrooms || !ids.price) {
    res.status(500).json({ error: "listing fields could not be resolved in amoCRM", ids });
    return;
  }

  // Only cards where the OWNER has said something: a thread holding just our
  // own outreach has nothing to extract, and running the model over it would
  // spend money to learn nothing.
  const result = await db.execute(sql`
    SELECT l.lead_id, l.lead_stage,
           (SELECT string_agg(m.sender_type || ': ' || m.text, E'\n' ORDER BY m.sent_at)
              FROM lead_messages m
             WHERE m.lead_id = l.lead_id AND m.text IS NOT NULL) AS convo
      FROM leads_sync l
     WHERE l.pipeline = 'Rental Listings'
       ${only ? sql`AND l.lead_id = ${only}` : sql``}
       ${onlyStage ? sql`AND lower(coalesce(l.lead_stage,'')) = ${onlyStage}` : sql``}
       AND EXISTS (SELECT 1 FROM lead_messages m
                    WHERE m.lead_id = l.lead_id AND m.sender_type = 'lead')
     ORDER BY l.updated_at DESC
     LIMIT ${limit}
  `);
  const rows = (result.rows ?? []) as unknown as Row[];

  const out: Array<Record<string, unknown>> = [];
  let filled = 0;
  let withPrice = 0;
  let withBedrooms = 0;

  for (const r of rows) {
    const facts = await extractListingFacts(r.convo ?? "");
    if (!facts) continue;
    if (facts.bedrooms) withBedrooms++;
    if (facts.monthlyIdr || facts.yearlyIdr) withPrice++;

    const verdict = meetsQualified(facts);
    let routed: string | null = null;
    if (route) {
      const promoted = await promoteIfQualified(r.lead_id, facts);
      if (promoted.moved) routed = "QUALIFIED";
      else if (promoted.reason.startsWith("not yet")) {
        const parked = await routeUnqualified(r.lead_id, facts);
        if (parked.moved) routed = parked.to ?? null;
      }
    }

    let written = 0;
    let names: string[] = [];
    if (apply) {
      const w = await syncListingFactsToCard(r.lead_id, facts);
      written = w.written;
      names = w.fields;
      if (written > 0) filled++;
    }

    out.push({
      lead: r.lead_id,
      stage: r.lead_stage,
      bedrooms: facts.bedrooms,
      price: priceLine(facts),
      available_from: facts.availableFrom,
      area: facts.area,
      counterpart: facts.counterpart,
      qualifies: verdict.ok,
      missing: verdict.missing,
      stop_signal: facts.stopSignal,
      photos: facts.photosLink ? "yes" : null,
      ...(apply ? { written, fields: names } : {}),
      ...(routed ? { movedTo: routed } : {}),
    });
  }

  logger.info(
    { scanned: rows.length, apply, filled, withBedrooms, withPrice, createdFields: created },
    "backfill-listing-fields finished",
  );
  res.json({
    apply,
    createdFields: created,
    scanned: rows.length,
    withBedrooms,
    withPrice,
    cardsUpdated: filled,
    leads: out,
  });
});

export default router;
