import { describe, expect, it } from "vitest";

import {
  addField,
  describeMissing,
  missingForStage,
  removeField,
  setStageRequirement,
  updateField,
  valueErrors,
  type FieldDraft,
} from "@/components/leadguard/crm/custom-field-rules";
import type { CustomFieldType, PipelineConfig } from "@/types/domain";

const base: PipelineConfig = {
  id: "p1",
  name: "Sales",
  isDefault: true,
  stages: [
    { id: "s1", name: "Discovery", type: "open", requiredFieldIds: [] },
    { id: "s2", name: "Proposal", type: "open", requiredFieldIds: [] },
  ],
  fields: [],
};
const draft = (label: string, type: CustomFieldType, extra: Partial<FieldDraft> = {}): FieldDraft => ({ label, type, options: [], required: false, ...extra });
function withField(p: PipelineConfig, d: FieldDraft, id: string) {
  const r = addField(p, d, id);
  if (!r.ok) throw new Error(r.error);
  return r.value.pipeline;
}

describe("custom field rules", () => {
  it.each<[CustomFieldType, string[]]>([
    ["text", []],
    ["number", []],
    ["date", []],
    ["select", ["Small", "Large"]],
    ["checkbox", []],
  ])("creates a %s field with a stable key", (type, options) => {
    const r = addField(base, draft("Budget Owner", type, { options }), "f1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.field).toMatchObject({ key: "budget_owner", type, required: false });
    expect(r.value.field.options).toEqual(type === "select" ? options : undefined);
  });

  it("rejects blank labels, duplicate labels and dropdowns without valid options", () => {
    const p = withField(base, draft("Budget", "number"), "f1");
    expect(addField(p, draft("  ", "text"), "f2").ok).toBe(false);
    expect(addField(p, draft("budget", "text"), "f2").ok).toBe(false);
    expect(addField(p, draft("Tier", "select"), "f2").ok).toBe(false);
    expect(addField(p, draft("Tier", "select", { options: ["Gold", "gold"] }), "f2").ok).toBe(false);
  });

  it("updates dropdown options but refuses to drop an option still in use", () => {
    const p = withField(base, draft("Tier", "select", { options: ["Silver", "Gold"] }), "f1");
    const renamed = updateField(p, "f1", { label: "Partner tier", options: ["Silver", "Gold", "Platinum"], required: true }, ["Gold"]);
    expect(renamed.ok && renamed.value.fields[0]).toMatchObject({ label: "Partner tier", options: ["Silver", "Gold", "Platinum"], required: true, type: "select", key: "tier" });
    const blocked = updateField(p, "f1", { label: "Tier", options: ["Silver"], required: false }, ["Gold"]);
    expect(!blocked.ok && blocked.error).toMatch(/“Gold” is still used/);
  });

  it("reports missing values for always-required and stage-required fields", () => {
    let p = withField(base, draft("Decision maker", "text", { required: true }), "f1");
    p = withField(p, draft("Signed", "checkbox"), "f2");
    const r = setStageRequirement(p, "s2", "f2", true);
    if (!r.ok) throw new Error(r.error);
    p = r.value;
    expect(missingForStage(p, "Discovery", {}).map((f) => f.label)).toEqual(["Decision maker"]);
    expect(missingForStage(p, "Proposal", { decision_maker: "Ana" }).map((f) => f.label)).toEqual(["Signed"]);
    expect(missingForStage(p, "Proposal", { decision_maker: "Ana", signed: "true" })).toEqual([]);
    expect(describeMissing("Proposal", missingForStage(p, "Proposal", {}))).toBe("“Proposal” requires: Decision maker, Signed.");
  });

  it("validates value types for number, date and dropdown fields", () => {
    let p = withField(base, draft("Seats", "number"), "f1");
    p = withField(p, draft("Kickoff", "date"), "f2");
    p = withField(p, draft("Tier", "select", { options: ["Gold"] }), "f3");
    expect(valueErrors(p, { seats: "ten", kickoff: "31/12/2026", tier: "Bronze" })).toHaveLength(3);
    expect(valueErrors(p, { seats: "10", kickoff: "2026-12-31", tier: "Gold" })).toEqual([]);
  });

  it("removes a field and its stage requirements", () => {
    let p = withField(base, draft("Signed", "checkbox"), "f1");
    const r = setStageRequirement(p, "s2", "f1", true);
    if (!r.ok) throw new Error(r.error);
    const removed = removeField(r.value, "f1");
    expect(removed.ok && removed.value.fields).toEqual([]);
    expect(removed.ok && removed.value.stages[1]!.requiredFieldIds).toEqual([]);
    p = base;
    expect(removeField(p, "missing").ok).toBe(false);
  });
});
