/**
 * Task B2 (v3.6.0) — client-side viewed-file state in the SWR cache, with
 * re-push (headSha change) invalidation at whole-PR granularity.
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

const KEY = () => detailKey("/repo/a", 42);

describe("usePrCache — viewed-file state (B2)", () => {
  it("setViewed / getViewed round-trip", () => {
    const c = usePrCache();
    c.setViewed(KEY(), "sha1", ["a.ts", "b.ts"]);
    expect(c.getViewed(KEY())).toEqual({ headSha: "sha1", paths: ["a.ts", "b.ts"] });
  });

  it("getViewed returns null for an unknown key", () => {
    expect(usePrCache().getViewed(KEY())).toBeNull();
  });

  it("toggleViewed adds a path, then removes it on a second toggle", () => {
    const c = usePrCache();
    c.toggleViewed(KEY(), "sha1", "a.ts");
    expect(c.getViewed(KEY())?.paths).toEqual(["a.ts"]);
    c.toggleViewed(KEY(), "sha1", "a.ts");
    expect(c.getViewed(KEY())?.paths).toEqual([]);
  });

  it("toggleViewed with a new headSha clears prior paths before applying the toggle", () => {
    const c = usePrCache();
    c.setViewed(KEY(), "sha1", ["a.ts", "b.ts"]);
    c.toggleViewed(KEY(), "sha2", "c.ts"); // re-push — new head SHA
    const v = c.getViewed(KEY());
    expect(v?.headSha).toBe("sha2");
    expect(v?.paths).toEqual(["c.ts"]); // a.ts/b.ts from the old head are gone
  });

  it("persists across a module reset (cold start)", () => {
    usePrCache().setViewed(KEY(), "sha1", ["a.ts"]);
    _resetPrCacheForTesting();
    expect(usePrCache().getViewed(KEY())).toEqual({ headSha: "sha1", paths: ["a.ts"] });
  });

  it("is pruned/evicted by the existing age/LRU machinery", () => {
    const c = usePrCache();
    c.setViewed(KEY(), "sha1", ["a.ts"]);
    expect(localStorage.getItem("gitwand-pr-cache")).toContain("viewed");
    // Age pruning runs on load — simulate a stale write by editing the ts
    // directly in storage, then reload the module state from it.
    const raw = JSON.parse(localStorage.getItem("gitwand-pr-cache")!);
    for (const k of Object.keys(raw.viewed)) raw.viewed[k].ts = 0;
    localStorage.setItem("gitwand-pr-cache", JSON.stringify(raw));
    _resetPrCacheForTesting();
    expect(usePrCache().getViewed(KEY())).toBeNull();
  });
});
