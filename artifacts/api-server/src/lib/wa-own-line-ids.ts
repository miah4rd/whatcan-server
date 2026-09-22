/**
 * WhatsApp lines that run on our own bridge (wa-gateway), not on Wahelp.
 *
 * They sit in BROKER_LINES next to the Wahelp source ids so the per-line budget
 * and the line choice need no second implementation, but they are NOT amoCRM
 * sources: nothing is written into the messenger field for them and Salesbot
 * never sends on them — lib/wa-own-send.ts delivers through the gateway and
 * writes the message into the card's chat itself.
 *
 * The ids are ours (900000+), chosen so they can never collide with an amoCRM
 * source id. No imports here on purpose: amo-messenger-field and the budget
 * read this file, and the bridge imports both.
 */
export const OWN_LINES: Record<number, { session: string; name: string }> = {
  // Yudi's second number +62 858-1241-0503, linked 19.09.2026 (owner: a second
  // nine first contacts a day for the listing manager, same responsible user).
  900002: { session: "yudi-2", name: "Yudi 2" },
  // The brokers' main numbers, moved off Wahelp on 22.09.2026: Wahelp stopped
  // delivering on 21.09 at ~15:06 (every send came back with delivery error 903).
  900001: { session: "amelia", name: "Amelia" },
  900003: { session: "yudi-main", name: "Yudi" },
};

export function isOwnLine(source: number | string | null | undefined): boolean {
  const n = Number(source);
  return Number.isFinite(n) && OWN_LINES[n] !== undefined;
}

export function ownLineSession(source: number | string | null | undefined): string | null {
  return OWN_LINES[Number(source)]?.session ?? null;
}
