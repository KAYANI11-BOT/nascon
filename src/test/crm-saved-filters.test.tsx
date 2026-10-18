import { act, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { FilterBuilder } from "@/components/leadguard/crm/filter-builder";
import { useSavedFilters } from "@/components/leadguard/crm/filter-data";
import { usePipelineManager } from "@/components/leadguard/crm/pipeline-data";
import { matchesFilter } from "@/components/leadguard/crm/filter-rules";
import { useOpportunityRecords } from "@/components/leadguard/crm/opportunity-data";
import { DemoProvider } from "@/contexts/demo-context";
import type { FilterCondition, FilterDefinition } from "@/types/domain";

const wrapper = ({ children }: { children: ReactNode }) => <DemoProvider>{children}</DemoProvider>;
const setup = () => renderHook(() => ({ filters: useSavedFilters(), records: useOpportunityRecords() }), { wrapper });
const SALES = "pipeline-sales";
const PARTNERS = "pipeline-partners";
const stage = (value: string, id = "c1"): FilterCondition => ({ id, kind: "stage", value });
const owner = (value: string, id = "c2"): FilterCondition => ({ id, kind: "owner", value });
const created = (value: string, id = "c3"): FilterCondition => ({ id, kind: "date", dateField: "created", operator: "on", value });
const matches = (r: ReturnType<typeof setup>["result"], def: FilterDefinition) => r.current.records.rows.filter((o) => matchesFilter(def, o));

describe("saved filters in demo mode", () => {
  it('keeps a saved filter working across an actual pipeline rename',()=>{
    const {result}=renderHook(()=>({filters:useSavedFilters(),manager:usePipelineManager(),records:useOpportunityRecords()}),{wrapper});
    const pipeline=result.current.manager.pipelines.find(p=>p.id===SALES)!;const original=pipeline.stages.find(s=>s.name==='Proposal')!;
    act(()=>{expect(result.current.filters.create('Stable stage',{pipelineId:SALES,conditions:[stage('Proposal')]}).ok).toBe(true);});
    const before=result.current.records.rows.filter(r=>matchesFilter(result.current.filters.filters[0]!,r)).map(r=>r.id);
    expect(before.length).toBeGreaterThan(0);
    act(()=>{expect(result.current.manager.renameStage(SALES,original.id,'Renamed proposal').ok).toBe(true);});
    const after=result.current.records.rows.filter(r=>matchesFilter(result.current.filters.filters[0]!,r));expect(after.map(r=>r.id)).toEqual(before);expect(after.every(r=>r.stage==='Renamed proposal')).toBe(true);
  });
  it("applies three simultaneous filters to the sample opportunities", () => {
    const { result } = setup();
    const target = result.current.records.rows.find((o) => o.pipelineId === SALES)!;
    const def: FilterDefinition = { pipelineId: SALES, conditions: [stage(target.stage), owner(target.owner), created(target.created)] };
    const found = matches(result, def);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((o) => o.stage === target.stage && o.owner === target.owner && o.created === target.created)).toBe(true);
    expect(found.length).toBeLessThan(result.current.records.rows.length);
  });

  it("creates, edits and deletes saved filters for the session", () => {
    const { result } = setup();
    expect(result.current.filters.filters).toEqual([]);
    let id = "";
    act(() => { const r = result.current.filters.create("Discovery deals", { pipelineId: SALES, conditions: [stage("Discovery")] }); if (!r.ok) throw new Error(r.error); id = r.value; });
    expect(result.current.filters.filters.map((f) => f.name)).toEqual(["Discovery deals"]);

    act(() => { expect(result.current.filters.update(id, "Proposal deals", { pipelineId: SALES, conditions: [stage("Proposal")] }).ok).toBe(true); });
    expect(result.current.filters.filters[0]).toMatchObject({ id, name: "Proposal deals", pipelineId: SALES });
    expect(result.current.filters.filters[0]!.conditions).toEqual([{...stage("Proposal"),stageIds:["stage-sales-3"]}]);

    act(() => { expect(result.current.filters.remove(id).ok).toBe(true); });
    expect(result.current.filters.filters).toEqual([]);
  });

  it("rejects invalid or duplicate saves and leaves the list unchanged", () => {
    const { result } = setup();
    act(() => { expect(result.current.filters.create("Mine", { pipelineId: SALES, conditions: [stage("Discovery")] }).ok).toBe(true); });
    let outcomes: boolean[] = [];
    act(() => {
      outcomes = [
        result.current.filters.create("mine", { pipelineId: SALES, conditions: [stage("Discovery")] }).ok,
        result.current.filters.create("", { pipelineId: SALES, conditions: [stage("Discovery")] }).ok,
        result.current.filters.create("Empty", { pipelineId: SALES, conditions: [] }).ok,
        result.current.filters.create("Wrong stage", { pipelineId: SALES, conditions: [stage("Live")] }).ok,
      ];
    });
    expect(outcomes).toEqual([false, false, false, false]);
    expect(result.current.filters.filters).toHaveLength(1);
  });

  it("updates results when opportunities change", () => {
    const { result } = setup();
    const def: FilterDefinition = { pipelineId: SALES, conditions: [stage("Negotiation")] };
    const before = matches(result, def).length;
    const mover = result.current.records.rows.find((o) => o.pipelineId === SALES && o.stage !== "Negotiation")!;
    act(() => { expect(result.current.records.moveToStage(mover.id, "Negotiation").ok).toBe(true); });
    expect(matches(result, def).map((o) => o.id)).toContain(mover.id);
    expect(matches(result, def)).toHaveLength(before + 1);

    act(() => { expect(result.current.records.save!(undefined, { title: "Fresh deal", contact: "", company: "", value: 10, currency: "USD", pipelineId: SALES, stage: "Negotiation", owner: "Alex Morgan", status: "Open", closeDate: "", customFields: {} }).ok).toBe(true); });
    expect(matches(result, def)).toHaveLength(before + 2);
  });

  it("filters custom fields and keeps pipelines isolated after edits", () => {
    const { result } = setup();
    const form = { title: "Gold partner", contact: "", company: "", value: 10, currency: "USD", pipelineId: PARTNERS, stage: "Evaluation", owner: "Alex Morgan", status: "Open", closeDate: "", customFields: { partner_tier: "Gold" } };
    act(() => { expect(result.current.records.save!(undefined, form).ok).toBe(true); });
    const tier = (value: string): FilterDefinition => ({ pipelineId: "all", conditions: [{ id: "x", kind: "custom", pipelineId: PARTNERS, fieldKey: "partner_tier", operator: "equals", value }] });
    expect(matches(result, tier("Gold")).map((o) => o.title)).toEqual(["Gold partner"]);
    expect(matches(result, tier("Silver"))).toEqual([]);
    const salesOnly = matches(result, { pipelineId: SALES, conditions: [] });
    expect(salesOnly.every((o) => o.pipelineId === SALES)).toBe(true);
    expect(salesOnly.some((o) => o.title === "Gold partner")).toBe(false);
  });
});

