import { describe, it, expect, vi } from "vitest";
import { createWorktreeRemoval, type WorktreeRemovalDeps } from "../useWorktreeRemoval";
import type { WorktreeGuard, RemoveOptions } from "../../utils/backend";
import type { HookTrustDecision } from "../useWorktreeHookTrust";

const guard = (over: Partial<WorktreeGuard> = {}): WorktreeGuard => ({
  untouchable: false,
  reasons: [],
  owned: true,
  recorded: true,
  teardown_required: true,
  branch: "task/x",
  lock_reason: null,
  ...over,
});

const run: HookTrustDecision = {
  choice: "run",
  status: { trusted: true, hash: "h1", hooks: { setup: null, teardown: "bin/down", url: null }, repo_root: "/r" },
} as unknown as HookTrustDecision;

function deps(over: Partial<WorktreeRemovalDeps> = {}) {
  const removed: RemoveOptions[] = [];
  const d: WorktreeRemovalDeps = {
    guard: vi.fn(async () => guard()),
    prepare: vi.fn(async () => ({ survivors: [], snapshot: { id: "1-ab" } as never })),
    remove: vi.fn(async (_c: string, _p: string, opts: RemoveOptions) => {
      removed.push(opts);
      return { branch_deleted: "task/x", warnings: [] };
    }),
    unlock: vi.fn(async () => {}),
    ensureTrusted: vi.fn(async () => run),
    runTeardown: vi.fn(async () => ({ code: 0, tabId: 7 })),
    disposeTabs: vi.fn(async () => {}),
    closeRepoTabs: vi.fn(),
    ...over,
  };
  return { d, removed };
}

const req = { repoPath: "/r", cwd: "/r", path: "/r.worktrees/x", name: "x", deleteBranch: true };

