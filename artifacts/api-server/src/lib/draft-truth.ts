/**
 * A Rental draft says only what is true (owner, 03.10.2026, skills/rental.md §5 "Facts in a draft").
 *
 * 29.09–02.10 six clients who had never written a word got "Thanks for confirming… no pets or kids,
 * workspace not needed", Dmitri got "moving in around 27 October" (his form said "in 1-2 months"),
 * Nicklas got "you mentioned Rp 70 million" (he said 60), and drafts said "here are two" over three
 * or four links. The prompt already forbade inventing; nothing checked. This is the check, in code:
 *
 * - a client who has not written is never thanked for confirming, never told what they "mentioned",
 *   and never has a preference read back that their form does not hold;
 * - an amount or a date put in the client's mouth must be in their own messages or their form;
 * - the number of villas the text names matches the links attached;
 * - a bedroom count or a price the text gives for a villa matches one of the attached villas;
 * - the text never lists the villas: each goes out as its own message with its caption and link
 *   (06.10.2026: lead 23748129 got the three villas of lead 23748097 listed in its text, while its links
 *   were three others; owner: «этот формат бот пусть и использует всегда»);
 * - nothing says a villa is free or available, or from when — that is known only after the villa's owner
 *   confirms it for the villa the client chose (owner, 06.10.2026);
 * - a date or a length of stay given as the client's is in their own words or their form;
 * - links never go under a text that says we have nothing.
 *
 * One rewrite is asked for with the defects named; whatever is still wrong after it is removed
 * sentence by sentence, and a wrong count is replaced with the real one. Nothing is sent from here.
 */
import { chatCompletion, WRITER_MODEL } from "./ai-client";
import { sanitizeSuggestion } from "./sanitize-suggestion";
import { logger } from "./logger";

export type TruthIssue = {
  kind: "silent_client_claim" | "unsourced_amount" | "unsourced_date" | "count" | "villa_mismatch" | "villa_list" | "availability" | "no_options_with_links";
  sentence: string;
  detail: string;
};

type Attachment = { label?: string | null; url?: string | null };

/** System notices that land as the "client's" message but are not the client. */
const NOT_THE_CLIENT = /не установлен whatsapp|whatsapp is not installed|^ad (form|enquiry)\s*:/i;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const NUM_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
const WORD_FOR = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight"];

