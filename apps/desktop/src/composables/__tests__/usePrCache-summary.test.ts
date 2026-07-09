/**
 * Task D1 (v3.6.0) — AI PR summary cache, keyed `${detailKey}@${headSha}`.
 */
import { describe, it, expect, beforeEach } from "vitest";

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

const keyAt = (sha: string) => `${detailKey("/repo", 1)}@${sha}`;

describe("usePrCache — PR summary (D1)", () => {
  it("setSummary / getSummary round-trip", () => {
    const c = usePrCache();
    c.setSummary(keyAt("sha1"), "What: x. Why: y.");
    expect(c.getSummary(keyAt("sha1"))).toBe("What: x. Why: y.");
  });

  it("a different headSha misses the cache", () => {
    const c = usePrCache();
    c.setSummary(keyAt("sha1"), "summary");
    expect(c.getSummary(keyAt("sha2"))).toBeNull();
  });

  it("persists across a module reset (cold start)", () => {
    usePrCache().setSummary(keyAt("sha1"), "summary");
    _resetPrCacheForTesting();
    expect(usePrCache().getSummary(keyAt("sha1"))).toBe("summary");
  });
});
