/**
 * amoCRM API client with auto token refresh.
 * Tokens stored in broker_settings table (keys: amo_access_token, amo_refresh_token, amo_token_expires_at).
 */
import { db, brokerSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

const AMO_SUBDOMAIN = process.env.AMO_SUBDOMAIN ?? "unicornproperty";
const AMO_BASE = `https://${AMO_SUBDOMAIN}.amocrm.ru`;
const CLIENT_ID = process.env.AMOCRM_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.AMOCRM_CLIENT_SECRET ?? "";
// Long-lived token — simpler alternative to full OAuth flow.
// If set, used directly as access token (no refresh needed).
const LONG_LIVED_TOKEN = process.env.AMOCRM_LONG_LIVED_TOKEN ?? "";

// ── Token storage helpers ─────────────────────────────────────────────────────

async function getSetting(key: string): Promise<string | null> {
  const rows = await db.select().from(brokerSettingsTable).where(eq(brokerSettingsTable.key, key));
  return rows[0]?.value ?? null;
}

async function setSetting(key: string, value: string): Promise<void> {
  await db.insert(brokerSettingsTable).values({ key, value }).onConflictDoUpdate({
    target: brokerSettingsTable.key,
    set: { value, updatedAt: new Date() },
  });
}

export async function saveTokens(accessToken: string, refreshToken: string, expiresIn: number): Promise<void> {
  const expiresAt = new Date(Date.now() + expiresIn * 1000 - 60_000).toISOString();
  await Promise.all([
    setSetting("amo_access_token", accessToken),
    setSetting("amo_refresh_token", refreshToken),
    setSetting("amo_token_expires_at", expiresAt),
  ]);
  logger.info("amoCRM tokens saved, expires at %s", expiresAt);
}

export async function getAccessToken(): Promise<string | null> {
  // Long-lived token takes priority — no expiry management needed
  if (LONG_LIVED_TOKEN) return LONG_LIVED_TOKEN;

  const token = await getSetting("amo_access_token");
  const expiresAt = await getSetting("amo_token_expires_at");
  if (!token) return null;

  const expired = expiresAt ? new Date(expiresAt) < new Date() : false;
  if (!expired) return token;

  // Try to refresh
  logger.info("amoCRM access token expired, refreshing...");
  return refreshAccessToken();
}

export async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = await getSetting("amo_refresh_token");
  if (!refreshToken || !CLIENT_ID || !CLIENT_SECRET) return null;

  try {
    const res = await fetch(`${AMO_BASE}/oauth2/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        redirect_uri: buildRedirectUri(),
      }),
    });
    if (!res.ok) {
      logger.error({ status: res.status, body: await res.text() }, "amoCRM token refresh failed");
      return null;
    }
    const data = await res.json() as {
      access_token: string; refresh_token: string; expires_in: number;
    };
    await saveTokens(data.access_token, data.refresh_token, data.expires_in);
    return data.access_token;
  } catch (err) {
    logger.error({ err }, "amoCRM token refresh error");
    return null;
  }
}

export async function exchangeCode(code: string): Promise<boolean> {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    logger.error("AMOCRM_CLIENT_ID / AMOCRM_CLIENT_SECRET not set");
    return false;
  }
  try {
    const res = await fetch(`${AMO_BASE}/oauth2/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: buildRedirectUri(),
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      logger.error({ status: res.status, body }, "amoCRM code exchange failed");
      return false;
    }
    const data = await res.json() as {
      access_token: string; refresh_token: string; expires_in: number;
    };
    await saveTokens(data.access_token, data.refresh_token, data.expires_in);
    return true;
  } catch (err) {
    logger.error({ err }, "amoCRM code exchange error");
    return false;
  }
}

export function buildRedirectUri(): string {
  const domain = (process.env.REPLIT_DOMAINS ?? "").split(",")[0]?.trim();
  if (domain) return `https://${domain}/api/admin/amo-oauth/callback`;
  return "https://copilot.globalapplab.ru/api/admin/amo-oauth/callback";
}

