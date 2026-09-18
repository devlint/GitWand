// @vitest-environment jsdom
//
// `useGitRepo` reaches `../../utils/backend`, which reads `window` at import
// time (apps/desktop/src/CLAUDE.md § Tests Vitest).
/**
 * useGitRepo.runOperationAction — one function for continue/abort/skip across
 * every operation. See
 * docs/superpowers/specs/2026-09-18-unified-operation-actions-design.md §5.
 *
 * Carries over the cases from useGitRepo-abort.test.ts (#201), which this
 * replaces: git's refusal is surfaced, a decline runs no git command, and
 * refresh() runs before `error` is assigned.
 *
 * The git layer is not mocked: `src/utils/backend` is, which is the IPC
 * wrapper module. The real-git contract is locked by operationAction.git.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../utils/backend");

import { useGitRepo, type ConfirmFn } from "../useGitRepo";
import {
  gitOperationAction,
  gitRepoState,
  getGitStatus,
  getGitLog,
} from "../../utils/backend";

const CWD = "/repos/alpha";

function makeConfirm(answer: boolean) {
  return vi.fn(async (_o: Parameters<ConfirmFn>[0]) => answer);
}

/** A repo composable pointed at a folder, mid-operation, refresh() harmless. */
function makeRepo(confirm = makeConfirm(true), state = "merge") {
  vi.mocked(getGitStatus).mockResolvedValue({
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    branch: "main",
  } as any);
  vi.mocked(getGitLog).mockResolvedValue([] as any);
  vi.mocked(gitRepoState).mockResolvedValue({
    state,
    hasConflict: true,
    operationHead: null,
    targetBranch: null,
    step: 0,
    total: 0,
  } as any);
  const repo = useGitRepo({ confirm });
  repo.folderPath.value = CWD;
  return { repo, confirm };
}

beforeEach(() => {
  vi.mocked(gitOperationAction).mockReset();
  vi.mocked(gitRepoState).mockReset();
});

describe("runOperationAction", () => {
  it("returns true and names the operation the repo is actually in", async () => {
    const { repo } = makeRepo(makeConfirm(true), "cherry_pick");
    vi.mocked(gitOperationAction).mockResolvedValue({ halted: false });

    const ok = await repo.runOperationAction("abort");

    expect(ok).toBe(true);
    expect(gitOperationAction).toHaveBeenCalledWith(CWD, "cherry_pick", "abort");
  });

  it("treats a halt on a further conflict as success, not failure", async () => {
    // git advanced and stopped where it should — no error surface.
    const { repo } = makeRepo();
    vi.mocked(gitOperationAction).mockResolvedValue({ halted: true });

    const ok = await repo.runOperationAction("continue");

    expect(ok).toBe(true);
    expect(repo.error.value).toBeFalsy();
  });

  it("returns false and surfaces git's message when git refused", async () => {
    const { repo } = makeRepo();
    vi.mocked(gitOperationAction).mockRejectedValue(
      new Error("git merge --abort failed: fatal: There is no merge to abort"),
    );

    const ok = await repo.runOperationAction("abort");

    expect(ok).toBe(false);
    expect(repo.error.value).toContain("There is no merge to abort");
  });

  it("returns false without calling git when nothing is in progress", async () => {
    const { repo } = makeRepo(makeConfirm(true), "clean");

    const ok = await repo.runOperationAction("abort");

    expect(ok).toBe(false);
    expect(gitOperationAction).not.toHaveBeenCalled();
  });

  it("returns false without calling git when no folder is open", async () => {
    const { repo } = makeRepo();
    repo.folderPath.value = null;

    const ok = await repo.runOperationAction("abort");

    expect(ok).toBe(false);
    expect(gitOperationAction).not.toHaveBeenCalled();
  });

  it("confirms before an abort that would discard resolution work", async () => {
    const confirm = makeConfirm(true);
    const { repo } = makeRepo(confirm);
    vi.mocked(gitOperationAction).mockResolvedValue({ halted: false });

    const ok = await repo.runOperationAction("abort", {
      hasResolutionWork: true,
    });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]?.[0]?.danger).toBe(true);
    expect(ok).toBe(true);
  });

  it("does not confirm a continue, which discards nothing", async () => {
    const confirm = makeConfirm(true);
    const { repo } = makeRepo(confirm);
    vi.mocked(gitOperationAction).mockResolvedValue({ halted: false });

    await repo.runOperationAction("continue", { hasResolutionWork: true });

    expect(confirm).not.toHaveBeenCalled();
  });

  it("runs no git command when the user declines", async () => {
    const confirm = makeConfirm(false);
    const { repo } = makeRepo(confirm);

    const ok = await repo.runOperationAction("abort", {
      hasResolutionWork: true,
    });

    expect(ok).toBe(false);
    expect(gitOperationAction).not.toHaveBeenCalled();
    expect(repo.error.value).toBeFalsy();
  });
});
