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
 * - a bedroom count or a price the text gives for a villa matches one of the attached villas.
 *
 * One rewrite is asked for with the defects named; whatever is still wrong after it is removed
 * sentence by sentence, and a wrong count is replaced with the real one. Nothing is sent from here.
 */
import { chatCompletion, WRITER_MODEL } from "./ai-client";
import { sanitizeSuggestion } from "./sanitize-suggestion";
import { logger } from "./logger";

export type TruthIssue = {
  kind: "silent_client_claim" | "unsourced_amount" | "unsourced_date" | "count" | "villa_mismatch";
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
    if (STRONG_ATTRIBUTION.test(s) || ABOUT_THEIR_DATES.test(s)) {
      const bad = datesIn(s).filter((d) => !dateInSources(d, sources));
      if (bad.length) {
        issues.push({ kind: "unsourced_date", sentence: s, detail: `date(s) ${bad.map((d) => `${d.d}.${d.m}`).join(", ")} given as the client's, but the client/form never named it — keep their own words ("in 1–2 months")` });
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
export async function enforceDraftTruth(o: {
  leadId: string;
  text: string;
  attachments: Attachment[];
  clientTexts: string[];
  formText: string;
}): Promise<string> {
  let issues = checkDraftTruth(o);
  if (issues.length === 0) return o.text;
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

${o.attachments.length ? `THE ${o.attachments.length} VILLAS ATTACHED TO THIS MESSAGE (the truth about bedrooms and prices):\n${villaList}\n` : "NO VILLAS ARE ATTACHED.\n"}
WHAT THE CLIENT ACTUALLY SAID OR FILLED IN (the only source for anything about them):
${[...o.clientTexts.filter((t) => !NOT_THE_CLIENT.test(t.trim())).slice(-6), o.formText].filter(Boolean).join("\n") || "(nothing — they have not written)"}

Rules: never thank them for confirming or say they mentioned anything they did not; never turn a range like "in 1-2 months" into a date; never state a budget they did not give; name exactly as many villas as are attached; give each villa only its own bedrooms and price. Output only the corrected message.`,
      messages: [{ role: "user", content: text }],
      max_tokens: 450,
    });
    const out = sanitizeSuggestion(res.content);
    if (out.trim().length > 20) text = out;
  } catch (err) {
    logger.warn({ err, leadId: o.leadId }, "draft truth: rewrite failed — falling back to removal");
  }

  issues = checkDraftTruth({ ...o, text });
  if (issues.length === 0) return text;
  const count = issues.find((i) => i.kind === "count");
  if (count) text = fixCount(text, o.attachments.length);
  const toRemove = issues.filter((i) => i.kind !== "count" && i.kind !== "villa_mismatch").map((i) => i.sentence);
  if (toRemove.length) text = removeSentences(text, toRemove);
  const left = checkDraftTruth({ ...o, text });
  if (left.length) logger.warn({ leadId: o.leadId, issues: left.map((i) => `${i.kind}: ${i.detail}`) }, "draft truth: defects still present after the fix");
  else logger.info({ leadId: o.leadId }, "draft truth: defects fixed");
  return text;
}
