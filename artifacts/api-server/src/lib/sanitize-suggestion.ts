const BANNED_PHRASES: [RegExp, string][] = [
  // A dash is the single loudest tell that a machine wrote the message. People
  // writing on WhatsApp use commas and full stops; a model reaches for a dash in
  // every second sentence, and the owner's brokers can spot it across the room.
  [/\s*—\s*/g, ", "],
  // The en dash and a spaced hyphen do the same job and used to slip through.
  // Guarded on both sides against digits so a price range ("Rp 30 - 50 million")
  // survives, and requiring spaces so compounds ("long-term", "3-4BR") do too.
  [/(?<=[^\d\s])\s+[–-]\s+(?=[^\d\s])/g, ", "],
  [/Hope you('re| are) doing well[!.]?\s*/gi, ""],
  [/Hope you('re| are) well[!.]?\s*/gi, ""],
  [/[Jj]ust checking in[!.]?\s*/g, ""],
  [/[Hh]appy to help[!.]?\s*/g, ""],
  [/[Hh]appy to reconnect[!.]?\s*/g, ""],
  // Only at the start of a sentence. "Let me know if" → "If you'd like" reads
  // fine there and nowhere else: mid-sentence it produced "could you If you'd
  // like it can be offered on a 12 month contract?", which went into a draft
  // queued for a villa owner. A slightly weak phrase is better than broken
  // English, so a mid-sentence occurrence is left exactly as the model wrote it.
  [/(^|[.!?]\s+)[Ll]et me know if\b/g, "$1If you'd like"],
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
    out = out.replace(pattern, replacement);
  }
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
