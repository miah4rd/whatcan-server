/**
 * Unicorn OS — Playbooks: the funnels' regulations and what the Copilot has learned (owner, 26.09).
 *
 * One source, as in Cowork: the files in skills/ of this repository. The OS reads the very file the
 * code obeys and the law gate guards (scripts/law-gate.sh); it keeps no copy. What the OS adds:
 *   · the history of each file, from git;
 *   · proposals: anyone may propose a change (a person here, a Claude session, later the bot);
 *     only the owner approves or rejects. An approval is recorded here with his name, the time and
 *     the exact text. The server cannot write to GitHub, so a Claude session applies an approved
 *     proposal to the file (and the code) in a commit that says "Approved by owner <date> — OS
 *     proposal #N"; the proposal then shows as applied, with that commit.
 *   · the lessons the Copilot draws from brokers' edits (broker_corrections), by situation.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pool } from "@workspace/db";
import { audit, type OsUser } from "./auth";

const run = promisify(execFile);

/** The repository root: the folder holding skills/ and .git, found upwards from where the server runs. */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "skills")) && fs.existsSync(path.join(dir, ".git"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error("The skills folder was not found next to the server.");
}
const skillsDir = () => path.join(repoRoot(), "skills");

/** A playbook file name, never a path: "rental-listings.md". */
function fileName(raw: unknown): string {
  const f = String(raw ?? "").trim();
  if (!/^[a-z0-9-]+\.md$/.test(f)) throw new Error("Unknown playbook.");
  return f;
}

async function git(args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", args, { cwd: repoRoot(), timeout: 10_000, maxBuffer: 4 << 20 });
    return stdout;
  } catch {
    return "";
  }
}

let ready: Promise<void> | null = null;
function ensureTables(): Promise<void> {
  if (!ready) {
    ready = pool
      .query(
        `CREATE TABLE IF NOT EXISTS os_playbook_proposals (
           id serial PRIMARY KEY,
           file text NOT NULL,
           section text NOT NULL DEFAULT '',
           proposed_text text NOT NULL,
           reason text NOT NULL DEFAULT '',
           source text NOT NULL DEFAULT 'person',
           proposed_by int,
           proposed_by_name text,
           status text NOT NULL DEFAULT 'pending',
           decided_by int,
           decided_by_name text,
           decided_at timestamptz,
           decision_note text NOT NULL DEFAULT '',
           applied_commit text,
           applied_at timestamptz,
           created_at timestamptz NOT NULL DEFAULT now()
         )`,
      )
      .then(() => undefined)
      .catch((err) => {
        ready = null;
        throw err;
      });
  }
  return ready;
}

const titleOf = (md: string, file: string) => (md.match(/^#\s+(.+)$/m)?.[1] ?? file.replace(/\.md$/, "")).trim();
const approvedOf = (md: string) => md.match(/^Approved by the owner:\s*(.+)$/im)?.[1]?.trim() ?? null;

/** Every regulation in skills/, with its last change, and how many proposals wait on it. */
export async function listPlaybooks() {
  await ensureTables();
  const dir = skillsDir();
  const files = fs.readdirSync(dir).filter((f) => /^[a-z0-9-]+\.md$/.test(f)).sort();
  const pending = await pool.query(`SELECT file, count(*)::int AS n FROM os_playbook_proposals WHERE status = 'pending' GROUP BY 1`);
  const waiting = new Map(pending.rows.map((r) => [String(r.file), Number(r.n)]));
  const items = [];
  for (const f of files) {
    const md = fs.readFileSync(path.join(dir, f), "utf8");
    const last = (await git(["log", "-1", "--format=%h|%aI|%s", "--", `skills/${f}`])).trim().split("|");
    items.push({
      file: f,
      title: titleOf(md, f),
      approved: approvedOf(md),
      openQuestions: (md.match(/\[no decision\]|\[нет решения\]/gi) ?? []).length,
      lastChange: last[0] ? { commit: last[0], at: last[1], subject: last.slice(2).join("|") } : null,
      pendingProposals: waiting.get(f) ?? 0,
    });
  }
  // Proposals may name a regulation not written yet (e.g. rental.md): it shows as a missing file.
  for (const [f, n] of waiting) if (!files.includes(f)) items.push({ file: f, title: f.replace(/\.md$/, ""), approved: null, openQuestions: 0, lastChange: null, pendingProposals: n, missing: true });
  return { items };
}

/** One regulation: the text as the code obeys it now, and its versions from git. */
export async function readPlaybook(raw: unknown) {
  const f = fileName(raw);
  const p = path.join(skillsDir(), f);
  const exists = fs.existsSync(p);
  const md = exists ? fs.readFileSync(p, "utf8") : "";
  const log = await git(["log", "-20", "--format=%h|%aI|%an|%s", "--", `skills/${f}`]);
  const versions = log
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [commit, at, author, ...rest] = l.split("|");
      return { commit, at, author, subject: rest.join("|") };
    });
  return { file: f, exists, title: exists ? titleOf(md, f) : f, approved: approvedOf(md), text: md, versions };
}

/** A past version of a regulation, as it was at that commit. */
export async function playbookVersion(raw: unknown, commitRaw: unknown) {
  const f = fileName(raw);
  const commit = String(commitRaw ?? "");
  if (!/^[0-9a-f]{6,40}$/.test(commit)) throw new Error("Unknown version.");
  return { file: f, commit, text: await git(["show", `${commit}:skills/${f}`]) };
}

