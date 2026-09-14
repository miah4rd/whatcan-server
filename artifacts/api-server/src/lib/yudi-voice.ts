/**
 * Yudi's own voice with villa owners — ONE source for every generator that writes to an owner
 * (owner, 14.09.2026: "проанализируй, как Юди обычно бронирует в его WhatsApp, и скопируй этот
 * стиль, чтобы выглядело, как он это делает, а не как ты придумал"; and the same day, relayed by
 * Yudi: autopilot messages to owners sound robotic).
 *
 * What counts as Yudi's words: `lead_messages.sender_type = 'broker'` on HIS Rental Listings cards —
 * typed on his phone and synced through WAhelp. Copilot sends are `bot` and are not his words, even
 * when he approved them.
 *
 * The trap: Amelia writes to villas from her phone to book her clients' viewings, and her lines land
 * on the same cards with the same `sender_id` (the WAhelp integration account is one for both phones).
 * So Amelia is filtered by text: a line that names her, a line with a skin-toned emoji (🙏🏻 👍🏻 are
 * hers; Yudi types a plain 🙏), and every line on that card in the 36 hours after a line that names
 * her, unless a later line names Yudi. The team chat card (Nikita ↔ Yudi/Amelia) is skipped too.
 *
 * The rule from [[broker-voice-over-rules]]: the trigger lives in code, the WORDS come from here and
 * from his lessons (`correctionsPromptBlock(broker, "owner_intake")`), and no generator puts an example
 * sentence of its own into a prompt.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";
import { ownWords, type ThreadMsg } from "./listing-progress";

export type OwnerLang = "id" | "en";
export type VoiceLine = { leadId: string; at: Date; text: string; lang: OwnerLang };

const HOUR = 3_600_000;
const CACHE_MS = 15 * 60_000;
/** Internal team conversations that sit in the Rental Listings funnel — not an owner thread. */
const TEAM_CARDS = new Set<string>(["23499347"]);

const AMELIA = /\bamelia\b/i;
const YUDI = /\byudi\b/i;
const SKIN_TONE = /[\u{1F3FB}-\u{1F3FF}]/u;
const TEAM_TALK = /\bnikita\b|\bnik\b|copilot|\bbots?\b|auto ?(sen[dt]|type|reply)|dikirim otomatis|sistem kami|\bpunel\b|\bpanel\b/i;

/**
 * His words without the text he quoted. A WhatsApp reply is stored as `>> quote⏎reply`, and the
 * quote is often the owner's own reply-with-quote, so `ownWords` (exact match of a whole earlier
 * message) leaves it in: "With guest?" and "Villa sudah kami siapkan…" read as Yudi's on 14.09.
 * Here every leading line found inside any earlier message of the thread is dropped.
 */
function stripQuote(text: string, earlier: ThreadMsg[]): string {
  if (!text.trimStart().startsWith(">>")) return text;
  const lines = text.replace(/^\s*>>\s*/, "").split("\n");
  const seen = earlier.map((m) => (m.text ?? "").replace(/\s+/g, " "));
  let k = 0;
  while (k < lines.length) {
    const l = lines[k]!.replace(/\s+/g, " ").trim();
    if (l && !(l.length >= 3 && seen.some((s) => s.includes(l)))) break;
    k++;
  }
  return lines.slice(k).join("\n");
}

const ID_WORDS =
  /\b(yang|bisa|boleh|kak|ka|pak|bu|ibu|bapak|sudah|belum|untuk|dengan|saya|sy|kami|terima ?kasih|terimakasih|makasih|baik|nggih|tidak|ada|besok|hari ini|jam|villa ?nya|mohon|maaf|selamat|pagi|siang|sore|malam|iya|oke|dong|nya|apa|kapan|berapa)\b/gi;
const EN_WORDS =
  /\b(the|is|are|you|your|we|our|for|and|please|thanks|thank you|available|would|could|when|what|hello|hi|morning|afternoon|yes|no|it|this|that|will|can|have)\b/gi;

