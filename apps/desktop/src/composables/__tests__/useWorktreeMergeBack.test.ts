import { describe, it, expect, vi } from "vitest";
import { createWorktreeMergeBack, type MergeBackDeps } from "../useWorktreeMergeBack";
import type { MergeBackCheck } from "../../utils/backend";
import type { ApplyOutcome } from "../useApplyFromPreview";

const check = (over: Partial<MergeBackCheck> = {}): MergeBackCheck => ({
  task_branch: "task/a",
  task_path: "/r.worktrees/a",
  name: "a",
  target: "main",
  default_target: "main",
  main_path: "/r",
  main_branch: "main",
  main_clean: true,
  task_commits: 2,
  task_dirty: false,
  refusal: null,
  ...over,
});

const outcome = (over: Partial<ApplyOutcome> = {}): ApplyOutcome => ({
  operation: "merge",
  ref: "task/a",
  estimatedHunks: 0,
  snapshotId: null,
  operationError: null,
  appliedHunks: 0,
  filesResolved: [],
  residualFiles: [],
  residualHunks: 0,
  finalized: true,
  stoppedReason: "clean",
  estimateDrifted: false,
  ...over,
});

function deps(over: Partial<MergeBackDeps> = {}) {
  const d: MergeBackDeps = {
    check: vi.fn(async (_c: string, _p: string, target?: string | null) => check(target ? { target } : {})),
    switchBranch: vi.fn(async () => {}),
    prepare: vi.fn(async () => ({ check: check(), survivors: [], task_snapshot: null, main_snapshot: null, committed_wip: false })),
    apply: vi.fn(async () => outcome()),
    fastForward: vi.fn(async () => ({ conflicts: false })),
    ...over,
  };
  return d;
}

const req = { cwd: "/r", path: "/r.worktrees/a" };

