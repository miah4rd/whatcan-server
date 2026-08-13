import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { eq } from "drizzle-orm";
import { db, listingSubmissionsTable } from "@workspace/db";
import { logger } from "../../lib/logger";
import { invalidatePropertyCache, propertyUrlById } from "../../lib/property-catalog";
import { absoluteUrls } from "../../lib/public-url";
import {
  runListingIntakeTurn,
  suggestPropertyCode,
  missingFields,
  EMPTY_DRAFT,
  type ListingDraft,
  type IntakeTurn,
} from "../../lib/listing-intake";
import { pushToSupabase } from "./listing-submissions";

/**
 * "Add a listing" for the brokers, as a chat.
 *
 * This exists because the team was publishing listings by sharing ONE Claude
 * account between them from different browsers — same session, three people,
 * constant collisions. Nothing here is shared: the conversation lives in the
 * broker's own tab and every request carries it in full, so two brokers adding
 * two villas at the same time cannot see or disturb each other.
 *
 * The publishing itself is not new — it is the same submission row and the same
 * `pushToSupabase` the review queue has always used, which is why approving
 * from /listings and publishing from the chat can never drift apart.
 */

const router = Router();

const UPLOAD_DIR = path.join(process.cwd(), "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    cb(null, "listing_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8) + ext);
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

/** Photos land here first; the chat then refers to them by URL. */
router.post("/listing-intake/upload", upload.array("images", 20), (req, res) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  res.json({ ok: true, images: files.map((f) => "/api/uploads/" + f.filename) });
});

function sanitiseTurns(raw: unknown): IntakeTurn[] {
  if (!Array.isArray(raw)) return [];
  // A long conversation is re-sent whole on every turn, so it is capped. The
  // draft, not the transcript, is what actually carries the listing forward.
  return raw
    .slice(-24)
    .map((t) => {
      const o = (t ?? {}) as Record<string, unknown>;
      const role = o["role"] === "assistant" ? "assistant" : "user";
      const images = Array.isArray(o["images"]) ? (o["images"] as unknown[]).map(String).slice(0, 20) : [];
      return { role, text: String(o["text"] ?? "").slice(0, 8000), images } as IntakeTurn;
    })
    .filter((t) => t.text.trim().length > 0 || (t.images ?? []).length > 0);
}

router.post("/listing-intake/chat", async (req, res) => {
  try {
    const body = (req.body ?? {}) as { turns?: unknown; draft?: unknown; broker?: unknown };
    const turns = sanitiseTurns(body.turns);
    if (!turns.length) {
      res.status(400).json({ error: "Nothing to work with — send at least one message." });
      return;
    }
    const draft = { ...EMPTY_DRAFT, ...((body.draft ?? {}) as Partial<ListingDraft>) };

    const result = await runListingIntakeTurn(turns, draft);
    logger.info(
      { broker: String(body.broker ?? ""), ready: result.ready, missing: result.missing },
      "listing intake turn",
    );
    res.json(result);
  } catch (err) {
    logger.error({ err }, "listing intake chat failed");
    res.status(500).json({ error: "The assistant could not answer. Try again." });
  }
});

/** Next free code in the series the team already uses, for the publish form. */
router.get("/listing-intake/code", async (req, res) => {
  try {
    const lt = req.query["listingType"];
    const listingType = lt === "rent" || lt === "sale" ? lt : null;
    res.json(await suggestPropertyCode(listingType));
  } catch (err) {
    logger.error({ err }, "listing code suggestion failed");
    res.json({ suggestion: null, prefixes: [], taken: [] });
  }
});

router.post("/listing-intake/publish", async (req, res) => {
  try {
    const body = (req.body ?? {}) as {
      draft?: Partial<ListingDraft>;
      images?: unknown;
      propertyId?: unknown;
      broker?: unknown;
    };

    const draft: ListingDraft = { ...EMPTY_DRAFT, ...(body.draft ?? {}) };
    const propertyId = String(body.propertyId ?? "").trim();
    const broker = String(body.broker ?? "").trim() || null;

    if (!propertyId) {
      res.status(400).json({ error: "A property code is required (e.g. R-YUD-040)." });
      return;
    }

    // The same completeness rule the chat enforces, checked again here: the
    // publish call is a plain HTTP endpoint and must not depend on the UI
    // having been honest about `ready`.
    const gaps = missingFields(draft);
    if (gaps.length) {
      res.status(400).json({ error: "Still missing: " + gaps.join(", "), missing: gaps });
      return;
    }

    const images = Array.isArray(body.images) ? (body.images as unknown[]).map(String).slice(0, 20) : [];

    // The submission row is written FIRST and always, even if Supabase then
    // refuses the insert. It is the record that this broker submitted this
    // villa at this time; losing it on a failed push would leave the work
    // nowhere, and the broker retyping everything.
    const [row] = await db
      .insert(listingSubmissionsTable)
      .values({
        title: draft.title!,
        area: draft.area!,
        type: draft.type,
        listingType: draft.listingType!,
        bedrooms: draft.bedrooms,
        bathrooms: draft.bathrooms,
        landSize: draft.landSize,
        buildSize: draft.buildSize,
        priceUsd: draft.priceUsd,
        leaseholdPriceUsd: draft.leaseholdPriceUsd,
        monthlyPriceUsd: draft.monthlyPriceUsd,
        yearlyPriceUsd: draft.yearlyPriceUsd,
        monthlyPriceIdr: draft.monthlyPriceIdr,
        yearlyPriceIdr: draft.yearlyPriceIdr,
        ownership: draft.ownership,
        leaseYears: draft.leaseYears,
        purpose: draft.purpose,
        zone: draft.zone,
        description: draft.description,
        features: draft.features ?? [],
        images: absoluteUrls(images),
        videoUrl: draft.videoUrl,
        submitterName: broker,
      })
      .returning();

    const pushed = await pushToSupabase(propertyId, row!, {});
    if (!pushed.ok) {
      // Left as "pending" on purpose: it is now sitting in the review queue at
      // /listings, so a failed publish is a listing waiting for a human, not a
      // listing lost.
      logger.error({ id: row!.id, propertyId, error: pushed.error }, "listing intake publish failed");
      const duplicate = /duplicate key|already exists|23505/i.test(pushed.error);
      res.status(502).json({
        error: duplicate
          ? "Code " + propertyId + " is already taken — pick another one."
          : pushed.error,
        submissionId: row!.id,
      });
      return;
    }

    await db
      .update(listingSubmissionsTable)
      .set({
        status: "approved",
        finalPropertyId: propertyId,
        reviewedBy: broker,
        reviewedAt: new Date(),
      })
      .where(eq(listingSubmissionsTable.id, row!.id));

    // Without this the bot would not offer the new villa for up to ten minutes
    // — the exact complaint that made this cache invalidation exist.
    invalidatePropertyCache();
    logger.info({ id: row!.id, propertyId, broker }, "listing published from intake chat");

    res.json({ ok: true, propertyId, url: propertyUrlById(propertyId), submissionId: row!.id });
  } catch (err) {
    logger.error({ err }, "listing intake publish crashed");
    res.status(500).json({ error: "Internal error" });
  }
});

export default router;
