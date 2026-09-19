/**
 * The voice of every owner-facing AI draft: Yudi's own messages, never a sentence of ours.
 *
 * Owner, 14.09.2026, relaying Yudi after he spoke with several owners: the autopilot reads "как будто
 * робот с тобой общается". Measured the same day (CLAUDE.md "The owner is never asked twice, in
 * Yudi's words"): Yudi's phone messages to owners are 8 words at the median, 40% span two or three
 * short lines, 19% carry kak and 19% pak/bu, 12% a plain 🙏; the auto-sent owner messages were 48
 * words, 2% multi-line, and 32% carried the prompt's own sentence "including our 10% agency
 * commission", 29% "that's everything we need", 41% "clients". The model was copying the prompt's
 * example sentences instead of the broker.
 *
 * So the words come from two places only, both his:
 * - `yudi-voice.ts` — the ONE reader of his phone lines on Rental Listings cards (Amelia's lines
 *   filtered out), shared with the inspection booking drafts;
 * - what he actually sent in place of a draft he rewrote by hand.
 * His lessons (`correctionsPromptBlock(broker, "owner_intake")`) follow in the prompt and win.
 * The rule from the viewing push (CLAUDE.md "Every draft after the shortlist pushes for a
 * viewing"): the trigger lives in code, the wording is the broker's, no generator adds an example
 * sentence of its own.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";
import { yudiStyleExamples, yudiExamplesBlock, type OwnerLang } from "./yudi-voice";
import { chatCompletionJSON, WRITER_MODEL } from "./ai-client";

const CACHE_MS = 15 * 60_000;
let rewriteCache: { at: number; lines: string[] } | null = null;

function words(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

function overlap(a: string, b: string): number {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / Math.max(A.size, B.size);
}

/**
 * What Yudi sent instead of a Rental Listings draft he rewrote by hand (not a typo fix: less than
 * 80% of the words shared), newest first, links removed. These are his words: the draft he replaced
 * is never shown to the model, so it cannot be imitated.
 */
export async function yudiRewrittenSends(limit = 3): Promise<string[]> {
  if (rewriteCache && Date.now() - rewriteCache.at < CACHE_MS) return rewriteCache.lines.slice(0, limit);
  const lines: string[] = [];
  try {
    const res = await db.execute(sql`
      SELECT p.suggestion_text, p.final_text
        FROM pending_suggestions p
        JOIN leads_sync l ON l.lead_id = p.lead_id
       WHERE lower(coalesce(l.pipeline, '')) = 'rental listings'
         AND lower(coalesce(p.responsible_user, '')) = 'yudi'
         AND p.status IN ('approved', 'edited')
         AND coalesce(p.auto_sent, false) = false
         AND p.final_text IS NOT NULL
         AND p.created_at > now() - interval '90 days'
       ORDER BY p.created_at DESC
       LIMIT 200`);
    for (const r of (res.rows ?? []) as Array<{ suggestion_text: string | null; final_text: string | null }>) {
      const before = (r.suggestion_text ?? "").trim();
      const after = (r.final_text ?? "").trim();
      if (!after || after === before || /https?:\/\//i.test(after) || after.length > 350) continue;
      if (overlap(before, after) >= 0.8) continue;
      const flat = after.replace(/\s*\n\s*/g, " / ");
      if (lines.some((x) => x.slice(0, 40) === flat.slice(0, 40))) continue;
      lines.push(flat);
      if (lines.length >= 8) break;
    }
  } catch (err) {
    logger.warn({ err }, "owner-voice: could not read Yudi's rewritten drafts (non-fatal)");
  }
  rewriteCache = { at: Date.now(), lines };
  return lines.slice(0, limit);
}

/**
 * The prompt block for an owner-facing draft in `lang`: his phone lines in that language first, his
 * rewrites, and what his messages measurably have in common. Empty when nothing of his is readable —
 * then the prompt's own rules stand alone rather than an invented style.
 */
export async function ownerVoiceBlock(o: { lang: OwnerLang }): Promise<string> {
  const [examples, rewrites] = await Promise.all([
    yudiStyleExamples({ lang: o.lang, limit: 8, minLen: 20, maxLen: 260 }),
    yudiRewrittenSends(3),
  ]);
  if (!examples.length && !rewrites.length) return "";
  const parts: string[] = [
    `\n\nHOW YUDI WRITES TO VILLA OWNERS. This message goes out under his name, so it must read like his own WhatsApp, not like an assistant. Copy his register and his moves, never his facts: the villas, dates, prices and names in these lines belong to other conversations.`,
  ];
  if (examples.length) parts.push(yudiExamplesBlock(examples));
  if (rewrites.length) {
    parts.push(
      `\nDrafts he rewrote by hand before sending, what he actually sent ("/" marks a line break):\n${rewrites.map((e) => `  · "${e}"`).join("\n")}`,
    );
  }
  parts.push(
    `\nWhat his messages have in common, measured on his own messages to owners: a few words to two or three short lines, a line break where a writer would use a long sentence; ${
      o.lang === "id"
        ? "kak, pak or bu with the name, a short thanks, a plain 🙏 at most"
        : "the name, a short thanks, a plain question"
    }; one or two questions, never a checklist read out; no company pitch, no claim about clients searching, no closing formula.`,
  );
  return parts.join("");
}

const TIGHT_WORDS = 22;
const HARD_MAX_WORDS = 30;
const wordCount = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);
// The autopilot judges a waiting draft again every few minutes: a rewrite that
// was rejected once is not paid for again.
const rejected = new Map<string, number>();

