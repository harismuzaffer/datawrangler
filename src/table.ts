/** A CSV as the pipeline sees it: unique column names and rows that all have one cell per column. */
export interface Table {
  columns: string[];
  rows: string[][];
}

/**
 * Turns raw header cells into names that steps can refer to: never empty, never repeated.
 * An empty header becomes "Column N"; a repeated name gets a number, like "Price (2)".
 */
export function columnNames(header: string[], width = header.length): string[] {
  const names: string[] = [];
  const used = new Set<string>();
  for (let c = 0; c < width; c++) {
    const base = (header[c] ?? "").trim() || `Column ${c + 1}`;
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base} (${n})`;
    used.add(name);
    names.push(name);
  }
  return names;
}

/** Builds a table from parsed records (header first). Short rows are padded so every row has every column. */
export function tableFromRecords(records: string[][]): Table {
  const [header = [], ...data] = records;
  let width = header.length;
  for (const row of data) width = Math.max(width, row.length);
  const rows = data.map((row) =>
    row.length === width
      ? row
      : [...row, ...Array<string>(width - row.length).fill("")]
  );
  return { columns: columnNames(header, width), rows };
}

/** Copies a table so a pipeline run can change it in place without touching the original. */
export function cloneTable(table: Table): Table {
  return {
    columns: [...table.columns],
    rows: table.rows.map((row) => [...row])
  };
}

const PLAIN_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Reads a cell as a number, or returns null. Only plain numbers count; "$1,200" needs normalizing first. */
export function parseNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!PLAIN_NUMBER.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * Writes a number back to a cell.
 * With `decimals`, uses exactly that many. Without, rounds away floating-point noise (0.1 + 0.2 gives "0.3").
 */
export function formatNumber(n: number, decimals?: number): string {
  if (decimals !== undefined) return n.toFixed(decimals);
  const rounded = Number(n.toFixed(10));
  return Object.is(rounded, -0) ? "0" : String(rounded);
}
