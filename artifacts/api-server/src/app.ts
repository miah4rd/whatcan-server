import express, { type Express } from "express";
import cors from "cors";
import path from "path";
import pinoHttp from "pino-http";
import router from "./routes";
import mobileRouter from "./routes/mobile";
import swRouter from "./routes/public-sw";
import propertyShareRouter from "./routes/property-share";
import { logger } from "./lib/logger";
import { startFollowupScheduler } from "./lib/followup-scheduler";
import { startAmoSyncScheduler } from "./lib/amo-sync";
import { startFunnelSnapshotScheduler } from "./lib/funnel-snapshot";
import { startTimelineSyncScheduler } from "./lib/amo-timeline-sync";
import { startCommitmentScheduler } from "./lib/commitment-scheduler";
import { startReportScheduler } from "./lib/report-scheduler";
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
app.use(express.json({ limit: "12mb" })); // large enough for a pasted screenshot (base64) as ground-truth context
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);
app.use(mobileRouter);
app.use(swRouter);
// Before the static/SPA fallback: /property/<ID> is the link clients receive,
// and the SPA shell would otherwise swallow it and serve generic OG tags —
// the exact bug this route fixes.
app.use(propertyShareRouter);

// ── Copilot Dashboard (landing app: login/dashboard/tasks/settings) ─────────
// Built React SPA served statically; relative /api/* fetches inside it hit
// this same server. Fallback below excludes /api and /m so those keep
// their own handlers/404s instead of being swallowed by the SPA shell.
const landingDist = path.resolve(__dirname, "../../landing/dist/public");
app.use(express.static(landingDist));
app.use((req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api") || req.path === "/m") {
    next();
    return;
  }
  res.sendFile(path.join(landingDist, "index.html"));
});

startFollowupScheduler();
startAmoSyncScheduler();
startFunnelSnapshotScheduler();
startTimelineSyncScheduler();
startCommitmentScheduler();
startReportScheduler();
ensureKnowledgeBaseVersion().catch((err) => logger.error({ err }, "kb version check failed"));

// When a rental is free from — asked in the intake chat, written to Supabase's
// property_availability on publish. Without it every listing added through the
// assistant showed "Available now" on the site forever.
pool.query(`ALTER TABLE listing_submissions ADD COLUMN IF NOT EXISTS available_from TEXT`)
  .then(() => logger.info("startup migration: listing_submissions.available_from ensured"))
  .catch((err) => logger.error({ err }, "startup migration: available_from failed"));

pool.query(`ALTER TABLE leads_sync ADD COLUMN IF NOT EXISTS pipeline text`)
  .then(() => logger.info("startup migration: pipeline column ensured"))
  .catch((err) => logger.error({ err }, "startup migration failed"));

// A lesson the broker has since reversed stops being injected into prompts.
pool.query(`ALTER TABLE broker_corrections ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ`)
  .then(() => logger.info("startup migration: broker_corrections.superseded_at ensured"))
  .catch((err) => logger.error({ err }, "startup migration: superseded_at failed"));

// Which conversation moment a lesson belongs to — situational injection.
pool.query(`ALTER TABLE broker_corrections ADD COLUMN IF NOT EXISTS situation TEXT`)
  .then(() => logger.info("startup migration: broker_corrections.situation ensured"))
  .catch((err) => logger.error({ err }, "startup migration: situation failed"));

// stage_events.pipeline was never populated — the caller does not always send
// one — and daily-report's stageIndex() needs it to know a funnel's order. So
// "advanced" and "listingsTaken" read 0 for every broker in every period while
// the table held 54 New LEAD -> Options sent moves. Backfill from the lead the
// event belongs to; the write path now falls back to the same source.
pool.query(`UPDATE stage_events e
               SET pipeline = l.pipeline
              FROM leads_sync l
             WHERE l.lead_id = e.lead_id
               AND e.pipeline IS NULL
               AND l.pipeline IS NOT NULL`)
  .then((r) => logger.info({ rows: r.rowCount }, "startup migration: stage_events.pipeline backfilled"))
  .catch((err) => logger.error({ err }, "startup migration: stage_events backfill failed"));

pool.query(`CREATE TABLE IF NOT EXISTS autopilot_settings (
  pipeline TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'off',
  up_to_stage_name TEXT,
  daily_cap INTEGER NOT NULL DEFAULT 30,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`)
  .catch((err) => logger.error({ err }, "startup migration: autopilot_settings failed"));

pool.query(`CREATE TABLE IF NOT EXISTS budget_filter_settings (
  pipeline TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  min_monthly_idr BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`)
  .catch((err) => logger.error({ err }, "startup migration: budget_filter_settings failed"));

// Every AI call, with what it cost. Nothing recorded this before, so the only
// answer to "how much are we spending a day" was arithmetic on estimates.
pool.query(`CREATE TABLE IF NOT EXISTS ai_usage (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  model TEXT NOT NULL,
  label TEXT,
  in_tokens INTEGER NOT NULL DEFAULT 0,
  out_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0
)`)
  // The index has to wait for the table: fired side by side, it lost the race
  // and logged "relation ai_usage does not exist" on every boot.
  .then(() => pool.query(`CREATE INDEX IF NOT EXISTS ai_usage_created_at_idx ON ai_usage (created_at)`))
  .catch((err) => logger.error({ err }, "startup migration: ai_usage failed"));

pool.query(`ALTER TABLE pending_suggestions ADD COLUMN IF NOT EXISTS auto_sent BOOLEAN DEFAULT FALSE`)
  .catch((err) => logger.error({ err }, "startup migration: auto_sent failed"));

