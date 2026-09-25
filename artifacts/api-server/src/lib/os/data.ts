/**
 * Unicorn OS — the read side over the Copilot's own tables and amoCRM.
 *
 * Nothing here decides anything the Copilot decides. Boards read leads_sync
 * (kept within five minutes of amoCRM by amo-sync), threads read lead_messages,
 * drafts read pending_suggestions, tasks are amoCRM's own tasks (they are the
 * follow-up scheduler's source of truth, so the OS shows and edits THEM, never
 * a copy). A person moving a card here is the same act as dragging it in
 * amoCRM: the stage is written to amoCRM first and our copy only after amoCRM
 * accepted it.
 */
import { pool } from "@workspace/db";
import {
  amoFetch,
  amoPatch,
  updateLeadStatus,
  closeLeadAsLost,
  getAmoLead,
  createAmoTask,
  completeAmoTasks,
  isProtectedTask,
} from "../amo-client";
import { safeStageIdForLead, getPipelineStages } from "../stage-classifier";
import { shouldSuppressPush } from "../stage-routing";
import { parseDialogContent } from "../dialog-parser";
import { cleanLeadName } from "../lead-display-name";
import { getMergedConversation } from "../merged-conversation";
import { PIPELINES } from "../pipelines";
import { aiHealth } from "../ai-health";
import { logger } from "../logger";
import { audit, brokerScope, isStaff, type OsUser } from "./auth";
import { recordCloseReason } from "./analytics";

const lc = (s: unknown) => String(s ?? "").trim().toLowerCase();
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

// ── Pipelines ────────────────────────────────────────────────────────────────

export type OsPipeline = { key: string; name: string; kind: string; stages: Array<{ id: number; name: string }> };

export async function pipelines(): Promise<OsPipeline[]> {
  const out: OsPipeline[] = [];
  for (const p of PIPELINES) {
    const st = await getPipelineStages(p.name).catch(() => null);
    out.push({
      key: lc(p.name).replace(/\s+/g, "-"),
      name: p.name,
      kind: p.kind,
      stages: (st?.all ?? []).map((s) => ({ id: s.id, name: s.name })),
    });
  }
  return out;
}

function pipelineNameFromKey(key: string): string | null {
  const hit = PIPELINES.find((p) => lc(p.name).replace(/\s+/g, "-") === lc(key) || lc(p.name) === lc(key));
  return hit ? hit.name : null;
}

// ── amoCRM names, users, tasks (cached; amoCRM answers 429 under load) ──────

const nameCache = new Map<string, { name: string; at: number }>();
export async function amoLeadNames(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const now = Date.now();
  const missing: string[] = [];
  for (const id of ids) {
    const c = nameCache.get(id);
    if (c && now - c.at < 30 * 60_000) out.set(id, c.name);
    else missing.push(id);
  }
  for (let i = 0; i < missing.length; i += 200) {
    const chunk = missing.slice(i, i + 200);
    const qs = chunk.map((id) => `filter[id][]=${encodeURIComponent(id)}`).join("&");
    const data = await amoFetch<{ _embedded?: { leads?: Array<{ id: number; name: string }> } }>(`/api/v4/leads?${qs}&limit=250`).catch(() => null);
    for (const l of data?._embedded?.leads ?? []) {
      nameCache.set(String(l.id), { name: l.name, at: now });
      out.set(String(l.id), l.name);
    }
  }
  return out;
}

let usersCache: { at: number; byId: Map<number, string> } | null = null;
export async function amoUsers(): Promise<Map<number, string>> {
  if (usersCache && Date.now() - usersCache.at < 60 * 60_000) return usersCache.byId;
  const data = await amoFetch<{ _embedded?: { users?: Array<{ id: number; name: string }> } }>(`/api/v4/users?limit=250`).catch(() => null);
  const byId = new Map<number, string>();
  for (const u of data?._embedded?.users ?? []) byId.set(u.id, (u.name || "").trim().split(/\s+/)[0] || String(u.id));
  if (byId.size) usersCache = { at: Date.now(), byId };
  return byId;
}

export type OsTask = {
  id: number;
  text: string;
  due: string;
  leadId: string;
  responsibleUserId: number | null;
  responsible: string | null;
  createdAt: string | null;
  protected: boolean;
  typeId: number | null;
};

