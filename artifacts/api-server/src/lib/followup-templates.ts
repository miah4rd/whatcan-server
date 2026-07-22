/**
 * Predefined follow-up message templates for the qualification track.
 * Each touch has 3 variants (A/B/C) to distribute across leads so WhatsApp
 * doesn't flag identical messages sent in the same batch.
 *
 * Variant selection: parseInt(leadId) % 3  →  0=A, 1=B, 2=C
 * This is deterministic per lead (same lead always gets the same variant
 * for a given touch) and distributes evenly across the lead pool.
 *
 * Placeholders:
 *   [Name]  → lead's first name (from dialog; falls back to empty string)
 *   [link]  → BROCHURE_LINK constant (Touch 0 only)
 */

export const BROCHURE_LINK = "https://unicorn-properties.com/brochure/property-brochure-2026";
export const INSTAGRAM_LINK = "https://www.instagram.com/unicorn.property.bali/";
export const WEBSITE_LINK = "https://unicorn-properties.com";

export type Variant = "A" | "B" | "C";

export interface TouchTemplates {
  touch: number;
  stageKeyword: string;
  variants: Record<Variant, string>;
}

/**
 * Select variant A/B/C deterministically from a lead ID so the same lead
 * always gets the same variant, and variants are distributed evenly.
 */
export function selectVariant(leadId: string): Variant {
  const n = parseInt(leadId.replace(/\D/g, ""), 10) || 0;
  return (["A", "B", "C"] as Variant[])[n % 3];
}

/**
 * Replace [Name] and [link] placeholders in a template string.
 * If leadFirstName is empty, the greeting becomes "Hi! 👋" etc.
 */
export function applyTemplate(
  template: string,
  leadFirstName: string,
  extraReplacements?: Record<string, string>,
): string {
  let result = template.replace(/\[Name\]/g, leadFirstName).replace(/\[link\]/g, BROCHURE_LINK);
  if (extraReplacements) {
    for (const [key, value] of Object.entries(extraReplacements)) {
      result = result.replace(new RegExp(`\\[${key}\\]`, "g"), value);
    }
  }

  if (!leadFirstName) {
    // Remove orphaned commas/punctuation left by an empty name substitution.
    // Patterns like "Hi , " → "Hi", "on your end, ." → "on your end.",
    // ", Bali's" → "Bali's", "back, [Name]." → "back."
    result = result
      .replace(/,\s*\./g, ".")              // ", ." → "."
      .replace(/,\s*!/g, "!")               // ", !" → "!"
      .replace(/Hi\s*,\s*/g, "Hi! ")        // "Hi, " → "Hi! "
      .replace(/\bend\s*,\s*/g, "end, ")    // keep "on your end," if followed by real text
      .replace(/,\s{2,}/g, " ")             // ", " + extra spaces → single space
      .replace(/\s{2,}/g, " ")              // collapse double spaces
      .replace(/\.\s*\./g, ".");            // ".." → "."
  }

  return result.trim();
}

