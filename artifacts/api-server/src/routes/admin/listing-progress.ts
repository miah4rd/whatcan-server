import { Router } from "express";
import { getAmoLead } from "../../lib/amo-client";
import { amoStageFor } from "../../lib/stage-classifier";
import { LISTING_STAGE, LISTINGS_PIPELINE_ID } from "../../lib/listing-status-week";
import { advanceListingProgress, applyForwardPath, auditListingProgress, restoreFromDeletedStage } from "../../lib/listing-progress";

const router = Router();

/**
 * Rental Listings after qualification: QUALIFIED → Inspection scheduled, and a changed time on a card
 * already there (lib/listing-progress.ts). "Details ased" was deleted by the owner on 14.09.2026.
 *
 * POST /api/admin/listing-progress            dry: every open QUALIFIED / Inspection scheduled card
 *   ?apply=1                                  move forward / record a changed visit as the rules say
 *   ?lead=<id>                                one card
 *   ?taken=1                                  also report TAKEN TO WORK cards with an agreed visit (never moved)
 *
 * POST /api/admin/listing-progress/move?lead=&to=inspection&evidence=<text>[&visitAt=ISO][&apply=1]
 *   A hand-checked forward move whose evidence the rule cannot see (a duplicate card's thread).
 *   Forward only; dry unless apply=1; the evidence is written into the card's note.
 */
router.post("/admin/listing-progress", async (req, res) => {
  const apply = String(req.query["apply"] ?? "") === "1";
  const lead = String(req.query["lead"] ?? "").trim();
  const reportTaken = String(req.query["taken"] ?? "") === "1";
  // ?past=N (with lead=): also record a visit whose hour passed up to N days ago (max 14) — calendar backfill.
  const pastRaw = Number(req.query["past"] ?? 0);
  const pastDays = Number.isFinite(pastRaw) && pastRaw > 0 ? Math.min(pastRaw, 14) : undefined;
  const decisions = lead
    ? [await advanceListingProgress(lead, { source: "admin", apply, full: true, reportTaken, pastDays })]
    : await auditListingProgress({ apply, reportTaken, source: "admin" });
  const brief = decisions.map((d) => ({
    leadId: d.leadId,
    from: d.from,
    to: d.to,
    moved: d.moved,
    applied: d.applied,
    reason: d.reason,
    visit: d.visit ? { at: d.visit.visitAt, timeKnown: d.visit.timeKnown, agreedAt: d.visit.agreedAt, quote: d.visit.quote } : null,
    windowStart: d.windowStart,
  }));
  res.json({
    apply,
    scanned: brief.length,
    wouldMove: brief.filter((d) => d.to && !d.moved).length,
    moved: brief.filter((d) => d.moved).length,
    decisions: brief,
  });
});

/**
 * POST /api/admin/listing-progress/restore?lead=<id>[,<id>…][&apply=1]
 * A card amoCRM dropped into the first stage when its stage was deleted goes back to its stage before.
 */
router.post("/admin/listing-progress/restore", async (req, res) => {
  const apply = String(req.query["apply"] ?? "") === "1";
  const leads = String(req.query["lead"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (leads.length === 0) {
    res.status(400).json({ error: "lead required" });
    return;
  }
  const out = [];
  for (const lead of leads) out.push({ lead, ...(await restoreFromDeletedStage(lead, apply)) });
  res.json({ apply, results: out });
});

router.post("/admin/listing-progress/move", async (req, res) => {
  const apply = String(req.query["apply"] ?? "") === "1";
  const lead = String(req.query["lead"] ?? "").trim();
  const to = String(req.query["to"] ?? "").trim();
  const evidence = String(req.query["evidence"] ?? "").trim();
  const visitAtRaw = String(req.query["visitAt"] ?? "").trim();
  if (to === "details") {
    res.status(410).json({ error: "the Details stage was deleted in amoCRM on 14.09.2026 — only to=inspection" });
    return;
  }
  if (!lead || !evidence || to !== "inspection") {
    res.status(400).json({ error: "lead, to=inspection and evidence are required" });
    return;
  }
  const amo = await getAmoLead(lead);
  if (!amo?.status_id || amo.pipeline_id !== LISTINGS_PIPELINE_ID) {
    res.status(404).json({ error: "not a Rental Listings card amoCRM returned" });
    return;
  }
  const current = amo.status_id;
  const path = [LISTING_STAGE.INSPECTION_SCHEDULED];
  if (current !== LISTING_STAGE.QUALIFIED) {
    res.status(409).json({ error: `card is in status ${current}; only QUALIFIED → Inspection scheduled` });
    return;
  }
  const visitAt = visitAtRaw ? new Date(visitAtRaw) : null;
  if (visitAt && Number.isNaN(visitAt.getTime())) {
    res.status(400).json({ error: "visitAt is not a date" });
    return;
  }
  const where = await amoStageFor(amo.pipeline_id, current).catch(() => null);
  if (!apply) {
    res.json({ apply, lead, from: where?.stage ?? current, path, evidence, visitAt });
    return;
  }
  const r = await applyForwardPath(lead, current, path, {
    source: "admin-move",
    all: where?.all,
    visit: visitAt ? { visitAt, timeKnown: true, agreedAt: null, quote: evidence.slice(0, 200), why: "hand-checked" } : null,
    evidenceNote: `Evidence (checked by hand): ${evidence}`,
  });
  res.json({ apply, lead, from: where?.stage ?? current, path, ...r });
});

export default router;
