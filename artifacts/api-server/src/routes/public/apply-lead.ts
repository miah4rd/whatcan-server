/**
 * Replaces the Meta Instant Form -> Albato -> amoCRM chain for rental ads.
 *
 * The site's /apply page (bali-villa-rentals) posts here directly; this
 * endpoint creates the amoCRM lead itself with the amoCRM API v4 client
 * already used everywhere else in this repo (lib/amo-client.ts) — no Albato,
 * no Meta-side form to configure per listing.
 *
 * One universal endpoint for every listing, same as the site's one universal
 * /apply page: nothing here is listing-specific, the listing code and title
 * just travel in the request body.
 */
import { Router } from "express";
import crypto from "crypto";
import { amoPost } from "../../lib/amo-client";
import { logger } from "../../lib/logger";

const router = Router();

// amoCRM lead custom-field ids (GET /api/v4/leads/custom_fields) — the SAME
// fields the old Meta ad form -> Albato flow already wrote onto Rental leads
// (see lib/lead-card-fields.ts, which reads these back). Reusing them means
// nothing downstream (the budget gate, the matcher) needs to change to
// recognise a lead this endpoint created.
const FIELD_BUDGET = 956449; // "Budget" (text)
const FIELD_BEDROOMS_TEXT = 959041; // "Number of Bedrooms" (text)
const FIELD_AREA_TEXT = 959039; // "Preferred Area or District" (text)
const FIELD_MOVE_IN = 968367; // "Move-in Timeline" (text)

const PIPELINE_RENTAL = 11119150;
const STATUS_NEW_LEAD = 87301078;

// Label text must stay in sync with bali-villa-rentals'
// src/lib/apply-form-options.ts — the LABEL (not the slug) is what lands on
// the amoCRM card, since these are plain text fields there.
const BUDGET_LABELS: Record<string, string> = {
  under_30m: "Under Rp 30 million/month",
  "30_50m": "Rp 30–50 million/month",
  "50_80m": "Rp 50–80 million/month",
  "80_150m": "Rp 80–150 million/month",
  "150m_plus": "Rp 150 million+/month",
};
const MOVE_IN_LABELS: Record<string, string> = {
  asap: "As soon as possible",
  "1_3m": "1–3 months",
  "3_6m": "3–6 months",
  "6m_plus": "6+ months / just exploring",
};

// The one hard rule this endpoint exists to enforce: the old Meta Instant
// Form could only show a text warning on this answer, never actually block
// the submission. This blocks it for real, and does so here — server-side —
// because the client-side block in the form is trivial to bypass.
const BLOCKED_BUDGET = "under_30m";

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

