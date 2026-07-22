/**
 * External AmoCRM integration endpoints.
 *
 * Redirect URI  →  POST /api/amo/oauth/install
 *   AmoCRM calls this after user authorizes via the external button.
 *   Receives client_id, client_secret, authorization_code, account_id.
 *   Exchanges code → tokens, saves to DB, kicks off full pipeline sync.
 *
 * Disconnect    →  POST /api/amo/webhook/disconnect
 *   AmoCRM calls this when the user removes the integration.
 *   Clears stored tokens.
 *
 * Deal updates  →  POST /api/amo/webhook/update
 *   Set this URL in amoCRM → Settings → Webhooks (events: leads add/update/delete).
 *   Keeps analytics tables in sync in real time.
 */
import { Router } from "express";
import { db, brokerSettingsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { saveTokens } from "../lib/amo-client";
import { syncAnalyticsPipeline, syncSingleDeal, deleteDealFromAnalytics } from "../lib/amo-analytics-sync";
import { logger } from "../lib/logger";

const router = Router();

const AMO_SUBDOMAIN = process.env.AMO_SUBDOMAIN ?? "unicornproperty";
const AMO_BASE = `https://${AMO_SUBDOMAIN}.amocrm.ru`;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function setSetting(key: string, value: string): Promise<void> {
  await db.insert(brokerSettingsTable).values({ key, value })
    .onConflictDoUpdate({
      target: brokerSettingsTable.key,
      set: { value, updatedAt: new Date() },
    });
}

async function clearSetting(key: string): Promise<void> {
  await db.delete(brokerSettingsTable).where(eq(brokerSettingsTable.key, key));
}

// ── External integration install webhook ──────────────────────────────────────
// This is the redirect_uri you register in the external integration button.
// AmoCRM POSTs here with auth data after user authorizes.

router.post("/amo/oauth/install", async (req, res) => {
  const body = req.body as {
    client_id?: string;
    client_secret?: string;
    authorization_code?: string;
    redirect_uri?: string;
    account_id?: string;
    referer?: string;
  };

  logger.info({ account_id: body.account_id, referer: body.referer }, "amo external install webhook received");

  const { client_id, client_secret, authorization_code, redirect_uri, account_id } = body;

  if (!client_id || !client_secret || !authorization_code) {
    logger.error({ body }, "amo install: missing required fields");
    res.status(400).json({ error: "client_id, client_secret, authorization_code required" });
    return;
  }

  // Store the credentials received from amoCRM
  await Promise.all([
    setSetting("ext_amo_client_id", client_id),
    setSetting("ext_amo_client_secret", client_secret),
    setSetting("ext_amo_account_id", account_id ?? ""),
    setSetting("ext_amo_referer", body.referer ?? AMO_SUBDOMAIN),
  ]);

  // Exchange authorization_code for access + refresh tokens
  const amoBase = body.referer
    ? `https://${body.referer}.amocrm.ru`
    : AMO_BASE;

  try {
    const tokenRes = await fetch(`${amoBase}/oauth2/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id,
        client_secret,
        grant_type: "authorization_code",
        code: authorization_code,
        redirect_uri: redirect_uri ?? `https://${process.env.REPLIT_DOMAINS?.split(",")[0]}/api/amo/oauth/install`,
      }),
    });

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      logger.error({ status: tokenRes.status, errBody }, "amo install: token exchange failed");
      res.status(502).json({ error: "token exchange failed", detail: errBody });
      return;
    }

    const tokens = await tokenRes.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    await saveTokens(tokens.access_token, tokens.refresh_token, tokens.expires_in);
    await setSetting("ext_amo_installed_at", new Date().toISOString());

    logger.info({ account_id }, "amo install: tokens saved, starting full sync");

    // Full pipeline sync in background — don't block the response
    syncAnalyticsPipeline().then(result => {
      logger.info(result, "amo install: full sync completed");
    }).catch(err => {
      logger.error({ err }, "amo install: full sync error");
    });

    res.status(200).json({ ok: true, message: "Integration installed, sync started" });
  } catch (err) {
    logger.error({ err }, "amo install: unexpected error");
    res.status(500).json({ error: String(err) });
  }
});

