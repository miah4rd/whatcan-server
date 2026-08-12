import { db, brokerSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

const SETTINGS_KEY = "push_stage_whitelist";

const DEFAULT_STAGES: string[] = [
  "1st follow up",
  "2nd follow up",
  "final follow up",
];

let _cache: string[] | null = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 60_000;

export async function getPushStageWhitelist(): Promise<string[]> {
  if (_cache && Date.now() - _cacheAt < CACHE_TTL_MS) return _cache;
  try {
    const row = await db
      .select({ value: brokerSettingsTable.value })
      .from(brokerSettingsTable)
      .where(eq(brokerSettingsTable.key, SETTINGS_KEY))
      .limit(1);
    if (row.length > 0) {
      const parsed = JSON.parse(row[0].value) as string[];
      _cache = Array.isArray(parsed) ? parsed : DEFAULT_STAGES;
    } else {
      _cache = DEFAULT_STAGES;
    }
    _cacheAt = Date.now();
  } catch (err) {
    logger.warn({ err }, "push-stage-whitelist: failed to read from DB, using defaults");
    _cache = DEFAULT_STAGES;
    _cacheAt = Date.now();
  }
  return _cache;
}

export async function setPushStageWhitelist(stages: string[]): Promise<void> {
  const value = JSON.stringify(stages);
  await db
    .insert(brokerSettingsTable)
    .values({ key: SETTINGS_KEY, value })
    .onConflictDoUpdate({ target: brokerSettingsTable.key, set: { value, updatedAt: new Date() } });
  _cache = stages;
  _cacheAt = Date.now();
}

export function invalidatePushStageCache(): void {
  _cache = null;
  _cacheAt = 0;
}

/**
 * Whether the Unicorn stage whitelist applies to this funnel.
 *
 * A funnel that names its stages differently matches none of the whitelist, so
 * applying it hides EVERY push it produces — silently. That is what happened to
 * Rental Listings on day one: 11 leads synced, 11 drafts written and queued, and
 * the broker's inbox showed nothing, because "Initial Contact" is not
 * "contact established". The roster now lives in lib/pipelines.ts.
 */
export { usesOwnStageVocabulary } from "./pipelines";

export function isPushStageAllowed(whitelist: string[], rawStage: string | null | undefined): boolean {
  if (whitelist.length === 0) return true;
  if (!rawStage) return true;
  const s = rawStage.toLowerCase().trim();
  return whitelist.some((w) => s.includes(w.toLowerCase()));
}