let tasksCache: { at: number; list: OsTask[] } | null = null;
export async function openTasks(force = false): Promise<OsTask[]> {
  if (!force && tasksCache && Date.now() - tasksCache.at < 60_000) return tasksCache.list;
  const users = await amoUsers();
  const list: OsTask[] = [];
  for (let page = 1; page <= 20; page++) {
    const data = await amoFetch<{
      _embedded?: { tasks?: Array<{ id: number; text: string; complete_till: number; entity_id: number; entity_type: string; responsible_user_id?: number; created_at?: number; task_type_id?: number }> };
      _links?: { next?: unknown };
    }>(`/api/v4/tasks?filter[is_completed]=0&filter[entity_type]=leads&limit=250&page=${page}`).catch(() => null);
    const tasks = data?._embedded?.tasks ?? [];
    for (const t of tasks) {
      list.push({
        id: t.id,
        text: t.text,
        due: new Date(t.complete_till * 1000).toISOString(),
        leadId: String(t.entity_id),
        responsibleUserId: t.responsible_user_id ?? null,
        responsible: t.responsible_user_id ? users.get(t.responsible_user_id) ?? null : null,
        createdAt: t.created_at ? new Date(t.created_at * 1000).toISOString() : null,
        protected: isProtectedTask(t.text),
        typeId: t.task_type_id ?? null,
      });
    }
    if (tasks.length < 250 || !data?._links?.next) break;
  }
  tasksCache = { at: Date.now(), list };
  return list;
}

// ── Board / table ────────────────────────────────────────────────────────────

export type OsCard = {
  leadId: string;
  name: string;
  pipeline: string | null;
  stage: string | null;
  stageId: string | null;
  responsible: string | null;
  lastMessageAt: string | null;
  lastMessageFrom: string | null;
  lastOurMessageAt: string | null;
  nextFollowupAt: string | null;
  stageSince: string | null;
  temperature: string | null;
  potential: number | null;
  intent: string | null;
  summary: string | null;
  viewingAt: string | null;
  freeFrom: string | null;
  botExcluded: boolean;
  createdAt: string | null;
  request: { pax: number | null; bedrooms: number | null; areas: string | null; moveIn: string | null; stay: string | null; budget: number | null };
  facts: Record<string, unknown> | null;
  draft: { id: string; kind: string; at: string; verdict: string | null } | null;
  openTasks: number;
  nextTaskDue: string | null;
};

export async function boardCards(user: OsUser, opts: { pipeline: string; broker?: string | null; closed?: boolean }): Promise<OsCard[]> {
  const pipelineName = pipelineNameFromKey(opts.pipeline) ?? opts.pipeline;
  const scope = brokerScope(user) ?? (opts.broker ? opts.broker : null);
  const { rows } = await pool.query(
    `SELECT lead_id, left(content, 6000) AS head, responsible_user, lead_stage, lead_stage_id, pipeline,
            last_message_at, last_message_from, last_our_message_at, next_followup_at, bot_excluded, amo_created_at,
            profile_temperature, profile_potential, profile_intent, profile_summary, viewing_at, listing_free_from,
            req_pax, req_bedrooms, req_areas, req_move_in, req_stay, req_budget_idr_monthly, listing_facts
       FROM leads_sync
      WHERE lower(coalesce(pipeline, '')) = lower($1)
        AND ($2::text IS NULL OR lower(coalesce(responsible_user, '')) = lower($2))
        AND ($3::boolean OR coalesce(lead_stage, '') NOT ILIKE '%closed%')
      ORDER BY last_message_at DESC NULLS LAST
      LIMIT 2000`,
    [pipelineName, scope, Boolean(opts.closed)],
  );
  const ids = rows.map((r) => String(r.lead_id));
  if (!ids.length) return [];

  const [drafts, firstNames, stageSince] = await Promise.all([
    pool.query(
      `SELECT DISTINCT ON (lead_id) lead_id, id, kind, created_at, autopilot_skipped_reason
         FROM pending_suggestions WHERE status = 'pending' AND lead_id = ANY($1)
        ORDER BY lead_id, created_at DESC`,
      [ids],
    ),
    pool.query(
      `SELECT DISTINCT ON (lead_id) lead_id, sender_name FROM lead_messages
        WHERE lead_id = ANY($1) AND sender_type = 'lead' AND coalesce(sender_name, '') <> ''
        ORDER BY lead_id, sent_at ASC`,
      [ids],
    ),
    pool.query(
      `SELECT DISTINCT ON (lead_id) lead_id, changed_at FROM stage_events WHERE lead_id = ANY($1) ORDER BY lead_id, changed_at DESC`,
      [ids],
    ),
  ]);
  const draftBy = new Map(drafts.rows.map((r) => [String(r.lead_id), r]));
  const nameBy = new Map(firstNames.rows.map((r) => [String(r.lead_id), String(r.sender_name)]));
  const sinceBy = new Map(stageSince.rows.map((r) => [String(r.lead_id), r.changed_at]));

  // A villa card is named after the villa in amoCRM, not after whoever answers.
  const needAmo = /listing/i.test(pipelineName) ? ids : [];
  const amoNames = needAmo.length ? await amoLeadNames(needAmo) : new Map<string, string>();

  let tasks: OsTask[] = [];
  try {
    tasks = await openTasks();
  } catch {
    /* the board still renders without task counts */
  }
  const taskBy = new Map<string, OsTask[]>();
  for (const t of tasks) {
    const a = taskBy.get(t.leadId) ?? [];
    a.push(t);
    taskBy.set(t.leadId, a);
  }

  const missingNames: string[] = [];
  const cards = rows.map((r) => {
    const id = String(r.lead_id);
    let name: string | null = amoNames.get(id) ?? null;
    if (!name && r.head) {
      try {
        const dialog = parseDialogContent(String(r.head));
        const m = dialog.messages.find((x) => x.from === "lead" && x.senderName && x.senderName.trim().length > 1);
        name = cleanLeadName(m?.senderName);
      } catch {
        /* keep looking */
      }
    }
    if (!name) name = cleanLeadName(nameBy.get(id));
    if (!name) missingNames.push(id);
    const d = draftBy.get(id);
    const ts = (taskBy.get(id) ?? []).sort((a, b) => a.due.localeCompare(b.due));
    return {
      leadId: id,
      name: name ?? `#${id}`,
      pipeline: r.pipeline ?? null,
      stage: r.lead_stage ?? null,
      stageId: r.lead_stage_id ?? null,
      responsible: r.responsible_user ?? null,
      lastMessageAt: iso(r.last_message_at),
      lastMessageFrom: r.last_message_from ?? null,
      lastOurMessageAt: iso(r.last_our_message_at),
      nextFollowupAt: iso(r.next_followup_at),
      stageSince: iso(sinceBy.get(id)),
      temperature: r.profile_temperature ?? null,
      potential: r.profile_potential ?? null,
      intent: r.profile_intent ?? null,
      summary: r.profile_summary ?? null,
      viewingAt: iso(r.viewing_at),
      freeFrom: iso(r.listing_free_from),
      botExcluded: Boolean(r.bot_excluded),
      createdAt: iso(r.amo_created_at),
      request: {
        pax: r.req_pax ?? null,
        bedrooms: r.req_bedrooms ?? null,
        areas: r.req_areas ?? null,
        moveIn: r.req_move_in ?? null,
        stay: r.req_stay ?? null,
        budget: r.req_budget_idr_monthly ?? null,
      },
      facts: (r.listing_facts as Record<string, unknown> | null) ?? null,
      draft: d ? { id: String(d.id), kind: String(d.kind), at: iso(d.created_at)!, verdict: d.autopilot_skipped_reason ?? null } : null,
      openTasks: ts.length,
      nextTaskDue: ts[0]?.due ?? null,
    } satisfies OsCard;
  });

  // Cards with no readable name anywhere else get amoCRM's own title.
  if (missingNames.length) {
    const more = await amoLeadNames(missingNames.slice(0, 600)).catch(() => new Map<string, string>());
    for (const c of cards) if (c.name.startsWith("#") && more.get(c.leadId)) c.name = more.get(c.leadId)!;
  }
  return cards;
}

