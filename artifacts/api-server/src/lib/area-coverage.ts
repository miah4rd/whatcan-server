/**
 * Do we have villas where this rental client wants to live?
 *
 * The automatic ad welcome reads the Meta form back to the client — "Got your
 * request: 4BR, Rp 30–50 million, Sanur. Did I get that right?" — and it did
 * exactly that on 10.09.2026 for a client in Sanur, where we have no villas
 * and nothing nearby. Before her, Pemogan (Denpasar) and Ubud were welcomed
 * the same way and went nowhere. Amelia: "can we not send messages to areas we
 * don't cover?" A recap of a place we cannot serve reads as a promise, and the
 * message spends one of the line's daily new conversations.
 *
 * Coverage is read from the live catalog, never from a hand-kept list of "our"
 * areas: a place counts as served when an offerable rental sits in it, in its
 * district, or in a district a broker would honestly call adjacent
 * (NEIGHBOUR_AREAS in bali-areas.ts — Jimbaran and Nusa Dua are served through
 * Uluwatu). The day a villa in Sanur is listed, Sanur leads are welcomed again
 * with no code change.
 *
 * The verdict only ever withholds the AUTOMATIC message. The lead still reaches
 * the inbox with its ordinary draft and a "⊘ Review" flag, and the broker
 * decides. Megan, the client who raised this, answered the welcome "West side
 * is ok": a person reading the card can still win that lead.
 */
import { areaMatches, areaNamesInText, neighbourAreas, parentAreaOf } from "./bali-areas";
import { fetchAllPropertiesForPriceLookup, offerableNow } from "./property-catalog";

/**
 * A form answer that says nothing: the area question's "Other", or a notes
 * field filled in to get past it ("No", "-", "."). Never read back to a
 * client, never taken as a place.
 */
const NON_ANSWER = /^\s*(other|others|lainnya|any|anywhere|no|nope|none|no need|nothing|n\/?a|not sure|done|me|-+|\.+|\d{1,2})\s*[.!]?\s*$/i;

export function isNonAnswer(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  return t.length === 0 || NON_ANSWER.test(t);
}

/**
 * Places clients name that are not on the site's area list at all — the rest
 * of the island. Matched on word boundaries, not substrings: "amed" is inside
 * "named". Kuta and Legian are deliberately absent — they sit next to
 * Seminyak, where we do have villas, so a client naming them is not asking for
 * somewhere we cannot serve.
 */
const OTHER_PLACES =
  /\b(denpasar|pemogan|renon|sesetan|sidakarya|panjer|mambal|abiansemal|tegal+alang|payangan|penestanan|sayan|gianyar|sukawati|keramas|ketewel|amed|candidasa|sidemen|karangasem|tulamben|munduk|singaraja|bedugul|nusa penida|nusa lembongan|nusa ceningan)\b/gi;

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function placesIn(text: string): string[] {
  const found = areaNamesInText(text);
  for (const m of text.matchAll(OTHER_PLACES)) {
    const name = titleCase(m[1]!);
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

/**
 * Every place the client named on the card. The form's area answer first; the
 * notes only when that answer named nothing — "Other" + "Sanur" is a Sanur
 * request, while "Kerobokan" + "Sanur too" is a Kerobokan one.
 */
export function placesAsked(areaAnswer: string | null | undefined, notes: string | null | undefined): string[] {
  const area = (areaAnswer ?? "").trim();
  const fromArea = isNonAnswer(area) ? [] : placesIn(area);
  if (fromArea.length > 0) return fromArea;
  const note = (notes ?? "").trim();
  return isNonAnswer(note) ? [] : placesIn(note);
}

/** Served: an offerable rental in the place itself, its district, or next door. */
export function isServed(place: string, stockAreas: readonly string[]): boolean {
  const nearby = [place, parentAreaOf(place) ?? place, ...neighbourAreas(place)];
  return stockAreas.some((area) => areaMatches(area, nearby));
}

/**
 * The places asked that we cannot serve — or null when the welcome may go:
 * nothing recognisable was named (that is not evidence of anything), the stock
 * is unknown, or at least one named place is served.
 */
export function unservedPlaces(places: readonly string[], stockAreas: readonly string[]): string[] | null {
  if (places.length === 0 || stockAreas.length === 0) return null;
  return places.some((p) => isServed(p, stockAreas)) ? null : [...places];
}

/** Areas holding at least one rental we could offer today. */
export async function rentalStockAreas(): Promise<string[]> {
  const all = await fetchAllPropertiesForPriceLookup();
  const areas = new Set<string>();
  for (const p of all) {
    if (p.listing_type === "rent" && p.area && offerableNow(p)) areas.add(p.area);
  }
  return [...areas];
}

/**
 * The card's verdict. A catalog that cannot be read yields null: an outage
 * must never silence every welcome.
 */
export async function unservedAreasOnCard(
  answers: { areas: string | null; notes: string | null } | null | undefined,
): Promise<string[] | null> {
  if (!answers) return null;
  const places = placesAsked(answers.areas, answers.notes);
  if (places.length === 0) return null;
  const stock = await rentalStockAreas().catch(() => [] as string[]);
  return unservedPlaces(places, stock);
}