pool.query(`ALTER TABLE pending_suggestions ADD COLUMN IF NOT EXISTS requested_at TIMESTAMPTZ`)
  .catch((err) => logger.error({ err }, "startup migration: pending_suggestions.requested_at failed"));

pool.query(`ALTER TABLE leads_sync ADD COLUMN IF NOT EXISTS bot_excluded BOOLEAN DEFAULT FALSE`)
  .then(() => logger.info("startup migration: bot_excluded column ensured"))
  .catch((err) => logger.error({ err }, "startup migration: bot_excluded failed"));

pool.query(`ALTER TABLE leads_sync ADD COLUMN IF NOT EXISTS lead_stage_id TEXT`)
  .then(() => logger.info("startup migration: lead_stage_id column ensured"))
  .catch((err) => logger.error({ err }, "startup migration: lead_stage_id failed"));

pool.query(`ALTER TABLE leads_sync ADD COLUMN IF NOT EXISTS amo_created_at TIMESTAMPTZ`)
  .then(() => logger.info("startup migration: amo_created_at column ensured"))
  .catch((err) => logger.error({ err }, "startup migration: amo_created_at failed"));

// ── Lead profile + discard-flag columns (adaptive follow-up system) ─────────
pool.query(`
  ALTER TABLE leads_sync
    ADD COLUMN IF NOT EXISTS profile_temperature TEXT,
    ADD COLUMN IF NOT EXISTS profile_temperature_source TEXT,
    ADD COLUMN IF NOT EXISTS profile_temperature_ai TEXT,
    ADD COLUMN IF NOT EXISTS profile_temperature_override_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS profile_potential INTEGER,
    ADD COLUMN IF NOT EXISTS profile_intent TEXT,
    ADD COLUMN IF NOT EXISTS profile_timeframe TEXT,
    ADD COLUMN IF NOT EXISTS profile_open_question BOOLEAN,
    ADD COLUMN IF NOT EXISTS profile_alive TEXT,
    ADD COLUMN IF NOT EXISTS profile_summary TEXT,
    ADD COLUMN IF NOT EXISTS profile_updated_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS profile_source_msg_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS discard_flagged_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS discard_reason TEXT,
    ADD COLUMN IF NOT EXISTS live_dismissed_at TIMESTAMPTZ
`)
  .then(() => logger.info("startup migration: lead profile + discard columns ensured"))
  .catch((err) => logger.error({ err }, "startup migration: lead profile columns failed"));

pool.query(`
  ALTER TABLE pending_suggestions
    ADD COLUMN IF NOT EXISTS suggested_stage TEXT,
    ADD COLUMN IF NOT EXISTS suggested_stage_id TEXT,
    ADD COLUMN IF NOT EXISTS suggested_stage_reason TEXT,
    ADD COLUMN IF NOT EXISTS suggested_stage_terminal BOOLEAN
`)
  .then(() => logger.info("startup migration: pending_suggestions stage columns ensured"))
  .catch((err) => logger.error({ err }, "startup migration: pending_suggestions stage columns failed"));

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

// ── broker_property_picks table ─────────────────────────────────────────────
pool.query(`
  CREATE TABLE IF NOT EXISTS broker_property_picks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    broker_id TEXT NOT NULL,
    property_id TEXT NOT NULL,
    listing_type TEXT,
    use_count INTEGER NOT NULL DEFAULT 1,
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT broker_property_picks_uniq UNIQUE(broker_id, property_id)
  )
`).then(() => logger.info("startup migration: broker_property_picks table ensured"))
  .catch((err) => logger.error({ err }, "broker_property_picks migration failed"));

// ── push_subscriptions table ─────────────────────────────────────────────────
pool.query(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    broker_id TEXT NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`).then(() => logger.info("startup migration: push_subscriptions table ensured"))
  .catch((err) => logger.error({ err }, "push_subscriptions migration failed"));

// ── broker_agent_sessions (see lib/broker-agent.ts) ─────────────────────────
// One row per open "Add a listing" chat on the website. The browser re-sends
// the transcript but not the draft, and never re-sends a photo it has already
// uploaded, so keeping this in memory would lose a broker's pictures on every
// deploy.
pool.query(`
  CREATE TABLE IF NOT EXISTS broker_agent_sessions (
    session_id TEXT PRIMARY KEY,
    broker TEXT,
    draft JSONB NOT NULL DEFAULT '{}'::jsonb,
    images JSONB NOT NULL DEFAULT '[]'::jsonb,
    pending_code TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`).then(() => logger.info("startup migration: broker_agent_sessions table ensured"))
  .catch((err) => logger.error({ err }, "broker_agent_sessions migration failed"));

// ── lead_commitments table (see lib/commitment-scheduler.ts) ────────────────
pool.query(`
  CREATE TABLE IF NOT EXISTS lead_commitments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id TEXT NOT NULL,
    responsible_user TEXT,
    promise_text TEXT NOT NULL,
    source_excerpt TEXT,
    due_at TIMESTAMPTZ NOT NULL,
    notified_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'open',
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`).then(() => pool.query(`
  CREATE INDEX IF NOT EXISTS lead_commitments_due_idx ON lead_commitments (status, notified_at, due_at)
`)).then(() => logger.info("startup migration: lead_commitments table ensured"))
  .catch((err) => logger.error({ err }, "lead_commitments migration failed"));

export default app;
