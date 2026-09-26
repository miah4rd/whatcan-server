/**
 * Unicorn OS — every automation the Copilot runs, in plain words, with its
 * real switch where one exists.
 *
 * Nothing is re-implemented: the switches are the same settings the code reads
 * today (autopilot_settings, budget_filter_settings, broker_settings keys), and
 * they are written through the same setters the /m panel and the admin routes
 * use. A rule without a switch is shown with how it behaves and where its
 * status is visible — the owner asked for the trigger system to be copied, not
 * reinvented, and for autopilot to be a clear per-stage system.
 */
import { pool } from "@workspace/db";
import { getAutopilotSetting, setAutopilotSetting, type AutopilotMode } from "../autopilot";
import { getBudgetFilter, setBudgetFilter } from "../budget-filter";
import { getPipelineStages } from "../stage-classifier";
import { audit, type OsUser } from "./auth";

type Switch =
  | { kind: "autopilot"; pipeline: string }
  | { kind: "budget"; pipeline: string }
  | { kind: "setting"; key: string; values: string[]; default: string };

type Rule = {
  id: string;
  group: "Rental clients" | "Villa owners (Rental Listings)" | "Sales" | "Everyone" | "Safety";
  name: string;
  when: string;
  does: string;
  notifies: string;
  owner: "code" | "person" | "site";
  switch?: Switch;
};

