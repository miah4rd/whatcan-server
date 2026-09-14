/**
 * What the villa side has already told us — ONE check before any owner-facing message asks anything.
 *
 * Owner, 14.09.2026, relaying Yudi after he spoke with several owners: the autopilot asks "повторные,
 * однотипные вопросы… там, где уже ответили". Measured the same day over 14 days of auto-sent owner
 * messages (see CLAUDE.md "The owner is never asked twice"): the reply generator and the nudge
 * ladder both re-asked bedrooms, price, availability, minimum stay and "are you still looking to
 * rent it out?" of owners who had answered, in English, in Indonesian, after a `>>` quote, or to
 * Yudi's own phone messages. Three causes, one per writer:
 * - the nudge template asked the WHOLE checklist whenever nothing it knew how to phrase was missing
 *   (Villa Yoshi 12.09: price, commission, date, min stay and viewing all given five days earlier);
 * - `meetsQualified` reads a `null` fact as "missing", and a fact the extractor did not read (a
 *   price in USD, "tidak ada minimum", "before 13tg") is `null`;
 * - the reply prompt's "already answered" list was built from those same facts only, and nothing
 *   checked the finished draft.
 *
 * So the rule is fail-safe in the direction the owner cares about: a point counts as KNOWN when the
 * extracted facts have it OR the villa side's own words carry an answer-shaped statement about it.
 * A false "known" costs one question the broker may ask by hand; a false "unknown" is the bot
 * asking an owner the same thing twice. Every writer asks here before asking the owner anything,
 * and `stripRepeatedAsks` removes a repeated question from a finished draft deterministically.
 */
import { db, leadMessagesTable, leadsSyncTable } from "@workspace/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { extractListingFacts, type ListingFacts } from "./listing-card-fields";
import { chatCompletion, HELPER_MODEL } from "./ai-client";
import { logger } from "./logger";

export type OwnerPoint =
  | "bedrooms"
  | "price"
  | "commission"
  | "min_stay"
  | "availability"
  | "viewing"
  | "photos"
  | "pin"
  | "owner"
  | "still_renting";

export const POINT_LABEL: Record<OwnerPoint, string> = {
  bedrooms: "bedrooms",
  price: "price",
  commission: "whether the price includes our 10% commission",
  min_stay: "minimum stay",
  availability: "when it is free",
  viewing: "when it can be viewed",
  photos: "photos or video",
  pin: "location / map pin",
  owner: "who they are (owner, owner's team or a management company)",
  still_renting: "whether it is still for rent",
};

export type ThreadLine = { senderType: string; text: string | null; sentAt: Date };
export type KnownPoint = { how: "facts" | "thread"; said: string };
export type OwnerThreadKnown = {
  /** The thread as it was read (up to `asOf`), oldest first. */
  lines: ThreadLine[];
  /** The villa side has written at least one message of its own. */
  ownerReplied: boolean;
  lastOwnerAt: Date | null;
  known: Partial<Record<OwnerPoint, KnownPoint>>;
  facts: ListingFacts | null;
};

// ── The villa side's own words ─────────────────────────────────────────────────────────────────

/**
 * A villa-side message without the text it quotes. A WhatsApp reply is stored as `>> quote⏎reply`;
 * the quote is usually OUR question, and "the monthly and yearly rate including our 10%" quoted
 * back is not the owner giving a price. Leading lines found inside an earlier message are dropped;
 * when none is found (the quoted message was never logged) the first line is the quote.
 */
export function villaSideWords(m: ThreadLine, earlier: ThreadLine[]): string {
  const raw = m.text ?? "";
  const seen = earlier.map((e) => (e.text ?? "").replace(/\s+/g, " "));
  let lines = raw.split("\n");
  if (raw.trimStart().startsWith(">>")) {
    lines = raw.replace(/^\s*>>\s*/, "").split("\n");
    let k = 0;
    while (k < lines.length) {
      const l = lines[k]!.replace(/\s+/g, " ").trim();
      if (l && !(l.length >= 3 && seen.some((s) => s.includes(l)))) break;
      k++;
    }
    if (k === 0) k = 1;
    lines = lines.slice(k);
  }
  // Our own words pasted or forwarded back without a quote mark ("My name is Yudi, from Unicorn
  // Property… including our 10%") are still ours.
  const ours = earlier.filter((e) => e.senderType !== "lead").map((e) => (e.text ?? "").replace(/\s+/g, " "));
  return lines
    .filter((l) => {
      const t = l.replace(/\s+/g, " ").trim();
      return !(t.length >= 25 && ours.some((s) => s.includes(t)));
    })
    .join("\n");
}

/** A line of theirs that is a question to us or a promise of an answer later is not an answer. */
const QUESTION_SENTENCE = /\?\s*$/;
const PROMISE = /\b(will|akan|nanti|once|as soon as|to help us|let me|we'?ll|i'?ll|going to|mau (cek|tanya)|cek dulu|check (first|with))\b/i;