// ── One card, everything ─────────────────────────────────────────────────────

export async function leadDetail(user: OsUser, leadId: string) {
  const { rows } = await pool.query(`SELECT * FROM leads_sync WHERE lead_id = $1`, [leadId]);
  const ls = rows[0];
  if (!ls) return null;
  const scope = brokerScope(user);
  if (scope && lc(ls.responsible_user) !== lc(scope)) return { forbidden: true as const };

  const safe = async <T,>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      logger.warn({ err, leadId, label }, "os: lead detail section failed");
      return fallback;
    }
  };

  const [messages, drafts, slots, reports, commitments, stages, sends, tasks, amoLead] = await Promise.all([
    safe("messages", async () => {
      const r = await pool.query(
        `SELECT sender_type, sender_name, text, channel, direction, sent_at FROM lead_messages WHERE lead_id = $1 ORDER BY sent_at ASC LIMIT 800`,
        [leadId],
      );
      if (r.rows.length) {
        return r.rows.map((m) => ({
          from: m.sender_type === "lead" ? "client" : m.sender_type === "bot" ? "bot" : m.sender_type === "system" ? "system" : "broker",
          name: m.sender_name ?? null,
          text: m.text ?? "",
          channel: m.channel ?? null,
          at: iso(m.sent_at),
        }));
      }
      const merged = await getMergedConversation(leadId, ls.content);
      return merged.map((m) => ({ from: m.from === "lead" ? "client" : "broker", name: m.senderName, text: m.text, channel: m.channel, at: m.at.toISOString() }));
    }, [] as Array<{ from: string; name: string | null; text: string; channel: string | null; at: string | null }>),
    safe("drafts", async () => (await pool.query(
      `SELECT id, kind, followup_level, suggestion_text, attachments, suggested_stage, suggested_stage_reason, autopilot_skipped_reason, objection_category, created_at
         FROM pending_suggestions WHERE lead_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 5`, [leadId])).rows, [] as Record<string, unknown>[]),
    safe("slots", async () => (await pool.query(
      `SELECT id, viewing_at, property_code, status, agreed_at, source FROM viewing_slots WHERE lead_id = $1 ORDER BY viewing_at DESC LIMIT 20`, [leadId])).rows, [] as Record<string, unknown>[]),
    safe("reports", async () => (await pool.query(
      `SELECT id, property_code, viewing_at, status, outcome, feedback, next_steps, next_by, filed_by, filed_at FROM viewing_reports WHERE lead_id = $1 ORDER BY viewing_at DESC LIMIT 20`, [leadId])).rows, [] as Record<string, unknown>[]),
    safe("commitments", async () => (await pool.query(
      `SELECT id, promise_text, due_at, status, source_excerpt FROM lead_commitments WHERE lead_id = $1 ORDER BY due_at DESC LIMIT 20`, [leadId])).rows, [] as Record<string, unknown>[]),
    safe("stages", async () => (await pool.query(
      `SELECT from_stage, to_stage, changed_at, responsible_user FROM stage_events WHERE lead_id = $1 ORDER BY changed_at DESC LIMIT 30`, [leadId])).rows, [] as Record<string, unknown>[]),
    safe("sends", async () => (await pool.query(
      `SELECT kind, message_text, webhook_status, created_at FROM sent_messages WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 30`, [leadId])).rows, [] as Record<string, unknown>[]),
    safe("tasks", async () => (await openTasks()).filter((t) => t.leadId === leadId), [] as OsTask[]),
    safe("amo", async () => amoFetch<{ id: number; name: string; price?: number; created_at?: number; _embedded?: { tags?: Array<{ name: string }>; contacts?: Array<{ id: number }> } }>(`/api/v4/leads/${leadId}?with=contacts`), null),
  ]);

  // The phone lives only on the amoCRM contact.
  const phone = await safe("phone", async () => {
    const cid = amoLead?._embedded?.contacts?.[0]?.id;
    if (!cid) return null;
    const c = await amoFetch<{ custom_fields_values?: Array<{ field_code?: string; values?: Array<{ value?: string }> }> }>(`/api/v4/contacts/${cid}`);
    const f = (c?.custom_fields_values ?? []).find((x) => x.field_code === "PHONE");
    return f?.values?.[0]?.value ?? null;
  }, null as string | null);

  const sentIds = new Set<string>();
  for (const m of messages) {
    if (m.from === "client") continue;
    for (const hit of String(m.text).matchAll(/\/property\/([A-Za-z0-9-]+)/g)) sentIds.add(hit[1].toUpperCase());
  }

  let name = amoLead?.name ?? null;
  const firstClient = messages.find((m) => m.from === "client" && m.name);
  const personName = cleanLeadName(firstClient?.name ?? null);
  if (!/listing/i.test(String(ls.pipeline ?? "")) && personName) name = personName;

  return {
    leadId,
    name: name ?? `#${leadId}`,
    amoName: amoLead?.name ?? null,
    phone,
    tags: (amoLead?._embedded?.tags ?? []).map((t) => t.name),
    price: amoLead?.price ?? null,
    pipeline: ls.pipeline,
    stage: ls.lead_stage,
    stageId: ls.lead_stage_id,
    responsible: ls.responsible_user,
    temperature: ls.profile_temperature,
    potential: ls.profile_potential,
    intent: ls.profile_intent,
    summary: ls.profile_summary,
    timeframe: ls.profile_timeframe,
    openQuestion: ls.profile_open_question,
    alive: ls.profile_alive,
    botExcluded: Boolean(ls.bot_excluded),
    lastMessageAt: iso(ls.last_message_at),
    nextFollowupAt: iso(ls.next_followup_at),
    followupLevel: ls.followup_level,
    viewingAt: iso(ls.viewing_at),
    freeFrom: iso(ls.listing_free_from),
    createdAt: iso(ls.amo_created_at),
    notes: ls.lead_notes ?? null,
    request: {
      pax: ls.req_pax, bedrooms: ls.req_bedrooms, areas: ls.req_areas, moveIn: ls.req_move_in, stay: ls.req_stay, budget: ls.req_budget_idr_monthly,
    },
    facts: ls.listing_facts ?? null,
    messages,
    drafts,
    viewings: { slots, reports },
    commitments,
    stageEvents: stages,
    sends,
    tasks,
    sentPropertyIds: [...sentIds],
  };
}

