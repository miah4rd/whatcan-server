import { Router } from "express";
import { getAccessToken } from "../lib/amo-client";

const router = Router();

router.get("/debug/amojo", async (_req, res) => {
  const token = await getAccessToken();
  if (!token) { res.json({ error: "no token" }); return; }
  
  try {
    const resp = await fetch("https://unicornproperty.amocrm.ru/api/v4/account?with=amojo_id", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await resp.json() as any;
    
    // Also get users with amojo_id
    const usersResp = await fetch("https://unicornproperty.amocrm.ru/api/v4/users?with=amojo_id&limit=50", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const usersData = await usersResp.json() as any;
    const users = usersData?._embedded?.users?.map((u: any) => ({
      id: u.id,
      name: u.name,
      amojo_id: u.amojo_id,
    })) ?? [];
    
    res.json({ 
      amojo_id: data.amojo_id, 
      account_id: data.id, 
      subdomain: data.subdomain,
      users,
    });
  } catch (err: any) {
    res.json({ error: err.message });
  }
});

export default router;
