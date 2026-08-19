import { Router } from "express";
import { amoFetch } from "../../lib/amo-client";
import { logger } from "../../lib/logger";

const router = Router();

/**
 * GET /api/public/stage-options[?pipeline=Rental]
 *
 * The stages a broker may pick from when moving a card by hand, WITH the
 * numeric amoCRM status_id that approve.ts needs to actually apply them.
 *
 * This list used to be a hardcoded snapshot of the UNICORN funnel, for every
 * pipeline. Stage IDs are unique per funnel even when the names match, so on a
 * Rental lead the picker offered Unicorn's vocabulary ("Viewing Scheduled",
 * "Negotiations", "Reservation") — names Rental does not have — and
 * stageIdForName() returned null for anything the broker actually wanted.
 * approve.ts then fell back to the lead's CURRENT status id and "moved" the
 * card to the stage it was already in, while our own DB recorded the advance.
 *
 * The damage was invisible from inside: leads_sync said Viewing, stage_events
 * counted it as progress, the report showed it as progress — and amoCRM never
 * moved. The next periodic sync pulled the real stage back and the card
 * reappeared in Options sent. Nine such phantom advances were recorded before
 * anyone checked amoCRM's own event log, which showed no such transition had
 * ever happened. That is the whole reason the Rental board had 58 cards in
 * Options sent and none in Viewing.
 *
 * So the stages now come from amoCRM itself, per pipeline. Never reintroduce a
 * hardcoded cross-pipeline list.
 */

interface AmoStatus { id: number; name: string; sort: number; type?: number }
interface AmoPipeline { id: number; name: string; _embedded: { statuses: AmoStatus[] } }

type StageOption = { name: string; id: number };

const CACHE_TTL_MS = 10 * 60 * 1000;
let cache: { at: number; byPipeline: Map<string, StageOption[]> } | null = null;

/**
 * Unicorn's stages, as a last resort only. If amoCRM is unreachable the picker
 * still has to render something for the funnel most leads are in — but a
 * Rental lead gets an EMPTY list rather than Unicorn's ids, because offering
 * the wrong id is what caused the silent failure above.
 */
const UNICORN_FALLBACK: StageOption[] = [
  { name: "NEW LEAD", id: 68024550 },
  { name: "1ST FOLLOW UP (NEXT DAY)", id: 72376798 },
  { name: "2ND FOLLOW UP (3 DAYS AFTER)", id: 72376802 },
  { name: "FINAL FOLLOW UP (1 WEEK AFTER)", id: 72376806 },
  { name: "LEAD ASSIGNED", id: 72376818 },
  { name: "TAKEN TO WORK", id: 72376822 },
  { name: "Contact established", id: 68024554 },
  { name: "Mailing", id: 84883814 },
  { name: "Long-Term Cycle", id: 68035578 },
  { name: "Needs Assessed", id: 68024558 },
  { name: "Options Sent", id: 68035586 },
  { name: "Zoom Call scheduled", id: 70723858 },
  { name: "Viewing Scheduled", id: 68035590 },
  { name: "Feedback / Handling Objections", id: 68035594 },
  { name: "Reservation", id: 68035598 },
  { name: "Negotiations", id: 68035602 },
  { name: "Contract signed", id: 68035614 },
  { name: "Closed - won", id: 142 },
  { name: "Closed - lost", id: 143 },
];

async function loadStages(): Promise<Map<string, StageOption[]>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.byPipeline;

  const byPipeline = new Map<string, StageOption[]>();
  try {
    const data = await amoFetch<{ _embedded: { pipelines: AmoPipeline[] } }>(
      "/api/v4/leads/pipelines?limit=50",
    );
    for (const p of data?._embedded?.pipelines ?? []) {
      const stages = (p._embedded?.statuses ?? [])
        .slice()
        .sort((a, b) => a.sort - b.sort)
        // "Incoming leads" is amoCRM's own intake bucket, not a stage a broker
        // moves a card to by hand.
        .filter((s) => !/^incoming leads$/i.test(s.name))
        .map((s) => ({ name: s.name, id: s.id }));
      if (stages.length > 0) byPipeline.set(p.name.trim().toLowerCase(), stages);
    }
  } catch (err) {
    logger.error({ err }, "stage-options: amoCRM pipeline fetch failed");
  }

  if (byPipeline.size > 0) cache = { at: Date.now(), byPipeline };
  return byPipeline;
}

router.options("/stage-options", (_req, res) => res.sendStatus(204));

router.get("/stage-options", async (req, res) => {
  const wanted = String(req.query["pipeline"] ?? "").trim().toLowerCase();
  const byPipeline = await loadStages();

  if (byPipeline.size === 0) {
    // amoCRM unreachable. Unicorn is the only funnel whose ids we can vouch for
    // offline; anything else gets nothing rather than another funnel's ids.
    const stages = !wanted || wanted === "unicorn" ? UNICORN_FALLBACK : [];
    res.json({ pipeline: wanted || "unicorn", stages, stale: true });
    return;
  }

  const stages = wanted
    ? byPipeline.get(wanted) ?? []
    : byPipeline.get("unicorn") ?? UNICORN_FALLBACK;

  res.json({ pipeline: wanted || "unicorn", stages });
});

export default router;
