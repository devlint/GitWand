/**
 * v3.7.0 review-round fix (Task 1, finding #1, CRITICAL): `repoStats` body
 * lifted verbatim out of `useGitRepo.ts` into a pure, Vue-free module so the
 * regression (a routine status poll wiping commit-review findings) can be
 * pinned with a unit test. `useGitRepo.ts` itself has no test harness of its
 * own for this computed, so these tests are the only executable proof.
 *
 * Root cause: `status.value = await getGitStatus(...)` assigns a BRAND NEW
 * object on every 2s poll tick even when nothing changed. The old
 * `repoStats` computed always returned a fresh object literal, so Vue's
 * `hasChanged(new, old)` (`!Object.is`) always saw a "change" and notified
 * every subscriber -- including a single-getter-array `watch` in App.vue,
 * whose multi-source form is *also* always "changed" for a fresh array
 * (see the `describe("Vue reactivity contract")` block below, which pins
 * that Vue semantic directly).
 */
import { describe, it, expect } from "vitest";
import { ref, computed, watch, nextTick } from "vue";
import type { GitStatus } from "../backend";
import {
  EMPTY_REPO_STATS,
  computeRepoStats,
  sameRepoStats,
  createRepoStatsMemo,
  stagedFingerprintOf,
} from "../repoStats";

function baseStatus(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: "main",
    remote: "origin",
    remoteBranchExists: true,
    ahead: 0,
    behind: 0,
    mainCommitCount: 1,
    pushRemote: null,
    aheadPush: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    ...overrides,
  };
}

describe("computeRepoStats", () => {
  it("returns EMPTY_REPO_STATS for a null status", () => {
    expect(computeRepoStats(null)).toEqual(EMPTY_REPO_STATS);
  });

  it("counts untracked files as added", () => {
    const status = baseStatus({ untracked: ["a.ts", "b.ts"] });
    const stats = computeRepoStats(status);
    expect(stats.added).toBe(2);
    expect(stats.untracked).toBe(2);
  });

  it("counts conflicted files as modified", () => {
    const status = baseStatus({ conflicted: ["c.ts"] });
    const stats = computeRepoStats(status);
    expect(stats.modified).toBe(1);
    expect(stats.conflicted).toBe(1);
  });

  it("maps staged renamed/deleted/added to the right bucket", () => {
    const status = baseStatus({
      staged: [
        { path: "r.ts", status: "renamed" },
        { path: "d.ts", status: "deleted" },
        { path: "a.ts", status: "added" },
        { path: "m.ts", status: "modified" },
      ],
    });
    const stats = computeRepoStats(status);
    expect(stats.staged).toBe(4);
    expect(stats.renamed).toBe(1);
    expect(stats.deleted).toBe(1);
    expect(stats.added).toBe(1);
    expect(stats.modified).toBe(1);
  });

  it("an unstaged deleted overrides a staged modified for the same file", () => {
    const status = baseStatus({
      staged: [{ path: "x.ts", status: "modified" }],
      unstaged: [{ path: "x.ts", status: "deleted" }],
    });
    const stats = computeRepoStats(status);
    // one file, counted once in the fileStates bucket, as "deleted"
    expect(stats.deleted).toBe(1);
    expect(stats.modified).toBe(0);
    expect(stats.staged).toBe(1);
    expect(stats.unstaged).toBe(1);
  });

  it("counts a file that is both staged and unstaged once in the fileStates map", () => {
    const status = baseStatus({
      staged: [{ path: "y.ts", status: "modified" }],
      unstaged: [{ path: "y.ts", status: "modified" }],
    });
    const stats = computeRepoStats(status);
    expect(stats.modified).toBe(1);
    expect(stats.staged).toBe(1);
    expect(stats.unstaged).toBe(1);
  });
});

describe("sameRepoStats", () => {
  it("is true for field-for-field identical stats objects (different references)", () => {
    const a = computeRepoStats(baseStatus({ untracked: ["a.ts"] }));
    const b = computeRepoStats(baseStatus({ untracked: ["a.ts"] }));
    expect(a).not.toBe(b);
    expect(sameRepoStats(a, b)).toBe(true);
  });

  it("is false when any of the 8 fields differ", () => {
    const a = computeRepoStats(baseStatus());
    expect(sameRepoStats(a, computeRepoStats(baseStatus({ staged: [{ path: "s.ts", status: "added" }] })))).toBe(false);
    expect(sameRepoStats(a, computeRepoStats(baseStatus({ unstaged: [{ path: "s.ts", status: "added" }] })))).toBe(false);
    expect(sameRepoStats(a, computeRepoStats(baseStatus({ conflicted: ["s.ts"] })))).toBe(false);
    expect(
      sameRepoStats(
        a,
        computeRepoStats(baseStatus({ staged: [{ path: "s.ts", status: "renamed" }] })),
      ),
    ).toBe(false);
  });
});

