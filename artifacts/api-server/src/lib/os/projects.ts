/**
 * Unicorn OS — Projects: the owner's Notion boards (goals and tasks), moved in.
 *
 * The format is copied from the two Notion templates the owner worked in
 * ("Любимое дело" = projects, "Tasks: Цели спринта" = tasks), nothing more:
 *   project — name, status (Backlog/Planning · In progress/Paused · Done/Canceled),
 *             owner, priority, dates, summary, notes, completion from its tasks;
 *   task    — title, status (Not started · In progress · Done, Archived),
 *             assignees, due (date or range), priority, estimate, tags,
 *             project, parent task (sub-tasks), summary, notes, comments.
 *
 * Staff (admin, manager) see and edit everything. A broker sees only tasks
 * assigned to them and may change their status, notes and comments — so the
 * owner can hand Amelia or Yudi a project task without giving them the board.
 *
 * These tables are the OS's own. Nothing here touches amoCRM, the Copilot or
 * the site.
 */
import { pool } from "@workspace/db";
import { isStaff, audit, type OsUser } from "./auth";

export const TASK_STATUSES = [
  { name: "Not started", group: "todo" },
  { name: "In progress", group: "doing" },
  { name: "Done", group: "done" },
  { name: "Archived", group: "archived" },
] as const;
export const PROJECT_STATUSES = [
  { name: "Backlog", group: "todo" },
  { name: "Planning", group: "todo" },
  { name: "In progress", group: "doing" },
  { name: "Paused", group: "doing" },
  { name: "Done", group: "done" },
  { name: "Canceled", group: "done" },
] as const;
export const PRIORITIES = ["Low", "Medium", "High", "Extra High"] as const;
export const ESTIMATES = ["XS", "S", "M", "L", "XL"] as const;

const TASK_STATUS_NAMES: string[] = TASK_STATUSES.map((s) => s.name);
const PROJECT_STATUS_NAMES: string[] = PROJECT_STATUSES.map((s) => s.name);

