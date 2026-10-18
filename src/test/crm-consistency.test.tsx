import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCrmMutation } from "@/components/leadguard/crm/live-queries";
const state = vi.hoisted(() => ({ workspace: "workspace-a", mutate: vi.fn() }));
vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({
    enforced: true,
    user: { id: "user" },
    activeWorkspace: { workspaceId: state.workspace, role: "User" },
    permissions: ["contacts.manage"],
    error: null,
  }),
}));
vi.mock("@/lib/supabase", () => ({ getSupabaseConfiguration: () => ({ demoMode: false }) }));
vi.mock("@/services/crm-live.functions", () => ({ mutateLiveCrm: state.mutate }));
beforeEach(() => {
  state.workspace = "workspace-a";
  state.mutate.mockReset();
});
function setup() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  for (const prefix of ["crm", "crm-dashboard"])
    for (const ws of ["workspace-a", "workspace-b"])
      qc.setQueryData([prefix, ws, "existing"], { old: true });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, ...renderHook(() => useCrmMutation(), { wrapper }) };
}
describe("CRM mutation consistency", () => {
  it("invalidates related CRM and dashboard caches after a failed or ambiguous response", async () => {
    state.mutate.mockRejectedValue(new Error("Response lost"));
    const { qc, result } = setup();
    await act(async () => {
      await result.current
        .mutateAsync({
          entity: "contacts",
          action: "update",
          id: "record",
          values: { full_name: "Updated" },
        })
        .catch(() => undefined);
    });
    expect(qc.getQueryState(["crm", "workspace-a", "existing"])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(["crm-dashboard", "workspace-a", "existing"])?.isInvalidated).toBe(
      true,
    );
    expect(qc.getQueryState(["crm", "workspace-b", "existing"])?.isInvalidated).toBe(false);
  });
  it("refreshes the mutation original workspace after the selected workspace changes", async () => {
    let finish!: (value: null) => void;
    state.mutate.mockImplementation(
      () =>
        new Promise<null>((resolve) => {
          finish = resolve;
        }),
    );
    const { qc, result, rerender } = setup();
    act(() => result.current.mutate({ entity: "contacts", action: "delete", id: "record" }));
    await waitFor(() => expect(state.mutate).toHaveBeenCalled());
    state.workspace = "workspace-b";
    rerender();
    await act(async () => {
      finish(null);
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(state.mutate).toHaveBeenCalledWith({
      data: { entity: "contacts", action: "delete", id: "record", workspaceId: "workspace-a" },
    });
    expect(qc.getQueryState(["crm", "workspace-a", "existing"])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(["crm", "workspace-b", "existing"])?.isInvalidated).toBe(false);
  });
});
