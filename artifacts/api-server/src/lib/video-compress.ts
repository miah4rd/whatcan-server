import { spawn } from "node:child_process";
import { createWriteStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pool } from "@workspace/db";
import { logger } from "./logger";

/**
 * Video-tour compressor.
 *
 * Agents upload walkthroughs straight from the phone into the site's
 * `property-videos` bucket (admin form → `properties.video_url`). A phone
 * clip is ~70 MB for 30 s at 18 Mbit/s, and every view of it is 70 MB of
 * Supabase egress. This worker polls the catalog for videos still in that
 * raw form, re-encodes them on this VPS with ffmpeg (H.264, ≤1920×1080,
 * ≤6 Mbit/s — about a third of the size with no visible loss on a phone),
 * uploads the result next to the original as `<name>-web.mp4`, repoints
 * `video_url`, and only then deletes the original. iPhone HEVC `.mov` files,
 * which Chrome and Android cannot play, come out as H.264 the same way.
 *
 * Safety: the original is deleted only after the output was probed to have
 * the same duration and to be smaller, and only if `video_url` still pointed
 * at that original when we swapped it (a broker replacing the video mid-job
 * keeps whatever they set). Every decision is recorded in
 * `video_compress_jobs`, so a file is never re-encoded twice and a failure
 * is visible instead of silently retried forever.
 *
 * Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (same as listing-publish)
 * and ffmpeg/ffprobe on PATH. Set VIDEO_COMPRESS_DISABLED=1 to pause.
 */

const BUCKET = "property-videos";
const OBJECT_PUBLIC_PREFIX = `/storage/v1/object/public/${BUCKET}/`;
const WEB_SUFFIX = "-web.mp4";
const POLL_MS = 60_000;
const FIRST_RUN_MS = 20_000;
const FFMPEG_TIMEOUT_MS = 20 * 60_000;
/** Already lean: H.264, at most this bitrate and at most 1920 on the long side. */
const SKIP_BELOW_BPS = 6_500_000;
const DURATION_TOLERANCE_S = 1.5;

type CatalogRow = { id: string; video_url: string | null };
type Probe = { width: number; height: number; codec: string; durationS: number; bitrateBps: number };
type JobStatus = "done" | "skipped" | "failed" | "done_unlinked";

let running = false;

function supabaseEnv(): { url: string; key: string } | null {
  const url = (process.env["SUPABASE_URL"] ?? "").trim().replace(/\/+$/, "");
  const key = (process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? "").trim();
  if (!url || !key) return null;
  return { url, key };
}

function authHeaders(key: string): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

/** `…/storage/v1/object/public/property-videos/R-YUD-071/x.mp4` → `R-YUD-071/x.mp4` */
export function objectPathOf(videoUrl: string): string | null {
  const i = videoUrl.indexOf(OBJECT_PUBLIC_PREFIX);
  if (i < 0) return null;
  const rest = videoUrl.slice(i + OBJECT_PUBLIC_PREFIX.length).split("?")[0] ?? "";
  try {
    return rest ? decodeURIComponent(rest) : null;
  } catch {
    return rest || null;
  }
}

/** `R-YUD-071/reels16.mp4` → `R-YUD-071/reels16-web.mp4` */
export function outputPathFor(objectPath: string): string {
  const dir = path.posix.dirname(objectPath);
  const base = path.posix.basename(objectPath).replace(/\.[^.]+$/, "");
  const name = `${base}${WEB_SUFFIX}`;
  return dir === "." ? name : `${dir}/${name}`;
}

const isCompressedOutput = (objectPath: string) => objectPath.endsWith(WEB_SUFFIX);

