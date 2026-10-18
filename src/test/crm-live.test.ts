import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthContext } from "@/types/domain";
import {
  assertCrmIdentity,
  assertCrmPermission,
  canReadMoney,
  parseCrmValues,
  safeCrmSearch,
} from "@/services/crm-live.contracts";
import { getCrm, listCrm, mutateCrm, readCrmActivity } from "@/services/crm-live.server";
import { groupPipeline, loadCrmDashboard, workspaceDay } from "@/services/crm-dashboard.server";

const ws = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const user = "00000000-0000-4000-8000-000000000003";
function auth(role: "Owner" | "Admin" | "User" = "Owner"): AuthContext {
  const activeWorkspace = {
    workspaceId: ws,
    role,
    workspace: { id: ws, name: "Test", industry: "Other", timezone: "Asia/Karachi" },
  };
  return {
    configured: true,
    enforced: true,
    user: { id: user, email: "test@example.com", fullName: "Test" },
    memberships: [activeWorkspace],
    activeWorkspace,
    permissions: [
      "contacts.manage",
      "companies.manage",
      "opportunities.manage",
      "pipelines.manage",
      "records.delete",
    ],
    error: null,
  };
}
type Reply = { data: unknown; error: { code?: string; message?: string } | null; count?: number };
function fake(replies: Reply[] = []) {
  const calls: { table: string; ops: [string, ...unknown[]][] }[] = [];
  const from = vi.fn((table: string) => {
    const call = { table, ops: [] as [string, ...unknown[]][] };
    calls.push(call);
    const reply = replies.shift() ?? { data: [], error: null, count: 0 };
    const chain: Record<string, unknown> = {};
    for (const name of [
      "select",
      "eq",
      "in",
      "ilike",
      "order",
      "range",
      "insert",
      "update",
      "delete",
      "gte",
      "lte",
      "limit",
    ])
      chain[name] = (...args: unknown[]) => {
        call.ops.push([name, ...args]);
        return chain;
      };
    chain["single"] = chain["maybeSingle"] = () => Promise.resolve(reply);
    chain["then"] = (resolve: (v: Reply) => void) => Promise.resolve(reply).then(resolve);
    return chain;
  });
  return {
    db: {
      from,
      rpc: vi.fn(async () => ({ data: [], error: { code: "PGRST202" } })),
    } as unknown as SupabaseClient,
    calls,
  };
}
const company = { name: " Acme ", domain: null, industry: null, phone: null, owner_id: null };
describe("CRM authorization and validation", () => {
  it.each(["user", "activeWorkspace", "configured", "enforced"] as const)(
    "rejects missing %s",
    (field) => {
      const value = {
        ...auth(),
        [field]: field === "user" || field === "activeWorkspace" ? null : false,
      };
      expect(() => assertCrmIdentity(value)).toThrow();
    },
  );
  it("rejects unverified membership and a stale workspace", () => {
    expect(() => assertCrmIdentity({ ...auth(), memberships: [] })).toThrow();
    expect(() => assertCrmIdentity(auth(), other)).toThrow("Workspace changed");
  });
  it("requires entity manage and separate delete permission", () => {
    expect(() => assertCrmPermission({ ...auth(), permissions: [] }, "companies")).toThrow();
    expect(() =>
      assertCrmPermission({ ...auth(), permissions: ["contacts.manage"] }, "contacts", true),
    ).toThrow();
  });
  it("fails closed for monetary visibility", () => {
    expect(canReadMoney(auth("Admin"))).toBe(false);
    expect(canReadMoney(auth())).toBe(true);
  });
  it.each(["workspace_id", "created_by", "id", "status", "email"])(
    "rejects unsupported company field %s",
    (field) => {
      expect(() => parseCrmValues("companies", { ...company, [field]: "forged" }, false)).toThrow();
    },
  );
  it("rejects invalid dates, numeric values and custom fields", () => {
    const base = {
      name: "Deal",
      pipeline_id: ws,
      stage_id: user,
      company_id: null,
      contact_id: null,
      owner_id: null,
      currency: "USD",
      expected_close_date: null,
    };
    expect(() =>
      parseCrmValues("opportunities", { ...base, expected_close_date: "2026-02-30" }, false),
    ).toThrow();
    expect(() => parseCrmValues("opportunities", { ...base, amount: -1 }, false)).toThrow();
    expect(() => parseCrmValues("opportunities", { ...base, custom_fields: {} }, false)).toThrow();
  });
  it("cleans search syntax", () => {
    expect(safeCrmSearch("a%,(id.eq.1)")).toBe("a   id.eq.1");
  });
});
describe("CRM server persistence boundary (fake database)", () => {
  it("does not query while signed out", async () => {
    const f = fake();
    await expect(
      listCrm({ ...f, auth: { ...auth(), user: null } }, { entity: "contacts" }),
    ).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });
  it("paginates, searches and scopes reads in the database", async () => {
    const f = fake([{ data: [{ id: other, workspace_id: ws }], count: 21, error: null }]);
    const result = await listCrm(
      { ...f, auth: auth() },
      { entity: "contacts", page: 2, pageSize: 20, search: "Acme", ownerId: user },
    );
    expect(result.total).toBe(21);
    expect(f.calls[0]!.ops).toContainEqual(["eq", "workspace_id", ws]);
    expect(f.calls[0]!.ops).toContainEqual(["eq", "owner_id", user]);
    expect(f.calls[0]!.ops).toContainEqual(["range", 20, 39]);
    expect(f.calls[0]!.ops).toContainEqual(["ilike", "full_name", "%Acme%"]);
  });
  it("omits amounts from database selection and responses for non-Owners", async () => {
    const f = fake([{ data: [{ id: other, amount: 123 }], error: null, count: 1 }]);
    const r = await listCrm({ ...f, auth: auth("User") }, { entity: "opportunities" });
    expect(f.calls[0]!.ops[0]![1]).not.toContain("amount");
    expect(r.rows[0]!.amount).toBeNull();
  });
  it("rejects amount sorting without requesting data", async () => {
    const f = fake();
    await expect(
      listCrm({ ...f, auth: auth("User") }, { entity: "opportunities", sort: "amount" }),
    ).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });
  it("creates with server identity and database confirmation", async () => {
    const f = fake([{ data: { id: other, workspace_id: ws, name: "Acme" }, error: null }]);
    const r = await mutateCrm({ ...f, auth: auth() }, "companies", "create", undefined, company);
    expect(r?.name).toBe("Acme");
    expect(f.calls[0]!.ops).toContainEqual([
      "insert",
      { ...company, name: "Acme", workspace_id: ws, created_by: user },
    ]);
  });
  it("scopes update and delete by both workspace and record id", async () => {
    const f = fake([
      { data: { id: other }, error: null },
      { data: { id: other }, error: null },
    ]);
    await mutateCrm({ ...f, auth: auth() }, "companies", "update", other, { name: "Renamed" });
    await mutateCrm({ ...f, auth: auth() }, "companies", "delete", other, undefined);
    for (const call of f.calls) {
      expect(call.ops).toContainEqual(["eq", "workspace_id", ws]);
      expect(call.ops).toContainEqual(["eq", "id", other]);
    }
  });
  it("rejects unavailable cross-workspace references", async () => {
    const f = fake([{ data: null, error: null }]);
    await expect(
      mutateCrm({ ...f, auth: auth() }, "companies", "create", undefined, {
        ...company,
        owner_id: other,
      }),
    ).rejects.toThrow("active workspace");
    expect(f.calls[0]!.ops).toContainEqual(["eq", "workspace_id", ws]);
    expect(f.calls).toHaveLength(1);
  });
  it("rejects a stage from another pipeline", async () => {
    const f = fake([
      { data: { id: user, stage_id: user, pipeline_id: ws }, error: null },
      { data: null, error: null },
    ]);
    await expect(
      mutateCrm({ ...f, auth: auth() }, "opportunities", "update", user, { stage_id: other }),
    ).rejects.toThrow("Stage must belong");
    expect(f.calls[1]!.ops).toContainEqual(["eq", "pipeline_id", ws]);
  });
  it("moves a stage and status in a single write while preserving hidden amounts", async () => {
    const f = fake([
      { data: { id: other, pipeline_id: ws }, error: null },
      { data: { stage_type: "won" }, error: null },
      { data: { id: other, amount: 123 }, error: null },
    ]);
    const r = await mutateCrm({ ...f, auth: auth("User") }, "opportunities", "update", other, {
      stage_id: user,
    });
    expect(f.calls[2]!.ops).toContainEqual(["update", { stage_id: user, status: "won" }]);
    expect(r?.amount).toBeNull();
  });
  it("rejects unauthorized amount edits", async () => {
    const f = fake();
    await expect(
      mutateCrm({ ...f, auth: auth("Admin") }, "opportunities", "update", other, { amount: 1 }),
    ).rejects.toThrow("restricted");
    expect(f.calls).toHaveLength(0);
  });
  it("blocks non-atomic stage operations", async () => {
    const f = fake();
    await expect(
      mutateCrm({ ...f, auth: auth() }, "pipeline_stages", "delete", other, undefined),
    ).rejects.toThrow("atomic");
    await expect(
      mutateCrm({ ...f, auth: auth() }, "pipeline_stages", "update", other, { position: 5 }),
    ).rejects.toThrow("atomic");
    expect(f.calls).toHaveLength(0);
  });
  it("does not expose database errors or pretend zero-row writes succeeded", async () => {
    const f = fake([
      { data: null, error: { code: "XX000", message: "secret internal SQL" } },
      { data: null, error: null },
    ]);
    await expect(
      mutateCrm({ ...f, auth: auth() }, "companies", "create", undefined, company),
    ).rejects.toThrow("CRM database operation failed");
    await expect(
      mutateCrm({ ...f, auth: auth() }, "companies", "delete", other, undefined),
    ).rejects.toThrow("did not confirm");
  });
  it("returns a not-found state for missing detail", async () => {
    const f = fake([{ data: null, error: null }]);
    await expect(getCrm({ ...f, auth: auth() }, "contacts", other)).rejects.toThrow("not found");
  });
  it("applies three criteria and close date ranges together in the database", async () => {
    const f = fake();
    await listCrm(
      { ...f, auth: auth() },
      {
        entity: "opportunities",
        pipelineId: ws,
        stageId: other,
        ownerId: user,
        closeFrom: "2026-10-01",
        closeTo: "2026-10-31",
      },
    );
    for (const op of [
      ["eq", "pipeline_id", ws],
      ["eq", "stage_id", other],
      ["eq", "owner_id", user],
      ["gte", "expected_close_date", "2026-10-01"],
      ["lte", "expected_close_date", "2026-10-31"],
    ])
      expect(f.calls[0]!.ops).toContainEqual(op);
  });
  it("rejects reversed date ranges before querying", async () => {
    const f = fake();
    await expect(
      listCrm(
        { ...f, auth: auth() },
        { entity: "opportunities", closeFrom: "2026-10-31", closeTo: "2026-10-01" },
      ),
    ).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });
  it("cannot change a restricted amount denomination", async () => {
    const f = fake([
      { data: { id: other, currency: "USD", pipeline_id: ws, stage_id: user }, error: null },
    ]);
    await expect(
      mutateCrm({ ...f, auth: auth("User") }, "opportunities", "update", other, {
        currency: "PKR",
      }),
    ).rejects.toThrow("currencies are restricted");
    expect(f.calls).toHaveLength(1);
  });
});
describe("operational metrics", () => {
  it("sums fractional cents exactly without mixing currencies", () => {
    const rows = groupPipeline(
      [
        { stage_id: "s", currency: "USD", amount: "0.10" },
        { stage_id: "s", currency: "USD", amount: "0.20" },
        { stage_id: "s", currency: "EUR", amount: "0.10" },
      ],
      [],
      [],
    );
    expect(rows.map((r) => [r.currency, r.amount])).toEqual([
      ["USD", 0.3],
      ["EUR", 0.1],
    ]);
  });
  it("rejects unsafe or malformed aggregates rather than displaying an inaccurate total", () => {
    expect(() =>
      groupPipeline([{ stage_id: "s", currency: "USD", amount: "90071992547409.92" }], [], []),
    ).toThrow("exact database aggregate");
    expect(() =>
      groupPipeline([{ stage_id: "s", currency: "USD", amount: "NaN" }], [], []),
    ).toThrow("Invalid monetary");
  });
  it("keeps stage currencies separate and converts numeric strings", () => {
    const rows = groupPipeline(
      [
        { stage_id: "s", currency: "USD", amount: "10.25" },
        { stage_id: "s", currency: "USD", amount: 20 },
        { stage_id: "s", currency: "PKR", amount: 1000 },
      ],
      [{ id: "s", name: "New", pipeline_id: "p" }],
      [{ id: "p", name: "Sales" }],
    );
    expect(rows.map((r) => [r.currency, r.amount, r.count])).toEqual([
      ["USD", 30.25, 2],
      ["PKR", 1000, 1],
    ]);
  });
  it("uses workspace day at UTC midnight and DST boundaries", () => {
    expect(workspaceDay(new Date("2026-10-17T20:00:00Z"), "Asia/Karachi")).toBe("2026-10-18");
    expect(workspaceDay(new Date("2026-03-08T07:00:00Z"), "America/New_York")).toBe("2026-03-08");
  });
  it("does not query monetary data for a restricted user and marks missing sources unavailable", async () => {
    const f = fake();
    const d = await loadCrmDashboard(
      { ...f, auth: auth("Admin") },
      new Date("2026-10-18T10:00:00Z"),
    );
    expect(d.pipeline.available).toBe(false);
    expect(d.payments.available).toBe(false);
    expect(d.appointments.available).toBe(false);
    expect(d.acknowledgement.available).toBe(false);
    expect(f.calls.some((c) => c.table === "opportunities")).toBe(false);
  });
  it("scopes User figures to their records and accounts for capacity", async () => {
    const f = fake([
      {
        data: [{ created_at: "2026-10-17T20:00:00Z" }, { created_at: "2026-10-17T10:00:00Z" }],
        error: null,
        count: 2,
      },
      {
        data: [
          {
            first_assigned_at: "2026-10-18T09:00:00Z",
            first_acknowledged_at: "2026-10-18T09:01:00Z",
          },
        ],
        error: null,
        count: 1,
      },
      { data: null, error: null, count: 2 },
      { data: [{ user_id: user, status: "available", max_open_leads: 1 }], error: null, count: 1 },
      { data: [{ id: other, assigned_to: user, status: "new" }], error: null, count: 1 },
      { data: { max_open_leads: 10 }, error: null },
    ]);
    const d = await loadCrmDashboard(
      { ...f, auth: auth("User") },
      new Date("2026-10-18T10:00:00Z"),
    );
    expect(d.scope).toBe("personal");
    expect(d.newLeads).toEqual({ available: true, value: 1 });
    expect(d.acknowledgement).toEqual({ available: true, value: 60 });
    expect(d.availability.available && d.availability.value[0]).toMatchObject({
      openLeads: 1,
      capacity: 1,
      eligible: false,
    });
    for (const c of f.calls.filter((c) => c.table === "leads"))
      expect(c.ops).toContainEqual(["eq", "assigned_to", user]);
    expect(f.calls.find((c) => c.table === "lead_escalations")!.ops).toContainEqual([
      "eq",
      "new_owner",
      user,
    ]);
  });
  it("marks oversized daily aggregates unavailable rather than truncating counts", async () => {
    const f = fake([{ data: [], count: 1001, error: null }]);
    const d = await loadCrmDashboard({ ...f, auth: auth("Admin") });
    expect(d.newLeads.available).toBe(false);
  });
});
describe("CRM activity metadata", () => {
  it("loads opportunity history with correct actor identities and deterministic timestamps", async () => {
    const f = fake([
      { data: { id: other, workspace_id: ws }, error: null },
      {
        data: [
          {
            id: 2,
            actor_id: user,
            action: "update",
            created_at: "2026-10-18T10:00:00Z",
            old_data: { amount: 999 },
          },
        ],
        error: null,
        count: 1,
      },
      { data: [{ id: user, full_name: "Actual actor" }], error: null },
    ]);
    const identity = {
      ...auth("User"),
      permissions: [...auth("User").permissions, "audit.view" as const],
    };
    const result = await readCrmActivity({ ...f, auth: identity }, "opportunities", other, 2, ws);
    expect(result.rows[0]).toEqual({
      id: 2,
      actorId: user,
      actorName: "Actual actor",
      action: "update",
      createdAt: "2026-10-18T10:00:00Z",
    });
    const audit = f.calls.find((c) => c.table === "audit_logs")!;
    expect(audit.ops).toContainEqual(["eq", "workspace_id", ws]);
    expect(audit.ops).toContainEqual(["eq", "table_name", "opportunities"]);
    expect(audit.ops).toContainEqual(["eq", "record_id", other]);
    expect(audit.ops).toContainEqual(["range", 20, 39]);
    expect(audit.ops).toContainEqual(["order", "id", { ascending: false }]);
    expect(JSON.stringify(result)).not.toContain("amount");
    expect(audit.ops[0]![1]).not.toContain("data");
    expect(f.calls[0]!.ops[0]![1]).not.toContain("amount");
  });
  it("rejects missing audit permission without reading the database", async () => {
    const f = fake();
    await expect(readCrmActivity({ ...f, auth: auth() }, "contacts", other)).rejects.toThrow(
      "audit viewing permission",
    );
    expect(f.calls).toHaveLength(0);
  });
  it("preserves unavailable actor IDs and does not impersonate a current employee", async () => {
    const f = fake([
      { data: { id: other }, error: null },
      {
        data: [
          { id: 1, actor_id: user, action: "insert", created_at: "2026-10-18T10:00:00Z" },
          { id: 2, actor_id: null, action: "update", created_at: "2026-10-18T10:00:01Z" },
        ],
        error: null,
        count: 2,
      },
      { data: null, error: { code: "42501" } },
    ]);
    const result = await readCrmActivity(
      { ...f, auth: { ...auth(), permissions: ["audit.view"] } },
      "contacts",
      other,
    );
    expect(result.rows[0]!.actorName).toBe(`Member ${user}`);
    expect(result.rows[1]!.actorName).toBe("System or removed account");
  });
});
describe("optimistic CRM concurrency", () => {
  it("checks the loaded version in the same database update", async () => {
    const version = "2026-10-18T10:00:00Z";
    const f = fake([{ data: { id: other }, error: null }]);
    await mutateCrm(
      { ...f, auth: auth() },
      "contacts",
      "update",
      other,
      { full_name: "Changed" },
      ws,
      version,
    );
    expect(f.calls[0]!.ops).toContainEqual(["eq", "updated_at", version]);
    expect(f.calls[0]!.ops).toContainEqual(["eq", "workspace_id", ws]);
  });
  it("does not overwrite or delete a concurrently changed record", async () => {
    const f = fake([{ data: null, error: { code: "PGRST116" } }]);
    await expect(
      mutateCrm(
        { ...f, auth: auth() },
        "companies",
        "delete",
        other,
        undefined,
        ws,
        "2026-10-18T10:00:00Z",
      ),
    ).rejects.toThrow("record changed");
  });
});
