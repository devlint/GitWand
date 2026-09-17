// @vitest-environment jsdom
//
// `useGitRepo` reaches `../../utils/backend`, which reads `window` at import
// time, so the default `node` environment cannot load it (repo convention:
// opt in per-file — apps/desktop/src/CLAUDE.md § Tests Vitest).
/**
 * useGitRepo — abort paths for issue #197. One case per decision in
 * docs/superpowers/specs/2026-09-17-issue-197-merge-abort-design.md §3.
 *
 * The git layer is not mocked here: `src/utils/backend` is, which is the IPC
 * wrapper module, not git. The real-git contract these tests assume (a refused
 * abort exits non-zero, which the backend surfaces as success: false) is locked
 * by mergeAbort.git.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../utils/backend");

import { useGitRepo } from "../useGitRepo";
import {
  gitMergeAbort,
  getGitStatus,
  getGitLog,
} from "../../utils/backend";

const CWD = "/repos/alpha";

/** A repo composable already pointed at a folder, with refresh() harmless. */
function makeRepo(confirm = vi.fn(async () => true)) {
  vi.mocked(getGitStatus).mockResolvedValue({
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    branch: "main",
  } as any);
  vi.mocked(getGitLog).mockResolvedValue([] as any);
  const repo = useGitRepo({ confirm });
  repo.folderPath.value = CWD;
  return { repo, confirm };
}

beforeEach(() => {
  vi.mocked(gitMergeAbort).mockReset();
});

describe("abortMerge", () => {
  it("returns true and sets the toast when git aborted", async () => {
    const { repo } = makeRepo();
    vi.mocked(gitMergeAbort).mockResolvedValue({
      success: true,
      message: "Merge aborted",
    } as any);

    const ok = await repo.abortMerge();

    expect(ok).toBe(true);
    expect(repo.successMessage.value).toBe("merge-aborted");
    expect(repo.error.value).toBeFalsy();
  });

  it("returns false and surfaces git's message when git refused", async () => {
    const { repo } = makeRepo();
    vi.mocked(gitMergeAbort).mockResolvedValue({
      success: false,
      message: "error: Entry 'a.txt' not uptodate. Cannot merge.",
    } as any);

    const ok = await repo.abortMerge();

    expect(ok).toBe(false);
    expect(repo.successMessage.value).not.toBe("merge-aborted");
    expect(repo.error.value).toContain("not uptodate");
  });

  it("returns false and surfaces the error when the IPC call rejects", async () => {
    const { repo } = makeRepo();
    vi.mocked(gitMergeAbort).mockRejectedValue(new Error("ipc down"));

    const ok = await repo.abortMerge();

    expect(ok).toBe(false);
    expect(repo.error.value).toContain("ipc down");
  });

  it("returns false without calling git when no folder is open", async () => {
    const { repo } = makeRepo();
    repo.folderPath.value = null;

    const ok = await repo.abortMerge();

    expect(ok).toBe(false);
    expect(gitMergeAbort).not.toHaveBeenCalled();
  });
});
