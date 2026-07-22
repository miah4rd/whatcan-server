import { Router } from "express";
import { db, brokerSettingsTable, pendingSuggestionsTable, leadsSyncTable } from "@workspace/db";
import { eq, like, isNull, and, or } from "drizzle-orm";
import { getAllPropertiesForAdmin, invalidateCache } from "../lib/property-catalog";
import { processFollowups } from "../lib/followup-scheduler";
import { generateSuggestion } from "./amocrm-webhook";
import multer from "multer";
import path from "path";
import fs from "fs";
import { logger } from "../lib/logger";

const router = Router();

const UPLOAD_DIR = path.join(process.cwd(), "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    const key = (file.fieldname || "file") + "_" + Date.now() + ext;
    cb(null, key);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only images allowed"));
  },
});

router.use("/uploads", (req, res, next) => {
  const file = path.basename(req.path);
  res.sendFile(path.join(UPLOAD_DIR, file), (err) => {
    if (err) next();
  });
});

const PLAYBOOK_STORAGE_KEYS = [
  { key: "airdna_1", label: "AirDNA Screenshot 1" },
  { key: "airdna_2", label: "AirDNA Screenshot 2" },
  { key: "airdna_3", label: "AirDNA Screenshot 3" },
  { key: "airdna_4", label: "AirDNA Screenshot 4" },
  { key: "airdna_5", label: "AirDNA Screenshot 5" },
  { key: "eur_idr_1", label: "EUR/IDR Rate Screenshot 1" },
  { key: "eur_idr_2", label: "EUR/IDR Rate Screenshot 2" },
  { key: "eur_idr_3", label: "EUR/IDR Rate Screenshot 3" },
];

async function getImageUrls(): Promise<Record<string, string>> {
  const keys = PLAYBOOK_STORAGE_KEYS.map((k) => `playbook_img_${k.key}`);
  const rows = await db
    .select()
    .from(brokerSettingsTable)
    .where(like(brokerSettingsTable.key, "playbook_img_%"));
  const result: Record<string, string> = {};
  for (const row of rows) {
    const shortKey = row.key.replace("playbook_img_", "");
    result[shortKey] = row.value;
  }
  return result;
}

