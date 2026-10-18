import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LiveRecordEditor, ReferenceSelect } from "@/components/leadguard/crm/live-crm-page";
import type { CrmReferences, LiveRow } from "@/services/crm-live.contracts";

const state = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  role: "Owner",
  error: null as Error | null,
}));
vi.mock("@/components/leadguard/crm/live-queries", () => ({
  useCrmMode: () => ({ auth: { activeWorkspace: { role: state.role } } }),
  useCrmMutation: () => ({ mutateAsync: state.mutateAsync, isPending: false, error: state.error }),
}));
const refs = {
  companies: [{ id: "company", name: "Acme" }],
  contacts: [{ id: "contact", full_name: "Alex" }],
  pipelines: [{ id: "pipeline", name: "Sales" }],
  stages: [{ id: "stage", pipeline_id: "pipeline", name: "New", position: 0, stage_type: "open" }],
  members: [{ id: "owner", name: "Employee" }],
  truncated: false,
} as CrmReferences;
const record: LiveRow = {
  id: "deal",
  workspace_id: "ws",
  name: "Deal",
  company_id: "company",
  contact_id: "contact",
  owner_id: "owner",
  pipeline_id: "pipeline",
  stage_id: "stage",
  amount: 100,
  currency: "USD",
};
beforeEach(() => {
  state.mutateAsync.mockReset();
  state.role = "Owner";
  state.error = null;
});
describe("live CRM editor", () => {
  it("retains linked record IDs and closes only after server confirmation", async () => {
    let finish!: () => void;
    state.mutateAsync.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const onClose = vi.fn();
    render(
      <LiveRecordEditor entity="opportunities" record={record} refs={refs} onClose={onClose} />,
    );
    expect(screen.getByLabelText("Contact")).toHaveValue("contact");
    expect(screen.getByLabelText("Company")).toHaveValue("company");
    expect(screen.getByLabelText("Assigned employee")).toHaveValue("owner");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(state.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "update",
        id: "deal",
        values: expect.objectContaining({
          contact_id: "contact",
          company_id: "company",
          amount: 100,
        }),
      }),
    );
    finish();
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });
  it("does not submit restricted amounts as zero", async () => {
    state.role = "User";
    state.mutateAsync.mockResolvedValue(null);
    render(
      <LiveRecordEditor
        entity="opportunities"
        record={{ ...record, amount: null }}
        refs={refs}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText("Amount")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const submitted = state.mutateAsync.mock.calls[0]![0].values;
    expect(submitted).not.toHaveProperty("amount");
    expect(submitted).not.toHaveProperty("currency");
  });
  it("keeps the editor open when persistence fails", async () => {
    state.mutateAsync.mockRejectedValue(new Error("Network failed"));
    const onClose = vi.fn();
    render(
      <LiveRecordEditor
        entity="contacts"
        record={{ ...record, full_name: "Alex", email: "alex@example.com" }}
        refs={refs}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(state.mutateAsync).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
  });
  it("preserves an existing relationship omitted by the reference limit", () => {
    render(
      <ReferenceSelect label="Company" name="company" options={[]} defaultValue="existing-id" />,
    );
    expect(screen.getByLabelText("Company")).toHaveValue("existing-id");
  });
  it("renders database failure without reporting success", () => {
    state.error = new Error("Permission denied.");
    render(<LiveRecordEditor entity="companies" refs={refs} onClose={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Permission denied.");
  });
});
