import { z } from "zod";
import type { DatasetProfile, IssueCode } from "./profile";
import { cloneTable, type Table } from "./table";
import {
  createContext,
  isTransformName,
  StepError,
  TRANSFORM_NAMES,
  TRANSFORMS,
  type StepResult,
  type TransformName
} from "./transforms";

/** One step of a pipeline: a transform and its parameters. */
export interface Step {
  id: string;
  op: TransformName;
  params: Record<string, unknown>;
  /** True when DataCobbler added the step on its own because it is safe. */
  auto?: boolean;
}

export interface Pipeline {
  steps: Step[];
  /** Counter for step IDs, so a removed step's ID is never reused. */
  nextStepNumber: number;
}

export const MAX_STEPS = 100;

/** Thrown when an edit is refused. The message is shown to the LLM so it can fix its call. */
export class PipelineError extends Error {}

export function emptyPipeline(): Pipeline {
  return { steps: [], nextStepNumber: 1 };
}

const paramsSchema = z.record(z.string(), z.unknown());

/** Checks the transform name and its parameters, and returns the parameters with defaults filled in. */
export function validateStep(
  op: string,
  params: unknown
): { op: TransformName; params: Record<string, unknown> } {
  if (!isTransformName(op))
    throw new PipelineError(
      `Unknown transform "${op}". Use one of: ${TRANSFORM_NAMES.join(", ")}.`
    );
  const usage = `Usage: ${TRANSFORMS[op].usage}`;
  const parsed = TRANSFORMS[op].params.safeParse(params ?? {});
  if (!parsed.success)
    throw new PipelineError(
      `Invalid parameters for ${op}:\n${z.prettifyError(parsed.error)}\n${usage}`
    );
  const data = paramsSchema.parse(parsed.data);
  // Zod drops unknown keys silently; a misspelled option should be an error the LLM can fix.
  const unknown = Object.keys(paramsSchema.catch({}).parse(params)).filter(
    (key) => !(key in data)
  );
  if (unknown.length > 0)
    throw new PipelineError(
      `Unknown parameters for ${op}: ${unknown.join(", ")}.\n${usage}`
    );
  return { op, params: data };
}

function indexOf(pipeline: Pipeline, stepId: string): number {
  const index = pipeline.steps.findIndex((s) => s.id === stepId);
  if (index === -1) {
    const ids = pipeline.steps.map((s) => s.id).join(", ") || "none";
    throw new PipelineError(`There is no step "${stepId}". Steps are: ${ids}.`);
  }
  return index;
}

/** Turns a 1-based position into an index, where a missing position means "at the end". */
function toIndex(position: number | undefined, length: number): number {
  if (position === undefined) return length;
  if (!Number.isInteger(position) || position < 1 || position > length + 1) {
    throw new PipelineError(
      `Position must be a whole number from 1 to ${length + 1}.`
    );
  }
  return position - 1;
}

/** Returns a new pipeline with the step added at a 1-based position (default: the end), and the new step. */
export function addStep(
  pipeline: Pipeline,
  op: string,
  params: unknown,
  position?: number,
  options: { auto?: boolean } = {}
): { pipeline: Pipeline; step: Step } {
  if (pipeline.steps.length >= MAX_STEPS)
    throw new PipelineError(`A pipeline can have at most ${MAX_STEPS} steps.`);
  const valid = validateStep(op, params);
  const step: Step = {
    id: `s${pipeline.nextStepNumber}`,
    ...valid,
    ...(options.auto ? { auto: true } : {})
  };
  const steps = [...pipeline.steps];
  steps.splice(toIndex(position, steps.length), 0, step);
  return {
    pipeline: { steps, nextStepNumber: pipeline.nextStepNumber + 1 },
    step
  };
}

