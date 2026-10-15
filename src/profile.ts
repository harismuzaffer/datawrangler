import type { Encoding, ParsedCsv } from "./csv";

export type ColumnType =
  | "empty"
  | "integer"
  | "decimal"
  | "boolean"
  | "date"
  | "text";

export type IssueCode =
  // File level
  | "bom"
  | "encoding"
  | "unclosed_quote"
  | "bad_quote"
  | "empty_header"
  | "duplicate_header"
  | "ragged_rows"
  | "empty_rows"
  | "duplicate_rows"
  // Column level
  | "empty_column"
  | "whitespace"
  | "repeated_spaces"
  | "invisible_chars"
  | "null_markers"
  | "mixed_types"
  | "number_format"
  | "mixed_date_formats"
  | "ambiguous_dates"
  | "mixed_booleans"
  | "inconsistent_case";

export interface Issue {
  code: IssueCode;
  /** Plain-language description built by code, never by the LLM. */
  message: string;
  /** How many cells, rows, or groups are affected. */
  count: number;
  /** Up to five 1-based row numbers, where the header is row 1. */
  rows: number[];
  /** Up to three raw values from the file, shortened. */
  examples: string[];
}

export interface ColumnProfile {
  index: number;
  name: string;
  type: ColumnType;
  filled: number;
  empty: number;
  distinct: number;
  /** True when there were more distinct values than we count. */
  distinctCapped: boolean;
  /** Up to five distinct values, shortened. */
  samples: string[];
  min?: number;
  max?: number;
  dateFormats?: string[];
  issues: Issue[];
}

export interface DatasetProfile {
  rowCount: number;
  columnCount: number;
  delimiter: string;
  encoding: Encoding;
  issues: Issue[];
  columns: ColumnProfile[];
  /** The first rows of data, shortened, so the LLM and the UI can show what the file looks like. */
  sampleRows: string[][];
}

const MAX_EXAMPLES = 3;
const MAX_ROWS_LISTED = 5;
const MAX_SAMPLES = 5;
const SAMPLE_ROWS = 5;
const MAX_DISTINCT = 10_000;
const MAX_CASE_GROUPS = 5_000;
// Long values would make the profile large; the LLM and UI only need a glimpse.
const MAX_VALUE_LENGTH = 60;

const NULL_MARKERS = new Set([
  "n/a",
  "na",
  "#n/a",
  "null",
  "none",
  "nil",
  "nan",
  "undefined",
  "missing",
  "-",
  "--",
  "?"
]);

// Control characters other than tab and line breaks, invisible format characters (zero-width spaces, BOM, bidi marks),
// and the no-break space, which looks like a space but does not match one.
const INVISIBLE = /(?![\t\n\r])\p{Cc}|\p{Cf}|\u{A0}/u;
const REPEATED_SPACES = /\S(?: {2,}|\t)\S/;
const INTEGER = /^[+-]?\d+$/;
const DECIMAL = /^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/;
const LEADING_CURRENCY = /^([+-]?)\s*[$€£¥]\s*/;
const TRAILING_CURRENCY_OR_PERCENT = /\s*[$€£¥%]$/;
// Each pattern says whether a match has a fractional part.
const FORMATTED_NUMBER: [RegExp, (value: string) => boolean][] = [
  [/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/, (v) => v.includes(".")], // 1,234.56
  [/^[+-]?\d{1,3}(?:\.\d{3})+(?:,\d+)?$/, (v) => v.includes(",")], // 1.234,56
  [/^[+-]?\d+,\d+$/, () => true], // 12,5 (1,234 is caught above as thousands)
  [/^[+-]?\d+(?:\.\d+)?$/, (v) => v.includes(".")] // 12.5 after removing a currency or percent sign
];
const BOOLEAN_TRUE = new Set(["true", "yes", "y", "t"]);
const BOOLEAN_FALSE = new Set(["false", "no", "n", "f"]);
const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";
const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const ISO_DATETIME =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
const YEAR_FIRST_SLASH = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/;
const NUMERIC_DATE = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})$/;
const DAY_MONTH_NAME = new RegExp(
  `^\\d{1,2}[ -](?:${MONTHS})[a-z]*\\.?[ -,]+\\d{4}$`,
  "i"
);
const MONTH_NAME_DAY = new RegExp(
  `^(?:${MONTHS})[a-z]*\\.? \\d{1,2},? \\d{4}$`,
  "i"
);

type ValueClass =
  | "integer"
  | "decimal"
  | "formatted"
  | "boolean"
  | "date"
  | "text";

interface DateMatch {
  format: string;
  /** For dd/mm vs mm/dd: which part is known to be the day, if either. */
  dayFirst?: boolean;
  monthFirst?: boolean;
}