/**
 * Owner, 19.09.2026: "сделай тексты короче как у Юди, в целом копируй его стиль". Measured the same
 * day on Rental Listings: the bot's replies 32 words at the median, nudges 37; Yudi's own messages
 * that ask an owner something, 13. An owner wrote back "nice automatic answer. So not serious".
 *
 * The last step for every owner-facing draft (the reply generator, and the autopilot before it
 * sends anything, whoever wrote it): a draft over ~22 words is rewritten ONCE in his voice, from his
 * own short lines — every question and every fact the owner needs stays, the recap of what they
 * said, the explanations and the pitch go. A rewrite that loses the question, grows, or comes back
 * empty is thrown away and the draft goes as it was: shorter is the goal, never a lost ask.
 */
export async function tightenInYudiVoice(text: string, o: { lang: OwnerLang; leadId?: string }): Promise<string> {
  const before = (text ?? "").trim();
  if (wordCount(before) <= TIGHT_WORDS) return before;
  if (rejected.has(before)) return before;
  try {
    const examples = await yudiStyleExamples({ lang: o.lang, limit: 14, minLen: 12, maxLen: 140 });
    const r = await chatCompletionJSON<{ text?: string }>({
      model: WRITER_MODEL,
      label: "owner-tighten",
      max_tokens: 300,
      system:
        `You shorten a WhatsApp message that Yudi, a Bali villa-rental agent, is about to send to a villa owner, so it reads like he typed it himself on his phone.` +
        yudiExamplesBlock(examples) +
        `\n\nRules:\n- Keep every question and every fact the owner needs to act on. Drop what repeats what the owner already said to us, explanations of why we ask, reassurance, company pitch, and closing formulas.\n- ${TIGHT_WORDS} words or fewer if at all possible, never more than ${HARD_MAX_WORDS}.\n- One to three short lines, separated by a line break, like his.\n- Same language as the message (${o.lang === "id" ? "Indonesian" : "English"}), his register: ${o.lang === "id" ? "kak / pak / bu, Baik, Terimakasih" : "Hello / may I know / well noted / thank you"}.\n- No dashes, no emoji except a plain 🙏 if the original had one.\n- Do not add anything that is not in the message.\nReturn JSON {"text": "..."}.`,
      messages: [{ role: "user", content: before }],
    });
    const after = String(r?.text ?? "").trim();
    const askedBefore = /\?/.test(before);
    const ok = after && wordCount(after) < wordCount(before) && wordCount(after) <= HARD_MAX_WORDS + 5 && (!askedBefore || /\?/.test(after));
    if (!ok) {
      logger.warn({ leadId: o.leadId, before: wordCount(before), after: wordCount(after) }, "owner tighten: rewrite rejected — draft kept as written");
      if (rejected.size > 500) rejected.clear();
      rejected.set(before, Date.now());
      return before;
    }
    logger.info({ leadId: o.leadId, before: wordCount(before), after: wordCount(after) }, "owner tighten: draft shortened in Yudi's voice");
    return after;
  } catch (err) {
    logger.warn({ err: String(err), leadId: o.leadId }, "owner tighten failed — draft kept as written");
    return before;
  }
}