/** Returns a new pipeline with changes merged into a step's parameters. A null value removes that parameter. */
export function updateStep(
  pipeline: Pipeline,
  stepId: string,
  changes: Record<string, unknown>
): Pipeline {
  const index = indexOf(pipeline, stepId);
  const old = pipeline.steps[index];
  const merged: Record<string, unknown> = { ...old.params };
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  const valid = validateStep(old.op, merged);
  const steps = [...pipeline.steps];
  // An edited step is the user's choice now, not an automatic one.
  steps[index] = { id: old.id, ...valid };
  return { ...pipeline, steps };
}

export function removeStep(pipeline: Pipeline, stepId: string): Pipeline {
  const index = indexOf(pipeline, stepId);
  return { ...pipeline, steps: pipeline.steps.filter((_, i) => i !== index) };
}

/** Returns a new pipeline with the step moved to a 1-based position. */
export function moveStep(
  pipeline: Pipeline,
  stepId: string,
  position: number
): Pipeline {
  const index = indexOf(pipeline, stepId);
  const steps = [...pipeline.steps];
  const [step] = steps.splice(index, 1);
  steps.splice(toIndex(position, steps.length), 0, step);
  return { ...pipeline, steps };
}

export interface StepRun {
  id: string;
  op: TransformName;
  status: "ok" | "error" | "skipped";
  error?: string;
  result?: StepResult;
}

/**
 * Runs steps on a copy of the table, up to and including `upToStepId` if given.
 * Stops at the first step that fails; the steps after it are marked skipped, because they would see a different table.
 */
export function runSteps(
  input: Table,
  steps: Step[],
  upToStepId?: string
): { table: Table; runs: StepRun[] } {
  const last =
    upToStepId === undefined
      ? steps.length - 1
      : steps.findIndex((s) => s.id === upToStepId);
  if (last === -1) throw new PipelineError(`There is no step "${upToStepId}".`);
  return applySteps(cloneTable(input), steps.slice(0, last + 1));
}

