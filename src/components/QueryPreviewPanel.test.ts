import { describe, it, expect } from "vitest";
import { rowsToTsv } from "./QueryPreviewPanel";

describe("rowsToTsv", () => {
  it("joins the header and rows with tabs and newlines", () => {
    const tsv = rowsToTsv(
      ["city", "value"],
      [
        ["Tokyo", "100"],
        ["Sapporo", "200"],
      ],
    );
    expect(tsv).toBe("city\tvalue\nTokyo\t100\nSapporo\t200");
  });

  it("handles zero rows as just the header line", () => {
    expect(rowsToTsv(["a", "b"], [])).toBe("a\tb");
  });
});
