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

/**
 * Really adjacent districts — what a broker would honestly call "nearby".
 * Used only when the client's own area holds nothing: the reply may OFFER
 * these in words. It never attaches villas from them unasked — the owner's
 * rule (2026-09-04): «человек говорит направо, ты ему даёшь налево — так не
 * надо». Nusa Dua is not "near" Pererenan, whatever a model thinks.
 */
const NEIGHBOUR_AREAS: Record<string, string[]> = {
  Canggu: ["Pererenan", "Umalas", "Kerobokan", "Seseh"],
  Pererenan: ["Canggu", "Seseh", "Cemagi"],
  Seseh: ["Pererenan", "Cemagi", "Canggu"],
  Cemagi: ["Seseh", "Pererenan", "Tabanan"],
  Tabanan: ["Cemagi", "Seseh"],
  Umalas: ["Kerobokan", "Canggu", "Seminyak"],
  Kerobokan: ["Umalas", "Seminyak", "Canggu"],
  Seminyak: ["Kerobokan", "Umalas"],
  Jimbaran: ["Nusa Dua", "Uluwatu"],
  "Nusa Dua": ["Jimbaran", "Uluwatu"],
  Uluwatu: ["Jimbaran", "Nusa Dua"],
  Sanur: [],
  Ubud: [],
  Lovina: [],
};

/** Adjacent districts of what the lead said (a sub-area resolves to its district first). */
export function neighbourAreas(spoken: string): string[] {
  const parent = parentAreaOf(spoken);
  if (!parent) return [];
  const key = Object.keys(NEIGHBOUR_AREAS).find((k) => k.toLowerCase() === parent.toLowerCase());
  return key ? [...NEIGHBOUR_AREAS[key]!] : [];
}

// ── Misspelled and voice-typed area names (owner, 14.09.2026) ───────────────
// Luke dictated "also cannot, berewa, pad on an, seseh are also suitable" —
// Canggu, Berawa, Padonan, Seseh. An area had to appear LITERALLY, so three of
// the four were dropped and he got Umalas only. A misspelling is read only
// inside a LIST of places (two or more place-like items in one message) and
// only on a short item, so ordinary words are never turned into districts.

/** What phone voice typing makes of a name — too far for an edit distance. */
const VOICE_AREA_ALIASES: Record<string, string> = {
  cannot: "Canggu",
  "can go": "Canggu",
  "chang gu": "Canggu",
  changgu: "Canggu",
  chango: "Canggu",
  kangu: "Canggu",
  "uma las": "Umalas",
  "see say": "Seseh",
  sesay: "Seseh",
  "pere renan": "Pererenan",
  "berry wa": "Berawa",
};

/** English words that sit one letter from a district ("loving" → Lovina). */
const FUZZY_STOPWORDS = new Set(["loving", "living", "lovin", "being", "bingo", "sanity", "pecan", "beware"]);

const LIST_FILLER = /\b(also|the|in|at|near|around|area|areas|are|is|suitable|fine|ok|okay|good|too|maybe|like|prefer|would|be|we|i|im|with|sure|yes|all|those|these|both|either|work|works|possible|options?)\b/g;

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

function closestAreaName(phrase: string, names: string[]): string | null {
  const joined = phrase.replace(/\s+/g, "");
  if (joined.length < 5 || FUZZY_STOPWORDS.has(joined)) return null;
  let best: { name: string; d: number } | null = null;
  for (const name of names) {
    const target = name.toLowerCase().replace(/[^a-z]/g, "");
    if (target.length < 5) continue;
    const d = editDistance(joined, target);
    const allowed = target.length >= 7 ? 2 : 1;
    if (d <= allowed && (!best || d < best.d)) best = { name, d };
  }
  return best?.name ?? null;
}

/**
 * Area names the text MEANS but misspells, in the valid spelling — only from a
 * list of places, never a lone word. Exact names are areaNamesInText's job and
 * are not repeated here. `extraNames` adds the catalog's own area spellings.
 */
export function fuzzyAreaNamesInText(text: string, extraNames: string[] = []): string[] {
  const names = [...new Set([...allAreaNames(), ...extraNames.map((n) => n.trim())])].filter(Boolean);
  const segments = String(text ?? "")
    .toLowerCase()
    .split(/[,;\/\n&+]|\s(?:and|or|plus)\s/)
    .map((s) => s.replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const exact = new Set<string>();
  const fuzzy = new Set<string>();
  let placeItems = 0;
  for (const seg of segments) {
    const exactHere = names.filter((n) => new RegExp(`\\b${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(seg));
    if (exactHere.length > 0) {
      exactHere.forEach((n) => exact.add(n));
      placeItems++;
      continue;
    }
    const core = seg.replace(LIST_FILLER, " ").replace(/\s+/g, " ").trim();
    const words = core ? core.split(" ") : [];
    if (words.length === 0 || words.length > 3) continue;
    let hit: string | null = VOICE_AREA_ALIASES[core] ?? null;
    for (let n = Math.min(3, words.length); !hit && n >= 1; n--) {
      for (let i = 0; !hit && i + n <= words.length; i++) {
        const gram = words.slice(i, i + n).join(" ");
        hit = VOICE_AREA_ALIASES[gram] ?? closestAreaName(gram, names);
      }
    }
    if (hit) {
      fuzzy.add(hit);
      placeItems++;
    }
  }
  if (fuzzy.size === 0 || placeItems < 2) return [];
  return [...fuzzy].filter((n) => !exact.has(n));
}

/**
 * A landmark is not an area, but it says where the client wants to be. Sophie
 * asked "do you have something near the Nuanu?" (14.09): Nuanu matched no
 * district, so the request kept a place no villa is tagged with and the
 * neighbouring Seseh, Cemagi and Tabanan villas were never opened. Only
 * places whose surroundings are not in doubt are listed; the caller keeps the
 * areas that exist in its vocabulary.
 */
const LANDMARK_AREAS: Array<{ rx: RegExp; landmark: string; areas: string[] }> = [
  { rx: /\bnuanu\b/i, landmark: "Nuanu", areas: ["Seseh", "Cemagi", "Tabanan", "Kedungu", "Nyanyi", "Beraban"] },
  { rx: /\btanah\s*lot\b/i, landmark: "Tanah Lot", areas: ["Tabanan", "Cemagi", "Kedungu", "Beraban"] },
  { rx: /\bfinn'?s\s+(beach|club)/i, landmark: "Finns Beach Club", areas: ["Berawa", "Canggu"] },
  { rx: /\batlas\s+(beach|club)/i, landmark: "Atlas Beach Club", areas: ["Berawa", "Canggu"] },
  { rx: /\bpotato\s+head\b/i, landmark: "Potato Head", areas: ["Seminyak", "Kerobokan"] },
  { rx: /\bold\s+man'?s\b/i, landmark: "Old Man's", areas: ["Batu Bolong", "Canggu"] },
];

export function landmarkAreasInText(text: string): Array<{ landmark: string; areas: string[] }> {
  const t = String(text ?? "");
  return LANDMARK_AREAS.filter((l) => l.rx.test(t)).map((l) => ({ landmark: l.landmark, areas: [...l.areas] }));
}