function Harness() {
  const [value, setValue] = useState<FilterDefinition>({ pipelineId: "all", conditions: [] });
  const records = useOpportunityRecords();
  return (
    <>
      <FilterBuilder value={value} onChange={setValue} pipelines={records.pipelines} owners={["Alex Morgan", "Sarah Chen"]} />
      <output data-testid="conditions">{value.conditions.length}</output>
      <output data-testid="first-stage">{value.conditions[0]?.kind === "stage" ? value.conditions[0].value : ""}</output>
    </>
  );
}

describe("filter builder", () => {
  it("adds and removes conditions, saves a filter and reapplies it from the dropdown", () => {
    render(<Harness />, { wrapper });
    expect(screen.getByRole("option", { name: "No saved filters yet" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /add condition/i }));
    fireEvent.click(screen.getByRole("button", { name: /add condition/i }));
    expect(screen.getByTestId("conditions")).toHaveTextContent("2");
    expect(screen.getAllByText(/Not applied yet/)).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: /remove stage condition/i })[1]!);
    expect(screen.getByTestId("conditions")).toHaveTextContent("1");

    // Saving an incomplete condition is refused with a clear message.
    fireEvent.change(screen.getByLabelText("Filter name"), { target: { value: "Late stage" } });
    fireEvent.click(screen.getByRole("button", { name: /save as new/i }));
    expect(screen.getByRole("alert")).toHaveTextContent("Condition 1: Choose a stage.");

    fireEvent.change(screen.getByLabelText("Stage"), { target: { value: "Proposal" } });
    fireEvent.click(screen.getByRole("button", { name: /save as new/i }));
    expect(within(screen.getByLabelText("Saved filters")).getByRole("option", { name: "Late stage" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /clear conditions/i }));
    expect(screen.getByTestId("conditions")).toHaveTextContent("0");
    fireEvent.change(screen.getByLabelText("Saved filters"), { target: { value: screen.getByRole<HTMLOptionElement>("option", { name: "Late stage" }).value } });
    expect(screen.getByTestId("first-stage")).toHaveTextContent("Proposal");

    fireEvent.click(screen.getByRole("button", { name: /^delete/i }));
    expect(screen.getByRole("option", { name: "No saved filters yet" })).toBeInTheDocument();
  });
});