// ── A person moves a card ────────────────────────────────────────────────────

export async function movePersonStage(
  user: OsUser,
  leadId: string,
  stageName: string,
  close?: { reason?: string | null; detail?: string | null },
): Promise<{ ok: boolean; stage?: string; error?: string }> {
  const { rows } = await pool.query(`SELECT lead_stage, pipeline, responsible_user FROM leads_sync WHERE lead_id = $1`, [leadId]);
  const ls = rows[0];
  if (!ls) return { ok: false, error: "Unknown card." };
  const scope = brokerScope(user);
  if (scope && lc(ls.responsible_user) !== lc(scope)) return { ok: false, error: "This card is not yours." };

  const amo = await getAmoLead(leadId).catch(() => null);
  if (!amo?.pipeline_id) return { ok: false, error: "amoCRM did not answer. Try again in a minute." };
  const isLost = /closed/i.test(stageName) && /lost/i.test(stageName);
  if (isLost && !close?.reason) return { ok: false, error: "Say why the card is lost." };
  let ok = false;
  let stageId: string | null = null;
  if (isLost) {
    ok = await closeLeadAsLost(leadId);
  } else {
    const safeId = await safeStageIdForLead({ pipelineId: amo.pipeline_id, stageId: null, stageName });
    stageId = safeId.id;
    if (!stageId) return { ok: false, error: `“${stageName}” is not a stage of this card's funnel.` };
    ok = await updateLeadStatus(leadId, Number(stageId));
  }
  if (!ok) return { ok: false, error: "amoCRM refused the move. Nothing changed." };

  const clearClock = shouldSuppressPush(stageName);
  await pool.query(
    `UPDATE leads_sync SET lead_stage = $2, lead_stage_id = coalesce($3, lead_stage_id), updated_at = now()${clearClock ? ", next_followup_at = NULL" : ""} WHERE lead_id = $1`,
    [leadId, stageName, stageId],
  );
  if (lc(ls.lead_stage) !== lc(stageName)) {
    await pool.query(
      `INSERT INTO stage_events (lead_id, from_stage, to_stage, pipeline, responsible_user) VALUES ($1, $2, $3, $4, $5)`,
      [leadId, ls.lead_stage ?? null, stageName, ls.pipeline ?? null, ls.responsible_user ?? null],
    ).catch(() => undefined);
  }
  if (isLost) await recordCloseReason(user.login, leadId, ls.pipeline ?? null, String(close?.reason), close?.detail ?? null).catch(() => undefined);
  await audit(user, "lead.stage", leadId, { from: ls.lead_stage, to: stageName, reason: close?.reason ?? null });
  return { ok: true, stage: stageName };
}

