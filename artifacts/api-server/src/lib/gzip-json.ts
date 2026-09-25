/**
 * Compress JSON answers for clients that ask for it (Accept-Encoding: gzip).
 *
 * The drafts list is ~0.5 MB per broker and crossed Bali ↔ Germany raw: the
 * OS (through the site's Cloudflare proxy) and the Copilot both waited on it.
 * Only res.json is touched and only above 2 KB; a client that does not accept
 * gzip gets exactly what it got before.
 */
import zlib from "node:zlib";
import type { Request, Response, NextFunction } from "express";

export function gzipJson(req: Request, res: Response, next: NextFunction): void {
  if (!/\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) return next();
  const plain = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (res.headersSent) return plain(body);
    const buf = Buffer.from(JSON.stringify(body) ?? "null");
    if (buf.length < 2048) return plain(body);
    const gz = zlib.gzipSync(buf, { level: 5 });
    if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Vary", "Accept-Encoding");
    res.setHeader("Content-Length", String(gz.length));
    res.end(gz);
    return res;
  }) as Response["json"];
  next();
}
