import { describe, expect, it } from "vitest";
import { decodeCsvBytes, parseCsv } from "./csv";
import {
  profileCsv,
  type ColumnProfile,
  type DatasetProfile,
  type IssueCode
} from "./profile";

function profile(text: string): DatasetProfile {
  const decoded = decodeCsvBytes(new TextEncoder().encode(text));
  return profileCsv(parseCsv(decoded.text), decoded);
}

/** Profiles a single column given its header and values. */
function column(name: string, values: string[]): ColumnProfile {
  const quoted = values.map((v) =>
    /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
  );
  return profile([name, ...quoted].join("\n")).columns[0];
}

const codes = (issues: { code: IssueCode }[]) => issues.map((i) => i.code);
const issue = (col: ColumnProfile, code: IssueCode) =>
  col.issues.find((i) => i.code === code);

describe("column types", () => {
  it.each([
    ["integer", ["1", "-2", "30"]],
    ["decimal", ["1.5", "2", "-0.25", "1e3"]],
    ["boolean", ["yes", "no", "yes"]],
    ["date", ["2024-01-15", "2024-02-01"]],
    ["text", ["Ann", "Bob", "Cy"]],
    ["empty", ["", "  ", ""]]
  ])("detects %s", (type, values) => {
    expect(column("c", values).type).toBe(type);
  });

  it("ignores empty cells and missing-data placeholders when picking the type", () => {
    const col = column("n", ["1", "", "N/A", "3", "null"]);
    expect(col.type).toBe("integer");
    expect(col.empty).toBe(1);
    expect(issue(col, "null_markers")?.count).toBe(2);
  });

  it("records min and max for numbers", () => {
    expect(column("n", ["5", "-1.5", "10"])).toMatchObject({
      type: "decimal",
      min: -1.5,
      max: 10
    });
  });

  it("does not mistake phone numbers with spaces for numbers", () => {
    expect(
      column("phone", ["555 1234", "+1 555 123 4567", "555 9876"]).type
    ).toBe("text");
  });

  it("does not flag a few numbers in a text column", () => {
    const col = column("name", ["Ann", "Bob", "123", "Cy"]);
    expect(col.type).toBe("text");
    expect(codes(col.issues)).not.toContain("mixed_types");
  });
});

describe("column issues", () => {
  it("finds spaces at the start or end, with row numbers", () => {
    const col = column("name", ["Ann", " Bob", "Cy "]);
    expect(issue(col, "whitespace")).toMatchObject({ count: 2, rows: [3, 4] });
  });

  it("finds repeated spaces inside values", () => {
    expect(
      issue(column("name", ["Ann  Lee", "Bob Ray"]), "repeated_spaces")?.count
    ).toBe(1);
  });

  it("finds invisible characters, but not plain spaces", () => {
    const col = column("name", ["Ann\u{200B}", "Bob", "\u{A0}", "   "]);
    expect(issue(col, "invisible_chars")?.count).toBe(2);
  });

  it("flags stray values in a typed column", () => {
    const col = column("age", ["30", "41", "unknown", "25"]);
    expect(col.type).toBe("integer");
    expect(issue(col, "mixed_types")).toMatchObject({
      count: 1,
      rows: [4],
      examples: ["unknown"]
    });
  });

  it("finds numbers with separators, currency, percent signs, or decimal commas", () => {
    const col = column("price", ["$1,200.50", "3,5", "40%", "12", "€ 7"]);
    expect(col.type).toBe("decimal");
    expect(issue(col, "number_format")?.count).toBe(4);
  });

  it("treats formatted whole numbers as integers", () => {
    expect(column("count", ["1,234", "5,678,900", "12"]).type).toBe("integer");
  });

  it("finds mixed date formats", () => {
    const col = column("when", ["2024-01-15", "15/01/2024", "Jan 3, 2024"]);
    expect(col.type).toBe("date");
    expect(issue(col, "mixed_date_formats")?.count).toBe(3);
  });

  it("treats day-first and month-first dates with the same separator as two formats", () => {
    const col = column("when", ["25/01/2024", "01/25/2024"]);
    expect(issue(col, "mixed_date_formats")?.count).toBe(2);
    expect(issue(col, "ambiguous_dates")).toBeUndefined();
  });

  it("flags dates that could be day-month or month-day", () => {
    const col = column("when", ["03/04/2024", "05/06/2024"]);
    expect(issue(col, "ambiguous_dates")).toBeDefined();
    expect(issue(col, "mixed_date_formats")).toBeUndefined();
  });

  it("does not treat impossible dates as dates", () => {
    expect(column("when", ["2024-13-45", "99/99/2024"]).type).toBe("text");
  });

  it("finds yes/no values written in different ways", () => {
    const col = column("active", ["yes", "Yes", "no", "true"]);
    expect(col.type).toBe("boolean");
    expect(issue(col, "mixed_booleans")?.count).toBe(4);
  });

  it("finds the same text in different letter cases", () => {
    const col = column("city", ["Paris", "paris", "Rome", "PARIS", "Oslo"]);
    expect(issue(col, "inconsistent_case")).toMatchObject({
      count: 1,
      examples: ["Paris / paris / PARIS"]
    });
  });

  it("reports an empty column", () => {
    expect(codes(column("c", ["", ""]).issues)).toContain("empty_column");
  });
});

describe("file issues", () => {
  it("reports a byte order mark and a non-UTF-8 encoding", () => {
    const bom = profileCsv(parseCsv("a\n1"), {
      encoding: "utf-8",
      hadBom: true
    });
    const latin = profileCsv(parseCsv("a\n1"), {
      encoding: "windows-1252",
      hadBom: false
    });
    expect(codes(bom.issues)).toEqual(["bom"]);
    expect(codes(latin.issues)).toEqual(["encoding"]);
  });

  it("reports empty and duplicate column names, and names empty columns", () => {
    const p = profile("id,,Name,name\n1,2,3,4");
    expect(codes(p.issues)).toEqual(["empty_header", "duplicate_header"]);
    expect(p.columns.map((c) => c.name)).toEqual([
      "id",
      "Column 2",
      "Name",
      "name"
    ]);
  });

  it("reports ragged, empty, and duplicate rows with row numbers", () => {
    const p = profile("a,b\n1,2\n1,2\n\n3\n,\n1,2\n");
    const byCode = Object.fromEntries(p.issues.map((i) => [i.code, i]));
    expect(byCode.ragged_rows).toMatchObject({ count: 1, rows: [5] });
    expect(byCode.empty_rows).toMatchObject({ count: 2, rows: [4, 6] });
    expect(byCode.duplicate_rows).toMatchObject({ count: 2, rows: [3, 7] });
  });

  it("counts columns from the widest row", () => {
    expect(profile("a,b\n1,2,3").columnCount).toBe(3);
  });

  it("returns row and column counts, delimiter, and sample rows", () => {
    const p = profile("a;b\n1;x\n2;y");
    expect(p).toMatchObject({
      rowCount: 2,
      columnCount: 2,
      delimiter: ";",
      issues: []
    });
    expect(p.sampleRows).toEqual([
      ["1", "x"],
      ["2", "y"]
    ]);
  });

  it("shortens long values so the profile stays small", () => {
    const p = profile(`note\n${"x".repeat(500)}`);
    expect(p.columns[0].samples[0].length).toBeLessThanOrEqual(61);
    expect(p.sampleRows[0][0].length).toBeLessThanOrEqual(61);
  });
});
