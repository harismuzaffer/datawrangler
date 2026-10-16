import { asSchema } from "ai";
import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv";
import { emptyPipeline, safePipeline, type Pipeline } from "./pipeline";
import { profileCsv, type DatasetProfile } from "./profile";
import { TOOL_SPECS } from "./prompts";
import { tableFromRecords } from "./table";
import type { RunSummary } from "./server";
import { createTools, type ToolHost } from "./tools";

const CSV = "name,city,amount\n Ann ,Paris,$1\nBob,paris,2\n,,\n";

function fakeHost(
  options: { status?: string; profile?: DatasetProfile | null } = {}
) {
  const records = parseCsv(CSV).rows;
  const profile =
    options.profile === undefined
      ? profileCsv(parseCsv(CSV), { encoding: "utf-8", hadBom: false })
      : options.profile;
  let saved: Pipeline = profile ? safePipeline(profile) : emptyPipeline();
  let saves = 0;
  const runs: RunSummary[] = [];
  const host: ToolHost = {
    latestDataset: () => ({
      id: "d1",
      name: "people.csv",
      status: options.status ?? "ready",
      error: null,
      profile
    }),
    loadPipeline: () => saved,
    savePipeline: (_, pipeline) => {
      saved = pipeline;
      saves++;
    },
    // Async like the real host, which reads R2.
    loadSample: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { table: tableFromRecords(records), partial: false };
    },
    startRun: async () => {
      const version = runs.length + 1;
      runs.push({
        id: `r${version}`,
        version,
        status: "running",
        error: null,
        rowCount: null,
        columnCount: null
      });
      return { runId: `r${version}`, version };
    },
    latestRun: () => runs.at(-1) ?? null
  };
  return { host, pipeline: () => saved, saves: () => saves, runs };
}

type Tools = ReturnType<typeof createTools>;

// Calls a tool's execute function the way the AI SDK does, after input validation.
async function call<K extends keyof Tools>(
  tools: Tools,
  name: K,
  input: unknown
): Promise<Record<string, unknown>> {
  const parsed = TOOL_SPECS[name].inputSchema.parse(input);
  const execute = tools[name].execute as unknown as (
    input: unknown,
    options: unknown
  ) => Promise<Record<string, unknown>>;
  return execute(parsed, { toolCallId: "t1", messages: [] });
}

describe("tool input schemas", () => {
  it("accepts valid input and refuses unknown transforms and bad positions", () => {
    expect(
      TOOL_SPECS.addStep.inputSchema.parse({
        op: "trim",
        params: { columns: "*" }
      })
    ).toMatchObject({ op: "trim" });
    expect(
      TOOL_SPECS.addStep.inputSchema.parse({ op: "dropEmptyRows" }).params
    ).toEqual({});
    expect(
      TOOL_SPECS.addStep.inputSchema.safeParse({ op: "rm -rf", params: {} })
        .success
    ).toBe(false);
    expect(
      TOOL_SPECS.moveStep.inputSchema.safeParse({ stepId: "s1", position: 0 })
        .success
    ).toBe(false);
    expect(
      TOOL_SPECS.updateStep.inputSchema.safeParse({ stepId: "s1" }).success
    ).toBe(false);
  });
});

