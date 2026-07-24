import { db, leadsSyncTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { chatCompletionJSON } from "./ai-client";
import { parseDialogContent, formatDialogForAI } from "./dialog-parser";
import { logger } from "./logger";

/**
 * The distilled "lead profile" — a small, structured summary the bot maintains
 * per lead so that daily prioritization can be CONTEXT-AWARE without re-reading
 * the raw conversation every day.
 *
 * Cost discipline: this is produced by ONE AI call, and only when the lead has
 * NEW activity since the last distillation (guarded by profileSourceMsgAt vs the
 * lead's last message time). Dormant leads keep their last profile for free.
 */
export type LeadProfile = {
  temperature: "cold" | "warm" | "hot";
  potential: number; // 0-100 latent buying potential
  intent: string; // short phrase of what they're after, or "unclear"
  timeframe: string | null; // e.g. "ready now", "back in spring", "wants a week"
  openQuestion: boolean; // lead asked a real question that's still unanswered
  alive: "alive" | "dead_candidate"; // dead ONLY when content says so, never from silence
  summary: string; // 1-2 line essence
};

const TEMP_VALUES = new Set(["cold", "warm", "hot"]);
const ALIVE_VALUES = new Set(["alive", "dead_candidate"]);

function coerceProfile(raw: Partial<LeadProfile> | null | undefined): LeadProfile {
  const temperature = TEMP_VALUES.has(String(raw?.temperature)) ? (raw!.temperature as LeadProfile["temperature"]) : "warm";
  const aliveVal = ALIVE_VALUES.has(String(raw?.alive)) ? (raw!.alive as LeadProfile["alive"]) : "alive";
  let potential = Number(raw?.potential);
  if (!Number.isFinite(potential)) potential = 40;
  potential = Math.max(0, Math.min(100, Math.round(potential)));
  return {
    temperature,
    potential,
    intent: (typeof raw?.intent === "string" && raw.intent.trim()) ? raw.intent.trim().slice(0, 200) : "unclear",
    timeframe: (typeof raw?.timeframe === "string" && raw.timeframe.trim() && raw.timeframe.trim().toLowerCase() !== "null")
      ? raw.timeframe.trim().slice(0, 120)
      : null,
    openQuestion: raw?.openQuestion === true,
    alive: aliveVal,
    summary: (typeof raw?.summary === "string" && raw.summary.trim()) ? raw.summary.trim().slice(0, 400) : "",
  };
}

/**
 * Read the last profile a lead already has stored (no AI). Returns null if never
 * distilled. Used by the daily ranking, which must stay AI-free.
 */
export function readStoredProfile(row: {
  profileTemperature?: string | null;
  profilePotential?: number | null;
  profileIntent?: string | null;
  profileTimeframe?: string | null;
  profileOpenQuestion?: boolean | null;
  profileAlive?: string | null;
  profileSummary?: string | null;
}): LeadProfile | null {
  if (!row.profileTemperature && row.profilePotential == null) return null;
  return coerceProfile({
    temperature: row.profileTemperature as LeadProfile["temperature"] | undefined,
    potential: row.profilePotential ?? undefined,
    intent: row.profileIntent ?? undefined,
    timeframe: row.profileTimeframe ?? undefined,
    openQuestion: row.profileOpenQuestion ?? undefined,
    alive: row.profileAlive as LeadProfile["alive"] | undefined,
    summary: row.profileSummary ?? undefined,
  });
}

/**
 * Distill (or refresh) a lead's profile from its conversation and persist it.
 *
 * Skips the AI call entirely when the profile is already up to date — i.e. the
 * lead's last message hasn't changed since we last distilled. This is what keeps
 * the whole system cheap: analysis happens once per new lead message, not daily.
 *
 * Returns the (possibly cached) profile, or null when there's no content to judge.
 */
export async function refreshLeadProfile(opts: {
  leadId: string;
  responsibleUser: string | null;
  content: string | null;
  leadStage: string | null;
  leadNotes?: string | null;
  /** last stored profileSourceMsgAt (the lead-message time the current profile reflects) */
  profileSourceMsgAt?: Date | null;
  /** already-stored profile columns, to return unchanged when cache is fresh */
  stored?: Parameters<typeof readStoredProfile>[0];
}): Promise<LeadProfile | null> {
  const content = opts.content ?? "";
  if (content.trim().length < 20) return opts.stored ? readStoredProfile(opts.stored) : null;

  const parsed = parseDialogContent(content);
  const lastLeadAt = parsed.lastLeadMessage?.at ?? null;

  // Cache hit: profile already reflects the lead's most recent message → no AI.
  if (
    lastLeadAt &&
    opts.profileSourceMsgAt &&
    opts.profileSourceMsgAt.getTime() >= lastLeadAt.getTime() &&
    opts.stored
  ) {
    const cached = readStoredProfile(opts.stored);
    if (cached) return cached;
  }

  // Feed a bounded, representative window — the lead's own messages carry the
  // signal; cap the rest for cost. ~40 recent messages + the whole thing is
  // already capped by formatDialogForAI's default. Keep it modest here.
  const dialog = formatDialogForAI(parsed.messages.slice(-40), 40, true);

  let profile: LeadProfile;
  try {
    const raw = await chatCompletionJSON<Partial<LeadProfile>>({
      model: "claude-sonnet-5",
      system: `You maintain a compact intelligence profile for a real-estate lead, for a Bali property brokerage. Read the conversation and output a JSON profile.

CRITICAL — real estate reality: a long SILENCE does NOT mean the lead is dead. Buyers visit Bali on long, seasonal cycles and often go quiet for months, then re-engage perfectly when they're back or ready. Judge "alive" vs "dead_candidate" ONLY from the CONTENT of what the lead actually said — never from how long they've been silent.

Mark alive="dead_candidate" ONLY when the content clearly shows the lead is genuinely gone: explicitly not interested / asked to stop, wrong number / no WhatsApp, already bought elsewhere and closed the topic, or hostile. When in doubt → "alive". Silence alone → always "alive".

Fields:
- temperature: "cold" | "warm" | "hot" — how engaged they are RIGHT NOW based on what they've said (hot = active real buying intent / positive signals; warm = some genuine engagement; cold = minimal, terse, no real signal yet). A brand-new terse lead is "cold" but still fully alive and worth working.
- potential: 0-100 — latent buying potential judged from what they've revealed (budget hints, seriousness, fit), NOT from recency.
- intent: short phrase of what they're actually after (area/budget/type/purpose if stated), or "unclear".
- timeframe: any timing the lead implied for the next step — "ready now", "back in Bali in spring", "wants a week to think", "next trip in autumn" — or null if none.
- openQuestion: true if the lead asked a real question that was never properly answered.
- alive: "alive" | "dead_candidate" (per the rule above).
- summary: 1-2 lines capturing the essence of this lead (who they are, what they want, where it stands).

Respond with ONLY the JSON object.`,
      messages: [
        {
          role: "user",
          content: `Lead stage (may be stale): ${opts.leadStage ?? "unknown"}\nLead card notes: ${opts.leadNotes?.trim() || "(none)"}\n\nConversation (timestamped, oldest → newest):\n${dialog}`,
        },
      ],
      max_tokens: 300,
    });
    profile = coerceProfile(raw);
  } catch (err) {
    logger.error({ err, leadId: opts.leadId }, "lead-profile: distillation failed (non-fatal)");
    return opts.stored ? readStoredProfile(opts.stored) : null;
  }

  try {
    await db
      .update(leadsSyncTable)
      .set({
        profileTemperature: profile.temperature,
        profilePotential: profile.potential,
        profileIntent: profile.intent,
        profileTimeframe: profile.timeframe,
        profileOpenQuestion: profile.openQuestion,
        profileAlive: profile.alive,
        profileSummary: profile.summary,
        profileUpdatedAt: new Date(),
        profileSourceMsgAt: lastLeadAt,
      })
      .where(eq(leadsSyncTable.leadId, opts.leadId));
  } catch (err) {
    logger.error({ err, leadId: opts.leadId }, "lead-profile: persist failed (non-fatal)");
  }

  return profile;
}
