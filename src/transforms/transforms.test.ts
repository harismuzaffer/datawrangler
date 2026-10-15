import { describe, expect, it } from "vitest";
import { tableFromRecords, type Table } from "../table";
import {
  createContext,
  StepError,
  TRANSFORMS,
  type TransformName
} from "./index";
import { normalizeNumber, parseDate } from "./values";

function table(csv: string[][]): Table {
  return tableFromRecords(csv);
}

function run(op: TransformName, params: unknown, input: Table) {
  const ctx = createContext(input);
  TRANSFORMS[op].apply(ctx, params);
  return { table: ctx.table, result: ctx.result };
}

const people = () =>
  table([
    ["name", "city", "age"],
    [" Ann ", "Paris", "30"],
    ["Bob", "paris", ""],
    ["Cy  Lee", "N/A", "41"]
  ]);

describe("columns and validation", () => {
  it("rejects unknown columns with the list of real ones", () => {
    expect(() => run("trim", { columns: ["nope"] }, people())).toThrow(
      StepError
    );
    expect(() => run("trim", { columns: ["nope"] }, people())).toThrow(
      /Columns are: name, city, age/
    );
  });

  it("finds a column when only the letter case differs", () => {
    expect(
      run("trim", { columns: ["NAME"] }, people()).result.cellsChanged
    ).toBe(1);
  });

  it("rejects bad parameters", () => {
    expect(() =>
      run("changeCase", { columns: ["name"], case: "shout" }, people())
    ).toThrow();
    expect(() => run("trim", {}, people())).toThrow();
  });

  it("records changed cells with spreadsheet row numbers", () => {
    const { result } = run("trim", { columns: "*" }, people());
    expect(result.cellsChanged).toBe(1);
    expect(result.examples).toEqual([
      { row: 2, column: "name", before: " Ann ", after: "Ann" }
    ]);
  });
});

describe("text", () => {
  it("collapses repeated spaces and tabs", () => {
    const t = table([["a"], ["x  y\tz"]]);
    expect(run("collapseSpaces", { columns: ["a"] }, t).table.rows[0][0]).toBe(
      "x y z"
    );
  });

  it("removes invisible characters and turns no-break spaces into spaces", () => {
    const t = table([["a"], ["A\u{200B}nn\u{A0}Lee"], ["line\nbreak"]]);
    const { table: out, result } = run(
      "removeInvisible",
      { columns: ["a"] },
      t
    );
    expect(out.rows.map((r) => r[0])).toEqual(["Ann Lee", "line\nbreak"]);
    expect(result.cellsChanged).toBe(1);
  });

  it.each([
    ["lower", "mary-ann o'neil"],
    ["upper", "MARY-ANN O'NEIL"],
    ["title", "Mary-Ann O'Neil"]
  ])("changes case to %s", (mode, expected) => {
    const t = table([["a"], ["mARY-ann o'neil"]]);
    expect(
      run("changeCase", { columns: ["a"], case: mode }, t).table.rows[0][0]
    ).toBe(expected);
  });

  it("finds and replaces plain text, treating pattern characters literally", () => {
    const t = table([["a"], ["a.b.c"], ["A.B"]]);
    const out = run(
      "findReplace",
      { columns: ["a"], find: ".", replace: "$&-" },
      t
    ).table;
    expect(out.rows.map((r) => r[0])).toEqual(["a$&-b$&-c", "A$&-B"]);
  });

  it("finds whole values without matching case", () => {
    const t = table([["a"], ["usa"], ["USA team"]]);
    const out = run(
      "findReplace",
      {
        columns: ["a"],
        find: "USA",
        replace: "United States",
        matchCase: false,
        wholeValue: true
      },
      t
    ).table;
    expect(out.rows.map((r) => r[0])).toEqual(["United States", "USA team"]);
  });
});