export function buildAuthUrl(): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: buildRedirectUri(),
    response_type: "code",
    state: "dash",
    mode: "post_message",
  });
  return `https://www.amocrm.ru/oauth?${params}`;
}

// ── API fetch wrapper ─────────────────────────────────────────────────────────

// amoCRM returns a 200 with an EMPTY body (not even "{}") for some filtered
// list endpoints when there are zero results (e.g. GET /tasks with no open
// tasks for that lead) — res.json() throws "Unexpected end of JSON input" on
// that. Read as text first and only parse if there's actually a body.
async function parseAmoResponse<T>(res: Response, path: string): Promise<T | null> {
  const raw = await res.text();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    logger.error({ err, path, bodySnippet: raw.slice(0, 200) }, "amoCRM: failed to parse response body");
    return null;
  }
}

export async function amoFetch<T>(path: string): Promise<T | null> {
  const token = await getAccessToken();
  if (!token) { logger.warn("amoCRM: no access token, skipping request"); return null; }

  const res = await fetch(`${AMO_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });

  if (res.status === 401) {
    logger.warn("amoCRM 401 – refreshing token and retrying");
    const newToken = await refreshAccessToken();
    if (!newToken) return null;
    const retry = await fetch(`${AMO_BASE}${path}`, {
      headers: { Authorization: `Bearer ${newToken}`, "Content-Type": "application/json" },
    });
    if (!retry.ok) { logger.error({ status: retry.status, path }, "amoCRM retry failed"); return null; }
    return parseAmoResponse<T>(retry, path);
  }

  if (!res.ok) { logger.error({ status: res.status, path }, "amoCRM request failed"); return null; }
  return parseAmoResponse<T>(res, path);
}

// ── Write helpers ─────────────────────────────────────────────────────────────

async function amoWrite<T>(method: "POST" | "PATCH", path: string, body: unknown): Promise<T | null> {
  const token = await getAccessToken();
  if (!token) { logger.warn("amoCRM: no access token"); return null; }
  const res = await fetch(`${AMO_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.error({ status: res.status, path, body: text.slice(0, 300) }, `amoCRM ${method} failed`);
    return null;
  }
  const text = await res.text().catch(() => "");
  try { return text ? JSON.parse(text) as T : null; } catch { return null; }
}

export async function amoPost<T>(path: string, body: unknown): Promise<T | null> {
  return amoWrite<T>("POST", path, body);
}

export async function amoPatch<T>(path: string, body: unknown): Promise<T | null> {
  return amoWrite<T>("PATCH", path, body);
}

// ── Lead operations ───────────────────────────────────────────────────────────

/** Update lead status (stage) in amoCRM. statusId is the numeric pipeline status_id. */
export async function updateLeadStatus(leadId: string, statusId: number): Promise<boolean> {
  const result = await amoPatch<unknown>(`/api/v4/leads/${leadId}`, { status_id: statusId });
  if (result !== null) {
    logger.info({ leadId, statusId }, "amoCRM: lead status updated");
  }
  return result !== null;
}

/** Fetch lead data from amoCRM (includes responsible_user_id). */
export async function getAmoLead(leadId: string): Promise<{ id: number; responsible_user_id?: number; status_id?: number } | null> {
  return amoFetch<{ id: number; responsible_user_id?: number; status_id?: number }>(`/api/v4/leads/${leadId}`);
}

/**
 * Fetch a lead's tags + utm_campaign custom field — used to tell apart ad
 * campaign types (e.g. Rental's "brochure" vs "specific listing" vs "b2b").
 */
export async function getLeadTagsAndUtm(
  leadId: string,
): Promise<{ tags: string[]; utmCampaign: string | null }> {
  const data = await amoFetch<{
    custom_fields_values?: Array<{ field_code: string | null; values: Array<{ value: string }> }>;
    _embedded?: { tags?: Array<{ name: string }> };
  }>(`/api/v4/leads/${leadId}`);

  const tags = data?._embedded?.tags?.map((t) => t.name) ?? [];
  const utmField = data?.custom_fields_values?.find((f) => f.field_code === "UTM_CAMPAIGN");
  const utmCampaign = utmField?.values?.[0]?.value ?? null;

  return { tags, utmCampaign };
}

/**
 * Close a lead as "Closed Lost" in amoCRM.
 * status_id 143 = system-level Closed Lost (works across all pipelines).
 * lossReasonId = the AmoCRM loss reason to attach.
 */
export async function closeLeadAsLost(leadId: string, lossReasonId: number): Promise<boolean> {
  const result = await amoPatch<unknown>(`/api/v4/leads/${leadId}`, {
    status_id: 143,
    loss_reason_id: lossReasonId,
  });
  if (result !== null) {
    logger.info({ leadId, lossReasonId }, "amoCRM: lead closed as lost");
  }
  return result !== null;
}

// ── Task operations ───────────────────────────────────────────────────────────

/** Shape of a task returned by AmoCRM /api/v4/tasks */
export type AmoTask = {
  id: number;
  entity_id: number;
  entity_type: string;
  complete_till: number; // Unix timestamp (seconds)
  text: string;
};

/** Get all open (incomplete) tasks for a single lead. */
export async function getOpenAmoTasks(leadId: string): Promise<Array<{ id: number; text: string }>> {
  const data = await amoFetch<{
    _embedded?: { tasks?: Array<{ id: number; text: string }> };
  }>(`/api/v4/tasks?filter[entity_id]=${leadId}&filter[entity_type]=leads&filter[is_completed]=0&limit=50`);
  return data?._embedded?.tasks ?? [];
}

/**
 * Fetch ALL open tasks for ALL leads from amoCRM (paginated).
 * Much more efficient than per-lead calls — use this in amo-sync.
 */
export async function getAllOpenLeadTasksPaginated(): Promise<AmoTask[]> {
  const all: AmoTask[] = [];
  let page = 1;
  while (true) {
    const data = await amoFetch<{
      _embedded?: { tasks?: AmoTask[] };
      _links?: { next?: { href: string } };
    }>(`/api/v4/tasks?filter[entity_type][]=leads&filter[is_completed]=0&limit=250&page=${page}`);
    const tasks = data?._embedded?.tasks ?? [];
    all.push(...tasks);
    if (!data?._links?.next || tasks.length < 250) break;
    page++;
    if (page > 20) break; // safety: max 5 000 tasks
  }
  return all;
}

/** Close all open tasks for a lead in amoCRM. Returns count of closed tasks. */
export async function closeAmoTasksForLead(leadId: string): Promise<number> {
  const tasks = await getOpenAmoTasks(leadId);
  if (tasks.length === 0) return 0;
  const payload = tasks.map((t) => ({ id: t.id, is_completed: true, result: { text: "Закрыто автоматически" } }));
  await amoPatch<unknown>(`/api/v4/tasks`, payload);
  logger.info({ leadId, count: tasks.length }, "amoCRM: tasks closed");
  return tasks.length;
}

/** Create a task for a lead in amoCRM. */
export async function createAmoTask(
  leadId: string,
  text: string,
  dueDate: Date,
  responsibleUserId?: number,
): Promise<boolean> {
  const task: Record<string, unknown> = {
    task_type_id: 1,
    text,
    complete_till: Math.floor(dueDate.getTime() / 1000),
    entity_id: Number(leadId),
    entity_type: "leads",
  };
  if (responsibleUserId) task.responsible_user_id = responsibleUserId;
  const result = await amoPost<unknown>(`/api/v4/tasks`, [task]);
  if (result !== null) {
    logger.info({ leadId, dueDate, text: text.slice(0, 60) }, "amoCRM: task created");
  }
  return result !== null;
}

export const AMO_SUBDOMAIN_VAL = AMO_SUBDOMAIN;
export const hasCredentials = () => Boolean(LONG_LIVED_TOKEN || (CLIENT_ID && CLIENT_SECRET));