describe("useWorktreeRemoval", () => {
  it("refuses an untouchable worktree and offers nothing but unlock", async () => {
    const { d } = deps({ guard: vi.fn(async () => guard({ untouchable: true, reasons: ["locked"] })) });
    const r = createWorktreeRemoval(d);
    await r.check(req);
    expect(r.state.value.phase).toBe("refused");
    await r.confirm({});
    expect(d.prepare).not.toHaveBeenCalled();
    expect(d.remove).not.toHaveBeenCalled();
  });

  it("unlocks then checks again", async () => {
    let locked = true;
    const { d } = deps({
      guard: vi.fn(async () => (locked ? guard({ untouchable: true, reasons: ["locked"] }) : guard())),
      unlock: vi.fn(async () => {
        locked = false;
      }),
    });
    const r = createWorktreeRemoval(d);
    await r.check(req);
    await r.unlock();
    expect(d.unlock).toHaveBeenCalledWith("/r", "/r.worktrees/x");
    expect(r.state.value.phase).toBe("confirm");
  });

  it("runs guard → stop → snapshot → teardown → remove, in that order", async () => {
    const order: string[] = [];
    const { d, removed } = deps();
    d.disposeTabs = vi.fn(async () => void order.push("tabs"));
    d.prepare = vi.fn(async () => (order.push("prepare"), { survivors: [], snapshot: { id: "1-ab" } as never }));
    d.runTeardown = vi.fn(async () => (order.push("teardown"), { code: 0, tabId: 7 }));
    const r = createWorktreeRemoval(d);
    await r.check(req);
    expect(r.state.value.phase).toBe("confirm");
    await r.confirm({});
    expect(order).toEqual(["tabs", "prepare", "teardown"]);
    expect(d.runTeardown).toHaveBeenCalledWith("/r", "/r", "/r.worktrees/x", "x", "h1");
    expect(removed[0]).toMatchObject({ snapshotId: "1-ab", teardownCode: 0, teardownSkipped: false, deleteBranch: true });
    expect(r.state.value.phase).toBe("done");
  });

  it("needs a confirmation for a worktree GitWand did not create, and runs no hook", async () => {
    const { d, removed } = deps({ guard: vi.fn(async () => guard({ owned: false, recorded: false, teardown_required: false })) });
    const r = createWorktreeRemoval(d);
    await r.check(req);
    expect(r.state.value.guard?.owned).toBe(false);
    await r.confirm({ confirmNotOwned: true });
    expect(d.ensureTrusted).not.toHaveBeenCalled();
    expect(d.runTeardown).not.toHaveBeenCalled();
    expect(removed[0]).toMatchObject({ confirmNotOwned: true });
  });

  it("lists the processes still running; Stop all asks to kill foreign ones", async () => {
    let calls = 0;
    const { d } = deps({
      prepare: vi.fn(async () =>
        ++calls === 1
          ? { survivors: [{ pid: 9, ppid: 1, name: "vite" }], snapshot: null }
          : { survivors: [], snapshot: { id: "1-ab" } as never },
      ),
    });
    const r = createWorktreeRemoval(d);
    await r.check(req);
    await r.confirm({});
    expect(r.state.value.phase).toBe("processes");
    expect(r.state.value.survivors[0].name).toBe("vite");
    expect(d.remove).not.toHaveBeenCalled();
    await r.stopAll();
    expect(d.prepare).toHaveBeenLastCalledWith("/r", "/r.worktrees/x", true);
    expect(r.state.value.phase).toBe("done");
  });

  it("a failed teardown keeps the worktree until Retry or Remove anyway", async () => {
    let code = 3;
    const { d, removed } = deps({ runTeardown: vi.fn(async () => ({ code, tabId: 7 })) });
    const r = createWorktreeRemoval(d);
    await r.check(req);
    await r.confirm({});
    expect(r.state.value.phase).toBe("teardown-failed");
    expect(r.state.value.teardownCode).toBe(3);
    expect(r.state.value.tabId).toBe(7);
    expect(d.remove).not.toHaveBeenCalled();
    await r.removeAnyway();
    expect(removed[0]).toMatchObject({ removeAnyway: true, teardownCode: 3 });

    const again = deps({ runTeardown: vi.fn(async () => ({ code, tabId: 8 })) });
    const r2 = createWorktreeRemoval(again.d);
    await r2.check(req);
    await r2.confirm({});
    code = 0;
    await r2.retryTeardown();
    expect(again.d.ensureTrusted).toHaveBeenCalledTimes(2);
    expect(again.removed[0]).toMatchObject({ teardownCode: 0, removeAnyway: false });
    // The snapshot is not taken twice.
    expect(again.d.prepare).toHaveBeenCalledTimes(1);
  });

  it("Skip hooks this time: removes without teardown and says so", async () => {
    const { d, removed } = deps({ ensureTrusted: vi.fn(async () => ({ choice: "skip", status: run.status }) as HookTrustDecision) });
    const r = createWorktreeRemoval(d);
    await r.check(req);
    await r.confirm({});
    expect(d.runTeardown).not.toHaveBeenCalled();
    expect(removed[0]).toMatchObject({ teardownSkipped: true });
    expect(r.state.value.skippedHooks).toBe(true);
    expect(r.state.value.phase).toBe("done");
  });

  it("Cancel at the trust prompt removes nothing", async () => {
    const { d } = deps({ ensureTrusted: vi.fn(async () => ({ choice: "cancel", status: null }) as HookTrustDecision) });
    const r = createWorktreeRemoval(d);
    await r.check(req);
    await r.confirm({});
    expect(d.prepare).not.toHaveBeenCalled();
    expect(r.state.value.phase).toBe("confirm");
  });

  it("asks no trust and runs no teardown when none is required", async () => {
    const { d, removed } = deps({ guard: vi.fn(async () => guard({ teardown_required: false })) });
    const r = createWorktreeRemoval(d);
    await r.check(req);
    await r.confirm({ deleteBranch: false });
    expect(d.ensureTrusted).not.toHaveBeenCalled();
    expect(removed[0]).toMatchObject({ teardownSkipped: false, teardownCode: null, deleteBranch: false });
  });

  it("reports a backend refusal as an error", async () => {
    const { d } = deps({ remove: vi.fn(async () => Promise.reject(new Error("processes: still running"))) });
    const r = createWorktreeRemoval(d);
    await r.check(req);
    await r.confirm({});
    expect(r.state.value.phase).toBe("error");
    expect(r.state.value.error).toContain("processes:");
  });

  it("ignores a second click while a step is in flight", async () => {
    const { d } = deps();
    const r = createWorktreeRemoval(d);
    await r.check(req);
    await Promise.all([r.confirm({}), r.confirm({})]);
    expect(d.prepare).toHaveBeenCalledTimes(1);
    expect(d.runTeardown).toHaveBeenCalledTimes(1);

    const failing = deps({ runTeardown: vi.fn(async () => ({ code: 1, tabId: 1 })) });
    const r2 = createWorktreeRemoval(failing.d);
    await r2.check(req);
    await r2.confirm({});
    await Promise.all([r2.retryTeardown(), r2.retryTeardown(), r2.removeAnyway()]);
    expect(failing.d.runTeardown).toHaveBeenCalledTimes(2);
    expect(failing.d.remove).not.toHaveBeenCalled();
  });

  it("closes the repo tabs open on the worktree once it is removed", async () => {
    const { d } = deps();
    const r = createWorktreeRemoval(d);
    await r.check(req);
    await r.confirm({});
    expect(r.state.value.phase).toBe("done");
    expect(d.closeRepoTabs).toHaveBeenCalledWith("/r.worktrees/x");
  });

  it("keeps the repo tabs when the worktree stays", async () => {
    const { d } = deps({ runTeardown: vi.fn(async () => ({ code: 3, tabId: 7 })) });
    const r = createWorktreeRemoval(d);
    await r.check(req);
    await r.confirm({});
    expect(r.state.value.phase).toBe("teardown-failed");
    expect(d.closeRepoTabs).not.toHaveBeenCalled();
  });
});
