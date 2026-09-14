/**
 * Read-only replay of the owner-facing writers on real past conversations (CLAUDE.md "The owner is
 * never asked twice, in Yudi's words"). Nothing is sent, no card, stage, fact or draft is written;
 * the only rows it adds are ai_usage.
 *
 * Bundled and run on the server from a worktree, never from /opt/whatcan:
 *   node dist-replay/replay-owner-drafts.mjs cases.json out.jsonl
 *
 * cases.json: [{ "id": "…", "kind": "reply" | "nudge", "leadId": "23497759",
 *               "asOf": "2026-09-12T05:03:00Z", "old": "the text that went out then" }]
 */
import { readFileSync, appendFileSync } from "node:fs";
import { db, leadsSyncTable, leadMessagesTable } from "@workspace/db";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { generateListingAcquisitionReply } from "../lib/listing-acquisition-prompt";
import { meetsQualified } from "../lib/listing-card-fields";
import { ownerThreadKnown, stripRepeatedAsks } from "../lib/owner-thread-known";
import { composeNudge, nudgeAsks } from "../lib/listing-owner-followup";
import { villaFromLeadName, fetchLeadTitle, fetchOwnerName } from "../lib/weekly-availability-check";
import { ownerThreadLanguage } from "../lib/yudi-voice";

type Case = { id?: string; kind: "reply" | "nudge"; leadId: string; asOf: string; old: string };

async function replayOne(c: Case): Promise<Record<string, unknown>> {
  const asOf = new Date(c.asOf);
  const known = await ownerThreadKnown(c.leadId, { asOf });
  let fresh = "";
  let asks: string[] = [];
  if (c.kind === "reply") {
    const [row] = await db
      .select({ responsibleUser: leadsSyncTable.responsibleUser, content: leadsSyncTable.content, leadNotes: leadsSyncTable.leadNotes })
      .from(leadsSyncTable)
      .where(eq(leadsSyncTable.leadId, c.leadId))
      .limit(1);
    const [lastIn] = await db
      .select({ text: leadMessagesTable.text })
      .from(leadMessagesTable)
      .where(
        and(
          eq(leadMessagesTable.leadId, c.leadId),
          eq(leadMessagesTable.senderType, "lead"),
          lt(leadMessagesTable.sentAt, asOf),
          sql`${leadMessagesTable.text} IS NOT NULL`,
        ),
      )
      .orderBy(desc(leadMessagesTable.sentAt))
      .limit(1);
    const out = await generateListingAcquisitionReply({
      leadId: c.leadId,
      responsibleUser: row?.responsibleUser ?? "Yudi",
      kind: "live",
      lastLeadMessage: lastIn?.text ?? "",
      contentSnippet: row?.content ?? "",
      leadNotes: row?.leadNotes ?? null,
      replayAsOf: asOf,
    });
    fresh = out.text;
  } else {
    const a = nudgeAsks(known, known.facts ? meetsQualified(known.facts).missing : null);
    asks = a;
    const villa = villaFromLeadName(await fetchLeadTitle(c.leadId));
    const owner = await fetchOwnerName(c.leadId, villa);
    fresh = composeNudge({ owner, villa, lang: ownerThreadLanguage(known.lines), asks: a, at: asOf });
  }
  const oldCheck = stripRepeatedAsks(c.old, known);
  const newCheck = stripRepeatedAsks(fresh, known);
  return {
    id: c.id,
    kind: c.kind,
    leadId: c.leadId,
    asOf: c.asOf,
    known: Object.keys(known.known),
    asks,
    old: c.old,
    new: fresh,
    oldRepeated: [...oldCheck.removed, ...oldCheck.kept].map((f) => f.repeated),
    newRepeated: [...newCheck.removed, ...newCheck.kept].map((f) => f.repeated),
  };
}

async function main(): Promise<void> {
  const [casesPath, outPath] = [process.argv[2], process.argv[3]];
  if (!casesPath || !outPath) {
    console.error("usage: replay-owner-drafts <cases.json> <out.jsonl>");
    process.exit(2);
  }
  const cases = JSON.parse(readFileSync(casesPath, "utf8")) as Case[];
  for (const c of cases) {
    try {
      appendFileSync(outPath, JSON.stringify(await replayOne(c)) + "\n");
    } catch (err) {
      appendFileSync(outPath, JSON.stringify({ id: c.id, leadId: c.leadId, error: String(err) }) + "\n");
    }
  }
  process.exit(0);
}

void main();
