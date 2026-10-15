import { z } from "zod";
import { column, newColumnName, StepError, transform } from "./core";

export const columnTransforms = {
  renameColumn: transform({
    usage: "renameColumn(column, to): give a column a new name.",
    params: z.object({ column, to: newColumnName }),
    apply: (ctx, p) => {
      const c = ctx.col(p.column);
      const { columns } = ctx.table;
      if (columns[c] === p.to) return;
      if (columns.includes(p.to))
        throw new StepError(`A column named "${p.to}" already exists.`);
      ctx.result.columnsRemoved.push(columns[c]);
      ctx.result.columnsAdded.push(p.to);
      columns[c] = p.to;
    }
  }),

  dropColumns: transform({
    usage: "dropColumns(columns): remove columns.",
    params: z.object({ columns: z.array(column).min(1).max(500) }),
    apply: (ctx, p) => {
      const indexes = ctx.cols(p.columns);
      if (indexes.length === ctx.table.columns.length)
        throw new StepError("A step cannot remove every column.");
      ctx.removeColumns(indexes);
    }
  }),

  reorderColumns: transform({
    usage:
      "reorderColumns(columns): put these columns first, in this order. Other columns follow in their current order.",
    params: z.object({ columns: z.array(column).min(1).max(500) }),
    apply: (ctx, p) => {
      const first = ctx.cols(p.columns);
      const firstSet = new Set(first);
      const order = [
        ...first,
        ...ctx.table.columns.map((_, i) => i).filter((i) => !firstSet.has(i))
      ];
      ctx.table.columns = order.map((i) => ctx.table.columns[i]);
      ctx.table.rows = ctx.table.rows.map((row) => order.map((i) => row[i]));
    }
  }),

  splitColumn: transform({
    usage:
      "splitColumn(column, delimiter, into, keepOriginal = false): split values on a delimiter into new columns named in into. Extra parts stay in the last new column.",
    params: z.object({
      column,
      delimiter: z.string().min(1).max(20),
      into: z.array(newColumnName).min(2).max(20),
      keepOriginal: z.boolean().default(false)
    }),
    apply: (ctx, p) => {
      const source = ctx.col(p.column);
      const values = ctx.table.rows.map((row) => {
        const parts = row[source] === "" ? [] : row[source].split(p.delimiter);
        return [
          ...parts.slice(0, p.into.length - 1),
          parts.slice(p.into.length - 1).join(p.delimiter)
        ];
      });
      // Remove first, so a new column may reuse the original's name.
      if (!p.keepOriginal) ctx.removeColumns([source]);
      const start = p.keepOriginal ? source + 1 : source;
      p.into.forEach((name, i) => {
        const c = ctx.insertColumn(start + i, name);
        values.forEach((cells, r) => ctx.set(r, c, cells[i] ?? ""));
      });
    }
  }),

  mergeColumns: transform({
    usage:
      'mergeColumns(columns, into, separator = " ", keepOriginals = false, skipEmpty = true): join columns into one new column, placed where the first one was.',
    params: z.object({
      columns: z.array(column).min(2).max(20),
      into: newColumnName,
      separator: z.string().max(20).default(" "),
      keepOriginals: z.boolean().default(false),
      skipEmpty: z.boolean().default(true)
    }),
    apply: (ctx, p) => {
      const sources = ctx.cols(p.columns);
      const values = ctx.table.rows.map((row) =>
        sources
          .map((c) => row[c])
          .filter((v) => !p.skipEmpty || v.trim() !== "")
          .join(p.separator)
      );
      // Remove first, so the new column may reuse an original's name. Columns before the first source keep their place.
      if (!p.keepOriginals) ctx.removeColumns(sources);
      const c = ctx.insertColumn(Math.min(...sources), p.into);
      values.forEach((value, r) => ctx.set(r, c, value));
    }
  })
};
