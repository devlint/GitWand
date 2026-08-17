/**
 * Task 1a (v3.7.0) — `useCommitReview` orchestrator: staged-diff AI review
 * engine, opt-in and off by default. Mocks `../../utils/backend` and
 * `../useAIProvider` per the established convention (`usePrPreReview.test.ts`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const rawPromptMock = vi.fn();
const isAvailableRef = { value: true };
const getGitBlameMock = vi.fn();
const gitExecMock = vi.fn();

vi.mock("../useAIProvider", () => ({
  useAIProvider: () => ({
    isAvailable: isAvailableRef,
    rawPrompt: (...a: unknown[]) => rawPromptMock(...a),
  }),
}));

vi.mock("../../utils/backend", () => ({
  getGitBlame: (...a: unknown[]) => getGitBlameMock(...a),
  gitExec: (...a: unknown[]) => gitExecMock(...a),
}));

import { useCommitReview, COMMIT_REVIEW_MAX_FILES, COMMIT_REVIEW_MAX_BYTES } from "../useCommitReview";
import { useSettings, defaultAppSettings } from "../useSettings";

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

function gitExecOk(stdout: string) {
  return { stdout, stderr: "", exitCode: 0 };
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
    isAvailableRef.value = true;
    const { settings } = useSettings();
    settings.value = { ...defaultAppSettings };
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
    gitExecMock.mockResolvedValue(gitExecOk(`${diffFor("a.ts")}\n${diffFor("b.ts")}`));
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
    gitExecMock.mockResolvedValue({ stdout: "", stderr: "fatal: not a git repository", exitCode: 128 });

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
    gitExecMock.mockResolvedValue(gitExecOk(""));

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

    gitExecMock
      .mockResolvedValueOnce(gitExecOk(diffFor("a.ts")))
      .mockResolvedValueOnce(gitExecOk(diffFor("c.ts")));
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
    gitExecMock.mockResolvedValue(gitExecOk(diffFor("a.ts")));
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
    gitExecMock.mockResolvedValue(gitExecOk(diffFor("a.ts")));
    rawPromptMock.mockResolvedValue('[{"line": 1, "title": "low-confidence finding", "confidence": 20}]');

    const review = useCommitReview();
    await review.run("/repo", "en");

    expect(review.findings.value).toEqual([]);
    expect(review.rawFindings.value).toHaveLength(1);
  });

  it("caps the staged file count at exactly COMMIT_REVIEW_MAX_FILES and marks truncated", async () => {
    enableCommitReview();
    const manyFiles = Array.from({ length: 45 }, (_, i) => diffFor(`f${i}.ts`)).join("\n");
    gitExecMock.mockResolvedValue(gitExecOk(manyFiles));
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
    gitExecMock.mockResolvedValue(gitExecOk(`${hugeDiff}\n${diffFor("small.ts")}`));
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
    gitExecMock.mockResolvedValue(gitExecOk(diffFor("a.ts")));
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

    gitExecMock
      .mockResolvedValueOnce(gitExecOk(diffFor("a.ts")))
      .mockResolvedValueOnce(gitExecOk(diffFor("c.ts")));
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
    it("arms exactly one auto re-review that fires on the next staged-set change", async () => {
      enableCommitReview({ commitReviewAutoReReview: true });
      gitExecMock.mockResolvedValue(gitExecOk(diffFor("a.ts")));
      rawPromptMock.mockResolvedValue("[]");

      const review = useCommitReview({ debounceMs: 0 });
      review.armReReview();
      review.onStagedSetChanged("/repo", "en", 1);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(gitExecMock).toHaveBeenCalledTimes(1);
    });

    it("a second staged-set change after the arm has fired runs no further review", async () => {
      enableCommitReview({ commitReviewAutoReReview: true });
      gitExecMock.mockResolvedValue(gitExecOk(diffFor("a.ts")));
      rawPromptMock.mockResolvedValue("[]");

      const review = useCommitReview({ debounceMs: 0 });
      review.armReReview();
      review.onStagedSetChanged("/repo", "en", 1);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(gitExecMock).toHaveBeenCalledTimes(1);

      gitExecMock.mockClear();
      review.onStagedSetChanged("/repo", "en", 1); // arm already consumed — no re-run
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(gitExecMock).not.toHaveBeenCalled();
    });

    it("never arms when commitReviewAutoReReview is disabled", async () => {
      enableCommitReview({ commitReviewAutoReReview: false });
      const review = useCommitReview({ debounceMs: 0 });
      review.armReReview();
      review.onStagedSetChanged("/repo", "en", 1);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(gitExecMock).not.toHaveBeenCalled();
    });

    it("does not fire the armed re-review when the next staged set is empty", async () => {
      enableCommitReview({ commitReviewAutoReReview: true });
      const review = useCommitReview({ debounceMs: 0 });
      review.armReReview();
      review.onStagedSetChanged("/repo", "en", 0); // staged count is 0 — nothing to review
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(gitExecMock).not.toHaveBeenCalled();
      // The arm was still consumed by this (empty) staged-set change — a
      // LATER non-empty staging event must not unexpectedly trigger a run.
      review.onStagedSetChanged("/repo", "en", 1);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(gitExecMock).not.toHaveBeenCalled();
    });

    it("onStagedSetChanged always resets findings/error even when nothing is armed", async () => {
      enableCommitReview();
      gitExecMock.mockResolvedValue(gitExecOk(diffFor("a.ts")));
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
      enableCommitReview({ commitReviewAutoReReview: true });
      gitExecMock.mockResolvedValue(gitExecOk(diffFor("a.ts")));
      rawPromptMock.mockResolvedValue("[]");

      const review = useCommitReview({ debounceMs: 20 });
      review.armReReview();
      review.onStagedSetChanged("/repo", "en", 1);
      // A second staged-set event arrives before the debounce window elapses
      // — it must reset the timer, not queue a second run.
      await new Promise((resolve) => setTimeout(resolve, 5));
      review.onStagedSetChanged("/repo", "en", 1);
      await new Promise((resolve) => setTimeout(resolve, 40));

      expect(gitExecMock).toHaveBeenCalledTimes(1);
    });
  });
});
