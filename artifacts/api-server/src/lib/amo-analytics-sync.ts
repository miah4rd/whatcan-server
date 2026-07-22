/**
 * Syncs all deals (+ contacts + companies) from the "unicorn" pipeline
 * into the analytics tables: amo_deals, amo_contacts, amo_companies, join tables.
 *
 * Can be triggered:
 *  - Once after external integration install (full sync)
 *  - Via webhook on individual deal add/update/delete (incremental)
 */
import { db, amoDealsTable, amoContactsTable, amoCompaniesTable, amoLeadContactsTable, amoLeadCompaniesTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { amoFetch } from "./amo-client";
import { logger } from "./logger";

// ── amoCRM API types ──────────────────────────────────────────────────────────

interface AmoCustomField {
  field_id: number;
  field_name?: string;
  values: Array<{ value: string | number | boolean; enum_id?: number; enum_code?: string }>;
}

interface AmoTag { id: number; name: string }

interface AmoLead {
  id: number;
  name: string;
  price: number;
  status_id: number;
  pipeline_id: number;
  responsible_user_id: number;
  loss_reason_id?: number;
  closed_at?: number | null;
  created_at: number;
  updated_at: number;
  custom_fields_values?: AmoCustomField[];
  _embedded?: {
    tags?: AmoTag[];
    contacts?: Array<{ id: number; is_main?: boolean }>;
    companies?: Array<{ id: number }>;
    loss_reason?: Array<{ id: number; name: string }>;
  };
}

interface AmoContact {
  id: number;
  name: string;
  first_name?: string;
  last_name?: string;
  custom_fields_values?: AmoCustomField[];
}

interface AmoCompany {
  id: number;
  name: string;
  custom_fields_values?: AmoCustomField[];
}

interface AmoPipeline { id: number; name: string }
interface AmoStatus { id: number; name: string }

interface AmoListResponse<T> {
  _embedded?: { [key: string]: T[] };
  _page?: number;
  _links?: { next?: { href: string } };
}

// ── Find unicorn pipeline ─────────────────────────────────────────────────────

let cachedPipeline: { id: number; name: string; statuses: Map<number, string> } | null = null;

export async function findUnicornPipeline(): Promise<{ id: number; name: string; statuses: Map<number, string> } | null> {
  if (cachedPipeline) return cachedPipeline;

  const data = await amoFetch<AmoListResponse<AmoPipeline & { _embedded?: { statuses?: AmoStatus[] } }>>(
    "/api/v4/leads/pipelines?limit=50"
  );
  if (!data?._embedded?.pipelines) return null;

  const pipelines = data._embedded.pipelines as Array<AmoPipeline & { _embedded?: { statuses?: AmoStatus[] } }>;
  const pipeline = pipelines.find(p => p.name.toLowerCase().includes("unicorn"));
  if (!pipeline) {
    logger.warn("amoCRM: 'unicorn' pipeline not found among: %s", pipelines.map(p => p.name).join(", "));
    return null;
  }

  const statuses = new Map<number, string>();
  for (const s of pipeline._embedded?.statuses ?? []) {
    statuses.set(s.id, s.name);
  }

  cachedPipeline = { id: pipeline.id, name: pipeline.name, statuses };
  logger.info({ pipelineId: pipeline.id, name: pipeline.name }, "unicorn pipeline found");
  return cachedPipeline;
}

// ── Extract phone/email from custom fields ────────────────────────────────────

function extractPhone(fields: AmoCustomField[] | undefined): string | null {
  const f = fields?.find(f => f.field_name?.toLowerCase().includes("phone") || f.field_id === 264);
  return f ? String(f.values[0]?.value ?? "") || null : null;
}

function extractEmail(fields: AmoCustomField[] | undefined): string | null {
  const f = fields?.find(f => f.field_name?.toLowerCase().includes("email") || f.field_id === 265);
  return f ? String(f.values[0]?.value ?? "") || null : null;
}

// ── Upsert contacts ───────────────────────────────────────────────────────────

async function upsertContacts(ids: number[]): Promise<void> {
  if (!ids.length) return;
  const chunks = chunkArray(ids, 50);

  for (const chunk of chunks) {
    const qs = chunk.map(id => `id[]=${id}`).join("&");
    const data = await amoFetch<AmoListResponse<AmoContact>>(`/api/v4/contacts?${qs}&with=custom_fields`);
    const contacts = data?._embedded?.contacts ?? [];

    for (const c of contacts) {
      const nameParts = c.name?.split(" ") ?? [];
      await db.insert(amoContactsTable).values({
        id: String(c.id),
        name: c.name ?? null,
        firstName: c.first_name ?? nameParts[0] ?? null,
        lastName: (c.last_name ?? nameParts.slice(1).join(" ")) || null,
        phone: extractPhone(c.custom_fields_values),
        email: extractEmail(c.custom_fields_values),
        customFields: c.custom_fields_values ?? null,
        syncedAt: new Date(),
      }).onConflictDoUpdate({
        target: amoContactsTable.id,
        set: {
          name: c.name ?? null,
          firstName: c.first_name ?? nameParts[0] ?? null,
          lastName: (c.last_name ?? nameParts.slice(1).join(" ")) || null,
          phone: extractPhone(c.custom_fields_values),
          email: extractEmail(c.custom_fields_values),
          customFields: c.custom_fields_values ?? null,
          syncedAt: new Date(),
        },
      });
    }
  }
}

// ── Upsert companies ──────────────────────────────────────────────────────────

async function upsertCompanies(ids: number[]): Promise<void> {
  if (!ids.length) return;
  const chunks = chunkArray(ids, 50);

  for (const chunk of chunks) {
    const qs = chunk.map(id => `id[]=${id}`).join("&");
    const data = await amoFetch<AmoListResponse<AmoCompany>>(`/api/v4/companies?${qs}&with=custom_fields`);
    const companies = data?._embedded?.companies ?? [];

    for (const c of companies) {
      await db.insert(amoCompaniesTable).values({
        id: String(c.id),
        name: c.name ?? null,
        phone: extractPhone(c.custom_fields_values),
        email: extractEmail(c.custom_fields_values),
        customFields: c.custom_fields_values ?? null,
        syncedAt: new Date(),
      }).onConflictDoUpdate({
        target: amoCompaniesTable.id,
        set: {
          name: c.name ?? null,
          phone: extractPhone(c.custom_fields_values),
          email: extractEmail(c.custom_fields_values),
          customFields: c.custom_fields_values ?? null,
          syncedAt: new Date(),
        },
      });
    }
  }
}

// ── Upsert a single deal row ──────────────────────────────────────────────────

async function upsertDeal(lead: AmoLead, pipeline: { id: number; name: string; statuses: Map<number, string> }): Promise<void> {
  const statusName = pipeline.statuses.get(lead.status_id) ?? null;
  const lossReason = lead._embedded?.loss_reason?.[0];

  await db.insert(amoDealsTable).values({
    id: String(lead.id),
    name: lead.name ?? null,
    price: lead.price ?? null,
    statusId: String(lead.status_id),
    statusName,
    pipelineId: String(lead.pipeline_id),
    pipelineName: pipeline.name,
    responsibleUserId: lead.responsible_user_id ?? null,
    lossReasonId: lead.loss_reason_id ? String(lead.loss_reason_id) : null,
    lossReasonName: lossReason?.name ?? null,
    closedAt: lead.closed_at ? new Date(lead.closed_at * 1000) : null,
    amoCreatedAt: lead.created_at ? new Date(lead.created_at * 1000) : null,
    amoUpdatedAt: lead.updated_at ? new Date(lead.updated_at * 1000) : null,
    tags: lead._embedded?.tags ?? null,
    customFields: lead.custom_fields_values ?? null,
    syncedAt: new Date(),
  }).onConflictDoUpdate({
    target: amoDealsTable.id,
    set: {
      name: lead.name ?? null,
      price: lead.price ?? null,
      statusId: String(lead.status_id),
      statusName,
      responsibleUserId: lead.responsible_user_id ?? null,
      lossReasonId: lead.loss_reason_id ? String(lead.loss_reason_id) : null,
      lossReasonName: lossReason?.name ?? null,
      closedAt: lead.closed_at ? new Date(lead.closed_at * 1000) : null,
      amoUpdatedAt: lead.updated_at ? new Date(lead.updated_at * 1000) : null,
      tags: lead._embedded?.tags ?? null,
      customFields: lead.custom_fields_values ?? null,
      syncedAt: new Date(),
    },
  });
}

// ── Sync join tables for a deal ───────────────────────────────────────────────

async function syncDealRelations(lead: AmoLead): Promise<{ contactIds: number[]; companyIds: number[] }> {
  const leadId = String(lead.id);
  const contactIds = lead._embedded?.contacts?.map(c => c.id) ?? [];
  const companyIds = lead._embedded?.companies?.map(c => c.id) ?? [];

  if (contactIds.length) {
    await db.delete(amoLeadContactsTable).where(eq(amoLeadContactsTable.leadId, leadId));
    await db.insert(amoLeadContactsTable)
      .values(contactIds.map(cid => ({ leadId, contactId: String(cid) })))
      .onConflictDoNothing();
  }

  if (companyIds.length) {
    await db.delete(amoLeadCompaniesTable).where(eq(amoLeadCompaniesTable.leadId, leadId));
    await db.insert(amoLeadCompaniesTable)
      .values(companyIds.map(cid => ({ leadId, companyId: String(cid) })))
      .onConflictDoNothing();
  }

  return { contactIds, companyIds };
}

// ── Full pipeline sync ────────────────────────────────────────────────────────

export async function syncAnalyticsPipeline(): Promise<{
  deals: number; contacts: number; companies: number;
}> {
  const pipeline = await findUnicornPipeline();
  if (!pipeline) throw new Error("unicorn pipeline not found");

  let page = 1;
  let totalDeals = 0;
  const allContactIds = new Set<number>();
  const allCompanyIds = new Set<number>();

  logger.info({ pipelineId: pipeline.id }, "starting full analytics sync");

  while (true) {
    const url = `/api/v4/leads?filter[pipeline_id]=${pipeline.id}&with=contacts,companies,loss_reason,tags,custom_fields&page=${page}&limit=250`;
    const data = await amoFetch<AmoListResponse<AmoLead>>(url);
    const leads = data?._embedded?.leads ?? [];

    if (!leads.length) break;

    for (const lead of leads) {
      await upsertDeal(lead, pipeline);
      const { contactIds, companyIds } = await syncDealRelations(lead);
      contactIds.forEach(id => allContactIds.add(id));
      companyIds.forEach(id => allCompanyIds.add(id));
      totalDeals++;
    }

    logger.info({ page, count: leads.length, totalSoFar: totalDeals }, "analytics sync page done");

    if (!data?._links?.next) break;
    page++;
    // Small delay to stay within amoCRM rate limits
    await new Promise(r => setTimeout(r, 200));
  }

  const contactIdList = [...allContactIds];
  const companyIdList = [...allCompanyIds];

  await upsertContacts(contactIdList);
  await upsertCompanies(companyIdList);

  logger.info({ deals: totalDeals, contacts: contactIdList.length, companies: companyIdList.length }, "analytics sync complete");
  return { deals: totalDeals, contacts: contactIdList.length, companies: companyIdList.length };
}

// ── Incremental update for a single deal (webhook-triggered) ──────────────────

export async function syncSingleDeal(leadId: number): Promise<void> {
  const pipeline = await findUnicornPipeline();

  const data = await amoFetch<AmoListResponse<AmoLead>>(
    `/api/v4/leads/${leadId}?with=contacts,companies,loss_reason,tags,custom_fields`
  );

  // amoFetch wraps single resource — the API returns the lead directly
  const lead = data as unknown as AmoLead;
  if (!lead?.id) {
    logger.warn({ leadId }, "analytics: lead not found on incremental sync");
    return;
  }

  // Only sync if it belongs to unicorn pipeline
  if (pipeline && lead.pipeline_id !== pipeline.id) return;

  const effectivePipeline = pipeline ?? {
    id: lead.pipeline_id,
    name: "unicorn",
    statuses: new Map(),
  };

  await upsertDeal(lead, effectivePipeline);
  const { contactIds, companyIds } = await syncDealRelations(lead);
  await upsertContacts(contactIds);
  await upsertCompanies(companyIds);

  logger.info({ leadId }, "analytics: single deal synced");
}

// ── Delete a deal from analytics ──────────────────────────────────────────────

export async function deleteDealFromAnalytics(leadId: number): Promise<void> {
  const id = String(leadId);
  await db.delete(amoLeadContactsTable).where(eq(amoLeadContactsTable.leadId, id));
  await db.delete(amoLeadCompaniesTable).where(eq(amoLeadCompaniesTable.leadId, id));
  await db.delete(amoDealsTable).where(eq(amoDealsTable.id, id));
  logger.info({ leadId }, "analytics: deal deleted");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