// ── proposals ────────────────────────────────────────────────────────────────

const clean = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);

export async function propose(user: OsUser, body: Record<string, unknown>) {
  await ensureTables();
  const f = fileName(body["file"]);
  const text = clean(body["text"], 6000);
  if (text.length < 10) throw new Error("Write the change in words: what the bot should do.");
  const r = await pool.query(
    `INSERT INTO os_playbook_proposals (file, section, proposed_text, reason, source, proposed_by, proposed_by_name) VALUES ($1,$2,$3,$4,'person',$5,$6) RETURNING id`,
    [f, clean(body["section"], 200), text, clean(body["reason"], 2000), user.id, user.name],
  );
  await audit(user, "playbook.propose", f, { id: r.rows[0].id, section: clean(body["section"], 200) });
  return { ok: true, id: Number(r.rows[0].id) };
}

/**
 * The proposals, newest first. An approved one counts as applied once a commit in the repository
 * names it ("OS proposal #N"): the file, and so the code's law, carries it from then on.
 */
export async function listProposals(filter: { status?: string; file?: string }) {
  await ensureTables();
  const approved = await pool.query(`SELECT id FROM os_playbook_proposals WHERE status = 'approved' AND applied_commit IS NULL`);
  for (const row of approved.rows) {
    const hit = (await git(["log", "-1", "--format=%h|%aI", "--grep", `OS proposal #${row.id}\\b`, "-E"])).trim();
    if (hit) {
      const [commit, at] = hit.split("|");
      await pool.query(`UPDATE os_playbook_proposals SET status = 'applied', applied_commit = $2, applied_at = $3 WHERE id = $1`, [row.id, commit, at]);
    }
  }
  const where: string[] = [];
  const vals: unknown[] = [];
  if (filter.status) {
    vals.push(filter.status);
    where.push(`status = $${vals.length}`);
  }
  if (filter.file) {
    vals.push(fileName(filter.file));
    where.push(`file = $${vals.length}`);
  }
  const r = await pool.query(`SELECT * FROM os_playbook_proposals ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY (status = 'pending') DESC, created_at DESC LIMIT 200`, vals);
  return {
    items: r.rows.map((x) => ({
      id: Number(x.id),
      file: String(x.file),
      section: String(x.section ?? ""),
      text: String(x.proposed_text),
      reason: String(x.reason ?? ""),
      source: String(x.source),
      by: x.proposed_by_name ?? null,
      at: x.created_at,
      status: String(x.status),
      decidedBy: x.decided_by_name ?? null,
      decidedAt: x.decided_at,
      note: String(x.decision_note ?? ""),
      appliedCommit: x.applied_commit ?? null,
      appliedAt: x.applied_at,
    })),
  };
}

/** The owner's decision. Only the owner (admin) decides; the route checks the role. */
export async function decide(user: OsUser, id: number, body: Record<string, unknown>) {
  await ensureTables();
  const action = String(body["action"] ?? "");
  if (!["approve", "reject"].includes(action)) throw new Error("approve or reject");
  const r = await pool.query(`SELECT status FROM os_playbook_proposals WHERE id = $1`, [id]);
  if (!r.rows[0]) throw new Error("No such proposal.");
  if (r.rows[0].status !== "pending") throw new Error("This proposal was already decided.");
  await pool.query(
    `UPDATE os_playbook_proposals SET status = $2, decided_by = $3, decided_by_name = $4, decided_at = now(), decision_note = $5 WHERE id = $1`,
    [id, action === "approve" ? "approved" : "rejected", user.id, user.name, clean(body["note"], 2000)],
  );
  await audit(user, `playbook.${action}`, String(id), { note: clean(body["note"], 2000) || undefined });
  return { ok: true };
}

// ── what the Copilot has learned ─────────────────────────────────────────────

/**
 * The live lessons from brokers' edits, by situation (lib/broker-corrections.ts), with how often
 * the drafts of the last 14 days went out as written: the measure of a situation's readiness.
 */
export async function lessons() {
  const [rows, drafts] = await Promise.all([
    pool.query(
      `SELECT id, broker_id, coalesce(situation, 'style') AS situation, instruction, created_at
         FROM broker_corrections WHERE superseded_at IS NULL ORDER BY created_at DESC LIMIT 600`,
    ),
    pool.query(
      `SELECT count(*) FILTER (WHERE status = 'approved' AND NOT coalesce(auto_sent,false))::int AS as_written,
              count(*) FILTER (WHERE status = 'edited')::int AS edited,
              count(*) FILTER (WHERE status = 'skipped')::int AS skipped
         FROM pending_suggestions WHERE created_at > now() - interval '14 days'`,
    ),
  ]);
  const by = new Map<string, Array<Record<string, unknown>>>();
  for (const r of rows.rows) {
    const k = String(r.situation);
    by.set(k, [...(by.get(k) ?? []), { id: Number(r.id), broker: r.broker_id, text: String(r.instruction), at: r.created_at }]);
  }
  const d = drafts.rows[0] ?? { as_written: 0, edited: 0, skipped: 0 };
  const decided = Number(d.as_written) + Number(d.edited) + Number(d.skipped);
  return {
    total: rows.rows.length,
    asWritten14d: decided ? Math.round((Number(d.as_written) / decided) * 100) : null,
    decided14d: decided,
    situations: [...by.entries()].map(([situation, items]) => ({ situation, count: items.length, items })).sort((a, b) => b.count - a.count),
  };
}