// ── Disconnect webhook ────────────────────────────────────────────────────────
// AmoCRM calls this when user removes the integration.

router.post("/amo/webhook/disconnect", async (req, res) => {
  const body = req.body as { account_id?: string };
  logger.info({ account_id: body.account_id }, "amo disconnect webhook received");

  try {
    // Clear all auth tokens
    await Promise.all([
      clearSetting("amo_access_token"),
      clearSetting("amo_refresh_token"),
      clearSetting("amo_token_expires_at"),
      clearSetting("ext_amo_installed_at"),
    ]);

    logger.info("amo disconnect: tokens cleared");
    res.status(200).json({ ok: true });
  } catch (err) {
    logger.error({ err }, "amo disconnect: error");
    res.status(500).json({ error: String(err) });
  }
});

// ── Deal update webhook ───────────────────────────────────────────────────────
// Register this in amoCRM → Settings → Webhooks for: leads add, leads update, leads delete.
// amoCRM sends application/x-www-form-urlencoded data.

router.post("/amo/webhook/update", async (req, res) => {
  // amoCRM sends form-encoded body like: leads[add][0][id]=123&leads[add][0][status_id]=456
  // Express urlencoded middleware parses this into nested objects
  const body = req.body as Record<string, unknown>;

  logger.info({ keys: Object.keys(body) }, "amo deal webhook received");

  // Respond immediately — amoCRM expects 200 within a few seconds
  res.status(200).json({ ok: true });

  try {
    const addedLeads = extractLeadIds(body, "leads", "add");
    const updatedLeads = extractLeadIds(body, "leads", "update");
    const deletedLeads = extractLeadIds(body, "leads", "delete");

    logger.info({ added: addedLeads, updated: updatedLeads, deleted: deletedLeads }, "amo deal webhook: processing");

    // Sync added + updated deals
    for (const id of [...new Set([...addedLeads, ...updatedLeads])]) {
      await syncSingleDeal(id).catch(err => logger.error({ err, leadId: id }, "analytics sync single deal error"));
    }

    // Remove deleted deals
    for (const id of deletedLeads) {
      await deleteDealFromAnalytics(id).catch(err => logger.error({ err, leadId: id }, "analytics delete deal error"));
    }
  } catch (err) {
    logger.error({ err }, "amo deal webhook: processing error");
  }
});

// ── Admin: manual full sync trigger ──────────────────────────────────────────

router.post("/amo/sync/full", async (req, res) => {
  const auth = (req.headers["x-dash-password"] as string | undefined);
  const DASH_PASSWORD = process.env.DASHBOARD_PASSWORD ?? "unicorn";
  if (auth !== DASH_PASSWORD) {
    res.status(403).json({ error: "forbidden" });
    return;
  }

  try {
    const result = await syncAnalyticsPipeline();
    res.json({ ok: true, ...result });
  } catch (err) {
    logger.error({ err }, "manual full sync error");
    res.status(500).json({ error: String(err) });
  }
});

// ── Helper: extract lead IDs from amoCRM webhook body ────────────────────────

function extractLeadIds(
  body: Record<string, unknown>,
  entity: string,
  event: string
): number[] {
  const entityData = body[entity] as Record<string, unknown> | undefined;
  if (!entityData) return [];
  const eventData = entityData[event] as Record<string, unknown> | undefined;
  if (!eventData || typeof eventData !== "object") return [];

  const ids: number[] = [];
  for (const item of Object.values(eventData)) {
    const id = (item as Record<string, unknown>)?.["id"];
    if (id !== undefined && id !== null) {
      const n = Number(id);
      if (!isNaN(n)) ids.push(n);
    }
  }
  return ids;
}

export default router;
