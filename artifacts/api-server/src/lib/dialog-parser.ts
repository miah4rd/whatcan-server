export interface ParsedMessage {
  at: Date;
  from: "us" | "lead";
  senderName: string;
  text: string;
  channel: string | null; // e.g. "whatsapp", "telegram", "email", "amocrm"
}

export interface DialogSummary {
  messages: ParsedMessage[];
  lastMessage: ParsedMessage | null;
  lastOurMessage: ParsedMessage | null;
  lastLeadMessage: ParsedMessage | null;
  leadRepliedAfterUs: boolean;
  lastLeadChannel: string | null; // channel the lead is being contacted through (from bot/manager senders)
}

/**
 * Extract the messaging channel from an amoCRM sender string.
 *
 * The channel is embedded in BOT and MANAGER senders, NOT in client senders.
 * Real formats found in content:
 *   "WAhelp (bot - WAhelp)"           → whatsapp
 *   "WhatsApp (bot - WhatsApp)"       → whatsapp
 *   "Amojo Bot (bot - amocrm)"        → amocrm
 *   "Michael (менеджер - amocrm)"     → amocrm
 *   "Telegram (bot - Telegram)"       → telegram
 *   "Mario Hrsak (клиент - Mario…)"   → null (name, not channel)
 *
 * Returns lowercase canonical channel: "whatsapp" | "telegram" | "instagram" |
 * "amocrm" | "email" — or null when not determinable.
 */
export function extractChannelFromSender(senderName: string): string | null {
  // Only bot and manager senders carry channel info
  const m = senderName.match(/\((?:bot|менеджер|manager)\s*[-–]\s*([^)]+)\)/i);
  if (!m) return null;
  const raw = m[1]!.trim().toLowerCase();
  if (raw === "wahelp" || raw === "whatsapp" || raw === "wa") return "whatsapp";
  if (raw === "telegram") return "telegram";
  if (raw === "instagram") return "instagram";
  if (raw === "amocrm" || raw === "amo") return "amocrm";
  if (raw === "email" || raw === "mail") return "email";
  if (raw === "viber") return "viber";
  return raw; // unknown source — return raw value
}

// Global regex — finds all message entries regardless of separator (newline or spaces).
// Matches: "11.05.2026 05:53:03 Sender Name (role - source) → message text"
// Uses lookahead for the next date OR end of string to capture the text boundary.
const GLOBAL_MSG_RE =
  /(\d{2}\.\d{2}\.\d{4})\s+(\d{2}:\d{2}:\d{2})\s+(.+?)\s+(?:→|->)\s*(.*?)(?=\s*\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}:\d{2}|$)/gs;

function parseDate(dateStr: string, timeStr: string): Date | null {
  const [day, month, year] = dateStr.split(".");
  const [hour, min, sec] = timeStr.split(":");
  if (!day || !month || !year || !hour || !min || !sec) return null;
  const d = new Date(
    Date.UTC(
      parseInt(year, 10),
      parseInt(month, 10) - 1,
      parseInt(day, 10),
      parseInt(hour, 10),
      parseInt(min, 10),
      parseInt(sec, 10),
    ),
  );
  return isNaN(d.getTime()) ? null : d;
}