const RULES: Rule[] = [
  // ── Rental clients ──
  { id: "ad-welcome", group: "Rental clients", name: "Welcome on a new form lead", owner: "code",
    when: "A Meta form, website form or catalog form lead is created in Rental.",
    does: "Sends one template, no AI: \"Got your request: … Did I get that right?\" No link. Withheld when every place named is one we have no villas in (the card is flagged ⊘ Review).",
    notifies: "Nobody; the thread shows it.",
    switch: { kind: "setting", key: "ad_auto_welcome", values: ["on", "off"], default: "on" } },
  { id: "opening", group: "Rental clients", name: "Broker's first message after 15 minutes", owner: "code",
    when: "15 minutes after the welcome, if the client did not answer.",
    does: "Drafts the first real message from the form answers (LIVE), with a shortlist; the clicked villa rides last.",
    notifies: "Web push to the broker." },
  { id: "live", group: "Rental clients", name: "Reply draft on every client message", owner: "code",
    when: "A client writes (amoCRM webhook, a 45-second poll and a 30-minute sweep; 5-second quiet window).",
    does: "Picks villas first (price ladder 70–125% of budget, exact bedrooms, named areas, free on the move-in date, never re-sent), then writes the reply in the broker's voice. Deterministic checks before it reaches the inbox.",
    notifies: "Web push with the client's own words." },
  { id: "followup", group: "Rental clients", name: "Follow-up ladder", owner: "code",
    when: "Exactly 24 h after our last message with no reply (the amoCRM task is the clock).",
    does: "PUSH drafts in the broker's voice; after a shortlist every draft asks for a viewing; objections get a new shortlist.",
    notifies: "Web push; amoCRM task badge." },
  { id: "promises", group: "Rental clients", name: "Promises the broker made", owner: "code",
    when: "A sent message contains a promise (\"I'll check with the owner and get back to you\").",
    does: "Creates a dated reminder (+4 h for owner questions) and puts it on top of the morning report.",
    notifies: "Web push at the due time; the 08:00 report." },
  { id: "stage-sync", group: "Rental clients", name: "Stages follow the conversation", owner: "code",
    when: "Any new message, ours or theirs (75-second debounce).",
    does: "Floors: anything sent → need assessed; a villa link → Options sent. Viewing scheduled needs an agreed slot; moving back needs evidence. Closed won / lost, Contract signed and Check-in only by a person.",
    notifies: "Nothing; a daily self-check at 09:00 alerts the owner if stages disagree with amoCRM." },
  { id: "viewing-report", group: "Rental clients", name: "Viewing report", owner: "code",
    when: "30 minutes after an agreed viewing slot.",
    does: "Creates the task \"Fill the viewing report\"; a filed report (go / think / no) moves the card to Viewing done, feeds every later draft, creates the next-step task and a task on the villa's card.",
    notifies: "Web push; amoCRM task." },
  { id: "budget-gate", group: "Rental clients", name: "Budget gate", owner: "code",
    when: "A new Rental lead states a budget below the threshold.",
    does: "Closes the card as lost before any message or AI spend.",
    notifies: "Nobody.",
    switch: { kind: "budget", pipeline: "rental" } },
  { id: "area-gate", group: "Rental clients", name: "Area gate (temporary)", owner: "code",
    when: "The form names only Uluwatu, Ubud or Sanur (first touch only).",
    does: "Closes the card as lost with no message. Lifting it is the owner's word (code list EXCLUDED_AREAS).",
    notifies: "Nobody." },
  { id: "autopilot-rental", group: "Rental clients", name: "Autopilot · Rental", owner: "person",
    when: "A draft is born on a card in a delegated stage.",
    does: "Sends it without approval, 10:00–20:00 Bali for proactive messages, within the daily cap. Readiness per situation is measured (share of drafts sent untouched).",
    notifies: "Nothing; the draft shows as sent by the bot.",
    switch: { kind: "autopilot", pipeline: "rental" } },

  // ── Villa owners ──
  { id: "autopilot-listings", group: "Villa owners (Rental Listings)", name: "Autopilot · Rental Listings", owner: "person",
    when: "A draft is born on a villa card in a delegated stage.",
    does: "Sends owner replies and nudges itself, in Yudi's voice, 10:00–20:00 Bali, 9 first contacts a day per WhatsApp line, never re-asking what the owner answered.",
    notifies: "Nothing.",
    switch: { kind: "autopilot", pipeline: "rental listings" } },
  { id: "nudges", group: "Villa owners (Rental Listings)", name: "Owner nudge ladder", owner: "code",
    when: "24, 72 and 120 hours of owner silence on Initial Contact / TAKEN TO WORK.",
    does: "Asks only the points still open, in the owner's language. Nothing open, no nudge. Three unanswered: closed.",
    notifies: "Nothing (autopilot sends)." },
  { id: "engine", group: "Villa owners (Rental Listings)", name: "Listing stage engine", owner: "code",
    when: "A reply is generated, a message is sent, and the daily audit after 09:00.",
    does: "Moves the card by facts: TAKEN TO WORK, QUALIFIED (bedrooms, price with our 10%, owner side, minimum stay, viewing day, price floor), long term (owner's own date beyond 90 days), co-broke (third party confirmed), lost (second opinion).",
    notifies: "Yudi gets the daily audit push." },
  { id: "inspection-ask", group: "Villa owners (Rental Listings)", name: "Inspection booking asks", owner: "code",
    when: "A QUALIFIED card with no agreed visit (every 30 minutes, 08:00–18:00).",
    does: "Drafts an ask in Yudi's words with two times from his calendar; at most 3 asks, 2 days apart.",
    notifies: "Web push \"Inspection asks ready\"." },
  { id: "visit-agreed", group: "Villa owners (Rental Listings)", name: "Visit agreed → Inspection scheduled", owner: "code",
    when: "The thread shows a visit both sides agreed for a concrete day.",
    does: "Moves the card to Inspection scheduled, records the slot and adds the event to the Brokers Google Calendar (the calendar is only ever added to, never edited).",
    notifies: "Google Calendar." },
  { id: "inspection-report", group: "Villa owners (Rental Listings)", name: "Inspection report", owner: "code",
    when: "30 minutes after an agreed inspection.",
    does: "Opens the report (flags, notes, photos, video, Listed switch); every change is read back from the site.",
    notifies: "Web push; WhatsApp group post when done." },
  { id: "listed-switch", group: "Villa owners (Rental Listings)", name: "Listed switch → live", owner: "site",
    when: "Someone switches a listing Pre-listed → Listed on the site (journaled).",
    does: "Moves the villa's card to live with a note. Listed → Pre-listed never moves a card back.",
    notifies: "Push to Yudi when a card cannot be moved." },
  { id: "weekly-check", group: "Villa owners (Rental Listings)", name: "Weekly availability check", owner: "code",
    when: "A live listing, 7 days since our last word, 10:00–17:00 Bali.",
    does: "One fixed sentence, no AI. An exact date from the owner goes to the site's availability and is read back; unclear answers become a draft with no push.",
    notifies: "Nobody (owner's rule).",
    switch: { kind: "setting", key: "weekly_availability_mode", values: ["on", "dry", "off"], default: "dry" } },
  { id: "long-term", group: "Villa owners (Rental Listings)", name: "Long term re-check", owner: "code",
    when: "14 days before the free date the owner gave.",
    does: "Moves the card back to TAKEN TO WORK and drafts the availability question.",
    notifies: "Nothing." },

  // ── Sales ──
  { id: "autopilot-sales", group: "Sales", name: "Autopilot · UNICORN", owner: "person",
    when: "A draft is born on a sales card in a delegated stage.",
    does: "Sends it without approval within the daily cap.",
    notifies: "Nothing.",
    switch: { kind: "autopilot", pipeline: "unicorn" } },
  { id: "sales-followup", group: "Sales", name: "Sales follow-ups 1 / 3 / 5 days", owner: "code",
    when: "Silence after our message (adaptive 2 / 4 / 7 / 14 / 30 days on long silences).",
    does: "PUSH drafts with the objection playbook.",
    notifies: "Web push." },

  // ── Everyone ──
  { id: "morning-report", group: "Everyone", name: "Morning report 08:00", owner: "code",
    when: "Every day 08:00 Bali.",
    does: "A to-do list first: promises › waiting clients › drafts › overdue; numbers underneath.",
    notifies: "Web push to each broker." },
  { id: "qc", group: "Everyone", name: "Quality control report 10:00", owner: "code",
    when: "Every day 10:00 Bali, about yesterday.",
    does: "Reply times in working minutes, who is waiting, phone vs Copilot, missing reports, overdue promises, two coaching notes with verbatim quotes.",
    notifies: "WhatsApp team group.",
    switch: { kind: "setting", key: "qc_enabled", values: ["on", "off"], default: "off" } },
  { id: "objections", group: "Everyone", name: "Objection log", owner: "code",
    when: "Every two hours, 07:00–22:00 Bali.",
    does: "Reads what Rental clients wrote after getting options and every filed viewing report, files each objection with its category and the client's words.",
    notifies: "Nothing; shown in Analytics." },
  { id: "weekly-brief", group: "Everyone", name: "Weekly bottleneck brief", owner: "code",
    when: "Monday 08:30 Bali, about the previous Mon–Sun week.",
    does: "Writes target vs fact, the 2–3 bottlenecks with evidence and client quotes, and what to do this week.",
    notifies: "Shown in Analytics → Bottlenecks." },

  // ── Safety ──
  { id: "ai", group: "Safety", name: "AI on / off", owner: "person",
    when: "Every model call.",
    does: "Off: every AI call refuses (no drafts, no classification). A daily cost cap also applies.",
    notifies: "Owner alert on an AI outage.",
    switch: { kind: "setting", key: "ai_enabled", values: ["on", "off"], default: "on" } },
  { id: "wa-watchdog", group: "Safety", name: "WhatsApp watchdog", owner: "code",
    when: "A broker number is unlinked or down.",
    does: "Alerts the owner with a relink link; sends are paced (15 per 10 minutes on Yudi's line).",
    notifies: "Owner push." },
];

async function readSetting(key: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT value FROM broker_settings WHERE key = $1`, [key]);
  return rows[0]?.value ?? null;
}

export async function automations(staff: boolean) {
  const out = [];
  for (const r of RULES) {
    let value: unknown = null;
    let options: unknown = null;
    try {
      if (r.switch?.kind === "autopilot") {
        const s = await getAutopilotSetting(r.switch.pipeline);
        const st = await getPipelineStages(r.switch.pipeline).catch(() => null);
        value = s;
        options = (st?.selectable ?? []).map((x) => x.name).filter((n) => !/closed|won|lost|сделка|лост/i.test(n));
      } else if (r.switch?.kind === "budget") {
        value = await getBudgetFilter(r.switch.pipeline);
      } else if (r.switch?.kind === "setting") {
        value = (await readSetting(r.switch.key)) ?? r.switch.default;
        options = r.switch.values;
      }
    } catch {
      value = null;
    }
    out.push({ ...r, value, options, editable: staff && !!r.switch });
  }
  return { rules: out };
}