type SaidPoint = Exclude<OwnerPoint, "still_renting">;

/** Answer-shaped statements, English and Indonesian. Deliberately generous: see the header. */
const SAID: Record<SaidPoint, RegExp[]> = {
  bedrooms: [
    /\b\d{1,2}\s*-?\s*(br|bed|beds|bed ?rooms?|bdr|bdrm|kamar(\s*tidur)?|kt)\b/i,
    /\b(one|two|three|four|five|six|seven|eight|satu|dua|tiga|empat|lima|enam|tujuh)[\s-]*(bed ?rooms?|beds?|kamar)\b/i,
    /\bstudio\b/i,
  ],
  price: [
    /\b(idr|rp\.?|usd|aud|eur|sgd)\s*\.?\s*\d/i,
    /\b\d[\d.,]*\s*(euros?|eur|dollars?|usd|aud|sgd)\b/i,
    /\b(confirm\w*|same as|sesuai)\b[^\n]{0,40}\b(rate|price|harga)\b[^\n]{0,40}\b(listing|ad|iklan|posted|website)\b/i,
    /[$€]\s*\d|\d[\d.,]*\s*[$€]/,
    /\b\d[\d.,]*\s*(jt|juta|mio|million|millions|mil|milyar|miliar)\b/i,
    /\b\d[\d.,]*\s*m\s*(\/|per|a)\s*(month|mo|year|yr|bulan|tahun)\b/i,
    /\b\d{1,3}([.,]\d{3}){2,}\b/,
    /\b\d+([.,]\d+)?\s*k\s*(usd|aud|eur|\$|per\b|\/|a month|a year|monthly|yearly)/i,
  ],
  // An answer about where our fee sits, not a promise to send one ("tim kami akan kirim info
  // mengenai komisi, sy sudah sampaikan" is not an answer).
  commission: [
    /\b(commission|komisi|fee|agen(t|cy|si)?)\b[^\n]{0,50}\b(includ\w*|termasuk|exclud\w*|on top|di ?luar)\b/i,
    /\b(includ\w*|termasuk|exclud\w*|di ?luar|on top)\b[^\n]{0,40}\b(commission|komisi|fee|agen\w*)\b/i,
    /\b(includ\w*|termasuk)\b[^\n]{0,40}10\s*%|10\s*%[^\n]{0,30}\b(includ\w*|termasuk)\b/i,
    /\b(sudah|belum)\s+(include|termasuk|incl)\b/i,
    /\bnett\b|\bnet (price|rate)\b|\b(price|rate|harga)\w*\s*(is|are|nya)?\s*(already\s+)?(our\s+)?(nett?|bersih)\b/i,
    /\bharga (bersih|pokok)\b/i,
    /\b\d{1,2}\s*%\s*(commission|komisi|for (the )?agents?|agent|agen|fee)/i,
    /\b(commission|komisi|fee)\b[^\n%]{0,30}\d{1,2}\s*%/i,
  ],
  min_stay: [
    /\b\d+\s*(nights?|malam)\b/i,
    /\bmin\w{0,6}\s*(stay|sewa)?\b[^\n]{0,30}\b(\d+\s*(nights?|malam|hari|days?|weeks?|minggu|months?|bulan|years?|tahun)|harian|mingguan|bulanan|daily|weekly|monthly)\b/i,
    /\b(tidak|gak|ga|nggak|no)\s+(ada\s+)?min\w*\b/i,
    /\bi'?d do (monthly|yearly)\b|\blooking for (1|one) year\b/i,
    /\bmin(imum|imal|\.)?\s*(stay|sewa|rent\w*|period|kontrak|lease|booking|contract)?\s*(is|nya|:|of)?\s*\d/i,
    /\b\d+\s*(nights?|malam|days?|hari|weeks?|minggu|months?|bulan|years?|tahun)\s*(minimum|min\b|minimal)/i,
    /\b(no minimum|tidak ada minim\w*|gak ada minim\w*|ga ada minim\w*|tanpa minim\w*|no min stay)\b/i,
    /\b(yearly only|tahunan (saja|aja)|only (yearly|monthly|long[- ]?term)|hanya (tahunan|bulanan))\b/i,
    /\b(monthly|bulanan|1 month|1 bulan)\s*(is\s*)?(ok|okay|fine|bisa|boleh|possible)\b/i,
    /\bminimum stay\b[^\n]{0,30}\b(requirement|required|needed)\b/i,
  ],
  availability: [
    /\b(available|availab\w*|avail|kosong|tersedia|free|ready|vacant)\b[^\n]{0,30}\b(from|mulai|on|now|sekarang|dari|start\w*|until|till|sampai|hingga|after|setelah|next|depan)\b/i,
    /\b(available|ready|kosong|tersedia|free)\s*(now|sekarang|immediately|langsung)\b/i,
    /\b(rented|occupied|booked|taken|di ?sewa\w*|tersewa|terisi|ada (tenant|penyewa|tamu))\b[^\n]{0,30}\b(until|till|sampai|sampe|hingga|s\.?d\.?|for|selama)\b/i,
    /\b(fully booked|full ?booked|sudah penuh|not available|tidak (tersedia|available)|belum (kosong|tersedia|available))\b/i,
    /\b(avail\w*|kosong|tersedia|free)\b[^\n]{0,12}\b\d{1,2}\s*(jan|feb|mar|apr|mei|may|jun|jul|agu|aug|sep|okt|oct|nov|des|dec)\w*/i,
  ],
  viewing: [
    /\b(anytime|any ?time|kapan (saja|aja)|setiap (hari|saat))\b/i,
    /\bwelcome to (visit|view|come|see the villa)/i,
    /\b(can|could|bisa|boleh|silahkan|silakan)\s+(come|visit|view|survey|survei|datang|mampir|lihat (villa\w*|langsung|unit\w*|lokasi))\b/i,
    /\b(viewing|visit|survey|survei|lihat|showing|inspection|inspeksi|kunjung\w*)\b[^\n]{0,40}\b(bisa|ok|okay|possible|welcome|available|tomorrow|besok|lusa|jam|pm|am)\b/i,
    /\b(besok|tomorrow|lusa)\b[^\n]{0,25}\b(bisa|ok|jam|at|\d)/i,
    /\bjam\s*\d{1,2}\b/i,
    /\b\d{1,2}([:.]\d{2})?\s*(am|pm)\b/i,
    /\b(before|after|sebelum|setelah)\s*(jam\s*)?\d{1,2}\b/i,
  ],
  photos: [
    /drive\.google|dropbox\.com|wetransfer|we\.tl\/|photos\.app\.goo|photos\.google|icloud\.com\/sharedalbum|instagram\.com|airbnb\.[a-z.]+\/rooms|booking\.com\/hotel/i,
    /Комментарий к (изображению|видео)|_Отправлен[оа]? (фото|видео|изображение|файл)_/i,
    /\b(here (are|is)|attached|terlampir|berikut)\b[^\n]{0,30}\b(photos?|pictures?|pics|foto|video|gambar)\b/i,
    /\b(photos?|pictures?|foto|video)\b[^\n]{0,30}\b(sent|attached|di atas|above|sudah (saya |kami )?(kirim|share))\b/i,
    /\b(instagram|ig)\b[^\n]{0,15}@?\w/i,
  ],
  pin: [
    /maps\.app\.goo\.gl|goo\.gl\/maps|google\.[a-z.]+\/maps|maps\.google\.|share\.google\/|_Отправлен[аоы]? (геолокация|местоположение|локация)_/i,
    /\b(jl\.?|jalan|gang|gg\.)\s+[A-Z]/,
  ],
  owner: [
    /\b(i'?m|i am|we'?re|we are|saya|sy|aku|kami)\s+(the\s+|a\s+|an\s+|sebagai\s+|selaku\s+)?(owner|pemilik|yang punya|yg punya|manager|manajer|management|pengelola|agent|agen|assistant|asisten|staff|staf|reception\w*|resepsionis|marketing|sales|developer|guest services|concierge|representative|caretaker|pengurus)\b/i,
    /\bmy (own )?(villa|property|house|rumah)\b|\bvilla (saya|kami|sy)\b/i,
    /\b(owner|pemilik)\s*(here|langsung|lsg|directly)\b|\blangsung (yg|yang) punya\b|\bdirect owner\b/i,
    /\b(kelola|manage\w*|handle\w*)\s+(sendiri|it myself|by myself|ourselves|directly)\b/i,
    /\bon behalf of (the )?owner\b|\b(dengan|dgn|with)\s+(the\s+)?owner\s*(nya)?\s*(langsung|lsg|directly)\b|\bowner'?s (representative|assistant|team|family|wife|husband)\b/i,
    /\b(management company|property management|we manage|kami kelola|dikelola oleh)\b/i,
    // "We are managing it", "I just manage these properties", "im the one handling the villa".
    /\b(i|we|saya|sy|kami)\s*('m|'re|am|are)?\s*(just\s+|only\s+|currently\s+)?(manag\w*|handl\w*|running|look\w* after|kelola|pegang|urus)\b/i,
    /\bthe one (handling|managing|in charge)\b|\bmanaging (the |this )?villa\b|\bworking with (the )?management\b/i,
    /\b(owned|managed) (and (managed|owned) )?by\b/i,
    /\b(vm|gm|pic)\b(?=[^\n]{0,20}\bvilla)/i,
    /\b(PT|CV)\.?\s+[A-Z][a-z]+/,
  ],
};

