/**
 * Unicorn OS — Playbooks: the funnels' regulations and what the Copilot has learned (owner, 26.09).
 *
 * One source, as in Cowork: the files in skills/ of this repository, read from GitHub's master
 * (fetched every two minutes), not from the server's checkout, which moves only on a deploy (owner,
 * 26.09: "no regulation may exist without showing here"). skills/README.md is the pool: the list of
 * every regulation and where it lives (skills/, a section of CLAUDE.md, or a Cowork skill kept in the
 * owner's Claude account, which the server cannot read). The OS keeps no copy. What it adds:
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

/** The repository root: the folder holding .git, found upwards from where the server runs. */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error("The repository was not found next to the server.");
}

/**
 * A regulation's id: "rental-listings.md" (a file in skills/), "CLAUDE.md#The viewing report"
 * (a section of CLAUDE.md), or "cowork:listing-upload-regulation" (a skill kept in Cowork).
 */
function fileName(raw: unknown): string {
  const f = String(raw ?? "").trim();
  if (/^[a-z0-9-]+\.md$/.test(f) || /^CLAUDE\.md#[\w .,:'’()/-]{3,120}$/.test(f) || /^cowork:[a-z0-9-]{2,80}$/.test(f)) return f;
  throw new Error("Unknown playbook.");
}

async function git(args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", args, { cwd: repoRoot(), timeout: 10_000, maxBuffer: 4 << 20 });
    return stdout;
  } catch {
    return "";
  }
}

