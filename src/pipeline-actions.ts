import { z } from "zod";
import {
  addStep,
  buildPreview,
  moveStep,
  PipelineError,
  removeStep,
  updateStep,
  type Pipeline,
  type Preview
} from "./pipeline";
import type { DatasetProfile } from "./profile";
import type { RunSummary } from "./server";
import type { Table } from "./table";

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