describe("pipeline tools", () => {
  it("explain why they cannot work before a file is ready", async () => {
    expect(
      await call(
        createTools(fakeHost({ status: "profiling", profile: null }).host),
        "addStep",
        { op: "dedupe" }
      )
    ).toEqual({
      error: "The file is still being read. Try again in a moment."
    });
  });

  it("start from the safe steps and show them in getProfile", async () => {
    const result = await call(createTools(fakeHost().host), "getProfile", {});
    expect(result.pipeline).toEqual([
      { id: "s1", op: "trim", params: { columns: ["name"] }, auto: true },
      { id: "s2", op: "dropEmptyRows", params: {}, auto: true }
    ]);
  });

  it("add a step, report what it did, and save it", async () => {
    const fake = fakeHost();
    const result = await call(createTools(fake.host), "addStep", {
      op: "changeCase",
      params: { columns: ["city"], case: "title" }
    });
    expect(result).toMatchObject({
      saved: true,
      step: { id: "s3", summary: "Changed 1 cell." }
    });
    expect(fake.pipeline().steps.map((s) => s.op)).toEqual([
      "trim",
      "dropEmptyRows",
      "changeCase"
    ]);
  });

  it("refuse invalid parameters without saving", async () => {
    const fake = fakeHost();
    const result = await call(createTools(fake.host), "addStep", {
      op: "changeCase",
      params: { columns: ["city"] }
    });
    expect(result.error).toMatch(/Invalid parameters for changeCase/);
    expect(fake.saves()).toBe(0);
  });

  it("refuse a step that fails on the sample, such as an unknown column", async () => {
    const fake = fakeHost();
    const result = await call(createTools(fake.host), "addStep", {
      op: "trim",
      params: { columns: ["town"] }
    });
    expect(result.error).toMatch(/not saved[\s\S]*no column "town"/);
    expect(fake.saves()).toBe(0);
  });

  it("keep both steps when two are added in parallel", async () => {
    const fake = fakeHost();
    const tools = createTools(fake.host);
    await Promise.all([
      call(tools, "addStep", { op: "dedupe" }),
      call(tools, "addStep", {
        op: "normalizeNumbers",
        params: { columns: ["amount"] }
      })
    ]);
    expect(fake.pipeline().steps.map((s) => s.id)).toEqual([
      "s1",
      "s2",
      "s3",
      "s4"
    ]);
  });

  it("warn when a removal or move makes another step fail", async () => {
    const fake = fakeHost();
    const tools = createTools(fake.host);
    await call(tools, "addStep", {
      op: "renameColumn",
      params: { column: "city", to: "town" }
    });
    await call(tools, "addStep", { op: "trim", params: { columns: ["town"] } });
    const result = await call(tools, "removeStep", { stepId: "s3" });
    expect(result).toMatchObject({
      saved: true,
      warning: expect.stringMatching(/s4: Failed/)
    });
    expect(
      (await call(tools, "moveStep", { stepId: "s9", position: 1 })).error
    ).toMatch(/no step "s9"/);
  });

  it("update a step by merging parameters", async () => {
    const fake = fakeHost();
    await call(createTools(fake.host), "updateStep", {
      stepId: "s1",
      params: { columns: "*" }
    });
    expect(fake.pipeline().steps[0]).toEqual({
      id: "s1",
      op: "trim",
      params: { columns: "*" }
    });
  });

  it("preview the result rows, up to a step if asked", async () => {
    const tools = createTools(fakeHost().host);
    const full = await call(tools, "previewPipeline", {});
    expect(full).toMatchObject({
      rowCount: 2,
      rows: [
        ["Ann", "Paris", "$1"],
        ["Bob", "paris", "2"]
      ]
    });
    expect(
      (
        (await call(tools, "previewPipeline", { upToStepId: "s1" }))
          .steps as unknown[]
      ).length
    ).toBe(1);
    expect(
      (await call(tools, "previewPipeline", { upToStepId: "s7" })).error
    ).toMatch(/no step/);
  });
});

describe("runPipeline", () => {
  it("needs the user's approval", () => {
    expect(createTools(fakeHost().host).runPipeline.needsApproval).toBe(true);
  });

  it("starts a run and shows it in getProfile", async () => {
    const fake = fakeHost();
    const tools = createTools(fake.host);
    expect(await call(tools, "runPipeline", {})).toMatchObject({
      started: true,
      version: 1
    });
    expect(await call(tools, "getProfile", {})).toMatchObject({
      latestRun: { version: 1, status: "running" }
    });
  });

  it("does not start when a step fails on the preview rows", async () => {
    const fake = fakeHost();
    const tools = createTools(fake.host);
    await call(tools, "addStep", {
      op: "renameColumn",
      params: { column: "city", to: "town" }
    });
    await call(tools, "addStep", {
      op: "changeCase",
      params: { columns: ["town"], case: "upper" }
    });
    // Removing the rename is saved, with a warning, and leaves s4 pointing at a missing column.
    await call(tools, "removeStep", { stepId: "s3" });
    expect(await call(tools, "runPipeline", {})).toMatchObject({
      error: expect.stringMatching(/did not start\. Step s4 fails/)
    });
    expect(fake.runs).toEqual([]);
  });
});

describe("position input", () => {
  it("accepts a position sent as a numeric string", () => {
    expect(
      TOOL_SPECS.moveStep.inputSchema.parse({ stepId: "s1", position: "2" })
        .position
    ).toBe(2);
    expect(
      TOOL_SPECS.moveStep.inputSchema.safeParse({
        stepId: "s1",
        position: "first"
      }).success
    ).toBe(false);
  });
});

describe("tool schemas sent to the model", () => {
  it("leave params open, so the model may send any parameter names", async () => {
    const tools = createTools(fakeHost().host);
    const schema = (await asSchema(tools.addStep.inputSchema).jsonSchema) as {
      properties: { params: { additionalProperties?: unknown } };
    };
    expect(schema.properties.params.additionalProperties).not.toBe(false);
  });

  it("still validate input with zod", async () => {
    const tools = createTools(fakeHost().host);
    const result = await asSchema(tools.moveStep.inputSchema).validate?.({
      stepId: "s1",
      position: "2"
    });
    expect(result).toEqual({
      success: true,
      value: { stepId: "s1", position: 2 }
    });
    expect(
      (
        await asSchema(tools.moveStep.inputSchema).validate?.({
          stepId: "s1",
          position: 0
        })
      )?.success
    ).toBe(false);
  });
});