/** The remote the server's checkout follows (deploy.sh merges github/master). */
const REF = "github/master";
let fetchedAt = 0;
let fetching: Promise<void> | null = null;
/** Bring GitHub's master in at most every two minutes; a failed fetch leaves the last one. */
async function fresh(): Promise<void> {
  if (Date.now() - fetchedAt < 120_000) return;
  if (!fetching)
    fetching = (async () => {
      await git(["fetch", "-q", "github", "master"]);
      fetchedAt = Date.now();
    })().finally(() => {
      fetching = null;
    });
  return fetching;
}
async function readAt(p: string): Promise<string | null> {
  const out = await git(["show", `${REF}:${p}`]);
  return out === "" ? null : out;
}
/** A CLAUDE.md section: from the heading whose words start with `words` to the next heading of its level or higher. */
async function claudeSection(words: string): Promise<{ heading: string; text: string } | null> {
  const md = (await readAt("CLAUDE.md")) ?? "";
  const lines = md.split("\n");
  const want = words.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean).slice(0, 4).join(" ");
  const i = lines.findIndex((l) => /^#{2,4}\s/.test(l) && l.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").includes(want));
  if (i < 0) return null;
  const level = lines[i].match(/^#+/)![0].length;
  let j = i + 1;
  while (j < lines.length && !(new RegExp(`^#{1,${level}}\\s`).test(lines[j]))) j++;
  return { heading: lines[i].replace(/^#+\s*/, ""), text: lines.slice(i, j).join("\n") };
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

/** Every regulation: the pool (skills/README.md) first, then each regulation it names, as GitHub has them now. */
export async function listPlaybooks() {
  await ensureTables();
  await fresh();
  const pending = await pool.query(`SELECT file, count(*)::int AS n FROM os_playbook_proposals WHERE status = 'pending' GROUP BY 1`);
  const waiting = new Map(pending.rows.map((r) => [String(r.file), Number(r.n)]));
  const files = (await git(["ls-tree", "--name-only", REF, "skills/"])).split("\n").map((x) => x.replace(/^skills\//, "")).filter((f) => /^[a-z0-9-]+\.md$/i.test(f));
  const lastOf = async (p: string) => {
    const l = (await git(["log", "-1", "--format=%h|%aI|%s", REF, "--", p])).trim().split("|");
    return l[0] ? { commit: l[0], at: l[1], subject: l.slice(2).join("|") } : null;
  };
  const items: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const readme = await readAt("skills/README.md");
  if (readme) {
    items.push({ file: "README.md", kind: "pool", title: "The pool — every regulation and where it lives", approved: null, lastChange: await lastOf("skills/README.md"), pendingProposals: waiting.get("README.md") ?? 0 });
    seen.add("README.md");
    // Each row of the pool's table: the regulation, where it lives, its status.
    for (const row of readme.split("\n").filter((l) => /^\|/.test(l) && !/^\|[\s:|-]+\|?$/.test(l)).slice(1)) {
      const [what, where, status] = row.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      for (const m of where.matchAll(/`skills\/([a-z0-9-]+\.md)`/gi)) {
        if (seen.has(m[1])) continue;
        seen.add(m[1]);
        const md = await readAt(`skills/${m[1]}`);
        items.push({ file: m[1], kind: "bot", title: md ? titleOf(md, m[1]) : what, pool: what, status, approved: md ? approvedOf(md) : null, missing: !md, openQuestions: md ? (md.match(/\[no decision\]|\[нет решения\]/gi) ?? []).length : 0, lastChange: md ? await lastOf(`skills/${m[1]}`) : null, pendingProposals: waiting.get(m[1]) ?? 0 });
      }
      for (const m of where.matchAll(/CLAUDE\.md\s+"([^"]+)"/g)) {
        const id = `CLAUDE.md#${m[1].replace(/…$/, "").trim()}`;
        if (seen.has(id)) continue;
        seen.add(id);
        items.push({ file: id, kind: "claude-md", title: what, pool: what, status, approved: null, pendingProposals: waiting.get(id) ?? 0 });
      }
      if (/cowork|skill `/i.test(where))
        for (const m of where.matchAll(/`([a-z0-9-]+)`/g)) {
          if (m[1].includes("/") || seen.has(`cowork:${m[1]}`)) continue;
          seen.add(`cowork:${m[1]}`);
          items.push({ file: `cowork:${m[1]}`, kind: "cowork", title: m[1], pool: what, status, approved: null, pendingProposals: waiting.get(`cowork:${m[1]}`) ?? 0 });
        }
    }
  }
  // A file in skills/ the pool does not list yet still shows: nothing is hidden.
  for (const f of files) {
    if (seen.has(f)) continue;
    seen.add(f);
    const md = (await readAt(`skills/${f}`)) ?? "";
    items.push({ file: f, kind: "bot", title: titleOf(md, f), approved: approvedOf(md), openQuestions: (md.match(/\[no decision\]|\[нет решения\]/gi) ?? []).length, lastChange: await lastOf(`skills/${f}`), pendingProposals: waiting.get(f) ?? 0, notInPool: true });
  }
  // Every skill of the owner's Cowork, from the mirror the owner's Mac keeps in cowork-skills/ (26.09).
  try {
    const idx = JSON.parse((await readAt("cowork-skills/index.json")) ?? "{}") as { skills?: Array<{ name: string; description?: string; updatedAt?: string }> };
    for (const k of idx.skills ?? []) {
      const id = `cowork:${k.name}`;
      const known = items.find((x) => x["file"] === id);
      const at = k.updatedAt ? k.updatedAt.slice(0, 10) : null;
      if (known) Object.assign(known, { updatedAt: at, mirrored: true });
      else {
        seen.add(id);
        items.push({ file: id, kind: "cowork", title: k.name, pool: null, status: null, approved: null, updatedAt: at, mirrored: true, pendingProposals: waiting.get(id) ?? 0 });
      }
    }
  } catch {
    /* no mirror yet */
  }
  for (const [f, n] of waiting) if (!seen.has(f)) items.push({ file: f, kind: "bot", title: f.replace(/\.md$/, ""), missing: true, pendingProposals: n });
  return { items, source: `GitHub ${REF}`, checkedAt: fetchedAt ? new Date(fetchedAt).toISOString() : null };
}

/** One regulation as GitHub has it now, and its versions. */
export async function readPlaybook(raw: unknown) {
  const f = fileName(raw);
  await fresh();
  if (f.startsWith("cowork:")) {
    const name = f.slice(7);
    const text = await readAt(`cowork-skills/${name}/SKILL.md`);
    const meta = ((JSON.parse((await readAt("cowork-skills/index.json")) ?? "{}").skills ?? []) as Array<{ name: string; updatedAt?: string }>).find((x) => x.name === name);
    return {
      file: f,
      kind: "cowork",
      exists: text != null,
      title: name,
      approved: null,
      // The mirror's front matter (name, description) is shown as the text's own first lines.
      text: (text ?? "").replace(/^---\n[\s\S]*?\n---\n/, ""),
      versions: [],
      note: text != null
        ? `A Cowork skill, kept in the owner's Claude account and edited there${meta?.updatedAt ? ` (last change ${meta.updatedAt.slice(0, 10)})` : ""}. Shown here read-only; the owner's Mac mirrors it every 10 minutes.`
        : `A Cowork skill (${name}) that is not in the mirror: it may be named differently in Cowork, or not be a Cowork skill.`,
    };
  }
  if (f.startsWith("CLAUDE.md#")) {
    const sec = await claudeSection(f.slice(10));
    return { file: f, kind: "claude-md", exists: !!sec, title: sec?.heading ?? f.slice(10), approved: null, text: sec?.text ?? "", versions: [], note: "A section of CLAUDE.md, the notes every Claude session reads." };
  }
  const p = `skills/${f}`;
  const md = await readAt(p);
  const log = await git(["log", "-20", "--format=%h|%aI|%an|%s", REF, "--", p]);
  const versions = log
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [commit, at, author, ...rest] = l.split("|");
      return { commit, at, author, subject: rest.join("|") };
    });
  return { file: f, kind: f === "README.md" ? "pool" : "bot", exists: md != null, title: md ? titleOf(md, f) : f, approved: md ? approvedOf(md) : null, text: md ?? "", versions };
}

/** A past version of a regulation, as it was at that commit. */
export async function playbookVersion(raw: unknown, commitRaw: unknown) {
  const f = fileName(raw);
  const commit = String(commitRaw ?? "");
  if (!/^[0-9a-f]{6,40}$/.test(commit)) throw new Error("Unknown version.");
  if (!/^[a-z0-9-]+\.md$/i.test(f)) throw new Error("Only files in skills/ have versions.");
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
    const hit = (await git(["log", "-1", "--format=%h|%aI", "--grep", `OS proposal #${row.id}\\b`, "-E", REF])).trim();
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
