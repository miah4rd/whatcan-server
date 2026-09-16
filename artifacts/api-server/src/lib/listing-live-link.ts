/**
 * Is this card's villa live on the website?
 *
 * A card can be closed for a reason of its own — no WhatsApp on the number, a price below our floor,
 * a tenant who just moved in — while the villa it carries is still published and offered to clients.
 * Closing it then takes the villa out of the weekly availability check for good, and the site keeps
 * showing it as free (owner, 16.09.2026, after Bima / R-YUD-048 and Bernice / R-YUD-049 were closed
 * on 15–16.09 with both listings still up). So every closer asks here first; a card with a live
 * listing keeps its stage and gets a note instead.
 */
import { siteGet } from "./listing-status-week";

export type LiveListing = { id: string; title: string };

/** The one PUBLISHED rent listing linked to this card, or null (two links, a draft, a sale: null). */
export async function publishedListingFor(leadId: string): Promise<LiveListing | null> {
  try {
    const links = await siteGet<{ property_id: string }[]>(
      `listing_crm_link?select=property_id&amo_lead_id=eq.${encodeURIComponent(leadId)}`,
    );
    if (links.length !== 1) return null;
    const id = links[0]!.property_id;
    const props = await siteGet<{ id: string; title: string; is_draft: boolean | null; listing_type: string | null }[]>(
      `properties?select=id,title,is_draft,listing_type&id=eq.${encodeURIComponent(id)}`,
    );
    const p = props[0];
    if (!p || p.is_draft || (p.listing_type ?? "rent") !== "rent") return null;
    return { id: p.id, title: p.title };
  } catch {
    // An unreadable site must not block a close that is otherwise right.
    return null;
  }
}