async function ensureTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS video_compress_jobs (
      source_url   TEXT PRIMARY KEY,
      property_id  TEXT NOT NULL,
      status       TEXT NOT NULL,
      output_url   TEXT,
      input_bytes  BIGINT,
      output_bytes BIGINT,
      error        TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function recordJob(
  sourceUrl: string,
  propertyId: string,
  status: JobStatus,
  extra: { outputUrl?: string; inputBytes?: number; outputBytes?: number; error?: string } = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO video_compress_jobs (source_url, property_id, status, output_url, input_bytes, output_bytes, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (source_url) DO UPDATE SET
       status = EXCLUDED.status, output_url = EXCLUDED.output_url, input_bytes = EXCLUDED.input_bytes,
       output_bytes = EXCLUDED.output_bytes, error = EXCLUDED.error, updated_at = now()`,
    [sourceUrl, propertyId, status, extra.outputUrl ?? null, extra.inputBytes ?? null, extra.outputBytes ?? null, extra.error ?? null],
  );
}

async function alreadyHandled(sourceUrl: string): Promise<boolean> {
  const r = await pool.query(`SELECT 1 FROM video_compress_jobs WHERE source_url = $1`, [sourceUrl]);
  return (r.rowCount ?? 0) > 0;
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

async function probe(file: string): Promise<Probe> {
  const { code, stdout, stderr } = await run(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,codec_name:format=duration,bit_rate", "-of", "json", file],
    60_000,
  );
  if (code !== 0) throw new Error(`ffprobe failed (${code}): ${stderr.trim()}`);
  const json = JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number; codec_name?: string }>; format?: { duration?: string; bit_rate?: string } };
  const s = json.streams?.[0];
  const f = json.format;
  if (!s?.width || !s?.height || !f?.duration) throw new Error("ffprobe: no video stream or duration");
  return {
    width: s.width,
    height: s.height,
    codec: s.codec_name ?? "",
    durationS: Number(f.duration),
    bitrateBps: Number(f.bit_rate ?? 0),
  };
}

async function download(url: string, file: string): Promise<number> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(file));
  return (await fs.stat(file)).size;
}

async function transcode(input: string, output: string): Promise<void> {
  // Long side capped at 1920, short side at 1080, both orientations; -2 keeps
  // dimensions even. ffmpeg applies the phone's rotation metadata before the
  // filter, so a portrait clip is measured as portrait here.
  const scale = "scale='if(gt(iw,ih),min(1920,iw),min(1080,iw))':-2";
  const args = [
    "-n", "10", "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
    "-i", input,
    "-vf", scale,
    "-c:v", "libx264", "-preset", "medium", "-crf", "26", "-maxrate", "6000k", "-bufsize", "12000k",
    "-pix_fmt", "yuv420p", "-profile:v", "high", "-level", "4.1",
    "-c:a", "aac", "-b:a", "128k", "-ac", "2",
    "-movflags", "+faststart", "-threads", "2",
    output,
  ];
  const { code, stderr } = await run("nice", args, FFMPEG_TIMEOUT_MS);
  if (code !== 0) throw new Error(`ffmpeg failed (${code}): ${stderr.trim().slice(-800)}`);
}

async function uploadObject(env: { url: string; key: string }, objectPath: string, file: string): Promise<void> {
  const body = await fs.readFile(file);
  const res = await fetch(`${env.url}/storage/v1/object/${BUCKET}/${objectPath.split("/").map(encodeURIComponent).join("/")}`, {
    method: "POST",
    headers: { ...authHeaders(env.key), "Content-Type": "video/mp4", "x-upsert": "true", "cache-control": "31536000" },
    body,
  });
  if (!res.ok) throw new Error(`upload ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

async function deleteObject(env: { url: string; key: string }, objectPath: string): Promise<void> {
  const res = await fetch(`${env.url}/storage/v1/object/${BUCKET}/${objectPath.split("/").map(encodeURIComponent).join("/")}`, {
    method: "DELETE",
    headers: authHeaders(env.key),
  });
  if (!res.ok && res.status !== 404) throw new Error(`delete ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

/** Repoints video_url only if it still equals the source; returns whether a row changed. */
async function swapVideoUrl(env: { url: string; key: string }, propertyId: string, sourceUrl: string, outputUrl: string): Promise<boolean> {
  const q = `id=eq.${encodeURIComponent(propertyId)}&video_url=eq.${encodeURIComponent(sourceUrl)}`;
  const res = await fetch(`${env.url}/rest/v1/properties?${q}`, {
    method: "PATCH",
    headers: { ...authHeaders(env.key), "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({ video_url: outputUrl, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`patch ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const rows = (await res.json()) as unknown[];
  return rows.length === 1;
}

async function listCandidates(env: { url: string; key: string }): Promise<Array<{ id: string; videoUrl: string; objectPath: string }>> {
  const res = await fetch(`${env.url}/rest/v1/properties?select=id,video_url&video_url=like.*property-videos*`, {
    headers: authHeaders(env.key),
  });
  if (!res.ok) throw new Error(`catalog ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const rows = (await res.json()) as CatalogRow[];
  const out: Array<{ id: string; videoUrl: string; objectPath: string }> = [];
  for (const r of rows) {
    if (!r.video_url) continue;
    const objectPath = objectPathOf(r.video_url);
    if (!objectPath || isCompressedOutput(objectPath)) continue;
    out.push({ id: r.id, videoUrl: r.video_url, objectPath });
  }
  return out;
}

async function compressOne(env: { url: string; key: string }, job: { id: string; videoUrl: string; objectPath: string }): Promise<void> {
  const log = logger.child({ propertyId: job.id, object: job.objectPath });
  const tmp = await fs.mkdtemp(path.join(process.env["VIDEO_TMP_DIR"] ?? os.tmpdir(), "video-compress-"));
  const input = path.join(tmp, "input");
  const output = path.join(tmp, "output.mp4");
  try {
    const inputBytes = await download(job.videoUrl, input);
    const before = await probe(input);
    log.info({ inputBytes, ...before }, "video: probed original");

    const lean = before.codec === "h264" && before.bitrateBps > 0 && before.bitrateBps <= SKIP_BELOW_BPS && Math.max(before.width, before.height) <= 1920;
    if (lean) {
      await recordJob(job.videoUrl, job.id, "skipped", { inputBytes, error: "already H.264 at a lean bitrate" });
      log.info("video: already lean, left as is");
      return;
    }

    await transcode(input, output);
    const outputBytes = (await fs.stat(output)).size;
    const after = await probe(output);
    if (Math.abs(after.durationS - before.durationS) > DURATION_TOLERANCE_S) {
      throw new Error(`output duration ${after.durationS}s differs from source ${before.durationS}s`);
    }
    if (outputBytes >= inputBytes) {
      await recordJob(job.videoUrl, job.id, "skipped", { inputBytes, outputBytes, error: "re-encode was not smaller" });
      log.info({ inputBytes, outputBytes }, "video: re-encode not smaller, original kept");
      return;
    }

    const outPath = outputPathFor(job.objectPath);
    await uploadObject(env, outPath, output);
    const outputUrl = job.videoUrl.slice(0, job.videoUrl.indexOf(OBJECT_PUBLIC_PREFIX) + OBJECT_PUBLIC_PREFIX.length) + outPath.split("/").map(encodeURIComponent).join("/");

    const swapped = await swapVideoUrl(env, job.id, job.videoUrl, outputUrl);
    if (!swapped) {
      await recordJob(job.videoUrl, job.id, "done_unlinked", { outputUrl, inputBytes, outputBytes, error: "video_url changed during the job; original kept" });
      log.warn("video: video_url changed meanwhile, original kept");
      return;
    }
    await deleteObject(env, job.objectPath);
    await recordJob(job.videoUrl, job.id, "done", { outputUrl, inputBytes, outputBytes });
    log.info({ inputBytes, outputBytes, ratio: Number((outputBytes / inputBytes).toFixed(2)), ...after }, "video: compressed, swapped and original removed");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordJob(job.videoUrl, job.id, "failed", { error: message.slice(0, 1000) }).catch(() => undefined);
    log.error({ err }, "video: compression failed");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function runVideoCompressOnce(): Promise<void> {
  if (running) return;
  const env = supabaseEnv();
  if (!env) {
    logger.warn("video compressor: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set, skipping");
    return;
  }
  running = true;
  try {
    const candidates = await listCandidates(env);
    for (const c of candidates) {
      if (await alreadyHandled(c.videoUrl)) continue;
      // One file per tick: the VPS has two cores and the bot must stay responsive.
      await compressOne(env, c);
      break;
    }
  } finally {
    running = false;
  }
}

export function startVideoCompressScheduler(): void {
  if (process.env["VIDEO_COMPRESS_DISABLED"]) {
    logger.info("video compressor disabled by VIDEO_COMPRESS_DISABLED");
    return;
  }
  ensureTable()
    .then(() => {
      setTimeout(() => { runVideoCompressOnce().catch((err) => logger.error({ err }, "video compressor: initial run failed")); }, FIRST_RUN_MS);
      setInterval(() => { runVideoCompressOnce().catch((err) => logger.error({ err }, "video compressor: run failed")); }, POLL_MS);
      logger.info("scheduler started: video compressor every 60s");
    })
    .catch((err) => logger.error({ err }, "video compressor: could not create video_compress_jobs"));
}