let ready: Promise<void> | null = null;
export function ensureProjectTables(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS os_projects (
          id serial PRIMARY KEY,
          name text NOT NULL,
          status text NOT NULL DEFAULT 'Planning',
          owner_id int,
          priority text,
          start_date date,
          end_date date,
          summary text NOT NULL DEFAULT '',
          notes text NOT NULL DEFAULT '',
          sort double precision NOT NULL DEFAULT 0,
          created_by int,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          deleted_at timestamptz
        );
        CREATE TABLE IF NOT EXISTS os_ptasks (
          id serial PRIMARY KEY,
          project_id int,
          parent_id int,
          title text NOT NULL,
          status text NOT NULL DEFAULT 'Not started',
          assignee_ids int[] NOT NULL DEFAULT '{}',
          due_start date,
          due_end date,
          priority text,
          estimate text,
          tags text[] NOT NULL DEFAULT '{}',
          summary text NOT NULL DEFAULT '',
          notes text NOT NULL DEFAULT '',
          sort double precision NOT NULL DEFAULT 0,
          created_by int,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          done_at timestamptz,
          deleted_at timestamptz
        );
        CREATE INDEX IF NOT EXISTS os_ptasks_project ON os_ptasks (project_id) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS os_ptasks_parent ON os_ptasks (parent_id) WHERE deleted_at IS NULL;
        CREATE TABLE IF NOT EXISTS os_ptask_events (
          id serial PRIMARY KEY,
          task_id int NOT NULL,
          user_id int,
          kind text NOT NULL,
          detail jsonb,
          at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS os_ptask_events_task ON os_ptask_events (task_id, at);
      `);
    })().catch((err) => {
      ready = null;
      throw err;
    });
  }
  return ready;
}

// ── shapes ──────────────────────────────────────────────────────────────────
const day = (v: unknown): string | null => {
  if (!v) return null;
  if (v instanceof Date) {
    // node-postgres turns a DATE into local midnight; keep the calendar day.
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
};
const ts = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

function taskOut(r: Record<string, unknown>) {
  return {
    id: Number(r.id),
    key: `T-${r.id}`,
    projectId: r.project_id == null ? null : Number(r.project_id),
    parentId: r.parent_id == null ? null : Number(r.parent_id),
    title: String(r.title ?? ""),
    status: String(r.status ?? "Not started"),
    assigneeIds: ((r.assignee_ids as number[]) ?? []).map(Number),
    dueStart: day(r.due_start),
    dueEnd: day(r.due_end),
    priority: (r.priority as string) ?? null,
    estimate: (r.estimate as string) ?? null,
    tags: (r.tags as string[]) ?? [],
    summary: String(r.summary ?? ""),
    notes: String(r.notes ?? ""),
    sort: Number(r.sort ?? 0),
    createdBy: r.created_by == null ? null : Number(r.created_by),
    createdAt: ts(r.created_at),
    updatedAt: ts(r.updated_at),
    doneAt: ts(r.done_at),
    subtasks: r.sub_total == null ? undefined : { total: Number(r.sub_total), done: Number(r.sub_done ?? 0) },
    comments: r.comment_count == null ? undefined : Number(r.comment_count),
  };
}
export type ProjectTask = ReturnType<typeof taskOut>;

function projectOut(r: Record<string, unknown>) {
  const total = Number(r.task_total ?? 0);
  const done = Number(r.task_done ?? 0);
  return {
    id: Number(r.id),
    name: String(r.name ?? ""),
    status: String(r.status ?? "Planning"),
    ownerId: r.owner_id == null ? null : Number(r.owner_id),
    priority: (r.priority as string) ?? null,
    startDate: day(r.start_date),
    endDate: day(r.end_date),
    summary: String(r.summary ?? ""),
    notes: String(r.notes ?? ""),
    sort: Number(r.sort ?? 0),
    createdAt: ts(r.created_at),
    updatedAt: ts(r.updated_at),
    tasks: { total, done, open: Number(r.task_open ?? 0), overdue: Number(r.task_overdue ?? 0) },
    completion: total ? Math.round((done / total) * 100) : 0,
  };
}

// ── validation ──────────────────────────────────────────────────────────────
const isoDay = (v: unknown, field: string): string | null => {
  if (v === null || v === "" || v === undefined) return null;
  const s = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw new Error(`${field}: use a date like 2026-10-01.`);
  return s;
};
const pick = <T extends string>(v: unknown, allowed: readonly T[], field: string): T | null => {
  if (v === null || v === "" || v === undefined) return null;
  const s = String(v);
  if (!allowed.includes(s as T)) throw new Error(`${field}: choose one of ${allowed.join(", ")}.`);
  return s as T;
};
const text = (v: unknown, max: number) => String(v ?? "").slice(0, max);
async function userIds(v: unknown): Promise<number[]> {
  const ids = [...new Set((Array.isArray(v) ? v : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return [];
  const { rows } = await pool.query(`SELECT id FROM os_users WHERE id = ANY($1::int[]) AND NOT disabled`, [ids]);
  const ok = new Set(rows.map((r) => Number(r.id)));
  const bad = ids.filter((i) => !ok.has(i));
  if (bad.length) throw new Error("One of the people is not in the team (Settings → Team).");
  return ids;
}
const tagList = (v: unknown): string[] =>
  [...new Set((Array.isArray(v) ? v : String(v ?? "").split(",")).map((t) => String(t).trim()).filter(Boolean))].slice(0, 12).map((t) => t.slice(0, 40));

// ── people (assignees are the OS team) ──────────────────────────────────────
export async function people() {
  const { rows } = await pool.query(`SELECT id, name, login, role FROM os_users WHERE NOT disabled ORDER BY name`);
  return rows.map((r) => ({ id: Number(r.id), name: String(r.name), login: String(r.login), role: String(r.role) }));
}

// ── projects ────────────────────────────────────────────────────────────────
export async function listProjects(user: OsUser, opts: { includeDone?: boolean } = {}) {
  await ensureProjectTables();
  if (!isStaff(user)) return [];
  const { rows } = await pool.query(
    `SELECT p.*,
            count(t.id) FILTER (WHERE t.status <> 'Archived') AS task_total,
            count(t.id) FILTER (WHERE t.status = 'Done') AS task_done,
            count(t.id) FILTER (WHERE t.status IN ('Not started','In progress')) AS task_open,
            count(t.id) FILTER (WHERE t.status IN ('Not started','In progress') AND coalesce(t.due_end, t.due_start) < (now() AT TIME ZONE 'Asia/Makassar')::date) AS task_overdue
       FROM os_projects p
       LEFT JOIN os_ptasks t ON t.project_id = p.id AND t.deleted_at IS NULL AND t.parent_id IS NULL
      WHERE p.deleted_at IS NULL AND ($1::boolean OR p.status NOT IN ('Done','Canceled'))
      GROUP BY p.id
      ORDER BY p.sort, p.id`,
    [opts.includeDone !== false],
  );
  return rows.map(projectOut);
}

export async function createProject(user: OsUser, body: Record<string, unknown>) {
  await ensureProjectTables();
  if (!isStaff(user)) throw new Error("Only managers can create projects.");
  const name = text(body.name, 200).trim();
  if (!name) throw new Error("Give the project a name.");
  const owner = body.ownerId === undefined ? [user.id] : await userIds(body.ownerId ? [body.ownerId] : []);
  const { rows } = await pool.query(
    `INSERT INTO os_projects (name, status, owner_id, priority, start_date, end_date, summary, notes, sort, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, coalesce((SELECT max(sort) FROM os_projects), 0) + 1, $9) RETURNING *`,
    [
      name,
      pick(body.status, PROJECT_STATUS_NAMES, "Status") ?? "Planning",
      owner[0] ?? null,
      pick(body.priority, PRIORITIES, "Priority"),
      isoDay(body.startDate, "Start"),
      isoDay(body.endDate, "End"),
      text(body.summary, 2000),
      text(body.notes, 50_000),
      user.id,
    ],
  );
  await audit(user, "project.create", String(rows[0].id), { name });
  return projectOut(rows[0]);
}

export async function updateProject(user: OsUser, id: number, body: Record<string, unknown>) {
  await ensureProjectTables();
  if (!isStaff(user)) throw new Error("Only managers can change projects.");
  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if ("name" in body) {
    const n = text(body.name, 200).trim();
    if (!n) throw new Error("The project needs a name.");
    set("name", n);
  }
  if ("status" in body) set("status", pick(body.status, PROJECT_STATUS_NAMES, "Status") ?? "Planning");
  if ("ownerId" in body) set("owner_id", (await userIds(body.ownerId ? [body.ownerId] : []))[0] ?? null);
  if ("priority" in body) set("priority", pick(body.priority, PRIORITIES, "Priority"));
  if ("startDate" in body) set("start_date", isoDay(body.startDate, "Start"));
  if ("endDate" in body) set("end_date", isoDay(body.endDate, "End"));
  if ("summary" in body) set("summary", text(body.summary, 2000));
  if ("notes" in body) set("notes", text(body.notes, 50_000));
  if ("sort" in body && Number.isFinite(Number(body.sort))) set("sort", Number(body.sort));
  if (!sets.length) throw new Error("Nothing to change.");
  vals.push(id);
  const { rows } = await pool.query(`UPDATE os_projects SET ${sets.join(", ")}, updated_at = now() WHERE id = $${vals.length} AND deleted_at IS NULL RETURNING *`, vals);
  if (!rows[0]) throw new Error("This project no longer exists.");
  await audit(user, "project.update", String(id), Object.keys(body));
  return projectOut(rows[0]);
}

/** Like Notion: the project goes, its tasks stay without a project. */
export async function deleteProject(user: OsUser, id: number) {
  await ensureProjectTables();
  if (!isStaff(user)) throw new Error("Only managers can delete projects.");
  const { rowCount } = await pool.query(`UPDATE os_projects SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [id]);
  if (!rowCount) throw new Error("This project no longer exists.");
  await pool.query(`UPDATE os_ptasks SET project_id = NULL, updated_at = now() WHERE project_id = $1`, [id]);
  await audit(user, "project.delete", String(id), null);
  return { ok: true };
}

