import { z } from "zod";
import { formatNumber, parseNumber } from "../table";
import {
  column,
  newColumnName,
  transform,
  windowOptions,
  type StepContext
} from "./core";

type WindowOptions = {
  groupBy?: string[];
  orderBy?: { column: string; direction: "asc" | "desc" };
};

/** Compares cells as numbers when both are numbers, otherwise as text. Empty cells always sort last. */
function compareCells(a: string, b: string, direction: "asc" | "desc"): number {
  const aEmpty = a.trim() === "";
  const bEmpty = b.trim() === "";
  if (aEmpty || bEmpty) return aEmpty === bEmpty ? 0 : aEmpty ? 1 : -1;
  const x = parseNumber(a);
  const y = parseNumber(b);
  const order = x !== null && y !== null ? x - y : a < b ? -1 : a > b ? 1 : 0;
  return direction === "asc" ? order : -order;
}

/**
 * Splits row indexes into groups and orders each group.
 * Sorting is stable, so rows with equal values keep their file order and results repeat between runs.
 */
function windowGroups(ctx: StepContext, options: WindowOptions): number[][] {
  const groupCols = options.groupBy ? ctx.cols(options.groupBy) : [];
  const groups = new Map<string, number[]>();
  ctx.table.rows.forEach((row, r) => {
    const key = JSON.stringify(groupCols.map((c) => row[c]));
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  });
  const orderBy = options.orderBy;
  if (!orderBy) return [...groups.values()];
  const c = ctx.col(orderBy.column);
  const rows = ctx.table.rows;
  return [...groups.values()].map((list) =>
    list.sort((a, b) => compareCells(rows[a][c], rows[b][c], orderBy.direction))
  );
}

/** Adds the output column right after the source column, or at the end when there is no source. */
function addOutput(ctx: StepContext, into: string, source?: number): number {
  return ctx.insertColumn(
    source === undefined ? ctx.table.columns.length : source + 1,
    into
  );
}

const windowUsage =
  'Optional groupBy (columns: restart for each group) and orderBy ({column, direction: "asc" | "desc"}: order rows before calculating; rows themselves do not move).';

