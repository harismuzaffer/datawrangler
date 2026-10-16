import { z } from "zod";
import type { Table } from "../table";

/** Thrown when a step cannot run, such as a missing column. The message is shown to the LLM and the user. */
export class StepError extends Error {}

/** One example of a changed cell. `row` is the spreadsheet row number at that step (header is row 1). */
export interface Change {
  row: number;
  column: string;
  before: string;
  after: string;
}

/** What one step did to the table. */
export interface StepResult {
  cellsChanged: number;
  rowsRemoved: number;
  columnsAdded: string[];
  columnsRemoved: string[];
  /** Cells the step could not convert (for example, text in a number column). They are left unchanged or emptied. */
  failed: number;
  failedExamples: string[];
  examples: Change[];
}

const MAX_EXAMPLES = 3;

/** Escapes text so it matches literally inside a regular expression. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The table a transform works on, with helpers that look up columns and record changes. */
export interface StepContext {
  table: Table;
  result: StepResult;
  /** Index of a column by name. Throws a StepError listing the real columns if it does not exist. */
  col(name: string): number;
  /** Indexes for a column list, where "*" means every column. */
  cols(spec: ColumnsSpec): number[];
  /** Writes a cell and records the change if the value is different. */
  set(row: number, col: number, value: string): void;
  /** Records a cell that could not be converted. */
  fail(value: string): void;
  /** Removes rows for which `keep` returns false. */
  filterRows(keep: (row: string[], index: number) => boolean): void;
  /** Inserts an empty column at `index`. Throws if the name is taken. */
  insertColumn(index: number, name: string): number;
  /** Removes columns by index. */
  removeColumns(indexes: number[]): void;
}

export function createContext(table: Table): StepContext {
  const result: StepResult = {
    cellsChanged: 0,
    rowsRemoved: 0,
    columnsAdded: [],
    columnsRemoved: [],
    failed: 0,
    failedExamples: [],
    examples: []
  };

  const ctx: StepContext = {
    table,
    result,
    col(name) {
      const index = table.columns.indexOf(name);
      if (index === -1) {
        const lower = name.toLowerCase();
        const near = table.columns.filter((c) => c.toLowerCase() === lower);
        if (near.length === 1) return table.columns.indexOf(near[0]);
        throw new StepError(
          `There is no column "${name}". Columns are: ${table.columns.join(", ")}.`
        );
      }
      return index;
    },
    cols(spec) {
      if (spec === "*") return table.columns.map((_, i) => i);
      return [...new Set(spec.map((name) => ctx.col(name)))];
    },
    set(row, col, value) {
      const before = table.rows[row][col];
      if (before === value) return;
      table.rows[row][col] = value;
      result.cellsChanged++;
      if (result.examples.length < MAX_EXAMPLES) {
        result.examples.push({
          row: row + 2,
          column: table.columns[col],
          before,
          after: value
        });
      }
    },
    fail(value) {
      result.failed++;
      if (
        result.failedExamples.length < MAX_EXAMPLES &&
        !result.failedExamples.includes(value)
      ) {
        result.failedExamples.push(value);
      }
    },
    filterRows(keep) {
      const before = table.rows.length;
      table.rows = table.rows.filter(keep);
      result.rowsRemoved += before - table.rows.length;
    },
    insertColumn(index, name) {
      const clean = name.trim();
      if (!clean) throw new StepError("A new column needs a name.");
      if (table.columns.includes(clean))
        throw new StepError(`A column named "${clean}" already exists.`);
      table.columns.splice(index, 0, clean);
      for (const row of table.rows) row.splice(index, 0, "");
      result.columnsAdded.push(clean);
      return index;
    },
    removeColumns(indexes) {
      const drop = new Set(indexes);
      result.columnsRemoved.push(
        ...table.columns.filter((_, i) => drop.has(i))
      );
      table.columns = table.columns.filter((_, i) => !drop.has(i));
      table.rows = table.rows.map((row) => row.filter((_, i) => !drop.has(i)));
    }
  };
  return ctx;
}

const columnName = z.string().trim().min(1).max(200);

/** A list of column names, or "*" for every column. */
export const columnsSpec = z.union(
  [
    z.literal("*"),
    z.array(columnName).min(1).max(500),
    // Models often send one column as a plain string; treat it as a list of one.
    columnName.transform((name) => [name])
  ],
  { error: 'columns must be "*" or a list of column names, like ["city"].' }
);
export type ColumnsSpec = z.infer<typeof columnsSpec>;
export const column = columnName;
export const newColumnName = columnName;

/** Optional grouping and ordering shared by the window transforms. */
export const windowOptions = {
  groupBy: z.array(columnName).max(10).optional(),
  orderBy: z
    .object({
      column: columnName,
      direction: z.enum(["asc", "desc"]).default("asc")
    })
    .optional()
};

export interface Transform {
  /** Parameters and what the transform does, in one line, for the LLM's catalog. */
  usage: string;
  /** Safe transforms are added automatically when the profile shows the matching issue. */
  safe?: boolean;
  /** Results depend on rows outside a preview sample, so a preview shows them as "sample only". */
  wholeFile?: boolean;
  params: z.ZodType;
  /** Validates `params` and applies the step. Throws StepError when the step cannot run. */
  apply(ctx: StepContext, params: unknown): void;
}

/** Declares a transform with typed parameters. */
export function transform<S extends z.ZodType>(def: {
  usage: string;
  safe?: boolean;
  wholeFile?: boolean;
  params: S;
  apply(ctx: StepContext, params: z.infer<S>): void;
}): Transform {
  return {
    ...def,
    apply: (ctx, params) => def.apply(ctx, def.params.parse(params))
  };
}

/** Applies `fn` to every non-empty cell of the given columns. `fn` returns the new value, or null if it fails. */
export function mapCells(
  ctx: StepContext,
  columns: ColumnsSpec,
  fn: (value: string) => string | null,
  options: { includeEmpty?: boolean } = {}
): void {
  const indexes = ctx.cols(columns);
  const { rows } = ctx.table;
  for (let r = 0; r < rows.length; r++) {
    for (const c of indexes) {
      const value = rows[r][c];
      if (!options.includeEmpty && value.trim() === "") continue;
      const next = fn(value);
      if (next === null) ctx.fail(value);
      else ctx.set(r, c, next);
    }
  }
}
