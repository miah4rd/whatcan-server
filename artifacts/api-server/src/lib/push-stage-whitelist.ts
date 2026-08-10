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
 * Pipelines whose stages have nothing to do with the whitelist above.
 *
 * The whitelist is Unicorn's vocabulary (Contact Established, Needs Assessed,
 * Options Sent...). A pipeline that names its stages differently matches none
 * of it, so applying the whitelist to one hides EVERY push it ever produces —
 * silently, with no error anywhere. That is exactly what happened to Rental
 * Listings on its first day: 11 leads were synced, 11 opening messages were
 * generated and queued, and the broker's inbox showed nothing, because
 * "Initial Contact" is not "contact established".
 *
 * Rental was already exempt via a bare `=== "rental"` comparison at each call
 * site; adding a second such pipeline is what turned that duplication into a
 * bug. One predicate, so the next pipeline only has to be added here.
 */
const OWN_STAGE_VOCABULARY = new Set<string>(["rental", "rental listings"]);

export function usesOwnStageVocabulary(pipeline: string | null | undefined): boolean {
  return OWN_STAGE_VOCABULARY.has((pipeline ?? "").trim().toLowerCase());
}

export function isPushStageAllowed(whitelist: string[], rawStage: string | null | undefined): boolean {
  if (whitelist.length === 0) return true;
  if (!rawStage) return true;
  const s = rawStage.toLowerCase().trim();
  return whitelist.some((w) => s.includes(w.toLowerCase()));
}
