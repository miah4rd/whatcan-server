export type AttachmentDef =
  | { type: "link"; label: string; url: string }
  | { type: "image"; label: string; storageKey: string }
  | { type: "reminder"; label: string };

export interface PlaybookEntry {
  id: string;
  label: string;
  /** Used in the AI classification prompt */
  description: string;
  /** Signals / keywords that indicate this objection */
  signals: string[];
  /** Ready-to-personalise script. {name} and {broker} are replaced at runtime. */
  scriptTemplate: string;
  attachments: AttachmentDef[];
}

export const OBJECTION_PLAYBOOK: PlaybookEntry[] = [
  {
    id: "market_legal",
    label: "Market / Legal / Process Uncertainty",
    description:
      "Lead feels the Bali buying process is complicated, unclear, or risky. Questions about leasehold, freehold, taxes, legal structure, how it works.",
    signals: [
      "complicated",
      "unclear",
      "risky",
      "leasehold",
      "freehold",
      "legal",
      "process",
      "tax",
      "how does it work",
      "not sure how",
    ],
    scriptTemplate: `Hi {name}, {broker} from Unicorn Property.

If you're looking for some clarity on the buying process and the market here in Bali — a lot of buyers pause their search because the process feels complicated.

I just put together a fresh '2026 Bali Buyer's Blueprint' that covers exact legal structures, taxes, and how to avoid the biggest traps new buyers face today.

Should I send a copy over to help with your research?`,
    attachments: [
      {
        type: "link",
        label: "2026 Bali Buyer's Blueprint",
        url: "https://unicorn-properties.com/blog/2026-bali-buyers-blueprint-legal-taxes-due-diligence",
      },
      {
        type: "link",
        label: "Podcast: Buyer Mistakes in Bali",
        url: "https://youtu.be/nPuDirSaVa0?si=f0maH2AToNyaCDy8",
      },
    ],
  },
  {
    id: "no_urgency",
    label: "No Urgency / Postponing",
    description:
      "Lead says they will think about it later, postpone, not ready yet. No clear next step. Stopped responding.",
    signals: [
      "later",
      "not now",
      "think about it",
      "not ready",
      "busy",
      "postpone",
      "wait",
      "maybe next year",
    ],
    scriptTemplate: `Hi {name}, hope you've been well.

Just wanted to check in and see if Bali investment is still on your radar.

The EUR is actually very strong against the IDR right now, so timing-wise it's quite interesting. Compared to last year, you're effectively buying at around 10%+ discount purely from the currency difference alone.

Could be a very good window to enter the market before rates move back again.`,
    attachments: [
      {
        type: "reminder",
        label: "📸 Attach current EUR/IDR exchange rate screenshot (take fresh one today)",
      },
    ],
  },
  {
    id: "real_numbers",
    label: "Real Numbers & Proof of Bali Performance",
    description:
      "Lead wants to see real statistics, ROI proof, occupancy data, or evidence that Bali actually performs as an investment market.",
    signals: [
      "proof",
      "numbers",
      "statistics",
      "ROI",
      "occupancy",
      "really work",
      "real data",
      "AirDNA",
      "how much",
      "guaranteed",
    ],
    scriptTemplate: `Still thinking whether Bali is worth investing in?

Have a look at these real AirDNA numbers for 1–2 bedroom villas in top locations.

Gives a much clearer picture than most assumptions.

If you want to understand how to get similar results, just let me know.`,
    attachments: [
      {
        type: "image",
        label: "AirDNA Screenshot 1",
        storageKey: "airdna_1",
      },
      {
        type: "image",
        label: "AirDNA Screenshot 2",
        storageKey: "airdna_2",
      },
      {
        type: "image",
        label: "AirDNA Screenshot 3",
        storageKey: "airdna_3",
      },
      {
        type: "image",
        label: "AirDNA Screenshot 4",
        storageKey: "airdna_4",
      },
      {
        type: "image",
        label: "AirDNA Screenshot 5",
        storageKey: "airdna_5",
      },
      {
        type: "link",
        label: "Pink Villa — top performer video",
        url: "https://www.instagram.com/reel/DXNwhZNAZdQ/?utm_source=ig_web_copy_link",
      },
      {
        type: "link",
        label: "Bali Tourism Stats (official)",
        url: "https://bali.bps.go.id/en/statistics-table/1/MjgjMQ==/number-of-foreign-visitor-to-bali-dan-indonesia--1969-2024.html",
      },
    ],
  },
  {
    id: "unique_options",
    label: "Need More Unique Options",
    description:
      "Lead has seen the brochure but needs stronger, more unique property options with proper descriptions and investment insights.",
    signals: [
      "more options",
      "didn't find",
      "nothing interesting",
      "unique",
      "other properties",
      "different",
      "not what I'm looking for",
    ],
    scriptTemplate: `{broker} from Unicorn Property — I've been putting together a short list of the strongest options we have right now that aren't in the main brochure.

These are the ones I'd personally shortlist for someone with your criteria.

Want me to send the details across?`,
    attachments: [
      {
        type: "reminder",
        label: "📎 Attach Terra Calma property info / Pink Villa property info",
      },
    ],
  },
];

/** Returns attachments with image storageKeys resolved to actual URLs from broker_settings */
export async function resolveAttachments(
  attachments: AttachmentDef[],
  imageUrls: Record<string, string>,
): Promise<ResolvedAttachment[]> {
  return attachments.map((a): ResolvedAttachment => {
    if (a.type === "image") {
      const url = imageUrls[a.storageKey] ?? null;
      return { type: "image", label: a.label, url, storageKey: a.storageKey };
    }
    if (a.type === "link") {
      return { type: "link", label: a.label, url: a.url };
    }
    return { type: "reminder", label: a.label };
  });
}

export type ResolvedAttachment =
  | { type: "link"; label: string; url: string }
  | { type: "image"; label: string; url: string | null; storageKey: string }
  | { type: "reminder"; label: string };
