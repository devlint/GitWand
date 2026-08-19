/**
 * Task 1a (v3.7.0) — `useCommitReview` orchestrator: staged-diff AI review
 * engine, opt-in and off by default. Mocks `../../utils/backend` and
 * `../useAIProvider` per the established convention (`usePrPreReview.test.ts`).
 *
 * Verifier item #3 (v3.7.0 PR2 fixes) — `run()` now also resolves the
 * repo's HEAD commit (`git rev-parse HEAD`) so a completed review is stamped
 * against the commit it actually reviewed, letting the commit-time gate
 * detect a commit that happened outside the app since the last review.
 * `gitExecMock` therefore routes by git subcommand (`args[0]`) instead of a
 * single blind response queue: `rev-parse` calls are answered from
 * `headHashResponse` (a fixed stub unless a test explicitly changes HEAD to
 * simulate an out-of-band commit), and `diff` calls are answered from the
 * `diff*` helpers below — completely decoupling the two so existing
 * `mockResolvedValueOnce` diff sequencing never has to account for the
 * extra call.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const rawPromptMock = vi.fn();
const isAvailableRef = { value: true };
const getGitBlameMock = vi.fn();
const gitExecMock = vi.fn();
const readGitwandrcMock = vi.fn();

vi.mock("../useAIProvider", () => ({
  useAIProvider: () => ({
    isAvailable: isAvailableRef,
    rawPrompt: (...a: unknown[]) => rawPromptMock(...a),
  }),
}));

vi.mock("../../utils/backend", () => ({
  getGitBlame: (...a: unknown[]) => getGitBlameMock(...a),
  gitExec: (...a: unknown[]) => gitExecMock(...a),
  readGitwandrc: (...a: unknown[]) => readGitwandrcMock(...a),
}));

import { useCommitReview, COMMIT_REVIEW_MAX_FILES, COMMIT_REVIEW_MAX_BYTES } from "../useCommitReview";
import { useSettings, defaultAppSettings } from "../useSettings";
import { _resetCommitReviewStateForTesting } from "../commitReviewState";

function diffFor(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    "index 111..222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,1 +1,1 @@",
    "-old",
    "+new",
  ].join("\n");
}

/** Same file as `diffFor`, but with a SECOND added line — simulates editing
 *  and restaging a file that was already reviewed (verifier scenario B: the
 *  staged file COUNT is unchanged, only the content grew). */
function diffForTwoLines(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    "index 111..222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,2 +1,2 @@",
    "-old",
    "+new",
    "-old2",
    "+new2",
  ].join("\n");
}

function gitExecOk(stdout: string) {
  return { stdout, stderr: "", exitCode: 0 };
}

type ExecResult = { stdout: string; stderr: string; exitCode: number };

// ── gitExec routing: rev-parse (HEAD) vs diff (staged diff fetch) ────────
let headHashResponse = "head-hash-stub";
let diffOnceQueue: ExecResult[] = [];
let diffDefaultResponse: ExecResult | null = null;

/** Simulates an out-of-band commit (amend, terminal commit, external tool)
 *  changing HEAD between two `run()` calls. */
function setHeadHash(hash: string): void {
  headHashResponse = hash;
}

function queueDiffResponseOnce(res: ExecResult): void {
  diffOnceQueue.push(res);
}

function setDiffDefaultResponse(res: ExecResult): void {
  diffDefaultResponse = res;
}

function enableCommitReview(overrides: Partial<typeof defaultAppSettings> = {}) {
  const { settings } = useSettings();
  settings.value = { ...defaultAppSettings, commitReviewEnabled: true, ...overrides };
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { value: hidden, configurable: true });
}

