/**
 * Verifier fix (v3.7.0, issue #1) — `usePrPanel`'s `visibilitychange`
 * handler must call the injected `onVisibilityResume` option on the same
 * hidden → visible edge it already uses to resume the PR pre-review queue,
 * so `useCommitReview`'s queue (a different instance entirely) never stays
 * wedged on `document.hidden` forever with nothing to wake it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";

vi.mock("@/utils/backend", async () => {
  const actual = await vi.importActual<typeof import("@/utils/backend")>("@/utils/backend");
  return {
    ...actual,
    gitFileCount: vi.fn(async () => 0),
    gitRemoteInfo: vi.fn(async () => ({ url: "", host: "github.com", owner: "o", repo: "r" })),
    ghForkInfo: vi.fn(async () => ({ isFork: false, origin: "", parent: "" })),
  };
});

import { usePrPanel } from "../usePrPanel";

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { value: hidden, configurable: true });
}

describe("usePrPanel — visibilitychange resume wiring", () => {
  beforeEach(() => {
    setHidden(false);
  });

  it("calls onVisibilityResume on the hidden -> visible edge, reusing the single listener", () => {
    const onVisibilityResume = vi.fn();
    // Empty cwd: the poll-tick side effects (loadPrs/revalidateOpenDetail)
    // no-op on a falsy cwd, so this test only ever exercises the
    // visibility wiring, not the PR-fetch machinery.
    usePrPanel(ref(""), { onVisibilityResume });

    setHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(onVisibilityResume).not.toHaveBeenCalled();

    setHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(onVisibilityResume).toHaveBeenCalledTimes(1);
  });

  it("never throws when onVisibilityResume is omitted", () => {
    usePrPanel(ref(""));
    setHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));
    setHidden(false);
    expect(() => document.dispatchEvent(new Event("visibilitychange"))).not.toThrow();
  });
});
