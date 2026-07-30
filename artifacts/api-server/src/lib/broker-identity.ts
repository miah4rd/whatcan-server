/**
 * One way to compare broker identities.
 *
 * The same person's name arrives spelled differently depending on the surface:
 * the Chrome extension reads it from amoCRM ("HoS"), the mobile page uses what
 * the broker typed into it once ("Hos"), webhooks carry whatever amoCRM sent.
 * Scattered `x === "HoS"` checks therefore agreed on one device and disagreed on
 * another — and because those checks gate WHICH LEADS A BROKER SEES, the mobile
 * inbox sat empty while the extension showed the same leads fine. It cost two
 * separate debugging sessions before the pattern was obvious.
 *
 * Every broker-name comparison goes through here. Nothing compares raw strings.
 */

/** Canonical form for comparison and for use as a storage/lookup key. */
export function normalizeBroker(name: string | null | undefined): string {
  return (name ?? "").trim().toLowerCase();
}

/** Case- and whitespace-insensitive equality between two broker names. */
export function isBroker(name: string | null | undefined, target: string): boolean {
  const n = normalizeBroker(name);
  return n.length > 0 && n === normalizeBroker(target);
}

/**
 * Key used when a broker name is stored or looked up (corrections, picks,
 * suggestion rows). Bounded to the column width, with an explicit placeholder
 * so an unknown broker doesn't silently collide with a real one.
 */
export function brokerKey(name: string | null | undefined): string {
  const n = normalizeBroker(name);
  return (n || "unknown").slice(0, 64);
}
