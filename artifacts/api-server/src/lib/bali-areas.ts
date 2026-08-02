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
  const raw = (listingArea ?? "").trim().toLowerCase();
  if (!raw) return false;
  // A couple of listings carry the sub-area AND its parent in one field,
  // comma-joined ("Tumbak Bayuh, Pererenan") — compared as a whole string that
  // matched neither name in it, so a lead asking for "Pererenan" never saw a
  // villa that is, in fact, in Pererenan. Split on the comma and match any part.
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const candidates = parts.length > 0 ? parts : [raw];
  for (const r of requested) {
    for (const candidate of expandArea(r)) {
      const c = candidate.toLowerCase();
      if (candidates.some((p) => p === c)) return true;
    }
  }
  return false;
}

/**
 * Russian spellings of the same places.
 *
 * The broker dictates edits by voice in Russian, so "поменяй район на Чангу"
 * arrives in Cyrillic while every area name here is Latin — the instruction
 * matched nothing and was silently ignored, which reads as the bot refusing to
 * listen. Only the areas the catalog actually uses are listed; add a line when
 * a new one appears.
 */
const RU_AREA_ALIASES: Record<string, string> = {
  чангу: "Canggu",
  канггу: "Canggu",
  кангу: "Canggu",
  бабакан: "Babakan",
  берава: "Berawa",
  берави: "Berawa",
  батубололнг: "Batu Bolong",
  "бату болонг": "Batu Bolong",
  падонан: "Padonan",
  чемаги: "Cemagi",
  джимбаран: "Jimbaran",
  керобокан: "Kerobokan",
  ловина: "Lovina",
  "нуса дуа": "Nusa Dua",
  переренан: "Pererenan",
  пererenan: "Pererenan",
  менгви: "Mengwi",
  "тумбак баюх": "Tumbak Bayuh",
  санур: "Sanur",
  семиньяк: "Seminyak",
  семиняк: "Seminyak",
  сесе: "Seseh",
  сесех: "Seseh",
  табанан: "Tabanan",
  убуд: "Ubud",
  улувату: "Uluwatu",
  улуватту: "Uluwatu",
  балангар: "Balangan",
  баланган: "Balangan",
  бингин: "Bingin",
  букит: "Bukit",
  дримленд: "Dreamland",
  "падан падан": "Padang Padang",
  пецату: "Pecatu",
  печату: "Pecatu",
  унгасан: "Ungasan",
  умалас: "Umalas",
};

/**
 * Latin area names mentioned in a piece of text, including ones written in
 * Russian. Returns the catalog's own spelling, so everything downstream keeps
 * comparing Latin to Latin.
 */
export function areaNamesInText(text: string): string[] {
  const lower = (text ?? "").toLowerCase();
  const found: string[] = [];
  for (const name of allAreaNames()) {
    if (lower.includes(name.toLowerCase()) && !found.includes(name)) found.push(name);
  }
  for (const [ru, latin] of Object.entries(RU_AREA_ALIASES)) {
    if (lower.includes(ru) && !found.includes(latin)) found.push(latin);
  }
  return found;
}

/**
 * The parent district of a sub-area ("Padonan" -> "Canggu"). Used when criteria
 * are inherited from an ad's anchor villa: the client clicked one villa in
 * Padonan, but the honest search area is the whole district, not that street.
 */
export function parentAreaOf(subArea: string | null | undefined): string | null {
  const w = (subArea ?? "").trim().toLowerCase();
  if (!w) return null;
  for (const g of AREA_GROUPS) {
    if (g.name.toLowerCase() === w) return g.name;
    if ((g.subAreas ?? []).some((s) => s.toLowerCase() === w)) return g.name;
  }
  return subArea!.trim();
}
