/**
 * The filed viewing report as prompt context. Its own tiny module so the
 * generators can read it without importing viewing-report.ts (which itself
 * calls the generators — a cycle otherwise).
 */
import { db, viewingReportsTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";

const LABEL: Record<string, string> = {
  go: "Going ahead",
  think: "Liked it, needs time",
  no: "Not this one",
  no_show: "Client didn't show",
  cancelled: "Cancelled by the villa",
  rescheduled: "Rescheduled",
};

export async function latestFiledReport(leadId: string) {
  const [r] = await db
    .select()
    .from(viewingReportsTable)
    .where(and(eq(viewingReportsTable.leadId, leadId), eq(viewingReportsTable.status, "filed")))
    .orderBy(desc(viewingReportsTable.viewingAt))
    .limit(1);
  return r ?? null;
}

/**
 * What the broker saw at the viewing, for every draft written after it. Without
 * this the bot answered a client who had just rejected a villa for its mould
 * as if nothing had happened.
 */
export async function viewingReportPromptBlock(leadId: string): Promise<string> {
  const r = await latestFiledReport(leadId).catch(() => null);
  if (!r) return "";
  const when = r.viewingAt.toLocaleString("en-GB", { timeZone: "Asia/Makassar", day: "numeric", month: "short" });
  const steps = Array.isArray(r.nextSteps) && r.nextSteps.length ? r.nextSteps.join(", ") : "not set";
  return `
VIEWING REPORT (filed by the broker after the viewing${r.propertyCode ? ` of ${r.propertyCode}` : ""} on ${when} — the client has NOT seen this):
- outcome: ${LABEL[r.outcome ?? ""] ?? r.outcome ?? "unknown"}
- client's feedback, in the broker's words: ${r.feedback?.trim() || "none noted"}
- broker's next steps: ${steps}${r.nextBy ? ` by ${r.nextBy}` : ""}
Write from this: acknowledge what they felt, never re-offer what they rejected or repeat a flaw they named as a feature, and move the agreed next step forward. Never mention the report.
`;
}
