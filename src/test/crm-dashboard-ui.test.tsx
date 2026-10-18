import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LiveDashboard } from "@/components/leadguard/crm/live-dashboard";
const api = vi.hoisted(() => ({ overview: vi.fn(), drill: vi.fn() }));
vi.mock("@/services/crm-dashboard.functions", () => ({
  getLiveDashboard: api.overview,
  getDashboardDrilldown: api.drill,
}));
vi.mock("@/components/leadguard/crm/live-queries", () => ({
  useCrmMode: () => ({
    ready: true,
    workspaceId: "ws",
    scope: ["user", "User"],
    auth: { user: { id: "user" } },
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));
const metric = <T,>(value: T) => ({ available: true, value });
const snapshot = {
  newLeads: metric(2),
  pipeline: metric([]),
  acknowledgement: metric(null),
  recovery: metric(1),
  escalations: metric(3),
  availability: metric([]),
  appointments: { available: false, reason: "No calendar source" },
  payments: { available: false, reason: "No confirmed payment source" },
  asOf: "2026-10-18T10:00:00Z",
  timezone: "Asia/Karachi",
  scope: "personal",
};
function mount() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <LiveDashboard />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  localStorage.clear();
  api.overview.mockReset().mockResolvedValue(snapshot);
  api.drill.mockReset().mockResolvedValue({ rows: [], total: 0 });
});
describe("operational dashboard UI", () => {
  it("shows eight figures with truthful unavailable states and three filtered drilldowns", async () => {
    mount();
    await screen.findByText("No calendar source");
    expect(screen.getByText("No confirmed payment source")).toBeInTheDocument();
    const buttons = screen.getAllByRole("button", { name: "View matching records" });
    expect(buttons).toHaveLength(3);
    fireEvent.click(buttons[2]!);
    await screen.findByText("No matching records.");
    expect(api.drill).toHaveBeenCalledWith({
      data: { workspaceId: "ws", kind: "escalations", page: 1, asOf: snapshot.asOf },
    });
  });
  it("remembers hidden figures across remounts", async () => {
    const view = mount();
    await screen.findByText("No calendar source");
    fireEvent.click(screen.getByLabelText("New leads today"));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "New leads today" })).not.toBeInTheDocument(),
    );
    view.unmount();
    mount();
    await screen.findByText("No calendar source");
    expect(screen.queryByRole("heading", { name: "New leads today" })).not.toBeInTheDocument();
  });
});
