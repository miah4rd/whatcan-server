import { db, brokerPropertyPicksTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

// The read side ("this broker has used these before", getTopPicksForBroker) was
// removed on 14.09.2026: the count is bumped by every approve of the BOT'S OWN
// picks, so handing it back to the matcher fed the oldest villas into every new
// shortlist (R-DESTI-003 at 27 uses). The counter stays as history only — never
// read it into ranking (rankShortlistFits in property-catalog.ts).

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