function isOurSender(senderPart: string): boolean {
  // Lead messages always have (клиент - …) or (client - …) in the sender part.
  // Everything else — (менеджер - amocrm), (bot - amocrm), (manager - wahelp),
  // (менеджер - whatsapp), SalesBot, WAHelp, etc. — is treated as "us".
  return !/\((клиент|client)\s*[-–]/i.test(senderPart);
}

export function parseDialogContent(content: string): DialogSummary {
  const messages: ParsedMessage[] = [];

  // Reset lastIndex for global regex reuse
  GLOBAL_MSG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = GLOBAL_MSG_RE.exec(content)) !== null) {
    const [, dateStr, timeStr, sender, text] = m;
    const at = parseDate(dateStr!, timeStr!);
    if (!at) continue;

    const senderTrimmed = sender!.trim();
    const fromWho: "us" | "lead" = isOurSender(senderTrimmed) ? "us" : "lead";
    // Channel is only determinable from bot/manager senders ("us"), not client senders
    const channel = fromWho === "us" ? extractChannelFromSender(senderTrimmed) : null;
    messages.push({
      at,
      from: fromWho,
      senderName: senderTrimmed,
      text: (text ?? "").trim(),
      channel,
    });
  }

  // Sort chronologically
  messages.sort((a, b) => a.at.getTime() - b.at.getTime());

  const lastMessage = messages.at(-1) ?? null;
  const lastOurMessage = [...messages].reverse().find((m) => m.from === "us") ?? null;
  const lastLeadMessage = [...messages].reverse().find((m) => m.from === "lead") ?? null;

  // "Human" messages from us = NOT automated bot responses.
  // Bot auto-replies (bot - amocrm) are excluded so they don't mask a lead reply.
  const lastHumanOurMessage =
    [...messages].reverse().find(
      (m) => m.from === "us" && !/\(bot\s*[-–]\s*amocrm\)/i.test(m.senderName),
    ) ?? null;

  // Lead replied after us if:
  // 1. Lead's last message is after the last HUMAN (non-bot) message from us, OR
  // 2. Bot auto-responded within 30 min of lead's last message
  //    (Ф5 triggers after bot replies, so content ends with bot — use time window)
  const BOT_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
  const botRespondedAfterLead =
    !!lastLeadMessage &&
    !!lastOurMessage &&
    lastOurMessage.at.getTime() > lastLeadMessage.at.getTime() &&
    lastOurMessage.at.getTime() - lastLeadMessage.at.getTime() < BOT_WINDOW_MS &&
    /\(bot\s*[-–]\s*amocrm\)/i.test(lastOurMessage.senderName);

  const leadRepliedAfterUs =
    (!!lastLeadMessage &&
      !!lastHumanOurMessage &&
      lastLeadMessage.at.getTime() > lastHumanOurMessage.at.getTime()) ||
    botRespondedAfterLead;

  // Channel is in "us" messages (bot/manager senders), not in lead messages.
  // Take the most recent "us" message that has a known channel.
  const lastLeadChannel =
    [...messages].reverse().find((m) => m.from === "us" && m.channel !== null)?.channel ?? null;

  return { messages, lastMessage, lastOurMessage, lastLeadMessage, leadRepliedAfterUs, lastLeadChannel };
}

/**
 * Count consecutive messages from "us" at the tail of the conversation —
 * i.e. how many of our touches in a row the lead has left unanswered.
 * Used to gauge how "cold" a lead has gone without a hardcoded threshold
 * table: 0 = lead spoke last, 1-2 = normal follow-up, 3+ = going cold.
 */
export function countTrailingOurMessages(messages: ParsedMessage[]): number {
  let n = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.from === "us") n++;
    else break;
  }
  return n;
}

/**
 * Format parsed messages as a clean, AI-readable conversation.
 * Returns the last `limit` messages formatted as:
 *   [Broker]: text
 *   [Lead]: text
 */
// Default is generous (not a tight recency window) so the AI sees the whole
// conversation, including the lead's original request at the very start —
// real conversations top out around 150 messages, well under this cap.
export function formatDialogForAI(messages: ParsedMessage[], limit = 500): string {
  const recent = messages.slice(-limit);
  return recent
    .map((m) => {
      const role = m.from === "us" ? "Broker" : "Lead";
      return `[${role}]: ${m.text.trim()}`;
    })
    .join("\n");
}

// Number of calendar days to the next follow-up, indexed by levelIndex passed to nextFollowupDate().
// level 0 → next calendar day (1st follow-up)
// level 1 → 3 calendar days after (2nd follow-up)
// level 2 → 5 calendar days after (final follow-up)
export const FOLLOWUP_DELAY_DAYS = [1, 3, 5];

// Bali timezone offset (UTC+8)
const BALI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Returns midnight (00:00) in Bali timezone N calendar days after `fromDate`.
 * Always returns the START of a day so the CRM task has no specific time.
 *
 * Example: fromDate = July 10 13:00 Bali, days=1 → July 11 00:00 Bali.
 * Example: fromDate = July 10 13:00 Bali, days=3 → July 13 00:00 Bali.
 */
export function nextFollowupDate(
  fromDate: Date,
  levelIndex: number,
  delayDays: number[] = FOLLOWUP_DELAY_DAYS,
): Date | null {
  const days = delayDays[levelIndex];
  if (days === undefined) return null; // max follow-up level reached

  // Shift to Bali clock, floor to start of current Bali day, add N days,
  // set to 23:59:59 of target day so the task shows as "Today" all day in AmoCRM,
  // then shift back to UTC.
  const baliMs = fromDate.getTime() + BALI_OFFSET_MS;
  const baliDayStart = Math.floor(baliMs / DAY_MS) * DAY_MS;
  const targetBaliEndOfDay = baliDayStart + days * DAY_MS + (DAY_MS - 1000); // 23:59:59 Bali
  return new Date(targetBaliEndOfDay - BALI_OFFSET_MS);
}
