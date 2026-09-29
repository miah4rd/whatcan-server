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
 *
 * A place missing here is not "unserved", it is "unrecognised", and an
 * unrecognised request is welcomed. Christine (15.09.2026) wrote "kesiman,
 * kertalangu, batu bulan, sedap malam" in the notes — East Denpasar and
 * Batubulan, nowhere near a villa of ours — none of it was on this list, and
 * she was read her request back. Add the neighbourhoods and villages clients
 * actually write, not only the district names.
 */
const OTHER_PLACES =
  /\b(denpasar|pemogan|renon|sesetan|sidakarya|panjer|kesiman|kertalangu|sedap\s*malam|sumerta|penatih|tohpati|serangan|pedungan|pesanggaran|peguyangan|batu\s*bulan|celuk|singapadu|batuan|guwang|mambal|abiansemal|tegal+alang|payangan|penestanan|sayan|singakerta|peliatan|lodtunduh|tampaksiring|gianyar|sukawati|blahbatuh|keramas|ketewel|klungkung|semarapura|padang\s*bai|amed|candidasa|sidemen|karangasem|tulamben|kintamani|munduk|singaraja|bedugul|nusa penida|nusa lembongan|nusa ceningan)\b/gi;

/**
 * The catalog district a place above sits next to, so that coverage stays read
 * from the catalog: the day a villa in Sanur is listed, a client asking for
 * Kesiman or Renon is welcomed again, as a Sanur client is. Only adjacency a
 * broker would say out loud; a place with no entry is served only by stock in
 * the place itself.
 */
const DISTRICT_OF_PLACE: Record<string, string> = {
  renon: "Sanur",
  sesetan: "Sanur",
  sidakarya: "Sanur",
  panjer: "Sanur",
  kesiman: "Sanur",
  kertalangu: "Sanur",
  "sedap malam": "Sanur",
  sumerta: "Sanur",
  penatih: "Sanur",
  tohpati: "Sanur",
  serangan: "Sanur",
  penestanan: "Ubud",
  sayan: "Ubud",
  singakerta: "Ubud",
  peliatan: "Ubud",
  lodtunduh: "Ubud",
  tegalalang: "Ubud",
  tegallalang: "Ubud",
  payangan: "Ubud",
};

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

/**
 * The district a named place belongs to: a site sub-area resolves to its parent
 * ("Bingin" → Uluwatu), a village from the list above to its district
 * ("Renon" → Sanur, "Sayan" → Ubud), anything else to itself.
 */
export function districtOfPlace(place: string): string {
  const village = DISTRICT_OF_PLACE[place.toLowerCase().replace(/\s+/g, " ")];
  return village ?? parentAreaOf(place) ?? place;
}

/** Served: an offerable rental in the place itself, its district, or next door. */
export function isServed(place: string, stockAreas: readonly string[]): boolean {
  const district = DISTRICT_OF_PLACE[place.toLowerCase().replace(/\s+/g, " ")];
  const nearby = [
    place,
    parentAreaOf(place) ?? place,
    ...neighbourAreas(place),
    ...(district ? [district, ...neighbourAreas(district)] : []),
  ];
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
