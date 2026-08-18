/**
 * amoCRM returns note text HTML-escaped: a scout note quoting a Facebook group
 * name arrives as `FB group &quot;Pererenan Community Housing&quot;`. Stored raw,
 * that reaches two places it must never reach — the broker's card in /m (Amelia
 * flagged it on screen, 2026-08-18) and the prompt, where the model reads the
 * client's own request with entity noise in it.
 *
 * One decoder, shared: the listing-acquisition path had its own copy, which is
 * exactly how the two seeding paths drift apart in this codebase.
 * &amp; is unescaped LAST so `&amp;quot;` cannot turn into a live quote.
 */
export function decodeAmoEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}
