import Papa from "papaparse";

/** Largest CSV a user can upload, in bytes. */
export const MAX_CSV_BYTES = 5 * 1024 * 1024;

/** Most columns we profile. Wider files are rejected so the profile stays small. */
export const MAX_COLUMNS = 500;

export type Encoding = "utf-8" | "utf-16le" | "utf-16be" | "windows-1252";

export interface DecodedText {
  text: string;
  encoding: Encoding;
  /** True when the file started with a byte order mark, which many tools show as junk in the first header. */
  hadBom: boolean;
}

// Windows-1252 differs from Latin-1 only in 0x80–0x9F. Undefined bytes keep their Latin-1 code point.
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c,
  0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d,
  0x017e, 0x0178
];

function decodeWindows1252(bytes: Uint8Array): string {
  let out = "";
  // Build in slices: String.fromCharCode with one argument per byte is slow for megabytes.
  const chunk: number[] = [];
  for (const byte of bytes) {
    chunk.push(byte >= 0x80 && byte <= 0x9f ? CP1252_HIGH[byte - 0x80] : byte);
    if (chunk.length === 8192) {
      out += String.fromCharCode(...chunk);
      chunk.length = 0;
    }
  }
  return out + String.fromCharCode(...chunk);
}

/**
 * Decodes file bytes to text.
 * Uses the byte order mark when present, then UTF-8, and falls back to Windows-1252
 * (the usual encoding of CSVs saved by older Excel versions) when the bytes are not valid UTF-8.
 */
export function decodeCsvBytes(bytes: Uint8Array): DecodedText {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return {
      text: new TextDecoder("utf-8").decode(bytes.subarray(3)),
      encoding: "utf-8",
      hadBom: true
    };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return {
      text: new TextDecoder("utf-16le").decode(bytes.subarray(2)),
      encoding: "utf-16le",
      hadBom: true
    };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return {
      text: new TextDecoder("utf-16be").decode(bytes.subarray(2)),
      encoding: "utf-16be",
      hadBom: true
    };
  }
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      encoding: "utf-8",
      hadBom: false
    };
  } catch {
    return {
      text: decodeWindows1252(bytes),
      encoding: "windows-1252",
      hadBom: false
    };
  }
}

export type ParseProblem = "unclosed_quote" | "bad_quote";

export interface ParsedCsv {
  /** All records, header first. Each record is a list of raw cell values. */
  rows: string[][];
  delimiter: string;
  /** Quote problems found by the parser, with the 1-based record numbers where they happened. */
  problems: { code: ParseProblem; rows: number[] }[];
}

/** Thrown when a file cannot be used at all. The message is safe to show to the user. */
export class CsvError extends Error {}

/** Parses CSV text. Detects the delimiter (comma, semicolon, tab, or pipe) and handles quoted fields with newlines. */
export function parseCsv(text: string): ParsedCsv {
  if (text.trim() === "") throw new CsvError("The file is empty.");

  const result = Papa.parse<string[]>(text, {
    delimitersToGuess: [",", ";", "\t", "|"],
    skipEmptyLines: false
  });

  const rows = result.data;
  // A final newline gives one extra record with a single empty cell; it is not a real row.
  const last = rows[rows.length - 1];
  if (rows.length > 1 && last.length === 1 && last[0] === "") rows.pop();

  const problemRows = new Map<ParseProblem, number[]>();
  for (const error of result.errors) {
    const code: ParseProblem | null =
      error.code === "MissingQuotes"
        ? "unclosed_quote"
        : error.code === "InvalidQuotes"
          ? "bad_quote"
          : null;
    if (!code) continue;
    const list = problemRows.get(code) ?? [];
    if (typeof error.row === "number") list.push(error.row + 1);
    problemRows.set(code, list);
  }

  let width = 0;
  for (const row of rows) width = Math.max(width, row.length);
  if (width > MAX_COLUMNS) {
    throw new CsvError(
      `The file has ${width} columns. DataCobbler supports up to ${MAX_COLUMNS}.`
    );
  }

  return {
    rows,
    delimiter: result.meta.delimiter,
    problems: [...problemRows].map(([code, list]) => ({ code, rows: list }))
  };
}