/** The language of a text sample: Indonesian or English, by function words. */
export function textLanguage(text: string): OwnerLang | null {
  const id = (text.match(ID_WORDS) ?? []).length;
  const en = (text.match(EN_WORDS) ?? []).length;
  if (id === 0 && en === 0) return null;
  return id > en ? "id" : "en";
}

/**
 * The language this owner's thread is in: what the villa side itself writes (the last ten of its
 * messages), else what we last wrote to them, else English — the listing prompt's default.
 */
export function ownerThreadLanguage(messages: Array<{ senderType: string; text: string | null }>): OwnerLang {
  const theirs = messages.filter((m) => m.senderType === "lead" && (m.text ?? "").trim()).slice(-10);
  const fromThem = textLanguage(theirs.map((m) => m.text).join("\n"));
  if (fromThem) return fromThem;
  const ours = messages.filter((m) => m.senderType !== "lead" && (m.text ?? "").trim()).slice(-3);
  return textLanguage(ours.map((m) => m.text).join("\n")) ?? "en";
}

let cache: { at: number; lines: VoiceLine[] } | null = null;

/**
 * Every line Yudi typed on his phone to a villa owner's side in the last `days` (default 60), oldest
 * first, with the owner text he quoted removed. Cached for 15 minutes; an unreadable table returns [].
 */
export async function yudiPhoneLines(days = 60): Promise<VoiceLine[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.lines;
  const lines: VoiceLine[] = [];
  try {
    const res = await db.execute(sql`
      SELECT m.lead_id, m.sender_type, m.text, m.sent_at
        FROM lead_messages m
        JOIN leads_sync l ON l.lead_id = m.lead_id
       WHERE lower(coalesce(l.pipeline, '')) = 'rental listings'
         AND lower(coalesce(l.responsible_user, '')) = 'yudi'
         AND m.text IS NOT NULL
         AND m.sent_at > now() - make_interval(days => ${days})
       ORDER BY m.lead_id, m.sent_at`);
    const rows = (res.rows ?? []) as Array<{ lead_id: string; sender_type: string; text: string; sent_at: string | Date }>;
    let i = 0;
    while (i < rows.length) {
      const leadId = rows[i]!.lead_id;
      const thread: ThreadMsg[] = [];
      let ameliaUntil = 0;
      for (; i < rows.length && rows[i]!.lead_id === leadId; i++) {
        const r = rows[i]!;
        const m: ThreadMsg = { senderType: r.sender_type, text: r.text, sentAt: new Date(r.sent_at) };
        const earlier = thread.slice(-12);
        thread.push(m);
        if (TEAM_CARDS.has(leadId) || m.senderType !== "broker") continue;
        const raw = m.text ?? "";
        const t = m.sentAt.getTime();
        if (AMELIA.test(raw)) {
          ameliaUntil = t + 36 * HOUR;
          continue;
        }
        if (YUDI.test(raw)) ameliaUntil = 0;
        if (t < ameliaUntil || SKIN_TONE.test(raw) || TEAM_TALK.test(raw)) continue;
        // stripQuote first: ownWords drops the leading ">>" even when it could not find the quote.
        const text = ownWords({ ...m, text: stripQuote(raw, earlier) }, earlier).replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
        if (text.length < 4) continue;
        lines.push({ leadId, at: m.sentAt, text, lang: textLanguage(text) ?? "en" });
      }
    }
  } catch (err) {
    logger.warn({ err }, "yudi-voice: could not read Yudi's phone lines (non-fatal)");
  }
  lines.sort((a, b) => a.at.getTime() - b.at.getTime());
  cache = { at: Date.now(), lines };
  return lines;
}

/** Yudi asking the villa side to let him come: an inspection, a visit, his own photos or video. */
export const INSPECTION_ASK_MOVE =
  /\b(inspe\w*|inspeksi\w*|survei|survey|visit\w*|kunjung\w*|berkunjung|datang|come (by|and|to|over)|ambil (photo|foto|video)|take (photo|pictures|video)\w*|photo ?shoot|record (a )?(short )?video|video (tour|walk ?through))\b/i;
