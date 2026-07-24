import { pgTable, text, uuid, integer, jsonb, timestamp, boolean, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const aiSuggestionsTable = pgTable("ai_suggestions", {
  id: uuid("id").primaryKey().defaultRandom(),
  brokerId: text("broker_id").notNull(),
  leadId: text("lead_id"),
  leadName: text("lead_name"),
  leadCompany: text("lead_company"),
  leadStage: text("lead_stage"),
  promptMessages: jsonb("prompt_messages").notNull(),
  suggestionText: text("suggestion_text").notNull(),
  rationale: text("rationale"),
  model: text("model").notNull().default("claude-3-5-haiku-20241022"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const suggestionFeedbackTable = pgTable("suggestion_feedback", {
  id: uuid("id").primaryKey().defaultRandom(),
  suggestionId: uuid("suggestion_id").notNull(),
  brokerId: text("broker_id").notNull(),
  verdict: text("verdict").notNull(),
  finalText: text("final_text"),
  comment: text("comment"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const pendingSuggestionsTable = pgTable("pending_suggestions", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: text("lead_id").notNull(),
  responsibleUser: text("responsible_user"),
  kind: text("kind").notNull(),
  followupLevel: integer("followup_level"),
  suggestionText: text("suggestion_text").notNull(),
  triggeredByMessageAt: timestamp("triggered_by_message_at", { withTimezone: true }),
  status: text("status").notNull().default("pending"),
  finalText: text("final_text"),
  objectionCategory: text("objection_category"),
  attachments: jsonb("attachments").$type<Array<{
    type: "link" | "image" | "reminder";
    label: string;
    url?: string | null;
    storageKey?: string;
  }>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sentMessagesTable = pgTable("sent_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: text("lead_id").notNull(),
  suggestionId: uuid("suggestion_id"),
  kind: text("kind"),
  messageText: text("message_text").notNull(),
  responsibleUser: text("responsible_user"),
  webhookStatus: integer("webhook_status"),
  webhookResponse: text("webhook_response"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const leadsSyncTable = pgTable("leads_sync", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: text("lead_id").notNull().unique(),
  responsibleUser: text("responsible_user"),
  content: text("content"),
  leadNotes: text("lead_notes"),
  leadStage: text("lead_stage"),
  leadStageId: text("lead_stage_id"),
  pipeline: text("pipeline"),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  lastMessageFrom: text("last_message_from"),
  lastOurMessageAt: timestamp("last_our_message_at", { withTimezone: true }),
  followupLevel: integer("followup_level").default(0),
  nextFollowupAt: timestamp("next_followup_at", { withTimezone: true }),
  botExcluded: boolean("bot_excluded").default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  amoCreatedAt: timestamp("amo_created_at", { withTimezone: true }),
});

export const brokerSettingsTable = pgTable("broker_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const propertiesTable = pgTable("properties", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),          // e.g. UM-017
  title: text("title").notNull(),
  location: text("location").notNull(),           // e.g. Umalas, Canggu
  area: text("area"),                             // e.g. Canggu region
  priceUsd: integer("price_usd"),                 // price in USD
  priceLabel: text("price_label"),                // e.g. "$380,000" or "from $300K"
  bedrooms: integer("bedrooms"),
  propertyType: text("property_type"),            // villa / apartment / land
  tenure: text("tenure"),                         // leasehold / freehold
  tenureYears: integer("tenure_years"),
  roiPercent: text("roi_percent"),                // e.g. "12-14%"
  purpose: text("purpose"),                       // "investment" | "lifestyle" | "both"
  highlight: text("highlight"),                   // 1-sentence selling point
  url: text("url"),                               // direct link on site
  status: text("status").notNull().default("active"), // active / sold / off-market
  tags: text("tags"),                             // comma-separated: "pool,beachside,ready-to-rent"
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Property = typeof propertiesTable.$inferSelect;

export const insertAiSuggestionSchema = createInsertSchema(aiSuggestionsTable).omit({ id: true, createdAt: true });
export const insertSuggestionFeedbackSchema = createInsertSchema(suggestionFeedbackTable).omit({ id: true, createdAt: true });
export const insertPendingSuggestionSchema = createInsertSchema(pendingSuggestionsTable).omit({ id: true, createdAt: true });

// Web Push subscriptions — one row per device a broker has enabled
// notifications on (a broker can have several: phone + laptop, etc).
export const pushSubscriptionsTable = pgTable("push_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  brokerId: text("broker_id").notNull(),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PushSubscription = typeof pushSubscriptionsTable.$inferSelect;

export const brokerCorrectionsTable = pgTable("broker_corrections", {
  id: uuid("id").primaryKey().defaultRandom(),
  brokerId: text("broker_id").notNull(),
  instruction: text("instruction").notNull(),
  situationContext: text("situation_context"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const stageEventsTable = pgTable("stage_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: text("lead_id").notNull(),
  fromStage: text("from_stage"),
  toStage: text("to_stage").notNull(),
  pipeline: text("pipeline"),
  responsibleUser: text("responsible_user"),
  changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
});

// Tracks every outbound touch a broker makes — via plugin OR directly in amoCRM/WhatsApp
export const contactEventsTable = pgTable("contact_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: text("lead_id").notNull(),
  responsibleUser: text("responsible_user"),
  source: text("source").notNull().default("plugin"), // 'plugin' | 'direct'
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
});

// Daily snapshot of funnel stage distribution for period-over-period comparison
export const funnelSnapshotsTable = pgTable("funnel_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  snapshotDate: text("snapshot_date").notNull(),   // YYYY-MM-DD
  responsibleUser: text("responsible_user").notNull().default(""), // '' = unknown/null
  stage: text("stage").notNull(),
  count: integer("count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("funnel_snapshots_uniq").on(t.snapshotDate, t.responsibleUser, t.stage)]);

export const leadCrmTasksTable = pgTable("lead_crm_tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: text("lead_id").notNull(),
  taskDate: timestamp("task_date", { withTimezone: true }).notNull(),
  taskText: text("task_text").notNull(),
  status: text("status").notNull().default("open"),   // "open" | "closed"
  closedAt: timestamp("closed_at", { withTimezone: true }),
  webhookStatus: integer("webhook_status"),
  webhookResponse: text("webhook_response"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Lead messages (synced from amoCRM chat history) ─────────────────────────
export const leadMessagesTable = pgTable("lead_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: text("lead_id").notNull(),
  amoMessageId: text("amo_message_id").notNull().unique(),
  senderType: text("sender_type").notNull(),    // 'lead' | 'broker' | 'bot' | 'system'
  senderName: text("sender_name"),
  senderId: text("sender_id"),                   // amoCRM user id or null for lead
  text: text("text"),
  channel: text("channel"),                      // 'whatsapp' | 'telegram' | 'amocrm' | 'instagram' etc
  direction: text("direction").notNull(),        // 'inbound' | 'outbound'
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Per-user settings (extension + AI behavior) ─────────────────────────────
export const userSettingsTable = pgTable("user_settings", {
  userId: text("user_id").notNull().primaryKey(),  // broker name or amoCRM user id
  outputLanguage: text("output_language").notNull().default("auto"),
  tone: text("tone").default("friendly"),          // friendly | formal | casual
  style: text("style").default("concise"),         // concise | detailed | adaptive
  autoApprove: boolean("auto_approve").default(false),
  notifyOnLive: boolean("notify_on_live").default(true),
  customInstructions: text("custom_instructions"),  // free-text broker instructions
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Tracks how often each broker's approved messages reference a given
// property listing — used to personalize future property matching per broker.
export const brokerPropertyPicksTable = pgTable("broker_property_picks", {
  id: uuid("id").primaryKey().defaultRandom(),
  brokerId: text("broker_id").notNull(),
  propertyId: text("property_id").notNull(),
  listingType: text("listing_type"), // "sale" | "rent"
  useCount: integer("use_count").notNull().default(1),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("broker_property_picks_uniq").on(t.brokerId, t.propertyId)]);

export type BrokerPropertyPick = typeof brokerPropertyPicksTable.$inferSelect;

export type AiSuggestion = typeof aiSuggestionsTable.$inferSelect;
export type PendingSuggestion = typeof pendingSuggestionsTable.$inferSelect;
export type SuggestionFeedback = typeof suggestionFeedbackTable.$inferSelect;
export type BrokerCorrection = typeof brokerCorrectionsTable.$inferSelect;
export type StageEvent = typeof stageEventsTable.$inferSelect;
export type ContactEvent = typeof contactEventsTable.$inferSelect;
export type LeadCrmTask = typeof leadCrmTasksTable.$inferSelect;
export type LeadMessage = typeof leadMessagesTable.$inferSelect;
export type UserSetting = typeof userSettingsTable.$inferSelect;
