/**
 * Updates the "last active chat messenger" custom field on a lead in amoCRM.
 * Field ID 967477 was created manually in amoCRM UI (API didn't allow creation).
 *
 * Also provides ensureMessengerField() which lazily fills the field on first approve:
 * 1. Reads current value via v4 API
 * 2. If empty, scans lead page via Puppeteer to find channel name
 * 3. Fills the field
 */
import { logger } from "./logger";

const AMO_BASE = `https://${process.env.AMO_SUBDOMAIN ?? "unicornproperty"}.amocrm.ru`;
const LOGIN = process.env.AMO_LOGIN ?? "unicorn.properties.office@gmail.com";
const PASSWORD = process.env.AMO_PASSWORD ?? "UnicornProperty00!";
const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH ?? undefined;

const LAST_MESSENGER_FIELD_ID = 967477;

// Source ID → channel name mapping
const SOURCE_MAP: Record<number, string> = {
  58745: "Robert",
  56811: "Amelia",
  62249: "Nick",
  56951: "Sharon",
  59537: "Yudi",
  59891: "Wa Grey",
  59893: "Saif",
  61161: "Kristo",
  61183: "Phone 1",
  61185: "Phone 2",
  61191: "Ferdian",
};

const KNOWN_BOT_NAMES = Object.values(SOURCE_MAP);

// Integration origin → default channel name
const INTEGRATION_DEFAULT: Record<string, string | null> = {
  "wahelp.whatbot": null, // determined from DOM
  "ru.wababa.amocrm": "Phone 1",
};

export function getLastMessengerFieldId(): number {
  return LAST_MESSENGER_FIELD_ID;
}

/**
 * Read the current value of field 967477 for a lead via v4 API.
 */
