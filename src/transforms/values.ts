import { z } from "zod";
import { NULL_MARKERS } from "../profile";
import { columnsSpec, mapCells, escapeRegExp, transform } from "./core";

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec"
];

export const DATE_FORMATS = [
  "YYYY-MM-DD",
  "DD/MM/YYYY",
  "MM/DD/YYYY",
  "D Mon YYYY",
  "Mon D, YYYY"
] as const;
type DateFormat = (typeof DATE_FORMATS)[number];

const NUMERIC = /^(\d{1,4})[/.\- ](\d{1,2})[/.\- ](\d{1,4})$/;
const DAY_MONTH_NAME = /^(\d{1,2})[ -]([a-z]+)\.?[ ,-]+(\d{2}|\d{4})$/i;
const MONTH_NAME_DAY = /^([a-z]+)\.? (\d{1,2}),? (\d{2}|\d{4})$/i;

function fullYear(text: string): number {
  const year = Number(text);
  // Two-digit years: 00–49 are 2000s, 50–99 are 1900s.
  if (text.length === 2) return year < 50 ? 2000 + year : 1900 + year;
  return year;
}

function monthFromName(name: string): number | null {
  const index = MONTHS.indexOf(name.slice(0, 3).toLowerCase());
  return index === -1 ? null : index + 1;
}