export const TOUCH_TEMPLATES: TouchTemplates[] = [
  // ── Touch 0 — New Lead (automated brochure) ──────────────────────────────
  {
    touch: 0,
    stageKeyword: "new lead",
    variants: {
      A: `Hi [Name]! 👋 This is [BrokerName] from Unicorn Property.
Here's our villa brochure: [link]
Just so you know, this only covers a small part of what we have. If you let me know your budget range and what you're looking for, to live in, rent out, or both, I can put together some options that actually fit 😊`,

      B: `Hi [Name], [BrokerName] here from Unicorn Property.
Here's the brochure you requested: [link]
Worth knowing this is just a small slice of our full listings. Tell me your budget range and whether you're after a home for yourself, a rental, or both, and I'll send something more tailored.`,

      C: `Hi [Name]! This is [BrokerName], Unicorn Property.
Brochure is here: [link]
Keep in mind it only shows part of what's available. Share your budget and what you'd like the place for, living in, renting out, or both, and I'll narrow it down properly for you.`,
    },
  },

  // ── Touch 1 — 1st Follow Up (next day) ───────────────────────────────────
  {
    touch: 1,
    stageKeyword: "1st follow up",
    variants: {
      A: `Saw you grabbed the guide, [Name]! 👋

Bali's still outperforming most markets on rental returns, it really comes down to getting the setup right, area, type, rental strategy. We also have options for personal use or mixed use if you'd rather enjoy it yourself part of the year.

What kind of returns or timeline are you working with? Just let me know and I can send a few that fit.

More listings here: ${WEBSITE_LINK}`,

      B: `Noticed the guide landed on your end, [Name].

Bali continues to beat a lot of markets on yield, the difference is really in getting the setup right. We can also find something more personal use or mixed use if that suits you better.

Curious what you're optimising for, returns, growth, or both? Happy to send some examples either way.

More listings here: ${WEBSITE_LINK}`,

      C: `Glad the guide came through, [Name].

Bali's still holding up better than most places for rental yield, mainly comes down to picking the right property and strategy. If personal use or mixed use is more your thing, we have plenty of those too.

Just let me know what matters most to you and I'll put a solid shortlist together 😊

More listings here: ${WEBSITE_LINK}`,
    },
  },

  // ── Touch 2 — 2nd Follow Up (3 days after Touch 1) ───────────────────────
  {
    touch: 2,
    stageKeyword: "2nd follow up",
    variants: {
      A: `Hi [Name], something came up in a client conversation yesterday and figured it was worth passing along.

Leasehold and freehold work differently here, and which one fits depends a lot on what you're trying to get out of the property.

Happy to navigate you through which suits your case better, just let me know.

More market insights here: ${INSTAGRAM_LINK}`,

      B: `Hi [Name], this one catches almost everyone off guard at first so figured I'd get ahead of it.

Leasehold versus freehold, the setup changes quite a bit depending on your plans.

Curious which direction makes more sense for you? Happy to break it down, no pressure at all.

More market insights here: ${INSTAGRAM_LINK}`,

      C: `Hi [Name], quick one that tends to be the first real fork in the road for most buyers here.

Leasehold and freehold lead to pretty different ownership setups.

Tell me a bit more about your plans and I can navigate you toward which one fits 😊

More market insights here: ${INSTAGRAM_LINK}`,
    },
  },

  // ── Touch 3 — Final Follow Up (5 days after Touch 2) ─────────────────────
  {
    touch: 3,
    stageKeyword: "final follow up",
    variants: {
      A: `Hi [Name], time for me to either keep your file warm or put it to rest, your call.

If you're still exploring Bali, just reply YES and I'll pick things back up. If not, reply NO and I'll close your file, no hard feelings either way. And if the timing just isn't right at the moment, just let me know and we'll reconnect when it suits you 🙏`,

      B: `Hi [Name], last one from me on this, promise.

Reply YES if you're still interested and I'll keep going, or NO if now's not the right time, totally understood either way. If it's more a timing thing than a no, just say so and we'll reconnect whenever works better for you.`,

      C: `Hi [Name], cleaning up my open conversations this week and yours is one of them.

Still want me looking out for you in Bali? Reply YES to keep your file open, or NO and I'll close it out, no hard feelings. If the timing's just off right now, just let me know and we'll reconnect down the line 🙏`,
    },
  },
];

/**
 * Find the template for a given lead stage (case-insensitive substring match).
 * Returns null if no template matches (AI generation should be used instead).
 */
export function getTemplateForStage(rawStage: string | null | undefined): TouchTemplates | null {
  if (!rawStage) return null;
  const s = rawStage.toLowerCase().trim();
  return TOUCH_TEMPLATES.find((t) => s.includes(t.stageKeyword)) ?? null;
}

/**
 * Build the final message for a lead at a given stage.
 * Returns null if no template is found for the stage.
 * NOTE: This may return Touch 0 (brochure). Prefer buildFollowupTemplateByLevel
 * in the scheduler to ensure brochures are never auto-suggested.
 */
