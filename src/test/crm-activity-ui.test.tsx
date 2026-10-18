import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LiveCrmActivity } from "@/components/leadguard/crm/live-activity";
const state = vi.hoisted(() => ({ allowed: true, read: vi.fn() }));
vi.mock("@/services/crm-live.functions", () => ({ getCrmActivity: state.read }));
vi.mock("@/components/leadguard/crm/live-queries", () => ({
  useCrmMode: () => ({
    ready: true,
    demo: false,
    workspaceId: "workspace",
    scope: ["user"],
    auth: {
      can: () => state.allowed,
      activeWorkspace: { workspace: { timezone: "Asia/Karachi" } },
    },
  }),
}));
function mount() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <LiveCrmActivity entity="opportunities" id="deal" />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  state.allowed = true;
  state.read.mockReset();
});
describe("opportunity timeline", () => {
  it("shows authoritative actor and timezone-correct timestamp", async () => {
    state.read.mockResolvedValue({
      rows: [
        {
          id: 1,
          actorId: "actual-id",
          actorName: "Actual employee",
          action: "update",
          createdAt: "2026-10-18T10:00:00Z",
        },
      ],
      total: 1,
    });
    mount();
    await screen.findByText("Actual employee");
    expect(screen.getByText("(actual-id)")).toBeInTheDocument();
    const time = document.querySelector("time")!;
    expect(time.getAttribute("datetime")).toBe("2026-10-18T10:00:00Z");
    expect(time.textContent).toContain("15:00:00");
    expect(time.textContent).toContain("Asia/Karachi");
  });
  it("does not request history without audit permission", () => {
    state.allowed = false;
    mount();
    expect(screen.getByText("Audit viewing permission required.")).toBeInTheDocument();
    expect(state.read).not.toHaveBeenCalled();
  });
  it("shows unavailable history rather than a false empty result", async () => {
    state.read.mockRejectedValue(new Error("Permission denied."));
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("Permission denied.");
    expect(screen.queryByText("No recorded activity for this record.")).not.toBeInTheDocument();
  });
});