router.get("/admin/upload", async (_req, res) => {
  const urls = await getImageUrls();
  const items = PLAYBOOK_STORAGE_KEYS.map(({ key, label }) => {
    const url = urls[key] ?? null;
    const thumb = url ? `<br><img src="${url}" style="max-width:240px;max-height:160px;margin-top:6px;border-radius:6px;border:1px solid #ddd">` : "";
    const status = url
      ? `<span style="color:#16a34a">✓ Uploaded</span>`
      : `<span style="color:#dc2626">✗ Missing</span>`;
    return `
      <div style="margin-bottom:20px;padding:16px;background:#f9fafb;border-radius:8px;border:1px solid #e5e7eb">
        <strong>${label}</strong> — ${status}${thumb}
        <form method="POST" action="/api/admin/upload/${key}" enctype="multipart/form-data" style="margin-top:8px">
          <input type="file" name="${key}" accept="image/*" required style="font-size:13px">
          <button type="submit" style="margin-left:8px;padding:4px 12px;background:#2563eb;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px">Upload</button>
        </form>
      </div>`;
  }).join("");

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Unicorn Property — Playbook Images</title>
  <style>body{font-family:system-ui,sans-serif;max-width:700px;margin:40px auto;padding:0 20px}h1{font-size:22px;margin-bottom:4px}p.sub{color:#6b7280;font-size:14px;margin-bottom:28px}</style>
</head>
<body>
  <h1>📎 Playbook Image Manager</h1>
  <p class="sub">Upload the screenshots that get attached to follow-up messages. Once uploaded, they appear as clickable thumbnails in the Chrome extension for the broker to send.</p>
  ${items}
  <hr style="margin:32px 0;border:none;border-top:1px solid #e5e7eb">
  <p style="color:#6b7280;font-size:13px">Images are stored on the server and served over HTTPS. Max size: 10 MB per image.</p>
</body>
</html>`);
});

router.post("/admin/upload/:storageKey", upload.single("placeholder"), async (req, res) => {
  const storageKey = Array.isArray(req.params["storageKey"]) ? req.params["storageKey"][0] : req.params["storageKey"];
  const validKeys = PLAYBOOK_STORAGE_KEYS.map((k) => k.key);
  if (!storageKey || !validKeys.includes(storageKey)) {
    return void res.status(400).send("Unknown storage key");
  }

  const file = req.file;
  if (!file) return void res.status(400).send("No file uploaded");

  const publicUrl = `/api/uploads/${file.filename}`;

  await db
    .insert(brokerSettingsTable)
    .values({ key: `playbook_img_${storageKey}`, value: publicUrl })
    .onConflictDoUpdate({
      target: brokerSettingsTable.key,
      set: { value: publicUrl, updatedAt: new Date() },
    });

  logger.info({ storageKey, publicUrl }, "playbook image uploaded");
  res.redirect("/api/admin/upload");
});

/**
 * Admin: inspect or force-push a specific lead.
 * GET  /admin/lead-debug?leadId=123 — show DB state + pending suggestions
 * POST /admin/lead-debug?leadId=123 — force nextFollowupAt=past and run scheduler
 */
router.get("/admin/lead-debug", async (req, res) => {
  const leadId = String(req.query["leadId"] ?? "");
  if (!leadId) return void res.status(400).json({ error: "leadId required" });
  try {
    const [syncRow] = await db.select().from(leadsSyncTable).where(eq(leadsSyncTable.leadId, leadId));
    const pending = await db.select().from(pendingSuggestionsTable).where(eq(pendingSuggestionsTable.leadId, leadId));
    res.json({ sync: syncRow ?? null, pending });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post("/admin/lead-debug", async (req, res) => {
  const leadId = String(req.query["leadId"] ?? "");
  if (!leadId) return void res.status(400).json({ error: "leadId required" });
  try {
    const pastTime = new Date(Date.now() - 60_000);
    // Clear any stale LIVE suggestions for this lead before creating PUSH
    await db.delete(pendingSuggestionsTable).where(
      and(
        eq(pendingSuggestionsTable.leadId, leadId),
        eq(pendingSuggestionsTable.kind, "live"),
        eq(pendingSuggestionsTable.status, "pending"),
      ),
    );
    await db.update(leadsSyncTable)
      .set({ followupLevel: 0, nextFollowupAt: pastTime })
      .where(eq(leadsSyncTable.leadId, leadId));
    processFollowups()
      .then(() => logger.info({ leadId }, "lead-debug: force-push complete"))
      .catch((err) => logger.error({ err, leadId }, "lead-debug: force-push error"));
    res.json({ ok: true, message: `Cleared stale LIVE, scheduled force-push for lead ${leadId}. Check inbox in ~30s.` });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/**
 * Admin: mark all old push items (no objection_category) as skipped,
 * reset their leads' followup_level to 0, then immediately run the scheduler
 * so new playbook-based follow-ups are generated right away.
 */
router.post("/admin/regen-followups", async (_req, res) => {
  try {
    // 1. Find old pending push items with no objection_category
    const old = await db
      .select({ id: pendingSuggestionsTable.id, leadId: pendingSuggestionsTable.leadId })
      .from(pendingSuggestionsTable)
      .where(
        and(
          eq(pendingSuggestionsTable.status, "pending"),
          eq(pendingSuggestionsTable.kind, "push"),
          isNull(pendingSuggestionsTable.objectionCategory),
        ),
      );

    if (old.length === 0) {
      // Nothing to skip, but still force-trigger leads that have no pending push item
      const pastTime = new Date(Date.now() - 60_000);
      // Only reset leads where broker wrote last (or unknown) — never touch leads that replied
      const allLeads = await db
        .select({ leadId: leadsSyncTable.leadId, lastMessageFrom: leadsSyncTable.lastMessageFrom })
        .from(leadsSyncTable);
      const withPending = await db
        .select({ leadId: pendingSuggestionsTable.leadId })
        .from(pendingSuggestionsTable)
        .where(and(eq(pendingSuggestionsTable.status, "pending"), eq(pendingSuggestionsTable.kind, "push")));
      const pendingLeadIds = new Set(withPending.map((r) => r.leadId));
      const toReset = allLeads.filter(
        (r) => !pendingLeadIds.has(r.leadId) && r.lastMessageFrom !== "lead",
      );
      for (const { leadId } of toReset) {
        await db
          .update(leadsSyncTable)
          .set({ followupLevel: 0, nextFollowupAt: pastTime })
          .where(eq(leadsSyncTable.leadId, leadId));
      }
      processFollowups()
        .then(() => logger.info("regen: force-trigger complete"))
        .catch((err) => logger.error({ err }, "regen: force-trigger error"));
      return void res.json({ ok: true, message: `Force-triggered scheduler for ${toReset.length} leads. Refresh in ~60s.`, leads: toReset.map((r) => r.leadId) });
    }

    const leadIds = [...new Set(old.map((r) => r.leadId))];

    // 2. Mark old items as skipped
    for (const item of old) {
      await db
        .update(pendingSuggestionsTable)
        .set({ status: "skipped" })
        .where(eq(pendingSuggestionsTable.id, item.id));
    }

    // 3. Reset followup_level to 0 — only for leads where broker wrote last (never override lead-replied state)
    const pastTime = new Date(Date.now() - 60_000); // 1 minute ago
    for (const leadId of leadIds) {
      await db
        .update(leadsSyncTable)
        .set({ followupLevel: 0, nextFollowupAt: pastTime })
        .where(
          and(
            eq(leadsSyncTable.leadId, leadId),
            or(eq(leadsSyncTable.lastMessageFrom, "us"), isNull(leadsSyncTable.lastMessageFrom)),
          ),
        );
    }

    logger.info({ count: old.length, leadIds }, "regen: old push items skipped, running scheduler");

    // 4. Run scheduler immediately (async — don't block the response)
    processFollowups()
      .then(() => logger.info("regen: scheduler run complete"))
      .catch((err) => logger.error({ err }, "regen: scheduler error"));

    res.json({
      ok: true,
      message: `Skipped ${old.length} old items for ${leadIds.length} leads. Scheduler running — refresh in ~30 seconds.`,
      leads: leadIds,
      regenerated: old.length,
    });
  } catch (err) {
    logger.error({ err }, "regen-followups error");
    res.status(500).json({ error: String(err) });
  }
});

/**
 * Re-derive lastMessageFrom from stored content for all leads, then clean up bad push items.
 * Fixes corruption from regen that force-set lastMessageFrom="us" for everyone.
 */
router.post("/admin/fix-last-message-from", async (_req, res) => {
  try {
    const { parseDialogContent } = await import("../lib/dialog-parser");
    const allLeads = await db.select().from(leadsSyncTable);
    let fixed = 0;
    let cleanedPush = 0;

    for (const lead of allLeads) {
      if (!lead.content) continue;
      const dialog = parseDialogContent(lead.content);
      const actualFrom = dialog.lastMessage?.from ?? null;
      if (actualFrom && actualFrom !== lead.lastMessageFrom) {
        await db
          .update(leadsSyncTable)
          .set({ lastMessageFrom: actualFrom })
          .where(eq(leadsSyncTable.leadId, lead.leadId));
        fixed++;

        // If lead replied last — clear push queue and followup schedule
        if (actualFrom === "lead") {
          const result = await db
            .update(pendingSuggestionsTable)
            .set({ status: "skipped" })
            .where(
              and(
                eq(pendingSuggestionsTable.leadId, lead.leadId),
                eq(pendingSuggestionsTable.status, "pending"),
                eq(pendingSuggestionsTable.kind, "push"),
              ),
            );
          cleanedPush += (result as any).rowCount ?? 0;
          await db
            .update(leadsSyncTable)
            .set({ nextFollowupAt: null, followupLevel: 0 })
            .where(eq(leadsSyncTable.leadId, lead.leadId));
        }
      }
    }

    logger.info({ fixed, cleanedPush }, "fix-last-message-from complete");
    res.json({ ok: true, leadsFixed: fixed, pushItemsCleaned: cleanedPush });
  } catch (err) {
    logger.error({ err }, "fix-last-message-from error");
    res.status(500).json({ error: String(err) });
  }
});

/**
 * One-time cleanup: skip push suggestions for leads whose last message is FROM the lead.
 * Also resets nextFollowupAt=null for those leads so they never enter push series.
 */
router.post("/admin/cleanup-lead-replied", async (_req, res) => {
  try {
    const leadReplied = await db
      .select({ leadId: leadsSyncTable.leadId })
      .from(leadsSyncTable)
      .where(eq(leadsSyncTable.lastMessageFrom, "lead"));

    const leadIds = leadReplied.map((r) => r.leadId);
    let skipped = 0;

    for (const leadId of leadIds) {
      const result = await db
        .update(pendingSuggestionsTable)
        .set({ status: "skipped" })
        .where(
          and(
            eq(pendingSuggestionsTable.leadId, leadId),
            eq(pendingSuggestionsTable.status, "pending"),
            eq(pendingSuggestionsTable.kind, "push"),
          ),
        );
      skipped += (result as any).rowCount ?? 0;

      await db
        .update(leadsSyncTable)
        .set({ nextFollowupAt: null, followupLevel: 0 })
        .where(eq(leadsSyncTable.leadId, leadId));
    }

    logger.info({ leadIds, skipped }, "cleanup: removed push items for lead-replied leads");
    res.json({ ok: true, affectedLeads: leadIds.length, skippedItems: skipped, leadIds });
  } catch (err) {
    logger.error({ err }, "cleanup-lead-replied error");
    res.status(500).json({ error: String(err) });
  }
});

export async function getPlaybookImageUrls(): Promise<Record<string, string>> {
  return getImageUrls();
}

// ─────────────────────────────────────────────────────────────────────────────
// Property Catalog admin page — live view from Supabase
// ─────────────────────────────────────────────────────────────────────────────

router.get("/admin/properties", async (_req, res) => {
  const props = await getAllPropertiesForAdmin();

  const rows = props.map((p) => `
    <tr>
      <td><code style="font-size:11px">${p.id}</code></td>
      <td style="max-width:220px">${p.title}</td>
      <td>${p.area ?? ""}</td>
      <td>${p.type ?? ""}</td>
      <td>${p.bedrooms ?? ""}</td>
      <td>${p.ownership ?? ""}</td>
      <td>${p.displayPrice ?? ""}</td>
      <td>${p.status ?? ""}</td>
      <td><a href="${p.url}" target="_blank" style="color:#2563eb">↗ открыть</a></td>
    </tr>`).join("");

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Unicorn Property — Property Catalog</title>
  <style>
    body{font-family:system-ui,sans-serif;max-width:1200px;margin:40px auto;padding:0 20px}
    h1{font-size:22px;margin-bottom:4px}
    p.sub{color:#6b7280;font-size:14px;margin-bottom:24px}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th{background:#f3f4f6;padding:8px 10px;text-align:left;border-bottom:2px solid #e5e7eb}
    td{padding:7px 10px;border-bottom:1px solid #f3f4f6;vertical-align:top}
    tr:hover td{background:#fafafa}
    .btn{display:inline-block;padding:6px 16px;background:#2563eb;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;text-decoration:none}
    a.nav{color:#2563eb;font-size:13px;margin-right:16px}
    .info{background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:14px 18px;margin-bottom:24px;font-size:13px;color:#1e40af}
  </style>
</head>
<body>
  <p><a class="nav" href="/api/admin/upload">← Playbook Images</a></p>
  <h1>🏡 Property Catalog</h1>
  <p class="sub">Объекты тянутся напрямую с unicorn-properties.com (Supabase). Обновляются автоматически — кэш 10 минут.</p>

  <div class="info">
    Данные синхронизируются с сайтом в реальном времени. Добавишь/уберёшь объект на сайте — AI увидит изменения в течение 10 минут.
    <br><br>
    <a href="/api/admin/properties/refresh" class="btn">🔄 Сбросить кэш сейчас</a>
  </div>

  <p style="color:#6b7280;font-size:13px;margin-bottom:12px">${props.length} объект(ов) в каталоге</p>
  ${props.length > 0 ? `
  <table>
    <thead><tr>
      <th>ID</th><th>Название</th><th>Район</th><th>Тип</th>
      <th>BR</th><th>Владение</th><th>Цена</th><th>Статус</th><th>Ссылка</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>` : `<p style="color:#dc2626">Не удалось загрузить объекты. Проверь SUPABASE_URL и SUPABASE_ANON_KEY.</p>`}
</body>
</html>`);
});

router.get("/admin/properties/refresh", (_req, res) => {
  invalidateCache();
  res.redirect("/api/admin/properties");
});

// ── Quick test: generate a suggestion from a raw dialog snippet ──────────────
router.post("/admin/test-suggest", async (req, res) => {
  const { content, lastLeadMessage, leadNotes, kind } = req.body as {
    content?: string;
    lastLeadMessage?: string;
    leadNotes?: string;
    kind?: "live" | "push";
  };
  if (!content) {
    res.status(400).json({ error: "content required" });
    return;
  }
  try {
    const text = await generateSuggestion({
      leadId: "test-001",
      responsibleUser: "Robert",
      kind: kind ?? "live",
      lastLeadMessage: lastLeadMessage ?? content,
      contentSnippet: content,
      leadNotes: leadNotes ?? null,
    });
    // Split multi-property responses into individual WhatsApp messages
    const messages = text
      ? text.split(/\n(?=https?:\/\/)/).map((p) => p.trim()).filter(Boolean)
      : [];
    const isMulti = messages.length > 1;
    res.json({ text, messages: isMulti ? messages : undefined, count: isMulti ? messages.length : 1 });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
