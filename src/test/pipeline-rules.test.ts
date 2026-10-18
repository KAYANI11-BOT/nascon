import { describe, expect, it } from "vitest";

import { addPipeline, addStage, planStageDeletion, renameStage, reorderStage, statusForStage } from "@/components/leadguard/crm/pipeline-rules";
import type { PipelineConfig } from "@/types/domain";

const pipeline: PipelineConfig = {
  id: "p1",
  name: "Sales",
  isDefault: true,
  stages: [
    { id: "s1", name: "Discovery", type: "open", requiredFieldIds: [] },
    { id: "s2", name: "Proposal", type: "open", requiredFieldIds: [] },
    { id: "s3", name: "Won", type: "won", requiredFieldIds: [] },
  ],
  fields: [],
};
const names = (p: PipelineConfig) => p.stages.map((s) => s.name);

describe("pipeline rules", () => {
  it("adds a new open stage before closed stages", () => {
    const r = addStage(pipeline, "  Negotiation ", "s4");
    expect(r.ok && names(r.value)).toEqual(["Discovery", "Proposal", "Negotiation", "Won"]);
  });

  it("rejects empty and duplicate stage names", () => {
    expect(addStage(pipeline, "  ", "x").ok).toBe(false);
    expect(addStage(pipeline, "proposal", "x").ok).toBe(false);
  });

  it("renames a stage and reports the old and new names", () => {
    const r = renameStage(pipeline, "s2", "Quote");
    expect(r.ok && r.value.from).toBe("Proposal");
    expect(r.ok && names(r.value.pipeline)).toEqual(["Discovery", "Quote", "Won"]);
    expect(renameStage(pipeline, "s2", "won").ok).toBe(false);
  });

  it("reorders stages within bounds", () => {
    const r = reorderStage(pipeline, "s2", -1);
    expect(r.ok && names(r.value)).toEqual(["Proposal", "Discovery", "Won"]);
    expect(reorderStage(pipeline, "s1", -1).ok).toBe(false);
    expect(reorderStage(pipeline, "s3", 1).ok).toBe(false);
  });

  it("blocks deleting a stage that still has opportunities without a target", () => {
    const r = planStageDeletion(pipeline, "s2", 3);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/Move the 3 opportunities/);
    expect(planStageDeletion(pipeline, "s2", 3, "s2").ok).toBe(false);
  });

  it("deletes a non-empty stage once a target stage is chosen", () => {
    const r = planStageDeletion(pipeline, "s2", 3, "s3");
    expect(r.ok && r.value.moveTo?.name).toBe("Won");
    expect(r.ok && names(r.value.pipeline)).toEqual(["Discovery", "Won"]);
  });

  it("deletes an empty stage but never the last one", () => {
    expect(planStageDeletion(pipeline, "s1", 0).ok).toBe(true);
    expect(planStageDeletion({ ...pipeline, stages: [pipeline.stages[0]!] }, "s1", 0).ok).toBe(false);
  });

  it("creates pipelines with unique names and maps stage types to statuses", () => {
    expect(addPipeline([pipeline], "sales", "p2").ok).toBe(false);
    const r = addPipeline([pipeline], "Partnerships", "p2");
    expect(r.ok && names(r.value)).toEqual(["New", "Won", "Lost"]);
    expect([statusForStage("open"), statusForStage("won"), statusForStage("lost")]).toEqual(["Open", "Won", "Lost"]);
  });
});