// The client's words put back to them. Strong: a fact is claimed to be theirs.
const CLAIMS_THEY_SAID = /\b(thanks?\s+(you\s+)?for\s+confirming|you\s+(mentioned|said|told( me)?|confirmed|wrote|shared|noted)|as\s+you\s+(said|mentioned)|good to know|noted that you)\b/i;
const STRONG_ATTRIBUTION = /\b(you\s+(mentioned|said|told|confirmed|wrote|shared)|as\s+you\s+(said|mentioned)|your\s+budget\s+(of|is|was)|budget\s+of|your\s+(max|maximum|limit|ceiling))\b/i;
const ABOUT_THEIR_DATES = /\b(you('re|\s+are)?\s+(moving|arriving|coming|landing|looking to move)|your\s+(move|arrival|check-?in|move-in)|moving\s+in|move-in)\b/i;
// A read-back of what matters to them, with no villa in the sentence.
const PREFERENCE_WORDS = /\b(quiet|construction|pets?|dogs?|cats?|kids|children|baby|workspace|office|enclosed|closed kitchen|garden|modern|balinese)\b/gi;
const MENTIONS_A_VILLA = /\b(villa|bedroom|\dbr|pool|rp\b|idr|million|leasehold|listing|option)/i;
// A preference read back as theirs: addressed to them, or phrased as a want ("no pets or kids", "not needed").
const ABOUT_THEM = /\b(you|your|you're|matters?|need|needed|want|wanted|must|prefer|preferred)\b|\bno (pets|kids|children)\b/i;
// "all under Rp 70 million", "within your range": a ceiling, not a villa's price.
const A_CEILING_OR_THEM = /\b(you|your|you're|budget|under|below|up to|within|max(imum)?|range)\b/i;

function sentencesOf(text: string): string[] {
  // Keeps line breaks as boundaries: WhatsApp drafts are written in short lines.
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Money figures in millions of rupiah: "Rp 30-50 million", "45M", "40jt", "30,000,000". */
function amountsIn(s: string): number[] {
  const out: number[] = [];
  const t = s.replace(/(\d{1,3})[.,](\d{3})[.,](\d{3})\b/g, (_m, a, b, c) => `${Number(`${a}${b}${c}`) / 1_000_000} million`);
  const re = /(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:(?:-|–|to)\s*(\d{1,4}(?:[.,]\d{1,2})?))?\s*(million|mil\b|mln|jt\b|juta|m\b)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    out.push(parseFloat(m[1].replace(",", ".")));
    if (m[2]) out.push(parseFloat(m[2].replace(",", ".")));
  }
  return out;
}

/** Every number a source mentions, plus its per-month value when it reads as a yearly figure. */
function numbersIn(texts: string[]): number[] {
  const out: number[] = [];
  for (const raw of texts) {
    const t = raw.replace(/(\d)[.,](\d{3})[.,](\d{3})\b/g, (_m, a, b, c) => String(Number(`${a}${b}${c}`) / 1_000_000));
    for (const m of t.matchAll(/\d{1,4}(?:[.,]\d{1,2})?/g)) {
      const v = parseFloat(m[0].replace(",", "."));
      if (!Number.isFinite(v)) continue;
      out.push(v, v / 12);
    }
  }
  return out;
}

function sourced(n: number, pool: number[]): boolean {
  return pool.some((p) => Math.abs(p - n) <= 0.6);
}

type DayMonth = { d: number; m: number };
function datesIn(s: string): DayMonth[] {
  const out: DayMonth[] = [];
  const t = s.toLowerCase();
  for (const m of t.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/g)) {
    out.push({ d: Number(m[1]), m: MONTHS.indexOf(m[2]) + 1 });
  }
  for (const m of t.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/g)) {
    out.push({ d: Number(m[2]), m: MONTHS.indexOf(m[1]) + 1 });
  }
  return out;
}

function dateInSources(dm: DayMonth, sources: string[]): boolean {
  const all = sources.join("\n").toLowerCase();
  if (datesIn(all).some((x) => x.d === dm.d && x.m === dm.m)) return true;
  // 27.10 / 27/10 / 10/27
  const pats = [`${dm.d}[./]${dm.m}\\b`, `\\b0?${dm.d}[./]0?${dm.m}\\b`, `\\b0?${dm.m}/0?${dm.d}\\b`];
  return pats.some((p) => new RegExp(p).test(all));
}

function attachmentFacts(attachments: Attachment[]): { bedrooms: Set<number>; prices: number[] } {
  const bedrooms = new Set<number>();
  const prices: number[] = [];
  for (const a of attachments) {
    const l = a.label ?? "";
    for (const m of l.matchAll(/(\d)\s*BR\b/gi)) bedrooms.add(Number(m[1]));
    for (const m of l.matchAll(/Rp\s*([\d.,]+)\s*million/gi)) {
      const v = parseFloat(m[1].replace(",", "."));
      if (Number.isFinite(v)) prices.push(v, v / 12);
    }
  }
  return { bedrooms, prices };
}

/**
 * The text never lists villas (skills/rental.md §5 layout, owner 06.10.2026: «этот формат бот пусть и
 * использует всегда»): each villa goes as its own message, its caption built from that villa's own record,
 * so the words and the link cannot name two different houses. A list line naming a villa is removed.
 */
const LIST_LINE = /^\s*(?:[-•*·–]|\d+[.)])\s+/;
const NAMES_A_VILLA = /\b(\d\s?BR|bedroom|villa|house|apartment|rp\b|idr|million)/i;
export function villaListLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => LIST_LINE.test(l) && NAMES_A_VILLA.test(l));
}

/**
 * Whether a villa is free is never said before the villa's owner has confirmed it for the villa the client
 * chose (skills/rental.md §5, owner 06.10.2026: «То, что на сайте… нельзя использовать боту как базовая
 * правда… Пока не уточним у владельца после того, как человек выбрал»). A promise to check it is fine.
 */
