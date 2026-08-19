/**
 * Task 2 (v3.7.0) — `useCommitReviewNav`: finding-to-finding cycling across
 * staged files. Port of `usePrReviewNav.ts`'s `jumpToFinding`, adapted to
 * switch the selected staged file via an injected `selectFile` callback
 * instead of a PR's file sidebar.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { ref, nextTick } from "vue";
import { useCommitReviewNav } from "../useCommitReviewNav";
import type { ReviewFinding } from "../usePrPreReview";

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: "f1",
    path: "a.ts",
    line: 1,
    side: "RIGHT",
    severity: "nit",
    confidence: 50,
    title: "t",
    detail: "d",
    ...overrides,
  };
}

describe("useCommitReviewNav", () => {
  let selectFile: Mock<(path: string, staged: boolean) => void>;
  let scrollToFinding: Mock<(line: number, side: "LEFT" | "RIGHT") => void>;
  let onDismiss: Mock<(id: string) => void>;
  let onHelp: Mock<() => void>;

  beforeEach(() => {
    selectFile = vi.fn<(path: string, staged: boolean) => void>();
    scrollToFinding = vi.fn<(line: number, side: "LEFT" | "RIGHT") => void>();
    onDismiss = vi.fn<(id: string) => void>();
    onHelp = vi.fn<() => void>();
  });

  function setup(findingsList: ReviewFinding[]) {
    const findings = ref<ReviewFinding[]>(findingsList);
    const diffHandle = ref({ scrollToFinding });
    const nav = useCommitReviewNav({ findings, selectFile, diffHandle, onDismiss, onHelp });
    return { nav, findings };
  }

  it("wraps forward from -1 to the first finding", async () => {
    const { nav } = setup([finding({ id: "a" }), finding({ id: "b" })]);
    nav.jumpToFinding(1);
    expect(nav.currentFindingIdx.value).toBe(0);
    await nextTick();
    expect(selectFile).toHaveBeenCalledWith("a.ts", true);
  });

  it("wraps backward from -1 to the last finding", () => {
    const { nav } = setup([finding({ id: "a" }), finding({ id: "b" }), finding({ id: "c" })]);
    nav.jumpToFinding(-1);
    expect(nav.currentFindingIdx.value).toBe(2);
  });

  it("wraps around past the end forward, and before the start backward", () => {
    const { nav } = setup([finding({ id: "a" }), finding({ id: "b" })]);
    nav.jumpToFinding(1); // -> 0
    nav.jumpToFinding(1); // -> 1
    nav.jumpToFinding(1); // -> wraps to 0
    expect(nav.currentFindingIdx.value).toBe(0);
    nav.jumpToFinding(-1); // -> wraps to 1
    expect(nav.currentFindingIdx.value).toBe(1);
  });

  it("switches file via the injected selectFile(path, true) callback on a cross-file jump", () => {
    const { nav } = setup([
      finding({ id: "a", path: "a.ts" }),
      finding({ id: "b", path: "b.ts", severity: "risk" }),
    ]);
    nav.jumpToFinding(1);
    nav.jumpToFinding(1);
    expect(selectFile).toHaveBeenLastCalledWith(expect.any(String), true);
  });

  it("calls diffHandle.scrollToFinding with the finding's line/side after nextTick", async () => {
    const { nav } = setup([finding({ id: "a", line: 7, side: "LEFT" })]);
    nav.jumpToFinding(1);
    expect(scrollToFinding).not.toHaveBeenCalled();
    await nextTick();
    expect(scrollToFinding).toHaveBeenCalledWith(7, "LEFT");
  });

  it("is a no-op on an empty findings list", () => {
    const { nav } = setup([]);
    nav.jumpToFinding(1);
    expect(nav.currentFindingIdx.value).toBe(-1);
    expect(selectFile).not.toHaveBeenCalled();
  });

  it("current is null with no findings, and the current finding once positioned", () => {
    const { nav } = setup([finding({ id: "a" })]);
    expect(nav.current.value).toBeNull();
    nav.jumpToFinding(1);
    expect(nav.current.value?.id).toBe("a");
  });

  it("dismiss advances the cursor sanely and never lands out of range", () => {
    const { nav, findings } = setup([finding({ id: "a" }), finding({ id: "b" }), finding({ id: "c" })]);
    nav.jumpToFinding(1);
    nav.jumpToFinding(1); // now on "b" (idx 1)
    expect(nav.current.value?.id).toBe("b");

    onDismiss.mockImplementation((id: string) => {
      findings.value = findings.value.filter((f) => f.id !== id);
    });
    nav.dispatch("dismiss-finding");
    expect(onDismiss).toHaveBeenCalledWith("b");
    // List shrank to ["a", "c"] (2 items) — cursor must stay in range.
    expect(nav.currentFindingIdx.value).toBeLessThan(2);
    expect(nav.currentFindingIdx.value).toBeGreaterThanOrEqual(-1);
  });

  it("dispatch('help') calls the onHelp callback", () => {
    const { nav } = setup([finding()]);
    nav.dispatch("help");
    expect(onHelp).toHaveBeenCalled();
  });
});
