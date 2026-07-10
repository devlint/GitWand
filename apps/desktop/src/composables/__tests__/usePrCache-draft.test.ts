/**
 * Task B3 (v3.6.0) — pending review draft persistence in the SWR cache.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { PendingReviewComment } from "../../utils/backend";

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

const KEY = () => detailKey("/repo/a", 7);

function comment(path: string): PendingReviewComment {
  return { path, line: 1, side: "RIGHT", body: "nit" };
}

describe("usePrCache — pending review draft (B3)", () => {
  it("setDraft / getDraft round-trip", () => {
    const c = usePrCache();
    c.setDraft(KEY(), [comment("a.ts")]);
    expect(c.getDraft(KEY())).toEqual([comment("a.ts")]);
  });

  it("getDraft returns null for an unknown key", () => {
    expect(usePrCache().getDraft(KEY())).toBeNull();
  });

  it("clearDraft removes the entry", () => {
    const c = usePrCache();
    c.setDraft(KEY(), [comment("a.ts")]);
    c.clearDraft(KEY());
    expect(c.getDraft(KEY())).toBeNull();
  });

  it("persists across a module reset (cold start)", () => {
    usePrCache().setDraft(KEY(), [comment("a.ts"), comment("b.ts")]);
    _resetPrCacheForTesting();
    expect(usePrCache().getDraft(KEY())?.length).toBe(2);
  });

  it("is pruned by age on load", () => {
    usePrCache().setDraft(KEY(), [comment("a.ts")]);
    const raw = JSON.parse(localStorage.getItem("gitwand-pr-cache")!);
    for (const k of Object.keys(raw.drafts)) raw.drafts[k].ts = 0;
    localStorage.setItem("gitwand-pr-cache", JSON.stringify(raw));
    _resetPrCacheForTesting();
    expect(usePrCache().getDraft(KEY())).toBeNull();
  });
});
