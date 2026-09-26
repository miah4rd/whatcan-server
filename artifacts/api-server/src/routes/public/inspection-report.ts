import { Router } from "express";
import { pool } from "@workspace/db";
import { recordBrokerVisit } from "../../lib/listing-progress";
import {
  AMO_CARD_URL,
  announceDue,
  cancelReport,
  closeNotListing,
  dropPrematureReports,
  ensureTable,
  fileReport,
  getReport,
  isRunning,
  missingFields,
  recopyToDrive,
  NOT_LISTING_REASONS,
  runDuePass,
  saveDraft,
  signedUpload,
  startReport,
  siteListing,
  tidyNotes,
  type ReportRow,
} from "../../lib/inspection-report";

/**
 * The inspection report form (lib/inspection-report.ts). The report id is the capability, as the
 * viewing report's is. The page is /m/inspection/<id> (routes/inspection-page.ts).
 */
const router = Router();

function view(rep: ReportRow) {
  return {
    id: rep.id,
    lead_id: rep.lead_id,
    property_code: rep.property_code,
    visit_at: new Date(rep.visit_at).toISOString(),
    status: rep.status,
    red_flags: rep.red_flags,
    green_flags: rep.green_flags,
    construction_nearby: rep.construction_nearby,
    notes: rep.notes,
    photos: rep.photos ?? [],
    photos_skipped: rep.photos_skipped ?? null,
    video_skipped: rep.video_skipped ?? null,
    cover: rep.cover,
    video_url: rep.video_url,
    private_edits: rep.private_edits ?? {},
    checks: rep.checks ?? [],
    not_listing_reason: rep.not_listing_reason,
    wa_message_id: rep.wa_message_id,
  };
}

router.get("/public/inspection-report/:id", async (req, res) => {
  const rep = await getReport(req.params.id);
  if (!rep) { res.status(404).json({ error: "report not found" }); return; }
  const site = rep.property_code ? await siteListing(rep.property_code).catch(() => ({ property: null, priv: null })) : { property: null, priv: null };
  res.json({
    report: view(rep),
    listing: site.property,
    private: site.priv
      ? {
          owner_name: site.priv.owner_name,
          owner_phone: site.priv.owner_phone,
          google_maps_url: site.priv.google_maps_url,
          drive_folder_url: site.priv.drive_folder_url,
          red_flags: site.priv.red_flags,
          green_flags: site.priv.green_flags,
          construction_nearby: site.priv.construction_nearby,
        }
      : null,
    reasons: NOT_LISTING_REASONS,
    card_url: AMO_CARD_URL(rep.lead_id),
    site_url: rep.property_code ? `https://unicorn-properties.com/property/${rep.property_code}` : null,
  });
});

router.get("/public/inspection-report/:id/status", async (req, res) => {
  const rep = await getReport(req.params.id);
  if (!rep) { res.status(404).json({ error: "report not found" }); return; }
  const status = rep.status === "checking" && !isRunning(rep.id) ? "failed" : rep.status;
  res.json({ status, checks: rep.checks ?? [] });
});

router.post("/public/inspection-report/:id/save", async (req, res) => {
  const b = (req.body ?? {}) as Record<string, any>;
  const arr = (v: unknown) => (Array.isArray(v) ? v.map(String) : undefined);
  const rep = await saveDraft(req.params.id, {
    propertyCode: b.propertyCode ? String(b.propertyCode) : null,
    red: arr(b.red),
    green: arr(b.green),
    construction: typeof b.construction === "boolean" ? b.construction : undefined,
    notes: typeof b.notes === "string" ? b.notes : undefined,
    notesRaw: typeof b.notesRaw === "string" ? b.notesRaw : undefined,
    photos: arr(b.photos),
    cover: b.cover === null || typeof b.cover === "string" ? b.cover : undefined,
    video: b.video === null || typeof b.video === "string" ? b.video : undefined,
    photosSkipped: b.photosSkipped === null || typeof b.photosSkipped === "string" ? b.photosSkipped : undefined,
    videoSkipped: b.videoSkipped === null || typeof b.videoSkipped === "string" ? b.videoSkipped : undefined,
    privateEdits: b.privateEdits && typeof b.privateEdits === "object" ? b.privateEdits : undefined,
  });
  if (!rep) { res.status(404).json({ error: "report not found" }); return; }
  res.json({ ok: true, report: view(rep), missing: missingFields(rep, true) });
});

router.post("/public/inspection-report/:id/tidy", async (req, res) => {
  const rep = await getReport(req.params.id);
  if (!rep) { res.status(404).json({ error: "report not found" }); return; }
  try {
    const text = await tidyNotes(String(req.body?.text ?? ""), rep.property_code);
    if (!text) { res.status(422).json({ error: "nothing to tidy" }); return; }
    await pool.query(`UPDATE inspection_reports SET notes_raw = $2 WHERE id = $1`, [rep.id, String(req.body?.text ?? "").slice(0, 5000)]);
    res.json({ ok: true, text });
  } catch (err) {
    res.status(503).json({ error: "AI is not available right now — edit the text by hand" });
  }
});

