import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { startFollowupScheduler } from "./lib/followup-scheduler";
import { startAmoSyncScheduler } from "./lib/amo-sync";
import { startFunnelSnapshotScheduler } from "./lib/funnel-snapshot";
import { startMessageSyncScheduler } from "./lib/amo-message-sync";
import { ensureKnowledgeBaseVersion } from "./lib/knowledge-base";
import { pool } from "@workspace/db";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

startFollowupScheduler(1 * 60 * 1000); // TEMP for testing — revert to default (5 min) by calling with no args
startAmoSyncScheduler();
startFunnelSnapshotScheduler();
startMessageSyncScheduler();
ensureKnowledgeBaseVersion().catch((err) => logger.error({ err }, "kb version check failed"));

pool.query(`ALTER TABLE leads_sync ADD COLUMN IF NOT EXISTS pipeline text`)
  .then(() => logger.info("startup migration: pipeline column ensured"))
  .catch((err) => logger.error({ err }, "startup migration failed"));

pool.query(`ALTER TABLE leads_sync ADD COLUMN IF NOT EXISTS bot_excluded BOOLEAN DEFAULT FALSE`)
  .then(() => logger.info("startup migration: bot_excluded column ensured"))
  .catch((err) => logger.error({ err }, "startup migration: bot_excluded failed"));

pool.query(`ALTER TABLE leads_sync ADD COLUMN IF NOT EXISTS lead_stage_id TEXT`)
  .then(() => logger.info("startup migration: lead_stage_id column ensured"))
  .catch((err) => logger.error({ err }, "startup migration: lead_stage_id failed"));

pool.query(`ALTER TABLE leads_sync ADD COLUMN IF NOT EXISTS amo_created_at TIMESTAMPTZ`)
  .then(() => logger.info("startup migration: amo_created_at column ensured"))
  .catch((err) => logger.error({ err }, "startup migration: amo_created_at failed"));

pool.query(`ALTER TABLE lead_crm_tasks ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open'`)
  .then(() => pool.query(`ALTER TABLE lead_crm_tasks ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ`))
  .then(() => logger.info("startup migration: lead_crm_tasks status/closed_at ensured"))
  .catch((err) => logger.error({ err }, "startup migration: lead_crm_tasks failed"));


pool.query(`
  CREATE TABLE IF NOT EXISTS stage_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id TEXT NOT NULL,
    from_stage TEXT,
    to_stage TEXT NOT NULL,
    pipeline TEXT,
    responsible_user TEXT,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`).then(() => pool.query(`
  CREATE INDEX IF NOT EXISTS stage_events_changed_at_idx ON stage_events(changed_at DESC)
`)).then(() => logger.info("startup migration: stage_events table ensured"))
  .catch((err) => logger.error({ err }, "stage_events migration failed"));

pool.query(`
  CREATE TABLE IF NOT EXISTS funnel_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    snapshot_date TEXT NOT NULL,
    responsible_user TEXT NOT NULL DEFAULT '',
    stage TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT funnel_snapshots_uniq UNIQUE(snapshot_date, responsible_user, stage)
  )
`).then(() => logger.info("startup migration: funnel_snapshots table ensured"))
  .catch((err) => logger.error({ err }, "funnel_snapshots migration failed"));

pool.query(`
  CREATE TABLE IF NOT EXISTS contact_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id TEXT NOT NULL,
    responsible_user TEXT,
    source TEXT NOT NULL DEFAULT 'plugin',
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`).then(() => pool.query(`
  CREATE INDEX IF NOT EXISTS contact_events_sent_at_idx ON contact_events(sent_at DESC)
`)).then(() => logger.info("startup migration: contact_events table ensured"))
  .catch((err) => logger.error({ err }, "contact_events migration failed"));

// ── lead_messages table ─────────────────────────────────────────────────────
pool.query(`
  CREATE TABLE IF NOT EXISTS lead_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id TEXT NOT NULL,
    amo_message_id TEXT NOT NULL UNIQUE,
    sender_type TEXT NOT NULL,
    sender_name TEXT,
    sender_id TEXT,
    text TEXT,
    channel TEXT,
    direction TEXT NOT NULL,
    sent_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`).then(() => pool.query(`
  CREATE INDEX IF NOT EXISTS lead_messages_lead_id_idx ON lead_messages(lead_id)
`)).then(() => pool.query(`
  CREATE INDEX IF NOT EXISTS lead_messages_sent_at_idx ON lead_messages(sent_at DESC)
`)).then(() => logger.info("startup migration: lead_messages table ensured"))
  .catch((err) => logger.error({ err }, "lead_messages migration failed"));

// ── user_settings table ─────────────────────────────────────────────────────
pool.query(`
  CREATE TABLE IF NOT EXISTS user_settings (
    user_id TEXT PRIMARY KEY,
    output_language TEXT NOT NULL DEFAULT 'auto',
    tone TEXT DEFAULT 'friendly',
    style TEXT DEFAULT 'concise',
    auto_approve BOOLEAN DEFAULT FALSE,
    notify_on_live BOOLEAN DEFAULT TRUE,
    custom_instructions TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`).then(() => logger.info("startup migration: user_settings table ensured"))
  .catch((err) => logger.error({ err }, "user_settings migration failed"));

export default app;
