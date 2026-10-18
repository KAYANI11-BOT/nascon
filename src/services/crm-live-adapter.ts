import type { CrmService, ServiceResult } from "@/types/domain";
import type { LiveEntity } from "./crm-live.contracts";
import { getLiveCrm, listLiveCrm, mutateLiveCrm } from "./crm-live.functions";
async function result<T>(call: () => Promise<unknown>): Promise<ServiceResult<T>> {
  try {
    return { data: (await call()) as T, error: null };
  } catch {
    return {
      data: null,
      error: "CRM request failed. Verify your session, permissions and database readiness.",
    };
  }
}
// Compatibility for existing typed contracts. Large lists must use listLiveCrm's paginated contract.
export function createLiveCrmService<Row, Input>(entity: LiveEntity): CrmService<Row, Input> {
  return {
    list: (workspaceId) =>
      result(async () => {
        const page = await listLiveCrm({ data: { entity, workspaceId, pageSize: 100 } });
        if (page.total > 100) throw new Error("Use paginated endpoint");
        return page.rows;
      }),
    getById: (workspaceId, id) => result(() => getLiveCrm({ data: { entity, workspaceId, id } })),
    create: (workspaceId, values) =>
      result(() => mutateLiveCrm({ data: { entity, workspaceId, values, action: "create" } })),
    update: (workspaceId, id, values) =>
      result(() => mutateLiveCrm({ data: { entity, workspaceId, values, id, action: "update" } })),
    delete: (workspaceId, id) =>
      result(() => mutateLiveCrm({ data: { entity, workspaceId, id, action: "delete" } })),
  };
}
