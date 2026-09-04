/**
 * Bring every pending draft whose text does not name its attached villas back
 * into ONE message — the owner's rule (2026-09-04): text and links are one
 * thing, the links are a mirror of the text. The drafts this sweeps were
 * generated before the writer was handed the attached list; approve would
 * rewrite them at send time, but a broker reading the inbox must see the
 * message the client will actually get, not words about other villas.
 *
 *   POST /api/admin/reconcile-pending           dry run (default): lists the mismatches
 *   POST /api/admin/reconcile-pending?apply=1   rewrites the text in place (same row id)
 *   optional ?lead=<leadId> limits the sweep to one lead
 */
import { Router } from "express";
import { db, pendingSuggestionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { allAttachmentsNamed, reconcileTextWithAttachments } from "../../lib/generate-suggestion";
import { logger } from "../../lib/logger";

const router = Router();

type Link = { type: "link"; label: string; url: string };

function linksOf(raw: unknown): Link[] {
  const arr: unknown[] = Array.isArray(raw) ? raw : [];
  return arr
    .filter((a): a is { type: string; url: string; label?: string } => {
      const x = a as { type?: unknown; url?: unknown } | null;
      return !!x && x.type === "link" && typeof x.url === "string" && x.url.length > 0;
    })
    .map((a) => ({ type: "link" as const, label: String(a.label ?? a.url), url: a.url }));
}

const preview = (t: string) => t.replace(/\s+/g, " ").trim().slice(0, 140);

router.post("/admin/reconcile-pending", async (req, res) => {
  const apply = String(req.query["apply"] ?? "") === "1";
  const onlyLead = String(req.query["lead"] ?? "").trim();
  const rows = await db
    .select({
      id: pendingSuggestionsTable.id,
      leadId: pendingSuggestionsTable.leadId,
      kind: pendingSuggestionsTable.kind,
      text: pendingSuggestionsTable.suggestionText,
      attachments: pendingSuggestionsTable.attachments,
    })
    .from(pendingSuggestionsTable)
    .where(eq(pendingSuggestionsTable.status, "pending"));

  const items: Array<{ leadId: string; kind: string; links: number; before: string; after?: string; error?: string }> = [];
  let checked = 0;
  for (const r of rows) {
    if (onlyLead && r.leadId !== onlyLead) continue;
    const links = linksOf(r.attachments);
    if (links.length === 0) continue;
    checked++;
    const text = r.text ?? "";
    if (allAttachmentsNamed(text, links)) continue;
    const item: (typeof items)[number] = { leadId: r.leadId, kind: r.kind, links: links.length, before: preview(text) };
    if (apply) {
      try {
        const rewritten = await reconcileTextWithAttachments(text, links, true);
        if (rewritten && rewritten.trim() && rewritten.trim() !== text.trim()) {
          await db
            .update(pendingSuggestionsTable)
            .set({ suggestionText: rewritten })
            .where(eq(pendingSuggestionsTable.id, r.id));
          item.after = preview(rewritten);
          logger.info({ leadId: r.leadId, kind: r.kind, links: links.length }, "reconcile-pending: rewrote the draft under its links");
        } else {
          item.error = "rewrite came back unchanged";
        }
      } catch (err) {
        item.error = err instanceof Error ? err.message : String(err);
        logger.warn({ err, leadId: r.leadId }, "reconcile-pending: rewrite failed");
      }
    }
    items.push(item);
  }
  res.json({ ok: true, apply, checked, mismatched: items.length, rewritten: items.filter((i) => i.after).length, items });
});

export default router;
