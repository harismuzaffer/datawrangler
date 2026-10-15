import { z } from "zod";
import { columnNames, parseNumber } from "../table";
import { column, columnsSpec, StepError, transform } from "./core";

const OPERATORS = [
  "equals",
  "notEquals",
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "greaterThan",
  "lessThan",
  "greaterOrEqual",
  "lessOrEqual",
  "isEmpty",
  "isNotEmpty"
] as const;
type Operator = (typeof OPERATORS)[number];

/** Tests one cell against a condition. Text checks ignore case; number checks only match cells that are numbers. */
export function matches(
  cell: string,
  operator: Operator,
  value: string
): boolean {
  const a = cell.trim().toLowerCase();
  const b = value.trim().toLowerCase();
  switch (operator) {
    case "equals":
      return a === b;
    case "notEquals":
      return a !== b;
    case "contains":
      return a.includes(b);
    case "notContains":
      return !a.includes(b);
    case "startsWith":
      return a.startsWith(b);
    case "endsWith":
      return a.endsWith(b);
    case "isEmpty":
      return a === "";
    case "isNotEmpty":
      return a !== "";
  }
  const x = parseNumber(cell);
  const y = parseNumber(value);
  if (x === null || y === null) return false;
  if (operator === "greaterThan") return x > y;
  if (operator === "lessThan") return x < y;
  if (operator === "greaterOrEqual") return x >= y;
  return x <= y;
}

export const rowTransforms = {
  dropEmptyRows: transform({
    usage: "dropEmptyRows(): remove rows where every cell is empty.",
    safe: true,
    params: z.object({}),
    apply: (ctx) =>
      ctx.filterRows((row) => row.some((cell) => cell.trim() !== ""))
  }),

  dedupe: transform({
    usage:
      'dedupe(columns = "*"): remove rows that repeat an earlier row, keeping the first. With columns, rows count as repeats when those columns match.',
    wholeFile: true,
    params: z.object({ columns: columnsSpec.default("*") }),
    apply: (ctx, p) => {
      const indexes = ctx.cols(p.columns);
      const seen = new Set<string>();
      ctx.filterRows((row) => {
        const key = JSON.stringify(indexes.map((c) => row[c]));
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
  }),

  dropRowsWhereEmpty: transform({
    usage:
      'dropRowsWhereEmpty(columns, mode = "any"): remove rows where any (or, with mode "all", every) one of the columns is empty.',
    params: z.object({
      columns: columnsSpec,
      mode: z.enum(["any", "all"]).default("any")
    }),
    apply: (ctx, p) => {
      const indexes = ctx.cols(p.columns);
      const isEmpty = (row: string[], c: number) => row[c].trim() === "";
      ctx.filterRows((row) =>
        p.mode === "any"
          ? !indexes.some((c) => isEmpty(row, c))
          : !indexes.every((c) => isEmpty(row, c))
      );
    }
  }),

  filterRows: transform({
    usage: `filterRows(column, operator, value?, action = "keep"): keep or drop rows matching a condition. operator: ${OPERATORS.join(", ")}. Text checks ignore case; number checks only match cells that are plain numbers.`,
    params: z
      .object({
        column,
        operator: z.enum(OPERATORS),
        value: z.string().max(1000).optional(),
        action: z.enum(["keep", "drop"]).default("keep")
      })
      .refine(
        (p) =>
          p.operator === "isEmpty" ||
          p.operator === "isNotEmpty" ||
          p.value !== undefined,
        {
          message: "This operator needs a value."
        }
      ),
    apply: (ctx, p) => {
      const c = ctx.col(p.column);
      ctx.filterRows(
        (row) =>
          matches(row[c], p.operator, p.value ?? "") === (p.action === "keep")
      );
    }
  }),

  skipRows: transform({
    usage: "skipRows(count): remove the first count rows below the header.",
    params: z.object({ count: z.number().int().min(1).max(1000) }),
    apply: (ctx, p) => ctx.filterRows((_, index) => index >= p.count)
  }),

  useRowAsHeader: transform({
    usage:
      "useRowAsHeader(row): use a row as the header and remove every row above it. row is the spreadsheet row number (the current header is row 1).",
    params: z.object({ row: z.number().int().min(2).max(1000) }),
    apply: (ctx, p) => {
      const index = p.row - 2;
      const { table } = ctx;
      if (index >= table.rows.length)
        throw new StepError(`There is no row ${p.row}.`);
      const old = table.columns;
      table.columns = columnNames(table.rows[index], old.length);
      ctx.filterRows((_, i) => i > index);
      ctx.result.columnsRemoved.push(...old);
      ctx.result.columnsAdded.push(...table.columns);
    }
  })
};
