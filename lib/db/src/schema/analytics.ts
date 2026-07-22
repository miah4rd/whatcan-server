import { pgTable, text, integer, jsonb, timestamp, primaryKey, bigint } from "drizzle-orm/pg-core";

export const amoDealsTable = pgTable("amo_deals", {
  id: text("id").primaryKey(),
  name: text("name"),
  price: integer("price"),
  statusId: text("status_id"),
  statusName: text("status_name"),
  pipelineId: text("pipeline_id"),
  pipelineName: text("pipeline_name"),
  responsibleUserId: bigint("responsible_user_id", { mode: "number" }),
  responsibleUserName: text("responsible_user_name"),
  lossReasonId: text("loss_reason_id"),
  lossReasonName: text("loss_reason_name"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  amoCreatedAt: timestamp("amo_created_at", { withTimezone: true }),
  amoUpdatedAt: timestamp("amo_updated_at", { withTimezone: true }),
  tags: jsonb("tags").$type<Array<{ id: number; name: string }>>(),
  customFields: jsonb("custom_fields"),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

export const amoContactsTable = pgTable("amo_contacts", {
  id: text("id").primaryKey(),
  name: text("name"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  phone: text("phone"),
  email: text("email"),
  customFields: jsonb("custom_fields"),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

export const amoCompaniesTable = pgTable("amo_companies", {
  id: text("id").primaryKey(),
  name: text("name"),
  phone: text("phone"),
  email: text("email"),
  customFields: jsonb("custom_fields"),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

export const amoLeadContactsTable = pgTable("amo_lead_contacts", {
  leadId: text("lead_id").notNull(),
  contactId: text("contact_id").notNull(),
}, (t) => [primaryKey({ columns: [t.leadId, t.contactId] })]);

export const amoLeadCompaniesTable = pgTable("amo_lead_companies", {
  leadId: text("lead_id").notNull(),
  companyId: text("company_id").notNull(),
}, (t) => [primaryKey({ columns: [t.leadId, t.companyId] })]);

export type AmoDeal = typeof amoDealsTable.$inferSelect;
export type AmoContact = typeof amoContactsTable.$inferSelect;
export type AmoCompany = typeof amoCompaniesTable.$inferSelect;
