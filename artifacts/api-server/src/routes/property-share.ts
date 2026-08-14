/**
 * GET /property/:id — the link a client actually receives on WhatsApp.
 *
 * Why this route exists at all. Every property link we send used to point
 * straight at the public site, and the site is a client-rendered SPA: a
 * crawler asking for /property/R-SAI-022 gets the same index.html as every
 * other page, so WhatsApp read the SAME generic Open Graph tags for every
 * villa. Verified against three different listings — identical og:title
 * ("Unicorn Property Bali — Trusted Real Estate Agency") and identical
 * og:image. We deliberately send each link as its own message so WhatsApp
 * unfurls a preview per villa; what the client saw instead was three
 * identical grey banners with no villa name, no price and no photo. Three
 * links, zero information — and 24 of 44 rental leads never answered.
 *
 * So we serve the share page ourselves: real per-villa Open Graph tags for
 * the crawler, and an immediate hop to the real site for a human.
 *
 * The path stays "/property/<ID>" on purpose. That exact shape is what the
 * whole codebase reads back out of conversation text to know which listings
 * have already gone out ("Never re-offer a listing the lead has seen") — some
 * twenty regexes across generate-suggestion, suggest, approve and
 * budget-filter. Only the HOST moves; every one of them keeps matching, and
 * links already sitting in old conversations keep parsing too.
 */
import { Router } from "express";
import { fetchPropertyForShare, humanPropertyUrl } from "../lib/property-catalog";
import { publicBaseUrl } from "../lib/public-url";

const router = Router();

function esc(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const IMAGE_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

/**
 * The preview image, re-served with a real image Content-Type.
 *
 * Every photo in the catalog's storage bucket comes back as
 * application/octet-stream — they were uploaded without one. Crawlers are
 * entitled to refuse an og:image that does not declare itself an image, and a
 * refused image is the same grey card this whole route exists to get rid of.
 * So og:image points here, and here we say what the bytes actually are.
 */
router.get("/property/:id/preview", async (req, res) => {
  const id = String(req.params["id"] ?? "").trim();
  try {
    const card = await fetchPropertyForShare(id);
    if (!card?.image) {
      res.sendStatus(404);
      return;
    }

    const upstream = await fetch(card.image);
    if (!upstream.ok || !upstream.body) {
      res.sendStatus(502);
      return;
    }

    const ext = (card.image.split("?")[0] ?? "").split(".").pop()?.toLowerCase() ?? "";
    const upstreamType = upstream.headers.get("content-type") ?? "";
    const type =
      IMAGE_TYPES[ext] ?? (upstreamType.startsWith("image/") ? upstreamType : "image/jpeg");

    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    req.log.error({ err, id }, "property share: preview image failed");
    res.sendStatus(502);
  }
});

router.get("/property/:id", async (req, res) => {
  const id = String(req.params["id"] ?? "").trim();
  const destination = humanPropertyUrl(id);

  if (!id) {
    res.redirect(302, destination);
    return;
  }

  let p: Awaited<ReturnType<typeof fetchPropertyForShare>> = null;
  try {
    p = await fetchPropertyForShare(id);
  } catch (err) {
    req.log.error({ err, id }, "property share: lookup failed");
  }

  // Unknown id, or the catalog is unreachable: send them on rather than
  // showing a broken card. A redirect is fine here — there is nothing better
  // to tell the crawler than what the site itself says.
  if (!p) {
    res.redirect(302, destination);
    return;
  }

  const title = [p.title, p.priceLabel].filter(Boolean).join(" — ");
  const descParts = [
    p.bedrooms ? `${p.bedrooms} bedrooms` : "",
    p.bathrooms ? `${p.bathrooms} bathrooms` : "",
    p.area ?? "",
    p.priceLabel ?? "",
  ].filter(Boolean);
  const description =
    descParts.join(" · ") || (p.description ?? "").slice(0, 180) || "Unicorn Property Bali";

  // Our own proxy, not the storage URL — see the /preview route above.
  // No og:image:width/height: we do not know this photo's real dimensions and
  // a wrong pair renders worse than none.
  const image = p.image ? `${publicBaseUrl()}/property/${encodeURIComponent(p.id)}/preview` : "";

  // 200 + client-side hop, never a 3xx: WhatsApp follows redirects, and
  // following one lands the crawler back on the SPA's generic tags — the bug
  // this route exists to fix.
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Unicorn Property Bali">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(destination)}">
${image ? `<meta property="og:image" content="${esc(image)}">` : ""}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
${image ? `<meta name="twitter:image" content="${esc(image)}">` : ""}
<link rel="canonical" href="${esc(destination)}">
<meta http-equiv="refresh" content="0; url=${esc(destination)}">
</head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:32px;text-align:center;color:#333">
<p>Opening ${esc(p.title)}…</p>
<p><a href="${esc(destination)}">Continue</a></p>
<script>location.replace(${JSON.stringify(destination)})</script>
</body>
</html>`;

  res.status(200);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // Short cache: a price edit on the site should reach the next share within
  // minutes, but a burst of crawler hits on one link must not hit Supabase
  // once per hit.
  res.setHeader("Cache-Control", "public, max-age=300");
  res.send(html);
});

export default router;
