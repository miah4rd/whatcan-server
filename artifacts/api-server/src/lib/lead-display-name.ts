/**
 * The lead's own name as a human should read it, taken from the transcript.
 *
 * amoCRM appends its own source suffix to the sender name — "Name (клиент -
 * Name)" — and the old stripper was `/\s*\([^)]*\)\s*$/`, which cannot survive
 * a name that ALREADY contains brackets: "刘豪 (Liu Hao) (клиент - 刘豪 (Liu
 * Hao))". `[^)]*` stops at the first ")", so nothing matched and the whole
 * suffix reached the broker's morning report verbatim (owner flagged it,
 * 2026-08-19). Cut from the suffix marker instead, which nesting cannot break.
 *
 * Shared on purpose: the inbox card and the report each had their own copy of
 * the regex, and that is exactly how the two drift apart in this codebase.
 */
const AMO_SOURCE_SUFFIX = /\s*\((?:клиент|client|контакт|contact|бот|bot)\s*[-–—].*$/i;

export function cleanLeadName(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const cut = s.replace(AMO_SOURCE_SUFFIX, "").trim();
  // Fall back to the old rule for suffixes that do not name a source, then to
  // the raw value — a name is better shown imperfectly than not at all.
  const legacy = cut || s.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return legacy || s;
}
