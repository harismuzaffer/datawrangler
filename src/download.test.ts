import { describe, expect, it } from "vitest";
import { cleanedFileName, contentDisposition } from "./download";

describe("cleanedFileName", () => {
  it("replaces the extension with the version", () => {
    expect(cleanedFileName("Sales 2024.CSV", 2)).toBe(
      "Sales 2024-cleaned-v2.csv"
    );
    expect(cleanedFileName("export", 1)).toBe("export-cleaned-v1.csv");
    expect(cleanedFileName(".csv", 1)).toBe("data-cleaned-v1.csv");
  });
});

describe("contentDisposition", () => {
  it("keeps user text from breaking out of the header value", () => {
    const header = contentDisposition('a"; filename="evil.exe');
    expect(header).toBe(
      `attachment; filename="a__ filename__evil.exe"; filename*=UTF-8''a%22%3B%20filename%3D%22evil.exe`
    );
    // The value is accepted by the Headers API, which refuses line breaks and other invalid characters.
    expect(() => new Headers({ "Content-Disposition": header })).not.toThrow();
  });

  it("encodes non-ASCII names for filename*", () => {
    expect(contentDisposition("café (1).csv")).toBe(
      `attachment; filename="caf_ _1_.csv"; filename*=UTF-8''caf%C3%A9%20%281%29.csv`
    );
  });
});
