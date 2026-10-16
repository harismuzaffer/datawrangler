import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv";
import {
  addStep,
  buildPreview,
  describeRun,
  emptyPipeline,
  moveStep,
  PipelineError,
  removeStep,
  runPipeline,
  runSteps,
  safePipeline,
  updateStep,
  validateStep,
  type Pipeline
} from "./pipeline";
import { profileCsv } from "./profile";
import { tableFromRecords } from "./table";

function build(...steps: [string, unknown][]): Pipeline {
  return steps.reduce(
    (p, [op, params]) => addStep(p, op, params).pipeline,
    emptyPipeline()
  );
}

const ids = (p: Pipeline) => p.steps.map((s) => s.id);

const sample = () =>
  tableFromRecords([
    ["name", "city", "amount"],
    [" Ann ", "Paris", "$1,200"],
    ["Bob", "paris", "300"],
    ["", "", ""],
    ["Bob", "paris", "300"]
  ]);

describe("validateStep", () => {
  it("fills in defaults", () => {
    expect(validateStep("normalizeNumbers", { columns: ["a"] }).params).toEqual(
      { columns: ["a"], decimalSeparator: "." }
    );
  });

  it("refuses unknown transforms, bad parameters, and unknown parameters, with usage help", () => {
    expect(() => validateStep("explode", {})).toThrow(
      /Unknown transform "explode"/
    );
    expect(() => validateStep("trim", { column: ["a"] })).toThrow(
      PipelineError
    );
    expect(() => validateStep("round", { columns: ["a"], decimal: 2 })).toThrow(
      /Unknown parameters for round: decimal[\s\S]*Usage: round/
    );
  });
});

describe("editing", () => {
  it("adds steps at the end or at a position, with IDs that are never reused", () => {
    let p = build(["trim", { columns: "*" }], ["dropEmptyRows", {}]);
    p = removeStep(p, "s2");
    p = addStep(p, "dedupe", {}, 1).pipeline;
    expect(ids(p)).toEqual(["s3", "s1"]);
  });

  it("refuses bad positions and unknown step IDs", () => {
    const p = build(["trim", { columns: "*" }]);
    expect(() => addStep(p, "dropEmptyRows", {}, 3)).toThrow(/from 1 to 2/);
    expect(() => removeStep(p, "s9")).toThrow(/Steps are: s1/);
  });

  it("merges updates into the parameters, removes keys set to null, and clears the automatic flag", () => {
    let p = addStep(
      emptyPipeline(),
      "round",
      { columns: ["a"], decimals: 2 },
      undefined,
      { auto: true }
    ).pipeline;
    p = updateStep(p, "s1", { mode: "floor" });
    expect(p.steps[0]).toEqual({
      id: "s1",
      op: "round",
      params: { columns: ["a"], mode: "floor", decimals: 2 }
    });
    p = updateStep(p, "s1", { decimals: null });
    expect(p.steps[0].params.decimals).toBe(0);
    expect(() => updateStep(p, "s1", { mode: "sideways" })).toThrow(
      PipelineError
    );
  });

  it("moves steps", () => {
    const p = build(
      ["trim", { columns: "*" }],
      ["dropEmptyRows", {}],
      ["dedupe", {}]
    );
    expect(ids(moveStep(p, "s3", 1))).toEqual(["s3", "s1", "s2"]);
    expect(ids(moveStep(p, "s1", 3))).toEqual(["s2", "s3", "s1"]);
    expect(() => moveStep(p, "s1", 4)).toThrow(/from 1 to 3/);
  });

  it("does not change the original pipeline", () => {
    const p = build(["trim", { columns: "*" }]);
    addStep(p, "dedupe", {});
    removeStep(p, "s1");
    expect(ids(p)).toEqual(["s1"]);
  });
});

