import { describe, expect, it } from "vitest";
import { CsvError, decodeCsvBytes, parseCsv } from "./csv";
import { MAX_COLUMNS } from "./limits";

const bytes = (...values: number[]) => new Uint8Array(values);
const utf8 = (text: string) => new TextEncoder().encode(text);

describe("decodeCsvBytes", () => {
  it("reads plain UTF-8", () => {
    expect(decodeCsvBytes(utf8("a,b\ncafé,2"))).toEqual({
      text: "a,b\ncafé,2",
      encoding: "utf-8",
      hadBom: false
    });
  });

  it("removes a UTF-8 byte order mark and reports it", () => {
    const result = decodeCsvBytes(
      new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("id,name")])
    );
    expect(result).toEqual({
      text: "id,name",
      encoding: "utf-8",
      hadBom: true
    });
  });

  it("reads UTF-16 with a byte order mark", () => {
    expect(
      decodeCsvBytes(bytes(0xff, 0xfe, 0x61, 0x00, 0x2c, 0x00, 0x62, 0x00)).text
    ).toBe("a,b");
    expect(
      decodeCsvBytes(bytes(0xfe, 0xff, 0x00, 0x61, 0x00, 0x2c, 0x00, 0x62)).text
    ).toBe("a,b");
  });

  it("falls back to Windows-1252 when the bytes are not valid UTF-8", () => {
    // "café €5" as saved by older Excel: é = 0xE9, € = 0x80
    const result = decodeCsvBytes(
      bytes(0x63, 0x61, 0x66, 0xe9, 0x20, 0x80, 0x35)
    );
    expect(result).toEqual({
      text: "café €5",
      encoding: "windows-1252",
      hadBom: false
    });
  });
});

describe("parseCsv", () => {
  it("parses commas and drops the final empty line", () => {
    const parsed = parseCsv("id,name\n1,Ann\n2,Bob\n");
    expect(parsed.rows).toEqual([
      ["id", "name"],
      ["1", "Ann"],
      ["2", "Bob"]
    ]);
    expect(parsed.delimiter).toBe(",");
    expect(parsed.problems).toEqual([]);
  });

  it.each([
    [";", "id;amount\n1;3,5\n2;4,0"],
    ["\t", "id\tname\n1\tAnn, Jr.\n2\tBob"],
    ["|", "id|name\n1|Ann\n2|Bob"]
  ])("detects the %j delimiter", (delimiter, text) => {
    const parsed = parseCsv(text);
    expect(parsed.delimiter).toBe(delimiter);
    expect(parsed.rows[1].length).toBe(2);
  });

  it("keeps quoted delimiters, quotes, and newlines inside one value", () => {
    const parsed = parseCsv('id,note\n1,"Hello, ""world""\nsecond line"\n2,ok');
    expect(parsed.rows[1]).toEqual(["1", 'Hello, "world"\nsecond line']);
    expect(parsed.rows[2]).toEqual(["2", "ok"]);
  });

  it("handles CRLF line endings", () => {
    expect(parseCsv("a,b\r\n1,2\r\n").rows).toEqual([
      ["a", "b"],
      ["1", "2"]
    ]);
  });

  it("keeps ragged and empty rows for the profile to report", () => {
    const parsed = parseCsv("a,b,c\n1,2\n\n4,5,6,7\n");
    expect(parsed.rows.map((row) => row.length)).toEqual([3, 2, 1, 4]);
  });

  it("reports an unclosed quote", () => {
    const parsed = parseCsv('a,b\n1,"oops\n2,3');
    expect(parsed.problems.map((p) => p.code)).toContain("unclosed_quote");
  });

  it("rejects empty files", () => {
    expect(() => parseCsv("")).toThrow(CsvError);
    expect(() => parseCsv(" \n \n")).toThrow(CsvError);
  });

  it("rejects files wider than the column limit", () => {
    const header = Array.from(
      { length: MAX_COLUMNS + 1 },
      (_, i) => `c${i}`
    ).join(",");
    expect(() => parseCsv(`${header}\n`)).toThrow(/columns/);
  });
});