export function buildTemplateMessage(
  rawStage: string | null | undefined,
  leadId: string,
  leadFirstName: string,
  brokerName?: string,
): string | null {
  const tpl = getTemplateForStage(rawStage);
  if (!tpl) return null;
  const variant = selectVariant(leadId);
  return applyTemplate(tpl.variants[variant], leadFirstName, brokerName ? { BrokerName: brokerName } : undefined);
}

/**
 * Build a follow-up message by numeric level (1, 2, 3…), never Touch 0 (brochure).
 * The brochure is sent automatically by ARGO — the bot must never suggest it.
 * Returns null if no template exists for that level.
 */
export function buildFollowupTemplateByLevel(
  level: number,
  leadId: string,
  leadFirstName: string,
  brokerName?: string,
): string | null {
  if (level <= 0) return null; // Never generate brochure (Touch 0)
  const tpl = TOUCH_TEMPLATES.find((t) => t.touch === level) ?? null;
  if (!tpl) return null;
  const variant = selectVariant(leadId);
  return applyTemplate(tpl.variants[variant], leadFirstName, brokerName ? { BrokerName: brokerName } : undefined);
}

// ── Rental pipeline: Touch 0 (first-ever message) ────────────────────────────
// Unlike Unicorn, Rental has no external system (ARGO) sending an initial
// brochure — our bot must generate the very first message itself, and its
// content depends on which ad campaign the lead came from.

export type RentalTouch0Type = "brochure" | "listing" | "b2b";

/**
 * Classify a Rental lead's first-touch type from its amoCRM tags + utm_campaign.
 *   - "b2b"        — tagged "b2b" / "b2b agents" (agency partnership inquiry)
 *   - "brochure"   — tagged "Renting brochure" (generic rental ad, no specific listing)
 *   - "listing"    — everything else (utm_campaign names a specific property)
 */
export function detectRentalTouch0Type(tags: string[], utmCampaign: string | null): RentalTouch0Type {
  const lowerTags = tags.map((t) => t.toLowerCase());
  if (lowerTags.some((t) => t.includes("b2b"))) return "b2b";
  if (lowerTags.some((t) => t.includes("renting brochure"))) return "brochure";
  return "listing";
}

/** Turn a utm_campaign slug like "facebook_3BR_Villa_for_Long-Term_Rental_in_Balangan" into "3BR Villa for Long Term Rental in Balangan". */
function humanizeListingName(utmCampaign: string | null): string {
  if (!utmCampaign) return "this property";
  const withoutSource = utmCampaign.replace(/^(facebook|instagram|fb|ig|google)_/i, "");
  const words = withoutSource.replace(/[_-]+/g, " ").trim();
  return words || "this property";
}

const RENTAL_TOUCH0_TEMPLATES: Record<RentalTouch0Type, string> = {
  brochure: `Hi [Name]! Thanks for reaching out — this is [BrokerName] from Unicorn Property. Before I send over a selection, could you tell me a bit about what you're after: how long you're looking to rent (a few months, 6 months, a year+), budget, and area? That way I can send something that actually fits.`,

  listing: `Hi [Name]! Thanks for your interest in the [Listing] — this is [BrokerName] from Unicorn Property. Want me to send more details on this one, or set up a viewing? Also, roughly how long are you looking to rent for — a few months, 6 months, or longer-term?`,

  b2b: `Hi [Name]! Thanks for reaching out about partnering with Unicorn Property — this is [BrokerName]. Could you tell me a bit about your agency and the clients you usually work with, so I can point you toward the right opportunities?`,
};

/** Build the Touch 0 message for a Rental lead based on its ad-campaign tags/UTM. */
export function buildRentalTouch0Message(
  tags: string[],
  utmCampaign: string | null,
  leadFirstName: string,
  brokerName?: string,
): string {
  const type = detectRentalTouch0Type(tags, utmCampaign);
  const template = RENTAL_TOUCH0_TEMPLATES[type];
  return applyTemplate(template, leadFirstName, {
    ...(brokerName ? { BrokerName: brokerName } : {}),
    Listing: type === "listing" ? humanizeListingName(utmCampaign) : "",
  });
}
