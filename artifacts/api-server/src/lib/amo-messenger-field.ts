/**
 * Updates the "last active chat messenger" custom field on a lead in amoCRM.
 * Field ID 967477 was created manually in amoCRM UI (API didn't allow creation).
 */
import { logger } from "./logger";

const AMO_BASE = `https://${process.env.AMO_SUBDOMAIN ?? "unicornproperty"}.amocrm.ru`;

// Hardcoded — field created manually in amoCRM
const LAST_MESSENGER_FIELD_ID = 967477;

export function getLastMessengerFieldId(): number {
  return LAST_MESSENGER_FIELD_ID;
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
