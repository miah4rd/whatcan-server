/**
 * What the broker sees under each villa in a shortlist (owner, 27.09.2026: "I cannot see whether a
 * villa is Pre-listed or Listed, with green flags or red, so I cannot tell if the priority worked").
 * The same facts the matcher ranks by (property-catalog.ts rankShortlistFits): inspected (Listed) or
 * not (Pre-listed), green flags from the inspection and checked key features, red flags or
 * construction nearby. For the broker only — never in the text or the links the client gets.
 */
import { publishedRentals, greenFeatures } from "./property-catalog";
import { listingQualityById } from "./property-flags";

export type VillaTrust = { listed: boolean | null; greenFlags: number; redFlags: number; construction: boolean; features: string[]; photos: string[]; originals?: string[] };

// Brokers remember a villa by how it looks, not by its R-number (Amelia, 29.09.2026): the Copilot
// shows its photos next to the link. The 600px webp copies the website itself uses (photo-variants).
const OBJECT_PUBLIC = "/storage/v1/object/public/";
const smallPhoto = (u: string) => {
  const i = u.indexOf(OBJECT_PUBLIC);
  return i >= 0 ? `https://copilot.globalapplab.ru/photo-variants/w600/${u.slice(i + OBJECT_PUBLIC.length)}` : u;
};

const idOf = (url: string | null | undefined) => String(url ?? "").match(/\/property\/([A-Za-z0-9-]+)/i)?.[1]?.toUpperCase() ?? null;

export async function trustForAttachments(
  attachments: ReadonlyArray<{ type?: string; url?: string | null }> | null | undefined,
): Promise<Record<string, VillaTrust>> {
  const links = (attachments ?? []).filter((a) => a?.url && (a.type ?? "link") === "link");
  if (!links.length) return {};
  const [props, quality] = await Promise.all([publishedRentals().catch(() => []), listingQualityById().catch(() => new Map())]);
  const byId = new Map(props.map((p) => [String(p.id).toUpperCase(), p]));
  const out: Record<string, VillaTrust> = {};
  for (const a of links) {
    const id = idOf(a.url);
    const p = id ? byId.get(id) : undefined;
    if (!id || !p) continue;
    const q = quality.get(id) ?? quality.get(String(p.id));
    out[a.url!] = {
      listed: p.pre_listed == null ? null : p.pre_listed === false,
      greenFlags: q?.greenFlags ?? 0,
      redFlags: q?.redFlags ?? 0,
      construction: !!q?.constructionNearby,
      features: greenFeatures(p),
      photos: (p.photos ?? []).map(smallPhoto),
      // The site's own photo, for a brand-new villa whose small copy is not made yet (owner, 30.09).
      originals: (p.photos ?? []).slice(0, 1),
    };
  }
  return out;
}
