/**
 * Scores how a rental villa LOOKS in its photos, 1–5 (owner, 05.10.2026, skills/rental.md §5:
 * «4 делай», «5 да, фишки плюс визуал»). Amelia swapped villas in the bot's shortlists for how they
 * look; the bot only read text. The score is a tie-breaker between villas that fit the request
 * equally — it never lets a worse fit outrank a better one.
 *
 * The first photos of the listing (the cover set the client sees first) are read once; a listing is
 * re-read only when nobody has scored it yet. Results live on the site's properties row
 * (visual_score, visual_note, visual_scored_at).
 */
import { logger } from "./logger";
import { chatCompletionJSON, HELPER_MODEL, type ChatImageBlock, type ChatTextBlock } from "./ai-client";
import { siteGet } from "./listing-status-week";

type Row = { id: string; title: string | null; images: string[] | null; visual_scored_at: string | null };

const PHOTOS = 5;

function siteDb(): { url: string; key: string } {
  const url = process.env["SUPABASE_URL"] ?? "";
  const key = process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? "";
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
  return { url, key };
}
async function sitePatch(id: string, patch: Record<string, unknown>): Promise<void> {
  const { url, key } = siteDb();
  const res = await fetch(`${url}/rest/v1/properties?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`site PATCH ${id} → ${res.status} ${(await res.text()).slice(0, 200)}`);
}

/** Our own storage photos go through Supabase's resizer (800px JPEG); others are fetched as they are. */
function smallUrl(u: string): string {
  return u.includes("/storage/v1/object/public/")
    ? `${u.replace("/storage/v1/object/public/", "/storage/v1/render/image/public/")}?width=800&quality=70`
    : u;
}

async function photoBlock(u: string): Promise<ChatImageBlock | null> {
  try {
    const res = await fetch(smallUrl(u), { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
    if (!/^image\/(jpeg|png|webp|gif)$/.test(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 4_500_000) return null;
    return { type: "image", source: { type: "base64", media_type: type, data: buf.toString("base64") } };
  } catch {
    return null;
  }
}

export async function scoreVillaPhotos(row: Row): Promise<{ score: number; note: string } | null> {
  const blocks: ChatImageBlock[] = [];
  for (const u of (row.images ?? []).slice(0, PHOTOS + 2)) {
    if (blocks.length >= PHOTOS) break;
    const b = await photoBlock(u);
    if (b) blocks.push(b);
  }
  if (blocks.length < 2) return null;
  const text: ChatTextBlock = { type: "text", text: `Villa ${row.id}${row.title ? ` — ${row.title}` : ""}. ${blocks.length} listing photos above.` };
  const out = await chatCompletionJSON<{ score?: number; note?: string }>({
    model: HELPER_MODEL,
    label: "listing-visual-score",
    max_tokens: 150,
    temperature: 0,
    system: `You judge how a Bali rental villa LOOKS to a client scrolling its listing photos, the way an experienced rental broker would before sending it.
Score 1–5:
5 = wow: modern or beautifully designed, bright, spotless, great pool/garden/view, professional photos.
4 = attractive and well kept, good light, nothing off-putting.
3 = fine but ordinary: dated or plain interiors, average photos.
2 = tired: worn furniture, dark rooms, clutter, stains, unfinished areas, poor phone photos.
1 = off-putting: dirty, broken, construction mess, or photos that show almost nothing.
Judge the villa, not the price. Return {"score": 1-5, "note": "<max 12 words: what drives the score>"}.`,
    messages: [{ role: "user", content: [...blocks, text] }],
  });
  const score = Math.round(Number(out?.score));
  if (!(score >= 1 && score <= 5)) return null;
  return { score, note: String(out?.note ?? "").slice(0, 160) };
}

export async function runVisualScore(opts: { apply?: boolean; ids?: string[]; limit?: number; rescore?: boolean } = {}): Promise<Array<{ id: string; score?: number; note?: string; skipped?: string }>> {
  const filter = opts.ids?.length ? `&id=in.(${opts.ids.map((i) => encodeURIComponent(i)).join(",")})` : "";
  const unscored = opts.rescore || opts.ids?.length ? "" : "&visual_scored_at=is.null";
  const rows = await siteGet<Row[]>(
    `properties?select=id,title,images,visual_scored_at&listing_type=eq.rent&is_draft=eq.false${unscored}${filter}&order=id`,
  );
  const out: Array<{ id: string; score?: number; note?: string; skipped?: string }> = [];
  for (const row of rows.slice(0, opts.limit ?? rows.length)) {
    try {
      const r = await scoreVillaPhotos(row);
      if (!r) { out.push({ id: row.id, skipped: "fewer than 2 readable photos" }); continue; }
      if (opts.apply) await sitePatch(row.id, { visual_score: r.score, visual_note: r.note, visual_scored_at: new Date().toISOString() });
      out.push({ id: row.id, ...r });
    } catch (err) {
      logger.warn({ err, id: row.id }, "listing-visual-score: failed");
      out.push({ id: row.id, skipped: `error: ${String(err).slice(0, 120)}` });
    }
  }
  logger.info({ apply: !!opts.apply, scored: out.filter((r) => r.score).length }, "listing-visual-score: pass complete");
  return out;
}
