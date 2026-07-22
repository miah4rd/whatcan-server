import { Router } from "express";
import { getAccessToken } from "../lib/amo-client";

const router = Router();

router.get("/debug/talks/:leadId", async (req, res) => {
  const token = await getAccessToken();
  if (!token) { res.json({ error: "no token" }); return; }
  
  const leadId = req.params.leadId;
  
  try {
    const resp = await fetch(`https://unicornproperty.amocrm.ru/api/v4/talks?filter[entity_id]=${leadId}&filter[entity_type]=lead&limit=10`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await resp.json() as any;
    
    const notesResp = await fetch(`https://unicornproperty.amocrm.ru/api/v4/leads/${leadId}/notes?limit=5`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const notesData = await notesResp.json() as any;
    
    const eventsResp = await fetch(`https://unicornproperty.amocrm.ru/api/v4/events?filter[entity]=lead&filter[entity_id][]=${leadId}&limit=10`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const eventsData = await eventsResp.json() as any;
    
    res.json({ 
      talks: data?._embedded?.talks ?? [],
      talksCount: data?._embedded?.talks?.length ?? 0,
      notes: notesData?._embedded?.notes?.map((n: any) => ({ id: n.id, type: n.note_type, params: n.params })) ?? [],
      notesCount: notesData?._embedded?.notes?.length ?? 0,
      events: eventsData?._embedded?.events?.map((e: any) => ({ id: e.id, type: e.type, entity_id: e.entity_id, created_at: e.created_at, value_after: e.value_after })) ?? [],
      eventsCount: eventsData?._embedded?.events?.length ?? 0,
    });
  } catch (err: any) {
    res.json({ error: err.message });
  }
});

export default router;
