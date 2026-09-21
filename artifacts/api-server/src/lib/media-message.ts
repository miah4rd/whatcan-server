/**
 * A WhatsApp message with no words in it — a photo, a screenshot, a file, a voice note.
 *
 * amoCRM's timeline carries these as type-89/90 events with `message.type` "picture" / "file" /
 * "video" / "voice" and an empty `text`. The timeline parser dropped every event without text, so a
 * villa owner who answered our price question with a screenshot of his price list had, as far as
 * the bot could tell, said nothing: the nudge asked him the same question again (Yudi, 21.09:
 * "владелец подумал, что я же уже скинул скриншот, зачем он меня повторно спрашивает").
 *
 * The bot cannot read the picture yet: amoCRM keeps chat media in VK Cloud storage, which this
 * server cannot connect to, and Anthropic refuses the URL by robots.txt. So a media message is
 * stored as a marker the rest of the system can reason about — "the villa side answered with a
 * photo" — and a person looks at the picture.
 */
export const MEDIA_MARKER_PREFIX = "[media:";

const KIND_LABEL: Record<string, string> = {
  picture: "photo or screenshot",
  image: "photo or screenshot",
  video: "video",
  file: "file",
  voice: "voice message",
  audio: "voice message",
  sticker: "sticker",
  location: "location pin",
};

/** "[media: photo or screenshot]" / "[media: file price-list.pdf]" — null when there is nothing to mark. */
export function mediaMarker(type: string | undefined | null, fileName?: string | null): string | null {
  const t = (type ?? "").toLowerCase();
  if (!t || t === "text") return null;
  const label = KIND_LABEL[t] ?? t;
  const name = (fileName ?? "").trim().replace(/[\[\]]/g, "");
  return `${MEDIA_MARKER_PREFIX} ${label}${name && t === "file" ? ` ${name.slice(0, 80)}` : ""}]`;
}

/** Is this stored text only a media marker (no words of their own)? */
export function isMediaOnly(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  return t.startsWith(MEDIA_MARKER_PREFIX) && t.endsWith("]") && t.indexOf("]") === t.length - 1;
}

/** A photo, screenshot or file — something that can carry an answer (not a sticker or a voice note). */
export function isDocumentMedia(text: string | null | undefined): boolean {
  return isMediaOnly(text) && /photo or screenshot|file/.test(text ?? "");
}