// ── tasks ───────────────────────────────────────────────────────────────────
const TASK_SELECT = `
  SELECT t.*,
         (SELECT count(*) FROM os_ptasks s WHERE s.parent_id = t.id AND s.deleted_at IS NULL AND s.status <> 'Archived') AS sub_total,
         (SELECT count(*) FROM os_ptasks s WHERE s.parent_id = t.id AND s.deleted_at IS NULL AND s.status = 'Done') AS sub_done,
         (SELECT count(*) FROM os_ptask_events e WHERE e.task_id = t.id AND e.kind = 'comment') AS comment_count
    FROM os_ptasks t`;

export async function listTasks(user: OsUser, opts: { projectId?: string; assignee?: string; archived?: boolean; parentId?: number } = {}) {
  await ensureProjectTables();
  const where = ["t.deleted_at IS NULL"];
  const vals: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    vals.push(v);
    where.push(sql.replace("$?", `$${vals.length}`));
  };
  if (!isStaff(user)) add("$? = ANY(t.assignee_ids)", user.id);
  if (opts.projectId === "none") where.push("t.project_id IS NULL");
  else if (opts.projectId) add("t.project_id = $?", Number(opts.projectId));
  if (opts.assignee === "me") add("$? = ANY(t.assignee_ids)", user.id);
  else if (opts.assignee === "none") where.push("cardinality(t.assignee_ids) = 0");
  else if (opts.assignee) add("$? = ANY(t.assignee_ids)", Number(opts.assignee));
  if (opts.parentId) add("t.parent_id = $?", opts.parentId);
  if (!opts.archived) where.push("t.status <> 'Archived'");
  const { rows } = await pool.query(`${TASK_SELECT} WHERE ${where.join(" AND ")} ORDER BY t.sort, t.id LIMIT 3000`, vals);
  return rows.map(taskOut);
}

