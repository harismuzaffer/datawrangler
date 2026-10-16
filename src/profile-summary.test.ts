import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv";
import { profileCsv } from "./profile";
import { profileForLlm } from "./profile-summary";

const decoded = { encoding: "utf-8" as const, hadBom: false };

describe("profileForLlm", () => {
  it("keeps details for columns with issues and only name and type for clean ones", () => {
    const profile = profileCsv(parseCsv("id,city\n1, Paris\n2,Rome"), decoded);
    const summary = profileForLlm(profile);
    expect(summary.columnDetails[0]).toEqual({ name: "id", type: "integer" });
    expect(summary.columnDetails[1]).toMatchObject({
      name: "city",
      issues: [{ code: "whitespace", count: 1 }]
    });
    expect(summary.columnsNotShown).toBe(0);
  });

  it("stays within its size budget for very wide files and says how many columns it left out", () => {
    const header = Array.from({ length: 400 }, (_, i) => `column_${i}`).join(
      ","
    );
    const row = Array.from({ length: 400 }, (_, i) => ` value ${i} `).join(",");
    const summary = profileForLlm(
      profileCsv(parseCsv(`${header}\n${row}\n${row}`), decoded)
    );
    expect(JSON.stringify(summary).length).toBeLessThanOrEqual(12_000);
    expect(summary.columnsNotShown).toBeGreaterThan(0);
    expect(summary.columnDetails.length + summary.columnsNotShown).toBe(400);
  });
});
