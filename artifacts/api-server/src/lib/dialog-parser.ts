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
 * Human-readable relative age of a timestamp ("3 months ago", "yesterday",
 * "2 hours ago"). Used so the AI can reason about how stale a conversation is
 * instead of treating a months-old exchange as if it happened today.
 */
export function formatRelativeAge(from: Date, now: Date = new Date()): string {
  const ms = Math.max(0, now.getTime() - from.getTime());
  const mins = Math.floor(ms / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours > 1 ? "s" : ""} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return `${weeks} week${weeks > 1 ? "s" : ""} ago`;
  }
  if (days < 365) {
    const months = Math.max(1, Math.floor(days / 30));
    return `${months} month${months > 1 ? "s" : ""} ago`;
  }
  const years = Math.floor(days / 365);
  return `${years} year${years > 1 ? "s" : ""} ago`;
}

/**
 * Build a compact timing summary the AI can use to calibrate its follow-up:
 * how long since the last message overall, since the lead last wrote, and
 * since we last wrote — plus who spoke last and the text of the lead's last
 * message (so the model can judge whether it actually warranted a reply, e.g.
 * a bare "ok, thanks, see you" does not, an unanswered real question does).
 */
export function describeConversationTiming(
  messages: ParsedMessage[],
  now: Date = new Date(),
): string {
  if (messages.length === 0) return "No conversation history yet.";
  const last = messages[messages.length - 1]!;
  const lastLead = [...messages].reverse().find((m) => m.from === "lead") ?? null;
  const lastOur = [...messages].reverse().find((m) => m.from === "us") ?? null;

  const lines: string[] = [];
  lines.push(`Today is ${now.toISOString().slice(0, 10)}.`);
  lines.push(
    `Most recent message in this conversation: ${formatRelativeAge(last.at, now)} (from ${last.from === "us" ? "you, the broker" : "the lead"}).`,
  );
  if (lastLead) {
    lines.push(`Lead's last message: ${formatRelativeAge(lastLead.at, now)} — "${lastLead.text.slice(0, 160)}"`);
  } else {
    lines.push("The lead has never sent a message.");
  }
  if (lastOur) lines.push(`Your last message: ${formatRelativeAge(lastOur.at, now)}.`);
  return lines.join("\n");
}

/**
 * Format parsed messages as a clean, AI-readable conversation.
 * Returns the last `limit` messages formatted as:
 *   [Broker]: text
 *   [Lead]: text
 * When `includeDates` is true, each line is prefixed with the message date
 * (`[2026-05-10 14:30 · Broker]: ...`) so the AI can see the real time spread
 * between messages, not just their order.
 */
// Default is generous (not a tight recency window) so the AI sees the whole
// conversation, including the lead's original request at the very start —
// real conversations top out around 150 messages, well under this cap.
export function formatDialogForAI(messages: ParsedMessage[], limit = 500, includeDates = false): string {
  const recent = messages.slice(-limit);
  return recent
    .map((m) => {
      const role = m.from === "us" ? "Broker" : "Lead";
      if (includeDates) {
        const stamp = m.at.toISOString().slice(0, 16).replace("T", " ");
        return `[${stamp} · ${role}]: ${m.text.trim()}`;
      }
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
