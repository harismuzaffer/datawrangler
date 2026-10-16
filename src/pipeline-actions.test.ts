import { describe, expect, it } from "vitest";
import { addStep, emptyPipeline } from "./pipeline";
import { applyEdit, pipelineEditSchema } from "./pipeline-actions";

describe("pipelineEditSchema", () => {
  it("accepts each kind of edit and refuses unknown kinds and bad shapes", () => {
    for (const edit of [
      { type: "add", op: "trim", params: { columns: "*" } },
      { type: "update", stepId: "s1", params: { mode: null } },
      { type: "replace", stepId: "s1", params: {} },
      { type: "remove", stepId: "s1" },
      { type: "move", stepId: "s1", position: 2 }
    ])
      expect(pipelineEditSchema.safeParse(edit).success).toBe(true);
    for (const edit of [
      { type: "run" },
      { type: "add", op: "trim", params: "columns=*" },
      { type: "move", stepId: "s1", position: "2" },
      { type: "remove", stepId: "x".repeat(100) }
    ])
      expect(pipelineEditSchema.safeParse(edit).success).toBe(false);
  });
});

describe("applyEdit", () => {
  it("replaces all parameters, so options left out of an edit form go back to their defaults", () => {
    const pipeline = addStep(emptyPipeline(), "round", {
      columns: ["a"],
      decimals: 2,
      mode: "floor"
    }).pipeline;
    const { pipeline: next, checkStepId } = applyEdit(pipeline, {
      type: "replace",
      stepId: "s1",
      params: { columns: ["b"] }
    });
    expect(next.steps[0].params).toEqual({
      columns: ["b"],
      decimals: 0,
      mode: "round"
    });
    expect(checkStepId).toBe("s1");
  });
});
