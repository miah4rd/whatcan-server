/**
 * The conversation moment a draft belongs to, reconstructed in SQL from its kind and stage — the one
 * definition shared by autopilot readiness (routes/public/autopilot-readiness.ts) and the accepted
 * examples (lib/accepted-examples.ts). It must stay in step with `deriveSituation` in
 * lib/broker-corrections.ts: `p` is pending_suggestions, `l` is leads_sync.
 */
export const SITUATION_CASE = `
  CASE
    WHEN lower(coalesce(l.pipeline,'')) LIKE '%listing%' THEN 'owner_intake'
    WHEN p.kind = 'push' THEN 'followup'
    WHEN lower(coalesce(p.suggested_stage, l.lead_stage, '')) ~ '(negotiat|reservation|contract|won)' THEN 'closing'
    WHEN lower(coalesce(p.suggested_stage, l.lead_stage, '')) ~ '(viewing|zoom)' THEN 'viewing'
    WHEN lower(coalesce(p.suggested_stage, l.lead_stage, '')) ~ '(feedback|objection)' THEN 'objection'
    WHEN lower(coalesce(p.suggested_stage, l.lead_stage, '')) ~ '(new lead|initial|неразобран)' THEN 'first_contact'
    WHEN lower(coalesce(p.suggested_stage, l.lead_stage, '')) ~ '(need|assess|qualif|contact establi)' THEN 'qualifying'
    ELSE 'options'
  END`;
