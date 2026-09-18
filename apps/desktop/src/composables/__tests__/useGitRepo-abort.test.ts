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

import { useGitRepo, type ConfirmFn } from "../useGitRepo";
import {
  gitMergeAbort,
  gitCherryPickAbort,
  getGitStatus,
  getGitLog,
} from "../../utils/backend";

const CWD = "/repos/alpha";

/**
 * A stub for the injected modal. The parameter is annotated so that
 * `confirm.mock.calls[0][0]` is typed as the confirmation options rather than
 * an empty tuple — `vi.fn(async () => true)` would infer a zero-arg signature.
 */
function makeConfirm(answer: boolean) {
  return vi.fn(async (_o: Parameters<ConfirmFn>[0]) => answer);
}

/** A repo composable already pointed at a folder, with refresh() harmless. */
function makeRepo(confirm = makeConfirm(true)) {
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
  vi.mocked(gitCherryPickAbort).mockReset();
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

describe("cherryPickAbort", () => {
  it("returns true, sets the toast and leaves cherry-pick mode on success", async () => {
    const { repo } = makeRepo();
    repo.isCherryPicking.value = true;
    vi.mocked(gitCherryPickAbort).mockResolvedValue(undefined);

    const ok = await repo.cherryPickAbort();

    expect(ok).toBe(true);
    expect(repo.successMessage.value).toBe("cherry-pick-aborted");
    expect(repo.isCherryPicking.value).toBe(false);
  });

  it("stays in cherry-pick mode when the abort failed", async () => {
    const { repo } = makeRepo();
    repo.isCherryPicking.value = true;
    vi.mocked(gitCherryPickAbort).mockRejectedValue(
      new Error("error: no cherry-pick in progress"),
    );

    const ok = await repo.cherryPickAbort();

    expect(ok).toBe(false);
    expect(repo.isCherryPicking.value).toBe(true);
    expect(repo.error.value).toContain("no cherry-pick in progress");
    expect(repo.successMessage.value).not.toBe("cherry-pick-aborted");
  });

  it("returns false without calling git when no folder is open", async () => {
    const { repo } = makeRepo();
    repo.folderPath.value = null;

    const ok = await repo.cherryPickAbort();

    expect(ok).toBe(false);
    expect(gitCherryPickAbort).not.toHaveBeenCalled();
  });
});

describe("abort confirmation", () => {
  it("asks before a merge abort that would discard resolution work", async () => {
    const confirm = makeConfirm(true);
    const { repo } = makeRepo(confirm);
    vi.mocked(gitMergeAbort).mockResolvedValue({
      success: true,
      message: "Merge aborted",
    } as any);

    const ok = await repo.abortMerge({ hasResolutionWork: true });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]?.[0]?.danger).toBe(true);
    expect(ok).toBe(true);
  });

  it("does not ask when there is no resolution work", async () => {
    const confirm = makeConfirm(true);
    const { repo } = makeRepo(confirm);
    vi.mocked(gitMergeAbort).mockResolvedValue({
      success: true,
      message: "Merge aborted",
    } as any);

    await repo.abortMerge();
    await repo.abortMerge({ hasResolutionWork: false });

    expect(confirm).not.toHaveBeenCalled();
  });

  it("returns false and runs no git command when the user declines", async () => {
    const confirm = makeConfirm(false);
    const { repo } = makeRepo(confirm);

    const ok = await repo.abortMerge({ hasResolutionWork: true });

    expect(ok).toBe(false);
    expect(gitMergeAbort).not.toHaveBeenCalled();
    expect(repo.error.value).toBeFalsy();
  });

  it("asks before a cherry-pick abort that would discard resolution work", async () => {
    const confirm = makeConfirm(false);
    const { repo } = makeRepo(confirm);
    repo.isCherryPicking.value = true;

    const ok = await repo.cherryPickAbort({ hasResolutionWork: true });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(ok).toBe(false);
    expect(gitCherryPickAbort).not.toHaveBeenCalled();
    // Declining is not a failed abort — the mode flag must not move.
    expect(repo.isCherryPicking.value).toBe(true);
  });
});