async function loadTask(id: number) {
  const { rows } = await pool.query(`${TASK_SELECT} WHERE t.id = $1 AND t.deleted_at IS NULL`, [id]);
  return rows[0] ? taskOut(rows[0]) : null;
}
function canSee(user: OsUser, t: ProjectTask) {
  return isStaff(user) || t.assigneeIds.includes(user.id);
}

export async function taskDetail(user: OsUser, id: number) {
  await ensureProjectTables();
  const t = await loadTask(id);
  if (!t || !canSee(user, t)) throw new Error("This task no longer exists, or it is not assigned to you.");
  const [subtasks, events, parent, project] = await Promise.all([
    listTasks(user, { parentId: id, archived: true }),
    pool.query(`SELECT e.*, u.name AS user_name FROM os_ptask_events e LEFT JOIN os_users u ON u.id = e.user_id WHERE e.task_id = $1 ORDER BY e.at`, [id]),
    t.parentId ? loadTask(t.parentId) : Promise.resolve(null),
    t.projectId ? pool.query(`SELECT id, name, status FROM os_projects WHERE id = $1 AND deleted_at IS NULL`, [t.projectId]) : Promise.resolve(null),
  ]);
  return {
    task: t,
    subtasks,
    parent: parent && canSee(user, parent) ? { id: parent.id, key: parent.key, title: parent.title } : null,
    project: project?.rows[0] ? { id: Number(project.rows[0].id), name: String(project.rows[0].name), status: String(project.rows[0].status) } : null,
    events: events.rows.map((e) => ({ id: Number(e.id), kind: String(e.kind), userId: e.user_id == null ? null : Number(e.user_id), userName: (e.user_name as string) ?? null, detail: e.detail ?? null, at: ts(e.at) })),
  };
}

async function logEvent(taskId: number, user: OsUser, kind: string, detail: unknown) {
  await pool.query(`INSERT INTO os_ptask_events (task_id, user_id, kind, detail) VALUES ($1, $2, $3, $4)`, [taskId, user.id, kind, detail == null ? null : JSON.stringify(detail)]);
}

