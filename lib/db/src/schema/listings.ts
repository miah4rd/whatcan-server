import { pgTable, text, uuid, integer, jsonb, timestamp, doublePrecision } from "drizzle-orm/pg-core";

/**
 * A listing submitted through the public "add listing" form — NOT yet in the
 * live Supabase `properties` table the site and the bot's catalog read from.
 * Anyone with the link (manager, listing owner) can submit; a team member
 * reviews and approves from /listings before it reaches a real client.
 *
 * The final property code (e.g. "SAI-029", "R-YUD-039") follows a manual
 * area/agent convention, so it's assigned by the reviewer at approval time,
 * not generated here.
 */
export const listingSubmissionsTable = pgTable("listing_submissions", {
  id: uuid("id").primaryKey().defaultRandom(),

  title: text("title").notNull(),
  area: text("area").notNull(),
  type: text("type"), // "villa" | "apartment" | "land" | ...
  listingType: text("listing_type").notNull(), // "sale" | "rent"
  bedrooms: integer("bedrooms"),
  bathrooms: integer("bathrooms"),
  landSize: integer("land_size"),
  buildSize: integer("build_size"),

  priceUsd: integer("price_usd"),
  leaseholdPriceUsd: integer("leasehold_price_usd"),
  monthlyPriceUsd: integer("monthly_price_usd"),
  yearlyPriceUsd: integer("yearly_price_usd"),
  monthlyPriceIdr: integer("monthly_price_idr"),
  yearlyPriceIdr: integer("yearly_price_idr"),

  ownership: text("ownership"), // "freehold" | "leasehold"
  leaseYears: integer("lease_years"),
  purpose: text("purpose"),
  zone: text("zone"),

  description: text("description"),
  features: jsonb("features").$type<string[]>().default([]),
  images: jsonb("images").$type<string[]>().default([]),
  videoUrl: text("video_url"),
  /** ISO date the rental is free from; null = free now. Written to property_availability on publish. */
  availableFrom: text("available_from"),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),

  submitterName: text("submitter_name"),
  submitterContact: text("submitter_contact"),

  status: text("status").notNull().default("pending"), // "pending" | "approved" | "rejected"
  rejectionReason: text("rejection_reason"),
  finalPropertyId: text("final_property_id"), // code assigned at approval, e.g. "SAI-030"
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ListingSubmission = typeof listingSubmissionsTable.$inferSelect;
export type NewListingSubmission = typeof listingSubmissionsTable.$inferInsert;