export async function setTemperature(user: OsUser, leadId: string, temperature: string) {
  if (!["hot", "warm", "cold"].includes(temperature)) throw new Error("hot, warm or cold");
  const { rows } = await pool.query(`SELECT responsible_user FROM leads_sync WHERE lead_id = $1`, [leadId]);
  const scope = brokerScope(user);
  if (!rows[0] || (scope && lc(rows[0].responsible_user) !== lc(scope))) throw new Error("This card is not yours.");
  await pool.query(
    `UPDATE leads_sync SET profile_temperature = $2, profile_temperature_source = 'broker', profile_temperature_override_at = now(), updated_at = now() WHERE lead_id = $1`,
    [leadId, temperature],
  );
  await audit(user, "lead.temperature", leadId, { temperature });
}

// ── Tasks ────────────────────────────────────────────────────────────────────

export async function tasksFor(user: OsUser, opts: { all?: boolean }) {
  const list = await openTasks();
  const scope = brokerScope(user);
  const mine = scope
    ? list.filter((t) => lc(t.responsible) === lc(scope) || lc(t.responsible) === lc(user.name))
    : opts.all
      ? list
      : list.filter((t) => lc(t.responsible) === lc(user.brokerKey) || lc(t.responsible) === lc(user.name));
  const ids = [...new Set(mine.map((t) => t.leadId))];
  const info = ids.length
    ? await pool.query(`SELECT lead_id, lead_stage, pipeline, responsible_user, left(content, 3000) AS head FROM leads_sync WHERE lead_id = ANY($1)`, [ids])
    : { rows: [] as Record<string, unknown>[] };
  const byId = new Map(info.rows.map((r) => [String(r.lead_id), r]));
  const names = await amoLeadNames(ids);
  return mine
    .map((t) => {
      const r = byId.get(t.leadId);
      return { ...t, leadName: names.get(t.leadId) ?? `#${t.leadId}`, stage: (r?.lead_stage as string) ?? null, pipeline: (r?.pipeline as string) ?? null };
    })
    .sort((a, b) => a.due.localeCompare(b.due));
}

export async function completeTask(user: OsUser, id: number, result: string) {
  const t = (await openTasks(true)).find((x) => x.id === id);
  if (!t) throw new Error("The task is already closed or does not exist.");
  if (t.protected) throw new Error("This task closes itself when the report is filed.");
  const scope = brokerScope(user);
  if (scope && lc(t.responsible) !== lc(scope)) throw new Error("This task is not yours.");
  const ok = await completeAmoTasks([id], result || "Done in Unicorn OS");
  if (!ok) throw new Error("amoCRM refused. Try again.");
  tasksCache = null;
  await audit(user, "task.complete", String(id), { leadId: t.leadId });
}