export async function createTask(user: OsUser, body: Record<string, unknown>) {
  await ensureProjectTables();
  if (!isStaff(user)) throw new Error("Only managers can create project tasks.");
  const title = text(body.title, 500).trim();
  if (!title) throw new Error("Write what needs to be done.");
  const projectId = body.projectId ? Number(body.projectId) : null;
  if (projectId) {
    const { rows } = await pool.query(`SELECT 1 FROM os_projects WHERE id = $1 AND deleted_at IS NULL`, [projectId]);
    if (!rows[0]) throw new Error("That project no longer exists.");
  }
  const parentId = body.parentId ? Number(body.parentId) : null;
  let inheritedProject = projectId;
  if (parentId) {
    const p = await loadTask(parentId);
    if (!p) throw new Error("The parent task no longer exists.");
    inheritedProject = projectId ?? p.projectId;
  }
  const assignees = body.assigneeIds === undefined ? [] : await userIds(body.assigneeIds);
  const status = pick(body.status, TASK_STATUS_NAMES, "Status") ?? "Not started";
  const dueStart = isoDay(body.dueStart, "Due");
  const dueEnd = isoDay(body.dueEnd, "Due end");
  if (dueEnd && !dueStart) throw new Error("Set the start of the due range first.");
  if (dueStart && dueEnd && dueEnd < dueStart) throw new Error("The due range ends before it starts.");
  const sort = Number.isFinite(Number(body.sort)) && body.sort !== null && body.sort !== undefined ? Number(body.sort) : null;
  const { rows } = await pool.query(
    `INSERT INTO os_ptasks (project_id, parent_id, title, status, assignee_ids, due_start, due_end, priority, estimate, tags, summary, notes, sort, created_by, done_at)
     VALUES ($1, $2, $3, $4, $5::int[], $6, $7, $8, $9, $10::text[], $11, $12,
             coalesce($13, (SELECT coalesce(max(sort), 0) + 1 FROM os_ptasks WHERE status = $4)), $14, CASE WHEN $4 = 'Done' THEN now() END)
     RETURNING id`,
    [
      inheritedProject,
      parentId,
      title,
      status,
      assignees,
      dueStart,
      dueEnd,
      pick(body.priority, PRIORITIES, "Priority"),
      pick(body.estimate, ESTIMATES, "Estimate"),
      tagList(body.tags),
      text(body.summary, 2000),
      text(body.notes, 50_000),
      sort,
      user.id,
    ],
  );
  const id = Number(rows[0].id);
  await logEvent(id, user, "created", { assignees });
  return (await loadTask(id))!;
}

const BROKER_FIELDS = new Set(["status", "notes"]);

