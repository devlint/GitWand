/**
 * Task 1a (v3.7.0) — `useCommitReview` orchestrator: staged-diff AI review
 * engine, opt-in and off by default. Mocks `../../utils/backend` and
 * `../useAIProvider` per the established convention (`usePrPreReview.test.ts`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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

import { useCommitReview, COMMIT_REVIEW_MAX_FILES } from "../useCommitReview";
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

describe("useCommitReview", () => {
  beforeEach(() => {
    rawPromptMock.mockReset();
    getGitBlameMock.mockReset().mockResolvedValue([]);
    gitExecMock.mockReset();
    isAvailableRef.value = true;
    const { settings } = useSettings();
    settings.value = { ...defaultAppSettings };
  });

  it("performs zero IPC and zero LLM calls when the setting is disabled", async () => {
    const { settings } = useSettings();
    settings.value = { ...defaultAppSettings, commitReviewEnabled: false };
    const review = useCommitReview();
    await review.run("/repo", "en");
    expect(gitExecMock).not.toHaveBeenCalled();
    expect(rawPromptMock).not.toHaveBeenCalled();
    expect(review.findings.value).toEqual([]);
  });

  it("performs zero IPC and zero LLM calls when the AI provider is unavailable", async () => {
    enableCommitReview();
    isAvailableRef.value = false;
    const review = useCommitReview();
    await review.run("/repo", "en");
    expect(gitExecMock).not.toHaveBeenCalled();
    expect(rawPromptMock).not.toHaveBeenCalled();
    expect(review.findings.value).toEqual([]);
  });

  it("reviews two staged files and aggregates findings + progress + per-file counts", async () => {
    enableCommitReview();
    gitExecMock.mockResolvedValue(gitExecOk(`${diffFor("a.ts")}\n${diffFor("b.ts")}`));
    rawPromptMock
      .mockResolvedValueOnce('[{"line": 1, "title": "finding a", "confidence": 80}]')
      .mockResolvedValueOnce('[{"line": 1, "title": "finding b", "confidence": 80}]');

    const review = useCommitReview();
    await review.run("/repo", "en");

    expect(review.findings.value).toHaveLength(2);
    expect(review.progress.value).toEqual({ done: 2, total: 2 });
    expect(review.findingsByFile.value).toEqual({ "a.ts": 1, "b.ts": 1 });
  });

  it("sets lastError (never throws) and leaves findings empty when gitExec exits non-zero", async () => {
    enableCommitReview();
    gitExecMock.mockResolvedValue({ stdout: "", stderr: "fatal: not a git repository", exitCode: 128 });

    const review = useCommitReview();
    await expect(review.run("/repo", "en")).resolves.toBeUndefined();
    expect(review.findings.value).toEqual([]);
    expect(review.lastError.value).toBeTruthy();
    expect(rawPromptMock).not.toHaveBeenCalled();
  });

  it("makes no LLM call on an empty staged diff (clean index is not an error)", async () => {
    enableCommitReview();
    gitExecMock.mockResolvedValue(gitExecOk(""));

    const review = useCommitReview();
    await review.run("/repo", "en");

    expect(rawPromptMock).not.toHaveBeenCalled();
    expect(review.findings.value).toEqual([]);
    expect(review.lastError.value).toBeNull();
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

  it("caps the staged file count at COMMIT_REVIEW_MAX_FILES and marks truncated", async () => {
    enableCommitReview();
    const manyFiles = Array.from({ length: 45 }, (_, i) => diffFor(`f${i}.ts`)).join("\n");
    gitExecMock.mockResolvedValue(gitExecOk(manyFiles));
    rawPromptMock.mockResolvedValue("[]");

    const review = useCommitReview();
    await review.run("/repo", "en");

    expect(rawPromptMock.mock.calls.length).toBeLessThanOrEqual(COMMIT_REVIEW_MAX_FILES);
    expect(review.truncated.value).toBe(true);
  });
});