async function readMessengerField(leadId: string): Promise<string | null> {
  const TOKEN = process.env.AMOCRM_LONG_LIVED_TOKEN ?? "";
  if (!TOKEN) return null;

  try {
    const res = await fetch(`${AMO_BASE}/api/v4/leads/${leadId}?custom_fields_values=true`, {
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    });
    if (!res.ok) return null;
    const lead = await res.json();
    const field = lead.custom_fields_values?.find((f: any) => f.field_id === LAST_MESSENGER_FIELD_ID);
    return field?.values?.[0]?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Scan lead page via Puppeteer to find the channel name.
 * Returns the channel name or null if not found.
 */
async function scanLeadPageForChannel(leadId: string): Promise<string | null> {
  let puppeteerCore: any;
  try {
    puppeteerCore = await import("puppeteer-core");
  } catch {
    logger.warn("puppeteer-core not installed — cannot scan lead page");
    return null;
  }

  const chromePath = CHROME_PATH || "/root/.cache/puppeteer/chrome/linux-150.0.7871.24/chrome-linux64/chrome";
  const browser = await puppeteerCore.default.launch({
    headless: true,
    executablePath: chromePath,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();

    // Login
    await page.goto(AMO_BASE + "/", { waitUntil: "networkidle2", timeout: 30000 });
    const li = await page.$('input[name="login"], input[type="email"], input[type="text"]');
    const pi = await page.$('input[name="password"], input[type="password"]');
    if (li && pi) {
      await li.click({ clickCount: 3 });
      await li.type(LOGIN, { delay: 15 });
      await pi.click({ clickCount: 3 });
      await pi.type(PASSWORD, { delay: 15 });
      const btn = await page.$('button[type="submit"], input[type="submit"]');
      if (btn) await btn.click();
      else await page.keyboard.press("Enter");
      await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
    }

    // Navigate to lead page
    await page.goto(AMO_BASE + `/leads/detail/${leadId}`, {
      waitUntil: "networkidle2",
      timeout: 25000,
    });
    await new Promise((r) => setTimeout(r, 3000));

    // Extract channel name from DOM
    const result = await page.evaluate((knownBots: string[]) => {
      const out: { channelName: string | null; origin: string | null } = { channelName: null, origin: null };

      // Get integration origin from messenger sidebar
      const messengerItem = document.querySelector(".profile_messengers-item");
      if (messengerItem) {
        const cls = messengerItem.className || "";
        const allMatches = cls.match(/profile_messengers-item-(\S+)/g) || [];
        for (const m of allMatches) {
          const val = m.replace("profile_messengers-item-", "");
          if (val !== "default") {
            out.origin = val;
            break;
          }
        }
      }

      // 1. "Chat with XXX:NNNN"
      const allText = document.body.innerText || "";
      const chatMatch = allText.match(/Chat\s+with\s+([^\n:]+?)(?:\s*:\s*\d+|$)/i);
      if (chatMatch) {
        out.channelName = chatMatch[1].trim();
        return out;
      }

      // 2. Messenger sidebar — specific name (not generic)
      const messengerName = document.querySelector(".profile_messengers-item-name");
      if (messengerName) {
        const name = messengerName.textContent?.trim();
        if (name && name !== "WAhelp" && name !== "WABABA" && name.length < 100) {
          out.channelName = name;
          return out;
        }
      }

      // 3. Feed senders — known bot names
      const feedNotes = document.querySelectorAll(".feed-note-with-dialog");
      for (const note of feedNotes) {
        const text = note.textContent || "";
        if (text.includes("value of the field") || text.includes("set to") || text.includes("was changed")) continue;
        for (const bot of knownBots) {
          if (text.includes(bot)) {
            out.channelName = bot;
            return out;
          }
        }
      }

      return out;
    }, KNOWN_BOT_NAMES);

    // If no channel from DOM, use integration default
    if (!result.channelName && result.origin && INTEGRATION_DEFAULT[result.origin] !== undefined) {
      result.channelName = INTEGRATION_DEFAULT[result.origin];
    }

    return result.channelName;
  } catch (err) {
    logger.error({ leadId, err }, "scanLeadPageForChannel failed");
    return null;
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Ensure the messenger field is filled for a lead.
 * Called before Salesbot trigger — reads current value, fills via Puppeteer if empty.
 */
export async function ensureMessengerField(leadId: string): Promise<string | null> {
  // 1. Check if already filled
  const current = await readMessengerField(leadId);
  if (current) {
    logger.info({ leadId, value: current }, "messenger field already filled");
    return current;
  }

  // 2. Scan lead page
  logger.info({ leadId }, "messenger field empty — scanning lead page");
  const channelName = await scanLeadPageForChannel(leadId);
  if (!channelName) {
    logger.warn({ leadId }, "could not determine channel name from lead page");
    return null;
  }

  // 3. Fill the field
  const ok = await updateLastMessengerField(leadId, channelName, 0, LAST_MESSENGER_FIELD_ID);
  if (ok) {
    logger.info({ leadId, channelName }, "messenger field filled via Puppeteer scan");
  }
  return channelName;
}

/**
 * Update the "last active chat messenger" field on a lead.
 */
export async function updateLastMessengerField(
  leadId: string,
  sourceName: string,
  sourceId: number,
  fieldId: number,
): Promise<boolean> {
  const TOKEN = process.env.AMOCRM_LONG_LIVED_TOKEN ?? "";
  if (!TOKEN) return false;

  try {
    const res = await fetch(`${AMO_BASE}/api/v4/leads/${leadId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        custom_fields_values: [
          {
            field_id: fieldId,
            values: [{ value: sourceName }],
          },
        ],
      }),
    });
    if (res.ok) {
      logger.info({ leadId, sourceName, sourceId }, "lastMessenger: field updated");
      return true;
    }
    const err = await res.text();
    logger.error({ status: res.status, err }, "lastMessenger: field update failed");
    return false;
  } catch (err) {
    logger.error({ err }, "lastMessenger: field update error");
    return false;
  }
}