describe("missing values", () => {
  it("empties placeholder values", () => {
    const { table: out, result } = run(
      "standardizeNulls",
      { columns: ["city"] },
      people()
    );
    expect(out.rows[2][1]).toBe("");
    expect(result.cellsChanged).toBe(1);
  });

  it("uses custom placeholder markers", () => {
    const t = table([["a"], ["unknown"], ["N/A"]]);
    expect(
      run(
        "standardizeNulls",
        { columns: ["a"], markers: ["Unknown"] },
        t
      ).table.rows.map((r) => r[0])
    ).toEqual(["", "N/A"]);
  });

  it("fills empty cells with a value", () => {
    expect(
      run("fillEmpty", { columns: ["age"], value: "0" }, people()).table
        .rows[1][2]
    ).toBe("0");
  });

  it("fills down from the row above", () => {
    const t = table([["g"], ["A"], [""], [" "], ["B"], [""]]);
    expect(
      run("fillDown", { columns: ["g"] }, t).table.rows.map((r) => r[0])
    ).toEqual(["A", "A", "A", "B", "B"]);
  });
});

describe("dates", () => {
  it.each([
    ["2024-01-15", ["YYYY-MM-DD"], "2024-01-15"],
    ["2024/1/5", ["YYYY-MM-DD"], "2024-01-05"],
    ["15/01/2024", ["DD/MM/YYYY"], "2024-01-15"],
    ["15.01.24", ["DD/MM/YYYY"], "2024-01-15"],
    ["01-15-2024", ["MM/DD/YYYY"], "2024-01-15"],
    ["3 Jan 2024", ["D Mon YYYY"], "2024-01-03"],
    ["15-Sept-1999", ["D Mon YYYY"], "1999-09-15"],
    ["January 3, 2024", ["Mon D, YYYY"], "2024-01-03"],
    ["31/12/75", ["DD/MM/YYYY"], "1975-12-31"]
  ] as const)("reads %s", (value, formats, expected) => {
    expect(parseDate(value, formats)).toBe(expected);
  });

  it("tries formats in order", () => {
    expect(parseDate("03/04/2024", ["DD/MM/YYYY", "MM/DD/YYYY"])).toBe(
      "2024-04-03"
    );
    expect(parseDate("03/04/2024", ["MM/DD/YYYY", "DD/MM/YYYY"])).toBe(
      "2024-03-04"
    );
    expect(parseDate("25/01/2024", ["MM/DD/YYYY", "DD/MM/YYYY"])).toBe(
      "2024-01-25"
    );
  });

  it("rejects impossible dates and other text", () => {
    expect(parseDate("31/04/2024", ["DD/MM/YYYY"])).toBeNull();
    expect(parseDate("29/02/2023", ["DD/MM/YYYY"])).toBeNull();
    expect(parseDate("2024-01-15T10:00", ["YYYY-MM-DD"])).toBeNull();
    expect(parseDate("soon", ["YYYY-MM-DD", "DD/MM/YYYY"])).toBeNull();
  });

  it("leaves unreadable dates unchanged and counts them as failed", () => {
    const t = table([["d"], ["15/01/2024"], ["someday"], [""]]);
    const { table: out, result } = run(
      "parseDate",
      { columns: ["d"], formats: ["DD/MM/YYYY"] },
      t
    );
    expect(out.rows.map((r) => r[0])).toEqual(["2024-01-15", "someday", ""]);
    expect(result).toMatchObject({
      cellsChanged: 1,
      failed: 1,
      failedExamples: ["someday"]
    });
  });
});