export async function rescheduleTask(user: OsUser, id: number, due: Date) {
  const t = (await openTasks(true)).find((x) => x.id === id);
  if (!t) throw new Error("The task is already closed or does not exist.");
  const scope = brokerScope(user);
  if (scope && lc(t.responsible) !== lc(scope)) throw new Error("This task is not yours.");
  const res = await amoPatch<unknown>(`/api/v4/tasks`, [{ id, complete_till: Math.floor(due.getTime() / 1000) }]);
  if (res === null) throw new Error("amoCRM refused. Try again.");
  tasksCache = null;
  await audit(user, "task.reschedule", String(id), { due: due.toISOString() });
}

export async function createTask(user: OsUser, leadId: string, text: string, due: Date) {
  const { rows } = await pool.query(`SELECT responsible_user FROM leads_sync WHERE lead_id = $1`, [leadId]);
  const scope = brokerScope(user);
  if (!rows[0] || (scope && lc(rows[0].responsible_user) !== lc(scope))) throw new Error("This card is not yours.");
  const amo = await getAmoLead(leadId).catch(() => null);
  const ok = await createAmoTask(leadId, text, due, amo?.responsible_user_id);
  if (!ok) throw new Error("amoCRM refused the task.");
  tasksCache = null;
  await audit(user, "task.create", leadId, { text, due: due.toISOString() });
}

// ── Calendar ─────────────────────────────────────────────────────────────────

export async function calendar(user: OsUser, from: Date, to: Date) {
  const scope = brokerScope(user);
  const events: Array<{ id: string; kind: string; at: string; title: string; sub: string | null; leadId: string | null; timeKnown: boolean; who: string | null }> = [];
  const v = await pool.query(
    `SELECT s.id, s.lead_id, s.viewing_at, s.property_code, s.status, l.responsible_user
       FROM viewing_slots s LEFT JOIN leads_sync l ON l.lead_id = s.lead_id
      WHERE s.viewing_at BETWEEN $1 AND $2 AND s.status IN ('scheduled', 'reported')
        AND ($3::text IS NULL OR lower(coalesce(l.responsible_user,'')) = lower($3))`,
    [from, to, scope],
  ).catch(() => ({ rows: [] as Record<string, unknown>[] }));
  const ins = await pool.query(
    `SELECT s.id, s.lead_id, s.visit_at, s.time_known, l.responsible_user
       FROM listing_inspection_slots s LEFT JOIN leads_sync l ON l.lead_id = s.lead_id
      WHERE s.visit_at BETWEEN $1 AND $2 AND coalesce(s.status, 'scheduled') = 'scheduled'
        AND ($3::text IS NULL OR lower(coalesce(l.responsible_user,'')) = lower($3))`,
    [from, to, scope],
  ).catch(() => ({ rows: [] as Record<string, unknown>[] }));
  const ids = [...new Set([...v.rows, ...ins.rows].map((r) => String(r.lead_id)))];
  const names = await amoLeadNames(ids).catch(() => new Map<string, string>());
  for (const r of v.rows) {
    events.push({ id: `v:${r.id}`, kind: "viewing", at: iso(r.viewing_at)!, title: `Viewing · ${names.get(String(r.lead_id)) ?? "#" + r.lead_id}`, sub: (r.property_code as string) ?? null, leadId: String(r.lead_id), timeKnown: true, who: (r.responsible_user as string) ?? null });
  }
  for (const r of ins.rows) {
    events.push({ id: `i:${r.id}`, kind: "inspection", at: iso(r.visit_at)!, title: `Inspection · ${names.get(String(r.lead_id)) ?? "#" + r.lead_id}`, sub: r.time_known ? null : "time not fixed", leadId: String(r.lead_id), timeKnown: Boolean(r.time_known), who: (r.responsible_user as string) ?? null });
  }
  try {
    const ts = await tasksFor(user, { all: isStaff(user) });
    for (const t of ts) {
      const at = new Date(t.due);
      if (at < from || at > to) continue;
      events.push({ id: `t:${t.id}`, kind: "task", at: t.due, title: t.text, sub: t.leadName, leadId: t.leadId, timeKnown: true, who: t.responsible });
    }
  } catch {
    /* tasks are optional on the calendar */
  }
  return events.sort((a, b) => a.at.localeCompare(b.at));
}

// ── Notifications (derived, nothing new stored but the "seen" mark) ─────────

