import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { nextTick, ref } from "vue";
import { useBranchPrSearch } from "../useBranchPrSearch";
import type { PullRequest } from "../../utils/backend";

function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 42,
    title: "Fix the thing",
    state: "open",
    author: "octocat",
    branch: "feat/the-thing",
    base: "main",
    draft: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    url: "https://github.com/acme/repo/pull/42",
    additions: 0,
    deletions: 0,
    labels: [],
    assignees: [],
    reviewRequested: [],
    reviewDecision: "",
    mergeStateStatus: "",
    checksRollup: "",
    commentCount: 0,
    ...overrides,
  };
}

describe("useBranchPrSearch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("prNumberQuery is null for plain text and for partial PR-like text", () => {
    const filterText = ref("feature-x");
    const search = useBranchPrSearch({
      cwd: ref("/repo"),
      filterText,
      prs: ref([]),
      forge: ref({ getPR: vi.fn() } as any),
    });
    expect(search.prNumberQuery.value).toBeNull();

    filterText.value = "#93x";
    expect(search.prNumberQuery.value).toBeNull();

    filterText.value = "#93 ";
    expect(search.prNumberQuery.value).toBe(93);
  });

  it("resolves synchronously from the cached PR list on a cache hit (no fetch)", async () => {
    const getPR = vi.fn();
    const filterText = ref("");
    const search = useBranchPrSearch({
      cwd: ref("/repo"),
      filterText,
      prs: ref([makePr({ number: 42, branch: "feat/the-thing" })]),
      forge: ref({ getPR } as any),
    });

    filterText.value = "#42";
    await nextTick();

    expect(search.lookupLoading.value).toBe(false);
    expect(search.matchesResolvedBranch("feat/the-thing", false)).toBe(true);
    expect(search.matchesResolvedBranch("other-branch", false)).toBe(false);
    expect(getPR).not.toHaveBeenCalled();
  });

  it("falls back to forge.getPR after a debounce on a cache miss, and resolves the branch", async () => {
    const getPR = vi.fn(async () => ({ branch: "fix/old-pr" }));
    const filterText = ref("");
    const search = useBranchPrSearch({
      cwd: ref("/repo"),
      filterText,
      prs: ref([]),
      forge: ref({ getPR } as any),
      debounceMs: 300,
    });

    filterText.value = "#9335";
    await nextTick();
    expect(search.lookupLoading.value).toBe(true);
    expect(getPR).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);

    expect(getPR).toHaveBeenCalledWith("/repo", 9335);
    expect(search.lookupLoading.value).toBe(false);
    expect(search.matchesResolvedBranch("fix/old-pr", false)).toBe(true);
  });

  it("debounces rapid keystrokes into a single fetch for the final value", async () => {
    const getPR = vi.fn(async () => ({ branch: "fix/old-pr" }));
    const filterText = ref("");
    useBranchPrSearch({
      cwd: ref("/repo"),
      filterText,
      prs: ref([]),
      forge: ref({ getPR } as any),
      debounceMs: 300,
    });

    filterText.value = "#9";
    await nextTick();
    filterText.value = "#93";
    await nextTick();
    filterText.value = "#9335";
    await nextTick();

    await vi.advanceTimersByTimeAsync(300);

    expect(getPR).toHaveBeenCalledTimes(1);
    expect(getPR).toHaveBeenCalledWith("/repo", 9335);
  });

  it("leaves the branch unresolved when the fetch rejects (not found)", async () => {
    const getPR = vi.fn(async () => {
      throw new Error("404");
    });
    const filterText = ref("");
    const search = useBranchPrSearch({
      cwd: ref("/repo"),
      filterText,
      prs: ref([]),
      forge: ref({ getPR } as any),
      debounceMs: 300,
    });

    filterText.value = "#404";
    await nextTick();
    await vi.advanceTimersByTimeAsync(300);
    await nextTick();

    expect(search.lookupLoading.value).toBe(false);
    expect(search.matchesResolvedBranch("anything", false)).toBe(false);
  });

  it("prFor strips the origin/ prefix for remote branches but not for local ones", () => {
    const pr = makePr({ number: 7, branch: "feat/y" });
    const search = useBranchPrSearch({
      cwd: ref("/repo"),
      filterText: ref(""),
      prs: ref([pr]),
      forge: ref({ getPR: vi.fn() } as any),
    });

    expect(search.prFor("feat/y", false)).toBe(pr);
    expect(search.prFor("origin/feat/y", true)).toBe(pr);
    expect(search.prFor("origin/feat/y", false)).toBeNull();
    expect(search.prFor("feat/y", true)).toBeNull();
  });

  it("matchesResolvedBranch strips the origin/ prefix for remote branches", async () => {
    const filterText = ref("");
    const search = useBranchPrSearch({
      cwd: ref("/repo"),
      filterText,
      prs: ref([makePr({ number: 42, branch: "feat/the-thing" })]),
      forge: ref({ getPR: vi.fn() } as any),
    });

    filterText.value = "#42";
    await nextTick();

    expect(search.matchesResolvedBranch("origin/feat/the-thing", true)).toBe(true);
    expect(search.matchesResolvedBranch("feat/the-thing", true)).toBe(false);
  });

  it("clears resolution state when the query is cleared", async () => {
    const filterText = ref("");
    const search = useBranchPrSearch({
      cwd: ref("/repo"),
      filterText,
      prs: ref([makePr({ number: 42, branch: "feat/the-thing" })]),
      forge: ref({ getPR: vi.fn() } as any),
    });

    filterText.value = "#42";
    await nextTick();
    expect(search.matchesResolvedBranch("feat/the-thing", false)).toBe(true);

    filterText.value = "";
    await nextTick();
    expect(search.prNumberQuery.value).toBeNull();
    expect(search.matchesResolvedBranch("feat/the-thing", false)).toBe(false);
  });
});
