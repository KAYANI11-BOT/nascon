import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase.server";
import { getAuthContext } from "./workspace.functions";
import {
  assertCrmIdentity,
  entitySchema,
  listSchema,
  uuid,
  type CrmReferences,
} from "./crm-live.contracts";
import { dbError, getCrm, listCrm, mutateCrm, readCrmActivity } from "./crm-live.server";

async function session() {
  const auth = await getAuthContext();
  assertCrmIdentity(auth);
  return { auth, db: createSupabaseServerClient() };
}
export const listLiveCrm = createServerFn({ method: "GET" })
  .validator((v: unknown) => listSchema.parse(v))
  .handler(async ({ data }) => listCrm(await session(), data));
export const getLiveCrm = createServerFn({ method: "GET" })
  .validator((v: unknown) =>
    z.object({ entity: entitySchema, id: uuid, workspaceId: uuid.optional() }).strict().parse(v),
  )
  .handler(async ({ data }) => getCrm(await session(), data.entity, data.id, data.workspaceId));
export const mutateLiveCrm = createServerFn({ method: "POST" })
  .validator((v: unknown) =>
    z
      .object({
        entity: entitySchema,
        action: z.enum(["create", "update", "delete"]),
        id: uuid.optional(),
        values: z.unknown().optional(),
        workspaceId: uuid.optional(),
        expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
      })
      .strict()
      .parse(v),
  )
  .handler(async ({ data }) =>
    mutateCrm(
      await session(),
      data.entity,
      data.action,
      data.id,
      data.values,
      data.workspaceId,
      data.expectedUpdatedAt,
    ),
  );
export const getCrmReferences = createServerFn({ method: "GET" })
  .validator((v: unknown) => z.object({ workspaceId: uuid }).strict().parse(v))
  .handler(async ({ data }): Promise<CrmReferences> => {
    const s = await session();
    const { workspaceId } = assertCrmIdentity(s.auth, data.workspaceId);
    const results = await Promise.all([
      s.db
        .from("companies")
        .select("id,name")
        .eq("workspace_id", workspaceId)
        .order("name")
        .limit(1000),
      s.db
        .from("contacts")
        .select("id,full_name,company_id")
        .eq("workspace_id", workspaceId)
        .order("full_name")
        .limit(1000),
      s.db
        .from("pipelines")
        .select("id,name,is_default")
        .eq("workspace_id", workspaceId)
        .order("name")
        .limit(1000),
      s.db
        .from("pipeline_stages")
        .select("id,pipeline_id,name,position,stage_type")
        .eq("workspace_id", workspaceId)
        .order("position")
        .limit(1000),
      s.db
        .from("workspace_members")
        .select("user_id,profiles(full_name)")
        .eq("workspace_id", workspaceId)
        .limit(1000),
    ]);
    for (const r of results) dbError(r.error);
    return {
      companies: results[0]!.data ?? [],
      contacts: results[1]!.data ?? [],
      pipelines: results[2]!.data ?? [],
      stages: results[3]!.data ?? [],
      members: (results[4]!.data ?? []).map((m: Record<string, unknown>) => ({
        id: String(m["user_id"]),
        name: String((m["profiles"] as { full_name?: string } | null)?.full_name || "Member"),
      })),
      truncated: results.some((r) => (r.data?.length ?? 0) >= 1000),
    } as CrmReferences;
  });
export const getContactActivity = createServerFn({ method: "GET" })
  .validator((v: unknown) =>
    z
      .object({
        workspaceId: uuid,
        contactId: uuid,
        page: z.number().int().min(1).max(100000).default(1),
      })
      .strict()
      .parse(v),
  )
  .handler(async ({ data }) => {
    const s = await session();
    const result = await readCrmActivity(
      s,
      "contacts",
      data.contactId,
      data.page,
      data.workspaceId,
    );
    return {
      rows: result.rows.map((r) => ({
        id: r.id,
        actor_id: r.actorId,
        actor_name: r.actorName,
        action: r.action,
        created_at: r.createdAt,
      })),
      total: result.total,
    };
  });
export const getCrmActivity = createServerFn({ method: "GET" })
  .validator((v: unknown) =>
    z
      .object({
        workspaceId: uuid,
        entity: z.enum(["contacts", "opportunities"]),
        id: uuid,
        page: z.number().int().min(1).max(100000).default(1),
      })
      .strict()
      .parse(v),
  )
  .handler(async ({ data }) =>
    readCrmActivity(await session(), data.entity, data.id, data.page, data.workspaceId),
  );