export async function notifications(user: OsUser) {
  const scope = brokerScope(user) ?? (isStaff(user) ? null : user.brokerKey);
  const items: Array<{ id: string; kind: string; title: string; body: string; at: string; leadId: string | null; severity: "info" | "warn" | "bad" }> = [];
  const q = async (sql: string, params: unknown[]) => (await pool.query(sql, params).catch(() => ({ rows: [] as Record<string, unknown>[] }))).rows;

  const live = await q(
    `SELECT p.id, p.lead_id, p.created_at, p.kind, l.responsible_user
       FROM pending_suggestions p LEFT JOIN leads_sync l ON l.lead_id = p.lead_id
      WHERE p.status = 'pending' AND p.kind = 'live' AND p.created_at > now() - interval '3 days'
        AND ($1::text IS NULL OR lower(coalesce(l.responsible_user,'')) = lower($1))
      ORDER BY p.created_at DESC LIMIT 40`,
    [scope],
  );
  const due = await q(
    `SELECT r.id, r.lead_id, r.viewing_at, r.property_code, l.responsible_user FROM viewing_reports r LEFT JOIN leads_sync l ON l.lead_id = r.lead_id
      WHERE r.status = 'due' AND ($1::text IS NULL OR lower(coalesce(l.responsible_user,'')) = lower($1)) ORDER BY r.viewing_at DESC LIMIT 20`,
    [scope],
  );
  const promises = await q(
    `SELECT c.id, c.lead_id, c.promise_text, c.due_at, l.responsible_user FROM lead_commitments c LEFT JOIN leads_sync l ON l.lead_id = c.lead_id
      WHERE c.status = 'open' AND c.due_at < now() + interval '2 hours'
        AND ($1::text IS NULL OR lower(coalesce(l.responsible_user,'')) = lower($1)) ORDER BY c.due_at ASC LIMIT 20`,
    [scope],
  );
  const insp = await q(
    `SELECT r.id, r.lead_id, r.visit_at, r.property_code, l.responsible_user FROM inspection_reports r LEFT JOIN leads_sync l ON l.lead_id = r.lead_id
      WHERE r.status = 'due' AND ($1::text IS NULL OR lower(coalesce(l.responsible_user,'')) = lower($1)) ORDER BY r.visit_at DESC LIMIT 20`,
    [scope],
  );
  const ids = [...new Set([...live, ...due, ...promises, ...insp].map((r) => String(r.lead_id)))];
  const names = await amoLeadNames(ids).catch(() => new Map<string, string>());
  const nm = (id: unknown) => names.get(String(id)) ?? `#${id}`;
  for (const r of live) items.push({ id: `live:${r.id}`, kind: "live", title: `${nm(r.lead_id)} wrote`, body: "A reply draft is waiting for you.", at: iso(r.created_at)!, leadId: String(r.lead_id), severity: "info" });
  for (const r of promises) items.push({ id: `promise:${r.id}`, kind: "promise", title: `Promise due · ${nm(r.lead_id)}`, body: String(r.promise_text ?? ""), at: iso(r.due_at)!, leadId: String(r.lead_id), severity: new Date(String(r.due_at)) < new Date() ? "bad" : "warn" });
  for (const r of due) items.push({ id: `vr:${r.id}`, kind: "viewing-report", title: `Viewing report due · ${nm(r.lead_id)}`, body: `Viewing ${r.property_code ?? ""} on ${new Date(String(r.viewing_at)).toLocaleString("en-GB", { timeZone: "Asia/Makassar", dateStyle: "medium", timeStyle: "short" })}`, at: iso(r.viewing_at)!, leadId: String(r.lead_id), severity: "warn" });
  for (const r of insp) items.push({ id: `ir:${r.id}`, kind: "inspection-report", title: `Inspection report due · ${nm(r.lead_id)}`, body: `${r.property_code ?? ""} visited ${new Date(String(r.visit_at)).toLocaleDateString("en-GB", { timeZone: "Asia/Makassar" })}`, at: iso(r.visit_at)!, leadId: String(r.lead_id), severity: "warn" });
  try {
    const ts = await tasksFor(user, {});
    for (const t of ts.filter((x) => new Date(x.due) < new Date()).slice(0, 30)) {
      items.push({ id: `task:${t.id}`, kind: "task", title: `Overdue task · ${t.leadName}`, body: t.text, at: t.due, leadId: t.leadId, severity: "bad" });
    }
  } catch {
    /* amoCRM down: the other items still show */
  }
  if (isStaff(user)) {
    const h = aiHealth() as unknown as Record<string, unknown>;
    if (h && (h["outage"] || h["status"] === "down")) items.push({ id: "ai", kind: "system", title: "AI is failing", body: "Drafts are not being written. Check the Anthropic balance and key.", at: new Date().toISOString(), leadId: null, severity: "bad" });
    const wa = await q(`SELECT name, label, status, updated_at FROM wa_sessions`, []);
    for (const s of wa) {
      if (/open|connected|online|live/i.test(String(s.status ?? ""))) continue;
      items.push({ id: `wa:${s.name}`, kind: "system", title: `WhatsApp ${s.label ?? s.name}: ${s.status ?? "unknown"}`, body: "The gateway reports this number as not connected.", at: iso(s.updated_at) ?? new Date().toISOString(), leadId: null, severity: "warn" });
    }
  }
  const seen = (await q(`SELECT notif_seen_at FROM os_users WHERE id = $1`, [user.id]))[0]?.notif_seen_at as string | undefined;
  items.sort((a, b) => b.at.localeCompare(a.at));
  return { items, seenAt: iso(seen ?? null) };
}

