/**
 * The last-result cache of useCombinedDiff (`combinedResultCache`): reused
 * only for the same repository and request, another repository drops it.
 * Stale responses are `latestOnly`'s (utils/__tests__/latestOnly.test.ts);
 * the backend call itself is covered by the backend and parity tests.
 */
import { describe, it, expect } from "vitest";
import { combinedResultCache } from "../useCombinedDiff";
import type { CombinedDiff } from "../../utils/backend";

const combined = (tag: string): CombinedDiff => ({
  base: null,
  commits: [{ hash: tag.padEnd(40, "0"), shortHash: tag, subject: `s ${tag}`, author: "A", date: "2026-01-01T00:00:00Z" }],
  diffs: [],
  steps: [[]],
  fallback: [],
  truncated: false,
});

describe("combinedResultCache", () => {
  it("returns the stored result for the same repo and request", () => {
    const c = combinedResultCache();
    c.set("/r", { hashes: ["a", "b"], paths: ["x"] }, combined("c1"));
    expect(c.get("/r", { hashes: ["a", "b"], paths: ["x"] })?.commits[0].shortHash).toBe("c1");
  });

  it("misses for another request (hashes or paths)", () => {
    const c = combinedResultCache();
    c.set("/r", { hashes: ["a", "b"] }, combined("c1"));
    expect(c.get("/r", { hashes: ["a", "c"] })).toBeNull();
    expect(c.get("/r", { hashes: ["a", "b"], paths: ["x"] })).toBeNull();
  });

  it("another repo misses and drops the stored result", () => {
    const c = combinedResultCache();
    c.set("/r", { hashes: ["a", "b"] }, combined("c1"));
    expect(c.get("/other", { hashes: ["a", "b"] })).toBeNull();
    expect(c.get("/r", { hashes: ["a", "b"] })).toBeNull();
  });

  it("a new result replaces the previous one", () => {
    const c = combinedResultCache();
    c.set("/r", { hashes: ["a", "b"] }, combined("c1"));
    c.set("/r", { hashes: ["a", "b"] }, combined("c2"));
    expect(c.get("/r", { hashes: ["a", "b"] })?.commits[0].shortHash).toBe("c2");
  });

  it("starts empty", () => {
    expect(combinedResultCache().get("/r", { hashes: ["a", "b"] })).toBeNull();
  });
});