describe("numbers and booleans", () => {
  it.each([
    ["$1,200.50", ".", "1200.50"],
    ["1.234,5", ",", "1234.5"],
    ["€ 7", ".", "7"],
    ["40%", ".", "40"],
    ["(30)", ".", "-30"],
    ["-1,000", ".", "-1000"],
    ["+12", ".", "12"],
    ["12,5", ",", "12.5"]
  ] as const)("normalizes %s", (value, sep, expected) => {
    expect(normalizeNumber(value, sep)).toBe(expected);
  });

  it.each([
    ["12,5", "."],
    ["1,23,4", "."],
    ["abc", "."],
    ["1.2.3", ","]
  ] as const)("refuses %s rather than guess", (value, sep) => {
    expect(normalizeNumber(value, sep)).toBeNull();
  });

  it("normalizes yes/no spellings and counts the rest as failed", () => {
    const t = table([["b"], ["Yes"], ["N"], ["1"], ["maybe"]]);
    const { table: out, result } = run(
      "normalizeBooleans",
      { columns: ["b"], trueValue: "yes", falseValue: "no" },
      t
    );
    expect(out.rows.map((r) => r[0])).toEqual(["yes", "no", "yes", "maybe"]);
    expect(result.failed).toBe(1);
  });

  it("maps whole values, ignoring case and outer spaces by default", () => {
    const t = table([["c"], ["NY"], [" n.y. "], ["Boston"]]);
    const out = run(
      "mapValues",
      { columns: ["c"], mapping: { ny: "New York", "N.Y.": "New York" } },
      t
    ).table;
    expect(out.rows.map((r) => r[0])).toEqual([
      "New York",
      "New York",
      "Boston"
    ]);
  });
});

describe("rows", () => {
  it("drops fully empty rows", () => {
    const t = table([
      ["a", "b"],
      ["1", "2"],
      ["", " "],
      ["3", ""]
    ]);
    const { table: out, result } = run("dropEmptyRows", {}, t);
    expect(out.rows).toEqual([
      ["1", "2"],
      ["3", ""]
    ]);
    expect(result.rowsRemoved).toBe(1);
  });

  it("removes repeated rows, keeping the first, by all or by key columns", () => {
    const t = () =>
      table([
        ["id", "v"],
        ["1", "a"],
        ["1", "a"],
        ["1", "b"]
      ]);
    expect(run("dedupe", {}, t()).table.rows).toEqual([
      ["1", "a"],
      ["1", "b"]
    ]);
    expect(run("dedupe", { columns: ["id"] }, t()).table.rows).toEqual([
      ["1", "a"]
    ]);
  });

  it("drops rows where columns are empty", () => {
    const t = () =>
      table([
        ["a", "b"],
        ["1", ""],
        ["", ""],
        ["2", "x"]
      ]);
    expect(
      run("dropRowsWhereEmpty", { columns: ["a", "b"] }, t()).table.rows
    ).toEqual([["2", "x"]]);
    expect(
      run("dropRowsWhereEmpty", { columns: ["a", "b"], mode: "all" }, t()).table
        .rows.length
    ).toBe(2);
  });

  it("keeps or drops rows by condition", () => {
    expect(
      run(
        "filterRows",
        { column: "age", operator: "greaterThan", value: "35" },
        people()
      ).table.rows.map((r) => r[0])
    ).toEqual(["Cy  Lee"]);
    expect(
      run(
        "filterRows",
        { column: "city", operator: "equals", value: "PARIS", action: "drop" },
        people()
      ).table.rows.map((r) => r[0])
    ).toEqual(["Cy  Lee"]);
    expect(
      run(
        "filterRows",
        { column: "age", operator: "isEmpty" },
        people()
      ).table.rows.map((r) => r[0])
    ).toEqual(["Bob"]);
  });

  it("needs a value for comparison operators", () => {
    expect(() =>
      run("filterRows", { column: "age", operator: "equals" }, people())
    ).toThrow(/needs a value/);
  });

  it("skips leading rows", () => {
    expect(
      run("skipRows", { count: 2 }, people()).table.rows.map((r) => r[0])
    ).toEqual(["Cy  Lee"]);
  });

  it("uses a lower row as the header", () => {
    const t = table([
      ["Report 2024", ""],
      ["", ""],
      ["id", "id"],
      ["1", "2"]
    ]);
    const out = run("useRowAsHeader", { row: 3 }, t).table;
    expect(out.columns).toEqual(["id", "id (2)"]);
    expect(out.rows).toEqual([["1", "2"]]);
  });
});

