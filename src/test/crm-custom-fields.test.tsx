import { act, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { OpportunityForm } from "@/components/leadguard/crm/opportunity-form";
import { useOpportunityRecords, type OpportunityFormValues } from "@/components/leadguard/crm/opportunity-data";
import { usePipelineManager } from "@/components/leadguard/crm/pipeline-data";
import { DemoProvider } from "@/contexts/demo-context";

const wrapper = ({ children }: { children: ReactNode }) => <DemoProvider>{children}</DemoProvider>;
const setup = () => renderHook(() => ({ manager: usePipelineManager(), records: useOpportunityRecords() }), { wrapper });
type Hooks = ReturnType<typeof setup>["result"];
const SALES = "pipeline-sales";
const PARTNERS = "pipeline-partners";
const values = (overrides: Partial<OpportunityFormValues>): OpportunityFormValues => ({
  title: "Acme partnership", contact: "", company: "", value: 1000, currency: "USD", pipelineId: PARTNERS,
  stage: "Evaluation", owner: "Alex Morgan", status: "Open", closeDate: "", customFields: {}, ...overrides,
});
const pipeline = (r: Hooks, id: string) => r.current.manager.pipelines.find((p) => p.id === id)!;
function createPartnerOpportunity(r: Hooks, customFields: Record<string, string> = {}) {
  act(() => { expect(r.current.records.save!(undefined, values({ customFields })).ok).toBe(true); });
  return r.current.records.rows.find((o) => o.title === "Acme partnership")!;
}

describe("CRM custom fields in demo mode", () => {
  it("keeps fields specific to one pipeline", () => {
    const { result } = setup();
    act(() => { expect(result.current.manager.addField(SALES, { label: "Budget confirmed", type: "checkbox", options: [], required: false }).ok).toBe(true); });
    expect(pipeline(result, SALES).fields.map((f) => f.label)).toContain("Budget confirmed");
    expect(pipeline(result, PARTNERS).fields.map((f) => f.label)).not.toContain("Budget confirmed");
  });

  it("rejects moving into a stage whose required fields are missing", () => {
    const { result } = setup();
    const opp = createPartnerOpportunity(result);
    let outcome: ReturnType<typeof result.current.records.moveToStage> | undefined;
    act(() => { outcome = result.current.records.moveToStage(opp.id, "Agreement"); });
    expect(outcome?.ok).toBe(false);
    expect(!outcome?.ok && outcome?.error).toContain("“Agreement” requires: Partner tier, Referral fee (%).");
    expect(result.current.records.rows.find((o) => o.id === opp.id)!.stage).toBe("Evaluation");
  });

  it("moves the opportunity once the required fields are completed", () => {
    const { result } = setup();
    const opp = createPartnerOpportunity(result);
    act(() => { expect(result.current.records.save!(opp.id, values({ customFields: { partner_tier: "Gold", referral_fee: "10" } })).ok).toBe(true); });
    act(() => { expect(result.current.records.moveToStage(opp.id, "Agreement").ok).toBe(true); });
    expect(result.current.records.rows.find((o) => o.id === opp.id)!.stage).toBe("Agreement");
    // "Live" additionally requires the checkbox to be ticked.
    act(() => { expect(result.current.records.moveToStage(opp.id, "Live").ok).toBe(false); });
  });

  it("rejects saving an opportunity into a stage with missing or invalid values", () => {
    const { result } = setup();
    expect(result.current.records.save!(undefined, values({ stage: "Agreement" })).ok).toBe(false);
    const invalid = result.current.records.save!(undefined, values({ customFields: { referral_fee: "ten" } }));
    expect(!invalid.ok && invalid.error).toBe("Referral fee (%) must be a number.");
  });

  it("does not let one pipeline's requirements affect another pipeline", () => {
    const { result } = setup();
    const agreement = pipeline(result, PARTNERS).stages.find((s) => s.name === "Agreement")!;
    act(() => { result.current.manager.setStageRequirement(PARTNERS, agreement.id, "field-partners-1", true); });
    const salesOpp = result.current.records.rows.find((o) => o.pipelineId === SALES)!;
    act(() => { expect(result.current.records.moveToStage(salesOpp.id, "Negotiation").ok).toBe(true); });
  });

  it("blocks moving a stage's opportunities into a stage they do not satisfy", () => {
    const { result } = setup();
    createPartnerOpportunity(result);
    const p = pipeline(result, PARTNERS);
    const evaluation = p.stages.find((s) => s.name === "Evaluation")!;
    const agreement = p.stages.find((s) => s.name === "Agreement")!;
    const r = result.current.manager.deleteStage(PARTNERS, evaluation.id, agreement.id);
    expect(!r.ok && r.error).toMatch(/1 opportunity is missing required fields/);
    expect(pipeline(result, PARTNERS).stages.some((s) => s.id === evaluation.id)).toBe(true);
  });

  it("shows field changes from settings in the opportunity form", () => {
    function Harness() {
      const manager = usePipelineManager();
      const records = useOpportunityRecords();
      return (
        <>
          <button onClick={() => manager.addField(PARTNERS, { label: "Go-live region", type: "select", options: ["EMEA", "APAC"], required: false })}>add</button>
          <button onClick={() => manager.updateField(PARTNERS, "field-partners-1", { label: "Partner level", options: ["Silver", "Gold", "Platinum", "Diamond"], required: false })}>edit</button>
          <OpportunityForm open onClose={() => {}} defaults={DEFAULTS} pipelines={records.pipelines} team={records.team} contacts={records.contacts} companies={records.companies} onSave={records.save} />
        </>
      );
    }
    render(<Harness />, { wrapper });
    expect(screen.getByText("Partner tier")).toBeInTheDocument();
    act(() => { screen.getByText("add").click(); screen.getByText("edit").click(); });
    expect(screen.getByText("Go-live region")).toBeInTheDocument();
    expect(screen.getByText("Partner level")).toBeInTheDocument();
    expect(screen.queryByText("Partner tier")).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Diamond" })).toBeInTheDocument();
  });
});
const DEFAULTS = { pipelineId: PARTNERS, stage: "Evaluation" };
