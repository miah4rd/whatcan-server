/**
 * Bali area hierarchy — the same parent/sub-area structure the website's search
 * filter uses (mirrored from AREA_GROUPS in the site repo, src/data/properties.ts).
 *
 * Why the bot needs it: listings are tagged with a SUB-area ("Pecatu", "Bukit",
 * "Berawa"), while leads speak in parent regions ("something in Uluwatu",
 * "looking at Canggu"). Matching those strings literally finds almost nothing —
 * a lead asking for Uluwatu would never be shown the Pecatu or Bingin villas
 * that a broker would obviously offer them.
 *
 * Keep in sync with the site: if a sub-area is added there, add it here too,
 * otherwise the bot silently stops offering listings in it.
 */

export type AreaGroup = { name: string; subAreas?: string[] };

export const AREA_GROUPS: AreaGroup[] = [
  { name: "Canggu", subAreas: ["Babakan", "Batu Bolong", "Berawa", "Canggu", "Dalung", "Echo Beach", "Kayu Tulang", "Padonan"] },
  { name: "Cemagi" },
  { name: "Jimbaran" },
  { name: "Kerobokan" },
  { name: "Lovina" },
  { name: "Nusa Dua" },
  { name: "Pererenan", subAreas: ["Mengwi", "Pererenan", "Tumbak Bayuh"] },
  { name: "Sanur" },
  { name: "Seminyak" },
  { name: "Seseh" },
  { name: "Tabanan" },
  { name: "Ubud" },
  { name: "Uluwatu", subAreas: ["Balangan", "Bingin", "Bukit", "Dreamland", "Nyang Nyang", "Padang Padang", "Pecatu", "Uluwatu / Suluban", "Suluban", "Ungasan"] },
  { name: "Umalas" },
];

/** Every name a lead might reasonably say — parents and sub-areas alike. */
export function allAreaNames(): string[] {
  const out: string[] = [];
  for (const g of AREA_GROUPS) {
    out.push(g.name);
    for (const s of g.subAreas ?? []) if (!out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * Expand what the lead said into every catalog area that should count as a match.
 *
 * A parent widens to its sub-areas ("Uluwatu" also means Pecatu, Bingin, Bukit…),
 * because that is how a broker reads the request. A sub-area stays narrow
 * ("Bingin" means Bingin) — naming one specifically is a deliberate choice, and
 * widening it back to the whole region would ignore what they asked for.
 */
export function expandArea(spoken: string): string[] {
  const wanted = spoken.trim().toLowerCase();
  if (!wanted) return [];

  const parent = AREA_GROUPS.find((g) => g.name.toLowerCase() === wanted);
  if (parent) {
    return [parent.name, ...(parent.subAreas ?? [])];
  }

  for (const g of AREA_GROUPS) {
    const sub = (g.subAreas ?? []).find((s) => s.toLowerCase() === wanted);
    if (sub) {
      // "Uluwatu / Suluban" in the catalog is the same place as "Suluban".
      const variants = [sub];
      if (sub.includes("/")) variants.push(...sub.split("/").map((x) => x.trim()));
      const combined = (g.subAreas ?? []).find(
        (s) => s.includes("/") && s.toLowerCase().split("/").map((x) => x.trim()).includes(wanted),
      );
      if (combined && !variants.includes(combined)) variants.push(combined);
      return variants;
    }
  }

  return [spoken.trim()];
}

/** True when a catalog listing's area falls under any of the requested areas. */
export function areaMatches(listingArea: string | null | undefined, requested: string[]): boolean {
  const a = (listingArea ?? "").trim().toLowerCase();
  if (!a) return false;
  for (const r of requested) {
    for (const candidate of expandArea(r)) {
      if (candidate.toLowerCase() === a) return true;
    }
  }
  return false;
}