const CLAIMS_AVAILABILITY =
  /\b(free|available|vacant)\s+(right\s+)?(now|immediately|today|straight away|from\b|on\b|in\b|by\b|after\b|until\b|till\b)|\bfrees?\s+up\b|\b(is|are|it's|they're|both|all)\s+(still\s+|currently\s+)?(free|available|vacant)\b|\bready to move in\b|\bwhat'?s available\b|\bavailable for you\b/i;
const PROMISES_TO_CHECK = /\b(check|confirm|verify|ask(ing)?|find out|look into|double-check|clarify)\b/i;
// "no longer available" is what an owner told us, not a promise to the client.
const SAYS_TAKEN = /\b(no longer|not|isn't|aren't|unavailable|taken|booked|rented out)\b/i;
// What the villa's owner told us, passed on as theirs, once the client chose the villa.
const OWNER_SAYS = /\b(owner|landlord)\b.*\b(confirm(ed|s)?|said|says|told|let me know|got back|replied|checked)\b|\b(confirmed|checked|heard back|spoke) with the (owner|landlord)\b/i;
export function availabilityClaims(text: string): string[] {
  return sentencesOf(text).filter((s) => CLAIMS_AVAILABILITY.test(s) && !PROMISES_TO_CHECK.test(s) && !SAYS_TAKEN.test(s) && !OWNER_SAYS.test(s));
}

/** "We have no options" over attached links (Julie, 05.10): one of the two is false (§5). */
const SAYS_NOTHING =
  /\b(no|not any|don't have any|do not have any|nothing)\s+(suitable\s+|matching\s+|good\s+)?(options?|villas?|matches|listings?)\b|\bnothing\s+(that\s+)?(matches|fits|available|suitable)\b/i;

/** A length of stay given as theirs ("your 3 month stay") that they never gave (Daan, 05.10). */
const DURATION = /\b(\d{1,2}|one|two|three|four|five|six|twelve)[\s-]*(months?|years?|weeks?)\b/gi;
const DURATION_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, twelve: 12 };
function durationSourced(n: number, unit: string, sourceLower: string): boolean {
  const u = unit.toLowerCase()[0];
  const words = Object.entries(DURATION_NUM).filter(([, v]) => v === n).map(([w]) => w);
  // "3 months", "3-6 months", "1 to 3 months", "3mo"
  const single = new RegExp(`\\b(${[String(n), ...words].join("|")})\\s*(?:(?:-|–|to)\\s*\\d{1,2}\\s*)?-?\\s*${u}`, "i");
  const rangeEnd = new RegExp(`\\b\\d{1,2}\\s*(?:-|–|to)\\s*${n}\\s*-?\\s*${u}`, "i");
  return single.test(sourceLower) || rangeEnd.test(sourceLower);
}

