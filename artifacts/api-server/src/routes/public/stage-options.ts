import { Router } from "express";

const router = Router();

/**
 * Returns the ordered list of AmoCRM pipeline stages available for manual
 * stage-change when a broker approves a suggestion.
 * Each entry includes the numeric AmoCRM status_id so the extension can
 * send the correct id to the approve endpoint (which calls updateLeadStatus).
 * IDs are from the UNICORN pipeline (8347534) — the primary sales pipeline.
 */
const STAGE_OPTIONS: Array<{ name: string; id: number }> = [
  { name: "NEW LEAD",                          id: 68024550 },
  { name: "1ST FOLLOW UP (NEXT DAY)",          id: 72376798 },
  { name: "2ND FOLLOW UP (3 DAYS AFTER)",      id: 72376802 },
  { name: "FINAL FOLLOW UP (1 WEEK AFTER)",    id: 72376806 },
  { name: "LEAD ASSIGNED",                     id: 72376818 },
  { name: "TAKEN TO WORK",                     id: 72376822 },
  { name: "Contact established",               id: 68024554 },
  { name: "Mailing",                           id: 84883814 },
  { name: "Long-Term Cycle",                   id: 68035578 },
  { name: "Needs Assessed",                    id: 68024558 },
  { name: "Options Sent",                      id: 68035586 },
  { name: "Zoom Call scheduled",               id: 70723858 },
  { name: "Viewing Scheduled",                 id: 68035590 },
  { name: "Feedback / Handling Objections",    id: 68035594 },
  { name: "Reservation",                       id: 68035598 },
  { name: "Negotiations",                      id: 68035602 },
  { name: "Contract signed",                   id: 68035614 },
  { name: "Closed - won",                      id: 142       },
  { name: "Closed - lost",                     id: 143       },
];

router.options("/stage-options", (_req, res) => res.sendStatus(204));

router.get("/stage-options", (_req, res) => {
  res.json({ stages: STAGE_OPTIONS });
});

export default router;