export async function markNotificationsSeen(user: OsUser) {
  await pool.query(`UPDATE os_users SET notif_seen_at = now() WHERE id = $1`, [user.id]);
}

// ── Integrations health ──────────────────────────────────────────────────────

export async function integrations() {
  const out: Record<string, unknown> = {};
  const q = async (sql: string) => (await pool.query(sql).catch(() => ({ rows: [] as Record<string, unknown>[] }))).rows;
  out["whatsapp"] = await q(`SELECT name, label, phone, status, mode, pipeline, responsible, updated_at FROM wa_sessions ORDER BY name`);
  out["whatsappLastMessage"] = (await q(`SELECT max(created_at) AS at FROM wa_messages`))[0]?.at ?? null;
  out["amoLastSync"] = (await q(`SELECT max(updated_at) AS at FROM leads_sync`))[0]?.at ?? null;
  out["amoLastMessage"] = (await q(`SELECT max(sent_at) AS at FROM lead_messages`))[0]?.at ?? null;
  const acct = await amoFetch<{ id: number; name: string }>(`/api/v4/account`).catch(() => null);
  out["amocrm"] = acct ? { ok: true, name: acct.name } : { ok: false };
  out["ai"] = aiHealth();
  out["aiSpendToday"] = (await q(`SELECT round(sum(cost_usd)::numeric, 2) AS usd FROM ai_usage WHERE created_at > date_trunc('day', now() AT TIME ZONE 'Asia/Makassar') AT TIME ZONE 'Asia/Makassar'`))[0]?.usd ?? null;
  out["calendar"] = {
    configured: Boolean(process.env["GOOGLE_CALENDAR_WEBHOOK_URL"]),
    calendarId: process.env["GOOGLE_CALENDAR_ID"] ? "Brokers" : null,
    lastInspectionEvent: (await q(`SELECT max(updated_at) AS at FROM inspection_calendar_events`))[0]?.at ?? null,
  };
  out["site"] = { configured: Boolean(process.env["SUPABASE_URL"] && process.env["SUPABASE_SERVICE_ROLE_KEY"]) };
  out["metaSpendLast"] = (await q(`SELECT max(updated_at) AS at FROM kpi_ad_spend`))[0]?.at ?? null;
  out["push"] = (await q(`SELECT broker_id, count(*)::int AS devices FROM push_subscriptions GROUP BY broker_id ORDER BY broker_id`));
  return out;
}

// ── Clients a villa fits (a new or freed villa → who asked for it) ─────────

export async function matchingClients(user: OsUser, listing: { area?: unknown; title?: unknown; bedrooms?: unknown; monthly_price_idr?: unknown }) {
  const scope = brokerScope(user);
  const beds = Number(listing.bedrooms ?? 0) || null;
  const price = Number(listing.monthly_price_idr ?? 0) || null;
  const areaWords = `${listing.area ?? ""} ${listing.title ?? ""}`.toLowerCase();
  const { rows } = await pool.query(
    `SELECT lead_id, left(content, 3000) AS head, lead_stage, responsible_user, req_bedrooms, req_areas, req_budget_idr_monthly, last_message_at
       FROM leads_sync
      WHERE lower(coalesce(pipeline,'')) = 'rental' AND coalesce(lead_stage,'') NOT ILIKE '%closed%'
        AND ($1::int IS NULL OR req_bedrooms IS NULL OR req_bedrooms = $1)
        AND ($2::text IS NULL OR lower(coalesce(responsible_user,'')) = lower($2))
        AND last_message_at > now() - interval '45 days'
      ORDER BY last_message_at DESC NULLS LAST LIMIT 400`,
    [beds, scope],
  );
  const out = [];
  for (const r of rows) {
    const areas = String(r.req_areas ?? "").toLowerCase().split(/[,/;]| or /).map((a: string) => a.trim()).filter(Boolean);
    const areaOk = !areas.length || areas.some((a: string) => areaWords.includes(a));
    const b = Number(r.req_budget_idr_monthly ?? 0) || null;
    const priceOk = !b || !price || (price >= b * 0.7 && price <= b * 1.25);
    if (!areaOk || !priceOk || (!areas.length && !b && r.req_bedrooms == null)) continue;
    let name: string | null = null;
    try {
      const m = parseDialogContent(String(r.head ?? "")).messages.find((x) => x.from === "lead" && x.senderName && x.senderName.trim().length > 1);
      name = cleanLeadName(m?.senderName);
    } catch {
      /* unnamed */
    }
    out.push({ leadId: String(r.lead_id), name: name ?? `#${r.lead_id}`, stage: r.lead_stage, responsible: r.responsible_user, bedrooms: r.req_bedrooms, areas: r.req_areas, budget: b, lastMessageAt: iso(r.last_message_at) });
    if (out.length >= 30) break;
  }
  return out;
}