export function checkDraftTruth(o: {
  text: string;
  attachments: Attachment[];
  /** Everything the client wrote, oldest first. */
  clientTexts: string[];
  /** The Meta form answers and card notes, as text. */
  formText: string;
}): TruthIssue[] {
  const issues: TruthIssue[] = [];
  const clientTexts = o.clientTexts.filter((t) => t.trim() && !NOT_THE_CLIENT.test(t.trim()));
  const silent = clientTexts.length === 0;
  const sources = [...clientTexts, o.formText];
  const sourceNumbers = numbersIn(sources);
  const villas = attachmentFacts(o.attachments);
  const sourceLower = sources.join("\n").toLowerCase();

  // The sentence right after a false "thanks for confirming" is where the invented list sits.
  let afterClaim = false;
  for (const s of sentencesOf(o.text)) {
    if (silent && CLAIMS_THEY_SAID.test(s)) {
      issues.push({ kind: "silent_client_claim", sentence: s, detail: "the client has not written anything — nothing can be 'confirmed' or 'mentioned' by them" });
      afterClaim = true;
      continue;
    }
    const isQuestion = /\?\s*$/.test(s);
    const isBullet = /^[•\-*·]/.test(s);
    if (!MENTIONS_A_VILLA.test(s) && !isQuestion && !isBullet && (ABOUT_THEM.test(s) || afterClaim)) {
      const prefs = [...new Set((s.match(PREFERENCE_WORDS) ?? []).map((w) => w.toLowerCase()))];
      const notTheirs = prefs.filter((w) => !sourceLower.includes(w.replace(/s$/, "")));
      if (prefs.length > 0 && notTheirs.length > 0) {
        issues.push({ kind: "silent_client_claim", sentence: s, detail: `preferences the client never gave: ${notTheirs.join(", ")}` });
        afterClaim = true;
        continue;
      }
    }
    afterClaim = false;
    if (STRONG_ATTRIBUTION.test(s)) {
      const bad = amountsIn(s).filter((n) => !sourced(n, sourceNumbers));
      if (bad.length) {
        issues.push({ kind: "unsourced_amount", sentence: s, detail: `amount(s) ${bad.join(", ")} million put in the client's mouth, but not in their messages or form` });
        continue;
      }
    }
    // Any date in a draft is either the client's — then in their own words or form — or a villa's
    // availability, which a draft never gives (§5, owner 06.10.2026: «да, либо повторяется формулировка
    // которую клиент сам и назвал»). A viewing or a call we propose is our own date, not theirs, and so is
    // a date the villa's owner gave us once the client chose, passed on as the owner's.
    const oursToGive = /\b(view|viewing|visit|inspection|call|meet|meeting|show you|tour)\w*/i.test(s) || OWNER_SAYS.test(s);
    if (!oursToGive) {
      const bad = datesIn(s).filter((d) => !dateInSources(d, sources));
      if (bad.length) {
        issues.push({ kind: "unsourced_date", sentence: s, detail: `date(s) ${bad.map((d) => `${d.d}.${d.m}`).join(", ")} the client/form never named — repeat their own words instead ("in 1–2 months"), or leave the date out` });
        continue;
      }
    }
    if (STRONG_ATTRIBUTION.test(s) || ABOUT_THEIR_DATES.test(s) || ABOUT_THEM.test(s) || /\bstay\b/i.test(s)) {
      const bad = [...s.matchAll(DURATION)].filter((m) => !durationSourced(DURATION_NUM[m[1].toLowerCase()] ?? Number(m[1]), m[2], sourceLower));
      if (bad.length) {
        issues.push({ kind: "unsourced_date", sentence: s, detail: `length of stay "${bad.map((m) => m[0]).join(", ")}" the client/form never gave — repeat their own words or leave it out` });
        continue;
      }
    }
    if (o.attachments.length > 0 && !A_CEILING_OR_THEM.test(s)) {
      const brs = [...s.matchAll(/\b(\d)\s*(?:BR\b|-?\s*bed(?:room)?s?\b)/gi)].map((m) => Number(m[1]));
      const wrongBr = brs.filter((b) => !villas.bedrooms.has(b));
      const prices = [...s.matchAll(/Rp\s*([\d.,]+)\s*(?:million|m\b|jt)/gi)].map((m) => parseFloat(m[1].replace(",", ".")));
      const wrongPrice = prices.filter((p) => !villas.prices.some((v) => Math.abs(v - p) <= 0.6));
      if (wrongBr.length || wrongPrice.length) {
        issues.push({
          kind: "villa_mismatch",
          sentence: s,
          detail: `${wrongBr.length ? `${wrongBr.join("/")}BR` : ""}${wrongBr.length && wrongPrice.length ? " and " : ""}${wrongPrice.length ? `Rp ${wrongPrice.join("/")} million` : ""} matches none of the attached villas`,
        });
      }
    }
  }

  for (const line of villaListLines(o.text)) {
    issues.push({ kind: "villa_list", sentence: line, detail: "a villa listed in the text — the villas go out as their own messages with their own captions; never list, number or describe them in the text" });
  }
  // Only what the villa's owner confirmed may be passed on, and then as the owner's word (06.10.2026: a
  // follow-up with no villas attached still said "free from 10 October" from the site).
  for (const sentence of availabilityClaims(o.text)) {
    issues.push({ kind: "availability", sentence, detail: "says a villa is free or available, or from when — never said before the villa's owner confirms it for the villa the client chose; at most say you will check availability" });
  }
  if (o.attachments.length > 0) {
    for (const sentence of sentencesOf(o.text).filter((x) => SAYS_NOTHING.test(x))) {
      issues.push({ kind: "no_options_with_links", sentence, detail: "says we have nothing while villas are attached — say we are short on that kind of option right now and these are the closest" });
    }
  }

  const n = statedCount(o.text);
  // One link fewer is right only when the text sets the clicked villa apart ("and the one you were looking at").
  const setsClickedApart = /one you were looking at|for comparison|you clicked|from the ad/i.test(o.text);
  if (n !== null && o.attachments.length > 0 && n !== o.attachments.length && !(setsClickedApart && n === o.attachments.length - 1)) {
    issues.push({ kind: "count", sentence: "", detail: `the text speaks of ${n} villa(s), ${o.attachments.length} link(s) are attached` });
  }
  return issues;
}

