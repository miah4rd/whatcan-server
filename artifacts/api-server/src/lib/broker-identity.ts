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

/**
 * The name a broker SIGNS with, as opposed to the label they log in with.
 * "HoS" is an account, not a person — the owner signs as Nick, told the bot so
 * on every edit, and kept being overridden by a prompt rule that said "sign as
 * HoS" with absolute priority. Display names live here so no prompt ever
 * reaches for the login again.
 */
const DISPLAY_NAMES: Record<string, string> = {
  hos: "Nick",
  nick: "Nick",
};

export function brokerDisplayName(name: string | null | undefined): string {
  const n = normalizeBroker(name);
  if (!n) return "";
  if (DISPLAY_NAMES[n]) return DISPLAY_NAMES[n];
  return n.charAt(0).toUpperCase() + n.slice(1);
}
