import { describe, expect, it } from "vitest";

import {
  activeConditions,
  conditionErrors,
  createSavedFilter,
  deleteSavedFilter,
  matchesFilter,
  maxConditions,
  updateSavedFilter,
  validateDefinition,
} from "@/components/leadguard/crm/filter-rules";
import type { OpportunityView } from "@/components/leadguard/crm/opportunity-data";
import type { FilterCondition, FilterDefinition, PipelineConfig } from "@/types/domain";

const pipelines: PipelineConfig[] = [
  {
    id: "sales", name: "Sales", isDefault: true,
    stages: [
      { id: "s1", name: "Discovery", type: "open", requiredFieldIds: [] },
      { id: "s2", name: "Proposal", type: "open", requiredFieldIds: [] },
      { id: "s3", name: "Won", type: "won", requiredFieldIds: [] },
    ],
    fields: [
      { id: "f1", key: "decision_maker", label: "Decision maker", type: "text", required: false },
      { id: "f2", key: "seats", label: "Seats", type: "number", required: false },
    ],
  },
  {
    id: "partners", name: "Partnerships", isDefault: false,
    stages: [
      { id: "p1", name: "Evaluation", type: "open", requiredFieldIds: [] },
      { id: "p2", name: "Live", type: "won", requiredFieldIds: [] },
    ],
    fields: [
      { id: "f3", key: "tier", label: "Partner tier", type: "select", options: ["Silver", "Gold"], required: false },
      { id: "f4", key: "signed", label: "Contract signed", type: "checkbox", required: false },
    ],
  },
];
const opp = (o: Partial<OpportunityView> & { id: string }): OpportunityView => ({
  title: o.id, contact: "", company: "", value: 100, currency: "USD", pipelineId: "sales", pipeline: "Sales",
  stage: "Discovery", owner: "Alex Morgan", status: "Open", closeDate: "", created: "2026-10-17", customFields: {}, ...o,
});
const rows: OpportunityView[] = [
  opp({ id: "a", stage: "Proposal", owner: "Alex Morgan", closeDate: "2026-11-05", customFields: { decision_maker: "Dana Cole", seats: "25" } }),
  opp({ id: "b", stage: "Proposal", owner: "Sarah Chen", closeDate: "2026-11-20", customFields: { decision_maker: "Lee Park", seats: "5" } }),
  opp({ id: "c", stage: "Discovery", owner: "Alex Morgan", closeDate: "2026-10-30" }),
  opp({ id: "d", pipelineId: "partners", pipeline: "Partnerships", stage: "Evaluation", owner: "Alex Morgan", closeDate: "2026-11-06", customFields: { tier: "Gold", signed: "true" } }),
  opp({ id: "e", pipelineId: "partners", pipeline: "Partnerships", stage: "Evaluation", owner: "Sarah Chen", customFields: { tier: "Silver" } }),
];
const ids = (def: FilterDefinition) => rows.filter((r) => matchesFilter(def, r)).map((r) => r.id);
type NoId = FilterCondition extends infer T ? (T extends unknown ? Omit<T, "id"> : never) : never;
let n = 0;
const cond = (c: NoId) => ({ ...c, id: `c${++n}` }) as FilterCondition;
const all = (...conditions: FilterCondition[]): FilterDefinition => ({ pipelineId: "all", conditions });

