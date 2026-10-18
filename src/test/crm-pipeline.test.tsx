import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { useOpportunityRecords } from "@/components/leadguard/crm/opportunity-data";
import { usePipelineManager } from "@/components/leadguard/crm/pipeline-data";
import { DemoProvider } from "@/contexts/demo-context";

// Pipeline board and Opportunities page share one demo session, so both hooks run under one provider.
function setup() {
  const wrapper = ({ children }: { children: ReactNode }) => <DemoProvider>{children}</DemoProvider>;
  return renderHook(() => ({ manager: usePipelineManager(), records: useOpportunityRecords() }), { wrapper });
}
const sales = "pipeline-sales";
const stageId = (r: ReturnType<typeof setup>["result"], name: string) =>
  r.current.manager.pipelines.find((p) => p.id === sales)!.stages.find((s) => s.name === name)!.id;

describe("CRM pipeline demo state", () => {
  it("offers multiple pipelines with their own stages and custom fields", () => {
    const { result } = setup();
    expect(result.current.manager.pipelines.map((p) => p.name)).toEqual(["Sales pipeline", "Partnerships"]);
    expect(result.current.manager.pipelines[1]!.fields.map((f) => f.key)).toEqual(["partner_tier", "referral_fee"]);
  });

  it("moves an opportunity to a stage of its pipeline and syncs status", () => {
    const { result } = setup();
    const id = result.current.records.rows[0]!.id;
    act(() => { expect(result.current.records.moveToStage(id, "Won").ok).toBe(true); });
    const row = result.current.records.rows.find((r) => r.id === id)!;
    expect([row.stage, row.status]).toEqual(["Won", "Won"]);
    expect(result.current.records.moveToStage(id, "Live").ok).toBe(false);
  });

  it("renames a stage and keeps its opportunities attached", () => {
    const { result } = setup();
    const before = result.current.manager.countInStage(sales, "Discovery");
    expect(before).toBeGreaterThan(0);
    act(() => { expect(result.current.manager.renameStage(sales, stageId(result, "Discovery"), "Intro call").ok).toBe(true); });
    expect(result.current.manager.countInStage(sales, "Intro call")).toBe(before);
    expect(result.current.records.rows.some((r) => r.stage === "Discovery")).toBe(false);
  });

  it("blocks unsafe deletion and moves opportunities before a safe deletion", () => {
    const { result } = setup();
    const count = result.current.manager.countInStage(sales, "Proposal");
    const proposal = stageId(result, "Proposal");
    expect(result.current.manager.deleteStage(sales, proposal).ok).toBe(false);
    act(() => { expect(result.current.manager.deleteStage(sales, proposal, stageId(result, "Negotiation")).ok).toBe(true); });
    expect(result.current.manager.pipelines[0]!.stages.some((s) => s.name === "Proposal")).toBe(false);
    expect(result.current.manager.countInStage(sales, "Proposal")).toBe(0);
    expect(result.current.manager.countInStage(sales, "Negotiation")).toBeGreaterThanOrEqual(count);
  });

  it("adds, reorders and creates pipelines in the session", () => {
    const { result } = setup();
    act(() => { result.current.manager.addStage(sales, "Contract"); });
    expect(result.current.manager.pipelines[0]!.stages.map((s) => s.name)).toEqual(["Discovery", "Qualified", "Proposal", "Negotiation", "Contract", "Won"]);
    act(() => { result.current.manager.reorderStage(sales, stageId(result, "Contract"), -1); });
    expect(result.current.manager.pipelines[0]!.stages.map((s) => s.name).slice(3, 5)).toEqual(["Contract", "Negotiation"]);
    act(() => { expect(result.current.manager.createPipeline("Renewals").ok).toBe(true); });
    expect(result.current.manager.pipelines.map((p) => p.name)).toContain("Renewals");
  });
});