const ASKS = /\?|\b(apakah|apa boleh|any chance|is it possible|will it be possible|should it be possible|could i|may i)\b/i;
/** A viewing for a client is Amelia's move, not an inspection; a line about our own media is Yudi's. */
const CLIENT_VIEWING = /\b(client|klien|tamu|guest)\w*\b/i;
const OWN_MEDIA = /\b(inspe\w*|video|photo\w*|foto|rekam|record|walk ?through)\b/i;

/**
 * Does this text (OUR words, quote removed) ask the villa side to let us come — an inspection, a
 * visit, our own photos or video? The one definition: Yudi's examples are picked by it, and the
 * booking ladder counts our asks by it.
 */
export function isInspectionAsk(text: string): boolean {
  const t = text ?? "";
  if (!INSPECTION_ASK_MOVE.test(t) || !ASKS.test(t)) return false;
  return !(CLIENT_VIEWING.test(t) && !OWN_MEDIA.test(t));
}

/**
 * Yudi's own inspection asks, newest first — in `lang` first, then the other language when there
 * are too few. Each is one message (greeting and reason included, the way he wrote it), links and
 * quoted text removed, at most `maxLen` characters.
 */
export async function yudiInspectionAskExamples(o: { lang?: OwnerLang; limit?: number; maxLen?: number } = {}): Promise<string[]> {
  const limit = o.limit ?? 6;
  const maxLen = o.maxLen ?? 400;
  const lines = (await yudiPhoneLines()).filter((l) => {
    if (/https?:\/\//i.test(l.text) || l.text.length > maxLen) return false;
    if (!INSPECTION_ASK_MOVE.test(l.text) || !ASKS.test(l.text)) return false;
    if (CLIENT_VIEWING.test(l.text) && !OWN_MEDIA.test(l.text)) return false;
    return true;
  });
  const newest = [...lines].reverse();
  const ordered = o.lang ? [...newest.filter((l) => l.lang === o.lang), ...newest.filter((l) => l.lang !== o.lang)] : newest;
  const out: string[] = [];
  for (const l of ordered) {
    const flat = l.text.replace(/\s*\n\s*/g, " / ");
    if (out.some((x) => x.slice(0, 40) === flat.slice(0, 40))) continue;
    out.push(flat);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Yudi's recent lines to owners for any move a caller names (`move`), or his general voice when no
 * move is given: short lines he typed, newest first, same language first. For generators that need
 * his tone (greeting, honorifics, length) rather than one specific move.
 */
export async function yudiStyleExamples(o: { move?: RegExp; lang?: OwnerLang; limit?: number; minLen?: number; maxLen?: number } = {}): Promise<string[]> {
  const limit = o.limit ?? 6;
  const minLen = o.minLen ?? 25;
  const maxLen = o.maxLen ?? 300;
  const lines = (await yudiPhoneLines()).filter(
    (l) => !/https?:\/\//i.test(l.text) && l.text.length >= minLen && l.text.length <= maxLen && (!o.move || o.move.test(l.text)),
  );
  const newest = [...lines].reverse();
  const ordered = o.lang ? [...newest.filter((l) => l.lang === o.lang), ...newest.filter((l) => l.lang !== o.lang)] : newest;
  const out: string[] = [];
  for (const l of ordered) {
    const flat = l.text.replace(/\s*\n\s*/g, " / ");
    if (out.some((x) => x.slice(0, 40) === flat.slice(0, 40))) continue;
    out.push(flat);
    if (out.length >= limit) break;
  }
  return out;
}

/** The prompt lines that carry the examples. No sentence of our own: only his, quoted. */
export function yudiExamplesBlock(examples: string[], what = "writes to villa owners"): string {
  if (!examples.length) return "";
  return `\nThis is how Yudi ${what}: his own recent WhatsApp messages, typed on his phone ("/" marks a line break). Same voice, same moves, same length:\n${examples.map((e) => `  · "${e}"`).join("\n")}`;
}
