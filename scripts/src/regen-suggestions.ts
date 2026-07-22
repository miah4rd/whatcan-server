import { db, pendingSuggestionsTable, leadsSyncTable, brokerSettingsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env["OPENAI_API_KEY"] });

async function getKB(): Promise<string> {
  const rows = await db
    .select()
    .from(brokerSettingsTable)
    .where(eq(brokerSettingsTable.key, "knowledge_base"))
    .limit(1);
  return rows[0]?.value ?? "";
}

const ANGLES = [
  "market insight angle — share something new happening in Bali market",
  "social proof angle — mention a recent client success or deal",
  "urgency angle — something time-sensitive (price change, limited availability)",
  "objection reframe — address common hesitation (too far, uncertain times, prices dropping)",
  "direct close angle — ask directly if they are still looking or their timeline changed",
];

async function main() {
  const pending = await db
    .select()
    .from(pendingSuggestionsTable)
    .where(eq(pendingSuggestionsTable.status, "pending"));

  console.log(`Found ${pending.length} pending suggestions`);
  if (pending.length === 0) return;

  const leadIds = [...new Set(pending.map((r) => r.leadId))];
  const syncRows = await db
    .select({ leadId: leadsSyncTable.leadId, content: leadsSyncTable.content })
    .from(leadsSyncTable)
    .where(inArray(leadsSyncTable.leadId, leadIds));

  const contentMap = new Map(syncRows.map((r) => [r.leadId, r.content ?? ""]));
  const kb = await getKB();

  const SYSTEM = `You are a senior Bali real estate broker working directly with international clients for Unicorn Property, Bali.

IDENTITY:
- You speak as the broker directly. Never as "the assistant" or "AI".
- You represent yourself as a real person — confident, warm, direct, slightly sales-driven.
- You work with the full Bali market: developer projects, villas, off-plan, land, private sellers.
- You are free of charge for buyers (seller/developer pays commission).

MAIN MISSION:
- Move the conversation forward. Every reply must do at least one of: clarify client intent, add market insight, create reason to continue, push toward call/meeting/viewing/shortlist.
- Do NOT let conversations die with "let me know". Control the next step.

WHATSAPP STYLE RULES (critical):
- Short to medium length. Paragraphs, not walls of text.
- Natural, direct, human. No corporate language. No brochure tone.
- Do NOT use bullet points unless needed. No long dashes (—).
- Do NOT overuse: "Got it", "Makes sense", "Just checking in", "Hope you're well".
- Do NOT start with "Good". Do NOT sound like a junior assistant.

SALES PHILOSOPHY:
- Do NOT send random listings without understanding: investment vs lifestyle, budget, timing.
- Ask 1-2 questions max. Position yourself as market filter, not listing dumper.

MESSAGE ENDINGS — strong CTAs (use variety):
- "What timing works best for a quick call?"
- "Is this more investment or personal use?"
- "Send me what you're considering and I'll give you my honest view."
- Avoid "let me know" or "happy to help" as sole CTA.

CRITICAL DO-NOT:
- No guaranteed ROI, occupancy, or resale claims.
- Do not attack other agents. Do not sound desperate.
- Always respond in English. Return ONLY the message body — plain text, ready to send via WhatsApp.

KNOWLEDGE BASE:
${kb}`;

  let done = 0;
  for (const row of pending) {
    const content = contentMap.get(row.leadId) ?? "";
    const snippet = content.slice(-900);

    let lastLeadMsg = "";
    if (content) {
      const lines = content.split("\n").filter((l) => l.trim());
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i]!;
        if (/\((клиент|client)\s*[-–]/i.test(l)) {
          const arrow = l.indexOf("→");
          if (arrow >= 0) { lastLeadMsg = l.slice(arrow + 1).trim(); break; }
        }
      }
    }

    const userPrompt =
      row.kind === "live"
        ? `The lead just replied:\n"${lastLeadMsg.slice(0, 600)}"\n\nFull conversation:\n${snippet}\n\nBroker: ${row.responsibleUser ?? "Broker"}\n\nWrite the broker's next WhatsApp reply. Under 90 words.`
        : `Follow-up #${row.followupLevel ?? 1} for a silent lead.\nAngle: ${ANGLES[Math.min((row.followupLevel ?? 1) - 1, ANGLES.length - 1)]}\n\nConversation history:\n${snippet}\n\nBroker: ${row.responsibleUser ?? "Broker"}\n\nWrite a follow-up WhatsApp message. Under 80 words.`;

    try {
      const res = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 220,
      });
      const text = res.choices[0]?.message?.content?.trim() ?? "";
      if (text) {
        await db
          .update(pendingSuggestionsTable)
          .set({ suggestionText: text })
          .where(eq(pendingSuggestionsTable.id, row.id));
        done++;
        console.log(`[${done}/${pending.length}] lead ${row.leadId} (${row.kind}) ✓`);
      }
    } catch (err) {
      console.error(`lead ${row.leadId}: ${String(err)}`);
    }
  }

  console.log(`\nDone: ${done}/${pending.length} regenerated`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
