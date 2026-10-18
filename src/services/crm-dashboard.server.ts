import { canReadMoney, assertCrmIdentity } from "./crm-live.contracts";
import type { CrmSession } from "./crm-live.server";

export type Metric<T> = { available: true; value: T } | { available: false; reason: string };
export interface StageTotal {
  stageId: string;
  stage: string;
  pipeline: string;
  currency: string;
  amount: number;
  count: number;
}
export interface DashboardSnapshot {
  newLeads: Metric<number>;
  pipeline: Metric<StageTotal[]>;
  acknowledgement: Metric<number | null>;
  recovery: Metric<number>;
  escalations: Metric<number>;
  availability: Metric<
    {
      userId: string;
      status: string;
      eligible: boolean;
      openLeads: number;
      capacity: number | null;
    }[]
  >;
  appointments: Metric<number>;
  payments: Metric<number>;
  timezone: string;
  asOf: string;
  scope: "personal" | "workspace";
}
export const unavailableMetric = (reason: string): Metric<never> => ({ available: false, reason });
export function groupPipeline(
  rows: { stage_id: string; currency: string; amount: number | string }[],
  stages: { id: string; name: string; pipeline_id: string }[],
  pipelines: { id: string; name: string }[],
): StageTotal[] {
  const groups = new Map<string, StageTotal>();
  const minorUnits = new Map<string, bigint>();
  for (const row of rows) {
    const stage = stages.find((s) => s.id === row.stage_id);
    const key = `${row.stage_id}:${row.currency}`;
    const group = groups.get(key) ?? {
      stageId: row.stage_id,
      stage: stage?.name ?? "Unknown stage",
      pipeline: pipelines.find((p) => p.id === stage?.pipeline_id)?.name ?? "Unknown pipeline",
      currency: row.currency,
      amount: 0,
      count: 0,
    };
    // CRM amounts are numeric(14,2). Add integer minor units, never binary fractions.
    const decimal = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(row.amount));
    if (!decimal) throw new Error("Invalid monetary amount returned by the database.");
    const cents = BigInt(decimal[1]!) * 100n + BigInt((decimal[2] ?? "").padEnd(2, "0"));
    const total = (minorUnits.get(key) ?? 0n) + cents;
    if (total > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("An exact database aggregate is required for this value.");
    minorUnits.set(key, total);
    group.amount = Number(total) / 100;
    group.count++;
    groups.set(key, group);
  }
  return [...groups.values()];
}
export function workspaceDay(date: Date, timezone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
export async function loadCrmDashboard(
  session: CrmSession,
  now = new Date(),
): Promise<DashboardSnapshot> {
  const { workspaceId } = assertCrmIdentity(session.auth);
  const db = session.db;
  const timezone = session.auth.activeWorkspace!.workspace.timezone;
  const personal = session.auth.activeWorkspace!.role === "User";
  const userId = session.auth.user!.id;
  const since = new Date(now.getTime() - 86400000).toISOString();
  async function metric<T>(fn: () => Promise<T>): Promise<Metric<T>> {
    try {
      return { available: true, value: await fn() };
    } catch {
      return unavailableMetric(
        "Source unavailable or access denied. Ask Member 1 to verify migrations and permissions.",
      );
    }
  }
  async function count(table: string, column?: string, from?: string) {
    let q = db
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId);
    if (column && from) q = q.gte(column, from).lte(column, now.toISOString());
    if (personal && table === "lead_escalations") q = q.eq("new_owner", userId);
    const r = await q;
    if (r.error || r.count === null) throw new Error("Source unavailable");
    return r.count;
  }
  // Bounded server-only aggregation: never present a partial sum as a workspace total.
  async function allRows(table: string, columns: string, filter?: [string, string | string[]]) {
    let q = db.from(table).select(columns, { count: "exact" }).eq("workspace_id", workspaceId);
    if (filter)
      q = Array.isArray(filter[1]) ? q.in(filter[0], filter[1]) : q.eq(filter[0], filter[1]);
    const first = await q.order(table === "employee_availability" ? "user_id" : "id").range(0, 999);
    if (first.error || first.count === null || first.count > 10000)
      throw new Error("Aggregate RPC required");
    const rows = [...(first.data ?? [])];
    for (let offset = rows.length; offset < first.count; offset += 1000) {
      let next = db.from(table).select(columns).eq("workspace_id", workspaceId);
      if (filter)
        next = Array.isArray(filter[1])
          ? next.in(filter[0], filter[1])
          : next.eq(filter[0], filter[1]);
      const r = await next
        .order(table === "employee_availability" ? "user_id" : "id")
        .range(offset, offset + 999);
      if (r.error || !r.data?.length) throw new Error("Incomplete aggregate");
      rows.push(...r.data);
    }
    if (rows.length !== first.count) throw new Error("Incomplete aggregate");
    return rows as unknown as Record<string, unknown>[];
  }
  const [newLeads, pipeline, acknowledgement, recovery, escalations, availability] =
    await Promise.all([
      metric(async () => {
        // Query a UTC window enclosing the workspace's day, then compare local dates. DST is handled by Intl.
        const start = new Date(now.getTime() - 48 * 3600000).toISOString();
        let query = db
          .from("leads")
          .select("created_at", { count: "exact" })
          .eq("workspace_id", workspaceId)
          .gte("created_at", start)
          .lte("created_at", now.toISOString());
        if (personal) query = query.eq("assigned_to", userId);
        const r = await query.limit(1000);
        if (r.error || r.count === null || r.count > 1000)
          throw new Error("Day aggregate RPC required");
        return (r.data ?? []).filter(
          (x) => workspaceDay(new Date(x["created_at"]), timezone) === workspaceDay(now, timezone),
        ).length;
      }),
      canReadMoney(session.auth)
        ? metric(async () => {
            const [stages, pipelines] = await Promise.all([
              allRows("pipeline_stages", "id,name,pipeline_id,stage_type"),
              allRows("pipelines", "id,name"),
            ]);
            const openIds = stages
              .filter((s) => s["stage_type"] === "open")
              .map((s) => String(s["id"]));
            const rows = openIds.length
              ? await allRows("opportunities", "id,stage_id,currency,amount", ["stage_id", openIds])
              : [];
            return groupPipeline(rows as never, stages as never, pipelines as never);
          })
        : Promise.resolve(
            unavailableMetric(
              "Opportunity amounts are restricted to Owners pending approved monetary permissions.",
            ),
          ),
      metric(async () => {
        if (personal) {
          const rows = await allRows("leads", "id,first_assigned_at,first_acknowledged_at", [
            "assigned_to",
            userId,
          ]);
          const elapsed = rows
            .filter((r) => r["first_assigned_at"] && r["first_acknowledged_at"])
            .map(
              (r) =>
                (Date.parse(String(r["first_acknowledged_at"])) -
                  Date.parse(String(r["first_assigned_at"]))) /
                1000,
            );
          return elapsed.length ? elapsed.reduce((a, b) => a + b, 0) / elapsed.length : null;
        }
        const r = await db.rpc("get_first_response_stats", { p_workspace: workspaceId });
        if (r.error || !r.data?.[0]) throw new Error("Missing lead RPC");
        return r.data[0]["avg_seconds"] === null ? null : Number(r.data[0]["avg_seconds"]);
      }),
      metric(async () => {
        const r = await db.rpc("get_recovery_queue", {
          p_workspace: workspaceId,
          ...(personal ? { p_owner: userId } : {}),
          p_limit: 1,
          p_offset: 0,
        });
        if (r.error) throw new Error("Missing recovery RPC");
        return Number(r.data?.[0]?.["total_count"] ?? 0);
      }),
      metric(() => count("lead_escalations", "created_at", since)),
      metric(async () => {
        const [rows, leads, rule] = await Promise.all([
          allRows(
            "employee_availability",
            "user_id,status,max_open_leads",
            personal ? ["user_id", userId] : undefined,
          ),
          allRows("leads", "id,assigned_to,status", personal ? ["assigned_to", userId] : undefined),
          db
            .from("assignment_rules")
            .select("max_open_leads")
            .eq("workspace_id", workspaceId)
            .eq("is_active", true)
            .order("priority", { ascending: false })
            .order("created_at")
            .limit(1)
            .maybeSingle(),
        ]);
        if (rule.error) throw new Error("Capacity unavailable");
        return rows.map((r) => {
          const openLeads = leads.filter(
            (l) =>
              l["assigned_to"] === r["user_id"] &&
              !["converted", "lost"].includes(String(l["status"])),
          ).length;
          const capacity = r["max_open_leads"] ?? rule.data?.["max_open_leads"];
          return {
            userId: String(r["user_id"]),
            status: String(r["status"]),
            capacity: capacity == null ? null : Number(capacity),
            openLeads,
            eligible:
              r["status"] === "available" && capacity != null && openLeads < Number(capacity),
          };
        });
      }),
    ]);
  return {
    newLeads,
    pipeline,
    acknowledgement,
    recovery,
    escalations,
    availability,
    appointments: unavailableMetric(
      "Member 4 appointment table and confirmed scheduling contract are not available.",
    ),
    payments: unavailableMetric(
      "Member 4 confirmed payments/refunds schema and currency contract are not available.",
    ),
    timezone,
    asOf: now.toISOString(),
    scope: personal ? "personal" : "workspace",
  };
}
