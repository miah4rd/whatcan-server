import { Router } from "express";
import { amoFetch } from "../../lib/amo-client";
import { logger } from "../../lib/logger";

const router = Router();

/**
 * GET /api/public/inspections?days=7
 *
 * Villas Yudi inspected in the period: every arrival at the Rental Listings
 * stage "Inspection. done", read from amoCRM's own event log (the only
 * complete record — our stage_events misses hand moves it never saw). The
 * owner's use (09.09.2026): count inspections per week, because each one
 * means new material in Google Drive and an update the site should get —
 * another agent checks that against this list. Information only; nothing
 * here moves a card.
 *
 * The stage kept its id when it was renamed from "agreement" on 09.09.2026,
 * so arrivals before that date are "agreement" moves: returned, with the
 * date, for the reader to judge.
 */
type Pipeline = { id: number; name: string; _embedded: { statuses: Array<{ id: number; name: string }> } };
type Event = { entity_id: number; created_at: number; created_by?: number; value_after?: Array<{ lead_status?: { id?: number; pipeline_id?: number } }> };

router.get("/public/inspections", async (req, res) => {
  const days = Math.min(Math.max(Number(req.query["days"] ?? 7) || 7, 1), 90);
  try {
    const pipes = await amoFetch<{ _embedded?: { pipelines?: Pipeline[] } }>("/api/v4/leads/pipelines?limit=50");
    const listing = (pipes?._embedded?.pipelines ?? []).find((p) => /rental\s*listings/i.test(p.name));
    const stage = listing?._embedded?.statuses.find((s) => /inspection/i.test(s.name));
    if (!listing || !stage) {
      res.status(503).json({ error: "the Inspection. done stage was not found in amoCRM" });
      return;
    }
    const from = Math.floor((Date.now() - days * 86_400_000) / 1000);
    const hits: Array<{ leadId: string; at: string; by: number | null }> = [];
    for (let page = 1; page <= 10; page++) {
      const ev = await amoFetch<{ _embedded?: { events?: Event[] } }>(
        `/api/v4/events?filter[entity]=leads&filter[type]=lead_status_changed&filter[created_at][from]=${from}&limit=100&page=${page}`,
      );
      const events = ev?._embedded?.events ?? [];
      for (const e of events) {
        const after = e.value_after?.[0]?.lead_status;
        if (after?.id === stage.id && (after.pipeline_id === undefined || after.pipeline_id === listing.id)) {
          hits.push({ leadId: String(e.entity_id), at: new Date(e.created_at * 1000).toISOString(), by: e.created_by ?? null });
        }
      }
      if (events.length < 100) break;
    }
    const names = new Map<string, string>();
    if (hits.length) {
      const ids = [...new Set(hits.map((h) => h.leadId))];
      const q = ids.map((id, i) => `filter[id][${i}]=${id}`).join("&");
      const leads = await amoFetch<{ _embedded?: { leads?: Array<{ id: number; name: string }> } }>(`/api/v4/leads?${q}&limit=250`);
      for (const l of leads?._embedded?.leads ?? []) names.set(String(l.id), l.name);
    }
    const users = await amoFetch<{ _embedded?: { users?: Array<{ id: number; name: string }> } }>("/api/v4/users?limit=250");
    const userName = new Map((users?._embedded?.users ?? []).map((u) => [u.id, u.name]));
    const inspections = hits
      .sort((a, b) => a.at.localeCompare(b.at))
      .map((h) => ({
        leadId: h.leadId,
        name: names.get(h.leadId) ?? null,
        at: h.at,
        atBali: new Date(h.at).toLocaleString("en-GB", { timeZone: "Asia/Makassar", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }),
        by: h.by === 0 ? "system" : (userName.get(h.by ?? -1) ?? String(h.by)),
        beforeRename: new Date(h.at) < new Date("2026-09-09T00:00:00+08:00"),
        card: `https://unicornproperty.amocrm.ru/leads/detail/${h.leadId}`,
      }));
    res.json({ days, stage: { id: stage.id, name: stage.name }, count: inspections.length, inspections, note: "arrivals before 2026-09-09 were 'agreement' moves (same stage id)" });
  } catch (err) {
    logger.error({ err }, "inspections: failed");
    res.status(500).json({ error: "could not read amoCRM events" });
  }
});

export default router;