describe("filter matching", () => {
  it("combines three simultaneous filters with AND", () => {
    const def = all(
      cond({ kind: "stage", value: "Proposal" }),
      cond({ kind: "owner", value: "Alex Morgan" }),
      cond({ kind: "date", dateField: "closeDate", operator: "after", value: "2026-11-01" }),
    );
    expect(ids(def)).toEqual(["a"]);
    expect(ids(all(cond({ kind: "stage", value: "Proposal" })))).toEqual(["a", "b"]);
    expect(ids(all())).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("filters by date: before, after, on, between, and skips opportunities without the date", () => {
    const on = (operator: "before" | "after" | "on", value: string) => ids(all(cond({ kind: "date", dateField: "closeDate", operator, value })));
    expect(on("before", "2026-11-06")).toEqual(["a", "c"]);
    expect(on("after", "2026-11-06")).toEqual(["b"]);
    expect(on("on", "2026-11-06")).toEqual(["d"]);
    expect(ids(all(cond({ kind: "date", dateField: "closeDate", operator: "between", value: "2026-11-05", valueTo: "2026-11-20" })))).toEqual(["a", "b", "d"]);
    expect(ids(all(cond({ kind: "date", dateField: "created", operator: "on", value: "2026-10-17" })))).toHaveLength(5);
  });

  it("filters by custom field value for each field type", () => {
    const sales = (c: NoId): FilterDefinition => ({ pipelineId: "sales", conditions: [cond(c)] });
    expect(ids(sales({ kind: "custom", pipelineId: "sales", fieldKey: "decision_maker", operator: "contains", value: "cole" }))).toEqual(["a"]);
    expect(ids(sales({ kind: "custom", pipelineId: "sales", fieldKey: "seats", operator: "gt", value: "10" }))).toEqual(["a"]);
    expect(ids(sales({ kind: "custom", pipelineId: "sales", fieldKey: "seats", operator: "lt", value: "10" }))).toEqual(["b"]);
    expect(ids(all(cond({ kind: "custom", pipelineId: "partners", fieldKey: "tier", operator: "equals", value: "Gold" })))).toEqual(["d"]);
    expect(ids(all(cond({ kind: "custom", pipelineId: "partners", fieldKey: "signed", operator: "equals", value: "true" })))).toEqual(["d"]);
    // An unticked or never-set checkbox counts as "not checked".
    expect(ids(all(cond({ kind: "custom", pipelineId: "partners", fieldKey: "signed", operator: "equals", value: "false" })))).toEqual(["e"]);
  });

  it("keeps pipelines isolated", () => {
    expect(ids({ pipelineId: "partners", conditions: [] })).toEqual(["d", "e"]);
    expect(ids({ pipelineId: "sales", conditions: [cond({ kind: "owner", value: "Alex Morgan" })] })).toEqual(["a", "c"]);
    // A custom condition for one pipeline's field never matches another pipeline's opportunities, even with the same key.
    expect(ids(all(cond({ kind: "custom", pipelineId: "sales", fieldKey: "decision_maker", operator: "contains", value: "e" })))).toEqual(["a", "b"]);
  });
});

describe("filter validation", () => {
  const errs = (c: NoId, scope = "all") => conditionErrors(cond(c), scope, pipelines);

  it("rejects incomplete or unknown conditions", () => {
    expect(errs({ kind: "stage", value: "" })).toHaveLength(1);
    expect(errs({ kind: "stage", value: "Nonexistent" })[0]).toMatch(/not a stage of all pipelines/);
    expect(errs({ kind: "stage", value: "Evaluation" }, "sales")[0]).toMatch(/not a stage of Sales/);
    expect(errs({ kind: "owner", value: "  " })).toHaveLength(1);
  });

  it("rejects invalid dates and ranges", () => {
    expect(errs({ kind: "date", dateField: "closeDate", operator: "on", value: "31/12/2026" })).toEqual(["Enter a valid date."]);
    expect(errs({ kind: "date", dateField: "closeDate", operator: "between", value: "2026-11-10", valueTo: "2026-11-01" })[0]).toMatch(/end date must not be before/);
    expect(errs({ kind: "date", dateField: "closeDate", operator: "between", value: "2026-11-10" })[0]).toMatch(/end date/);
  });

  it("rejects invalid custom field conditions", () => {
    expect(errs({ kind: "custom", pipelineId: "ghost", fieldKey: "x", operator: "equals", value: "1" })[0]).toMatch(/Choose a pipeline/);
    expect(errs({ kind: "custom", pipelineId: "sales", fieldKey: "missing", operator: "equals", value: "1" })[0]).toMatch(/Choose a Sales field/);
    expect(errs({ kind: "custom", pipelineId: "sales", fieldKey: "seats", operator: "contains", value: "1" })[0]).toMatch(/cannot be filtered/);
    expect(errs({ kind: "custom", pipelineId: "sales", fieldKey: "seats", operator: "gt", value: "many" })[0]).toMatch(/must be a number/);
    expect(errs({ kind: "custom", pipelineId: "partners", fieldKey: "tier", operator: "equals", value: "Bronze" })[0]).toMatch(/must be one of: Silver, Gold/);
    expect(errs({ kind: "custom", pipelineId: "partners", fieldKey: "signed", operator: "equals", value: "maybe" })[0]).toMatch(/checked or unchecked/);
    expect(errs({ kind: "custom", pipelineId: "sales", fieldKey: "seats", operator: "gt", value: "" })[0]).toMatch(/Enter a value/);
  });

  it("refuses another pipeline's field in a pipeline-limited filter", () => {
    const e = errs({ kind: "custom", pipelineId: "partners", fieldKey: "tier", operator: "equals", value: "Gold" }, "sales");
    expect(e[0]).toMatch(/Partnerships fields cannot be used in a filter limited to Sales/);
  });

  it("validates whole definitions", () => {
    expect(validateDefinition(all(), pipelines)[0]).toMatch(/at least one condition/);
    expect(validateDefinition({ pipelineId: "ghost", conditions: [cond({ kind: "owner", value: "Alex Morgan" })] }, pipelines)[0]).toMatch(/no longer exists/);
    const tooMany = all(...Array.from({ length: maxConditions + 1 }, () => cond({ kind: "owner", value: "Alex Morgan" })));
    expect(validateDefinition(tooMany, pipelines)[0]).toMatch(/at most/);
    const mixed = all(cond({ kind: "owner", value: "Alex Morgan" }), cond({ kind: "stage", value: "" }));
    expect(validateDefinition(mixed, pipelines)).toEqual(["Condition 2: Choose a stage."]);
    expect(activeConditions(mixed, pipelines)).toHaveLength(1);
  });
});

describe("saved filter list operations", () => {
  const def = all(cond({ kind: "stage", value: "Proposal" }), cond({ kind: "owner", value: "Alex Morgan" }), cond({ kind: "date", dateField: "closeDate", operator: "after", value: "2026-11-01" }));

  it('keeps saved stage criteria attached to IDs after rename and rejects a reused label', () => {
    const saved = createSavedFilter([], 'Stable', {pipelineId:'sales',conditions:[cond({kind:'stage',value:'Proposal'})]}, pipelines, 'sf-stable');
    if (!saved.ok) throw new Error(saved.error);
    const filter = saved.value[0]!;
    expect(filter.conditions[0]).toMatchObject({stageIds:['s2']});
    const renamed = pipelines.map(p=>({...p,stages:p.stages.map(s=>s.id==='s2'?{...s,name:'Review'}:s)}));
    expect(validateDefinition(filter,renamed)).toEqual([]);
    expect(matchesFilter(filter,opp({id:'original',stageId:'s2',stage:'Review'}))).toBe(true);
    expect(matchesFilter(filter,opp({id:'reused-name',stageId:'s-new',stage:'Proposal'}))).toBe(false);
    const deleted = renamed.map(p=>({...p,stages:p.stages.filter(s=>s.id!=='s2')}));
    expect(validateDefinition(filter,deleted)).not.toEqual([]);
    expect(activeConditions(filter,deleted)).toHaveLength(1);
    expect(matchesFilter({...filter,conditions:activeConditions(filter,deleted)},opp({id:'unrelated',stageId:'s-new',stage:'Proposal'}))).toBe(false);
  });

  it("creates, edits and deletes a saved filter", () => {
    const created = createSavedFilter([], "  Hot proposals ", def, pipelines, "sf1");
    if (!created.ok) throw new Error(created.error);
    expect(created.value).toMatchObject([{ id: "sf1", name: "Hot proposals", pipelineId: "all" }]);
    expect(created.value[0]!.conditions).toHaveLength(3);

    const edited = updateSavedFilter(created.value, "sf1", "Alex proposals", all(cond({ kind: "stage", value: "Proposal" })), pipelines);
    expect(edited.ok && edited.value[0]).toMatchObject({ name: "Alex proposals" });
    expect(edited.ok && edited.value[0]!.conditions).toHaveLength(1);

    const removed = deleteSavedFilter(created.value, "sf1");
    expect(removed.ok && removed.value).toEqual([]);
    expect(deleteSavedFilter([], "sf1").ok).toBe(false);
  });

  it("rejects blank, duplicate and invalid saves without changing the list", () => {
    const base = createSavedFilter([], "Hot", def, pipelines, "sf1");
    if (!base.ok) throw new Error(base.error);
    expect(createSavedFilter(base.value, "  ", def, pipelines, "sf2").ok).toBe(false);
    expect(createSavedFilter(base.value, "hot", def, pipelines, "sf2").ok).toBe(false);
    expect(createSavedFilter(base.value, "Other", all(), pipelines, "sf2").ok).toBe(false);
    expect(createSavedFilter(base.value, "Other", all(cond({ kind: "stage", value: "Nope" })), pipelines, "sf2").ok).toBe(false);
    expect(updateSavedFilter(base.value, "missing", "X", def, pipelines).ok).toBe(false);
    // Renaming a filter to its own name is fine.
    expect(updateSavedFilter(base.value, "sf1", "Hot", def, pipelines).ok).toBe(true);
  });
});
