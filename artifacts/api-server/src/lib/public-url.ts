/**
 * The address this server is reachable at from the OUTSIDE.
 *
 * Uploaded listing photos are served by us (`/api/uploads/<file>`) but rendered
 * by the website, which lives on a different host — so a relative path in the
 * `images` column resolves against the site's own domain and 404s. Every image
 * URL that leaves for Supabase has to be absolute.
 */
const FALLBACK_BASE = "https://copilot.globalapplab.ru";

export function publicBaseUrl(): string {
  const configured = (process.env["PUBLIC_BASE_URL"] ?? "").trim();
  const base = configured || FALLBACK_BASE;
  return base.replace(/\/+$/, "");
}

/** Leaves absolute URLs alone; turns "/api/uploads/x.jpg" into a full URL. */
export function absoluteUrl(pathOrUrl: string): string {
  const s = String(pathOrUrl ?? "").trim();
  if (!s) return s;
  if (/^https?:\/\//i.test(s)) return s;
  return publicBaseUrl() + (s.startsWith("/") ? s : "/" + s);
}

export function absoluteUrls(list: readonly string[] | null | undefined): string[] {
  return (list ?? []).map(absoluteUrl).filter(Boolean);
}