const COUNT_RE = /\b(one|two|three|four|five|six|[1-6])\s+(more\s+|other\s+|new\s+)?(options?|villas?|places|ones|homes|picks|properties)\b|\bhere are (two|three|four|five|six)\b/i;

function statedCount(text: string): number | null {
  const m = text.match(COUNT_RE);
  if (!m) return null;
  const w = (m[1] ?? m[4] ?? "").toLowerCase();
  return NUM_WORDS[w] ?? (Number(w) || null);
}

const SINGULAR: Record<string, string> = { options: "option", villas: "villa", ones: "one", places: "place", homes: "home", picks: "pick", properties: "property" };
const PLURAL: Record<string, string> = Object.fromEntries(Object.entries(SINGULAR).map(([p, sg]) => [sg, p]));

function fixCount(text: string, n: number): string {
  return text.replace(COUNT_RE, (_whole, _w1, more, noun, w4) => {
    const word = WORD_FOR[n] ?? String(n);
    if (w4) return `here are ${word}`;
    const lower = String(noun).toLowerCase();
    const fixedNoun = n === 1 ? (SINGULAR[lower] ?? lower) : (PLURAL[lower] ?? lower);
    return `${word} ${more ?? ""}${fixedNoun}`.replace(/\s+/g, " ");
  });
}