function validDayMonth(day: number, month: number): boolean {
  return day >= 1 && day <= 31 && month >= 1 && month <= 12;
}

function matchDate(value: string): DateMatch | null {
  let m = ISO_DATE.exec(value);
  if (m)
    return validDayMonth(Number(m[3]), Number(m[2]))
      ? { format: "YYYY-MM-DD" }
      : null;
  if (ISO_DATETIME.test(value)) return { format: "ISO date-time" };
  m = YEAR_FIRST_SLASH.exec(value);
  if (m)
    return validDayMonth(Number(m[3]), Number(m[2]))
      ? { format: "YYYY/MM/DD" }
      : null;
  m = NUMERIC_DATE.exec(value);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[3]);
    if (!validDayMonth(a, b) && !validDayMonth(b, a)) return null;
    const sep = m[2];
    const year = m[4].length === 4 ? "YYYY" : "YY";
    return {
      format: `NN${sep}NN${sep}${year}`,
      dayFirst: a > 12,
      monthFirst: b > 12
    };
  }
  if (DAY_MONTH_NAME.test(value)) return { format: "D Mon YYYY" };
  if (MONTH_NAME_DAY.test(value)) return { format: "Mon D, YYYY" };
  return null;
}

function classify(value: string): {
  cls: ValueClass;
  date?: DateMatch;
  fraction?: boolean;
} {
  if (INTEGER.test(value)) return { cls: "integer" };
  if (DECIMAL.test(value)) return { cls: "decimal" };
  const lower = value.toLowerCase();
  if (BOOLEAN_TRUE.has(lower) || BOOLEAN_FALSE.has(lower))
    return { cls: "boolean" };
  const date = matchDate(value);
  if (date) return { cls: "date", date };
  const stripped = value
    .replace(LEADING_CURRENCY, "$1")
    .replace(TRAILING_CURRENCY_OR_PERCENT, "");
  for (const [pattern, hasFraction] of FORMATTED_NUMBER) {
    if (pattern.test(stripped))
      return { cls: "formatted", fraction: hasFraction(stripped) };
  }
  return { cls: "text" };
}

