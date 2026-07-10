import { describe, it, expect } from "vitest";
import { normalizeFindingClass, filterFindings } from "../usePrFindingFilter";
import type { ReviewFinding } from "../usePrPreReview";

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: "id1", path: "src/a.ts", line: 1, side: "RIGHT",
    severity: "suggestion", confidence: 70, title: "unused variable", detail: "",
    ...overrides,
  };
}

describe("normalizeFindingClass", () => {
  it("collapses digit variance in the title", () => {
    const a = normalizeFindingClass(finding({ title: "unused variable x2" }));
    const b = normalizeFindingClass(finding({ title: "unused variable x7" }));
    expect(a).toBe(b);
  });

  it("uses the file's dirname, not the full path", () => {
    const a = normalizeFindingClass(finding({ path: "src/a.ts", line: 5 }));
    const b = normalizeFindingClass(finding({ path: "src/a.ts", line: 99 }));
    expect(a).toBe(b);
  });

  it("differs across directories with the same title", () => {
    const a = normalizeFindingClass(finding({ path: "src/a.ts" }));
    const b = normalizeFindingClass(finding({ path: "test/a.ts" }));
    expect(a).not.toBe(b);
  });

  it("is case-insensitive on the title", () => {
    const a = normalizeFindingClass(finding({ title: "Unused Variable" }));
    const b = normalizeFindingClass(finding({ title: "unused variable" }));
    expect(a).toBe(b);
  });
});

describe("filterFindings", () => {
  it("drops findings below the threshold", () => {
    const all = [finding({ id: "a", confidence: 40 }), finding({ id: "b", confidence: 80 })];
    const out = filterFindings(all, { threshold: 60, cap: 10, dismissed: new Set() });
    expect(out.map((f) => f.id)).toEqual(["b"]);
  });

  it("caps at the top-N by confidence", () => {
    const all = [
      finding({ id: "a", confidence: 90 }),
      finding({ id: "b", confidence: 70 }),
      finding({ id: "c", confidence: 80 }),
    ];
    const out = filterFindings(all, { threshold: 0, cap: 2, dismissed: new Set() });
    expect(out.map((f) => f.id)).toEqual(["a", "c"]);
  });

  it("removes a dismissed class regardless of confidence", () => {
    const dismissedFinding = finding({ id: "a", title: "dismiss me", confidence: 95 });
    const dismissed = new Set([normalizeFindingClass(dismissedFinding)]);
    const out = filterFindings([dismissedFinding, finding({ id: "b" })], { threshold: 0, cap: 10, dismissed });
    expect(out.map((f) => f.id)).toEqual(["b"]);
  });

  it("returns [] when everything is below threshold or dismissed", () => {
    const out = filterFindings([finding({ confidence: 10 })], { threshold: 50, cap: 10, dismissed: new Set() });
    expect(out).toEqual([]);
  });
});
