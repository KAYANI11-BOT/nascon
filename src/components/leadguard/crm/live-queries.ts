import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/auth-context";
import { getSupabaseConfiguration } from "@/lib/supabase";
import {
  getCrmReferences,
  getLiveCrm,
  listLiveCrm,
  mutateLiveCrm,
} from "@/services/crm-live.functions";
import type { LiveEntity, LiveListInput } from "@/services/crm-live.contracts";

export function useCrmMode() {
  const auth = useAuth();
  // Only explicit demo mode can render fixtures. Missing auth/configuration must never fall back to demo.
  return {
    demo: getSupabaseConfiguration().demoMode,
    ready: auth.enforced && !!auth.user && !!auth.activeWorkspace && !auth.error,
    workspaceId: auth.activeWorkspace?.workspaceId ?? null,
    auth,
    scope: [auth.user?.id, auth.activeWorkspace?.role, [...auth.permissions].sort().join(",")],
  };
}
export function useLiveRecords(input: LiveListInput) {
  const mode = useCrmMode();
  return useQuery({
    queryKey: ["crm", mode.workspaceId, mode.scope, "list", input],
    enabled: mode.ready && !mode.demo,
    queryFn: () => listLiveCrm({ data: { ...input, workspaceId: mode.workspaceId! } }),
    refetchInterval: 30_000,
  });
}
export function useLiveRecord(entity: LiveListInput["entity"], id: string) {
  const mode = useCrmMode();
  return useQuery({
    queryKey: ["crm", mode.workspaceId, mode.scope, entity, id],
    enabled: mode.ready && !mode.demo && !!id,
    queryFn: () => getLiveCrm({ data: { entity, id, workspaceId: mode.workspaceId! } }),
    refetchInterval: 30_000,
  });
}
export function useCrmReferences() {
  const mode = useCrmMode();
  return useQuery({
    queryKey: ["crm", mode.workspaceId, mode.scope, "references"],
    enabled: mode.ready && !mode.demo,
    queryFn: () => getCrmReferences({ data: { workspaceId: mode.workspaceId! } }),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}
export async function refreshCrmWorkspace(qc: QueryClient, workspaceId: string) {
  await Promise.all([
    qc.invalidateQueries({ queryKey: ["crm", workspaceId] }),
    qc.invalidateQueries({ queryKey: ["crm-dashboard", workspaceId] }),
  ]);
}
export function useCrmMutation() {
  const mode = useCrmMode();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      entity: LiveEntity;
      action: "create" | "update" | "delete";
      id?: string;
      values?: unknown;
      expectedUpdatedAt?: string;
    }) => mutateLiveCrm({ data: { ...data, workspaceId: mode.workspaceId! } }),
    onMutate: async () => {
      if (!mode.ready || mode.demo || !mode.workspaceId)
        throw new Error("A verified workspace is required.");
      const workspaceId = mode.workspaceId;
      await Promise.all([
        qc.cancelQueries({ queryKey: ["crm", workspaceId] }),
        qc.cancelQueries({ queryKey: ["crm-dashboard", workspaceId] }),
      ]);
      return { workspaceId };
    },
    // A lost HTTP response can follow a successful database write. Refetch on errors too.
    // Use the mutation's original scope, even if the active workspace has since changed.
    onSettled: async (_data, _error, _variables, context) => {
      if (context?.workspaceId) await refreshCrmWorkspace(qc, context.workspaceId);
    },
  });
}
