/**
 * A filler phrase removed WITH the punctuation after it, and the next word
 * capitalised when the phrase opened a sentence or a line. The plain removal
 * left the comma behind: "Just checking in, where are you at with the search?"
 * became ", where are you at with the search?" (Amelia, 23548815, 15.09.2026).
 */
function filler(phrase: string): [RegExp, (m: string, lead: string | undefined, next: string | undefined) => string] {
  return [
    new RegExp(`(^|[.!?][^\\S\\n]+|\\n)?${phrase}[,!.;:]?[^\\S\\n]*([a-z])?`, "gi"),
    (_m, lead, next) => (lead ?? "") + (next ? (lead !== undefined ? next.toUpperCase() : next) : ""),
  ];
}

const BANNED_PHRASES: Array<[RegExp, string | ((m: string, lead: string | undefined, next: string | undefined) => string)]> = [
  // A dash is the single loudest tell that a machine wrote the message. People
  // writing on WhatsApp use commas and full stops; a model reaches for a dash in
  // every second sentence, and the owner's brokers can spot it across the room.
  [/\s*—\s*/g, ", "],
  // The en dash and a spaced hyphen do the same job and used to slip through.
  // Guarded on both sides against digits so a price range ("Rp 30 - 50 million")
  // survives, and requiring spaces so compounds ("long-term", "3-4BR") do too.
  [/(?<=[^\d\s])\s+[–-]\s+(?=[^\d\s])/g, ", "],
  filler("hope you(?:'re|’re| are) doing well"),
  filler("hope you(?:'re|’re| are) well"),
  filler("just checking in"),
  filler("happy to help"),
  filler("happy to reconnect"),
  // "Let me know if" is filler only as an empty closer ("Let me know if you have
  // any questions"), and that whole sentence goes. Rewriting the phrase itself
  // broke English every time: mid-sentence "could you If you'd like it can be
  // offered on a 12 month contract?" (a draft to a villa owner), and at the
  // start "Let me know if the dates work" → "If you'd like the dates work"
  // (15.09.2026). A "let me know if" that carries a real question stays as written.
  [
    /(^|[.!?]|\n)[^\S\n]*(?:feel free to )?let me know if you (?:have any (?:other |more |further )?questions?|need anything(?: else)?|need any (?:more )?(?:help|info(?:rmation)?))[^.!?\n]*[.!?]?[^\S\n]*/gi,
    "$1",
  ],
  [/[Ff]eel free to reach out\b[^.]*\./g, ""],
  [/[Ff]eel free to reach out/g, ""],
];

// Meta-commentary label lines a model sometimes prepends before the real
// message, despite the OUTPUT RULE — strip them as a safety net rather than
// relying on prompt-following alone.
const PREAMBLE_LABEL_LINE = /^(here'?s?( is)? (the |your |my )?(whatsapp )?(reply|message|response):?|reply:?|message:?|response:?)\s*/i;

export function sanitizeSuggestion(text: string): string {
  let out = text;

  // If the model narrated its reasoning before the actual message, a "---"
  // separator (or a lone line of 3+ dashes) usually marks where the real
  // reply starts — keep only what comes after the LAST such separator.
  const separatorMatches = [...out.matchAll(/^\s*-{3,}\s*$/gm)];
  if (separatorMatches.length > 0) {
    const last = separatorMatches[separatorMatches.length - 1];
    out = out.slice((last.index ?? 0) + last[0].length);
  }
  out = out.replace(PREAMBLE_LABEL_LINE, "").trim();

  for (const [pattern, replacement] of BANNED_PHRASES) {
    out = typeof replacement === "string"
      ? out.replace(pattern, replacement)
      : out.replace(pattern, (m: string, lead?: string, next?: string) => replacement(m, lead, next));
  }
  // Whatever removal left a line opening with a comma or semicolon, it goes.
  out = out.replace(/(^|\n)[^\S\n]*[,;][^\S\n]*/g, "$1");
  // Collapse double commas; collapse multiple spaces on a single line
  // but PRESERVE newlines so property blocks stay separated
  out = out.replace(/,\s*,/g, ",");
  out = out.replace(/[^\S\n]{2,}/g, " "); // collapse spaces/tabs but not newlines
  out = out.replace(/\n{3,}/g, "\n\n");   // max 2 consecutive newlines
  out = out.trim();
  return out;
}

export const AVOID_PHRASES_REMINDER =
  `\nSTRICTLY AVOID these exact phrases: "Happy to help", "Just checking in", "Hope you're well", "Hope you're doing well", "Let me know if". ` +
  `Do NOT use em dashes (—). Replace any dash with a comma or period.`;
