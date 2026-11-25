/**
 * #262 — the dev-server finds a PR number's repo by the rules of
 * `pr_lookup_order` / `pr_lookup_moves_on` (commands/github_api.rs), so
 * `pnpm dev:web` on a fork reads and writes the PR the list shows. Same cases
 * as the Rust tests.
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs module, no type declarations
import { devPrLookupOrder, devPrLookupMovesOn, devPrNumber } from "../../dev-pr-repo.mjs";

describe("devPrLookupOrder", () => {
  it("asks the base repo first, origin as the fallback", () => {
    expect(devPrLookupOrder("me/proj", "upstream/proj")).toEqual(["upstream/proj", "me/proj"]);
    expect(devPrLookupOrder("me/proj", "me/proj")).toEqual(["me/proj"]);
    expect(devPrLookupOrder("me/proj", null)).toEqual(["me/proj"]);
  });
});

describe("devPrLookupMovesOn", () => {
  it("moves on only when the repo cannot answer", () => {
    for (const st of [404, 410, 451]) expect(devPrLookupMovesOn(st)).toBe(true);
    expect(devPrLookupMovesOn(403, '{"message":"Resource protected by organization SAML enforcement."}')).toBe(true);
    expect(devPrLookupMovesOn(403, '{"message":"API rate limit exceeded for user."}')).toBe(false);
    for (const st of [401, 422, 500, 502]) expect(devPrLookupMovesOn(st)).toBe(false);
  });
});

describe("devPrNumber", () => {
  it("accepts a positive integer only", () => {
    expect(devPrNumber("12")).toBe(12);
    expect(devPrNumber(7)).toBe(7);
    for (const bad of [null, undefined, "", "0", "-3", "1.5", "abc", 0]) expect(devPrNumber(bad)).toBeNull();
  });
});
