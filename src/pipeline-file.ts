import { z } from "zod";
import {
  addStep,
  emptyPipeline,
  PipelineError,
  type Pipeline,
  type Step
} from "./pipeline";

export const PIPELINE_FORMAT = "datacobbler-pipeline";
export const PIPELINE_VERSION = 1;

/** Largest pipeline file accepted. A full pipeline of 100 steps is far smaller. */
export const MAX_PIPELINE_FILE_BYTES = 256 * 1024;

/** A step as stored in a file: no ID, because IDs belong to one pipeline. */
export interface FileStep {
  op: string;
  params: Record<string, unknown>;
}

/** Builds the exported file for a pipeline. `source` is the name of the CSV it was made for. */
export function exportPipeline(steps: Step[], source: string) {
  return {
    format: PIPELINE_FORMAT,
    version: PIPELINE_VERSION,
    source,
    exportedAt: new Date().toISOString(),
    steps: steps.map(({ op, params }) => ({ op, params }))
  };
}

const fileSchema = z.object({
  format: z.literal(PIPELINE_FORMAT),
  version: z.literal(PIPELINE_VERSION),
  source: z.string().max(200).optional(),
  steps: z
    .array(
      z.object({
        op: z.string().max(50),
        params: z.record(z.string(), z.unknown())
      })
    )
    .max(100)
});

/** Thrown when a pipeline file cannot be used. The message is safe to show to the user. */
export class PipelineFileError extends Error {}

/** Reads a pipeline file. It comes from the user's disk, so everything is checked; transforms and parameters are checked later, when the steps are added. */
export function parsePipelineFile(text: string): {
  steps: FileStep[];
  source?: string;
} {
  if (new TextEncoder().encode(text).byteLength > MAX_PIPELINE_FILE_BYTES)
    throw new PipelineFileError("The pipeline file is too large.");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new PipelineFileError("The file is not valid JSON.");
  }
  const parsed = fileSchema.safeParse(json);
  if (!parsed.success) {
    const format = (json as { format?: unknown } | null)?.format;
    throw new PipelineFileError(
      format === PIPELINE_FORMAT
        ? `The pipeline file is not valid:\n${z.prettifyError(parsed.error)}`
        : "This is not a DataCobbler pipeline file."
    );
  }
  return { steps: parsed.data.steps, source: parsed.data.source };
}

/** Finds a column by name the way steps do: exact, else the only match that differs in letter case. */
function findColumn(name: string, available: string[]): string | undefined {
  if (available.includes(name)) return name;
  const near = available.filter((c) => c.toLowerCase() === name.toLowerCase());
  return near.length === 1 ? near[0] : undefined;
}

/** Column names a step reads. */
function referencedColumns(params: Record<string, unknown>): string[] {
  const names: string[] = [];
  for (const key of ["column", "otherColumn"])
    if (typeof params[key] === "string") names.push(params[key]);
  for (const key of ["columns", "groupBy"])
    if (Array.isArray(params[key]))
      names.push(
        ...params[key].filter((n): n is string => typeof n === "string")
      );
  const orderBy = params.orderBy as { column?: unknown } | undefined;
  if (typeof orderBy?.column === "string") names.push(orderBy.column);
  return names;
}

/** Column names a step creates, which later steps may use. */
function createdColumns(params: Record<string, unknown>): string[] {
  return ["to", "into"].flatMap((key) => {
    const value = params[key];
    if (typeof value === "string") return [value];
    if (Array.isArray(value))
      return value.filter((n): n is string => typeof n === "string");
    return [];
  });
}

/**
 * Lists the columns the steps use that the file does not have, in the order they are first used.
 * Columns made by an earlier step (a rename, or a new column) count as present.
 */
export function findMissingColumns(
  steps: FileStep[],
  fileColumns: string[]
): string[] {
  const available = [...fileColumns];
  const missing: string[] = [];
  for (const step of steps) {
    for (const name of referencedColumns(step.params))
      if (!findColumn(name, available) && !missing.includes(name))
        missing.push(name);
    available.push(...createdColumns(step.params));
  }
  return missing;
}

/**
 * Renames missing columns to the user's choices. A column mapped to null is removed:
 * from a list of columns it is dropped, and a step left with no column to work on is dropped.
 */
export function applyColumnMapping(
  steps: FileStep[],
  mapping: Record<string, string | null>
): FileStep[] {
  const has = (name: string) => Object.hasOwn(mapping, name);
  const result: FileStep[] = [];
  for (const step of steps) {
    const params = { ...step.params };
    let drop = false;
    for (const key of ["column", "otherColumn"]) {
      const name = params[key];
      if (typeof name !== "string" || !has(name)) continue;
      if (mapping[name] === null) drop = true;
      else params[key] = mapping[name];
    }
    for (const key of ["columns", "groupBy"]) {
      const list = params[key];
      if (!Array.isArray(list)) continue;
      const next = list.flatMap((name: unknown) =>
        typeof name === "string" && has(name)
          ? mapping[name] === null
            ? []
            : [mapping[name]]
          : [name]
      );
      // An empty groupBy means "no groups", which is fine; an empty column list leaves nothing to do.
      if (next.length === 0 && key === "columns") drop = true;
      params[key] = next.length === 0 && key === "groupBy" ? undefined : next;
      if (params[key] === undefined) delete params[key];
    }
    const orderBy = params.orderBy as Record<string, unknown> | undefined;
    if (typeof orderBy?.column === "string" && has(orderBy.column)) {
      const to = mapping[orderBy.column];
      if (to === null) delete params.orderBy;
      else params.orderBy = { ...orderBy, column: to };
    }
    if (!drop) result.push({ op: step.op, params });
  }
  return result;
}

/** Builds a new pipeline from file steps, checking each transform and its parameters. Throws a PipelineError naming the bad step. */
export function pipelineFromSteps(steps: FileStep[]): Pipeline {
  return steps.reduce((pipeline, step, i) => {
    try {
      return addStep(pipeline, step.op, step.params).pipeline;
    } catch (error) {
      if (error instanceof PipelineError)
        throw new PipelineError(`Step ${i + 1}: ${error.message}`);
      throw error;
    }
  }, emptyPipeline());
}
