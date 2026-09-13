/**
 * GET /photo-variants/w<width>/<bucket>/<path> — a catalog photo resized by
 * lib/photo-variants.ts, for the website's worker (worker/image-edge.js in
 * bali-villa-rentals). 404 means "not rendered yet" and puts it first in the
 * queue; the worker then falls back to Supabase's transformer.
 * GET /photo-variants/_status — progress of the backlog.
 */
import { Router } from "express";
import { promises as fs } from "node:fs";
import { VARIANT_WIDTHS, normalizeObjectPath, photoVariantStats, requestVariant, variantFileFor } from "../lib/photo-variants";

const router = Router();
const PREFIX = "/photo-variants/";

router.use("/photo-variants", async (req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    next();
    return;
  }
  const raw = (req.originalUrl.split("?")[0] ?? "").slice(PREFIX.length);
  if (raw === "_status") {
    res.set("Cache-Control", "no-store").json(photoVariantStats());
    return;
  }
  const m = raw.match(/^w(\d+)\/(.+)$/);
  const width = m ? Number(m[1]) : NaN;
  const objectPath = m ? normalizeObjectPath(m[2]!) : null;
  if (!objectPath || !(VARIANT_WIDTHS as readonly number[]).includes(width)) {
    res.status(400).set("Cache-Control", "no-store").end();
    return;
  }
  const file = variantFileFor(objectPath, width);
  try {
    await fs.access(file);
  } catch {
    requestVariant(objectPath);
    res.status(404).set("Cache-Control", "no-store").end();
    return;
  }
  res.set("Cache-Control", "public, max-age=31536000, immutable");
  res.type("image/webp");
  res.sendFile(file);
});

export default router;