function clip(value: string): string {
  return value.length > MAX_VALUE_LENGTH
    ? `${value.slice(0, MAX_VALUE_LENGTH)}…`
    : value;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Collects the count, row numbers, and examples for one issue while scanning. */
function tally() {
  const t = {
    count: 0,
    rows: [] as number[],
    examples: [] as string[],
    add(row: number, example?: string) {
      t.count++;
      if (t.rows.length < MAX_ROWS_LISTED) t.rows.push(row);
      if (
        example !== undefined &&
        t.examples.length < MAX_EXAMPLES &&
        !t.examples.includes(clip(example))
      ) {
        t.examples.push(clip(example));
      }
    },
    toIssue(code: IssueCode, message: string): Issue | null {
      return t.count === 0
        ? null
        : { code, message, count: t.count, rows: t.rows, examples: t.examples };
    }
  };
  return t;
}

function compact(issues: (Issue | null)[]): Issue[] {
  return issues.filter((issue): issue is Issue => issue !== null);
}

function profileColumn(
  index: number,
  name: string,
  data: string[][]
): ColumnProfile {
  const whitespace = tally();
  const repeatedSpaces = tally();
  const invisible = tally();
  const nullMarkers = tally();
  const formatted = tally();
  const classCounts: Record<ValueClass, number> = {
    integer: 0,
    decimal: 0,
    formatted: 0,
    boolean: 0,
    date: 0,
    text: 0
  };
  const firstOfClass = new Map<ValueClass, { row: number; value: string }[]>();
  const dateFormats = new Map<string, number>();
  let dayFirst = false;
  let monthFirst = false;
  const trueSpellings = new Set<string>();
  const falseSpellings = new Set<string>();
  const distinct = new Set<string>();
  let distinctCapped = false;
  const caseGroups = new Map<string, Set<string>>();
  const caseRows = new Map<string, number>();
  let empty = 0;
  let formattedFraction = false;
  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < data.length; i++) {
    const row = i + 2;
    const raw = data[i][index] ?? "";
    const value = raw.trim();
    if (value === "") {
      empty++;
      if (INVISIBLE.test(raw)) invisible.add(row, raw);
      continue;
    }

    if (distinct.size < MAX_DISTINCT) distinct.add(raw);
    else if (!distinct.has(raw)) distinctCapped = true;

    if (raw !== value) whitespace.add(row, raw);
    if (REPEATED_SPACES.test(value)) repeatedSpaces.add(row, raw);
    if (INVISIBLE.test(raw)) invisible.add(row, raw);
    if (NULL_MARKERS.has(value.toLowerCase())) {
      nullMarkers.add(row, value);
      continue;
    }

    const { cls, date, fraction } = classify(value);
    classCounts[cls]++;
    const firsts = firstOfClass.get(cls) ?? [];
    if (firsts.length < MAX_ROWS_LISTED) firsts.push({ row, value: raw });
    firstOfClass.set(cls, firsts);

    if (cls === "integer" || cls === "decimal") {
      const n = Number(value);
      if (n < min) min = n;
      if (n > max) max = n;
    } else if (cls === "formatted") {
      formatted.add(row, raw);
      formattedFraction ||= Boolean(fraction);
    } else if (cls === "date" && date) {
      dateFormats.set(date.format, (dateFormats.get(date.format) ?? 0) + 1);
      dayFirst ||= Boolean(date.dayFirst);
      monthFirst ||= Boolean(date.monthFirst);
    } else if (cls === "boolean") {
      (BOOLEAN_TRUE.has(value.toLowerCase())
        ? trueSpellings
        : falseSpellings
      ).add(value);
    } else if (cls === "text") {
      const key = value.toLowerCase();
      const group = caseGroups.get(key);
      if (group) group.add(value);
      else if (caseGroups.size < MAX_CASE_GROUPS) {
        caseGroups.set(key, new Set([value]));
        caseRows.set(key, row);
      }
    }
  }

  const typed = data.length - empty - nullMarkers.count;
  const numeric =
    classCounts.integer + classCounts.decimal + classCounts.formatted;
  const candidates: [ColumnType | "numeric", number][] = [
    ["numeric", numeric],
    ["boolean", classCounts.boolean],
    ["date", classCounts.date],
    ["text", classCounts.text]
  ];
  // Ties go to the earlier, more specific type.
  const [winner, winnerCount] = candidates.reduce((best, next) =>
    next[1] > best[1] ? next : best
  );
  const type: ColumnType =
    typed === 0
      ? "empty"
      : winner === "numeric"
        ? classCounts.decimal > 0 || formattedFraction
          ? "decimal"
          : "integer"
        : winner;

  const issues: (Issue | null)[] = [];
  if (type === "empty") {
    issues.push({
      code: "empty_column",
      message: "This column has no values.",
      count: data.length,
      rows: [],
      examples: []
    });
  }
  issues.push(
    whitespace.toIssue(
      "whitespace",
      `${plural(whitespace.count, "value")} with spaces at the start or end.`
    ),
    repeatedSpaces.toIssue(
      "repeated_spaces",
      `${plural(repeatedSpaces.count, "value")} with repeated spaces or tabs inside.`
    ),
    invisible.toIssue(
      "invisible_chars",
      `${plural(invisible.count, "value")} with invisible characters.`
    ),
    nullMarkers.toIssue(
      "null_markers",
      `${plural(nullMarkers.count, "value")} that look like placeholders for missing data (for example N/A or null).`
    )
  );

  // A text column with a few numbers in it is normal (names, codes); only flag stray values in typed columns.
  if (type !== "empty" && type !== "text" && winnerCount < typed) {
    const stray = tally();
    for (const [cls, firsts] of firstOfClass) {
      const isWinner =
        winner === "numeric"
          ? cls === "integer" || cls === "decimal" || cls === "formatted"
          : cls === winner;
      if (isWinner) continue;
      for (const { row, value } of firsts) stray.add(row, value);
    }
    issues.push({
      code: "mixed_types",
      message: `${plural(typed - winnerCount, "value")} that do not look like the column type (${type}).`,
      count: typed - winnerCount,
      rows: stray.rows.sort((a, b) => a - b),
      examples: stray.examples
    });
  }

  if (winner === "numeric") {
    issues.push(
      formatted.toIssue(
        "number_format",
        `${plural(formatted.count, "number")} written with thousands separators, currency or percent signs, or a decimal comma.`
      )
    );
  }

  if (type === "date") {
    // dd/mm and mm/dd evidence in one column means two formats, even with the same separators.
    const formatCount = dateFormats.size + (dayFirst && monthFirst ? 1 : 0);
    if (formatCount > 1) {
      issues.push({
        code: "mixed_date_formats",
        message: `Dates are written in ${formatCount} different formats.`,
        count: formatCount,
        rows: [],
        examples: [...dateFormats.keys()]
      });
    }
    const hasNumericDayMonth = [...dateFormats.keys()].some((f) =>
      f.startsWith("NN")
    );
    if (hasNumericDayMonth && !dayFirst && !monthFirst) {
      issues.push({
        code: "ambiguous_dates",
        message:
          "Dates like 03/04 could be day-month or month-day. The user needs to say which.",
        count: classCounts.date,
        rows: [],
        examples: []
      });
    }
  }

  if (
    type === "boolean" &&
    (trueSpellings.size > 1 || falseSpellings.size > 1)
  ) {
    const spellings = [...trueSpellings, ...falseSpellings];
    issues.push({
      code: "mixed_booleans",
      message: `Yes/no values are written ${spellings.length} different ways.`,
      count: spellings.length,
      rows: [],
      examples: spellings.slice(0, MAX_EXAMPLES).map(clip)
    });
  }

  if (type === "text") {
    const caseTally = tally();
    for (const [key, group] of caseGroups) {
      if (group.size > 1)
        caseTally.add(
          caseRows.get(key) ?? 0,
          [...group].slice(0, 3).join(" / ")
        );
    }
    issues.push(
      caseTally.toIssue(
        "inconsistent_case",
        `${plural(caseTally.count, "value")} written in more than one letter case.`
      )
    );
  }

  const samples = [...distinct].slice(0, MAX_SAMPLES).map(clip);
  return {
    index,
    name,
    type,
    filled: data.length - empty,
    empty,
    distinct: distinct.size,
    distinctCapped,
    samples,
    ...(min <= max ? { min, max } : {}),
    ...(type === "date" ? { dateFormats: [...dateFormats.keys()] } : {}),
    issues: compact(issues)
  };
}

