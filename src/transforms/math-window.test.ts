import { describe, expect, it } from "vitest";
import { tableFromRecords, type Table } from "../table";
import { createContext, TRANSFORMS, type TransformName } from "./index";
import { roundTo } from "./math";

function run(op: TransformName, params: unknown, input: Table) {
  const ctx = createContext(input);
  TRANSFORMS[op].apply(ctx, params);
  return { table: ctx.table, result: ctx.result };
}

const column = (t: Table, name: string) =>
  t.rows.map((row) => row[t.columns.indexOf(name)]);

const sales = () =>
  tableFromRecords([
    ["region", "month", "amount"],
    ["east", "2024-02", "20"],
    ["west", "2024-01", "5"],
    ["east", "2024-01", "10"],
    ["west", "2024-02", "x"],
    ["east", "2024-03", ""]
  ]);

describe("math", () => {
  it("calculates with a constant into a new column, without float noise", () => {
    const t = tableFromRecords([["a"], ["0.1"], ["2"]]);
    const out = run(
      "math",
      { column: "a", operator: "add", value: 0.2, into: "b" },
      t
    ).table;
    expect(column(out, "b")).toEqual(["0.3", "2.2"]);
  });

  it("calculates with another column and fixed decimals", () => {
    const t = tableFromRecords([
      ["price", "qty"],
      ["2.5", "3"],
      ["1", "x"]
    ]);
    const { table: out, result } = run(
      "math",
      {
        column: "price",
        operator: "multiply",
        otherColumn: "qty",
        into: "total",
        decimals: 2
      },
      t
    );
    expect(column(out, "total")).toEqual(["7.50", ""]);
    expect(result.failed).toBe(1);
  });

  it("keeps the original value when overwriting a cell it cannot calculate", () => {
    const t = tableFromRecords([["a"], ["10"], ["n/a"], ["4"]]);
    const { table: out, result } = run(
      "math",
      { column: "a", operator: "divide", value: 0 },
      t
    );
    expect(column(out, "a")).toEqual(["10", "n/a", "4"]);
    expect(result.failed).toBe(3);
    expect(
      run(
        "math",
        { column: "a", operator: "divide", value: 4 },
        tableFromRecords([["a"], ["10"]])
      ).table.rows[0][0]
    ).toBe("2.5");
  });

  it("needs exactly one of value or otherColumn", () => {
    const t = tableFromRecords([
      ["a", "b"],
      ["1", "2"]
    ]);
    expect(() => run("math", { column: "a", operator: "add" }, t)).toThrow(
      /exactly one/
    );
    expect(() =>
      run(
        "math",
        { column: "a", operator: "add", value: 1, otherColumn: "b" },
        t
      )
    ).toThrow(/exactly one/);
  });

  it.each([
    [1.005, 2, "round", 1.01],
    [-2.5, 0, "round", -3],
    [2.5, 0, "round", 3],
    [1.27, 1, "floor", 1.2],
    [-1.21, 1, "ceil", -1.2]
  ] as const)("rounds %d to %d places (%s)", (x, places, mode, expected) => {
    expect(roundTo(x, places, mode)).toBe(expected);
  });

  it("rounds, takes absolute values, and clamps", () => {
    const t = () => tableFromRecords([["n"], ["-3.456"], ["12"], ["x"]]);
    expect(
      column(run("round", { columns: ["n"], decimals: 1 }, t()).table, "n")
    ).toEqual(["-3.5", "12.0", "x"]);
    expect(column(run("abs", { columns: ["n"] }, t()).table, "n")).toEqual([
      "3.456",
      "12",
      "x"
    ]);
    expect(
      column(run("clamp", { columns: ["n"], min: 0, max: 10 }, t()).table, "n")
    ).toEqual(["0", "10", "x"]);
    expect(() => run("clamp", { columns: ["n"] }, t())).toThrow(/min, max/);
    expect(() => run("clamp", { columns: ["n"], min: 5, max: 1 }, t())).toThrow(
      /above max/
    );
  });
});

describe("window", () => {
  it("numbers rows within groups in order, without moving rows", () => {
    const out = run(
      "rowNumber",
      { into: "n", groupBy: ["region"], orderBy: { column: "month" } },
      sales()
    ).table;
    expect(column(out, "region")).toEqual([
      "east",
      "west",
      "east",
      "west",
      "east"
    ]);
    expect(column(out, "n")).toEqual(["2", "1", "1", "2", "3"]);
  });

  it("ranks with shared ranks for ties and no rank for empty cells", () => {
    const t = tableFromRecords([
      ["score"],
      ["90"],
      ["75"],
      ["90"],
      [""],
      ["100"]
    ]);
    expect(
      column(run("rank", { column: "score", into: "rank" }, t).table, "rank")
    ).toEqual(["2", "4", "2", "", "1"]);
  });

  it("adds a running total per group, counting non-numbers as failed", () => {
    const { table: out, result } = run(
      "runningTotal",
      {
        column: "amount",
        into: "total",
        groupBy: ["region"],
        orderBy: { column: "month" }
      },
      sales()
    );
    expect(column(out, "total")).toEqual(["30", "5", "10", "5", "30"]);
    expect(out.columns).toEqual(["region", "month", "amount", "total"]);
    expect(result.failed).toBe(1);
  });

  it("copies previous and next values", () => {
    const opts = {
      column: "amount",
      groupBy: ["region"],
      orderBy: { column: "month" }
    };
    expect(
      column(run("lag", { ...opts, into: "prev" }, sales()).table, "prev")
    ).toEqual(["10", "", "", "5", "20"]);
    expect(
      column(run("lead", { ...opts, into: "next" }, sales()).table, "next")
    ).toEqual(["", "x", "20", "", ""]);
  });

  it("takes differences from the previous row", () => {
    const t = tableFromRecords([["v"], ["10"], ["15"], ["12"]]);
    expect(
      column(run("difference", { column: "v", into: "d" }, t).table, "d")
    ).toEqual(["", "5", "-3"]);
  });

  it("averages over a trailing window", () => {
    const t = tableFromRecords([["v"], ["1"], ["2"], ["x"], ["6"]]);
    expect(
      column(
        run("movingAverage", { column: "v", into: "avg", size: 2 }, t).table,
        "avg"
      )
    ).toEqual(["1", "1.5", "2", "6"]);
  });

  it("gives percents of the group total", () => {
    const t = tableFromRecords([
      ["g", "v"],
      ["a", "1"],
      ["a", "3"],
      ["b", "5"],
      ["b", "0"]
    ]);
    expect(
      column(
        run("percentOfTotal", { column: "v", into: "pct", groupBy: ["g"] }, t)
          .table,
        "pct"
      )
    ).toEqual(["25.00", "75.00", "100.00", "0.00"]);
  });

  it("refuses an output name that already exists", () => {
    expect(() => run("rowNumber", { into: "amount" }, sales())).toThrow(
      /already exists/
    );
  });
});
