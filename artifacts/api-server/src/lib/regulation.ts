/**
 * The funnel's regulation as the bot reads it (owner, 26.09: "edit it, press Save, and the Copilot and
 * the autopilot work by it — as in Cowork"). The one source is skills/<file>.md on GitHub master: a
 * save in Unicorn OS Playbooks pushes there, a Claude session pushes there, and this reader follows
 * it within a minute (fetch + git show), without a deploy. Until the first read it falls back to the
 * server's checkout. Rules enforced in code (limits, gates) still need the code to follow; the text
 * steers what the AI writes and decides.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const FILE_OF: Record<string, string> = { rental: "rental.md", "rental listings": "rental-listings.md" };
const fromGithub = new Map<string, string>();
let lastFetch = 0;

function repoRoot(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

/** Re-read the regulations from GitHub master. `fetch` false = the ref was just fetched. */
export async function refreshRegulations(fetch = true): Promise<void> {
  const root = repoRoot();
  if (!root) return;
  const opts = { cwd: root, timeout: 20_000, maxBuffer: 4 << 20 };
  if (fetch && Date.now() - lastFetch > 60_000) {
    lastFetch = Date.now();
    await run("git", ["fetch", "-q", "github", "master"], opts).catch(() => undefined);
  }
  for (const file of Object.values(FILE_OF)) {
    const text = await run("git", ["show", `github/master:skills/${file}`], opts).then((r) => r.stdout, () => null);
    if (text != null) fromGithub.set(file, text);
  }
}
if (process.env["NODE_ENV"] !== "test") {
  void refreshRegulations();
  setInterval(() => void refreshRegulations(), 60_000).unref();
}

/** The regulation text for a funnel ("Rental", "Rental Listings"), or "" when it has none. */
export function regulationText(pipeline: string | null | undefined): string {
  const file = FILE_OF[String(pipeline ?? "").trim().toLowerCase()];
  if (!file) return "";
  const hit = fromGithub.get(file);
  if (hit != null) return hit;
  const root = repoRoot();
  try {
    return root ? fs.readFileSync(path.join(root, "skills", file), "utf8") : "";
  } catch {
    return "";
  }
}

/** The block appended to a funnel's system prompt: the owner's written rules win over anything above. */
export function regulationBlock(pipeline: string | null | undefined): string {
  const text = regulationText(pipeline).trim();
  if (!text) return "";
  return `\n\n## THE FUNNEL'S REGULATION — the owner's written rules, current version\nWhere anything above disagrees with this regulation, the regulation wins. Follow it; never invent a rule it does not contain.\n\n${text}`;
}
