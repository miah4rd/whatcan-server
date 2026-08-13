import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { eq } from "drizzle-orm";
import { db, listingSubmissionsTable, type ListingSubmission } from "@workspace/db";
import { logger } from "../../lib/logger";
import { invalidatePropertyCache } from "../../lib/property-catalog";
// The Supabase insert lives in lib/listing-publish.ts so that this queue, the
// intake chat in /m and the website assistant all publish through one function.
import { pushToSupabase } from "../../lib/listing-publish";

const router = Router();

// Same on-disk store + /api/uploads/:file static route as routes/upload.ts —
// one upload directory for the whole app, filenames are unique by design
// (fieldname + timestamp), so sharing it is safe.
const UPLOAD_DIR = path.join(process.cwd(), "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    const key = "listing_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8) + ext;
    cb(null, key);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only images allowed"));
  },
});

function toIntOrNull(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}
function toFloatOrNull(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}
function toStrOrNull(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

// ── Public: submit a new listing (no auth — link is shared directly) ────────
router.post("/listing-submissions", upload.array("images", 20), async (req, res) => {
  try {
    const body = req.body as Record<string, string>;

    if (!body.title?.trim() || !body.area?.trim() || !body.listingType?.trim()) {
      res.status(400).json({ error: "title, area and listingType are required" });
      return;
    }

    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const images = files.map((f) => `/api/uploads/${f.filename}`);

    const featuresRaw = toStrOrNull(body.features);
    const features = featuresRaw
      ? featuresRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : [];

    const [row] = await db
      .insert(listingSubmissionsTable)
      .values({
        title: body.title.trim(),
        area: body.area.trim(),
        type: toStrOrNull(body.type),
        listingType: body.listingType.trim(),
        bedrooms: toIntOrNull(body.bedrooms),
        bathrooms: toIntOrNull(body.bathrooms),
        landSize: toIntOrNull(body.landSize),
        buildSize: toIntOrNull(body.buildSize),
        priceUsd: toIntOrNull(body.priceUsd),
        leaseholdPriceUsd: toIntOrNull(body.leaseholdPriceUsd),
        monthlyPriceUsd: toIntOrNull(body.monthlyPriceUsd),
        yearlyPriceUsd: toIntOrNull(body.yearlyPriceUsd),
        monthlyPriceIdr: toIntOrNull(body.monthlyPriceIdr),
        yearlyPriceIdr: toIntOrNull(body.yearlyPriceIdr),
        ownership: toStrOrNull(body.ownership),
        leaseYears: toIntOrNull(body.leaseYears),
        purpose: toStrOrNull(body.purpose),
        zone: toStrOrNull(body.zone),
        description: toStrOrNull(body.description),
        features,
        images,
        videoUrl: toStrOrNull(body.videoUrl),
        lat: toFloatOrNull(body.lat),
        lng: toFloatOrNull(body.lng),
        submitterName: toStrOrNull(body.submitterName),
        submitterContact: toStrOrNull(body.submitterContact),
      })
      .returning();

    logger.info({ id: row!.id, title: row!.title }, "listing submission received");
    res.json({ ok: true, id: row!.id });
  } catch (err) {
    logger.error({ err }, "listing submission failed");
    res.status(500).json({ error: "Internal error" });
  }
});

// ── Review queue (password-gated on the frontend, same as /dashboard) ───────
router.get("/listing-submissions", async (req, res) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : "pending";
    const rows =
      status === "all"
        ? await db.select().from(listingSubmissionsTable)
        : await db.select().from(listingSubmissionsTable).where(eq(listingSubmissionsTable.status, status));
    rows.sort((a: ListingSubmission, b: ListingSubmission) => b.createdAt.getTime() - a.createdAt.getTime());
    res.json({ submissions: rows });
  } catch (err) {
    logger.error({ err }, "list listing submissions failed");
    res.status(500).json({ error: "Internal error" });
  }
});

router.get("/listing-submissions/:id", async (req, res) => {
  try {
    const [row] = await db
      .select()
      .from(listingSubmissionsTable)
      .where(eq(listingSubmissionsTable.id, req.params.id as string))
      .limit(1);
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(row);
  } catch (err) {
    logger.error({ err }, "get listing submission failed");
    res.status(500).json({ error: "Internal error" });
  }
});

router.post("/listing-submissions/:id/reject", async (req, res) => {
  try {
    const { reason, reviewedBy } = req.body as { reason?: string; reviewedBy?: string };
    await db
      .update(listingSubmissionsTable)
      .set({
        status: "rejected",
        rejectionReason: reason ?? null,
        reviewedBy: reviewedBy ?? null,
        reviewedAt: new Date(),
      })
      .where(eq(listingSubmissionsTable.id, req.params.id as string));
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "reject listing submission failed");
    res.status(500).json({ error: "Internal error" });
  }
});

router.post("/listing-submissions/:id/approve", async (req, res) => {
  try {
    const { finalPropertyId, reviewedBy, overrides } = req.body as {
      finalPropertyId?: string;
      reviewedBy?: string;
      overrides?: Record<string, unknown>;
    };

    if (!finalPropertyId?.trim()) {
      res.status(400).json({ error: "finalPropertyId is required — assign the property's real code (e.g. SAI-030)" });
      return;
    }

    const [row] = await db
      .select()
      .from(listingSubmissionsTable)
      .where(eq(listingSubmissionsTable.id, req.params.id as string))
      .limit(1);
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (row.status === "approved") {
      res.status(409).json({ error: "Already approved" });
      return;
    }

    const pushed = await pushToSupabase(finalPropertyId.trim(), row, overrides ?? {});
    if (!pushed.ok) {
      res.status(502).json({ error: pushed.error });
      return;
    }

    await db
      .update(listingSubmissionsTable)
      .set({
        status: "approved",
        finalPropertyId: finalPropertyId.trim(),
        reviewedBy: reviewedBy ?? null,
        reviewedAt: new Date(),
      })
      .where(eq(listingSubmissionsTable.id, req.params.id as string));

    invalidatePropertyCache();
    logger.info({ id: row.id, finalPropertyId }, "listing submission approved and pushed to Supabase");
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "approve listing submission failed");
    res.status(500).json({ error: "Internal error" });
  }
});

export default router;
