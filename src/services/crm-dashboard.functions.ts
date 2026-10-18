import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase.server";
import { assertCrmIdentity, uuid } from "./crm-live.contracts";
import { getAuthContext } from "./workspace.functions";
import { loadCrmDashboard, workspaceDay } from "./crm-dashboard.server";
import { dbError } from "./crm-live.server";
export const getLiveDashboard = createServerFn({ method: "GET" })
  .validator((v: unknown) => z.object({ workspaceId: uuid }).strict().parse(v))
  .handler(async ({ data }) => {
    const auth = await getAuthContext();
    assertCrmIdentity(auth, data.workspaceId);
    return loadCrmDashboard({ auth, db: createSupabaseServerClient() });
  });
export const getDashboardDrilldown = createServerFn({ method: "GET" })
  .validator((v: unknown) =>
    z
      .object({
        workspaceId: uuid,
        kind: z.enum(["today", "recovery", "escalations"]),
        page: z.number().int().min(1).max(100000).default(1),
        asOf: z.string().datetime(),
      })
      .strict()
      .parse(v),
  )
  .handler(async ({ data }) => {
    const auth = await getAuthContext();
    const { workspaceId, userId } = assertCrmIdentity(auth, data.workspaceId);
    const db = createSupabaseServerClient();
    const personal = auth.activeWorkspace!.role === "User";
    const from = (data.page - 1) * 20;
    const now = new Date(data.asOf);
    if (data.kind === "recovery") {
      const r = (await db.rpc(
        "get_recovery_queue" as never,
        {
          p_workspace: workspaceId,
          ...(personal ? { p_owner: userId } : {}),
          p_limit: 20,
          p_offset: from,
        } as never,
      )) as unknown as {
        data:
          | {
              lead_id: string;
              full_name: string;
              created_at: string;
              reasons: string[];
              total_count: number;
            }[]
          | null;
        error: { code?: string } | null;
      };
      dbError(r.error);
      return {
        rows: (r.data ?? []).map((r) => ({
          id: r.lead_id,
          leadId: r.lead_id,
          label: r.full_name,
          time: r.created_at,
          detail: r.reasons.join(", "),
        })),
        total: Number(r.data?.[0]?.total_count ?? 0),
      };
    }
    // Lead extension tables are owned by Member 2 and not yet in Member 1's generated types.
    const client = db as unknown as import("@supabase/supabase-js").SupabaseClient;
    if (data.kind === "escalations") {
      let q = client
        .from("lead_escalations")
        .select("id,lead_id,created_at,level", { count: "exact" })
        .eq("workspace_id", workspaceId)
        .gte("created_at", new Date(now.getTime() - 86400000).toISOString())
        .lte("created_at", data.asOf);
      if (personal) q = q.eq("new_owner", userId);
      const r = await q
        .order("created_at", { ascending: false })
        .order("id")
        .range(from, from + 19);
      dbError(r.error);
      return {
        rows: (r.data ?? []).map((r) => ({
          id: String(r["id"]),
          leadId: String(r["lead_id"]),
          label: "Escalated lead",
          time: String(r["created_at"]),
          detail: `Level ${r["level"]}`,
        })),
        total: r.count ?? 0,
      };
    }
    let q = client
      .from("leads")
      .select("id,full_name,created_at,status", { count: "exact" })
      .eq("workspace_id", workspaceId)
      .gte("created_at", new Date(now.getTime() - 48 * 3600000).toISOString())
      .lte("created_at", data.asOf);
    if (personal) q = q.eq("assigned_to", userId);
    const r = await q.order("created_at", { ascending: false }).order("id").limit(1000);
    dbError(r.error);
    if (r.count === null || r.count > 1000)
      throw new Error("Daily lead aggregation requires an approved database RPC for this volume.");
    const rows = (r.data ?? []).filter(
      (r) =>
        workspaceDay(
          new Date(String(r["created_at"])),
          auth.activeWorkspace!.workspace.timezone,
        ) === workspaceDay(now, auth.activeWorkspace!.workspace.timezone),
    );
    return {
      rows: rows.slice(from, from + 20).map((r) => ({
        id: String(r["id"]),
        leadId: String(r["id"]),
        label: String(r["full_name"]),
        time: String(r["created_at"]),
        detail: String(r["status"]),
      })),
      total: rows.length,
    };
  });