describe("useCommitReview", () => {
  beforeEach(() => {
    rawPromptMock.mockReset();
    getGitBlameMock.mockReset().mockResolvedValue([]);
    gitExecMock.mockReset();
    // Default: no `.gitwandrc` on disk — every existing test (written before
    // Task 6) must fall back cleanly to the app settings, unaffected by the
    // new read.
    readGitwandrcMock.mockReset().mockResolvedValue("");
    headHashResponse = "head-hash-stub";
    diffOnceQueue = [];
    diffDefaultResponse = null;
    gitExecMock.mockImplementation(async (_cwd: string, args: string[]): Promise<ExecResult> => {
      if (args[0] === "rev-parse") return { stdout: headHashResponse, stderr: "", exitCode: 0 };
      if (diffOnceQueue.length) return diffOnceQueue.shift()!;
      if (diffDefaultResponse) return diffDefaultResponse;
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    isAvailableRef.value = true;
    const { settings } = useSettings();
    settings.value = { ...defaultAppSettings };
    localStorage.clear();
    _resetCommitReviewStateForTesting();
  });

  afterEach(() => {
    setHidden(false);
  });

  it("performs zero IPC and zero LLM calls when the setting is disabled, and reports it did not run", async () => {
    const { settings } = useSettings();
    settings.value = { ...defaultAppSettings, commitReviewEnabled: false };
    const review = useCommitReview();
    const ran = await review.run("/repo", "en");
    expect(gitExecMock).not.toHaveBeenCalled();
    expect(rawPromptMock).not.toHaveBeenCalled();
    expect(review.findings.value).toEqual([]);
    expect(ran).toBe(false);
  });

  it("performs zero IPC and zero LLM calls when the AI provider is unavailable, and reports it did not run", async () => {
    enableCommitReview();
    isAvailableRef.value = false;
    const review = useCommitReview();
    const ran = await review.run("/repo", "en");
    expect(gitExecMock).not.toHaveBeenCalled();
    expect(rawPromptMock).not.toHaveBeenCalled();
    expect(review.findings.value).toEqual([]);
    expect(ran).toBe(false);
  });

  it("reviews two staged files and aggregates findings + progress + per-file counts", async () => {
    enableCommitReview();
    setDiffDefaultResponse(gitExecOk(`${diffFor("a.ts")}\n${diffFor("b.ts")}`));
    rawPromptMock
      .mockResolvedValueOnce('[{"line": 1, "title": "finding a", "confidence": 80}]')
      .mockResolvedValueOnce('[{"line": 1, "title": "finding b", "confidence": 80}]');

    const review = useCommitReview();
    const ran = await review.run("/repo", "en");

    expect(review.findings.value).toHaveLength(2);
    expect(review.progress.value).toEqual({ done: 2, total: 2 });
    expect(review.findingsByFile.value).toEqual({ "a.ts": 1, "b.ts": 1 });
    expect(ran).toBe(true);
  });

  it("sets lastError (never throws) and leaves findings empty when gitExec exits non-zero", async () => {
    enableCommitReview();
    setDiffDefaultResponse({ stdout: "", stderr: "fatal: not a git repository", exitCode: 128 });

    const review = useCommitReview();
    let ran: boolean | undefined;
    await expect((async () => { ran = await review.run("/repo", "en"); })()).resolves.toBeUndefined();
    expect(review.findings.value).toEqual([]);
    expect(review.lastError.value).toBeTruthy();
    expect(rawPromptMock).not.toHaveBeenCalled();
    // A full attempt did occur (it just failed) — distinct from the
    // disabled/unavailable "never even tried" case above.
    expect(ran).toBe(true);
  });

  it("makes no LLM call on an empty staged diff (clean index is not an error), and reports it ran", async () => {
    enableCommitReview();
    setDiffDefaultResponse(gitExecOk(""));

    const review = useCommitReview();
    const ran = await review.run("/repo", "en");

    expect(rawPromptMock).not.toHaveBeenCalled();
    expect(review.findings.value).toEqual([]);
    expect(review.lastError.value).toBeNull();
    expect(ran).toBe(true);
  });

  it("aborts a run in flight when a second run() starts, painting no stale findings", async () => {
    enableCommitReview();
    let resolveFirst!: (v: string) => void;
    const pending = new Promise<string>((resolve) => { resolveFirst = resolve; });

    queueDiffResponseOnce(gitExecOk(diffFor("a.ts")));
    queueDiffResponseOnce(gitExecOk(diffFor("c.ts")));
    rawPromptMock
      .mockImplementationOnce(() => pending)
      .mockResolvedValueOnce('[{"line": 1, "title": "finding c", "confidence": 80}]');

    const review = useCommitReview();
    const firstRun = review.run("/repo", "en"); // starts, blocks on rawPrompt for a.ts
    // Flush every pending microtask chain (gitExec, queue's waitWhileHidden,
    // getGitBlame) so execution actually reaches the blocked rawPrompt call
    // before the second run starts — a macrotask tick drains all of them
    // since none of those awaits depend on a timer themselves.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const secondRun = review.run("/repo", "en"); // aborts the first, reviews c.ts
    await secondRun;
    resolveFirst('[{"line": 1, "title": "finding a (stale)", "confidence": 80}]');
    await firstRun;
    await Promise.resolve();

    expect(review.findings.value.map((f) => f.title)).toEqual(["finding c"]);
  });

  it("reset() clears findings, error, and aborts any run in flight", async () => {
    enableCommitReview();
    setDiffDefaultResponse(gitExecOk(diffFor("a.ts")));
    rawPromptMock.mockResolvedValue('[{"line": 1, "title": "finding a", "confidence": 80}]');

    const review = useCommitReview();
    await review.run("/repo", "en");
    expect(review.findings.value).toHaveLength(1);

    review.reset();
    expect(review.findings.value).toEqual([]);
    expect(review.rawFindings.value).toEqual([]);
    expect(review.lastError.value).toBeNull();
  });

  it("keeps a below-threshold finding in rawFindings but filters it out of findings", async () => {
    enableCommitReview({ reviewAiConfidenceThreshold: 60 });
    setDiffDefaultResponse(gitExecOk(diffFor("a.ts")));
    rawPromptMock.mockResolvedValue('[{"line": 1, "title": "low-confidence finding", "confidence": 20}]');

    const review = useCommitReview();
    await review.run("/repo", "en");

    expect(review.findings.value).toEqual([]);
    expect(review.rawFindings.value).toHaveLength(1);
  });

  it("caps the staged file count at exactly COMMIT_REVIEW_MAX_FILES and marks truncated", async () => {
    enableCommitReview();
    const manyFiles = Array.from({ length: 45 }, (_, i) => diffFor(`f${i}.ts`)).join("\n");
    setDiffDefaultResponse(gitExecOk(manyFiles));
    rawPromptMock.mockResolvedValue("[]");

    const review = useCommitReview();
    await review.run("/repo", "en");

    // Tightened from toBeLessThanOrEqual: that assertion passed even with 0
    // calls, so it never actually proved the cap triggered. 45 small files
    // fit well within the byte budget, so the file-count cap is the only
    // thing that can be limiting here — exactly 40 calls.
    expect(rawPromptMock.mock.calls.length).toBe(COMMIT_REVIEW_MAX_FILES);
    expect(review.truncated.value).toBe(true);
  });

  it("truncates by the byte budget when a single file's diff exceeds it, excluding files after it", async () => {
    enableCommitReview();
    const hugeAddedLine = "+" + "x".repeat(COMMIT_REVIEW_MAX_BYTES + 1000);
    const hugeDiff = [
      "diff --git a/huge.ts b/huge.ts",
      "index 111..222 100644",
      "--- a/huge.ts",
      "+++ b/huge.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      hugeAddedLine,
    ].join("\n");
    setDiffDefaultResponse(gitExecOk(`${hugeDiff}\n${diffFor("small.ts")}`));
    rawPromptMock.mockResolvedValue("[]");

    const review = useCommitReview();
    await review.run("/repo", "en");

    // huge.ts alone exhausts the byte budget, so small.ts (after it in the
    // diff) is never sent through the review pass.
    expect(rawPromptMock).toHaveBeenCalledTimes(1);
    expect(review.truncated.value).toBe(true);
  });

  it("resume() unblocks a run paused on document.hidden and lets it complete (never stays wedged)", async () => {
    enableCommitReview();
    setDiffDefaultResponse(gitExecOk(diffFor("a.ts")));
    rawPromptMock.mockResolvedValue('[{"line": 1, "title": "finding a", "confidence": 80}]');

    setHidden(true);
    const review = useCommitReview();
    const runPromise = review.run("/repo", "en");

    // Give the run a beat to reach the queue's document.hidden pause — it
    // must not have called rawPrompt yet, and `running` must still be true
    // (this is the exact hang the fix guards against: without resume() ever
    // being called, this promise would never settle).
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(rawPromptMock).not.toHaveBeenCalled();
    expect(review.running.value).toBe(true);

    setHidden(false);
    review.resume();
    await runPromise;

    expect(rawPromptMock).toHaveBeenCalledTimes(1);
    expect(review.findings.value).toHaveLength(1);
    expect(review.running.value).toBe(false);
  });

  it("does not let a stale aborted run's cleanup clobber a newer run's running/progress state", async () => {
    enableCommitReview();
    let resolveFirst!: (v: string) => void;
    const pending = new Promise<string>((resolve) => { resolveFirst = resolve; });

    queueDiffResponseOnce(gitExecOk(diffFor("a.ts")));
    queueDiffResponseOnce(gitExecOk(diffFor("c.ts")));
    rawPromptMock
      .mockImplementationOnce(() => pending)
      .mockResolvedValueOnce("[]");

    const review = useCommitReview();
    const firstRun = review.run("/repo", "en"); // blocks on rawPrompt for a.ts
    await new Promise((resolve) => setTimeout(resolve, 0));

    const secondRun = review.run("/repo", "en"); // aborts the first, reviews c.ts
    await secondRun;

    // Second run completed fully — running/progress must reflect it.
    expect(review.running.value).toBe(false);
    expect(review.progress.value).toEqual({ done: 1, total: 1 });

    // Now let the FIRST run's stale in-flight analyzeOne resolve. Its own
    // (now-orphaned) queue instance settles independently — it must not
    // touch the second run's running/progress state.
    resolveFirst("[]");
    await firstRun;
    await Promise.resolve();

    expect(review.running.value).toBe(false);
    expect(review.progress.value).toEqual({ done: 1, total: 1 });
  });

  // ── Task 3 (v3.7.0) — "Fix with agent" one-shot re-review arming ─────────
  // `armReReview()` / `onStagedSetChanged()` are the tested, real trigger for
  // the roadmap's "re-review triggers on the next staging change": App.vue's
  // staged-set watcher calls `onStagedSetChanged` directly (see App.vue), so
  // exercising it here proves the trigger actually fires end-to-end rather
  // than merely existing as a callable, unwired function (the exact shape of
  // bug that shipped `resume()` unwired in PR1).
  describe("armReReview() / onStagedSetChanged() — one-shot re-review", () => {
    // Assertions in this block check `rawPromptMock` (the LLM call — i.e.
    // "a review pass actually ran") rather than raw `gitExec` counts:
    // `onStagedSetChanged` also fires an unconditional coverage-refresh
    // `git diff` call on every invocation (verifier item #2), which is
    // orthogonal to whether the ARMED re-review itself fires, so a raw
    // gitExec count is no longer the right signal for "did a review run".

    it("arms exactly one auto re-review that fires on the next staged-set change", async () => {
      enableCommitReview({ commitReviewAutoReReview: true });
      setDiffDefaultResponse(gitExecOk(diffFor("a.ts")));
      rawPromptMock.mockResolvedValue("[]");

      const review = useCommitReview({ debounceMs: 0 });
      review.armReReview();
      review.onStagedSetChanged("/repo", "en", 1);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(rawPromptMock).toHaveBeenCalledTimes(1);
    });

    it("a second staged-set change after the arm has fired runs no further review", async () => {
      enableCommitReview({ commitReviewAutoReReview: true });
      setDiffDefaultResponse(gitExecOk(diffFor("a.ts")));
      rawPromptMock.mockResolvedValue("[]");

      const review = useCommitReview({ debounceMs: 0 });
      review.armReReview();
      review.onStagedSetChanged("/repo", "en", 1);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(rawPromptMock).toHaveBeenCalledTimes(1);

      rawPromptMock.mockClear();
      review.onStagedSetChanged("/repo", "en", 1); // arm already consumed — no re-run
      await new Promise((resolve) => setTimeout(resolve, 10));
      // The coverage refresh still runs (it's unconditional), but no NEW
      // review pass (no further LLM call) fires.
      expect(rawPromptMock).not.toHaveBeenCalled();
    });

    it("never arms when commitReviewAutoReReview is disabled", async () => {
      enableCommitReview({ commitReviewAutoReReview: false });
      setDiffDefaultResponse(gitExecOk(diffFor("a.ts")));
      const review = useCommitReview({ debounceMs: 0 });
      review.armReReview();
      review.onStagedSetChanged("/repo", "en", 1);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(rawPromptMock).not.toHaveBeenCalled();
    });

    it("does not fire the armed re-review when the next staged set is empty", async () => {
      enableCommitReview({ commitReviewAutoReReview: true });
      const review = useCommitReview({ debounceMs: 0 });
      review.armReReview();
      review.onStagedSetChanged("/repo", "en", 0); // staged count is 0 — nothing to review
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(rawPromptMock).not.toHaveBeenCalled();
      // The arm was still consumed by this (empty) staged-set change — a
      // LATER non-empty staging event must not unexpectedly trigger a run.
      review.onStagedSetChanged("/repo", "en", 1);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(rawPromptMock).not.toHaveBeenCalled();
    });

    it("onStagedSetChanged always resets findings/error even when nothing is armed", async () => {
      enableCommitReview();
      setDiffDefaultResponse(gitExecOk(diffFor("a.ts")));
      rawPromptMock.mockResolvedValue('[{"line": 1, "title": "finding a", "confidence": 80}]');

      const review = useCommitReview({ debounceMs: 0 });
      await review.run("/repo", "en");
      expect(review.findings.value).toHaveLength(1);

      review.onStagedSetChanged("/repo", "en", 1); // not armed — pure invalidation (D5)
      expect(review.findings.value).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      // Only the initial run() call touched rawPrompt — the staged-set
      // change itself must never auto-run when nothing was armed.
      expect(rawPromptMock).toHaveBeenCalledTimes(1);
    });

    // Race condition guard: stage → review → fix → restage → review again in
    // quick succession must never double-fire the one-shot re-review, even
    // when the debounce window overlaps two staged-set events.
    it("debounces rapid repeated staged-set changes into a single armed re-review", async () => {
      // Fake timers (pattern: useSecretsScanner.test.ts) rather than real
      // setTimeout waits — a real-timer version of this test was flaky under
      // load (the debounce window and the waits around it are only a few ms
      // apart), and fake timers make the sequencing deterministic instead of
      // load-dependent. Scoped to just this test; every other test in this
      // file keeps using real timers.
      vi.useFakeTimers();
      try {
        enableCommitReview({ commitReviewAutoReReview: true });
        setDiffDefaultResponse(gitExecOk(diffFor("a.ts")));
        rawPromptMock.mockResolvedValue("[]");

        const review = useCommitReview({ debounceMs: 20 });
        review.armReReview();
        review.onStagedSetChanged("/repo", "en", 1);
        // A second staged-set event arrives before the debounce window
        // elapses — it must reset the timer, not queue a second run.
        await vi.advanceTimersByTimeAsync(5);
        review.onStagedSetChanged("/repo", "en", 1);
        await vi.advanceTimersByTimeAsync(25);

        expect(rawPromptMock).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── Task 4 (v3.7.0) — iterations & coverage ───────────────────────────
  // ── Verifier item #2 — coverage must never assert 100% when it's actually
  // unknown/stale. `onStagedSetChanged` used to hardcode `coverage.value =
  // 100` unconditionally, which meant a brand-new unreviewed file staged
  // AFTER a completed review kept showing "100% reviewed" (and could get
  // written into a `GitWand-Review: ran (iter:N, coverage:100%)` trailer)
  // right up until the user clicked "Review staged changes" again.
  describe("coverage recompute on staged-set change (no commit involved)", () => {
    it("recomputes coverage against the current staged diff instead of asserting 100%", async () => {
      enableCommitReview();
      setDiffDefaultResponse(gitExecOk(diffFor("a.ts")));
      rawPromptMock.mockResolvedValue("[]");

      const review = useCommitReview({ debounceMs: 0 });
      await review.run("/repo", "en");
      expect(review.coverage.value).toBe(100);

      // A brand-new, never-reviewed file gets staged — no commit happened,
      // HEAD is unchanged, but the staged diff now includes unreviewed content.
      setDiffDefaultResponse(gitExecOk(`${diffFor("a.ts")}\n${diffFor("b.ts")}`));
      review.onStagedSetChanged("/repo", "en", 2);
      // The refresh is a plain diff fetch (no LLM call) — async, wait for it.
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(review.coverage.value).toBeLessThan(100);
    });

    it("is zero IPC when the feature is disabled (coverage stays at the neutral default)", async () => {
      const { settings } = useSettings();
      settings.value = { ...defaultAppSettings, commitReviewEnabled: false };

      const review = useCommitReview({ debounceMs: 0 });
      review.onStagedSetChanged("/repo", "en", 1);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(gitExecMock).not.toHaveBeenCalled();
      expect(review.coverage.value).toBe(100);
    });

    it("a stale in-flight coverage refresh never clobbers a newer staged-set change's result", async () => {
      enableCommitReview();
      let resolveSlow!: (v: ExecResult) => void;
      const slow = new Promise<ExecResult>((resolve) => { resolveSlow = resolve; });

      let diffCallN = 0;
      gitExecMock.mockImplementation(async (_cwd: string, args: string[]): Promise<ExecResult> => {
        if (args[0] === "rev-parse") return { stdout: headHashResponse, stderr: "", exitCode: 0 };
        diffCallN++;
        if (diffCallN === 1) return slow; // first staged-set change's refresh — deliberately slow
        return gitExecOk(`${diffFor("a.ts")}\n${diffFor("b.ts")}`); // second — resolves fast
      });

      const review = useCommitReview({ debounceMs: 0 });
      review.onStagedSetChanged("/repo", "en", 1); // fires the SLOW refresh
      await new Promise((resolve) => setTimeout(resolve, 5)); // let it start, still pending
      review.onStagedSetChanged("/repo", "en", 2); // fires a second, faster refresh
      await new Promise((resolve) => setTimeout(resolve, 10)); // let the fast one resolve

      // The newer refresh's result must be in effect: current diff is
      // a.ts+b.ts against zero reviewed hashes so far, so coverage is 0.
      expect(review.coverage.value).toBe(0);

      // Now let the STALE slow one resolve — it must not clobber the newer value.
      resolveSlow(gitExecOk(diffFor("a.ts")));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(review.coverage.value).toBe(0);
    });
  });

  // ── Second verifier pass — coverage:100% is still reachable, HIGH ────────
  // The staged-set watcher fix above only helps when the watcher actually
  // fires. `computeCurrentCoverage` is the shared, on-demand recompute
  // `App.vue`'s `proceedToCommit` awaits right before building the trailer —
  // correct regardless of watcher granularity (scenario B) or the review
  // pass's file/byte cap (scenario C).
  describe("computeCurrentCoverage — the pre-commit recompute", () => {
    it("scenario B: reflects new unreviewed content in the SAME file, even though the staged file COUNT never changed", async () => {
      enableCommitReview();
      setDiffDefaultResponse(gitExecOk(diffFor("a.ts")));
      rawPromptMock.mockResolvedValue("[]");

      const review = useCommitReview();
      await review.run("/repo", "en");
      expect(review.coverage.value).toBe(100);

      // Edit a.ts further and restage it — still exactly one staged file
      // (the count a naive watcher keys on never changes), but the diff
      // itself now has a second, never-reviewed added line.
      setDiffDefaultResponse(gitExecOk(diffForTwoLines("a.ts")));
      const fresh = await review.computeCurrentCoverage("/repo");

      // Only "new" (from the first review) is covered; "new2" is not — 1/2.
      expect(fresh).toBe(50);
      expect(review.coverage.value).toBe(50);
    });

    it("scenario C: reflects the FULL staged diff, not just the capped/reviewed subset", async () => {
      enableCommitReview();
      const manyFiles = Array.from({ length: 45 }, (_, i) => diffFor(`f${i}.ts`)).join("\n");
      setDiffDefaultResponse(gitExecOk(manyFiles));
      rawPromptMock.mockResolvedValue("[]");

      const review = useCommitReview();
      await review.run("/repo", "en");
      expect(review.truncated.value).toBe(true);

      // 40 of 45 staged files were actually reviewed (file-count cap) — the
      // completed run's OWN coverage must already reflect the full 45, not
      // tautologically equal the 40 it just reviewed.
      expect(review.coverage.value).toBe(89); // round(100 * 40 / 45)

      // The on-demand recompute (what proceedToCommit awaits) agrees.
      const fresh = await review.computeCurrentCoverage("/repo");
      expect(fresh).toBe(89);
    });

    it("returns 100 and stays IPC-free when cwd is empty", async () => {
      enableCommitReview();
      const review = useCommitReview();
      const result = await review.computeCurrentCoverage("");
      expect(result).toBe(100);
      expect(gitExecMock).not.toHaveBeenCalled();
    });

    it("third verifier pass, L1: keeps the last known coverage instead of an optimistic 100 when the feature is disabled mid-cycle", async () => {
      enableCommitReview();
      setDiffDefaultResponse(gitExecOk(diffForTwoLines("a.ts")));
      rawPromptMock.mockResolvedValue("[]");

      const review = useCommitReview();
      await review.run("/repo", "en");
      setDiffDefaultResponse(gitExecOk(`${diffForTwoLines("a.ts")}\n${diffFor("b.ts")}`));
      const partial = await review.computeCurrentCoverage("/repo");
      expect(partial).toBeLessThan(100);

      // Commit Review gets toggled off in Settings before the commit lands —
      // the trailer must still report the truthful, previously-computed
      // coverage, not silently launder it back to an optimistic 100%.
      const { settings } = useSettings();
      settings.value = { ...settings.value, commitReviewEnabled: false };
      const afterDisable = await review.computeCurrentCoverage("/repo");

      expect(afterDisable).toBe(partial);
      expect(review.coverage.value).toBe(partial);
    });
  });

  describe("iterations / coverage", () => {
    it("a completed run bumps iterations to 1 and coverage to 100", async () => {
      enableCommitReview();
      setDiffDefaultResponse(gitExecOk(diffFor("a.ts")));
      rawPromptMock.mockResolvedValue("[]");

      const review = useCommitReview();
      await review.run("/repo", "en");

      expect(review.iterations.value).toBe(1);
      expect(review.coverage.value).toBe(100);
    });

    it("staging a new unreviewed line drops coverage below 100 while the next run is in flight, then back to 100 once it completes", async () => {
      enableCommitReview();
      queueDiffResponseOnce(gitExecOk(diffFor("a.ts")));
      rawPromptMock.mockResolvedValueOnce("[]");

      const review = useCommitReview();
      await review.run("/repo", "en");
      expect(review.coverage.value).toBe(100);

      let resolveSecond!: (v: string) => void;
      const pending = new Promise<string>((resolve) => { resolveSecond = resolve; });
      // A bigger staged diff now includes an extra file with a brand-new,
      // never-reviewed line.
      queueDiffResponseOnce(gitExecOk(`${diffFor("a.ts")}\n${diffFor("b.ts")}`));
      rawPromptMock.mockImplementationOnce(() => pending).mockResolvedValueOnce("[]");

      const secondRun = review.run("/repo", "en");
      await new Promise((resolve) => setTimeout(resolve, 0)); // let the parse land before the LLM call resolves
      expect(review.coverage.value).toBeLessThan(100);

      resolveSecond("[]");
      await secondRun;
      expect(review.coverage.value).toBe(100);
      expect(review.iterations.value).toBe(2);
    });

    it("an aborted run does not bump iterations (a stale run's cleanup must not double-count)", async () => {
      enableCommitReview();
      let resolveFirst!: (v: string) => void;
      const pending = new Promise<string>((resolve) => { resolveFirst = resolve; });

      queueDiffResponseOnce(gitExecOk(diffFor("a.ts")));
      queueDiffResponseOnce(gitExecOk(diffFor("c.ts")));
      rawPromptMock
        .mockImplementationOnce(() => pending)
        .mockResolvedValueOnce("[]");

      const review = useCommitReview();
      const firstRun = review.run("/repo", "en"); // blocks on rawPrompt for a.ts
      await new Promise((resolve) => setTimeout(resolve, 0));

      const secondRun = review.run("/repo", "en"); // aborts the first, reviews c.ts
      await secondRun;
      expect(review.iterations.value).toBe(1);

      resolveFirst("[]");
      await firstRun;
      await Promise.resolve();

      // The stale first run's completion must never bump iterations again.
      expect(review.iterations.value).toBe(1);
    });

    it("clearReviewState resets iterations/coverage and the persisted store for that repo", async () => {
      enableCommitReview();
      setDiffDefaultResponse(gitExecOk(diffFor("a.ts")));
      rawPromptMock.mockResolvedValue("[]");

      const review = useCommitReview();
      await review.run("/repo", "en");
      expect(review.iterations.value).toBe(1);

      review.clearReviewState("/repo");
      expect(review.iterations.value).toBe(0);
      expect(review.coverage.value).toBe(100);

      // A brand-new composable instance for the same repo must also see the
      // cleared persisted state (not just this instance's in-memory refs).
      const another = useCommitReview();
      another.onStagedSetChanged("/repo", "en", 0);
      expect(another.iterations.value).toBe(0);
    });

    it("onStagedSetChanged refreshes iterations from persisted state when switching repos", async () => {
      enableCommitReview();
      setDiffDefaultResponse(gitExecOk(diffFor("a.ts")));
      rawPromptMock.mockResolvedValue("[]");

      const review = useCommitReview();
      await review.run("/repo-a", "en");
      expect(review.iterations.value).toBe(1);

      // Switching to a never-reviewed repo must not keep showing repo-a's count.
      review.onStagedSetChanged("/repo-b", "en", 0);
      expect(review.iterations.value).toBe(0);
    });

    // ── Verifier item #3 — bind the review cycle to HEAD ─────────────────
    // `run()` must stamp each completed review against the repo's HEAD at
    // review time, and `reconcileIterationsForHead` (the commit-time gate's
    // real trigger — App.vue's `proceedToCommit` awaits it before deciding
    // whether to show the decision modal) must catch a commit that happened
    // OUTSIDE the app (amend, terminal commit, external tool) since the last
    // recorded review, instead of trusting a stale `iterations` count.
    describe("HEAD-cycle binding", () => {
      it("run() stamps the review against the current HEAD", async () => {
        enableCommitReview();
        setHeadHash("sha-1");
        setDiffDefaultResponse(gitExecOk(diffFor("a.ts")));
        rawPromptMock.mockResolvedValue("[]");

        const review = useCommitReview();
        await review.run("/repo", "en");
        expect(review.iterations.value).toBe(1);

        // A second review against the SAME HEAD continues the same cycle.
        await review.run("/repo", "en");
        expect(review.iterations.value).toBe(2);
      });

      it("a review after HEAD changed (an out-of-band commit) starts a fresh cycle", async () => {
        enableCommitReview();
        setHeadHash("sha-1");
        setDiffDefaultResponse(gitExecOk(diffFor("a.ts")));
        rawPromptMock.mockResolvedValue("[]");

        const review = useCommitReview();
        await review.run("/repo", "en");
        expect(review.iterations.value).toBe(1);

        // Simulates a commit made outside the app (amend, terminal, external
        // tool) moving HEAD between two reviews.
        setHeadHash("sha-2");
        await review.run("/repo", "en");
        expect(review.iterations.value).toBe(1); // fresh cycle, not 2
      });

      it("reconcileIterationsForHead resets a stale iterations count when HEAD moved since the last review, with no review run in between", async () => {
        enableCommitReview();
        setHeadHash("sha-1");
        setDiffDefaultResponse(gitExecOk(diffFor("a.ts")));
        rawPromptMock.mockResolvedValue("[]");

        const review = useCommitReview();
        await review.run("/repo", "en");
        expect(review.iterations.value).toBe(1);

        // An out-of-band commit happens; the user never reviews again before
        // hitting commit — this is exactly the scenario the commit-time gate
        // (App.vue's `proceedToCommit`) must catch by awaiting this call
        // BEFORE checking `iterations` (verifier item #3).
        setHeadHash("sha-2");
        await review.reconcileIterationsForHead("/repo");

        expect(review.iterations.value).toBe(0);
      });

      it("reconcileIterationsForHead is a no-op when HEAD hasn't changed", async () => {
        enableCommitReview();
        setHeadHash("sha-1");
        setDiffDefaultResponse(gitExecOk(diffFor("a.ts")));
        rawPromptMock.mockResolvedValue("[]");

        const review = useCommitReview();
        await review.run("/repo", "en");
        expect(review.iterations.value).toBe(1);

        await review.reconcileIterationsForHead("/repo");
        expect(review.iterations.value).toBe(1);
      });
    });
  });

  // ── Task 6 (v3.7.0) — .gitwandrc commitReview opt-in override ──────────
  // `.gitwandrc`'s `commitReview` block overrides the app `Settings` in
  // BOTH directions. These tests prove the GATE itself changes behavior
  // (an actual `run()` call either does or doesn't call the LLM depending
  // on the override) rather than merely that `parseGitwandrc` parses the
  // block correctly in isolation (that's covered in packages/core).
  describe(".gitwandrc commitReview opt-in override", () => {
    function setGitwandrc(commitReview: Record<string, unknown>) {
      readGitwandrcMock.mockResolvedValue(JSON.stringify({ commitReview }));
    }

    it(".gitwandrc commitReview.enabled: false beats app commitReviewEnabled: true — no LLM call", async () => {
      enableCommitReview(); // commitReviewEnabled: true
      setGitwandrc({ enabled: false });
      setDiffDefaultResponse(gitExecOk(diffFor("a.ts")));

      const review = useCommitReview();
      const ran = await review.run("/repo", "en");

      expect(rawPromptMock).not.toHaveBeenCalled();
      expect(review.findings.value).toEqual([]);
      expect(ran).toBe(false);
    });

    it(".gitwandrc commitReview.enabled: true beats app commitReviewEnabled: false — the LLM call happens", async () => {
      const { settings } = useSettings();
      settings.value = { ...defaultAppSettings, commitReviewEnabled: false };
      setGitwandrc({ enabled: true });
      setDiffDefaultResponse(gitExecOk(diffFor("a.ts")));
      rawPromptMock.mockResolvedValueOnce('[{"line": 1, "title": "finding a", "confidence": 80}]');

      const review = useCommitReview();
      const ran = await review.run("/repo", "en");

      expect(rawPromptMock).toHaveBeenCalledTimes(1);
      expect(review.findings.value).toHaveLength(1);
      expect(ran).toBe(true);
    });

    it(".gitwandrc minConfidence overrides the app threshold", async () => {
      enableCommitReview({ reviewAiConfidenceThreshold: 10 }); // app threshold would keep this finding
      setGitwandrc({ minConfidence: 90 }); // repo demands a much higher bar
      setDiffDefaultResponse(gitExecOk(diffFor("a.ts")));
      rawPromptMock.mockResolvedValueOnce('[{"line": 1, "title": "medium-confidence finding", "confidence": 50}]');

      const review = useCommitReview();
      await review.run("/repo", "en");

      // Would have passed the app's threshold (10) but not the repo's (90).
      expect(review.findings.value).toEqual([]);
      expect(review.rawFindings.value).toHaveLength(1);
    });

    it("missing/unreadable .gitwandrc falls back cleanly to app settings", async () => {
      enableCommitReview();
      readGitwandrcMock.mockRejectedValue(new Error("ENOENT"));
      setDiffDefaultResponse(gitExecOk(diffFor("a.ts")));
      rawPromptMock.mockResolvedValueOnce('[{"line": 1, "title": "finding a", "confidence": 80}]');

      const review = useCommitReview();
      const ran = await review.run("/repo", "en");

      expect(ran).toBe(true);
      expect(review.findings.value).toHaveLength(1);
    });

    it("caches the .gitwandrc read — exactly one readGitwandrc call across two run() calls for the same repo", async () => {
      enableCommitReview();
      setGitwandrc({ enabled: true });
      setDiffDefaultResponse(gitExecOk(diffFor("a.ts")));
      rawPromptMock.mockResolvedValue("[]");

      const review = useCommitReview();
      await review.run("/repo", "en");
      await review.run("/repo", "en");

      expect(readGitwandrcMock).toHaveBeenCalledTimes(1);
    });

    it("two different repos resolve independently — no stale cross-repo cache entry", async () => {
      enableCommitReview(); // app default: enabled true
      setDiffDefaultResponse(gitExecOk(diffFor("a.ts")));
      rawPromptMock.mockResolvedValue("[]");

      readGitwandrcMock.mockImplementation(async (cwd: string) => {
        if (cwd === "/repo-off") return JSON.stringify({ commitReview: { enabled: false } });
        return "";
      });

      const review = useCommitReview();
      const ranOff = await review.run("/repo-off", "en");
      expect(ranOff).toBe(false);
      expect(rawPromptMock).not.toHaveBeenCalled();

      const ranOn = await review.run("/repo-on", "en");
      expect(ranOn).toBe(true);
      expect(rawPromptMock).toHaveBeenCalledTimes(1);
    });
  });
});
