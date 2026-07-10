/**
 * Task C2 (v3.6.0) — local dismissal memory for AI pre-review findings,
 * keyed per repo.
 */
import { describe, it, expect, beforeEach } from "vitest";

let usePrCache: typeof import("../usePrCache").usePrCache;
let _resetPrCacheForTesting: typeof import("../usePrCache")._resetPrCacheForTesting;

beforeEach(async () => {
  localStorage.clear();
  const mod = await import("../usePrCache");
  usePrCache = mod.usePrCache;
  _resetPrCacheForTesting = mod._resetPrCacheForTesting;
  _resetPrCacheForTesting();
});

const CWD = "/repo/a";

describe("usePrCache — dismissed findings (C2)", () => {
  it("getDismissed returns an empty set for an unknown repo", () => {
    expect(usePrCache().getDismissed(CWD)).toEqual(new Set());
  });

  it("addDismissed / getDismissed round-trip", () => {
    const c = usePrCache();
    c.addDismissed(CWD, "src::unused variable");
    expect(c.getDismissed(CWD)).toEqual(new Set(["src::unused variable"]));
  });

  it("addDismissed accumulates distinct classes", () => {
    const c = usePrCache();
    c.addDismissed(CWD, "a");
    c.addDismissed(CWD, "b");
    expect(c.getDismissed(CWD)).toEqual(new Set(["a", "b"]));
  });

  it("addDismissed is idempotent for the same class", () => {
    const c = usePrCache();
    c.addDismissed(CWD, "a");
    c.addDismissed(CWD, "a");
    expect(c.getDismissed(CWD)).toEqual(new Set(["a"]));
  });

  it("dismissal memory is scoped per repo", () => {
    const c = usePrCache();
    c.addDismissed(CWD, "a");
    expect(c.getDismissed("/repo/other")).toEqual(new Set());
  });

  it("persists across a module reset (cold start)", () => {
    usePrCache().addDismissed(CWD, "a");
    _resetPrCacheForTesting();
    expect(usePrCache().getDismissed(CWD)).toEqual(new Set(["a"]));
  });

  it("is pruned by age on load", () => {
    usePrCache().addDismissed(CWD, "a");
    const raw = JSON.parse(localStorage.getItem("gitwand-pr-cache")!);
    for (const k of Object.keys(raw.dismissedFindings)) raw.dismissedFindings[k].ts = 0;
    localStorage.setItem("gitwand-pr-cache", JSON.stringify(raw));
    _resetPrCacheForTesting();
    expect(usePrCache().getDismissed(CWD)).toEqual(new Set());
  });
});
