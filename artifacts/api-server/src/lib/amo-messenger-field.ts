/**
 * Creates a custom field "last active chat messenger" in amoCRM leads.
 * This field stores the source_id of the last channel used by the client.
 * The Salesbot reads this field to determine which channel to send through.
 */
import { logger } from "./logger";

const AMO_BASE = `https://${process.env.AMO_SUBDOMAIN ?? "unicornproperty"}.amocrm.ru`;
const TOKEN = process.env.AMOCRM_LONG_LIVED_TOKEN ?? "";

// Known field name to look for
const FIELD_NAME = "last active chat messenger";

export async function ensureLastMessengerField(): Promise<number | null> {
  if (!TOKEN) {
    logger.error("ensureLastMessengerField: missing AMOCRM_LONG_LIVED_TOKEN");
    return null;
  }

  try {
    // 1. Check if field already exists
    const listRes = await fetch(`${AMO_BASE}/api/v4/leads/custom_fields`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (!listRes.ok) {
      logger.error({ status: listRes.status }, "ensureLastMessengerField: failed to list custom fields");
      return null;
    }
    const listData = await listRes.json() as { _embedded?: { custom_fields: Array<{ id: number; name: string }> } };
    const existing = listData._embedded?.custom_fields?.find((f) => f.name === FIELD_NAME);
    if (existing) {
      logger.info({ fieldId: existing.id }, "ensureLastMessengerField: field already exists");
      return existing.id;
    }

    // 2. Create the field
    const createRes = await fetch(`${AMO_BASE}/api/v4/leads/custom_fields`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: FIELD_NAME,
        type: "text",
        group_id: 0,
      }),
    });
    if (!createRes.ok) {
      const err = await createRes.text();
      logger.error({ status: createRes.status, err }, "ensureLastMessengerField: failed to create field");
      return null;
    }
    const created = await createRes.json() as { id: number };
    logger.info({ fieldId: created.id }, "ensureLastMessengerField: field created");
    return created.id;
  } catch (err) {
    logger.error({ err }, "ensureLastMessengerField: error");
    return null;
  }
}

/**
 * Update the "last active chat messenger" field on a lead.
 * @param leadId - amoCRM lead ID
 * @param sourceName - human-readable channel name (e.g. "Nick", "Phone 1")
 * @param sourceId - numeric source ID (e.g. 62249)
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