function removeSentences(text: string, sentences: string[]): string {
  let out = text;
  for (const s of sentences) {
    if (!s) continue;
    out = out.replace(s, "");
  }
  return out
    .split("\n")
    .map((l) => l.replace(/\s{2,}/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The gate. Returns the draft unchanged when nothing is wrong. Otherwise one rewrite with the defects
 * named; whatever remains wrong is then removed in code (a sentence), or corrected in code (a count).
 */
/**
 * The villas go out as their own messages after the text (skills/rental.md §5 layout). The two rewrites
 * below are shown the attached villas so they get the facts right, and on 05.10 one of them wrote the
 * villas back into the text as a numbered list with prices (Daan, 23746857): Amelia deleted it by hand.
 * A rewrite never adds villa lines a draft did not have; if it does, they are cut (owner, 06.10.2026:
 * «исправь»).
 */
const VILLA_LINE = /^\s*\d+[.)]\s+.*(\d\s?BR\b|\bRp\b|bedroom|villa)/i;
function keepVillasOutOfText(before: string, after: string): string {
  if (before.split("\n").some((l) => VILLA_LINE.test(l))) return after;
  const kept = after
    .split("\n")
    .filter((l) => !VILLA_LINE.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return kept.length > 20 ? kept : before;
}
export function withoutVillaList(text: string): string {
  const lines = new Set(villaListLines(text));
  if (!lines.size && !/^\s*also attached:/im.test(text)) return text;
  return text
    .split("\n")
    .filter((l) => !lines.has(l.trim()) && !/^\s*also attached:/i.test(l))
    .join("\n")
    .replace(/:\s*$/gm, ".")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
/**
 * A rewrite that is a note to us instead of the message ("I don't see the actual original message you want me
 * to correct… Could you please share…", Amelia's queue 07.10.2026) is thrown away and the draft stays as it
 * was: the controller never puts a model's own words in front of a client (§5).
 */
const NOTE_TO_US =
  /\b(I (don'?t|do not|cannot|can'?t) see|could you (please )?(share|provide|send)|the (original|actual|full) (whatsapp )?message|you want me to (correct|edit|fix|rewrite)|I'?m meant to edit|once I have (that|it)|I'?ll correct only|as an AI|here is the (corrected|rewritten|fixed) (message|version))\b/i;
export function isNoteToUs(text: string): boolean {
  return NOTE_TO_US.test(text);
}
const VILLAS_SEPARATE =
  "These villas go out as their OWN messages right after this text, each with its caption and link: never list, number, name or describe them in this message.";

/**
 * An internal villa code ("R-UM-024") is ours, never the client's (owner, 08.10.2026: «Внутренний код – это
 * внутренний код. Для внутренних»; skills/rental.md §5). It reaches a draft from the link the client clicked.
 * Outside a link it becomes "that villa"; the links themselves stay as they are.
 */
const INTERNAL_CODE = /(?<![\/\w-])R-[A-Z]{2,4}-\d{2,4}\b/g;
export function withoutInternalCodes(text: string): string {
  if (!INTERNAL_CODE.test(text)) return text;
  INTERNAL_CODE.lastIndex = 0;
  return text
    .replace(/\(\s*R-[A-Z]{2,4}-\d{2,4}\s*\)/g, "")
    .replace(INTERNAL_CODE, "that villa")
    .replace(/\bthe that villa\b/gi, "that villa")
    .replace(/ {2,}/g, " ");
}

export async function enforceDraftTruth(o: {
  leadId: string;
  text: string;
  attachments: Attachment[];
  clientTexts: string[];
  formText: string;
}): Promise<string> {
  o = { ...o, text: withoutInternalCodes(o.text) };
  let issues = checkDraftTruth(o);
  if (issues.length === 0) return o.text;
  // Nothing to correct a message in: a model asked to fix an empty draft answers with a note to us.
  if (o.text.trim().length < 20) return o.text;
  logger.warn({ leadId: o.leadId, issues: issues.map((i) => `${i.kind}: ${i.detail}`) }, "draft truth: defects found — rewriting");

  let text = o.text;
  try {
    const villaList = o.attachments.map((a, i) => `${i + 1}. ${a.label ?? a.url ?? ""}`).join("\n");
    const res = await chatCompletion({
      model: WRITER_MODEL,
      label: "draft-truth",
      system: `You fix specific factual defects in a WhatsApp message a villa-rental broker is about to send to a client. Change ONLY what the list below names; keep the same language, voice, greeting, structure and closing question.

DEFECTS:
${issues.map((i) => `- ${i.detail}${i.sentence ? ` — in: «${i.sentence}»` : ""}`).join("\n")}

${o.attachments.length ? `THE ${o.attachments.length} VILLAS ATTACHED TO THIS MESSAGE (the truth about bedrooms and prices):\n${villaList}\n${VILLAS_SEPARATE}\n` : "NO VILLAS ARE ATTACHED.\n"}
WHAT THE CLIENT ACTUALLY SAID OR FILLED IN (the only source for anything about them):
${[...o.clientTexts.filter((t) => !NOT_THE_CLIENT.test(t.trim())).slice(-6), o.formText].filter(Boolean).join("\n") || "(nothing — they have not written)"}

Rules: never thank them for confirming or say they mentioned anything they did not; never turn a range like "in 1-2 months" into a date or a length of stay — repeat their own words; never state a budget they did not give; never list or describe the villas in the text, they go out as their own messages; never say a villa is free or available, or from when — at most that you will check its availability; never say we have nothing while villas are attached. Output only the corrected message.`,
      messages: [{ role: "user", content: text }],
      max_tokens: 450,
    });
    const out = keepVillasOutOfText(text, sanitizeSuggestion(res.content));
    if (out.trim().length > 20 && !isNoteToUs(out)) text = out;
    else if (isNoteToUs(out)) logger.warn({ leadId: o.leadId, out: out.slice(0, 120) }, "draft truth: the rewrite was a note to us, not a message — draft kept");
  } catch (err) {
    logger.warn({ err, leadId: o.leadId }, "draft truth: rewrite failed — falling back to removal");
  }

  issues = checkDraftTruth({ ...o, text });
  if (issues.length === 0) return text;
  const count = issues.find((i) => i.kind === "count");
  if (count) text = fixCount(text, o.attachments.length);
  // A villa list never reaches the broker, rewrite or not: its lines go, and a lead-in left pointing at
  // nothing ("Here they are:") ends with a full stop.
  text = withoutVillaList(text);
  issues = checkDraftTruth({ ...o, text });
  const toRemove = issues.filter((i) => i.kind !== "count" && i.kind !== "villa_mismatch").map((i) => i.sentence);
  if (toRemove.length) text = removeSentences(text, toRemove);
  const left = checkDraftTruth({ ...o, text });
  if (left.length) logger.warn({ leadId: o.leadId, issues: left.map((i) => `${i.kind}: ${i.detail}`) }, "draft truth: defects still present after the fix");
  else logger.info({ leadId: o.leadId }, "draft truth: defects fixed");
  return text;
}

/**
 * The draft heard the client (owner, 05.10.2026, skills/rental.md §5 "The draft heard the client"):
 * it answers what they asked, does not offer back what they turned down, and does not ask what they
 * already told us. The two-month read found ~10–12 such misses (Viktoria said "Seseh" and got Canggu;
 * a washing-machine question left unanswered). One check by the helper model; a miss gets one rewrite
 * with the defects named. Unreadable → the draft stays as written.
 */
export async function enforceListening(o: {
  leadId: string;
  text: string;
  thread: Array<{ from: "us" | "lead"; text: string }>;
  attachments: Attachment[];
}): Promise<string> {
  const recent = o.thread.filter((m) => (m.text ?? "").trim() && !NOT_THE_CLIENT.test(m.text.trim())).slice(-12);
  if (!recent.some((m) => m.from === "lead")) return o.text;
  const transcript = recent.map((m) => `${m.from === "lead" ? "CLIENT" : "US"}: ${m.text.replace(/\s+/g, " ").slice(0, 400)}`).join("\n");
  try {
    const { chatCompletionJSON, HELPER_MODEL } = await import("./ai-client");
    const verdict = await chatCompletionJSON<{ problems?: string[] }>({
      model: HELPER_MODEL,
      label: "draft-listening",
      system: `You check a villa-rental broker's next WhatsApp draft against the conversation. List ONLY real problems of these three kinds:
1. the client asked something in their latest messages (after our last message) that the draft does not answer;
2. the draft offers again something the client already turned down (an area, a villa, a budget, a size, a style);
3. the draft asks the client for something they already told us.
Ignore tone, length and wording. If there is nothing of these kinds, return an empty list.
JSON only: {"problems": ["short description", …]}`,
      messages: [{ role: "user", content: `CONVERSATION:\n${transcript}\n\nDRAFT:\n${o.text}` }],
      max_tokens: 200,
      temperature: 0,
    });
    const problems = (verdict?.problems ?? []).map((p) => String(p).trim()).filter(Boolean).slice(0, 4);
    if (!problems.length) return o.text;
    logger.warn({ leadId: o.leadId, problems }, "draft listening: the draft missed what the client said — rewriting");
    const villas = o.attachments.map((a, i) => `${i + 1}. ${a.label ?? a.url ?? ""}`).join("\n");
    const res = await chatCompletion({
      model: WRITER_MODEL,
      label: "draft-listening-fix",
      system: `You fix a WhatsApp draft a villa-rental broker is about to send so that it truly answers the client. Fix ONLY these problems, keep the same language, voice, greeting, villas and closing:
${problems.map((p) => `- ${p}`).join("\n")}
${villas ? `The villas attached to this message (do not add or drop any):\n${villas}\n${VILLAS_SEPARATE}\n` : "No villas are attached; do not mention any as attached.\n"}Never invent a fact about a villa or the client; if the answer to their question is not known, say you will check it. Output only the corrected message.`,
      messages: [{ role: "user", content: `CONVERSATION:\n${transcript}\n\nDRAFT:\n${o.text}` }],
      max_tokens: 450,
    });
    const out = keepVillasOutOfText(o.text, sanitizeSuggestion(res.content));
    if (isNoteToUs(out)) {
      logger.warn({ leadId: o.leadId, out: out.slice(0, 120) }, "draft listening: the rewrite was a note to us, not a message — draft kept");
      return o.text;
    }
    return out.trim().length > 20 ? out : o.text;
  } catch (err) {
    logger.warn({ err, leadId: o.leadId }, "draft listening: check failed — draft kept as written");
    return o.text;
  }
}
