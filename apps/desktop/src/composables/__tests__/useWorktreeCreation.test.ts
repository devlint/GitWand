import { describe, it, expect } from "vitest";
import { createWorktreeCreation, type WorktreeCreationDeps } from "../useWorktreeCreation";
import type { CreatedWorktree, HookTrustStatus } from "../../utils/backend";
import type { HookTrustDecision } from "../useWorktreeHookTrust";

const created: CreatedWorktree = {
  path: "/wt/x",
  branch: "task/x",
  name: "x",
  kind: "task",
  base: { base_ref: "origin/main", commit: "c", fetched_at: 1, fallback_reason: null, fallback_detail: null },
  warnings: [],
  created_at: 1,
};

const status = (setup: string | null, url: string | null = null): HookTrustStatus => ({
  hooks: { setup, teardown: null, url },
  hash: setup || url ? "h" : null,
  trusted: true,
  repoRoot: "/repo",
});

function deps(decision: HookTrustDecision, exitCode: number | null = 0) {
  const calls = { create: 0, runSetup: 0, url: 0, restore: 0 };
  const d: WorktreeCreationDeps = {
    ensureTrusted: async () => decision,
    create: async () => {
      calls.create++;
      return created;
    },
    runSetup: async () => {
      calls.runSetup++;
      return { code: exitCode, tabId: 5 };
    },
    url: async () => {
      calls.url++;
      return "http://x";
    },
    restore: async () => {
      calls.restore++;
      return created;
    },
  };
  return { d, calls };
}

describe("useWorktreeCreation", () => {
  it("cancel at the trust prompt creates nothing", async () => {
    const { d, calls } = deps({ choice: "cancel", status: status("up") });
    const flow = createWorktreeCreation(d);
    expect(await flow.create("/repo", { name: "x", kind: "task" })).toBeNull();
    expect(calls.create).toBe(0);
  });

  it("skip creates and skips setup", async () => {
    const { d, calls } = deps({ choice: "skip", status: status("up") });
    const flow = createWorktreeCreation(d);
    const r = await flow.create("/repo", { name: "x", kind: "task" });
    expect(r?.created.path).toBe("/wt/x");
    expect(await flow.runSetup("/repo", "/repo", r!.created, r!.decision)).toBe("skipped");
    expect(calls.runSetup).toBe(0);
    expect(flow.states.value["/wt/x"].status).toBe("skipped");
  });

  it("no setup hook is skipped too", async () => {
    const { d, calls } = deps({ choice: "run", status: status(null) });
    const flow = createWorktreeCreation(d);
    const r = await flow.create("/repo", { name: "x", kind: "task" });
    expect(await flow.runSetup("/repo", "/repo", r!.created, r!.decision)).toBe("skipped");
    expect(calls.runSetup).toBe(0);
  });

  it("setup exit 0 is ok and fetches the url", async () => {
    const { d, calls } = deps({ choice: "run", status: status("up", "u") }, 0);
    const flow = createWorktreeCreation(d);
    const r = await flow.create("/repo", { name: "x", kind: "task" });
    expect(await flow.runSetup("/repo", "/repo", r!.created, r!.decision)).toBe("ok");
    expect(calls.url).toBe(1);
    expect(flow.states.value["/wt/x"]).toMatchObject({ status: "ok", code: 0, url: "http://x", tabId: 5 });
  });

  it("setup exit 2 fails and never asks for the url", async () => {
    const { d, calls } = deps({ choice: "run", status: status("up", "u") }, 2);
    const flow = createWorktreeCreation(d);
    const r = await flow.create("/repo", { name: "x", kind: "task" });
    expect(await flow.runSetup("/repo", "/repo", r!.created, r!.decision)).toBe("failed");
    expect(calls.url).toBe(0);
    expect(flow.states.value["/wt/x"]).toMatchObject({ status: "failed", code: 2 });
  });

  it("a url failure leaves setup ok", async () => {
    const { d } = deps({ choice: "run", status: status("up", "u") }, 0);
    d.url = async () => {
      throw new Error("boom");
    };
    const flow = createWorktreeCreation(d);
    const r = await flow.create("/repo", { name: "x", kind: "task" });
    expect(await flow.runSetup("/repo", "/repo", r!.created, r!.decision)).toBe("ok");
    expect(flow.states.value["/wt/x"].url).toBeNull();
  });

  it("restore asks for trust first, then restores; Cancel restores nothing", async () => {
    const cancel = deps({ choice: "cancel", status: status("up") });
    expect(await createWorktreeCreation(cancel.d).restore("/repo", "1-ab")).toBeNull();
    expect(cancel.calls.restore).toBe(0);

    const ok = deps({ choice: "run", status: status("up") });
    const out = await createWorktreeCreation(ok.d).restore("/repo", "1-ab", "fix");
    expect(out?.created.path).toBe("/wt/x");
    expect(out?.decision.choice).toBe("run");
    expect(ok.calls.restore).toBe(1);
  });
});