router.post("/public/inspection-report/:id/upload", async (req, res) => {
  const rep = await getReport(req.params.id);
  if (!rep) { res.status(404).json({ error: "report not found" }); return; }
  if (!rep.property_code) { res.status(400).json({ error: "name the villa code first" }); return; }
  const kind = req.body?.kind === "video" ? "video" : "photo";
  try {
    res.json(await signedUpload(rep.property_code, kind, String(req.body?.name ?? "")));
  } catch (err) {
    res.status(503).json({ error: String((err as Error).message).slice(0, 200) });
  }
});

router.post("/public/inspection-report/:id/done", async (req, res) => {
  const r = await fileReport(req.params.id, req.body?.broker ? String(req.body.broker) : null);
  res.status(r.ok ? 200 : r.missing ? 422 : 404).json(r);
});

router.post("/public/inspection-report/:id/not-listing", async (req, res) => {
  const r = await closeNotListing(req.params.id, String(req.body?.reason ?? ""), String(req.body?.notes ?? ""), req.body?.broker ? String(req.body.broker) : null);
  res.status(r.ok || r.checks ? 200 : 422).json(r);
});

/** The broker starts a report himself on a Rental Listings card that has none. */
router.post("/public/inspection-report/start", async (req, res) => {
  const r = await startReport(String(req.body?.leadId ?? "").trim(), req.body?.broker ? String(req.body.broker) : null);
  res.status(r.ok ? 200 : 422).json(r);
});

/** The visit did not happen: drop the report. */
router.post("/public/inspection-report/:id/cancel", async (req, res) => {
  const r = await cancelReport(req.params.id, req.body?.broker ? String(req.body.broker) : null);
  res.status(r.ok ? 200 : 422).json(r);
});

/**
 * The broker sets the inspection date himself (a visit agreed by phone or in person): the slot, the
 * stage and the calendar follow (lib/listing-progress.ts recordBrokerVisit). Body {leadId | reportId, at}.
 */
router.post("/public/inspection-report/schedule", async (req, res) => {
  let leadId = String(req.body?.leadId ?? "").trim();
  if (!leadId && req.body?.reportId) leadId = (await getReport(String(req.body.reportId)))?.lead_id ?? "";
  const at = new Date(String(req.body?.at ?? ""));
  const r = await recordBrokerVisit(leadId, at, req.body?.broker ? String(req.body.broker) : null);
  if (r.ok) await dropPrematureReports(leadId, at).catch(() => undefined);
  res.status(r.ok ? 200 : 422).json(r);
});

/** Copy a filed report's photos and video to Drive now (admin). */
router.post("/admin/inspection-report/:id/drive", async (req, res) => {
  res.json(await recopyToDrive(req.params.id));
});

/** Run the visit watch now (admin). */
router.post("/admin/visit-watch", async (_req, res) => {
  const { runVisitWatch } = await import("../../lib/listing-progress");
  res.json(await runVisitWatch());
});

// ── Admin ─────────────────────────────────────────────────────────────────────

/** Run the due pass now; `?dry=1` lists what it would create. */
router.post("/admin/inspection-report/due", async (req, res) => {
  res.json(await runDuePass({ dry: String(req.query["dry"] ?? "") === "1" }));
});

/** A report by hand for a visit the slots table does not hold: `?lead=&at=<ISO>&code=R-…`. */
router.post("/admin/inspection-report/create", async (req, res) => {
  const lead = String(req.query["lead"] ?? "").trim();
  const at = new Date(String(req.query["at"] ?? ""));
  const code = String(req.query["code"] ?? "").trim().toUpperCase() || null;
  if (!/^\d+$/.test(lead) || Number.isNaN(at.getTime())) { res.status(400).json({ error: "lead and at (ISO) required" }); return; }
  await ensureTable();
  const exists = await pool.query(`SELECT id FROM inspection_reports WHERE lead_id = $1 AND status IN ('due', 'checking', 'failed')`, [lead]);
  if (exists.rows.length) { res.json({ id: exists.rows[0].id, existed: true }); return; }
  const r = await pool.query(`INSERT INTO inspection_reports (lead_id, property_code, visit_at) VALUES ($1, $2, $3) RETURNING id`, [lead, code, at]);
  // ?announce=1: the same task, push and inbox card the scheduled pass gives a fresh inspection.
  if (String(req.query["announce"] ?? "") === "1") await announceDue(lead, code, at, null).catch(() => undefined);
  res.json({ id: r.rows[0].id, url: `/m/inspection/${r.rows[0].id}` });
});

router.get("/admin/inspection-report/list", async (_req, res) => {
  await ensureTable();
  const r = await pool.query(
    `SELECT id, lead_id, property_code, visit_at, status, filed_by, filed_at, done_at, checks FROM inspection_reports ORDER BY created_at DESC LIMIT 50`,
  );
  res.json(r.rows);
});

export default router;
