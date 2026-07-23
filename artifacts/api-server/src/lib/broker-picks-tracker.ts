import { db, brokerPropertyPicksTable } from "@workspace/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { logger } from "./logger";

/**
 * Returns this broker's most-used property IDs, restricted to the given
 * candidate pool (so a broker's sale history never leaks into rent matching
 * or vice versa — the caller already filtered the pool by listing_type).
 */
export async function getTopPicksForBroker(brokerId: string, candidateIds: string[], limit = 10): Promise<string[]> {
  if (candidateIds.length === 0) return [];
  try {
    const rows = await db
      .select({ propertyId: brokerPropertyPicksTable.propertyId })
      .from(brokerPropertyPicksTable)
      .where(and(eq(brokerPropertyPicksTable.brokerId, brokerId), inArray(brokerPropertyPicksTable.propertyId, candidateIds)))
      .orderBy(desc(brokerPropertyPicksTable.useCount))
      .limit(limit);
    return rows.map((r) => r.propertyId);
  } catch (err) {
    logger.error({ err, brokerId }, "getTopPicksForBroker failed (non-fatal)");
    return [];
  }
}

/** Called after a broker approves a suggestion that included property attachments. */
export async function incrementBrokerPick(brokerId: string, propertyId: string, listingType: string | null): Promise<void> {
  try {
    await db
      .insert(brokerPropertyPicksTable)
      .values({ brokerId, propertyId, listingType, useCount: 1 })
      .onConflictDoUpdate({
        target: [brokerPropertyPicksTable.brokerId, brokerPropertyPicksTable.propertyId],
        set: { useCount: sql`${brokerPropertyPicksTable.useCount} + 1`, lastUsedAt: new Date() },
      });
  } catch (err) {
    logger.error({ err, brokerId, propertyId }, "incrementBrokerPick failed (non-fatal)");
  }
}
