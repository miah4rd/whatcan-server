/**
 * The Google Maps link of each villa in a conversation, from the site's Internal data
 * (property_private.google_maps_url). Owner, 27.09.2026: a broker who books a viewing dictated
 * "attach the Google Maps link" and got "I'll send the address once it's confirmed" — the editor
 * had no map link to give. Only for the broker's own drafts; never invented, only as stored.
 */
import { siteGet } from "./listing-status-week";

const CODE = /\b(R-[A-Z]+-\d+)\b/gi;
const LINK = /\/property\/([A-Za-z0-9-]+)/gi;

/** Villa codes named in a text (property links and codes), newest last. */
export function villaIdsIn(text: string): string[] {
  const ids = [...String(text ?? "").matchAll(LINK)].map((m) => m[1]!.toUpperCase()).concat([...String(text ?? "").matchAll(CODE)].map((m) => m[1]!.toUpperCase()));
  return [...new Set(ids)];
}

export async function villaMapLinks(ids: string[]): Promise<Array<{ id: string; url: string }>> {
  const want = [...new Set(ids.map((i) => i.toUpperCase()))].slice(0, 12);
  if (!want.length) return [];
  const rows = await siteGet<Array<{ property_id: string; google_maps_url: string | null }>>(
    `property_private?select=property_id,google_maps_url&property_id=in.(${want.map(encodeURIComponent).join(",")})`,
  ).catch(() => []);
  return rows
    .map((r) => ({ id: String(r.property_id).toUpperCase(), url: String(r.google_maps_url ?? "").trim() }))
    .filter((r) => /^https?:\/\/\S+$/i.test(r.url));
}

export type VillaLinks = { id: string; title: string; site: string | null; maps: string | null; drive: string | null; video: string | null };

/**
 * Every sendable link of each villa (owner, 27.09.2026: «ссылки на Google карты, на Google диск, ссылка на
 * видео тур… бот имел доступ ко всему этому, и в ручном управлении тоже»): the site page, the map
 * (Internal data), the Drive folder (Internal data) and the video tour (the site's own file, sent as is).
 */
export async function villaLinks(ids: string[]): Promise<VillaLinks[]> {
  const want = [...new Set(ids.map((i) => i.toUpperCase()))].slice(0, 12);
  if (!want.length) return [];
  const list = want.map(encodeURIComponent).join(",");
  type Pub = { id: string; title: string | null; video_url: string | null; is_draft: boolean | null };
  type Priv = { property_id: string; google_maps_url: string | null; drive_folder_url: string | null };
  const [pub, priv] = await Promise.all([
    siteGet<Pub[]>(`properties?select=id,title,video_url,is_draft&id=in.(${list})`).catch((): Pub[] => []),
    siteGet<Priv[]>(`property_private?select=property_id,google_maps_url,drive_folder_url&property_id=in.(${list})`).catch((): Priv[] => []),
  ]);
  const base = (process.env["PUBLIC_BASE_URL"] || process.env["PROPERTY_LINK_BASE_URL"] || "https://unicorn-properties.com").replace(/\/+$/, "");
  const ok = (u: string | null | undefined) => (/^https?:\/\/\S+$/i.test(String(u ?? "").trim()) ? String(u).trim() : null);
  return want
    .map((id) => {
      const p = pub.find((x) => String(x.id).toUpperCase() === id);
      const q = priv.find((x) => String(x.property_id).toUpperCase() === id);
      if (!p && !q) return null;
      return { id, title: String(p?.title ?? id), site: p && !p.is_draft ? `${base}/property/${id}` : null, maps: ok(q?.google_maps_url), drive: ok(q?.drive_folder_url), video: ok(p?.video_url) };
    })
    .filter((v): v is VillaLinks => !!v);
}
