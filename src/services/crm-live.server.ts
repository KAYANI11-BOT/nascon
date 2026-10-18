import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthContext } from "@/types/domain";
import {
  assertCrmIdentity,
  assertCrmPermission,
  canReadMoney,
  listSchema,
  parseCrmValues,
  redactMoney,
  safeCrmSearch,
  type LiveEntity,
  type LiveListInput,
  type LivePage,
  type LiveRow,
  type CrmActivityEntry,
} from "./crm-live.contracts";

export interface CrmSession {
  db: SupabaseClient;
  auth: AuthContext;
}
export const crmColumns = {
  contacts:
    "id,workspace_id,full_name,email,phone,title,company_id,owner_id,created_by,created_at,updated_at",
  companies: "id,workspace_id,name,domain,industry,phone,owner_id,created_by,created_at,updated_at",
  opportunities:
    "id,workspace_id,name,pipeline_id,stage_id,contact_id,company_id,owner_id,currency,status,expected_close_date,created_by,created_at,updated_at",
  pipelines: "id,workspace_id,name,is_default,created_at,updated_at",
  pipeline_stages:
    "id,workspace_id,pipeline_id,name,position,stage_type,probability,created_at,updated_at",
} as const;
export function dbError(error: { code?: string } | null) {
  if (!error) return;
  throw new Error(
    error.code === "42501"
      ? "Permission denied."
      : error.code === "23503"
        ? "A related record is missing or still in use."
        : error.code === "PGRST116"
          ? "The record changed or is no longer available. Refresh and try again."
          : error.code === "23505"
            ? "This record conflicts with another change. Refresh and retry."
            : "CRM database operation failed. Check configuration and schema readiness.",
  );
}
/** Reads the existing audit infrastructure only. Raw snapshots never cross this boundary. */
export async function readCrmActivity(
  session: CrmSession,
  entity: "contacts" | "opportunities",
  id: string,
  page = 1,
  expectedWorkspace?: string,
): Promise<{ rows: CrmActivityEntry[]; total: number }> {
  const { workspaceId } = assertCrmIdentity(session.auth, expectedWorkspace);
  if (!session.auth.permissions.includes("audit.view"))
    throw new Error("Activity requires audit viewing permission.");
  await getCrm(session, entity, id, workspaceId);
  const result = await session.db
    .from("audit_logs")
    .select("id,actor_id,action,created_at", { count: "exact" })
    .eq("workspace_id", workspaceId)
    .eq("table_name", entity)
    .eq("record_id", id)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range((page - 1) * 20, page * 20 - 1);
  dbError(result.error);
  const rows = (result.data ?? []) as {
    id: number;
    actor_id: string | null;
    action: string;
    created_at: string;
  }[];
  const ids = [...new Set(rows.flatMap((r) => (r.actor_id ? [r.actor_id] : [])))];
  const names = new Map<string, string>();
  if (ids.length) {
    // profiles has no workspace_id; the verified audit actor IDs and profile RLS constrain the lookup.
    const profiles = await session.db.from("profiles").select("id,full_name").in("id", ids);
    // Profile visibility can legitimately be lost after a member leaves; retain their ID instead.
    if (!profiles.error)
      for (const p of profiles.data ?? [])
        names.set(String(p["id"]), String(p["full_name"] || "Member"));
  }
  return {
    rows: rows.map((r) => ({
      id: r.id,
      actorId: r.actor_id,
      actorName: r.actor_id
        ? (names.get(r.actor_id) ?? `Member ${r.actor_id}`)
        : "System or removed account",
      action: r.action,
      createdAt: r.created_at,
    })),
    total: result.count ?? 0,
  };
}
export async function listCrm(session: CrmSession, input: LiveListInput): Promise<LivePage> {
  const v = listSchema.parse(input);
  const { db, auth } = session;
  const { workspaceId } = assertCrmIdentity(auth, v.workspaceId);
  if (v.sort === "amount" && !canReadMoney(auth))
    throw new Error("Opportunity values are restricted.");
  const columns =
    crmColumns[v.entity] + (v.entity === "opportunities" && canReadMoney(auth) ? ",amount" : "");
  let q = db.from(v.entity).select(columns, { count: "exact" }).eq("workspace_id", workspaceId);
  const search = safeCrmSearch(v.search);
  if (search) q = q.ilike(v.entity === "contacts" ? "full_name" : "name", `%${search}%`);
  if (v.ownerId && ["contacts", "companies", "opportunities"].includes(v.entity))
    q = q.eq("owner_id", v.ownerId);
  if (v.companyId && ["contacts", "opportunities"].includes(v.entity))
    q = q.eq("company_id", v.companyId);
  if (v.contactId && v.entity === "opportunities") q = q.eq("contact_id", v.contactId);
  if (v.pipelineId && ["opportunities", "pipeline_stages"].includes(v.entity))
    q = q.eq("pipeline_id", v.pipelineId);
  if (v.stageId && v.entity === "opportunities") q = q.eq("stage_id", v.stageId);
  if (v.status && v.entity === "opportunities") q = q.eq("status", v.status);
  if (v.closeFrom && v.entity === "opportunities") q = q.gte("expected_close_date", v.closeFrom);
  if (v.closeTo && v.entity === "opportunities") q = q.lte("expected_close_date", v.closeTo);
  const sort =
    v.entity === "pipeline_stages"
      ? "position"
      : v.sort === "name"
        ? v.entity === "contacts"
          ? "full_name"
          : "name"
        : v.entity === "opportunities" && v.sort === "close"
          ? "expected_close_date"
          : v.entity === "opportunities" && v.sort === "amount"
            ? "amount"
            : "created_at";
  const from = (v.page - 1) * v.pageSize;
  const result = await q
    .order(sort, {
      ascending: ["name", "full_name", "position", "expected_close_date"].includes(sort),
      nullsFirst: false,
    })
    .order("id")
    .range(from, from + v.pageSize - 1);
  dbError(result.error);
  const rows = (result.data ?? []) as unknown as LiveRow[];
  return {
    rows: v.entity === "opportunities" ? redactMoney(rows, canReadMoney(auth)) : rows,
    total: result.count ?? 0,
  };
}
export async function getCrm(
  session: CrmSession,
  entity: LiveEntity,
  id: string,
  expectedWorkspace?: string,
) {
  const { workspaceId } = assertCrmIdentity(session.auth, expectedWorkspace);
  const columns =
    crmColumns[entity] +
    (entity === "opportunities" && canReadMoney(session.auth) ? ",amount" : "");
  const result = await session.db
    .from(entity)
    .select(columns)
    .eq("workspace_id", workspaceId)
    .eq("id", id)
    .maybeSingle();
  dbError(result.error);
  if (!result.data) throw new Error("Record not found in this workspace.");
  const row = result.data as unknown as LiveRow;
  return entity === "opportunities" ? redactMoney([row], canReadMoney(session.auth))[0]! : row;
}
async function requireReference(
  session: CrmSession,
  table: string,
  id: unknown,
  workspaceId: string,
) {
  if (!id) return;
  const key = table === "workspace_members" ? "user_id" : "id";
  const result = await session.db
    .from(table)
    .select(key)
    .eq("workspace_id", workspaceId)
    .eq(key, id)
    .maybeSingle();
  dbError(result.error);
  if (!result.data) throw new Error("Choose a related record from the active workspace.");
}
export async function mutateCrm(
  session: CrmSession,
  entity: LiveEntity,
  action: "create" | "update" | "delete",
  id: string | undefined,
  input: unknown,
  expectedWorkspace?: string,
  expectedUpdatedAt?: string,
) {
  const { db, auth } = session;
  const { workspaceId, userId } = assertCrmIdentity(auth, expectedWorkspace);
  assertCrmPermission(auth, entity, action === "delete");
  if (action !== "create" && !id) throw new Error("Record identifier required.");
  if (entity === "pipeline_stages" && action === "delete")
    throw new Error("Stage deletion requires an approved atomic reassignment RPC from Member 1.");
  let values: Record<string, unknown> = {};
  if (action !== "delete") {
    values = parseCrmValues(entity, input, action === "update");
    if (!Object.keys(values).length) throw new Error("No changes supplied.");
    await requireReference(session, "workspace_members", values["owner_id"], workspaceId);
    await requireReference(session, "companies", values["company_id"], workspaceId);
    await requireReference(session, "contacts", values["contact_id"], workspaceId);
    if (entity === "pipeline_stages") {
      if (action === "update" && Object.keys(values).some((k) => k !== "name"))
        throw new Error("Only stage renaming is supported without an atomic pipeline RPC.");
      await requireReference(session, "pipelines", values["pipeline_id"], workspaceId);
    }
    if (entity === "opportunities") {
      if (values["amount"] !== undefined && !canReadMoney(auth))
        throw new Error("Opportunity values are restricted.");
      const prev =
        action === "update" ? await getCrm(session, entity, id!, workspaceId) : undefined;
      if (
        prev &&
        !canReadMoney(auth) &&
        values["currency"] !== undefined &&
        values["currency"] !== prev.currency
      )
        throw new Error("Opportunity currencies are restricted.");
      const stageId = values["stage_id"] ?? prev?.stage_id;
      const pipelineId = values["pipeline_id"] ?? prev?.pipeline_id;
      const stage = await db
        .from("pipeline_stages")
        .select("stage_type")
        .eq("workspace_id", workspaceId)
        .eq("pipeline_id", pipelineId)
        .eq("id", stageId)
        .maybeSingle();
      dbError(stage.error);
      if (!stage.data) throw new Error("Stage must belong to the selected pipeline and workspace.");
      values["status"] = stage.data["stage_type"];
      // Custom-field enforcement is intentionally not simulated: approved schema/RPCs are absent.
    }
  }
  const columns =
    crmColumns[entity] + (entity === "opportunities" && canReadMoney(auth) ? ",amount" : "");
  let write =
    action === "create"
      ? db.from(entity).insert({
          ...values,
          workspace_id: workspaceId,
          ...(["contacts", "companies", "opportunities"].includes(entity)
            ? { created_by: userId }
            : {}),
        })
      : action === "update"
        ? db.from(entity).update(values).eq("workspace_id", workspaceId).eq("id", id)
        : db.from(entity).delete().eq("workspace_id", workspaceId).eq("id", id);
  if (action !== "create" && expectedUpdatedAt) write = write.eq("updated_at", expectedUpdatedAt);
  const result = await write.select(action === "delete" ? "id" : columns).single();
  dbError(result.error);
  if (!result.data) throw new Error("The database did not confirm this change.");
  if (action === "delete") return null;
  const row = result.data as unknown as LiveRow;
  return entity === "opportunities" ? redactMoney([row], canReadMoney(auth))[0]! : row;
}
