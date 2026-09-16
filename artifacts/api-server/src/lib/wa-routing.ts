/**
 * Which funnel a WhatsApp number's new chats land in.
 *
 * amoCRM puts every new chat of our channel into the account's default
 * "Неразобранное" (UNICORN). The Sources API that would route it natively needs
 * a widget registered on the channel, so instead each number carries its own
 * route (wa_sessions.pipeline / stage / responsible) and the bridge ACCEPTS the
 * new unsorted chat straight into that stage — verified 16.09.2026: accepting
 * with a Rental status moves it out of UNICORN's unsorted into Rental.
 *
 * Pipelines, stages and users are read live from amoCRM by name or id, so a
 * funnel created tomorrow is selectable without a code change. A number with no
 * pipeline set is left exactly where amoCRM put it.
 */
import { pool } from "@workspace/db";
import { amoFetch, amoPatch, amoPost } from "./amo-client";
import { logger } from "./logger";

export interface AmoStage { id: number; name: string; sort: number; type: number }
export interface AmoPipelineInfo { id: number; name: string; is_archive: boolean; stages: AmoStage[] }
export interface AmoUserInfo { id: number; name: string }

let pipelinesCache: { at: number; data: AmoPipelineInfo[] } | null = null;
let usersCache: { at: number; data: AmoUserInfo[] } | null = null;
const TTL = 5 * 60 * 1000;

// amoCRM's "Неразобранное" is status type 1; won/lost are 142/143. A chat is
// accepted into a working stage, never into those.
const NOT_WORKING = (s: AmoStage) => s.type === 1 || s.id === 142 || s.id === 143;

export async function listPipelines(fresh = false): Promise<AmoPipelineInfo[]> {
  if (!fresh && pipelinesCache && Date.now() - pipelinesCache.at < TTL) return pipelinesCache.data;
  const r = await amoFetch<{ _embedded: { pipelines: Array<{ id: number; name: string; is_archive: boolean; _embedded: { statuses: Array<{ id: number; name: string; sort: number; type: number }> } }> } }>(
    "/api/v4/leads/pipelines?limit=250",
  );
  if (!r) return pipelinesCache?.data ?? [];
  const data = r._embedded.pipelines.map((p) => ({
    id: p.id,
    name: p.name,
    is_archive: p.is_archive,
    stages: p._embedded.statuses.map((s) => ({ id: s.id, name: s.name, sort: s.sort, type: s.type })).sort((a, b) => a.sort - b.sort),
  }));
  pipelinesCache = { at: Date.now(), data };
  return data;
}

export async function listUsers(): Promise<AmoUserInfo[]> {
  if (usersCache && Date.now() - usersCache.at < TTL) return usersCache.data;
  const r = await amoFetch<{ _embedded: { users: Array<{ id: number; name: string }> } }>("/api/v4/users?limit=250");
  if (!r) return usersCache?.data ?? [];
  const data = r._embedded.users.map((u) => ({ id: u.id, name: u.name }));
  usersCache = { at: Date.now(), data };
  return data;
}

const norm = (s: string) => s.trim().toLowerCase();
const byIdOrName = <T extends { id: number; name: string }>(list: T[], key: string | null | undefined): T | undefined => {
  if (!key) return undefined;
  const k = norm(String(key));
  return list.find((x) => String(x.id) === k) ?? list.find((x) => norm(x.name) === k);
};

export interface ResolvedRoute { pipeline: AmoPipelineInfo; stage: AmoStage; userId: number | null }

/** The stage a new chat of this number goes to, or null when the number has no route. */
export async function resolveRoute(session: string): Promise<ResolvedRoute | null> {
  const row = (await pool.query(`SELECT pipeline, stage, responsible FROM wa_sessions WHERE name = $1`, [session])).rows[0];
  if (!row?.pipeline) return null;
  const pipelines = await listPipelines();
  const pipeline = byIdOrName(pipelines, row.pipeline);
  if (!pipeline) {
    logger.error({ session, pipeline: row.pipeline }, "wa-routing: pipeline not found in amoCRM (renamed or deleted?)");
    return null;
  }
  const working = pipeline.stages.filter((s) => !NOT_WORKING(s));
  const stage = byIdOrName(working, row.stage) ?? working[0];
  if (!stage) return null;
  const user = row.responsible ? byIdOrName(await listUsers(), row.responsible) : undefined;
  return { pipeline, stage, userId: user?.id ?? null };
}

/**
 * Moves the unsorted chat amoCRM just created for `conversationId` into the
 * number's funnel. amoCRM creates the unsorted entry a moment after the message
 * is accepted, so it is looked for a few times. An existing client (chat
 * attached to an open lead) creates no unsorted entry — nothing to do.
 */
export async function routeNewChat(session: string, conversationId: string): Promise<void> {
  const route = await resolveRoute(session);
  if (!route) return;
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise((r) => setTimeout(r, attempt === 0 ? 2000 : 4000));
    const list = await amoFetch<{ _embedded: { unsorted: Array<{ uid: string; pipeline_id: number; metadata?: { to?: string } }> } }>(
      "/api/v4/leads/unsorted?filter[category][]=chats&order[created_at]=desc&limit=50",
    );
    const item = list?._embedded?.unsorted?.find((u) => u.metadata?.to === conversationId);
    if (!item) continue;
    const res = await amoPost<{ _embedded?: { leads?: Array<{ id: number }> } }>(
      `/api/v4/leads/unsorted/${encodeURIComponent(item.uid)}/accept`,
      { status_id: route.stage.id, ...(route.userId ? { user_id: route.userId } : {}) },
    );
    const leadId = res?._embedded?.leads?.[0]?.id ?? null;
    logger.info(
      { session, conversationId, leadId, pipeline: route.pipeline.name, stage: route.stage.name, ok: Boolean(res) },
      "wa-routing: new chat placed in its funnel",
    );
    // amoCRM ignores user_id for a chat lead on accept; set it explicitly.
    if (leadId && route.userId) {
      await amoPatch(`/api/v4/leads/${leadId}`, { responsible_user_id: route.userId });
    }
    return;
  }
  logger.info({ session, conversationId }, "wa-routing: no unsorted entry — chat joined an existing lead");
}