/** Runs steps on the table itself, changing it. */
function applySteps(
  input: Table,
  steps: Step[]
): { table: Table; runs: StepRun[] } {
  let table = input;
  const runs: StepRun[] = [];
  let failed = false;
  for (const step of steps) {
    if (failed) {
      runs.push({ id: step.id, op: step.op, status: "skipped" });
      continue;
    }
    const ctx = createContext(table);
    try {
      TRANSFORMS[step.op].apply(ctx, step.params);
      table = ctx.table;
      runs.push({ id: step.id, op: step.op, status: "ok", result: ctx.result });
    } catch (error) {
      if (!(error instanceof StepError || error instanceof z.ZodError))
        throw error;
      failed = true;
      const message =
        error instanceof z.ZodError ? z.prettifyError(error) : error.message;
      runs.push({ id: step.id, op: step.op, status: "error", error: message });
    }
  }
  return { table, runs };
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Describes what a step did in one plain sentence. */
export function describeRun(run: StepRun): string {
  if (run.status === "skipped")
    return "Skipped because an earlier step failed.";
  if (run.status === "error" || !run.result) return `Failed: ${run.error}`;
  const r = run.result;
  const parts: string[] = [];
  if (r.cellsChanged) parts.push(`changed ${plural(r.cellsChanged, "cell")}`);
  if (r.rowsRemoved) parts.push(`removed ${plural(r.rowsRemoved, "row")}`);
  const renamed =
    r.columnsAdded.length > 0 &&
    r.columnsAdded.length === r.columnsRemoved.length;
  if (renamed && run.op === "renameColumn")
    parts.push(`renamed ${r.columnsRemoved[0]} to ${r.columnsAdded[0]}`);
  else {
    if (r.columnsAdded.length) parts.push(`added ${r.columnsAdded.join(", ")}`);
    if (r.columnsRemoved.length)
      parts.push(`removed ${r.columnsRemoved.join(", ")}`);
  }
  if (r.failed) parts.push(`could not convert ${plural(r.failed, "cell")}`);
  if (parts.length === 0) return "No changes.";
  const sentence = parts.join(", ");
  return `${sentence[0].toUpperCase()}${sentence.slice(1)}.`;
}

/** What a full run did: the size of the result and one sentence per step. Small enough to store and show. */
export interface RunReport {
  rowCount: number;
  columns: string[];
  steps: { id: string; op: TransformName; summary: string }[];
}

/**
 * Runs every step on the whole table and describes what each step did.
 * Changes `input` instead of copying it, because a whole file can be large; do not use `input` afterwards.
 * Throws a PipelineError naming the first step that fails, because a partly cleaned file must not be saved.
 */
export function runPipeline(
  input: Table,
  steps: Step[]
): { table: Table; report: RunReport } {
  const { table, runs } = applySteps(input, steps);
  const failed = runs.find((run) => run.status === "error");
  if (failed)
    throw new PipelineError(
      `Step ${failed.id} (${failed.op}) failed on the whole file: ${failed.error}`
    );
  return {
    table,
    report: {
      rowCount: table.rows.length,
      columns: table.columns,
      steps: runs.map((run) => ({
        id: run.id,
        op: run.op,
        summary: describeRun(run)
      }))
    }
  };
}

const PREVIEW_CELL_LENGTH = 60;

function clip(value: string): string {
  return value.length > PREVIEW_CELL_LENGTH
    ? `${value.slice(0, PREVIEW_CELL_LENGTH)}…`
    : value;
}

export interface PreviewOptions {
  upToStepId?: string;
  /** How many result rows to include. */
  rows?: number;
  /** True when the sample is only the start of the file. */
  partial: boolean;
}

/** Runs the steps on the sample and describes each step and the resulting rows, ready for the LLM or the UI. */
export function buildPreview(
  sample: Table,
  steps: Step[],
  options: PreviewOptions
) {
  const { table, runs } = runSteps(sample, steps, options.upToStepId);
  const byId = new Map(steps.map((s) => [s.id, s]));
  return {
    sampleRows: sample.rows.length,
    partial: options.partial,
    steps: runs.map((run) => {
      const step = byId.get(run.id);
      return {
        id: run.id,
        op: run.op,
        params: step?.params ?? {},
        ...(step?.auto ? { auto: true } : {}),
        status: run.status,
        summary: describeRun(run),
        // Counts for steps that need every row are only true for the sample.
        ...(options.partial && TRANSFORMS[run.op].wholeFile
          ? { sampleOnly: true }
          : {}),
        ...(run.result?.examples.length
          ? {
              examples: run.result.examples.map((e) => ({
                ...e,
                before: clip(e.before),
                after: clip(e.after)
              }))
            }
          : {}),
        ...(run.result?.failedExamples.length
          ? { failedExamples: run.result.failedExamples.map(clip) }
          : {})
      };
    }),
    columns: table.columns,
    rowCount: table.rows.length,
    rows: table.rows.slice(0, options.rows ?? 5).map((row) => row.map(clip))
  };
}

export type Preview = ReturnType<typeof buildPreview>;

/** Safe transforms and the profile issue that calls for each, in the order they should run. */
const SAFE_FIXES: {
  issue: IssueCode;
  op: TransformName;
  perColumn: boolean;
}[] = [
  { issue: "invisible_chars", op: "removeInvisible", perColumn: true },
  { issue: "whitespace", op: "trim", perColumn: true },
  { issue: "repeated_spaces", op: "collapseSpaces", perColumn: true },
  { issue: "empty_rows", op: "dropEmptyRows", perColumn: false }
];

/** Builds a pipeline of the safe steps that fix issues found in the profile. */
export function safePipeline(profile: DatasetProfile): Pipeline {
  let pipeline = emptyPipeline();
  for (const fix of SAFE_FIXES) {
    if (fix.perColumn) {
      const columns = profile.columns
        .filter((c) => c.issues.some((i) => i.code === fix.issue))
        .map((c) => c.name);
      if (columns.length > 0)
        pipeline = addStep(pipeline, fix.op, { columns }, undefined, {
          auto: true
        }).pipeline;
    } else if (profile.issues.some((i) => i.code === fix.issue)) {
      pipeline = addStep(pipeline, fix.op, {}, undefined, {
        auto: true
      }).pipeline;
    }
  }
  return pipeline;
}