describe("useWorktreeMergeBack", () => {
  it("opens on the default target in merge mode", async () => {
    const d = deps();
    const m = createWorktreeMergeBack(d);
    await m.open(req);
    expect(m.state.value.phase).toBe("choose");
    expect(m.state.value.mode).toBe("merge");
    expect(m.state.value.check?.target).toBe("main");
  });

  it("offers to switch a clean main checkout to the target, then checks again", async () => {
    let on = "other";
    const d = deps({
      check: vi.fn(async () =>
        on === "main" ? check() : check({ main_branch: on, refusal: { code: "wrong-branch", message: "x", paths: [] } }),
      ),
      switchBranch: vi.fn(async () => {
        on = "main";
      }),
    });
    const m = createWorktreeMergeBack(d);
    await m.open(req);
    expect(m.canSwitch.value).toBe(true);
    await m.start();
    expect(d.prepare, "a refusal starts nothing").not.toHaveBeenCalled();
    await m.switchMain();
    expect(d.switchBranch).toHaveBeenCalledWith("/r", "main");
    expect(m.state.value.check?.refusal).toBeNull();
  });

  it("previews against the right checkout for each mode", async () => {
    const m = createWorktreeMergeBack(deps());
    await m.open(req);
    expect(m.previewSpec.value).toEqual({ cwd: "/r", ref: "task/a", operation: "merge" });
    m.setMode("squash");
    expect(m.previewSpec.value).toEqual({ cwd: "/r", ref: "task/a", operation: "merge" });
    m.setMode("rebase");
    expect(m.previewSpec.value).toEqual({ cwd: "/r.worktrees/a", ref: "main", operation: "rebase" });
  });

  it("lists the task's processes and goes no further until they are gone", async () => {
    let calls = 0;
    const d = deps({
      prepare: vi.fn(async () => ({
        check: check(),
        survivors: ++calls === 1 ? [{ pid: 3, ppid: 1, name: "claude" }] : [],
        task_snapshot: null,
        main_snapshot: null,
        committed_wip: false,
      })),
    });
    const m = createWorktreeMergeBack(d);
    await m.open(req);
    await m.start();
    expect(m.state.value.phase).toBe("processes");
    await m.start();
    expect(m.state.value.phase).toBe("preview");
  });

  it("merge: applies in the main checkout and lands on done", async () => {
    const d = deps();
    const m = createWorktreeMergeBack(d);
    await m.open(req);
    await m.start();
    await m.apply(4);
    expect(d.apply).toHaveBeenCalledWith({
      checkout: "/r",
      operation: "merge",
      ref: "task/a",
      estimated: 4,
      mode: "merge",
      target: "main",
      path: "/r.worktrees/a",
    });
    expect(m.state.value.phase).toBe("done");
    expect(m.cleanup.value).toEqual({ deleteBranch: true });
  });

  it("rebase: rebases in the task worktree, then fast-forwards the target", async () => {
    const d = deps();
    const m = createWorktreeMergeBack(d);
    await m.open(req);
    m.setMode("rebase");
    await m.start();
    await m.apply(0);
    expect(d.apply).toHaveBeenCalledWith(expect.objectContaining({ checkout: "/r.worktrees/a", operation: "rebase", ref: "main" }));
    expect(d.fastForward).toHaveBeenCalledWith("/r", "/r.worktrees/a", "main");
    expect(m.state.value.phase).toBe("done");
  });

  it("stops on what the engine left, then resumes once the user finished", async () => {
    const d = deps({ apply: vi.fn(async () => outcome({ operation: "rebase", stoppedReason: "residual", finalized: false, residualFiles: ["a.ts"] })) });
    const m = createWorktreeMergeBack(d);
    await m.open(req);
    m.setMode("rebase");
    await m.start();
    await m.apply(0);
    expect(m.state.value.phase).toBe("residual");
    expect(d.fastForward).not.toHaveBeenCalled();
    d.fastForward = vi.fn(async () => Promise.reject(new Error("task-in-progress: finish the rebase")));
    await m.resume();
    expect(m.state.value.phase).toBe("residual");
    expect(m.state.value.error).toContain("task-in-progress");
    d.fastForward = vi.fn(async () => ({ conflicts: false }));
    await m.resume();
    expect(m.state.value.phase).toBe("done");
  });

  it("merge residual: done only once the main checkout is no longer mid-merge", async () => {
    const d = deps({ apply: vi.fn(async () => outcome({ stoppedReason: "residual", finalized: false })) });
    const m = createWorktreeMergeBack(d);
    await m.open(req);
    await m.start();
    await m.apply(0);
    expect(m.state.value.phase).toBe("residual");
    d.check = vi.fn(async () => check({ refusal: { code: "main-in-progress", message: "mid merge", paths: [] } }));
    await m.resume();
    expect(m.state.value.phase).toBe("residual");
    expect(m.state.value.error).toBe("mid merge");
    d.check = vi.fn(async () => check({ refusal: { code: "nothing", message: "", paths: [] } }));
    await m.resume();
    expect(m.state.value.phase).toBe("done");
  });

  it("squash: the branch is not merged, so cleanup asks", async () => {
    const m = createWorktreeMergeBack(deps());
    await m.open(req);
    m.setMode("squash");
    await m.start();
    await m.apply(0);
    expect(m.state.value.phase).toBe("done");
    expect(m.cleanup.value).toEqual({ deleteBranch: false });
  });

  it("an operation git refused is an error, nothing more is run", async () => {
    const d = deps({ apply: vi.fn(async () => outcome({ stoppedReason: "op-failed", operationError: "refused" })) });
    const m = createWorktreeMergeBack(d);
    await m.open(req);
    m.setMode("rebase");
    await m.start();
    await m.apply(0);
    expect(m.state.value.phase).toBe("error");
    expect(m.state.value.error).toBe("refused");
    expect(d.fastForward).not.toHaveBeenCalled();
  });

  it("a changed target is checked again", async () => {
    const d = deps();
    const m = createWorktreeMergeBack(d);
    await m.open(req);
    await m.setTarget("develop");
    expect(d.check).toHaveBeenLastCalledWith("/r", "/r.worktrees/a", "develop");
    expect(m.state.value.check?.target).toBe("develop");
  });

  it("ignores a second click while a step runs", async () => {
    const d = deps();
    const m = createWorktreeMergeBack(d);
    await m.open(req);
    await Promise.all([m.start(), m.start()]);
    expect(d.prepare).toHaveBeenCalledTimes(1);
    await Promise.all([m.apply(0), m.apply(0)]);
    expect(d.apply).toHaveBeenCalledTimes(1);
  });
});
