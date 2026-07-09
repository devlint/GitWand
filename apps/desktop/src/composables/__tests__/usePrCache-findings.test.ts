/**
 * Task C3 (v3.6.0) — AI pre-review findings cache, keyed `${detailKey}@${headSha}`.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { ReviewFinding } from "../usePrPreReview";

let usePrCache: typeof import("../usePrCache").usePrCache;
let detailKey: typeof import("../usePrCache").detailKey;
let _resetPrCacheForTesting: typeof import("../usePrCache")._resetPrCacheForTesting;

beforeEach(async () => {
  localStorage.clear();
  const mod = await import("../usePrCache");
  usePrCache = mod.usePrCache;
  detailKey = mod.detailKey;
  _resetPrCacheForTesting = mod._resetPrCacheForTesting;
  _resetPrCacheForTesting();
});

function finding(): ReviewFinding {
  return { id: "1", path: "a.ts", line: 1, side: "RIGHT", severity: "nit", confidence: 50, title: "t", detail: "" };
}

function keyAt(sha: string) {
  return `${detailKey("/repo", 1)}@${sha}`;
}

describe("usePrCache — findings by headSha (C3)", () => {
  it("setFindings / getFindings round-trip", () => {
    const c = usePrCache();
    c.setFindings(keyAt("sha1"), [finding()]);
    expect(c.getFindings(keyAt("sha1"))).toEqual([finding()]);
  });

  it("a different headSha misses the cache", () => {
    const c = usePrCache();
    c.setFindings(keyAt("sha1"), [finding()]);
    expect(c.getFindings(keyAt("sha2"))).toBeNull();
  });

  it("persists across a module reset (cold start)", () => {
    usePrCache().setFindings(keyAt("sha1"), [finding()]);
    _resetPrCacheForTesting();
    expect(usePrCache().getFindings(keyAt("sha1"))).toEqual([finding()]);
  });
});
