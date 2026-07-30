import { db, leadMessagesTable, sentMessagesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { parseDialogContent, type ParsedMessage } from "./dialog-parser";

/**
 * The full conversation for a lead, merged from BOTH sources of truth:
 *   • leads_sync.content — webhook-fed, but for WhatsApp / replies sent manually
 *     from the phone it FREEZES and stops recording new messages;
 *   • lead_messages — the timeline poll, which DOES capture our outgoing WhatsApp
 *     replies and the latest incoming.
 * Reading content alone left the bot blind to the newest messages. Dedupe by
 * NORMALISED TEXT (the same message carries different timestamps across the two
 * sources — Moscow UTC+3 in content vs the poll's — so a time key wouldn't match),
 * then sort by time. Used by /suggest and the automatic PUSH generation so no
 * generation path builds a reply from a stale, truncated thread.
 */
export async function getMergedConversation(
  leadId: string,
  content: string | null | undefined,
): Promise<ParsedMessage[]> {
  const norm = (s: string) => (s ?? "").trim().replace(/\s+/g, " ").toLowerCase().slice(0, 160);
  let merged: ParsedMessage[] = [];
  if (content) {
    try {
      merged = parseDialogContent(content).messages.slice();
    } catch {
      /* ignore parse errors */
    }
  }
  try {
    const tl = await db
      .select({
        senderType: leadMessagesTable.senderType,
        text: leadMessagesTable.text,
        sentAt: leadMessagesTable.sentAt,
        channel: leadMessagesTable.channel,
      })
      .from(leadMessagesTable)
      .where(eq(leadMessagesTable.leadId, leadId));
    const seen = new Set(merged.map((m) => norm(m.text)));
    for (const t of tl) {
      const key = norm(t.text ?? "");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push({
        at: t.sentAt ?? new Date(0),
        from: t.senderType === "lead" ? "lead" : "us",
        senderName: t.senderType === "lead" ? "Lead" : "Us",
        text: t.text ?? "",
        channel: t.channel ?? null,
      });
    }
  } catch {
    /* content-only fallback */
  }
  // Our OWN sent record — written the instant we send, with no amoCRM sync lag.
  // Without this, a message the broker just approved doesn't come back when they
  // reopen the lead (content is frozen, the poll hasn't run yet), so the bot
  // looked like it "forgot" what it sent and the broker couldn't copy it. Same
  // normalised-text dedupe so it collapses once the poll syncs the same message.
  try {
    const sent = await db
      .select({ text: sentMessagesTable.messageText, at: sentMessagesTable.createdAt })
      .from(sentMessagesTable)
      .where(eq(sentMessagesTable.leadId, leadId));
    const seen = new Set(merged.map((m) => norm(m.text)));
    for (const s of sent) {
      const key = norm(s.text ?? "");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push({
        at: s.at ?? new Date(0),
        from: "us",
        senderName: "Us",
        text: s.text ?? "",
        channel: "whatsapp",
      });
    }
  } catch {
    /* non-fatal — sent-record enrichment is best-effort */
  }
  merged.sort((a, b) => a.at.getTime() - b.at.getTime());
  return merged;
}
