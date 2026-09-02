/**
 * Phase G (v3.10, Today active mutations) verifier fix — the Launchpad merge
 * handler in App.vue gates its success toast / error surfacing on two
 * `usePrPanel` contracts: `mergePr()` nulls `mergingPr` only on success (not
 * on failure), and both `mergePr()` and `checkoutPr()` funnel a thrown error
 * into `error.value`. These tests lock in that contract so a regression here
 * doesn't silently break the Launchpad's failure handling.
 *
 * See usePrPanel-cli-missing.test.ts for why `vi.hoisted()` is required for
 * the mock factories (usePrPanel.ts's import chain evaluates them first).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";

const { gitRemoteInfo } = vi.hoisted(() => ({
  gitRemoteInfo: vi.fn(),
}));

vi.mock("../../utils/backend", () => ({
  gitRemoteInfo: (...args: unknown[]) => gitRemoteInfo(...args),
  gitFileCount: vi.fn(async () => 0),
  ghForkInfo: vi.fn(async () => ({ isFork: false, origin: "", parent: "" })),
  ghPrFreshnessSignal: vi.fn(),
  detectClaudeCli: vi.fn(async () => ({
    found: false, path: "", version: "", logged_in: false, status: "not_found",
  })),
}));

const forgeStub = vi.hoisted(() => ({
  current: {
    name: "github",
    listPRs: (..._a: unknown[]) => Promise.resolve([]),
    mergePR: (..._a: unknown[]) => Promise.resolve(),
    checkoutPR: (..._a: unknown[]) => Promise.resolve(),
  },
}));
vi.mock("../forge/useForge", () => ({
  forgeFromRemoteInfo: vi.fn(() => forgeStub.current),
  githubProvider: { name: "github", listPRs: vi.fn(async () => []) },
}));

import { usePrPanel } from "../usePrPanel";
import { _resetPrCacheForTesting } from "../usePrCache";

const fakePr = { number: 42, title: "Sample PR", author: "octocat", branch: "feature/x", base: "main" } as any;

describe("usePrPanel — merge/checkout failure contract (Phase G)", () => {
  beforeEach(() => {
    localStorage.clear();
    _resetPrCacheForTesting();
    gitRemoteInfo.mockReset();
    gitRemoteInfo.mockResolvedValue({ name: "origin", url: "https://github.com/o/r", provider: "github", owner: "o", repo: "r" });
    forgeStub.current = {
      name: "github",
      listPRs: vi.fn(async () => []),
      mergePR: vi.fn(async () => {}),
      checkoutPR: vi.fn(async () => {}),
    };
  });

  it("mergePr() nulls mergingPr on success", async () => {
    const panel = usePrPanel(ref("/repo"));
    await panel.loadRemote();
    panel.mergingPr.value = fakePr;

    await panel.mergePr();

    expect(panel.mergingPr.value).toBeNull();
    expect(panel.error.value).toBeNull();
  });

  it("mergePr() leaves mergingPr set and surfaces error.value on failure", async () => {
    forgeStub.current.mergePR = vi.fn(async () => { throw new Error("merge conflict"); });
    const panel = usePrPanel(ref("/repo"));
    await panel.loadRemote();
    panel.mergingPr.value = fakePr;

    await panel.mergePr();

    // mergePr() does NOT clear mergingPr on failure — callers must do it
    // themselves after checking error.value, or a stale mergingPr re-opens
    // the merge dialog next time PrDetailView reads it.
    expect(panel.mergingPr.value).not.toBeNull();
    expect(panel.error.value).toBe("merge conflict");
  });

  it("checkoutPr() surfaces error.value on failure", async () => {
    forgeStub.current.checkoutPR = vi.fn(async () => { throw new Error("checkout failed: local changes would be overwritten"); });
    const panel = usePrPanel(ref("/repo"));
    await panel.loadRemote();

    await panel.checkoutPr(fakePr);

    expect(panel.error.value).toContain("checkout failed");
  });

  it("checkoutPr() leaves error.value null on success", async () => {
    const panel = usePrPanel(ref("/repo"));
    await panel.loadRemote();
    panel.error.value = null;

    await panel.checkoutPr(fakePr);

    expect(panel.error.value).toBeNull();
  });
});
