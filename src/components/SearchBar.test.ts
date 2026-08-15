import { describe, it, expect } from "vitest";
import { normalizeSmartQuotes } from "./SearchBar";

describe("normalizeSmartQuotes", () => {
  it("converts curly single quotes to a straight ASCII apostrophe", () => {
    expect(normalizeSmartQuotes("city = ‘Sapporo’")).toBe("city = 'Sapporo'");
  });

  it("converts curly double quotes to a straight ASCII double quote", () => {
    expect(normalizeSmartQuotes("city = “Sapporo”")).toBe('city = "Sapporo"');
  });

  it("handles an unmatched opening curly quote with no closer", () => {
    expect(normalizeSmartQuotes("city = ‘Sapporo")).toBe("city = 'Sapporo");
  });

  it("leaves already-straight quotes unchanged", () => {
    expect(normalizeSmartQuotes("city = 'Sapporo'")).toBe("city = 'Sapporo'");
  });

  it("leaves text with no quotes unchanged", () => {
    expect(normalizeSmartQuotes("value > 1000")).toBe("value > 1000");
  });
});