export async function updateTask(user: OsUser, id: number, body: Record<string, unknown>) {
  await ensureProjectTables();
  const before = await loadTask(id);
  if (!before || !canSee(user, before)) throw new Error("This task no longer exists, or it is not assigned to you.");
  if (!isStaff(user)) {
    const extra = Object.keys(body).filter((k) => !BROKER_FIELDS.has(k));
    if (extra.length) throw new Error("You can change the status and notes of your tasks. Ask a manager for the rest.");
  }
  const sets: string[] = [];
  const vals: unknown[] = [];
  const changes: Record<string, unknown> = {};
  const set = (col: string, v: unknown, cast = "") => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}${cast}`);
  };
  if ("title" in body) {
    const t = text(body.title, 500).trim();
    if (!t) throw new Error("The task needs a title.");
    set("title", t);
  }
  if ("status" in body) {
    const st = pick(body.status, TASK_STATUS_NAMES, "Status") ?? "Not started";
    set("status", st);
    if (st !== before.status) {
      changes.status = { from: before.status, to: st };
      sets.push(st === "Done" ? "done_at = now()" : "done_at = NULL");
    }
  }
  if ("assigneeIds" in body) {
    const ids = await userIds(body.assigneeIds);
    set("assignee_ids", ids, "::int[]");
    const added = ids.filter((i) => !before.assigneeIds.includes(i));
    const removed = before.assigneeIds.filter((i) => !ids.includes(i));
    if (added.length || removed.length) changes.assignees = { added, removed };
  }
  if ("dueStart" in body || "dueEnd" in body) {
    const ds = "dueStart" in body ? isoDay(body.dueStart, "Due") : before.dueStart;
    let de = "dueEnd" in body ? isoDay(body.dueEnd, "Due end") : before.dueEnd;
    if (!ds) de = null;
    if (ds && de && de < ds) throw new Error("The due range ends before it starts.");
    set("due_start", ds);
    set("due_end", de);
    if (ds !== before.dueStart || de !== before.dueEnd) changes.due = { from: [before.dueStart, before.dueEnd], to: [ds, de] };
  }
  if ("priority" in body) set("priority", pick(body.priority, PRIORITIES, "Priority"));
  if ("estimate" in body) set("estimate", pick(body.estimate, ESTIMATES, "Estimate"));
  if ("tags" in body) set("tags", tagList(body.tags), "::text[]");
  if ("summary" in body) set("summary", text(body.summary, 2000));
  if ("notes" in body) set("notes", text(body.notes, 50_000));
  if ("sort" in body && Number.isFinite(Number(body.sort))) set("sort", Number(body.sort));
  if ("projectId" in body) {
    const pid = body.projectId ? Number(body.projectId) : null;
    if (pid) {
      const { rows } = await pool.query(`SELECT 1 FROM os_projects WHERE id = $1 AND deleted_at IS NULL`, [pid]);
      if (!rows[0]) throw new Error("That project no longer exists.");
    }
    set("project_id", pid);
    if (pid !== before.projectId) changes.project = { from: before.projectId, to: pid };
  }
  if ("parentId" in body) {
    const pid = body.parentId ? Number(body.parentId) : null;
    if (pid === id) throw new Error("A task cannot be its own sub-task.");
    if (pid) {
      // No loops: the new parent must not sit under this task.
      const { rows } = await pool.query(
        `WITH RECURSIVE up AS (SELECT id, parent_id FROM os_ptasks WHERE id = $1 UNION ALL SELECT t.id, t.parent_id FROM os_ptasks t JOIN up ON t.id = up.parent_id) SELECT 1 FROM up WHERE id = $2`,
        [pid, id],
      );
      if (rows[0]) throw new Error("That would put the task inside its own sub-task.");
    }
    set("parent_id", pid);
  }
  if (!sets.length) throw new Error("Nothing to change.");
  vals.push(id);
  await pool.query(`UPDATE os_ptasks SET ${sets.join(", ")}, updated_at = now() WHERE id = $${vals.length}`, vals);
  if (Object.keys(changes).length) await logEvent(id, user, "changed", changes);
  return (await loadTask(id))!;
}

/** Deleting takes its sub-tasks along; restore brings the same set back. */
export async function deleteTask(user: OsUser, id: number) {
  await ensureProjectTables();
  if (!isStaff(user)) throw new Error("Only managers can delete tasks.");
  const { rows } = await pool.query(
    `WITH RECURSIVE down AS (SELECT id FROM os_ptasks WHERE id = $1 AND deleted_at IS NULL
                              UNION ALL SELECT t.id FROM os_ptasks t JOIN down ON t.parent_id = down.id WHERE t.deleted_at IS NULL)
     UPDATE os_ptasks SET deleted_at = now() WHERE id IN (SELECT id FROM down) RETURNING id, deleted_at`,
    [id],
  );
  if (!rows.length) throw new Error("This task no longer exists.");
  await audit(user, "ptask.delete", String(id), { count: rows.length });
  return { ok: true, count: rows.length };
}
export async function restoreTask(user: OsUser, id: number) {
  await ensureProjectTables();
  if (!isStaff(user)) throw new Error("Only managers can restore tasks.");
  // Compared inside SQL: a JS Date drops the microseconds and would match nothing.
  const { rowCount } = await pool.query(
    `UPDATE os_ptasks SET deleted_at = NULL WHERE deleted_at = (SELECT deleted_at FROM os_ptasks WHERE id = $1 AND deleted_at IS NOT NULL)`,
    [id],
  );
  if (!rowCount) throw new Error("Nothing to restore.");
  await audit(user, "ptask.restore", String(id), null);
  const t = await loadTask(id);
  if (!t) throw new Error("Restored, but the task could not be read back.");
  return t;
}

export async function addComment(user: OsUser, id: number, body: Record<string, unknown>) {
  await ensureProjectTables();
  const t = await loadTask(id);
  if (!t || !canSee(user, t)) throw new Error("This task no longer exists, or it is not assigned to you.");
  const txt = text(body.text, 5000).trim();
  if (!txt) throw new Error("Write the comment first.");
  await logEvent(id, user, "comment", { text: txt });
  await pool.query(`UPDATE os_ptasks SET updated_at = now() WHERE id = $1`, [id]);
  return taskDetail(user, id);
}

/**
 * For the bell and My day: tasks of mine that are due or late, tasks someone
 * else just gave me, and comments others left on my tasks.
 */
export async function projectNotifications(user: OsUser) {
  await ensureProjectTables();
  const out: Array<{ id: string; kind: string; title: string; body: string; at: string; leadId: null; ptaskId: number; severity: "info" | "warn" | "bad" }> = [];
  const due = await pool.query(
    `SELECT id, title, due_start, due_end, updated_at FROM os_ptasks
      WHERE deleted_at IS NULL AND status IN ('Not started','In progress') AND $1 = ANY(assignee_ids)
        AND coalesce(due_end, due_start) <= (now() AT TIME ZONE 'Asia/Makassar')::date
      ORDER BY coalesce(due_end, due_start) LIMIT 30`,
    [user.id],
  );
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  for (const r of due.rows) {
    const d = day(r.due_end ?? r.due_start)!;
    out.push({ id: `pt-due:${r.id}:${d}`, kind: "ptask", title: d < today ? "Project task overdue" : "Project task due today", body: String(r.title), at: new Date(`${d}T01:00:00Z`).toISOString(), leadId: null, ptaskId: Number(r.id), severity: d < today ? "bad" : "warn" });
  }
  const ev = await pool.query(
    `SELECT e.id, e.task_id, e.kind, e.detail, e.at, u.name AS by_name, t.title
       FROM os_ptask_events e JOIN os_ptasks t ON t.id = e.task_id LEFT JOIN os_users u ON u.id = e.user_id
      WHERE e.at > now() - interval '7 days' AND t.deleted_at IS NULL AND coalesce(e.user_id, 0) <> $1 AND $1 = ANY(t.assignee_ids)
        AND (e.kind = 'comment'
             OR (e.kind = 'created' AND e.detail->'assignees' @> to_jsonb($1::int))
             OR (e.kind = 'changed' AND e.detail->'assignees'->'added' @> to_jsonb($1::int)))
      ORDER BY e.at DESC LIMIT 30`,
    [user.id],
  );
  for (const r of ev.rows) {
    const by = (r.by_name as string) ?? "Someone";
    const d = r.detail as { text?: string } | null;
    out.push({
      id: `pt-ev:${r.id}`,
      kind: "ptask",
      title: r.kind === "comment" ? `${by} commented` : `${by} gave you a task`,
      body: r.kind === "comment" ? `${r.title}: ${String(d?.text ?? "").slice(0, 140)}` : String(r.title),
      at: ts(r.at)!,
      leadId: null,
      ptaskId: Number(r.task_id),
      severity: "info",
    });
  }
  return out;
}

/**
 * One-time move of the live rows from the owner's Notion ("Задачи с ботами",
 * 16.07.2026). Runs once: the seed is keyed in broker_settings.
 */
export async function seedFromNotion() {
  await ensureProjectTables();
  const key = "os_projects_seed_v1";
  // Once only: skipped when the marker is set or any project ever existed.
  const { rows: done } = await pool
    .query(`SELECT 1 FROM broker_settings WHERE key = $1 UNION ALL SELECT 1 FROM os_projects LIMIT 1`, [key])
    .catch(() => ({ rows: [{}] }));
  if (done[0]) return;
  const { rows: admin } = await pool.query(`SELECT id FROM os_users WHERE login = 'nikita'`);
  const owner = admin[0] ? Number(admin[0].id) : null;
  const mk = async (name: string, summary: string, sort: number) =>
    Number((await pool.query(`INSERT INTO os_projects (name, status, owner_id, priority, summary, sort, created_by) VALUES ($1, 'In progress', $2, 'High', $3, $4, $2) RETURNING id`, [name, owner, summary, sort])).rows[0].id);
  const bali = await mk("Bali rentals", "Long-term villa rentals: clients (Amelia) and villa owners (Yudi).", 1);
  const dubai = await mk("Dubai realtors", "Outreach to Dubai real-estate agents.", 2);
  const task = async (projectId: number, title: string, notes: string, sort: number) =>
    pool.query(
      `INSERT INTO os_ptasks (project_id, title, status, assignee_ids, notes, sort, created_by, created_at) VALUES ($1, $2, 'In progress', $3::int[], $4, $5, $6, '2026-07-16')`,
      [projectId, title, owner ? [owner] : [], notes, sort, owner],
    );
  await task(
    bali,
    "Publish Villa 5 in Bali Facebook groups",
    "Next step (from Notion, 16.07.2026): waiting for moderators in 3 groups (Seminyak canggu kerobokan community, CANGGU COMMUNITY, Canggu Community-Bali). If it takes long, write to the admins. Also waiting for Nikita's decision on the open Facebook Marketplace.",
    1,
  );
  await task(
    dubai,
    "Rank the Dubai realtors base + WhatsApp outreach",
    "Next step (from Notion, 16.07.2026): the WhatsApp template is ready and waiting for Meta moderation. The agent could read only ~355 of several thousand rows from Google Sheets. Nikita to send the .xlsx (or connect the folder) so the base can be ranked A/B/C.",
    2,
  );
  await pool.query(`INSERT INTO broker_settings (key, value, updated_at) VALUES ($1, 'done', now()) ON CONFLICT (key) DO NOTHING`, [key]).catch(() => undefined);
}
