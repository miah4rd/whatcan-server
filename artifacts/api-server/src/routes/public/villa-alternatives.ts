/**
 * Swap / add a villa right on the draft (owner, 29.09.2026): the next villas in line for THIS client,
 * from the same ranked pool the edit composer draws from (the request, the priority order, never a villa
 * the client already has). The Copilot page swaps the link and has the words rewritten through /suggest.
 */
import { Router } from "express";
import { pool } from "@workspace/db";
import { alreadySentPropertyIds } from "../../lib/generate-suggestion";
import { getLeadCardCriteria } from "../../lib/lead-card-fields";
import { candidatesForLead, priceOf, propertyUrl, keyFeatureBits } from "../../lib/property-catalog";
import { trustForAttachments } from "../../lib/villa-trust";

const router = Router();

router.get("/villa-alternatives", async (req, res) => {
  const leadId = String(req.query["leadId"] ?? "").trim();
  if (!/^\d+$/.test(leadId)) return void res.status(400).json({ error: "leadId required" });
  const exclude = String(req.query["exclude"] ?? "")
    .split(",")
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);
  try {
    const sync = (await pool.query(`SELECT pipeline, lead_notes, content FROM leads_sync WHERE lead_id = $1`, [leadId])).rows[0];
    if (!sync) return void res.status(404).json({ error: "lead not found" });
    const msgs = (await pool.query(`SELECT sender_type, text FROM lead_messages WHERE lead_id = $1 AND text IS NOT NULL ORDER BY sent_at DESC LIMIT 40`, [leadId])).rows;
    const lead = msgs.filter((m) => m.sender_type === "lead").map((m) => String(m.text));
    const ours = msgs.filter((m) => m.sender_type !== "lead").map((m) => String(m.text));
    const notes = String(sync.lead_notes ?? "");
    const sent = await alreadySentPropertyIds(leadId, `${sync.content ?? ""}\n${[...ours, ...lead].join("\n")}`, lead.join("\n"), ours.join("\n")).catch(() => [] as string[]);
    const card = await getLeadCardCriteria(leadId).catch(() => null);
    const { candidates } = await candidatesForLead({
      listingType: String(sync.pipeline ?? "").toLowerCase() === "rental" ? "rent" : "sale",
      excludeIds: [...sent, ...exclude],
      ourMessages: ours,
      recentLeadMessages: lead,
      brokerInstruction: null,
      cardCriteria: card ? { bedrooms: card.bedrooms, areas: card.areas, budgetIdrMonthly: card.budgetIdrMonthly } : null,
      cardAnswers: card?.answers ?? null,
      cardBudgetTexts: card?.budgetTexts ?? [],
      leadNotes: notes || null,
      clickedListingId: /Ad enquiry:\s*([A-Z0-9-]+)/i.exec(notes)?.[1] ?? null,
      leadId,
    });
    const next = candidates.filter((p) => !exclude.includes(p.id.toUpperCase()) && !sent.includes(p.id.toUpperCase())).slice(0, 4);
    const trust = await trustForAttachments(next.map((p) => ({ type: "link", url: propertyUrl(p) }))).catch(() => ({} as Record<string, unknown>));
    res.json({
      villas: next.map((p) => {
        const url = propertyUrl(p);
        const price = priceOf(p);
        const priceM = price ? Math.round(price / 100_000) / 10 : null;
        // The caption line of the shortlist layout (owner, 30.09.2026), so "↻ Next" can put the villa in place
        // without rewriting the message: "Pererenan · 2BR · Rp 38M/mo · from 8 Oct" + its best four features.
        const f = p.free_from ? new Date(`${p.free_from}T00:00:00Z`) : null;
        const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const from = f && !Number.isNaN(f.getTime()) && f.getTime() > Date.now() ? `from ${f.getUTCDate()} ${MON[f.getUTCMonth()]}` : "";
        const head = [String(p.area ?? "").split(",")[0]!.trim() || "Bali", p.bedrooms ? `${p.bedrooms}BR` : "", priceM ? `Rp ${priceM}M/mo` : "", from].filter(Boolean).join(" · ");
        const feats = keyFeatureBits(p).filter((b) => !/open kitchen/i.test(b)).slice(0, 4).join(", ");
        return { id: p.id, url, title: p.title, area: p.area, bedrooms: p.bedrooms, priceM, trust: (trust as Record<string, unknown>)[url] ?? null, captionHead: head, captionFeatures: feats ? feats[0]!.toUpperCase() + feats.slice(1) : "" };
      }),
    });
  } catch (err) {
    res.status(500).json({ error: String((err as Error).message ?? err).slice(0, 200) });
  }
});

export default router;
