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
  const out = await chatCompletionJSON<{ design?: number; condition?: number; light?: number; photos?: number; wow?: number; note?: string }>({
    model: HELPER_MODEL,
    label: "listing-visual-score",
    max_tokens: 200,
    temperature: 0,
    system: `You are a strict, picky rental broker in Bali comparing villa listings. Almost every Bali listing has a pool and decent photos — that is the NORM, not a plus. Your job is to separate the few villas a client says "wow" to from the many ordinary ones.
Rate each 1–10 against the typical Canggu/Pererenan rental listing (typical = 5):
- design: how modern, stylish and coherent the interiors and architecture are (dated tiles, mismatched furniture, plain boxes → low).
- condition: how new, clean and well kept (worn, stained, mouldy, unfinished, cluttered → low).
- light: bright, airy rooms vs dark, cramped ones.
- photos: professional, well composed, showing the rooms vs phone snaps, dark, few angles.
- wow: would a client stop scrolling? (view, standout pool, garden, architecture). Typical villa = 4–5, only the top 1 in 10 gets 8+.
Be honest and use the whole scale. Return {"design":n,"condition":n,"light":n,"photos":n,"wow":n,"note":"<max 12 words: what stands out, good or bad>"}.`,
    messages: [{ role: "user", content: [...blocks, text] }],
  });
  const parts = [out?.design, out?.condition, out?.light, out?.photos, out?.wow].map(Number);
  if (parts.some((n) => !(n >= 1 && n <= 10))) return null;
  // design and wow weigh double: they are what made Amelia swap a villa; light and photos follow.
  const avg = (2 * parts[0]! + parts[1]! + parts[2]! + parts[3]! + 2 * parts[4]!) / 7;
  const score = avg >= 8 ? 5 : avg >= 6.5 ? 4 : avg >= 5 ? 3 : avg >= 3.5 ? 2 : 1;
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
