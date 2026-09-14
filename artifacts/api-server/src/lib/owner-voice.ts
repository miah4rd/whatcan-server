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
