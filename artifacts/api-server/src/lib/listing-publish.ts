import { eq } from "drizzle-orm";
import { db, listingSubmissionsTable, type ListingSubmission } from "@workspace/db";
import { logger } from "./logger";
import { invalidatePropertyCache, propertyUrlById } from "./property-catalog";
import { absoluteUrls } from "./public-url";
import { missingFields, suggestPropertyCode, type ListingDraft } from "./listing-intake";

/**
 * The one road a finished listing takes into the live catalog.
 *
 * There are now three surfaces that publish: the review queue at /listings, the
 * intake chat in `/m`, and the assistant embedded in the website for logged-in
 * brokers. This file exists so they cannot drift — the same submission row, the
 * same completeness check, the same Supabase insert, the same cache
 * invalidation. (The project has already paid for two copies of one feature
 * more than once; see the generateSuggestion note in CLAUDE.md.)
 */

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

export function isDuplicateCodeError(error: string): boolean {
  return /duplicate key|already exists|23505/i.test(error);
}

/** "R-YUD-039" → "R-YUD-040". Used only to step past a code taken mid-publish. */
export function bumpPropertyCode(code: string): string | null {
  const m = /^(.*[^0-9])(\d+)$/.exec(code);
  if (!m) return null;
  const digits = m[2]!;
  return m[1]! + String(parseInt(digits, 10) + 1).padStart(digits.length, "0");
}

export type PublishOutcome =
  | { ok: true; propertyId: string; url: string; submissionId: string }
  | { ok: false; error: string; missing?: string[]; duplicate?: boolean; submissionId?: string };

/**
 * Turns a finished draft into a live listing.
 *
 * `propertyId` is normally the code the broker typed. Pass "auto" and the next
 * free code in the series is chosen here — that is what the website assistant
 * does, because there is no form on that surface to type a code into.
 */
export async function publishListingDraft(opts: {
  draft: ListingDraft;
  images: string[];
  propertyId: string;
  broker: string | null;
}): Promise<PublishOutcome> {
  const { draft, broker } = opts;
  const images = (opts.images ?? []).slice(0, 20);

  // The same completeness rule the chat enforces, checked again here: publishing
  // is a plain HTTP endpoint and must not depend on the UI having been honest
  // about `ready`.
  const gaps = missingFields(draft);
  if (gaps.length) {
    return { ok: false, error: "Still missing: " + gaps.join(", "), missing: gaps };
  }

  const auto = !opts.propertyId || opts.propertyId.trim().toLowerCase() === "auto";
  let code = auto
    ? (await suggestPropertyCode(draft.listingType)).suggestion ?? ""
    : opts.propertyId.trim();
  if (!code) {
    return { ok: false, error: "A property code is required (e.g. R-YUD-040)." };
  }

  // The submission row is written FIRST and always, even if Supabase then
  // refuses the insert. It is the record that this broker submitted this villa
  // at this time; losing it on a failed push would leave the work nowhere, and
  // the broker retyping everything.
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

  // A code chosen automatically can lose a race with another broker publishing
  // in the same second. That is not an error worth showing anybody — step to the
  // next number and try again, reusing the SAME submission row so a race never
  // leaves duplicates sitting in the review queue.
  let pushed = await pushToSupabase(code, row!, {});
  for (let attempt = 0; attempt < 3 && !pushed.ok && auto && isDuplicateCodeError(pushed.error); attempt++) {
    const next = bumpPropertyCode(code);
    if (!next) break;
    code = next;
    pushed = await pushToSupabase(code, row!, {});
  }

  if (!pushed.ok) {
    // Left as "pending" on purpose: it is now sitting in the review queue at
    // /listings, so a failed publish is a listing waiting for a human, not a
    // listing lost.
    logger.error({ id: row!.id, propertyId: code, error: pushed.error }, "listing publish failed");
    return {
      ok: false,
      error: pushed.error,
      duplicate: isDuplicateCodeError(pushed.error),
      submissionId: row!.id,
    };
  }

  await db
    .update(listingSubmissionsTable)
    .set({
      status: "approved",
      finalPropertyId: code,
      reviewedBy: broker,
      reviewedAt: new Date(),
    })
    .where(eq(listingSubmissionsTable.id, row!.id));

  // Without this the bot would not offer the new villa for up to ten minutes —
  // the exact complaint that made this cache invalidation exist.
  invalidatePropertyCache();
  logger.info({ id: row!.id, propertyId: code, broker }, "listing published");

  return { ok: true, propertyId: code, url: propertyUrlById(code), submissionId: row!.id };
}