describe("runSteps", () => {
  it("runs steps in order without changing the input table", () => {
    const input = sample();
    const p = build(
      ["trim", { columns: ["name"] }],
      ["dropEmptyRows", {}],
      ["dedupe", {}]
    );
    const { table, runs } = runSteps(input, p.steps);
    expect(table.rows.length).toBe(2);
    expect(runs.map((r) => r.status)).toEqual(["ok", "ok", "ok"]);
    expect(input.rows[0][0]).toBe(" Ann ");
  });

  it("stops at a failing step and skips the rest", () => {
    const p = build(
      ["renameColumn", { column: "city", to: "town" }],
      ["trim", { columns: ["city"] }],
      ["dedupe", {}]
    );
    const { runs } = runSteps(sample(), p.steps);
    expect(runs.map((r) => r.status)).toEqual(["ok", "error", "skipped"]);
    expect(runs[1].error).toMatch(/no column "city"/);
  });

  it("runs only up to a step", () => {
    const p = build(["trim", { columns: "*" }], ["dropEmptyRows", {}]);
    expect(runSteps(sample(), p.steps, "s1").runs.length).toBe(1);
  });

  it("describes what each step did", () => {
    const p = build(
      ["normalizeNumbers", { columns: ["amount"] }],
      ["dropEmptyRows", {}],
      ["renameColumn", { column: "city", to: "town" }]
    );
    const { runs } = runSteps(
      tableFromRecords([
        ["name", "city", "amount"],
        ["a", "b", "$1,200"],
        ["", "", ""],
        ["c", "d", "x"]
      ]),
      p.steps
    );
    expect(runs.map(describeRun)).toEqual([
      "Changed 1 cell, could not convert 1 cell.",
      "Removed 1 row.",
      "Renamed city to town."
    ]);
  });
});

describe("runPipeline", () => {
  it("runs every step and reports the result size and what each step did", () => {
    const p = build(
      ["trim", { columns: ["name"] }],
      ["dropEmptyRows", {}],
      ["dedupe", {}]
    );
    const { table, report } = runPipeline(sample(), p.steps);
    expect(table.rows).toEqual([
      ["Ann", "Paris", "$1,200"],
      ["Bob", "paris", "300"]
    ]);
    expect(report).toEqual({
      rowCount: 2,
      columnCount: 3,
      steps: [
        { id: "s1", op: "trim", summary: "Changed 1 cell." },
        { id: "s2", op: "dropEmptyRows", summary: "Removed 1 row." },
        { id: "s3", op: "dedupe", summary: "Removed 1 row." }
      ]
    });
  });

  it("refuses to give a result when a step fails", () => {
    const p = build(
      ["renameColumn", { column: "city", to: "town" }],
      ["trim", { columns: ["city"] }]
    );
    expect(() => runPipeline(sample(), p.steps)).toThrow(
      /Step s2 \(trim\) failed on the whole file: .*no column "city"/
    );
  });
});

describe("buildPreview", () => {
  it("summarizes steps, marks whole-file steps on a partial sample, and shows result rows", () => {
    const p = build(["trim", { columns: ["name"] }], ["dedupe", {}]);
    const preview = buildPreview(sample(), p.steps, { partial: true, rows: 2 });
    expect(preview.steps[0]).toMatchObject({
      id: "s1",
      summary: "Changed 1 cell.",
      examples: [{ row: 2, before: " Ann ", after: "Ann" }]
    });
    expect(preview.steps[1]).toMatchObject({
      id: "s2",
      summary: "Removed 1 row.",
      sampleOnly: true
    });
    expect(preview.rowCount).toBe(3);
    expect(preview.rows).toEqual([
      ["Ann", "Paris", "$1,200"],
      ["Bob", "paris", "300"]
    ]);
  });

  it("does not mark whole-file steps when the sample is the whole file", () => {
    const preview = buildPreview(sample(), build(["dedupe", {}]).steps, {
      partial: false
    });
    expect(preview.steps[0]).not.toHaveProperty("sampleOnly");
  });
});

describe("safePipeline", () => {
  it("adds the safe steps the profile calls for, in a fixed order, for the affected columns", () => {
    const csv =
      "name,city,note\n Ann ,Paris,ok\nBob,Ro\u{200B}me,two  spaces\n,,\n";
    const p = safePipeline(
      profileCsv(parseCsv(csv), { encoding: "utf-8", hadBom: false })
    );
    expect(p.steps.map((s) => [s.op, s.params, s.auto])).toEqual([
      ["removeInvisible", { columns: ["city"] }, true],
      ["trim", { columns: ["name"] }, true],
      ["collapseSpaces", { columns: ["note"] }, true],
      ["dropEmptyRows", {}, true]
    ]);
  });

  it("adds nothing for a clean file", () => {
    expect(
      safePipeline(
        profileCsv(parseCsv("a,b\n1,2\n"), { encoding: "utf-8", hadBom: false })
      ).steps
    ).toEqual([]);
  });
});
