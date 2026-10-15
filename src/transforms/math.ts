import { z } from "zod";
import { formatNumber, parseNumber } from "../table";
import {
  column,
  columnsSpec,
  mapCells,
  newColumnName,
  transform
} from "./core";

const decimals = z.number().int().min(0).max(10);

/** Rounds using decimal exponents, so 1.005 rounds to 1.01 as people expect, not 1.00. Halves round away from zero. */
export function roundTo(
  x: number,
  places: number,
  mode: "round" | "floor" | "ceil"
): number {
  const shift = (n: number, by: number) => Number(`${n}e${by}`);
  const scaled = shift(x, places);
  const rounded =
    mode === "floor"
      ? Math.floor(scaled)
      : mode === "ceil"
        ? Math.ceil(scaled)
        : Math.sign(scaled) * Math.round(Math.abs(scaled));
  return shift(rounded, -places);
}

const OPERATORS = {
  add: (a: number, b: number) => a + b,
  subtract: (a: number, b: number) => a - b,
  multiply: (a: number, b: number) => a * b,
  divide: (a: number, b: number) => (b === 0 ? null : a / b)
};

export const mathTransforms = {
  math: transform({
    usage:
      'math(column, operator: "add" | "subtract" | "multiply" | "divide", value? | otherColumn?, into?, decimals?): calculate with a number or another column. Writes to a new column into, or overwrites column. Use multiply to scale or convert units. Cells that are not plain numbers are counted as failed: left empty in a new column, unchanged when overwriting. Division by zero counts as failed. Run normalizeNumbers first for values like "$1,200".',
    params: z
      .object({
        column,
        operator: z.enum(["add", "subtract", "multiply", "divide"]),
        value: z.number().optional(),
        otherColumn: column.optional(),
        into: newColumnName.optional(),
        decimals: decimals.optional()
      })
      .refine(
        (p) => (p.value === undefined) !== (p.otherColumn === undefined),
        {
          message: "Give exactly one of value or otherColumn."
        }
      ),
    apply: (ctx, p) => {
      const source = ctx.col(p.column);
      const other = p.otherColumn === undefined ? null : ctx.col(p.otherColumn);
      const target = p.into
        ? ctx.insertColumn(ctx.table.columns.length, p.into)
        : source;
      // Inserting at the end never shifts the source or the other column.
      const op = OPERATORS[p.operator];
      ctx.table.rows.forEach((row, r) => {
        if (row[source].trim() === "") return;
        const a = parseNumber(row[source]);
        const b = other === null ? (p.value ?? null) : parseNumber(row[other]);
        const out = a === null || b === null ? null : op(a, b);
        if (out === null || !Number.isFinite(out)) {
          ctx.fail(row[source]);
          return;
        }
        ctx.set(r, target, formatNumber(out, p.decimals));
      });
    }
  }),

  round: transform({
    usage:
      'round(columns, mode = "round", decimals = 0): round numbers. mode "round" (halves away from zero), "floor" (down), or "ceil" (up).',
    params: z.object({
      columns: columnsSpec,
      mode: z.enum(["round", "floor", "ceil"]).default("round"),
      decimals: decimals.default(0)
    }),
    apply: (ctx, p) =>
      mapCells(ctx, p.columns, (v) => {
        const n = parseNumber(v);
        return n === null
          ? null
          : formatNumber(roundTo(n, p.decimals, p.mode), p.decimals);
      })
  }),

  abs: transform({
    usage: "abs(columns): make negative numbers positive.",
    params: z.object({ columns: columnsSpec }),
    apply: (ctx, p) =>
      mapCells(ctx, p.columns, (v) => {
        const n = parseNumber(v);
        if (n === null) return null;
        return n < 0 ? formatNumber(-n) : v;
      })
  }),

  clamp: transform({
    usage:
      "clamp(columns, min?, max?): raise numbers below min to min and lower numbers above max to max.",
    params: z
      .object({
        columns: columnsSpec,
        min: z.number().optional(),
        max: z.number().optional()
      })
      .refine((p) => p.min !== undefined || p.max !== undefined, {
        message: "Give min, max, or both."
      })
      .refine(
        (p) => p.min === undefined || p.max === undefined || p.min <= p.max,
        { message: "min must not be above max." }
      ),
    apply: (ctx, p) =>
      mapCells(ctx, p.columns, (v) => {
        const n = parseNumber(v);
        if (n === null) return null;
        if (p.min !== undefined && n < p.min) return formatNumber(p.min);
        if (p.max !== undefined && n > p.max) return formatNumber(p.max);
        return v;
      })
  })
};