/** A short yes/no straight after our one-point question answers that point ("Yes" to "is it including our 10%?"). */
const SHORT_ANSWER = /^\s*(yes|yep|yup|ya|iya|iyah|betul|benar|correct|sure|sudah|udah|belum|no|not yet|include\w*|exclud\w*|termasuk|nett?)\b/i;

const STILL_RENTING_SAID =
  /\b(still available|masih (tersedia|available|kosong|disewakan|bisa)|(it'?s|it is) available|available for (long|monthly|yearly)|bisa (untuk )?(long ?term|bulanan|tahunan)|open (to|for) (long|monthly|yearly)|not available|tidak (tersedia|available)|sudah (disewa|tersewa|laku)|already (rented|taken|let))\b/i;
/** Engagement older than this does not make "is it still available?" a repeat. */
const STILL_RENTING_WINDOW_MS = 30 * 86_400_000;

function clip(s: string, n = 110): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function jt(idr: number | null): string | null {
  return idr && idr > 0 ? `${Math.round(idr / 1_000_000)} juta` : null;
}

/** Facts first (they carry values), the thread's own words for everything the extraction left null. */
export function threadKnown(lines: ThreadLine[], facts: ListingFacts | null, asOf: Date = new Date()): OwnerThreadKnown {
  const known: Partial<Record<OwnerPoint, KnownPoint>> = {};
  const put = (p: OwnerPoint, v: KnownPoint) => {
    if (!known[p]) known[p] = v;
  };

  if (facts) {
    if (facts.bedrooms) put("bedrooms", { how: "facts", said: `${facts.bedrooms} bedrooms` });
    const price = [jt(facts.monthlyIdr) && `${jt(facts.monthlyIdr)} a month`, jt(facts.yearlyIdr) && `${jt(facts.yearlyIdr)} a year`, facts.priceNote]
      .filter(Boolean)
      .join(", ");
    if (price) put("price", { how: "facts", said: price });
    if (facts.commission !== "unknown") put("commission", { how: "facts", said: facts.commission === "included" ? "includes our 10%" : "net, our 10% on top" });
    else if (facts.theirCommissionPct !== null) put("commission", { how: "facts", said: `they offer ${facts.theirCommissionPct}%` });
    if (facts.minStayMonths !== null) put("min_stay", { how: "facts", said: `${facts.minStayMonths} month(s)` });
    if (facts.availableFrom || facts.freeFromIso) put("availability", { how: "facts", said: facts.availableFrom ?? facts.freeFromIso! });
    if (facts.viewableFrom) put("viewing", { how: "facts", said: facts.viewableFrom });
    if (facts.photosLink) put("photos", { how: "facts", said: facts.photosLink });
    if (facts.mapsLink) put("pin", { how: "facts", said: facts.mapsLink });
    if (facts.counterpart !== "unclear") put("owner", { how: "facts", said: facts.counterpart });
  }

  let ownerReplied = false;
  let lastOwnerAt: Date | null = null;
  let lastEngagedAt = 0;
  const earlier: ThreadLine[] = [];
  const read = lines.filter((m) => m.sentAt.getTime() < asOf.getTime());
  for (const m of read) {
    if (m.senderType === "lead" && (m.text ?? "").trim()) {
      const own = villaSideWords(m, earlier);
      if (own.trim()) {
        ownerReplied = true;
        lastOwnerAt = m.sentAt;
        let engaged = STILL_RENTING_SAID.test(own);
        const sentences = own.split(/(?<=[.!?])\s+|\n/).filter((s) => s.trim());
        for (const p of Object.keys(SAID) as SaidPoint[]) {
          const hit = sentences.find((s) => {
            // "Can you come tomorrow at 10?" is a viewing answer; "is it including your commission?" is not a commission one.
            if (p !== "viewing" && p !== "photos" && p !== "pin" && QUESTION_SENTENCE.test(s.trim())) return false;
            if (p === "commission" && PROMISE.test(s) && !/\d\s*%|\d[\d.,]*\s*(jt|juta|mio|million|idr|rp)\b/i.test(s)) return false;
            return SAID[p].some((rx) => rx.test(s));
          });
          if (hit) {
            put(p, { how: "thread", said: clip(hit) });
            if (p === "price" || p === "availability" || p === "viewing" || p === "min_stay" || p === "bedrooms") engaged = true;
          }
        }
        // "Yes" right after our question about exactly one point answers that point.
        const ourLast = [...earlier].reverse().find((e) => e.senderType !== "lead" && (e.text ?? "").trim());
        const lastTheirs = [...earlier].reverse().find((e) => e.senderType === "lead");
        const answersUs = ourLast && (!lastTheirs || lastTheirs.sentAt.getTime() < ourLast.sentAt.getTime());
        if (answersUs && own.trim().split(/\s+/).length <= 12 && SHORT_ANSWER.test(own) && !QUESTION_SENTENCE.test(own.trim())) {
          const ourAsks = [...new Set((ourLast!.text ?? "").split(/(?<=[.!?])\s+|\n/).flatMap((s) => asksIn(s)))];
          if (ourAsks.length === 1) put(ourAsks[0]!, { how: "thread", said: `"${clip(own, 60)}" to our question about ${POINT_LABEL[ourAsks[0]!]}` });
        }
        if (engaged) lastEngagedAt = m.sentAt.getTime();
      }
    }
    earlier.push(m);
  }
  if (lastEngagedAt && asOf.getTime() - lastEngagedAt < STILL_RENTING_WINDOW_MS) {
    put("still_renting", { how: "thread", said: "they have been talking to us about renting it in the last 30 days" });
  }
  return { lines: read, ownerReplied, lastOwnerAt, known, facts };
}

async function readThread(leadId: string): Promise<ThreadLine[]> {
  return db
    .select({ senderType: leadMessagesTable.senderType, text: leadMessagesTable.text, sentAt: leadMessagesTable.sentAt })
    .from(leadMessagesTable)
    .where(and(eq(leadMessagesTable.leadId, leadId), sql`${leadMessagesTable.text} IS NOT NULL`))
    .orderBy(asc(leadMessagesTable.sentAt));
}

/**
 * The shared check for one card. `facts` when the caller already extracted them (the reply
 * generator); otherwise the stored `listing_facts` when they are newer than the villa side's last
 * message, else a fresh extraction (`extract: false` never calls a model — the autopilot gate).
 * `asOf` replays the thread as it stood at a moment, reading nothing written after it and
 * persisting nothing.
 */
export async function ownerThreadKnown(
  leadId: string,
  o: { facts?: ListingFacts | null; extract?: boolean; asOf?: Date } = {},
): Promise<OwnerThreadKnown> {
  const asOf = o.asOf ?? new Date();
  let lines: ThreadLine[] = [];
  try {
    lines = (await readThread(leadId)).filter((m) => m.sentAt.getTime() < asOf.getTime());
  } catch (err) {
    logger.warn({ err, leadId }, "owner-thread-known: thread unreadable");
  }
  let facts: ListingFacts | null | undefined = o.facts;
  if (facts === undefined) {
    const lastOwner = [...lines].reverse().find((m) => m.senderType === "lead");
    if (!o.asOf) {
      const [row] = await db
        .select({ facts: leadsSyncTable.listingFacts, at: leadsSyncTable.listingFactsAt })
        .from(leadsSyncTable)
        .where(eq(leadsSyncTable.leadId, leadId))
        .limit(1)
        .catch(() => []);
      const fresh = row?.facts && row.at && (!lastOwner || row.at.getTime() >= lastOwner.sentAt.getTime());
      if (row?.facts && (fresh || o.extract === false)) facts = row.facts as unknown as ListingFacts;
    }
    if (facts === undefined && o.extract !== false && lastOwner) {
      const convo = lines.map((m) => `${m.senderType}: ${m.text}`).join("\n");
      facts = await extractListingFacts(convo, o.asOf ? undefined : leadId).catch(() => null);
    }
  }
  return threadKnown(lines, facts ?? null, asOf);
}

/** The prompt lines: what is settled, in the villa side's own words where the facts had no value. */
export function knownPromptBlock(k: OwnerThreadKnown): string {
  const rows = (Object.keys(k.known) as OwnerPoint[]).map((p) => {
    const v = k.known[p]!;
    return v.how === "facts" ? `- ${POINT_LABEL[p]}: ${v.said}` : `- ${POINT_LABEL[p]}: they wrote "${v.said}"`;
  });
  if (!rows.length) return "";
  return `\nALREADY GIVEN BY THE VILLA SIDE IN THIS THREAD. Never ask for any of it again, not reworded, not "just to confirm", not as part of a list. If it helps, mention it as known ("noted, 45 juta including our 10%") and ask only for what is not here:\n${rows.join("\n")}\n`;
}

// ── The finished draft ─────────────────────────────────────────────────────────────────────────

const WORD_CUE =
  /\b(could you|can you|would you|will you|please (send|share|let|confirm|advise|info)|let me know|may i (know|ask|confirm|double check|check)|mind (sharing|sending)|send (me|us|over)|share (with )?(me|us)|boleh|bisa (di ?bantu|dibantu|tolong|minta|info|share|kirim)|mohon (info|dikonfirmasi|konfirmasi|kirim|dibantu|di bantu)|tolong|minta|apakah|berapa|kapan|sekalian|info(kan)?)\b|\w+kah\b|^\s*(is|are|do|does|did|will|would|could|can|may|what|when|how|which|who|ada|ini)\b/i;

/**
 * The part of a sentence that asks. "Noted the price, could you send a few photos?" asks for photos;
 * the price before the cue is a statement. Without a word cue a question mark makes the whole
 * sentence the ask; without either the sentence asks nothing.
 */
function askPart(sentence: string): string | null {
  const cue = WORD_CUE.exec(sentence);
  if (cue) {
    const clauseStart = sentence.lastIndexOf(",", cue.index);
    return sentence.slice(clauseStart + 1);
  }
  return sentence.includes("?") ? sentence : null;
}

/** A concrete day or time: proposing or confirming a visit, never the open "when could we view it?". */
const CONCRETE_TIME =
  /\b(besok|tomorrow|lusa|today|hari ini|nanti|monday|tuesday|wednesday|thursday|friday|saturday|sunday|senin|selasa|rabu|kamis|jumat|jum'at|sabtu|minggu ini|\d{1,2}\s*(am|pm)|jam\s*\d|pukul\s*\d|\d{1,2}[:.]\d{2}|tgl\.?\s*\d|tanggal\s*\d|\d{1,2}\s*(sept?|oct|okt|nov|dec|des|jan)\w*)\b/i;
/** Our own visit: an inspection, our photos or video. A booking move, not a repeated qualification point. */
const OUR_VISIT = /\b(inspe\w*|inspeksi|photo ?shoot|ambil (photo|foto|video)|take (photos?|pictures?|a video)|record|rekam|datang ke|come (by|over))\b/i;
/** Asking again because the first one failed or was not enough — not a repeat. */
const AGAIN =
  /\b(ulang|again|lagi|watermark|more|lebih banyak|resolution|original|tanpa|without|non|kedua|second|higher|coba|tidak sampai|belum (masuk|sampai|terima)|didn'?t (come|arrive|go)|not (received|come through)|resend|kirim ulang)\b/i;

const ASKED: Record<OwnerPoint, RegExp> = {
  bedrooms: /\b(bed ?rooms?|jumlah kamar|berapa kamar|kamar tidur\w*|how many rooms|number of rooms)\b/i,
  commission: /10\s*%|\b(commission|komisi|agency fee|nett? (price|rate)|harga (bersih|net\w*))\b/i,
  price: /\b(rates?|prices?|pricing|harga\w*|biaya sewa|price ?list|how much|berapa (harga|sewa|biaya))\b/i,
  min_stay: /\b(minimum (stay|rental|period|lease|term|booking)|min\.? stay|minimal (sewa|kontrak|stay|booking)\w*|minimum sewa|sewa minimal|shortest (stay|rental|period))\b/i,
  availability: /\b(available from|date it'?s (available|free)|free from|availability|tersedia mulai|mulai kapan|kosong mulai|tanggal (available|kosong|tersedia)\w*|when (is|will|does) (it|the villa)[^?]{0,30}(free|available)|kapan\b[^?]{0,30}\b(kosong|tersedia|available|free|bisa disewa))\b/i,
  // Only the open "when could it be seen" question. "so clients can see it before we schedule a
  // viewing" or "kabari saya biar bisa jadwalkan tamu untuk lihat villanya" asks nothing about when.
  viewing: /\b(earliest (day|date|time)|when (could|can|would) (we|i|a client|clients) (bring|view|see|come|show|visit)|what day[^?]{0,30}(view|visit|see|show)|kapan\b[^?]{0,30}\b(lihat|visit|datang|survey|bawa)|hari (paling cepat|apa)[^?]{0,40}(lihat|visit|datang|bawa|ajak)|tanggal berapa[^?]{0,40}(lihat|visit|datang|bawa|ajak))\b/i,
  photos: /\b(photos?|pictures?|pics|foto\w*|gambar|videos?)\b/i,
  pin: /\b(location pin|pin (location|lokasi)|exact location|maps? (link|pin)|share (the |your )?location|titik lokasi|lokasi (pin|villa\w*|nya)|google maps|share ?loc|pin)\b/i,
  owner: /\b(are you the owner|owner'?s (own )?team|management company|who i'?m coordinating|handled by you|are you (managing|handling)|dikelola (sendiri|oleh)|(kakak|bapak|ibu|anda|kak|pak|bu) (owner|pemilik)|apakah\b[^?]{0,25}\b(owner|pemilik)|punya (bapak|ibu|kak\w*|anda|pak|bu) sendiri|pegang untuk (pemilik|owner)\w*)\b|\b(owner|pemilik)\b[^?]{0,50}\b(or|atau)\b/i,
  still_renting: /\b(still (looking to rent|available|renting|for rent|open to|interested in renting)|is it (still )?available|masih (disewakan|tersedia|available|kosong|bisa disewa|mau disewakan)|are you still)\b/i,
};

/** The owner points a sentence asks for (empty when it asks nothing of the villa side). */
export function asksIn(whole: string): OwnerPoint[] {
  const sentence = askPart(whole);
  if (!sentence) return [];
  const pts = (Object.keys(ASKED) as OwnerPoint[]).filter((p) => ASKED[p].test(sentence));
  const out = new Set(pts);
  // "is it still available" is the still-renting check, not a date question.
  if (out.has("still_renting")) out.delete("availability");
  if (out.has("viewing") && (CONCRETE_TIME.test(sentence) || OUR_VISIT.test(sentence))) out.delete("viewing");
  if (out.has("photos") && (AGAIN.test(sentence) || OUR_VISIT.test(sentence))) out.delete("photos");
  if (out.has("pin") && AGAIN.test(sentence)) out.delete("pin");
  // A counter-offer or a figure put to them is negotiation, not a repeated question.
  if (COUNTER_OFFER.test(sentence)) {
    out.delete("commission");
    out.delete("price");
  }
  return [...out];
}

const COUNTER_OFFER =
  /\b(would you be able to do|could you do|can you do|how about|what about|bagaimana kalau|gimana kalau|bisa (di ?)?(nego|turun|kurang)|we could list|kami bisa (listing|pasang)|would .{0,20}work for you)\b/i;
const YEARLY = /\b(yearly|annual|per year|a year|tahunan\w*|per tahun|setahun)\b/i;
const MONTHLY = /\b(monthly|per month|a month|bulanan\w*|per bulan|sebulan)\b/i;

/**
 * Whether a point asked in this sentence is already answered. Price and commission asked together
 * ("the rate including our 10%") are ONE question: repeated only when both are known. A price
 * without its commission position leaves the legitimate "does that include our 10%?" open; a known
 * commission position leaves an unknown price open. Asking only the period they have not quoted is
 * not a repeat either.
 */
function knownIn(sentence: string, pts: OwnerPoint[], k: OwnerThreadKnown): (p: OwnerPoint) => boolean {
  const pair = pts.includes("price") && pts.includes("commission");
  const otherPeriod = asksOtherPeriod(sentence, k.facts);
  return (p) => {
    if (p === "price" || p === "commission") {
      if (otherPeriod) return false;
      if (pair) return Boolean(k.known.price && k.known.commission);
    }
    return Boolean(k.known[p]);
  };
}

/** Asking for the one period they have not quoted ("and the yearly one?") is not a repeat. */
function asksOtherPeriod(sentence: string, facts: ListingFacts | null): boolean {
  const yearlyOnly = YEARLY.test(sentence) && !MONTHLY.test(sentence);
  const monthlyOnly = MONTHLY.test(sentence) && !YEARLY.test(sentence);
  if (!facts) return yearlyOnly;
  return (yearlyOnly && !facts.yearlyIdr) || (monthlyOnly && !facts.monthlyIdr);
}

export type RepeatFinding = { sentence: string; repeated: OwnerPoint[]; open: OwnerPoint[] };
export type StripResult = { text: string; changed: boolean; removed: RepeatFinding[]; kept: RepeatFinding[] };

const LIST_LEAD =
  /^(.*?\b(could you (please )?(send( me| us)?( over)?|share( with me| with us)?|let me know|confirm|tell me)|can you (send|share|confirm)( me| us)?|would you (please )?(share|send|confirm)|please (send|share|confirm)|may i (know|confirm|double check)|let me know|boleh (di ?bantu |dibantu |minta |tolong )?(info|share|kirim)?|mohon (info|dikonfirmasi|konfirmasi))\s*)/i;

/** Drop the items of a list-shaped ask that are already known ("bedrooms, the rate and the minimum stay"). */
function trimList(sentence: string, k: OwnerThreadKnown): string | null {
  const lead = sentence.match(LIST_LEAD);
  if (!lead) return null;
  const head = lead[1]!;
  let body = sentence.slice(head.length);
  const tail = body.match(/[?.!]*\s*$/)?.[0] ?? "";
  body = body.slice(0, body.length - tail.length);
  const indo = /\b(dan|serta|ya)\b/i.test(sentence) && !/\b(and|the)\b/i.test(sentence);
  const items = body.split(/\s*,\s*(?:and\s+|dan\s+|serta\s+)?|\s+(?:and|dan|serta|plus)\s+/i).filter((s) => s.trim());
  if (items.length < 2) return null;
  const keep = items.filter((it) => {
    const pts = (Object.keys(ASKED) as OwnerPoint[]).filter((p) => ASKED[p].test(it));
    return !(pts.length && pts.every(knownIn(it, pts, k)));
  });
  if (keep.length === items.length || keep.length === 0) return null;
  const joiner = indo ? " dan " : " and ";
  const list = keep.length === 1 ? keep[0]! : `${keep.slice(0, -1).join(", ")}${joiner}${keep[keep.length - 1]}`;
  return `${head}${list}${tail || "?"}`;
}

const CLOSER_WITHOUT_ASK = /^(that'?s (all|everything)\b.*|itu (saja|aja)\b.*|once we have (it|those|that)\b.*)$/i;

/**
 * Remove every sentence that asks the villa side for something already known; a list-shaped ask
 * keeps its open items. A sentence mixing known and open points that cannot be trimmed is kept and
 * reported in `kept` — the caller decides (one model rewrite, or `dropMixed`).
 */
export function stripRepeatedAsks(text: string, k: OwnerThreadKnown, o: { dropMixed?: boolean } = {}): StripResult {
  const removed: RepeatFinding[] = [];
  const kept: RepeatFinding[] = [];
  const outLines: string[] = [];
  let droppedStillRenting = false;
  for (const line of (text ?? "").split("\n")) {
    const sentences = line.split(/(?<=[.!?])\s+/);
    const keepS: string[] = [];
    for (let s of sentences) {
      if (droppedStillRenting) {
        s = s.replace(/^(if so|if yes|kalau (masih|iya|ya)|jika (masih|iya|ya))\s*,\s*/i, "");
        s = s.charAt(0).toUpperCase() + s.slice(1);
        droppedStillRenting = false;
      }
      const pts = asksIn(s);
      const isKnown = knownIn(s, pts, k);
      const repeated = pts.filter(isKnown);
      if (!repeated.length) {
        keepS.push(s);
        continue;
      }
      const open = pts.filter((p) => !isKnown(p));
      const finding = { sentence: s, repeated, open };
      if (!open.length) {
        removed.push(finding);
        if (repeated.includes("still_renting")) droppedStillRenting = true;
        continue;
      }
      const trimmed = trimList(s, k);
      const trimmedPts = trimmed ? asksIn(trimmed) : [];
      if (trimmed && !trimmedPts.some(knownIn(trimmed, trimmedPts, k))) {
        removed.push(finding);
        keepS.push(trimmed);
        continue;
      }
      if (o.dropMixed) {
        removed.push(finding);
        continue;
      }
      kept.push(finding);
      keepS.push(s);
    }
    outLines.push(keepS.join(" ").trim());
  }
  let out = outLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (removed.length) {
    const stillAsks = out.split(/(?<=[.!?])\s+|\n/).some((s) => asksIn(s).length > 0 || /\?/.test(s));
    if (!stillAsks) {
      out = out
        .split("\n")
        .map((l) => l.split(/(?<=[.!?])\s+/).filter((s) => !CLOSER_WITHOUT_ASK.test(s.trim())).join(" "))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }
  }
  return { text: out, changed: removed.length > 0, removed, kept };
}

/**
 * For an AI draft: strip, and when a sentence mixes a repeated point with an open one, ONE cheap
 * rewrite that removes only the repeated part; whatever still repeats after that is dropped.
 * Never returns a draft that re-asks a known point.
 */
export async function removeRepeatedAsks(text: string, k: OwnerThreadKnown, leadId?: string): Promise<StripResult> {
  const first = stripRepeatedAsks(text, k);
  if (!first.kept.length) return first;
  const points = [...new Set(first.kept.flatMap((f) => f.repeated))];
  try {
    const out = await chatCompletion({
      model: HELPER_MODEL,
      label: "owner-draft:repeat-strip",
      max_tokens: 400,
      temperature: 0,
      system: `You edit a WhatsApp message to a villa owner. The owner has ALREADY answered these points: ${points
        .map((p) => POINT_LABEL[p])
        .join("; ")}. Remove only the part of each question that asks for those points again. Keep every other word, the language, the greeting and the remaining questions exactly as written. Return the message only.`,
      messages: [{ role: "user", content: first.text }],
    });
    const rewritten = (out.content ?? "").trim();
    if (rewritten) {
      const second = stripRepeatedAsks(rewritten, k, { dropMixed: true });
      return { text: second.text, changed: true, removed: [...first.removed, ...first.kept, ...second.removed], kept: [] };
    }
  } catch (err) {
    logger.warn({ err, leadId }, "owner-thread-known: rewrite failed — dropping the mixed sentences");
  }
  const dropped = stripRepeatedAsks(first.text, k, { dropMixed: true });
  return { text: dropped.text, changed: true, removed: [...first.removed, ...dropped.removed], kept: [] };
}

/**
 * The last gate before anything leaves for an owner (autopilot): stored facts plus the thread, no
 * model call, mixed sentences dropped. `text` empty means nothing worth sending is left.
 */
export async function guardOwnerDraft(leadId: string, text: string): Promise<StripResult & { known: OwnerThreadKnown }> {
  const known = await ownerThreadKnown(leadId, { extract: false });
  const r = stripRepeatedAsks(text, known, { dropMixed: true });
  const meaningful = r.text.replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).filter(Boolean).length >= 3;
  return { ...r, text: meaningful ? r.text : "", known };
}
