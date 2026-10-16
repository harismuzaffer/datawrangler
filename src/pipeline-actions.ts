import { z } from "zod";
import {
  addStep,
  buildPreview,
  moveStep,
  removeStep,
  updateStep,
  PipelineError,
  type Pipeline,
  type Preview,
  type Step
} from "./pipeline";
import {
  applyColumnMapping,
  findMissingColumns,
  pipelineFromSteps,
  type FileStep
} from "./pipeline-file";
import type { DatasetProfile } from "./profile";
import type { RunSummary } from "./server";
import type { Table } from "./table";
import { TRANSFORMS, type TransformName } from "./transforms";

export interface DatasetInfo {
  id: string;
  name: string;
  status: string;
  error: string | null;
  profile: DatasetProfile | null;
}

/** What pipeline edits, previews, and runs need from the agent. Kept small so they can be tested without a Durable Object. */
export interface PipelineHost {
  /** The latest upload and its profile, or null if there is none. */
  latestDataset(): DatasetInfo | null;
  dataset(id: string): DatasetInfo | null;
  loadPipeline(datasetId: string): Pipeline;
  savePipeline(datasetId: string, pipeline: Pipeline): void;
  /** The first rows of the file. `partial` is true when the file has more rows than the sample. */
  loadSample(
    datasetId: string,
    profile: DatasetProfile
  ): Promise<{ table: Table; partial: boolean }>;
  /** Starts a full run of the dataset's pipeline in a workflow, or explains why it cannot start. */
  startRun(
    datasetId: string
  ): Promise<{ runId: string; version: number } | { error: string }>;
  latestRun(datasetId: string): RunSummary | null;
  /** Earlier uploads that have pipeline steps, newest first, for reuse. */
  earlierPipelines(
    exceptDatasetId: string
  ): { datasetId: string; name: string; steps: Step[] }[];
}

export type ReadyDataset = {
  id: string;
  name: string;
  profile: DatasetProfile;
};

/** Returns the dataset if its profile is ready, or a message explaining why not. */
export function readyDataset(
  dataset: DatasetInfo | null
): ReadyDataset | { error: string } {
  if (!dataset)
    return {
      error: "No file has been uploaded yet. Ask the user to upload a CSV."
    };
  if (dataset.status === "profiling")
    return { error: "The file is still being read. Try again in a moment." };
  if (!dataset.profile)
    return {
      error: `The file could not be read: ${dataset.error ?? "unknown error"}`
    };
  return { id: dataset.id, name: dataset.name, profile: dataset.profile };
}

const stepId = z.string().max(20);
const params = z.record(z.string(), z.unknown());

/** One change to a pipeline. Positions are 1-based. Comes from the LLM tools or straight from the browser, so it is validated. */
export const pipelineEditSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add"),
    op: z.string().max(50),
    params,
    position: z.number().int().optional()
  }),
  // Merges into the old parameters; null removes one.
  z.object({ type: z.literal("update"), stepId, params }),
  // Replaces all parameters, as an edit form does.
  z.object({ type: z.literal("replace"), stepId, params }),
  z.object({ type: z.literal("remove"), stepId }),
  z.object({ type: z.literal("move"), stepId, position: z.number().int() })
]);

export type PipelineEdit = z.infer<typeof pipelineEditSchema>;

/**
 * Applies one edit and says which step must still work on the sample for the edit to be kept.
 * Throws a PipelineError when the edit is invalid.
 */
export function applyEdit(
  pipeline: Pipeline,
  edit: PipelineEdit
): { pipeline: Pipeline; checkStepId?: string } {
  switch (edit.type) {
    case "add": {
      const added = addStep(pipeline, edit.op, edit.params, edit.position);
      return { pipeline: added.pipeline, checkStepId: added.step.id };
    }
    case "update":
      return {
        pipeline: updateStep(pipeline, edit.stepId, edit.params),
        checkStepId: edit.stepId
      };
    case "replace": {
      const old = pipeline.steps.find((s) => s.id === edit.stepId);
      const cleared = Object.fromEntries(
        Object.keys(old?.params ?? {}).map((key) => [key, null])
      );
      return {
        pipeline: updateStep(pipeline, edit.stepId, {
          ...cleared,
          ...edit.params
        }),
        checkStepId: edit.stepId
      };
    }
    case "remove":
      return { pipeline: removeStep(pipeline, edit.stepId) };
    case "move":
      return {
        pipeline: moveStep(pipeline, edit.stepId, edit.position),
        checkStepId: edit.stepId
      };
  }
}

/**
 * Applies an edit to a dataset's pipeline, runs the result on the sample, and saves it.
 * If the edited step fails on the sample (for example, an unknown column), the edit is refused and nothing is saved.
 */
export async function editPipeline(
  host: PipelineHost,
  dataset: ReadyDataset,
  edit: PipelineEdit
): Promise<
  | { error: string }
  | {
      saved: true;
      step?: Preview["steps"][number];
      preview: Preview;
      warning?: string;
    }
> {
  const sample = await host.loadSample(dataset.id, dataset.profile);

  // From here to the save there is no await, so parallel edits cannot interleave
  // and overwrite each other: the agent runs one piece of code at a time between awaits.
  let next: { pipeline: Pipeline; checkStepId?: string };
  try {
    next = applyEdit(host.loadPipeline(dataset.id), edit);
  } catch (error) {
    if (error instanceof PipelineError) return { error: error.message };
    throw error;
  }

  const preview = buildPreview(sample.table, next.pipeline.steps, {
    partial: sample.partial
  });
  const checked = preview.steps.find((s) => s.id === next.checkStepId);
  if (checked?.status === "error")
    return { error: `The step was not saved. ${checked.summary}` };

  host.savePipeline(dataset.id, next.pipeline);
  const failing = preview.steps
    .filter((s) => s.status === "error")
    .map((s) => `${s.id}: ${s.summary}`);
  return {
    saved: true,
    ...(checked ? { step: checked } : {}),
    preview,
    ...(failing.length > 0
      ? { warning: `Some steps now fail. ${failing.join(" ")}` }
      : {})
  };
}

