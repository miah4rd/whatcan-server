/**
 * One-time upload slots in the site's storage (the service key never leaves the server). The phone
 * PUTs the file straight to Supabase, so a 200 MB video never passes through this VPS (2.5 GB free).
 * Used by the inspection report and the viewing report.
 */
const FOLDER = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;

export async function signedStorageUpload(
  folder: string,
  kind: "photo" | "video",
  fileName: string,
  stem: string,
): Promise<{ uploadUrl: string; publicUrl: string }> {
  const url = process.env["SUPABASE_URL"] ?? "";
  const key = process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? "";
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
  if (!FOLDER.test(folder)) throw new Error("bad storage folder");
  const bucket = kind === "photo" ? "property-images" : "property-videos";
  const ext = kind === "photo" ? "jpg" : ((fileName.match(/\.([a-z0-9]{2,4})$/i)?.[1] ?? "mp4").toLowerCase());
  const objectPath = `${folder}/${stem}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const res = await fetch(`${url}/storage/v1/object/upload/sign/${bucket}/${objectPath}`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`storage sign → ${res.status} ${text.slice(0, 200)}`);
  const signed = JSON.parse(text) as { url?: string; signedURL?: string };
  const rel = signed.url ?? signed.signedURL ?? "";
  if (!rel) throw new Error("storage sign returned no url");
  return { uploadUrl: `${url}/storage/v1${rel.startsWith("/") ? "" : "/"}${rel}`, publicUrl: `${url}/storage/v1/object/public/${bucket}/${objectPath}` };
}

/** A public URL of our own storage — the only kind a report may carry. */
export function isOwnStorageUrl(u: string): boolean {
  const base = process.env["SUPABASE_URL"] ?? "";
  return !!base && u.startsWith(`${base}/storage/v1/object/public/property-`);
}