router.post("/apply-lead", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  const listingCode = isNonEmptyString(body.listingCode) ? body.listingCode.trim().slice(0, 40) : "";
  const listingTitle = isNonEmptyString(body.listingTitle) ? body.listingTitle.trim().slice(0, 200) : listingCode;
  const budget = isNonEmptyString(body.budget) ? body.budget.trim() : "";
  const moveIn = isNonEmptyString(body.moveIn) ? body.moveIn.trim() : "";
  const bedrooms = isNonEmptyString(body.bedrooms) ? body.bedrooms.trim().slice(0, 20) : "";
  const areas = Array.isArray(body.areas)
    ? body.areas.filter(isNonEmptyString).map((a) => a.trim().slice(0, 40)).slice(0, 20)
    : [];
  const name = isNonEmptyString(body.name) ? body.name.trim().slice(0, 100) : "";
  const phone = isNonEmptyString(body.phone) ? body.phone.trim().slice(0, 20) : "";

  if (!listingCode || !budget || !moveIn || !bedrooms || !name || !phone) {
    res.status(400).json({ error: "Missing required fields." });
    return;
  }

  if (budget === BLOCKED_BUDGET) {
    res.status(400).json({ error: "This listing requires a minimum budget of Rp 30 million per month." });
    return;
  }

  const budgetLabel = BUDGET_LABELS[budget] ?? budget;
  const moveInLabel = MOVE_IN_LABELS[moveIn] ?? moveIn;

  const leadPayload = [
    {
      name: `${listingCode} - ${listingTitle}`,
      pipeline_id: PIPELINE_RENTAL,
      status_id: STATUS_NEW_LEAD,
      custom_fields_values: [
        { field_id: FIELD_BUDGET, values: [{ value: budgetLabel }] },
        { field_id: FIELD_BEDROOMS_TEXT, values: [{ value: bedrooms }] },
        { field_id: FIELD_AREA_TEXT, values: [{ value: areas.join(", ") || "Not specified" }] },
        { field_id: FIELD_MOVE_IN, values: [{ value: moveInLabel }] },
      ],
      _embedded: {
        contacts: [
          {
            name,
            custom_fields_values: [{ field_code: "PHONE", values: [{ value: phone, enum_code: "WORK" }] }],
          },
        ],
      },
    },
  ];

  // Always a brand-new lead: no id is ever attached to an existing one, so
  // this call never updates a prior submission — every apply is its own
  // lead, same as a fresh Meta Instant Form submission used to be. (amoCRM's
  // own account-level duplicate-contact merging, if ever turned on in its
  // settings, sits outside what this endpoint's request body controls.)
  //
  // /leads/complex (not plain /leads) — verified live: plain POST /api/v4/leads
  // rejects an inline (id-less) _embedded.contacts entry with "FieldMissing:
  // _embedded.contacts.0.id" — it only accepts a reference to an EXISTING
  // contact. /leads/complex is amoCRM's endpoint for creating a lead and a new
  // contact in one call, and returns a flat array, not an _embedded wrapper.
  type ComplexLeadResult = Array<{ id: number; contact_id?: number }>;
  let result: ComplexLeadResult | null = null;
  try {
    result = await amoPost<ComplexLeadResult>("/api/v4/leads/complex", leadPayload);
  } catch (err) {
    logger.error({ err, listingCode }, "apply-lead: amoCRM request threw");
  }
  const leadId = result?.[0]?.id ?? null;

  if (!leadId) {
    logger.error({ listingCode, budget, bedrooms }, "apply-lead: amoCRM did not accept the lead");
    res.status(502).json({ error: "Could not submit the request right now. Please try again in a moment." });
    return;
  }

  logger.info({ leadId, listingCode, budget, bedrooms, moveIn, areas }, "apply-lead: lead created from website form");
  res.json({ ok: true, leadId });

  // Meta Conversions API — fired only after this point, i.e. only for a lead
  // that actually got created. A budget-blocked attempt returns above and
  // never reaches here, so it is never counted as a conversion. Best-effort
  // and after the response is already sent: a CAPI failure must never affect
  // what the visitor sees.
  fireMetaCapi(req, { phone }).catch((err) => logger.warn({ err }, "apply-lead: CAPI send failed (non-fatal)"));
});

// ── Meta Conversions API (optional) ─────────────────────────────────────────
// Ads now point at a real page instead of Meta's own Instant Form, so without
// server-side CAPI, Meta cannot see who actually converted and ad delivery
// degrades. Only fires when META_CAPI_ACCESS_TOKEN is set: get it from
// Events Manager -> this pixel -> Settings -> Conversions API -> Generate token.
const META_PIXEL_ID = process.env["META_PIXEL_ID"] || "1077800213845174"; // bali-villa-rentals index.html
const META_CAPI_TOKEN = process.env["META_CAPI_ACCESS_TOKEN"] || "";

function sha256(v: string): string {
  return crypto.createHash("sha256").update(v.trim().toLowerCase()).digest("hex");
}

async function fireMetaCapi(
  req: { body?: Record<string, unknown>; headers: Record<string, unknown> },
  lead: { phone: string },
): Promise<void> {
  if (!META_CAPI_TOKEN) {
    logger.info("apply-lead: META_CAPI_ACCESS_TOKEN not set — skipping Conversions API event");
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const userAgent = String(req.headers["user-agent"] ?? "") || undefined;
  const fbp = isNonEmptyString(body.fbp) ? body.fbp : undefined;
  const fbc = isNonEmptyString(body.fbc) ? body.fbc : undefined;
  const sourceUrl = isNonEmptyString(body.page) ? body.page : "https://unicorn-properties.com/apply";

  const payload = {
    data: [
      {
        event_name: "Lead",
        event_time: Math.floor(Date.now() / 1000),
        action_source: "website",
        event_source_url: sourceUrl,
        user_data: {
          ph: [sha256(lead.phone.replace(/[^\d]/g, ""))],
          client_user_agent: userAgent,
          fbp,
          fbc,
        },
      },
    ],
  };

  const url = `https://graph.facebook.com/v20.0/${META_PIXEL_ID}/events?access_token=${META_CAPI_TOKEN}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.warn({ status: res.status, body: text.slice(0, 300) }, "apply-lead: Meta CAPI rejected the event");
  }
}

export default router;