export const windowTransforms = {
  rowNumber: transform({
    usage: `rowNumber(into, groupBy?, orderBy?): number rows 1, 2, 3, … in a new column. ${windowUsage}`,
    wholeFile: true,
    params: z.object({ into: newColumnName, ...windowOptions }),
    apply: (ctx, p) => {
      const groups = windowGroups(ctx, p);
      const target = addOutput(ctx, p.into);
      for (const group of groups)
        group.forEach((r, i) => ctx.set(r, target, String(i + 1)));
    }
  }),

  rank: transform({
    usage: `rank(column, into, direction = "desc", groupBy?): rank rows by a column's values (1 = highest with "desc"). Equal values share a rank, and the next rank is skipped (1, 2, 2, 4). Empty cells get no rank. ${windowUsage}`,
    wholeFile: true,
    params: z.object({
      column,
      into: newColumnName,
      direction: z.enum(["asc", "desc"]).default("desc"),
      groupBy: windowOptions.groupBy
    }),
    apply: (ctx, p) => {
      const source = ctx.col(p.column);
      const groups = windowGroups(ctx, {
        groupBy: p.groupBy,
        orderBy: { column: p.column, direction: p.direction }
      });
      const target = addOutput(ctx, p.into, source);
      const rows = ctx.table.rows;
      // The output column sits after the source, so the source index is unchanged.
      for (const group of groups) {
        group.forEach((r, i) => {
          if (rows[r][source].trim() === "") return;
          const previous = group[i - 1];
          const tied =
            previous !== undefined &&
            compareCells(
              rows[previous][source],
              rows[r][source],
              p.direction
            ) === 0;
          ctx.set(r, target, tied ? rows[previous][target] : String(i + 1));
        });
      }
    }
  }),

  runningTotal: transform({
    usage: `runningTotal(column, into, groupBy?, orderBy?): add up a column row by row. Empty cells keep the total; cells that are not numbers are counted as failed. ${windowUsage}`,
    wholeFile: true,
    params: z.object({ column, into: newColumnName, ...windowOptions }),
    apply: (ctx, p) => {
      const source = ctx.col(p.column);
      const groups = windowGroups(ctx, p);
      const target = addOutput(ctx, p.into, source);
      for (const group of groups) {
        let total = 0;
        for (const r of group) {
          const value = ctx.table.rows[r][source];
          const n = parseNumber(value);
          if (n !== null) total += n;
          else if (value.trim() !== "") ctx.fail(value);
          ctx.set(r, target, formatNumber(total));
        }
      }
    }
  }),

  lag: transform({
    usage: `lag(column, into, offset = 1, groupBy?, orderBy?): copy the value from offset rows before (the previous row by default). ${windowUsage}`,
    wholeFile: true,
    params: z.object({
      column,
      into: newColumnName,
      offset: z.number().int().min(1).max(1000).default(1),
      ...windowOptions
    }),
    apply: (ctx, p) => shift(ctx, p, -p.offset)
  }),

  lead: transform({
    usage: `lead(column, into, offset = 1, groupBy?, orderBy?): copy the value from offset rows after (the next row by default). ${windowUsage}`,
    wholeFile: true,
    params: z.object({
      column,
      into: newColumnName,
      offset: z.number().int().min(1).max(1000).default(1),
      ...windowOptions
    }),
    apply: (ctx, p) => shift(ctx, p, p.offset)
  }),

  difference: transform({
    usage: `difference(column, into, groupBy?, orderBy?): subtract the previous row's value from each value. The first row of each group stays empty. ${windowUsage}`,
    wholeFile: true,
    params: z.object({ column, into: newColumnName, ...windowOptions }),
    apply: (ctx, p) => {
      const source = ctx.col(p.column);
      const groups = windowGroups(ctx, p);
      const target = addOutput(ctx, p.into, source);
      const rows = ctx.table.rows;
      for (const group of groups) {
        group.forEach((r, i) => {
          if (i === 0) return;
          const now = parseNumber(rows[r][source]);
          const before = parseNumber(rows[group[i - 1]][source]);
          if (now === null || before === null) {
            if (rows[r][source].trim() !== "") ctx.fail(rows[r][source]);
            return;
          }
          ctx.set(r, target, formatNumber(now - before));
        });
      }
    }
  }),

  movingAverage: transform({
    usage: `movingAverage(column, into, size, decimals?, groupBy?, orderBy?): average of each value and the size - 1 values before it. Early rows use the values available; cells that are not numbers are skipped. ${windowUsage}`,
    wholeFile: true,
    params: z.object({
      column,
      into: newColumnName,
      size: z.number().int().min(2).max(1000),
      decimals: z.number().int().min(0).max(10).optional(),
      ...windowOptions
    }),
    apply: (ctx, p) => {
      const source = ctx.col(p.column);
      const groups = windowGroups(ctx, p);
      const target = addOutput(ctx, p.into, source);
      for (const group of groups) {
        const numbers = group.map((r) =>
          parseNumber(ctx.table.rows[r][source])
        );
        group.forEach((r, i) => {
          const window = numbers
            .slice(Math.max(0, i - p.size + 1), i + 1)
            .filter((n): n is number => n !== null);
          if (window.length === 0) return;
          ctx.set(
            r,
            target,
            formatNumber(
              window.reduce((a, b) => a + b, 0) / window.length,
              p.decimals
            )
          );
        });
      }
    }
  }),

  percentOfTotal: transform({
    usage:
      "percentOfTotal(column, into, groupBy?, decimals = 2): each value as a percent of its column total (or group total). Cells that are not numbers are counted as failed.",
    wholeFile: true,
    params: z.object({
      column,
      into: newColumnName,
      groupBy: windowOptions.groupBy,
      decimals: z.number().int().min(0).max(10).default(2)
    }),
    apply: (ctx, p) => {
      const source = ctx.col(p.column);
      const groups = windowGroups(ctx, { groupBy: p.groupBy });
      const target = addOutput(ctx, p.into, source);
      const rows = ctx.table.rows;
      for (const group of groups) {
        const total = group.reduce(
          (sum, r) => sum + (parseNumber(rows[r][source]) ?? 0),
          0
        );
        for (const r of group) {
          const n = parseNumber(rows[r][source]);
          if (n === null || total === 0) {
            if (rows[r][source].trim() !== "") ctx.fail(rows[r][source]);
            continue;
          }
          ctx.set(r, target, formatNumber((n / total) * 100, p.decimals));
        }
      }
    }
  })
};

function shift(
  ctx: StepContext,
  p: WindowOptions & { column: string; into: string },
  by: number
): void {
  const source = ctx.col(p.column);
  const groups = windowGroups(ctx, p);
  const target = addOutput(ctx, p.into, source);
  for (const group of groups) {
    group.forEach((r, i) => {
      const from = group[i + by];
      if (from !== undefined) ctx.set(r, target, ctx.table.rows[from][source]);
    });
  }
}
