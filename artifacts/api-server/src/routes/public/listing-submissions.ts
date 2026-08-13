import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { eq } from "drizzle-orm";
import { db, listingSubmissionsTable, type ListingSubmission } from "@workspace/db";
import { logger } from "../../lib/logger";
import { invalidatePropertyCache } from "../../lib/property-catalog";
import { absoluteUrls } from "../../lib/public-url";

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

/**
 * Pushes an approved submission into the SAME Supabase `properties` table the
 * site and the bot's catalog read from. Needs SUPABASE_SERVICE_ROLE_KEY — the
 * anon key the rest of this app uses is read-only by RLS design (verified: a
 * probe insert came back "42501 new row violates row-level security policy"),
 * so approvals cannot go through with the anon key no matter how the request
 * is shaped.
 */
export async function pushToSupabase(
  finalPropertyId: string,
  s: ListingSubmission,
  overrides: Partial<Record<string, unknown>>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const SUPABASE_URL = process.env["SUPABASE_URL"] ?? "";
  const SERVICE_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? "";
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { ok: false, error: "SUPABASE_SERVICE_ROLE_KEY not set on the server — ask the owner to add it to .env" };
  }

  const payload = {
    id: finalPropertyId,
    title: s.title,
    area: s.area,
    type: s.type,
    listing_type: s.listingType,
    bedrooms: s.bedrooms,
    bathrooms: s.bathrooms,
    land_size: s.landSize,
    build_size: s.buildSize,
    price_usd: s.priceUsd,
    leasehold_price_usd: s.leaseholdPriceUsd,
    monthly_price_usd: s.monthlyPriceUsd,
    yearly_price_usd: s.yearlyPriceUsd,
    monthly_price_idr: s.monthlyPriceIdr,
    yearly_price_idr: s.yearlyPriceIdr,
    ownership: s.ownership,
    lease_years: s.leaseYears,
    purpose: s.purpose,
    zone: s.zone,
    description: s.description,
    features: s.features ?? [],
    // Absolute, always. The site renders these from its own domain, so the
    // relative "/api/uploads/x.jpg" this row may hold (every submission before
    // the intake chat stored exactly that) would resolve against the site and
    // 404 — a listing published with invisible photos.
    images: absoluteUrls(s.images),
    video_url: s.videoUrl,
    lat: s.lat,
    lng: s.lng,
    tags: [],
    status: "ready",
    is_draft: false,
    ...overrides,
  };

  const res = await fetch(`${SUPABASE_URL}/rest/v1/properties`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `Supabase insert failed (${res.status}): ${text.slice(0, 300)}` };
  }
  return { ok: true };
}

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
