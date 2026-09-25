/**
 * Unicorn OS — funnels and their stages, set up by the owner (26.09).
 *
 * The owner chose: every change here lives in the OS only; amoCRM is not touched.
 *   · A funnel that comes from amoCRM (Rental, Rental Listings, UNICORN) keeps its live stages
 *     from amoCRM on the board. Adding, renaming, moving or removing its stages here is saved
 *     as the plan for the move (os_funnel_stages rows with amo_stage_id), shown beside the live
 *     stages and applied on the day the agency leaves amoCRM. Its stage rules for the bot live
 *     in os_stage_rules (automation-map.ts) and act at once, as before.
 *   · A funnel created here is the OS's own: its stages, its cards (os_cards) and their history
 *     (os_card_events). The Copilot does not read these cards yet; people move them.
 */
import { pool } from "@workspace/db";
import { isStaff, audit, type OsUser } from "./auth";
import { pipelines } from "./data";

let ready: Promise<void> | null = null;
export function ensureFunnelTables(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS os_funnels (
          id serial PRIMARY KEY,
          key text NOT NULL UNIQUE,
          name text NOT NULL,
          source text NOT NULL DEFAULT 'os',
          color text,
          sort double precision NOT NULL DEFAULT 0,
          created_by int,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          archived_at timestamptz
        );
        CREATE TABLE IF NOT EXISTS os_funnel_stages (
          id serial PRIMARY KEY,
          funnel_id int NOT NULL REFERENCES os_funnels(id),
          name text NOT NULL,
          kind text NOT NULL DEFAULT 'open',
          sort double precision NOT NULL DEFAULT 0,
          rule text NOT NULL DEFAULT '',
          amo_stage_id bigint,
          removed_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS os_funnel_stages_funnel ON os_funnel_stages (funnel_id, sort);
        CREATE TABLE IF NOT EXISTS os_cards (
          id serial PRIMARY KEY,
          funnel_id int NOT NULL REFERENCES os_funnels(id),
          stage_id int NOT NULL REFERENCES os_funnel_stages(id),
          name text NOT NULL,
          phone text NOT NULL DEFAULT '',
          email text NOT NULL DEFAULT '',
          value_idr bigint,
          notes text NOT NULL DEFAULT '',
          responsible_id int,
          created_by int,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          stage_since timestamptz NOT NULL DEFAULT now(),
          deleted_at timestamptz
        );
        CREATE INDEX IF NOT EXISTS os_cards_funnel ON os_cards (funnel_id, stage_id) WHERE deleted_at IS NULL;
        CREATE TABLE IF NOT EXISTS os_card_events (
          id serial PRIMARY KEY,
          card_id int NOT NULL,
          user_id int,
          kind text NOT NULL,
          detail jsonb,
          at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS os_card_events_card ON os_card_events (card_id, at);
      `);
    })().catch((err) => {
      ready = null;
      throw err;
    });
  }
  return ready;
}

type Row = Record<string, unknown>;
const bad = (msg: string, status = 400) => Object.assign(new Error(msg), { status });
const clean = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
const kindOf = (name: string) => (/won|успешно|contract signed/i.test(name) ? "won" : /lost|закрыто и не/i.test(name) ? "lost" : "open");
const KINDS = ["open", "won", "lost"];

function needStaff(user: OsUser) {
  if (!isStaff(user)) throw bad("Only the owner and managers change funnels.", 403);
}

async function amoFunnels() {
  return (await pipelines()).map((p) => ({ key: p.key, name: p.name, stages: p.stages.map((s) => ({ id: Number(s.id), name: s.name })) }));
}

async function funnelRow(key: string): Promise<Row | null> {
  const r = await pool.query(`SELECT * FROM os_funnels WHERE key = $1 AND archived_at IS NULL`, [key]);
  return r.rows[0] ?? null;
}

/**
 * The funnel row to write to. For an amoCRM funnel the first change creates its plan: a copy
 * of the live stages, each tied to its amoCRM stage, so every later change reads as a diff.
 */
async function writable(user: OsUser, key: string): Promise<{ row: Row; source: "os" | "amo" }> {
  needStaff(user);
  await ensureFunnelTables();
  const row = await funnelRow(key);
  if (row) return { row, source: row["source"] === "amo" ? "amo" : "os" };
  const amo = (await amoFunnels()).find((f) => f.key === key);
  if (!amo) throw bad("Unknown funnel.", 404);
  const ins = await pool.query(`INSERT INTO os_funnels (key, name, source, created_by) VALUES ($1,$2,'amo',$3) RETURNING *`, [key, amo.name, user.id]);
  const f = ins.rows[0];
  let i = 0;
  for (const s of amo.stages) {
    await pool.query(`INSERT INTO os_funnel_stages (funnel_id, name, kind, sort, amo_stage_id) VALUES ($1,$2,$3,$4,$5)`, [f.id, s.name, kindOf(s.name), i++, s.id]);
  }
  await audit(user, "funnel.plan-start", key, { stages: amo.stages.length });
  return { row: f, source: "amo" };
}

async function stageRows(funnelId: number, withRemoved = false) {
  const r = await pool.query(
    `SELECT id, name, kind, sort, rule, amo_stage_id, removed_at, updated_at FROM os_funnel_stages WHERE funnel_id = $1 ${withRemoved ? "" : "AND removed_at IS NULL"} ORDER BY sort, id`,
    [funnelId],
  );
  return r.rows.map((s) => ({
    id: Number(s.id),
    name: String(s.name),
    kind: String(s.kind),
    rule: String(s.rule ?? ""),
    amoStageId: s.amo_stage_id == null ? null : Number(s.amo_stage_id),
    removed: !!s.removed_at,
  }));
}

/** Every funnel: amoCRM ones with their live stages and the plan for the move, and the OS's own. */
export async function listFunnels() {
  await ensureFunnelTables();
  const [amo, rows] = await Promise.all([amoFunnels(), pool.query(`SELECT * FROM os_funnels WHERE archived_at IS NULL ORDER BY sort, id`)]);
  const byKey = new Map(rows.rows.map((r) => [String(r.key), r]));
  const out: Array<Record<string, unknown>> = [];
  for (const f of amo) {
    const plan = byKey.get(f.key);
    const planStages = plan ? await stageRows(Number(plan.id), true) : null;
    out.push({ key: f.key, name: f.name, source: "amo", live: f.stages, plan: planStages ? { name: String(plan!.name), stages: diffPlan(f.stages, planStages) } : null });
  }
  for (const r of rows.rows) {
    if (r.source !== "os") continue;
    const stages = await stageRows(Number(r.id));
    const counts = await pool.query(`SELECT stage_id, count(*)::int AS n FROM os_cards WHERE funnel_id = $1 AND deleted_at IS NULL GROUP BY 1`, [r.id]);
    const n = new Map(counts.rows.map((c) => [Number(c.stage_id), Number(c.n)]));
    out.push({ key: String(r.key), name: String(r.name), source: "os", color: r.color ?? null, stages: stages.map((s) => ({ ...s, cards: n.get(s.id) ?? 0 })) });
  }
  return { items: out };
}

/** How the plan differs from amoCRM today, row by row, so the screen can say it in words. */
function diffPlan(live: Array<{ id: number; name: string }>, plan: Awaited<ReturnType<typeof stageRows>>) {
  const liveIdx = new Map(live.map((s, i) => [s.id, i]));
  const kept = plan.filter((p) => !p.removed && p.amoStageId != null);
  return plan.map((p) => {
    const l = p.amoStageId != null ? live.find((x) => x.id === p.amoStageId) : null;
    let change: string | null = null;
    if (p.amoStageId == null) change = "new";
    else if (!l) change = "gone"; // removed in amoCRM itself since the plan began
    else if (p.removed) change = "removed";
    else if (l.name !== p.name) change = "renamed";
    else {
      // moved: its place among the kept live stages is not amoCRM's order
      const before = kept.filter((k) => k.amoStageId != null && (liveIdx.get(k.amoStageId) ?? 0) < (liveIdx.get(p.amoStageId!) ?? 0)).map((k) => k.id);
      const planBefore = kept.slice(0, kept.findIndex((k) => k.id === p.id)).map((k) => k.id);
      if (before.length !== planBefore.length || before.some((id) => !planBefore.includes(id))) change = "moved";
    }
    return { ...p, liveName: l?.name ?? null, change };
  });
}

export async function createFunnel(user: OsUser, body: { name?: unknown; copyFrom?: unknown; color?: unknown }) {
  needStaff(user);
  await ensureFunnelTables();
  const name = clean(body.name, 80);
  if (!name) throw bad("Name the funnel.");
  const base = "f-" + (name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "funnel");
  let key = base;
  for (let i = 2; await funnelRow(key); i++) key = `${base}-${i}`;
  let stages: Array<{ name: string; kind: string; rule: string }> = [
    { name: "New", kind: "open", rule: "" },
    { name: "In progress", kind: "open", rule: "" },
    { name: "Won", kind: "won", rule: "" },
    { name: "Lost", kind: "lost", rule: "" },
  ];
  const from = clean(body.copyFrom, 80);
  if (from) {
    const all = (await listFunnels()).items;
    const src = all.find((f) => f["key"] === from) as Record<string, any> | undefined;
    if (!src) throw bad("The funnel to copy from is gone.");
    const list = src.source === "amo" ? (src.plan ? src.plan.stages.filter((s: any) => !s.removed) : src.live) : src.stages;
    stages = list.map((s: any) => ({ name: String(s.name), kind: s.kind || kindOf(String(s.name)), rule: String(s.rule || "") }));
  }
  const sort = (await pool.query(`SELECT coalesce(max(sort),0)+1 AS s FROM os_funnels`)).rows[0].s;
  const f = (await pool.query(`INSERT INTO os_funnels (key, name, source, color, sort, created_by) VALUES ($1,$2,'os',$3,$4,$5) RETURNING *`, [key, name, clean(body.color, 20) || null, sort, user.id])).rows[0];
  let i = 0;
  for (const s of stages) await pool.query(`INSERT INTO os_funnel_stages (funnel_id, name, kind, sort, rule) VALUES ($1,$2,$3,$4,$5)`, [f.id, s.name, s.kind, i++, s.rule]);
  await audit(user, "funnel.create", key, { name, copyFrom: from || null, stages: stages.length });
  return { key, name };
}

export async function updateFunnel(user: OsUser, key: string, body: { name?: unknown; color?: unknown }) {
  const { row } = await writable(user, key);
  const name = body.name === undefined ? String(row["name"]) : clean(body.name, 80);
  if (!name) throw bad("Name the funnel.");
  await pool.query(`UPDATE os_funnels SET name = $2, color = coalesce($3, color), updated_at = now() WHERE id = $1`, [row["id"], name, body.color === undefined ? null : clean(body.color, 20)]);
  await audit(user, "funnel.update", key, { name });
  return { ok: true };
}

export async function archiveFunnel(user: OsUser, key: string) {
  const { row, source } = await writable(user, key);
  if (source === "amo") throw bad("A funnel from amoCRM cannot be removed here. Discard its plan instead.");
  await pool.query(`UPDATE os_funnels SET archived_at = now() WHERE id = $1`, [row["id"]]);
  await audit(user, "funnel.archive", key, null);
  return { ok: true };
}

/** amoCRM funnel: begin its plan for the move (a copy of the live stages) and return it. */
export async function startPlan(user: OsUser, key: string) {
  await writable(user, key);
  return (await listFunnels()).items.find((f) => f["key"] === key) ?? null;
}

/** amoCRM funnel: forget the plan for the move, back to amoCRM's stages as they are. */
export async function discardPlan(user: OsUser, key: string) {
  const { row, source } = await writable(user, key);
  if (source !== "amo") throw bad("Only a funnel from amoCRM has a plan to discard.");
  await pool.query(`DELETE FROM os_funnel_stages WHERE funnel_id = $1`, [row["id"]]);
  await pool.query(`DELETE FROM os_funnels WHERE id = $1`, [row["id"]]);
  await audit(user, "funnel.plan-discard", key, null);
  return { ok: true };
}

export async function addStage(user: OsUser, key: string, body: { name?: unknown; afterId?: unknown; kind?: unknown }) {
  const { row } = await writable(user, key);
  const name = clean(body.name, 80);
  if (!name) throw bad("Name the stage.");
  const stages = await stageRows(Number(row["id"]), true);
  if (stages.some((s) => !s.removed && s.name.toLowerCase() === name.toLowerCase())) throw bad("This funnel already has a stage with that name.");
  const after = body.afterId == null ? null : stages.findIndex((s) => s.id === Number(body.afterId));
  // Without a place, a new stage goes before the closing ones (won, lost).
  const at = after != null && after >= 0 ? after + 1 : (() => {
    const firstClosed = stages.findIndex((s) => !s.removed && s.kind !== "open");
    return firstClosed === -1 ? stages.length : firstClosed;
  })();
  const kind = KINDS.includes(String(body.kind)) ? String(body.kind) : "open";
  const ins = await pool.query(`INSERT INTO os_funnel_stages (funnel_id, name, kind, sort) VALUES ($1,$2,$3,0) RETURNING id`, [row["id"], name, kind]);
  const order = stages.map((s) => s.id);
  order.splice(at, 0, Number(ins.rows[0].id));
  await writeOrder(order);
  await audit(user, "funnel.stage-add", key, { name });
  return { ok: true, id: Number(ins.rows[0].id) };
}

async function writeOrder(ids: number[]) {
  for (let i = 0; i < ids.length; i++) await pool.query(`UPDATE os_funnel_stages SET sort = $2, updated_at = now() WHERE id = $1`, [ids[i], i]);
}

async function stageOf(funnelId: number, id: number) {
  const r = await pool.query(`SELECT * FROM os_funnel_stages WHERE id = $1 AND funnel_id = $2`, [id, funnelId]);
  if (!r.rows[0]) throw bad("No such stage in this funnel.", 404);
  return r.rows[0];
}

export async function updateStage(user: OsUser, key: string, id: number, body: { name?: unknown; rule?: unknown; kind?: unknown; restore?: unknown }) {
  const { row } = await writable(user, key);
  const s = await stageOf(Number(row["id"]), id);
  const name = body.name === undefined ? String(s.name) : clean(body.name, 80);
  if (!name) throw bad("Name the stage.");
  if (name.toLowerCase() !== String(s.name).toLowerCase()) {
    const dup = await pool.query(`SELECT 1 FROM os_funnel_stages WHERE funnel_id = $1 AND id <> $2 AND removed_at IS NULL AND lower(name) = lower($3)`, [row["id"], id, name]);
    if (dup.rows.length) throw bad("This funnel already has a stage with that name.");
  }
  const rule = body.rule === undefined ? String(s.rule ?? "") : clean(body.rule, 4000);
  const kind = body.kind !== undefined && KINDS.includes(String(body.kind)) ? String(body.kind) : String(s.kind);
  await pool.query(`UPDATE os_funnel_stages SET name = $2, rule = $3, kind = $4, removed_at = CASE WHEN $5 THEN NULL ELSE removed_at END, updated_at = now() WHERE id = $1`, [id, name, rule, kind, body.restore === true]);
  await audit(user, "funnel.stage-update", key, { id, name, kind, rule: body.rule === undefined ? undefined : rule.slice(0, 200), restore: body.restore === true || undefined });
  return { ok: true };
}

export async function reorderStages(user: OsUser, key: string, ids: unknown) {
  const { row } = await writable(user, key);
  const stages = await stageRows(Number(row["id"]), true);
  const want = Array.isArray(ids) ? ids.map(Number) : [];
  const known = new Set(stages.map((s) => s.id));
  if (!want.length || want.some((x) => !known.has(x))) throw bad("The stage order does not match this funnel.");
  // Rows the list left out (removed ones) keep their place after the listed ones.
  const order = [...want, ...stages.map((s) => s.id).filter((x) => !want.includes(x))];
  await writeOrder(order);
  await audit(user, "funnel.stage-order", key, { ids: want });
  return { ok: true };
}

/**
 * Remove a stage. OS funnel: its cards move to `moveTo` first (a stage with cards is never left
 * orphaned). amoCRM plan: a live stage is marked removed at the move; a planned new one just goes.
 */
export async function removeStage(user: OsUser, key: string, id: number, body: { moveTo?: unknown }) {
  const { row, source } = await writable(user, key);
  const s = await stageOf(Number(row["id"]), id);
  if (source === "amo") {
    if (s.amo_stage_id == null) await pool.query(`DELETE FROM os_funnel_stages WHERE id = $1`, [id]);
    else await pool.query(`UPDATE os_funnel_stages SET removed_at = now(), updated_at = now() WHERE id = $1`, [id]);
  } else {
    const n = Number((await pool.query(`SELECT count(*)::int AS n FROM os_cards WHERE stage_id = $1 AND deleted_at IS NULL`, [id])).rows[0].n);
    if (n) {
      const to = Number(body.moveTo);
      if (!to || to === id) throw bad(`${n} card${n === 1 ? " is" : "s are"} in this stage. Pick the stage they move to.`);
      await stageOf(Number(row["id"]), to);
      const moved = await pool.query(`UPDATE os_cards SET stage_id = $2, stage_since = now(), updated_at = now() WHERE stage_id = $1 AND deleted_at IS NULL RETURNING id`, [id, to]);
      for (const c of moved.rows) await cardEvent(Number(c.id), user, "stage", { from: s.name, to: (await stageOf(Number(row["id"]), to)).name, why: "stage removed" });
    }
    await pool.query(`UPDATE os_funnel_stages SET removed_at = now(), updated_at = now() WHERE id = $1`, [id]);
  }
  await audit(user, "funnel.stage-remove", key, { id, name: s.name });
  return { ok: true };
}

// ── cards of the OS's own funnels ────────────────────────────────────────────

async function cardEvent(cardId: number, user: OsUser | null, kind: string, detail: unknown) {
  await pool.query(`INSERT INTO os_card_events (card_id, user_id, kind, detail) VALUES ($1,$2,$3,$4)`, [cardId, user?.id ?? null, kind, detail == null ? null : JSON.stringify(detail)]);
}

async function osFunnel(key: string) {
  await ensureFunnelTables();
  const f = await funnelRow(key);
  if (!f || f["source"] !== "os") throw bad("Unknown funnel.", 404);
  return f;
}

const CARD_COLS = `c.id, c.funnel_id, c.stage_id, s.name AS stage, s.kind AS stage_kind, c.name, c.phone, c.email, c.value_idr, c.notes, c.responsible_id, u.name AS responsible, c.created_at, c.updated_at, c.stage_since`;
const cardOut = (r: Row) => ({
  id: Number(r["id"]),
  stageId: Number(r["stage_id"]),
  stage: String(r["stage"] ?? ""),
  stageKind: String(r["stage_kind"] ?? "open"),
  name: String(r["name"]),
  phone: String(r["phone"] ?? ""),
  email: String(r["email"] ?? ""),
  valueIdr: r["value_idr"] == null ? null : Number(r["value_idr"]),
  notes: String(r["notes"] ?? ""),
  responsibleId: r["responsible_id"] == null ? null : Number(r["responsible_id"]),
  responsible: r["responsible"] == null ? null : String(r["responsible"]),
  createdAt: r["created_at"],
  updatedAt: r["updated_at"],
  stageSince: r["stage_since"],
});

/** A broker sees the cards they hold and the ones nobody holds yet; staff see all. */
function scope(user: OsUser, params: unknown[]) {
  if (isStaff(user)) return "";
  params.push(user.id);
  return ` AND (c.responsible_id = $${params.length} OR c.responsible_id IS NULL)`;
}

export async function listCards(user: OsUser, key: string) {
  const f = await osFunnel(key);
  const params: unknown[] = [f["id"]];
  const where = scope(user, params);
  const r = await pool.query(
    `SELECT ${CARD_COLS} FROM os_cards c JOIN os_funnel_stages s ON s.id = c.stage_id LEFT JOIN os_users u ON u.id = c.responsible_id
      WHERE c.funnel_id = $1 AND c.deleted_at IS NULL${where} ORDER BY c.updated_at DESC`,
    params,
  );
  return { funnel: { key, name: String(f["name"]) }, stages: await stageRows(Number(f["id"])), items: r.rows.map(cardOut) };
}

export async function createCard(user: OsUser, key: string, body: Row) {
  const f = await osFunnel(key);
  const name = clean(body["name"], 160);
  if (!name) throw bad("Name the card.");
  const stages = await stageRows(Number(f["id"]));
  const stageId = body["stageId"] ? Number(body["stageId"]) : stages[0]?.id;
  if (!stages.some((s) => s.id === stageId)) throw bad("Pick a stage of this funnel.");
  const ins = await pool.query(
    `INSERT INTO os_cards (funnel_id, stage_id, name, phone, email, value_idr, notes, responsible_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [f["id"], stageId, name, clean(body["phone"], 60), clean(body["email"], 160), body["valueIdr"] ? Math.round(Number(body["valueIdr"])) || null : null, clean(body["notes"], 8000), body["responsibleId"] ? Number(body["responsibleId"]) : isStaff(user) ? null : user.id, user.id],
  );
  const id = Number(ins.rows[0].id);
  await cardEvent(id, user, "created", { stage: stages.find((s) => s.id === stageId)?.name });
  return cardDetail(user, id);
}

async function cardRow(user: OsUser, id: number) {
  await ensureFunnelTables();
  const params: unknown[] = [id];
  const where = scope(user, params);
  const r = await pool.query(
    `SELECT ${CARD_COLS}, f.key AS funnel_key, f.name AS funnel_name FROM os_cards c JOIN os_funnel_stages s ON s.id = c.stage_id JOIN os_funnels f ON f.id = c.funnel_id LEFT JOIN os_users u ON u.id = c.responsible_id
      WHERE c.id = $1 AND c.deleted_at IS NULL${where}`,
    params,
  );
  if (!r.rows[0]) throw bad("No such card.", 404);
  return r.rows[0];
}

export async function cardDetail(user: OsUser, id: number) {
  const r = await cardRow(user, id);
  const ev = await pool.query(`SELECT e.kind, e.detail, e.at, u.name AS who FROM os_card_events e LEFT JOIN os_users u ON u.id = e.user_id WHERE e.card_id = $1 ORDER BY e.at DESC LIMIT 100`, [id]);
  return {
    ...cardOut(r),
    funnel: { key: String(r.funnel_key), name: String(r.funnel_name) },
    stages: await stageRows(Number(r.funnel_id)),
    events: ev.rows.map((e) => ({ kind: e.kind, detail: e.detail, at: e.at, who: e.who })),
  };
}

export async function updateCard(user: OsUser, id: number, body: Row) {
  const r = await cardRow(user, id);
  const sets: string[] = [];
  const vals: unknown[] = [id];
  const set = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  const changed: Record<string, unknown> = {};
  if (body["name"] !== undefined) {
    const n = clean(body["name"], 160);
    if (!n) throw bad("Name the card.");
    set("name", n);
    changed["name"] = n;
  }
  for (const [k, col, max] of [["phone", "phone", 60], ["email", "email", 160], ["notes", "notes", 8000]] as const) {
    if (body[k] !== undefined) {
      set(col, clean(body[k], max));
      changed[k] = true;
    }
  }
  if (body["valueIdr"] !== undefined) {
    set("value_idr", body["valueIdr"] ? Math.round(Number(body["valueIdr"])) || null : null);
    changed["value"] = body["valueIdr"];
  }
  if (body["responsibleId"] !== undefined) {
    if (!isStaff(user)) throw bad("Only the owner and managers hand cards over.", 403);
    set("responsible_id", body["responsibleId"] ? Number(body["responsibleId"]) : null);
    changed["responsible"] = body["responsibleId"];
  }
  if (body["stageId"] !== undefined && Number(body["stageId"]) !== Number(r.stage_id)) {
    const to = await stageOf(Number(r.funnel_id), Number(body["stageId"]));
    if (to.removed_at) throw bad("That stage was removed.");
    set("stage_id", Number(to.id));
    sets.push("stage_since = now()");
    await cardEvent(id, user, "stage", { from: r.stage, to: to.name });
  }
  if (body["delete"] === true) sets.push("deleted_at = now()");
  if (!sets.length) return cardDetail(user, id);
  sets.push("updated_at = now()");
  await pool.query(`UPDATE os_cards SET ${sets.join(", ")} WHERE id = $1`, vals);
  if (Object.keys(changed).length) await cardEvent(id, user, "edit", changed);
  if (body["delete"] === true) {
    await cardEvent(id, user, "deleted", null);
    return { ok: true, deleted: true };
  }
  return cardDetail(user, id);
}

/** For /meta: the OS's own funnels, for the menu. */
export async function osFunnelsBrief() {
  await ensureFunnelTables();
  const r = await pool.query(`SELECT key, name, color FROM os_funnels WHERE source = 'os' AND archived_at IS NULL ORDER BY sort, id`);
  return r.rows.map((x) => ({ key: String(x.key), name: String(x.name), color: x.color ?? null }));
}