/**
 * Starts a full run after checking every step on the sample.
 * A step that fails on the preview rows would fail the run too, so the run is refused now instead of after it starts.
 */
export async function startCheckedRun(
  host: PipelineHost,
  dataset: ReadyDataset
): Promise<{ error: string } | { runId: string; version: number }> {
  const sample = await host.loadSample(dataset.id, dataset.profile);
  const preview = buildPreview(
    sample.table,
    host.loadPipeline(dataset.id).steps,
    { partial: sample.partial }
  );
  const failing = preview.steps.find((s) => s.status === "error");
  if (failing)
    return {
      error: `The run did not start. Step ${failing.id} fails: ${failing.summary}`
    };
  return host.startRun(dataset.id);
}

/** How many result rows the pipeline panel shows. */
const VIEW_ROWS = 20;

/** The pipeline as the panel shows it: each step with what it did on the sample and the columns it saw, then the result rows. */
export async function pipelineView(
  host: PipelineHost,
  dataset: ReadyDataset,
  upToStepId?: string
) {
  const steps = host.loadPipeline(dataset.id).steps;
  if (upToStepId && !steps.some((s) => s.id === upToStepId))
    return { error: `There is no step "${upToStepId}".` };
  const sample = await host.loadSample(dataset.id, dataset.profile);
  // Every step is described even when the rows stop early, so the list stays complete.
  const all = buildPreview(sample.table, steps, {
    partial: sample.partial,
    columnsBefore: true
  });
  const upTo = buildPreview(sample.table, steps, {
    upToStepId,
    partial: sample.partial,
    rows: VIEW_ROWS
  });
  return {
    steps: all.steps,
    upToStepId: upToStepId ?? null,
    sampleRows: all.sampleRows,
    partial: all.partial,
    /** Columns after the last step, for adding a step at the end. */
    endColumns: all.columns,
    columns: upTo.columns,
    rowCount: upTo.rowCount,
    rows: upTo.rows
  };
}

export type PipelineView = Exclude<
  Awaited<ReturnType<typeof pipelineView>>,
  { error: string }
>;

/** What the panel needs to offer a transform: its usage text, flags, and parameters as JSON Schema. */
export interface TransformInfo {
  name: TransformName;
  usage: string;
  safe: boolean;
  wholeFile: boolean;
  schema: Record<string, unknown>;
}

/** Every transform, for the panel's add and edit forms. */
export function transformCatalog(): TransformInfo[] {
  return Object.entries(TRANSFORMS).map(([name, t]) => {
    const { $schema: _, ...schema } = z.toJSONSchema(t.params, {
      io: "input",
      target: "draft-7"
    });
    return {
      name: name as TransformName,
      usage: t.usage,
      safe: t.safe ?? false,
      wholeFile: t.wholeFile ?? false,
      schema
    };
  });
}

/** The user's answer for columns a reused pipeline needs: a column of this file, or null to remove it. */
export const columnMappingSchema = z
  .record(z.string().max(200), z.string().max(200).nullable())
  .refine((mapping) => Object.keys(mapping).length <= 100);

export type ReplaceResult =
  | { error: string }
  | { needsMapping: true; missing: string[]; columns: string[] }
  | { saved: true; steps: number; dropped: number };

/**
 * Replaces a dataset's pipeline with steps from a file or an earlier upload.
 * Returns `needsMapping` when the steps use columns this file lacks and `mapping` does not cover them all.
 * Nothing is saved unless every step works on the sample.
 */
export async function replacePipeline(
  host: PipelineHost,
  dataset: ReadyDataset,
  fileSteps: FileStep[],
  mapping: Record<string, string | null> = {}
): Promise<ReplaceResult> {
  const columns = dataset.profile.columns.map((c) => c.name);
  const missing = findMissingColumns(fileSteps, columns);
  const unmapped = missing.filter((name) => !Object.hasOwn(mapping, name));
  if (unmapped.length > 0) return { needsMapping: true, missing, columns };
  const bad = Object.entries(mapping).find(
    ([from, to]) =>
      !missing.includes(from) || (to !== null && !columns.includes(to))
  );
  if (bad)
    return {
      error: `"${bad[0]}" cannot be mapped to "${bad[1]}". Map only missing columns, to columns of this file.`
    };

  const steps = applyColumnMapping(fileSteps, mapping);
  const sample = await host.loadSample(dataset.id, dataset.profile);
  let pipeline: Pipeline;
  try {
    pipeline = pipelineFromSteps(
      steps,
      host.loadPipeline(dataset.id).nextStepNumber
    );
  } catch (error) {
    if (error instanceof PipelineError) return { error: error.message };
    throw error;
  }
  const preview = buildPreview(sample.table, pipeline.steps, {
    partial: sample.partial
  });
  const failing = preview.steps.findIndex((s) => s.status === "error");
  if (failing !== -1)
    return {
      error: `Nothing was changed. Step ${failing + 1} (${preview.steps[failing].op}) does not work on this file: ${preview.steps[failing].summary}`
    };
  host.savePipeline(dataset.id, pipeline);
  return {
    saved: true,
    steps: pipeline.steps.length,
    dropped: fileSteps.length - steps.length
  };
}