describe("createRepoStatsMemo (the regression proof)", () => {
  it("returns the SAME object reference for two distinct but structurally identical GitStatus objects", () => {
    const memo = createRepoStatsMemo();
    const first = memo(baseStatus({ staged: [{ path: "a.ts", status: "modified" }] }));
    // A brand new GitStatus object, structurally identical, as a routine poll
    // would produce.
    const second = memo(baseStatus({ staged: [{ path: "a.ts", status: "modified" }] }));
    expect(second).toBe(first);
  });

  it("returns a NEW reference as soon as staged differs", () => {
    const memo = createRepoStatsMemo();
    const first = memo(baseStatus({ staged: [{ path: "a.ts", status: "modified" }] }));
    const second = memo(
      baseStatus({
        staged: [
          { path: "a.ts", status: "modified" },
          { path: "b.ts", status: "added" },
        ],
      }),
    );
    expect(second).not.toBe(first);
  });

  it("returns a NEW reference as soon as unstaged differs", () => {
    const memo = createRepoStatsMemo();
    const first = memo(baseStatus());
    const second = memo(baseStatus({ unstaged: [{ path: "u.ts", status: "modified" }] }));
    expect(second).not.toBe(first);
  });

  it("returns a NEW reference as soon as conflicted differs", () => {
    const memo = createRepoStatsMemo();
    const first = memo(baseStatus());
    const second = memo(baseStatus({ conflicted: ["c.ts"] }));
    expect(second).not.toBe(first);
  });

  it("returns a NEW reference as soon as renamed differs", () => {
    const memo = createRepoStatsMemo();
    const first = memo(baseStatus({ staged: [{ path: "a.ts", status: "modified" }] }));
    const second = memo(baseStatus({ staged: [{ path: "a.ts", status: "renamed" }] }));
    expect(second).not.toBe(first);
  });

  it("returns EMPTY_REPO_STATS reference consistently across null statuses", () => {
    const memo = createRepoStatsMemo();
    const first = memo(null);
    const second = memo(null);
    expect(first).toBe(EMPTY_REPO_STATS);
    expect(second).toBe(EMPTY_REPO_STATS);
  });
});

describe("stagedFingerprintOf", () => {
  it("changes when unstage-A + stage-B happens even though the count stays the same", () => {
    const before = stagedFingerprintOf(baseStatus({ staged: [{ path: "a.ts", status: "modified" }] }));
    const after = stagedFingerprintOf(baseStatus({ staged: [{ path: "b.ts", status: "modified" }] }));
    expect(before).not.toBe(after);
  });

  it("changes when a status-only change happens (modified -> renamed)", () => {
    const before = stagedFingerprintOf(baseStatus({ staged: [{ path: "a.ts", status: "modified" }] }));
    const after = stagedFingerprintOf(baseStatus({ staged: [{ path: "a.ts", status: "renamed" }] }));
    expect(before).not.toBe(after);
  });

  it("is stable for structurally identical staged sets", () => {
    const a = stagedFingerprintOf(baseStatus({ staged: [{ path: "a.ts", status: "modified" }] }));
    const b = stagedFingerprintOf(baseStatus({ staged: [{ path: "a.ts", status: "modified" }] }));
    expect(a).toBe(b);
  });

  it("is empty string for a null status", () => {
    expect(stagedFingerprintOf(null)).toBe("");
  });

  it("does NOT normalize reordering (git's own order is stable, so this is fine by design)", () => {
    const orderA = stagedFingerprintOf(
      baseStatus({
        staged: [
          { path: "a.ts", status: "modified" },
          { path: "b.ts", status: "added" },
        ],
      }),
    );
    const orderB = stagedFingerprintOf(
      baseStatus({
        staged: [
          { path: "b.ts", status: "added" },
          { path: "a.ts", status: "modified" },
        ],
      }),
    );
    expect(orderA).not.toBe(orderB);
  });
});

describe("Vue reactivity contract (pins the Vue 3.5 semantics this fix relies on)", () => {
  it("Layer 1: memoized computed + multi-source watch does not re-fire on a no-op status reassignment", async () => {
    const memo = createRepoStatsMemo();
    const status = ref<GitStatus | null>(baseStatus({ staged: [{ path: "a.ts", status: "modified" }] }));
    const cwd = ref("repo1");
    const stats = computed(() => memo(status.value));

    let calls = 0;
    watch([() => cwd.value, () => stats.value.staged], () => {
      calls++;
    });

    await nextTick();
    expect(calls).toBe(0);

    // A brand new, structurally identical GitStatus object -- the routine
    // poll case.
    status.value = baseStatus({ staged: [{ path: "a.ts", status: "modified" }] });
    await nextTick();
    expect(calls).toBe(0);

    // A genuine staged-count change fires exactly once.
    status.value = baseStatus({
      staged: [
        { path: "a.ts", status: "modified" },
        { path: "b.ts", status: "added" },
      ],
    });
    await nextTick();
    expect(calls).toBe(1);
  });

  it("Layer 2: a non-memoized computed + the OLD single-getter-array watch fires on a no-op reassignment (reproduces the bug)", async () => {
    const status = ref<GitStatus | null>(baseStatus({ staged: [{ path: "a.ts", status: "modified" }] }));
    const cwd = ref("repo1");
    // Deliberately non-memoized: a fresh object literal every time, like the
    // pre-fix `repoStats` computed.
    const stats = computed(() => computeRepoStats(status.value));

    let calls = 0;
    // OLD shape: a single getter returning a fresh array literal.
    watch(
      () => [cwd.value, stats.value.staged] as const,
      () => {
        calls++;
      },
    );

    await nextTick();
    status.value = baseStatus({ staged: [{ path: "a.ts", status: "modified" }] });
    await nextTick();
    expect(calls).toBe(1); // reproduces the bug: fires on a no-op change
  });

  it("Layer 2b: the same non-memoized computed + the NEW multi-source shape does not fire on a no-op reassignment", async () => {
    const status = ref<GitStatus | null>(baseStatus({ staged: [{ path: "a.ts", status: "modified" }] }));
    const cwd = ref("repo1");
    const stats = computed(() => computeRepoStats(status.value));

    let calls = 0;
    // NEW shape: multi-source array, each source compared by its own value.
    watch([() => cwd.value, () => stats.value.staged], () => {
      calls++;
    });

    await nextTick();
    status.value = baseStatus({ staged: [{ path: "a.ts", status: "modified" }] });
    await nextTick();
    expect(calls).toBe(0);
  });
});
