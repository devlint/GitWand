/**
 * #262 — the dev-server routes validate a PR number before resolving its repo
 * (an empty or malformed one must not become PR #0 or #NaN).
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs module, no type declarations
import { devPrNumber } from "../../dev-pr-repo.mjs";

describe("devPrNumber", () => {
  it("accepts a positive integer only", () => {
    expect(devPrNumber("12")).toBe(12);
    expect(devPrNumber(7)).toBe(7);
    for (const bad of [null, undefined, "", "0", "-3", "1.5", "abc", "12abc", 0]) expect(devPrNumber(bad)).toBeNull();
  });
});
