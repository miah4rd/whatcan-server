/**
 * Finishes property-link sends that stopped halfway.
 *
 * 25.09.2026: two of Amelia's shortlists went out as a lead-in with no villas
 * under it (Kurito 0 of 6, Olya 2 of 4). The gateway refused messages for
 * pacing, sendAttachmentLinks stopped where it was, nothing came back for the
 * rest, and the broker saw "sent". Any refusal can do that — pacing, a session
 * reconnecting, the network — so the fix is not one limit but this pass.
 *
 * Every minute: a send whose delivery record says "links k/n" with k < n, older
 * than 90 seconds and not still running, is resumed from k through the same
 * sendAttachmentLinks. Nothing already out is sent twice: on our own lines the
 * send checks what left the number since the original send (wa_messages, the
 * broker's phone included); on Salesbot lines, the conversation. A retry comes
 * every 2 minutes; after 10 the broker gets a push with the lead and how many
 * villas reached the client, and the record is marked so nobody is chased twice.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";
import { sendAttachmentLinks, LINK_PROGRESS, linkSendsInFlight } from "./outbound-send";
import { notifyBroker } from "./push-notifications";

/** Only sends from this fix on: older gaps were closed by hand (Kurito, Olya, 25.09). */
export const RESUME_FROM = new Date("2026-09-25T04:30:00Z");
const RETRY_EVERY_MS = 2 * 60_000;
const MAX_ATTEMPTS = 10;
const GAVE_UP = "resume-gave-up";

const attempts = new Map<string, { n: number; at: number }>();
let running = false;

type Row = {
  id: string;
  lead_id: string;
  suggestion_id: string | null;
  source_id: string | null;
  webhook_response: string | null;
  created_at: string | Date;
  responsible_user: string | null;
};

export type ResumeReport = { id: string; leadId: string; sent: number; total: number; action: string };

function rowsOf<T>(res: unknown): T[] {
  return ((res as { rows?: T[] }).rows ?? (Array.isArray(res) ? (res as T[]) : [])) as T[];
}

async function markGaveUp(id: string): Promise<void> {
  await db.execute(sql`UPDATE sent_messages SET webhook_response = coalesce(webhook_response, '') || ${` | ${GAVE_UP}`} WHERE id::text = ${id}`);
}

export async function resumeUnfinishedLinkSends(opts: { dry?: boolean; from?: Date } = {}): Promise<ResumeReport[]> {
  if (running) return [];
  running = true;
  const report: ResumeReport[] = [];
  try {
    const from = opts.from ?? RESUME_FROM;
    const rows = rowsOf<Row>(
      await db.execute(sql`
        SELECT id::text AS id, lead_id, suggestion_id::text AS suggestion_id, source_id::text AS source_id,
               webhook_response, created_at, responsible_user
          FROM sent_messages
         WHERE created_at > ${from.toISOString()}
           AND created_at < now() - interval '90 seconds'
           AND webhook_status = 200
           AND webhook_response ~ 'links [0-9]+/[0-9]+'
           AND webhook_response !~ ${GAVE_UP}
         ORDER BY created_at
         LIMIT 50`),
    );
    for (const row of rows) {
      const progress = LINK_PROGRESS.exec(row.webhook_response ?? "");
      if (!progress) continue;
      const sent = Number(progress[1]);
      const total = Number(progress[2]);
      if (sent >= total) continue;
      const base: ReportBase = { id: row.id, leadId: row.lead_id, sent, total };
      if (linkSendsInFlight.has(row.id)) {
        report.push({ ...base, action: "still sending" });
        continue;
      }
      const tried = attempts.get(row.id) ?? { n: 0, at: 0 };
      if (Date.now() - tried.at < RETRY_EVERY_MS) {
        report.push({ ...base, action: "waiting for the next retry" });
        continue;
      }

      const [sug] = rowsOf<{ attachments: unknown; lead_stage: string | null }>(
        await db.execute(sql`
          SELECT p.attachments, l.lead_stage
            FROM pending_suggestions p LEFT JOIN leads_sync l ON l.lead_id::text = p.lead_id
           WHERE p.id::text = ${row.suggestion_id ?? ""}`),
      );
      const links = (Array.isArray(sug?.attachments) ? (sug!.attachments as Array<{ type?: string; url?: string | null }>) : []).filter(
        (a) => a && a.type === "link" && a.url,
      );
      if (links.length !== total) {
        report.push({ ...base, action: `cannot resume: the draft holds ${links.length} links, the send had ${total}` });
        if (!opts.dry) await markGaveUp(row.id);
        continue;
      }
      if (/closed|lost|won/i.test(sug?.lead_stage ?? "")) {
        report.push({ ...base, action: "lead closed — left as is" });
        if (!opts.dry) await markGaveUp(row.id);
        continue;
      }
      if (opts.dry) {
        report.push({ ...base, action: `would resume from link ${sent + 1}` });
        continue;
      }

      attempts.set(row.id, { n: tried.n + 1, at: Date.now() });
      const hook = (row.webhook_response ?? "").replace(LINK_PROGRESS, "").trim();
      const createdAt = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
      const now = await sendAttachmentLinks(row.lead_id, links, sent, row.id, hook, logger, null, row.source_id, {
        since: new Date(createdAt.getTime() - 60_000),
      });
      if (now >= total) {
        attempts.delete(row.id);
        logger.info({ leadId: row.lead_id, sentId: row.id, from: sent, total }, "link resume: the rest of the villas went out");
        report.push({ ...base, action: `finished (${sent} → ${total})` });
        continue;
      }
      logger.warn({ leadId: row.lead_id, sentId: row.id, sent: now, total, attempt: tried.n + 1 }, "link resume: still not all villas out — will retry");
      report.push({ ...base, sent: now, action: `retry ${tried.n + 1} of ${MAX_ATTEMPTS} stopped at ${now}` });
      if (tried.n + 1 >= MAX_ATTEMPTS) {
        attempts.delete(row.id);
        await markGaveUp(row.id);
        const broker = (row.responsible_user ?? "").trim().toLowerCase() || null;
        await notifyBroker(
          broker,
          "Villa links not delivered",
          `Lead #${row.lead_id}: only ${now} of ${total} villa links reached the client. Open the card and send the rest.`,
          `/m?lead=${row.lead_id}`,
        ).catch(() => 0);
        logger.error({ leadId: row.lead_id, sentId: row.id, sent: now, total }, "link resume: gave up — the broker was told");
      }
    }
  } catch (err) {
    logger.error({ err }, "link resume pass failed");
  } finally {
    running = false;
  }
  return report;
}

type ReportBase = { id: string; leadId: string; sent: number; total: number };

export function startLinkResume(): void {
  setInterval(() => {
    resumeUnfinishedLinkSends().catch((err) => logger.error({ err }, "link resume pass threw"));
  }, 60_000);
}
