/**
 * Sanitise an outgoing WhatsApp message before handing it to amoCRM's Salesbot.
 *
 * BUG this fixes: the Salesbot / WAhelp delivery pipeline TRUNCATES the message at
 * the first emoji. Real cases — the client received only "Hey Huzaifah 👋" and
 * "…so I wanted to check in 🙂", and the rest of the message never went out (the
 * broker had to resend the tail by hand). An emoji is an astral-plane code point
 * (a UTF-16 surrogate pair); somewhere in the Salesbot→WAhelp hand-off the string
 * is cut there. Until that's fixed on the integration side, we strip emoji from
 * the text we send so the WHOLE message is delivered.
 *
 * Only pictographic/emoji code points and their joiners are removed. Ordinary
 * text, punctuation, em-dashes, curly quotes and accented Latin (names) are left
 * intact — those are Basic-Multilingual-Plane characters and deliver fine.
 */
export function stripEmojiForDelivery(text: string): string {
  if (!text) return text;
  return text
    // Emoji pictographs, regional-indicator letters, variation selector (U+FE0F),
    // zero-width joiner (U+200D) and combining keycap (U+20E3). The astral-plane
    // pictographs are what trigger the truncation. Needs the /u flag.
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}️‍⃣]/gu, "")
    // Tidy the gaps a removed emoji leaves behind.
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
