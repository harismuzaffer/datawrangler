import { z } from "zod";
import { columnsSpec, mapCells, escapeRegExp, transform } from "./core";

const INVISIBLE = /(?![\t\n\r])\p{Cc}|\p{Cf}/gu;
const NO_BREAK_SPACE = /\u{A0}/gu;

export const textTransforms = {
  trim: transform({
    usage: "trim(columns): remove spaces at the start and end of values.",
    safe: true,
    params: z.object({ columns: columnsSpec }),
    apply: (ctx, p) =>
      mapCells(ctx, p.columns, (v) => v.trim(), { includeEmpty: true })
  }),

  collapseSpaces: transform({
    usage:
      "collapseSpaces(columns): replace repeated spaces and tabs inside values with one space.",
    safe: true,
    params: z.object({ columns: columnsSpec }),
    apply: (ctx, p) =>
      mapCells(ctx, p.columns, (v) => v.replace(/[ \t]{2,}|\t/g, " "))
  }),

  removeInvisible: transform({
    usage:
      "removeInvisible(columns): remove invisible characters (zero-width spaces, control characters) and turn no-break spaces into normal spaces.",
    safe: true,
    params: z.object({ columns: columnsSpec }),
    apply: (ctx, p) =>
      mapCells(
        ctx,
        p.columns,
        (v) => v.replace(INVISIBLE, "").replace(NO_BREAK_SPACE, " "),
        {
          includeEmpty: true
        }
      )
  }),

  changeCase: transform({
    usage:
      'changeCase(columns, case: "lower" | "upper" | "title"): change letter case.',
    params: z.object({
      columns: columnsSpec,
      case: z.enum(["lower", "upper", "title"])
    }),
    apply: (ctx, p) =>
      mapCells(ctx, p.columns, (v) => {
        if (p.case === "lower") return v.toLowerCase();
        if (p.case === "upper") return v.toUpperCase();
        return v
          .toLowerCase()
          .replace(
            /(^|[\s\-'/(])(\p{L})/gu,
            (_, before: string, letter: string) => before + letter.toUpperCase()
          );
      })
  }),

  findReplace: transform({
    usage:
      "findReplace(columns, find, replace, matchCase = true, wholeValue = false): replace plain text (no patterns). With wholeValue, only values exactly equal to find are replaced.",
    params: z.object({
      columns: columnsSpec,
      find: z.string().min(1).max(1000),
      replace: z.string().max(1000),
      matchCase: z.boolean().default(true),
      wholeValue: z.boolean().default(false)
    }),
    apply: (ctx, p) => {
      const pattern = new RegExp(
        p.wholeValue ? `^${escapeRegExp(p.find)}$` : escapeRegExp(p.find),
        p.matchCase ? "g" : "gi"
      );
      // A function replacement keeps "$" in the replacement text literal.
      mapCells(ctx, p.columns, (v) => v.replace(pattern, () => p.replace));
    }
  })
};
