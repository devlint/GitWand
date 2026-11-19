import { describe, it, expect } from "vitest";
import { escapeRegExp } from "../escapeRegExp";

describe("escapeRegExp", () => {
  it("matches the text literally", () => {
    const s = "a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o";
    expect(new RegExp(`^${escapeRegExp(s)}$`).test(s)).toBe(true);
    expect(new RegExp(escapeRegExp("a.b")).test("axb")).toBe(false);
  });
});
