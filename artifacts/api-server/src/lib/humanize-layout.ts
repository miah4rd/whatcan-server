/**
 * How a message LOOKS in WhatsApp (owner, 19.09.2026). An owner answered an
 * autopilot reply with "nice automatic answer. So not serious". Measured over
 * a week: the bot's median message is 36–44 words, Yudi's and Amelia's own are
 * 8–10. The owner's standard, with a screenshot of his own message: one message
 * is fine, but split into short paragraphs by meaning with an empty line
 * between them — greeting, then each point on its own.
 *
 * Applied at the one send path (deliverText) to every line. Only a long wall is
 * touched: a short message, or one already laid out in paragraphs, goes as the
 * broker or the model wrote it.
 */

const LONG_WORDS = 25;
const PARA_MAX_WORDS = 22;

const words = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

/** A greeting that deserves its own line: "Hi Artem,", "Selamat pagi kak,", "Hello!" */
const GREETING = /^((hi|hello|hey|good (morning|afternoon|evening)|selamat (pagi|siang|sore|malam)|halo|hallo|dear)\b[^.!?,\n]{0,30}[,!.])\s+/i;

/** Sentence ends — not inside numbers ("45.5"), common abbreviations or a URL. */
function sentences(text: string): string[] {
  const out: string[] = [];
  const re = /[.!?]+(?=\s|$)/g;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    const piece = text.slice(start, end);
    if (/\b(e\.g|i\.e|approx|incl|min|max|jl|no|pak|bu|mr|mrs|ms|dr)\.$/i.test(piece.trim())) continue;
    if (/https?:\/\/\S*$/.test(piece.trim())) continue;
    out.push(piece.trim());
    start = end;
  }
  if (text.slice(start).trim()) out.push(text.slice(start).trim());
  return out.filter(Boolean);
}

export function humanizeLayout(text: string): string {
  if (!text) return text;
  const t = text.replace(/\r\n/g, "\n").trim();
  if (words(t) < LONG_WORDS) return t;
  // Already laid out in paragraphs by a person or the model: keep it.
  if (/\n\s*\n/.test(t)) return t.replace(/\n{3,}/g, "\n\n");

  // Single line breaks already mark the points: make each a paragraph.
  if (t.includes("\n")) {
    return t
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .join("\n\n");
  }

  let rest = t;
  const paras: string[] = [];
  const g = GREETING.exec(rest);
  if (g && words(g[1]!) <= 6) {
    paras.push(g[1]!.trim());
    rest = rest.slice(g[0].length);
    rest = rest.charAt(0).toUpperCase() + rest.slice(1);
  }
  let cur = "";
  for (const s of sentences(rest)) {
    if (!cur) { cur = s; continue; }
    if (words(cur) + words(s) <= PARA_MAX_WORDS && words(cur) < 12) cur = `${cur} ${s}`;
    else { paras.push(cur); cur = s; }
  }
  if (cur) paras.push(cur);
  return paras.join("\n\n");
}

/**
 * A WhatsApp Business automatic reply, not a person: "Thank you for contacting
 * Kawung Villa…", "Terima kasih telah menghubungi…", "Please kindly wait, we
 * will reply…". The autopilot answered three of these on 19.09 as if the owner
 * had written, and re-asked its own question — the second tell of a bot.
 */
const AUTO_REPLY = [
  /thank(s| you) for (contacting|reaching out to|messaging|your message to|choosing)\b/i,
  /terima ?kasih (telah|sudah|atas) (menghubungi|pesan)/i,
  /(please|kindly) (kindly )?wait[^.]{0,40}(reply|respond|get back|assist)/i,
  /(we|our team|staff) will (reply|respond|get back|contact you|assist you)[^.]{0,30}(shortly|soon|as soon as|within)/i,
  /\b(out of (office|business) hours|our (business|office|working) hours|currently (closed|unavailable|away))\b/i,
  /(mohon|harap) (ditunggu|menunggu|tunggu)/i,
  /(apa yang bisa kami bantu|harap beri ?tahukan apa)/i,
];

export function isAutomaticReply(text: string | null | undefined): boolean {
  const s = (text ?? "").trim();
  if (!s) return false;
  return AUTO_REPLY.some((re) => re.test(s));
}
