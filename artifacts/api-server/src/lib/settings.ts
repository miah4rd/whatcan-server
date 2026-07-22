import { db, brokerSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// ── Follow-up steps ────────────────────────────────────────────────────────

/**
 * A single push follow-up step.
 *
 * `delayMs`  — how long to wait after the previous broker message.
 * `message`  — optional pre-written message the broker wants sent verbatim.
 *              When present and non-empty, the AI skips generation and uses
 *              this text directly. When absent or empty, the AI generates a
 *              context-aware follow-up as usual.
 */
export type FollowupStep = {
  delayMs: number;
  message?: string;
};

export const DEFAULT_FOLLOWUP_STEPS: FollowupStep[] = [
  { delayMs: 23 * 60 * 60 * 1000 },          // follow-up 1 → 23 h
  { delayMs: 3 * 24 * 60 * 60 * 1000 },      // follow-up 2 → 3 days
  { delayMs: 5 * 24 * 60 * 60 * 1000 },      // follow-up 3 → 5 days
];

export async function getFollowupSteps(): Promise<FollowupStep[]> {
  try {
    // Prefer the newer `followup_steps` key (has per-step messages).
    const rows = await db
      .select()
      .from(brokerSettingsTable)
      .where(eq(brokerSettingsTable.key, "followup_steps"))
      .limit(1);

    if (rows.length > 0) {
      const parsed = JSON.parse(rows[0].value) as unknown;
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        (parsed as unknown[]).every(
          (s) => typeof (s as FollowupStep).delayMs === "number" && (s as FollowupStep).delayMs > 0,
        )
      ) {
        return parsed as FollowupStep[];
      }
    }

    // Fall back to legacy `followup_delays` (plain number array) if present.
    const legacy = await db
      .select()
      .from(brokerSettingsTable)
      .where(eq(brokerSettingsTable.key, "followup_delays"))
      .limit(1);

    if (legacy.length > 0) {
      const parsed = JSON.parse(legacy[0].value) as unknown;
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        (parsed as unknown[]).every((d) => typeof d === "number" && d > 0)
      ) {
        return (parsed as number[]).map((delayMs) => ({ delayMs }));
      }
    }
  } catch {}

  return DEFAULT_FOLLOWUP_STEPS;
}

export async function setFollowupSteps(steps: FollowupStep[]): Promise<void> {
  const value = JSON.stringify(steps);
  await db
    .insert(brokerSettingsTable)
    .values({ key: "followup_steps", value })
    .onConflictDoUpdate({
      target: brokerSettingsTable.key,
      set: { value, updatedAt: new Date() },
    });
}

/** @deprecated Use getFollowupSteps() instead. Kept for backward-compat. */
export async function getFollowupDelays(): Promise<number[]> {
  const steps = await getFollowupSteps();
  return steps.map((s) => s.delayMs);
}

/** @deprecated Use setFollowupSteps() instead. Kept for backward-compat. */
export async function setFollowupDelays(delays: number[]): Promise<void> {
  await setFollowupSteps(delays.map((delayMs) => ({ delayMs })));
}

// ── Qualification script ───────────────────────────────────────────────────

/**
 * A single qualification stage message.
 *
 * `label`   — stage name shown in the UI (e.g. "1st Follow-up", "Final Follow-up").
 * `message` — the fixed copy-paste message the broker sends at this stage.
 *
 * Only follow-up stages are handled here: 1st, 2nd, Final.
 * New Lead is handled by amoCRM/ARGO automatically.
 */
export type QualificationStep = {
  label: string;
  message: string;
};

export const DEFAULT_QUALIFICATION_STEPS: QualificationStep[] = [
  { label: "1st Follow-up (next day)", message: "" },
  { label: "2nd Follow-up (3 days after)", message: "" },
  { label: "Final Follow-up (1 week after)", message: "" },
];

export async function getQualificationSteps(): Promise<QualificationStep[]> {
  try {
    const rows = await db
      .select()
      .from(brokerSettingsTable)
      .where(eq(brokerSettingsTable.key, "qualification_steps"))
      .limit(1);
    if (rows.length > 0) {
      const parsed = JSON.parse(rows[0].value) as unknown;
      if (
        Array.isArray(parsed) &&
        (parsed as unknown[]).every(
          (s) =>
            typeof (s as QualificationStep).label === "string" &&
            typeof (s as QualificationStep).message === "string",
        )
      ) {
        return parsed as QualificationStep[];
      }
    }
  } catch {}
  return DEFAULT_QUALIFICATION_STEPS;
}

export async function setQualificationSteps(steps: QualificationStep[]): Promise<void> {
  const value = JSON.stringify(steps);
  await db
    .insert(brokerSettingsTable)
    .values({ key: "qualification_steps", value })
    .onConflictDoUpdate({
      target: brokerSettingsTable.key,
      set: { value, updatedAt: new Date() },
    });
}

// ── Broker property picks ──────────────────────────────────────────────────

export type BrokerPicksSegment = {
  label: string;
  picks: string; // one line per property: "UP-1001: Best ROI in Pererenan"
};

const DEFAULT_BROKER_PICKS: BrokerPicksSegment[] = [
  { label: "Investment < $300K", picks: "" },
  { label: "Investment $300K–$600K", picks: "" },
  { label: "Investment $600K+", picks: "" },
  { label: "Lifestyle / Living", picks: "" },
  { label: "Land / Development", picks: "" },
];

export async function getBrokerPicks(): Promise<BrokerPicksSegment[]> {
  try {
    const rows = await db
      .select()
      .from(brokerSettingsTable)
      .where(eq(brokerSettingsTable.key, "broker_property_picks"))
      .limit(1);
    if (rows.length > 0) {
      const parsed = JSON.parse(rows[0].value) as unknown;
      if (Array.isArray(parsed)) return parsed as BrokerPicksSegment[];
    }
  } catch {}
  return DEFAULT_BROKER_PICKS;
}

export async function setBrokerPicks(picks: BrokerPicksSegment[]): Promise<void> {
  const value = JSON.stringify(picks);
  await db
    .insert(brokerSettingsTable)
    .values({ key: "broker_property_picks", value })
    .onConflictDoUpdate({
      target: brokerSettingsTable.key,
      set: { value, updatedAt: new Date() },
    });
}

// ── Combined settings ──────────────────────────────────────────────────────

export async function getServerSettings(): Promise<{
  followupSteps: FollowupStep[];
  /** @deprecated Use followupSteps instead. */
  followupDelays: number[];
  brokerPicks: BrokerPicksSegment[];
  qualificationSteps: QualificationStep[];
}> {
  const [steps, picks, qualSteps] = await Promise.all([
    getFollowupSteps(),
    getBrokerPicks(),
    getQualificationSteps(),
  ]);
  return {
    followupSteps: steps,
    followupDelays: steps.map((s) => s.delayMs),
    brokerPicks: picks,
    qualificationSteps: qualSteps,
  };
}