function isoDate(year: number, month: number, day: number): string | null {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1)
    return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC rolls 31 April over to 1 May; a real date keeps its day.
  if (date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Reads a date in one of the given formats and returns it as YYYY-MM-DD, or null. */
export function parseDate(
  value: string,
  formats: readonly DateFormat[]
): string | null {
  const v = value.trim();
  for (const format of formats) {
    let m: RegExpExecArray | null;
    if (format === "D Mon YYYY" && (m = DAY_MONTH_NAME.exec(v))) {
      const month = monthFromName(m[2]);
      const date = month && isoDate(fullYear(m[3]), month, Number(m[1]));
      if (date) return date;
    } else if (format === "Mon D, YYYY" && (m = MONTH_NAME_DAY.exec(v))) {
      const month = monthFromName(m[1]);
      const date = month && isoDate(fullYear(m[3]), month, Number(m[2]));
      if (date) return date;
    } else if ((m = NUMERIC.exec(v))) {
      const [a, b, c] = [m[1], m[2], m[3]];
      let date: string | null = null;
      if (format === "YYYY-MM-DD" && a.length === 4)
        date = isoDate(Number(a), Number(b), Number(c));
      if (format === "DD/MM/YYYY" && c.length !== 3 && a.length <= 2)
        date = isoDate(fullYear(c), Number(b), Number(a));
      if (format === "MM/DD/YYYY" && c.length !== 3 && a.length <= 2)
        date = isoDate(fullYear(c), Number(a), Number(b));
      if (date) return date;
    }
  }
  return null;
}

const CURRENCY = /[$€£¥₹]|\b(?:USD|EUR|GBP|INR|JPY)\b/gi;
const SPACES = /[\s\u{A0}\u{202F}]/gu;
const PLAIN = /^-?(?:\d+\.?\d*|\.\d+)$/;

/** Reads a formatted number ("$1,200.50", "1.234,5", "(30)", "40%") and returns it as plain text, or null. */
export function normalizeNumber(
  value: string,
  decimalSeparator: "." | ","
): string | null {
  let v = value.replace(CURRENCY, "").replace(SPACES, "");
  let negative = false;
  // Accounting style: (30) means -30.
  const parens = /^\((.*)\)$/.exec(v);
  if (parens) {
    v = parens[1];
    negative = true;
  }
  v = v.replace(/%$/, "");
  if (v.startsWith("+")) v = v.slice(1);
  if (v.startsWith("-")) {
    negative = !negative;
    v = v.slice(1);
  }
  const thousands = decimalSeparator === "." ? "," : ".";
  if (v.includes(thousands)) {
    // Only real thousands groups are removed; "12,5" with a "." decimal separator is not a number we can trust.
    const t = escapeRegExp(thousands);
    const d = escapeRegExp(decimalSeparator);
    if (!new RegExp(`^\\d{1,3}(?:${t}\\d{3})+(?:${d}\\d*)?$`).test(v))
      return null;
    v = v.split(thousands).join("");
  }
  if (decimalSeparator === ",") v = v.replace(",", ".");
  if (!PLAIN.test(v)) return null;
  return negative && Number(v) !== 0 ? `-${v}` : v;
}

const TRUE_WORDS = new Set(["true", "yes", "y", "t", "1"]);
const FALSE_WORDS = new Set(["false", "no", "n", "f", "0"]);

export const valueTransforms = {
  standardizeNulls: transform({
    usage:
      'standardizeNulls(columns, markers?): empty the cells that only hold a missing-data placeholder. Default markers: N/A, NA, #N/A, null, none, nil, NaN, undefined, missing, "-", "--", "?". Matching ignores case.',
    params: z.object({
      columns: columnsSpec,
      markers: z.array(z.string().min(1).max(50)).max(50).optional()
    }),
    apply: (ctx, p) => {
      const markers = p.markers
        ? new Set(p.markers.map((m) => m.trim().toLowerCase()))
        : NULL_MARKERS;
      mapCells(ctx, p.columns, (v) =>
        markers.has(v.trim().toLowerCase()) ? "" : v
      );
    }
  }),

  fillEmpty: transform({
    usage: "fillEmpty(columns, value): put a value into empty cells.",
    params: z.object({ columns: columnsSpec, value: z.string().max(1000) }),
    apply: (ctx, p) =>
      mapCells(ctx, p.columns, (v) => (v.trim() === "" ? p.value : v), {
        includeEmpty: true
      })
  }),

  fillDown: transform({
    usage:
      "fillDown(columns): fill empty cells with the value from the row above.",
    params: z.object({ columns: columnsSpec }),
    apply: (ctx, p) => {
      const { rows } = ctx.table;
      for (const c of ctx.cols(p.columns)) {
        let last = "";
        for (let r = 0; r < rows.length; r++) {
          if (rows[r][c].trim() === "") {
            if (last) ctx.set(r, c, last);
          } else last = rows[r][c];
        }
      }
    }
  }),

  parseDate: transform({
    usage: `parseDate(columns, formats): rewrite dates as YYYY-MM-DD. formats is a list tried in order, from: ${DATE_FORMATS.map((f) => `"${f}"`).join(", ")}. Separators /, -, . and space all work, and 2-digit years are read as 1950–2049. Dates that match no format are left unchanged and counted as failed.`,
    params: z.object({
      columns: columnsSpec,
      formats: z.array(z.enum(DATE_FORMATS)).min(1).max(5)
    }),
    apply: (ctx, p) => mapCells(ctx, p.columns, (v) => parseDate(v, p.formats))
  }),

  normalizeNumbers: transform({
    usage:
      'normalizeNumbers(columns, decimalSeparator = "."): rewrite numbers as plain numbers. Removes currency symbols, spaces, thousands separators, and percent signs; (30) becomes -30. Use decimalSeparator "," for numbers like 1.234,5. Values that are not numbers are left unchanged and counted as failed.',
    params: z.object({
      columns: columnsSpec,
      decimalSeparator: z.enum([".", ","]).default(".")
    }),
    apply: (ctx, p) =>
      mapCells(ctx, p.columns, (v) => normalizeNumber(v, p.decimalSeparator))
  }),

  normalizeBooleans: transform({
    usage:
      'normalizeBooleans(columns, trueValue = "true", falseValue = "false"): rewrite yes/no values (yes, y, true, t, 1 and no, n, false, f, 0, in any case) as one spelling. Other values are left unchanged and counted as failed.',
    params: z.object({
      columns: columnsSpec,
      trueValue: z.string().max(50).default("true"),
      falseValue: z.string().max(50).default("false")
    }),
    apply: (ctx, p) =>
      mapCells(ctx, p.columns, (v) => {
        const word = v.trim().toLowerCase();
        if (TRUE_WORDS.has(word)) return p.trueValue;
        if (FALSE_WORDS.has(word)) return p.falseValue;
        return null;
      })
  }),

  mapValues: transform({
    usage:
      'mapValues(columns, mapping, matchCase = false): replace whole values using a mapping, like {"NY": "New York", "N.Y.": "New York"}. Spaces at the ends are ignored when matching.',
    params: z.object({
      columns: columnsSpec,
      mapping: z
        .record(z.string().max(500), z.string().max(500))
        .refine(
          (m) => Object.keys(m).length > 0 && Object.keys(m).length <= 500,
          "mapping needs 1 to 500 entries"
        ),
      matchCase: z.boolean().default(false)
    }),
    apply: (ctx, p) => {
      const key = (v: string) =>
        p.matchCase ? v.trim() : v.trim().toLowerCase();
      const mapping = new Map(
        Object.entries(p.mapping).map(([from, to]) => [key(from), to])
      );
      mapCells(ctx, p.columns, (v) => mapping.get(key(v)) ?? v);
    }
  })
};
