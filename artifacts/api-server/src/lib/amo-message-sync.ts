/**
 * Parses lead dialog content from leads_sync.content into structured lead_messages.
 * The content text blob comes from WAHelp/F5 webhook, not from amoCRM API.
 * Format: "DD.MM.YYYY HH:MM:SS Sender Name (role - source) → message text"
 */
import { db, leadMessagesTable, leadsSyncTable } from "@workspace/db";
import { eq, and, sql, isNotNull } from "drizzle-orm";
import { logger } from "./logger";
import { parseDialogContent, extractChannelFromSender } from "./dialog-parser";
import { createHash } from "crypto";

// ── Deterministic message ID from content fields ──────────────────────────────
function messageId(leadId: string, sentAt: Date, senderName: string, text: string): string {
  const payload = `${leadId}|${sentAt.toISOString()}|${senderName}|${text.slice(0, 200)}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

// ── Parse and store messages for a single lead ────────────────────────────────
export async function syncLeadContent(leadId: string, content: string, responsibleUser: string | null): Promise<number> {
  const parsed = parseDialogContent(content);
  if (parsed.messages.length === 0) return 0;

  let inserted = 0;
  for (const msg of parsed.messages) {
    const amoMsgId = messageId(leadId, msg.at, msg.senderName, msg.text);
    const senderType = msg.from === "us" ? "broker" : "lead";
    const channel = msg.from === "us" ? extractChannelFromSender(msg.senderName) : null;
    const direction = msg.from === "us" ? "outbound" : "inbound";

    try {
      await db
        .insert(leadMessagesTable)
        .values({
          leadId,
          amoMessageId: amoMsgId,
          senderType,
          senderName: msg.senderName,
          senderId: null,
          text: msg.text,
          channel,
          direction,
          sentAt: msg.at,
        })
        .onConflictDoNothing({ target: leadMessagesTable.amoMessageId });
      inserted++;
    } catch {
      // Duplicate — non-fatal
    }
  }
  return inserted;
}

// ── Main sync: parse all leads with content ───────────────────────────────────
export async function syncLeadMessages(): Promise<{ synced: number; leads: number }> {
  // Get all leads that have content
  const leadsWithContent = await db
    .select({
      leadId: leadsSyncTable.leadId,
      content: leadsSyncTable.content,
      responsibleUser: leadsSyncTable.responsibleUser,
    })
    .from(leadsSyncTable)
    .where(and(isNotNull(leadsSyncTable.content), sql`length(${leadsSyncTable.content}) > 50`));

  if (leadsWithContent.length === 0) {
    logger.info("message sync: no leads with content");
    return { synced: 0, leads: 0 };
  }

  logger.info({ leadCount: leadsWithContent.length }, "message sync started");

  let totalSynced = 0;
  let leadsProcessed = 0;

  // Process in batches
  const BATCH_SIZE = 20;
  for (let i = 0; i < leadsWithContent.length; i += BATCH_SIZE) {
    const batch = leadsWithContent.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (lead) => {
        const count = await syncLeadContent(lead.leadId, lead.content!, lead.responsibleUser);
        return { leadId: lead.leadId, count };
      })
    );

    for (const r of results) {
      if (r.status === "fulfilled" && r.value.count > 0) {
        totalSynced += r.value.count;
        leadsProcessed++;
      }
    }
  }

  logger.info({ totalSynced, leadsProcessed, totalLeads: leadsWithContent.length }, "message sync complete");
  return { synced: totalSynced, leads: leadsProcessed };
}

// ── Fetch messages formatted for AI context ───────────────────────────────────
export async function getLeadMessageHistory(leadId: string, limit = 60): Promise<Array<{ from: string; text: string }>> {
  const messages = await db
    .select({
      senderType: leadMessagesTable.senderType,
      text: leadMessagesTable.text,
      sentAt: leadMessagesTable.sentAt,
    })
    .from(leadMessagesTable)
    .where(eq(leadMessagesTable.leadId, leadId))
    .orderBy(leadMessagesTable.sentAt)
    .limit(limit);

  return messages.map((m) => ({
    from: m.senderType === "lead" ? "lead" : "us",
    text: m.text ?? "",
  }));
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

const MESSAGE_SYNC_INTERVAL_MS = 1 * 60 * 1000; // TEMP for testing — revert to 10 * 60 * 1000

export function startMessageSyncScheduler(): void {
  // First sync after 20 seconds (let lead sync finish first)
  setTimeout(async () => {
    try { await syncLeadMessages(); } catch (err) { logger.error({ err }, "initial message sync error"); }
  }, 20_000);

  setInterval(async () => {
    try { await syncLeadMessages(); } catch (err) { logger.error({ err }, "periodic message sync error"); }
  }, MESSAGE_SYNC_INTERVAL_MS);

  logger.info("message sync scheduler started (every 10 min)");
}