describe("columns", () => {
  it("renames a column and refuses a name in use", () => {
    expect(
      run("renameColumn", { column: "age", to: "years" }, people()).table
        .columns
    ).toEqual(["name", "city", "years"]);
    expect(() =>
      run("renameColumn", { column: "age", to: "city" }, people())
    ).toThrow(/already exists/);
  });

  it("drops columns but never all of them", () => {
    expect(
      run("dropColumns", { columns: ["city"] }, people()).table.rows[0]
    ).toEqual([" Ann ", "30"]);
    expect(() =>
      run("dropColumns", { columns: ["name", "city", "age"] }, people())
    ).toThrow(/every column/);
  });

  it("reorders columns, keeping the rest in place", () => {
    const out = run("reorderColumns", { columns: ["age"] }, people()).table;
    expect(out.columns).toEqual(["age", "name", "city"]);
    expect(out.rows[0]).toEqual(["30", " Ann ", "Paris"]);
  });

  it("splits a column, keeping extra parts in the last new column", () => {
    const t = table([
      ["full", "x"],
      ["Ann Lee Smith", "1"],
      ["Bob", "2"],
      ["", "3"]
    ]);
    const out = run(
      "splitColumn",
      { column: "full", delimiter: " ", into: ["first", "last"] },
      t
    ).table;
    expect(out.columns).toEqual(["first", "last", "x"]);
    expect(out.rows).toEqual([
      ["Ann", "Lee Smith", "1"],
      ["Bob", "", "2"],
      ["", "", "3"]
    ]);
  });

  it("splits into a name the original column used, and can keep the original", () => {
    const t = () => table([["name"], ["Ann Lee"]]);
    expect(
      run(
        "splitColumn",
        { column: "name", delimiter: " ", into: ["name", "last"] },
        t()
      ).table.columns
    ).toEqual(["name", "last"]);
    expect(
      run(
        "splitColumn",
        {
          column: "name",
          delimiter: " ",
          into: ["first", "last"],
          keepOriginal: true
        },
        t()
      ).table.columns
    ).toEqual(["name", "first", "last"]);
  });

  it("merges columns where the first one was, skipping empty parts", () => {
    const t = table([
      ["id", "first", "last"],
      ["1", "Ann", "Lee"],
      ["2", "Bob", ""]
    ]);
    const out = run(
      "mergeColumns",
      { columns: ["first", "last"], into: "name" },
      t
    ).table;
    expect(out.columns).toEqual(["id", "name"]);
    expect(out.rows).toEqual([
      ["1", "Ann Lee"],
      ["2", "Bob"]
    ]);
  });

  it("merges into the name of a merged column and keeps originals on request", () => {
    const t = () =>
      table([
        ["first", "last"],
        ["Ann", "Lee"]
      ]);
    expect(
      run("mergeColumns", { columns: ["first", "last"], into: "first" }, t())
        .table.columns
    ).toEqual(["first"]);
    const kept = run(
      "mergeColumns",
      {
        columns: ["first", "last"],
        into: "full",
        separator: ", ",
        keepOriginals: true
      },
      t()
    ).table;
    expect(kept.columns).toEqual(["full", "first", "last"]);
    expect(kept.rows[0][0]).toBe("Ann, Lee");
  });
});

describe("tableFromRecords", () => {
  it("pads short rows and names empty or repeated headers", () => {
    expect(table([["a", "", "a"], ["1"], ["1", "2", "3", "4"]])).toEqual({
      columns: ["a", "Column 2", "a (2)", "Column 4"],
      rows: [
        ["1", "", "", ""],
        ["1", "2", "3", "4"]
      ]
    });
  });
});
