import { describe, expect, it } from "vitest";
import {
  assertLooksLikeText,
  fileNameSchema,
  readBodyWithLimit,
  UploadError,
  userIdSchema
} from "./upload";

function request(
  parts: Uint8Array[],
  headers: Record<string, string> = {}
): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    }
  });
  return new Request("https://x/upload", {
    method: "POST",
    body,
    headers,
    duplex: "half"
  } as RequestInit);
}

describe("readBodyWithLimit", () => {
  it("returns the whole body when it fits", async () => {
    const body = await readBodyWithLimit(
      request([new Uint8Array([1, 2]), new Uint8Array([3])]),
      3
    );
    expect([...body]).toEqual([1, 2, 3]);
  });

  it("refuses a declared size over the limit before reading", async () => {
    const error = await readBodyWithLimit(
      request([new Uint8Array(1)], { "content-length": "11" }),
      10
    ).catch((e) => e);
    expect(error).toBeInstanceOf(UploadError);
    expect(error.status).toBe(413);
  });

  it("refuses a body that grows past the limit even when the header says less", async () => {
    const parts = [new Uint8Array(6), new Uint8Array(6)];
    const error = await readBodyWithLimit(
      request(parts, { "content-length": "5" }),
      10
    ).catch((e) => e);
    expect(error.status).toBe(413);
  });

  it("refuses an empty body", async () => {
    const error = await readBodyWithLimit(request([]), 10).catch((e) => e);
    expect(error.status).toBe(400);
  });
});

describe("assertLooksLikeText", () => {
  it("accepts text and UTF-16 with a byte order mark", () => {
    expect(() =>
      assertLooksLikeText(new TextEncoder().encode("a,b\n1,2"))
    ).not.toThrow();
    expect(() =>
      assertLooksLikeText(new Uint8Array([0xff, 0xfe, 0x61, 0x00]))
    ).not.toThrow();
  });

  it("rejects binary files such as Excel workbooks", () => {
    // An .xlsx file is a ZIP archive: "PK\x03\x04" followed by binary data with zero bytes.
    const xlsx = new Uint8Array([
      0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00
    ]);
    expect(() => assertLooksLikeText(xlsx)).toThrow(/Excel/);
  });
});

describe("input schemas", () => {
  it("accepts normal file names and trims them", () => {
    expect(fileNameSchema.parse("  sales 2024.csv ")).toBe("sales 2024.csv");
  });

  it.each(["", "   ", "a".repeat(201), "bad\nname.csv"])(
    "rejects the file name %j",
    (name) => {
      expect(fileNameSchema.safeParse(name).success).toBe(false);
    }
  );

  it("accepts UUID user IDs and rejects anything that could change a storage path", () => {
    expect(
      userIdSchema.safeParse("3f2b8c1e-7a4d-4e8b-9c1a-2b3c4d5e6f70").success
    ).toBe(true);
    for (const id of [
      "",
      "../other",
      "a/b",
      "x".repeat(65),
      "name with space"
    ]) {
      expect(userIdSchema.safeParse(id).success).toBe(false);
    }
  });
});