/** Builds a profile of a parsed CSV: column types, counts, samples, and detected issues. Treats row 1 as the header. */
export function profileCsv(
  parsed: ParsedCsv,
  decoded: { encoding: Encoding; hadBom: boolean }
): DatasetProfile {
  const [header = [], ...data] = parsed.rows;
  let width = header.length;
  for (const row of data) width = Math.max(width, row.length);

  const fileIssues: (Issue | null)[] = [];
  if (decoded.hadBom) {
    fileIssues.push({
      code: "bom",
      message:
        "The file starts with a hidden byte order mark. It was removed when reading the file.",
      count: 1,
      rows: [1],
      examples: []
    });
  }
  if (decoded.encoding === "windows-1252") {
    fileIssues.push({
      code: "encoding",
      message:
        "The file is not UTF-8. It was read as Windows-1252, so check accented letters and symbols.",
      count: 1,
      rows: [],
      examples: []
    });
  }
  for (const problem of parsed.problems) {
    fileIssues.push({
      code: problem.code,
      message:
        problem.code === "unclosed_quote"
          ? "A quoted value is never closed, so the rest of the file may be read as one value."
          : "Some quote marks are in unexpected places.",
      count: problem.rows.length,
      rows: problem.rows.slice(0, MAX_ROWS_LISTED),
      examples: []
    });
  }

  const names: string[] = [];
  const emptyHeaders = tally();
  const duplicateHeaders = tally();
  const seenNames = new Set<string>();
  for (let c = 0; c < width; c++) {
    const raw = (header[c] ?? "").trim();
    if (raw === "") emptyHeaders.add(1, `column ${c + 1}`);
    const key = raw.toLowerCase();
    if (raw !== "" && seenNames.has(key)) duplicateHeaders.add(1, raw);
    seenNames.add(key);
    names.push(raw === "" ? `Column ${c + 1}` : raw);
  }
  fileIssues.push(
    emptyHeaders.toIssue(
      "empty_header",
      `${plural(emptyHeaders.count, "column")} without a name.`
    ),
    duplicateHeaders.toIssue(
      "duplicate_header",
      `${plural(duplicateHeaders.count, "column name")} used more than once.`
    )
  );

  const ragged = tally();
  const emptyRows = tally();
  const duplicates = tally();
  const seenRows = new Set<string>();
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (row.every((cell) => cell.trim() === "")) {
      emptyRows.add(i + 2);
      continue;
    }
    if (row.length !== header.length) ragged.add(i + 2, `${row.length} values`);
    const key = JSON.stringify(row);
    if (seenRows.has(key)) duplicates.add(i + 2);
    else seenRows.add(key);
  }
  fileIssues.push(
    ragged.toIssue(
      "ragged_rows",
      `${plural(ragged.count, "row")} with a different number of values than the header (${header.length}).`
    ),
    emptyRows.toIssue(
      "empty_rows",
      `${plural(emptyRows.count, "row")} with no values.`
    ),
    duplicates.toIssue(
      "duplicate_rows",
      `${plural(duplicates.count, "row")} that exactly repeat an earlier row.`
    )
  );

  return {
    rowCount: data.length,
    columnCount: width,
    delimiter: parsed.delimiter,
    encoding: decoded.encoding,
    issues: compact(fileIssues),
    columns: names.map((name, c) => profileColumn(c, name, data)),
    sampleRows: data.slice(0, SAMPLE_ROWS).map((row) => row.map(clip))
  };
}
