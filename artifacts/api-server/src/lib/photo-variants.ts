import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { logger } from "./logger";

/**
 * Resized copies of the website's catalog photos, served to the site's worker.
 *
 * Owner, 2026-09-13: photos of new listings load slowly and swiping lags. The
 * site's worker (bali-villa-rentals `worker/image-edge.js`) serves every photo
 * as `/img/<bucket>/<path>?w=` and caches it per Cloudflare location. What it
 * falls back to on a cold location was Supabase: its transformer took 1.5–3 s
 * per photo, and even a plain object answered its first request in 1.8–2.1 s
 * (storage in Sydney). So an old villa, or a listing published over SQL, was
 * slow for its first visitor in every location. Cloudflare R2 would have fixed
 * it globally, but the build could not create the bucket and the account's
 * dashboard is out of reach.
 *
 * So this VPS renders every photo once — webp, q75, widths 600/900/1600 — and
 * `/photo-variants/w<width>/<bucket>/<path>` hands the file to the worker in a
 * few hundred milliseconds from anywhere. Newest listings first, then the rest
 * of the catalog; a photo requested before it exists jumps the queue.
 *
 * Files are named by a hash of the object path (the path keeps its percent-
 * encoding, some names carry an encoded slash), so nothing a URL carries ever
 * becomes a filesystem path. Generation stops while the disk has under 1.5 GB
 * free — this is the bot's server. A photo whose EXIF says "rotate" is skipped:
 * the transformer rotates it, ffmpeg may not, and a sideways villa is worse
 * than a slow one. `PHOTO_VARIANTS_DISABLED=1` pauses it.
 */

export const VARIANT_WIDTHS = [600, 900, 1600] as const;
const OBJECT_PUBLIC_PREFIX = "/storage/v1/object/public/";
const VARIANTS_DIR = process.env["PHOTO_VARIANTS_DIR"] ?? "/opt/photo-variants";
const TMP_DIR = path.join(VARIANTS_DIR, ".tmp");
const POLL_MS = 60_000;
const FIRST_RUN_MS = 45_000;
const TICK_BUDGET_MS = 50_000;
const MIN_FREE_BYTES = 1.5 * 1024 ** 3;
const MAX_SOURCE_BYTES = 30 * 1024 * 1024;
const RETRY_FAILED_MS = 6 * 60 * 60_000;
const FFMPEG_TIMEOUT_MS = 90_000;
const MAX_WANTED = 500;

let running = false;
const done = new Set<string>();
const failedAt = new Map<string, { at: number; error: string }>();
const wanted = new Set<string>();
let catalogPaths: string[] = [];
let lastTick: { at: string; rendered: number; skipped: number; failed: number; remaining: number; note?: string } | null = null;
let kickTimer: NodeJS.Timeout | null = null;

function supabaseUrl(): string | null {
  const url = (process.env["SUPABASE_URL"] ?? "").trim().replace(/\/+$/, "");
  return url || null;
}

function serviceHeaders(): Record<string, string> {
  const key = (process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? "").trim();
  return key ? { apikey: key, Authorization: `Bearer ${key}` } : {};
}

/** `property-images/R-YUD-035%2F20.jpg`, spelled the way a browser's URL parser spells it. */
export function normalizeObjectPath(raw: string): string | null {
  try {
    const p = new URL(`http://x/${raw.replace(/^\/+/, "")}`).pathname.slice(1);
    return /^[a-z0-9][a-z0-9_-]*\/.+/i.test(p) ? p : null;
  } catch {
    return null;
  }
}

function objectPathOfSource(src: string, base: string): string | null {
  if (!src.startsWith(`${base}${OBJECT_PUBLIC_PREFIX}`)) return null;
  try {
    return normalizeObjectPath(new URL(src).pathname.slice(OBJECT_PUBLIC_PREFIX.length));
  } catch {
    return null;
  }
}

export function variantFileFor(objectPath: string, width: number): string {
  const h = createHash("sha1").update(objectPath).digest("hex");
  return path.join(VARIANTS_DIR, `w${width}`, h.slice(0, 2), `${h}.webp`);
}

const exists = (file: string) => fs.access(file).then(() => true, () => false);

async function allVariantsExist(objectPath: string): Promise<boolean> {
  for (const w of VARIANT_WIDTHS) if (!(await exists(variantFileFor(objectPath, w)))) return false;
  return true;
}

/** A 404 from the route: render this one before the backlog. */
export function requestVariant(objectPath: string): void {
  if (done.has(objectPath) || wanted.size >= MAX_WANTED) return;
  wanted.add(objectPath);
  if (kickTimer || running) return;
  kickTimer = setTimeout(() => {
    kickTimer = null;
    runPhotoVariantsOnce().catch((err) => logger.error({ err }, "photo variants: kicked run failed"));
  }, 2_000);
}

export function photoVariantStats() {
  return {
    done: done.size,
    catalog: catalogPaths.length,
    failed: failedAt.size,
    wanted: wanted.size,
    running,
    lastTick,
    recentFailures: [...failedAt.entries()].slice(-5).map(([p, f]) => ({ path: p, error: f.error })),
  };
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stderr += String(d).slice(0, 4000); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}

async function enoughDisk(): Promise<boolean> {
  try {
    await fs.mkdir(VARIANTS_DIR, { recursive: true });
    const s = await fs.statfs(VARIANTS_DIR);
    return s.bavail * s.bsize >= MIN_FREE_BYTES;
  } catch (err) {
    logger.warn({ err }, "photo variants: cannot read free disk space, not generating");
    return false;
  }
}

