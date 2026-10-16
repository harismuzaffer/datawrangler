import { describe, expect, it } from "vitest";
import { addStep, emptyPipeline } from "./pipeline";
import {
  applyColumnMapping,
  exportPipeline,
  findMissingColumns,
  parsePipelineFile,
  pipelineFromSteps,
  PipelineFileError
} from "./pipeline-file";

describe("export and parse", () => {
  it("reads back what it exports, without step IDs", () => {
    const { pipeline } = addStep(emptyPipeline(), "trim", { columns: "*" });
    const text = JSON.stringify(exportPipeline(pipeline.steps, "sales.csv"));
    expect(parsePipelineFile(text)).toEqual({
      source: "sales.csv",
      steps: [{ op: "trim", params: { columns: "*" } }]
    });
  });

  it("refuses files that are not pipelines, wrong versions, and oversized files", () => {
    expect(() => parsePipelineFile("{nope")).toThrow("not valid JSON");
    expect(() => parsePipelineFile('{"steps": []}')).toThrow(
      "not a DataCobbler pipeline"
    );
    expect(() =>
      parsePipelineFile(
        '{"format": "datacobbler-pipeline", "version": 2, "steps": []}'
      )
    ).toThrow(PipelineFileError);
    expect(() => parsePipelineFile(" ".repeat(300 * 1024) + "{}")).toThrow(
      "too large"
    );
  });
});

describe("findMissingColumns", () => {
  it("lists columns the file lacks once, and counts columns made by earlier steps as present", () => {
    const steps = [
      { op: "trim", params: { columns: ["Name", "email"] } },
      { op: "renameColumn", params: { column: "town", to: "city" } },
      { op: "changeCase", params: { columns: ["city"], case: "title" } },
      {
        op: "runningTotal",
        params: {
          column: "amount",
          into: "total",
          groupBy: ["region"],
          orderBy: { column: "date" }
        }
      },
      { op: "round", params: { columns: ["total", "email"] } }
    ];
    expect(findMissingColumns(steps, ["name", "town", "amount"])).toEqual([
      "email",
      "region",
      "date"
    ]);
  });
});

describe("applyColumnMapping", () => {
  it("renames mapped columns and removes dropped ones, dropping steps left with nothing to do", () => {
    const steps = [
      { op: "trim", params: { columns: ["email", "name"] } },
      { op: "trim", params: { columns: ["email"] } },
      { op: "renameColumn", params: { column: "email", to: "mail" } },
      {
        op: "runningTotal",
        params: {
          column: "amount",
          into: "total",
          groupBy: ["region"],
          orderBy: { column: "date", direction: "asc" }
        }
      }
    ];
    expect(
      applyColumnMapping(steps, { email: null, region: null, date: "day" })
    ).toEqual([
      { op: "trim", params: { columns: ["name"] } },
      {
        op: "runningTotal",
        params: {
          column: "amount",
          into: "total",
          orderBy: { column: "day", direction: "asc" }
        }
      }
    ]);
  });
});

describe("pipelineFromSteps", () => {
  it("gives new step IDs and names the step that is invalid", () => {
    expect(
      pipelineFromSteps([
        { op: "trim", params: { columns: "*" } },
        { op: "dedupe", params: {} }
      ]).steps.map((s) => s.id)
    ).toEqual(["s1", "s2"]);
    expect(
      pipelineFromSteps([{ op: "dedupe", params: {} }], 7).steps[0].id
    ).toBe("s7");
    expect(() =>
      pipelineFromSteps([
        { op: "trim", params: { columns: "*" } },
        { op: "explode", params: {} }
      ])
    ).toThrow(/^Step 2: Unknown transform "explode"/);
  });
});