async function listCatalogPaths(base: string): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${base}/rest/v1/properties?select=images&order=created_at.desc`, {
      headers: { ...serviceHeaders(), Range: `${from}-${from + 999}` },
    });
    if (!res.ok) throw new Error(`catalog ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const rows = (await res.json()) as Array<{ images: string[] | null }>;
    for (const r of rows) {
      for (const src of r.images ?? []) {
        const p = objectPathOfSource(src, base);
        if (p && !seen.has(p)) { seen.add(p); out.push(p); }
      }
    }
    if (rows.length < 1000) break;
  }
  return out;
}

/** True when the file carries an EXIF orientation other than "as stored". */
async function needsRotation(file: string): Promise<boolean> {
  const { stdout } = await run(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-read_intervals", "%+#1", "-show_entries", "frame_tags=Orientation:frame_side_data=rotation", "-of", "json", file],
    30_000,
  );
  const json = JSON.parse(stdout || "{}") as { frames?: Array<{ tags?: { Orientation?: string }; side_data_list?: Array<{ rotation?: number }> }> };
  const frame = json.frames?.[0];
  const orientation = frame?.tags?.Orientation;
  const rotation = frame?.side_data_list?.find((s) => typeof s.rotation === "number")?.rotation ?? 0;
  return (orientation !== undefined && orientation !== "1") || rotation !== 0;
}

async function renderOne(base: string, objectPath: string): Promise<"rendered" | "skipped"> {
  await fs.mkdir(TMP_DIR, { recursive: true });
  const tmp = await fs.mkdtemp(path.join(TMP_DIR, "v-"));
  try {
    const res = await fetch(`${base}${OBJECT_PUBLIC_PREFIX}${objectPath}`);
    if (!res.ok) throw new Error(`download ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.byteLength > MAX_SOURCE_BYTES) throw new Error(`source is ${Math.round(bytes.byteLength / 1048576)} MB`);
    const input = path.join(tmp, "input");
    await fs.writeFile(input, bytes);
    if (await needsRotation(input)) {
      failedAt.set(objectPath, { at: Date.now() + 100 * 365 * 86400_000, error: "EXIF rotation: left to the transformer" });
      return "skipped";
    }
    for (const w of VARIANT_WIDTHS) {
      const out = path.join(tmp, `w${w}.webp`);
      const { code, stderr } = await run(
        "nice",
        ["-n", "10", "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", input, "-frames:v", "1",
          "-vf", `scale='min(${w},iw)':-2`, "-c:v", "libwebp", "-quality", "75", "-compression_level", "4", "-threads", "1", out],
        FFMPEG_TIMEOUT_MS,
      );
      if (code !== 0) throw new Error(`ffmpeg w${w} failed (${code}): ${stderr.trim().slice(-300)}`);
      const target = variantFileFor(objectPath, w);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.rename(out, target);
    }
    done.add(objectPath);
    return "rendered";
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function runPhotoVariantsOnce(): Promise<void> {
  if (running) return;
  const base = supabaseUrl();
  if (!base) {
    logger.warn("photo variants: SUPABASE_URL not set, skipping");
    return;
  }
  running = true;
  const started = Date.now();
  let rendered = 0;
  let skipped = 0;
  let failed = 0;
  try {
    if (!(await enoughDisk())) {
      lastTick = { at: new Date().toISOString(), rendered, skipped, failed, remaining: -1, note: "disk below 1.5 GB free, paused" };
      logger.warn("photo variants: disk below 1.5 GB free, paused");
      return;
    }
    catalogPaths = await listCatalogPaths(base);
    const queue = [...wanted, ...catalogPaths];
    wanted.clear();
    let i = 0;
    for (; i < queue.length; i++) {
      const objectPath = queue[i]!;
      if (done.has(objectPath)) continue;
      const failure = failedAt.get(objectPath);
      if (failure && Date.now() - failure.at < RETRY_FAILED_MS) continue;
      if (await allVariantsExist(objectPath)) { done.add(objectPath); continue; }
      if (Date.now() - started > TICK_BUDGET_MS) break;
      if ((rendered + 1) % 50 === 0 && !(await enoughDisk())) break;
      try {
        const r = await renderOne(base, objectPath);
        if (r === "rendered") { rendered++; failedAt.delete(objectPath); } else skipped++;
      } catch (err) {
        failed++;
        const message = err instanceof Error ? err.message : String(err);
        failedAt.set(objectPath, { at: Date.now(), error: message.slice(0, 300) });
        logger.warn({ objectPath, err: message }, "photo variants: render failed");
      }
    }
    const remaining = catalogPaths.filter((p) => !done.has(p) && !failedAt.has(p)).length;
    lastTick = { at: new Date().toISOString(), rendered, skipped, failed, remaining };
    if (rendered || failed) logger.info(lastTick, "photo variants: tick");
  } finally {
    running = false;
  }
}

export function startPhotoVariantScheduler(): void {
  if (process.env["PHOTO_VARIANTS_DISABLED"]) {
    logger.info("photo variants disabled by PHOTO_VARIANTS_DISABLED");
    return;
  }
  fs.rm(TMP_DIR, { recursive: true, force: true })
    .catch(() => undefined)
    .finally(() => {
      setTimeout(() => { runPhotoVariantsOnce().catch((err) => logger.error({ err }, "photo variants: initial run failed")); }, FIRST_RUN_MS);
      setInterval(() => { runPhotoVariantsOnce().catch((err) => logger.error({ err }, "photo variants: run failed")); }, POLL_MS);
      logger.info("scheduler started: photo variants every 60s");
    });
}
