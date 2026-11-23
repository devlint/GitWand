/**
 * The restack flow module (`useStacksFlow.ts`) is loaded on first use (T13):
 * these tests start from a fresh `useStacks` module that has not loaded it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { StacksDeps } from "../useStacks";
import type { FinalizedRestack, RestackPlan, StackReport } from "../../utils/backend";

const report = (over: Partial<StackReport> = {}): StackReport => ({
  trunk: "main",
  remote_trunk: "origin/main",
  layers: [
    {
      branch: "step-2",
      parent: "step-1",
      base: "b",
      parent_tip: "p",
      state: "up_to_date",
      inherited: false,
      actionable: false,
      merge_signal: null,
      merged_pr: null,
      parent_behind_upstream: 0,
      top: "step-2",
    },
  ],
  rebase_in_progress: false,
  finalized: null,
  git_supports_restack: true,
  pending_errors: [],
  ...over,
});

function deps(over: Partial<StacksDeps> = {}): StacksDeps {
  return {
    status: vi.fn(async () => report()),
    setParent: vi.fn(),
    unset: vi.fn(),
    plan: vi.fn(async () => {
      throw new Error("restack step-1 first");
    }),
    fetch: vi.fn(async () => ({ success: true, message: "" })),
    branchPr: vi.fn(async () => null),
    setPrBase: vi.fn(),
    pushBranch: vi.fn(),
    deleteMergedParent: vi.fn(),
    forge: () => "github",
    trunkSetting: () => "main",
    dismissed: () => [],
    dismiss: vi.fn(),
    now: () => 0,
    ...over,
  } as StacksDeps;
}

const ctx = { cwd: "/r", forge: "github", currentBranch: "step-2", localBranches: ["main", "step-1", "step-2"], prs: [] };

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("../useStacksFlow");
});

describe("useStacks — the flow module not loaded yet (T13)", () => {
  it("a first call loads it; two concurrent first calls both run on the store", async () => {
    const { createStacks } = await import("../useStacks");
    const d = deps();
    const s = createStacks(d);
    s.setContext(ctx);
    // Neither call has the module yet: both wait for the same load.
    const a = s.startRestack("/r", "step-2");
    const b = s.startRestack("/r", "step-2");
    expect(s.flow.value.phase).toBe("idle");
    await Promise.all([a, b]);
    expect(d.fetch).toHaveBeenCalledTimes(2);
    // The second run superseded the first one on the shared store.
    expect(d.plan).toHaveBeenCalledTimes(1);
    expect(s.flow.value).toMatchObject({ phase: "error", error: "restack step-1 first" });
    // Loaded now: a later call starts at once.
    const c = s.startRestack("/r", "step-2");
    expect(s.flow.value.phase).toBe("fetching");
    await c;
  });

  it("a failed load drops the hints, and the refresh still succeeds", async () => {
    vi.doMock("../useStacksFlow", () => {
      throw new Error("chunk load failed");
    });
    const { createStacks } = await import("../useStacks");
    const d = deps();
    const s = createStacks(d);
    s.setContext(ctx);
    await s.refresh("/r");
    expect(d.status).toHaveBeenCalledWith("/r", "main", []);
    expect(s.report.value?.layers).toHaveLength(1);
    expect(s.statusError.value).toBeNull();
  });

  it("a retry offers the leases captured when the finalization was first seen, even after a failed load (wave 5, item 4)", async () => {
    let failing = true;
    vi.doMock("../useStacksFlow", async (importOriginal) => {
      if (failing) throw new Error("chunk load failed");
      return importOriginal();
    });
    const { createStacks, registerRestackHost } = await import("../useStacks");
    const offerPush = vi.fn();
    registerRestackHost({ apply: vi.fn(async () => ({ stoppedReason: "residual" }) as never), offerPush, notify: vi.fn() });
    const planOf = (lease: string): RestackPlan => ({
      moment: "parent_moved",
      bottom: "step-2",
      parent: "step-1",
      onto_ref: "step-1",
      onto_sha: "o",
      upstream_sha: "u",
      top: "step-2",
      top_sha: "t",
      moving: [{ branch: "step-2", in_stack: true, upstream: "origin/step-2", remote_sha: lease, push_block: null }],
      new_parent: null,
      refusal: null,
    });
    const fin: FinalizedRestack = {
      moment: "parent_moved",
      bottom: "step-2",
      merged_parent: null,
      new_parent: null,
      moved: ["step-2"],
      switched_back_to: null,
      switch_error: null,
      delete_offer: null,
    };
    let next: StackReport | null = null;
    const d = deps({
      forge: () => "gitlab",
      status: vi.fn(async () => {
        const r = next ?? report();
        next = null;
        return r;
      }),
    });
    const s = createStacks(d);
    s.setContext(ctx);
    // Plan A is applied (the run's own module load fails, the plan is kept).
    s.flow.value = { ...s.flow.value, phase: "preview", cwd: "/r", branch: "step-2", plan: planOf("aaa") };
    await s.applyRestack(0).catch(() => {});
    // Its finalization: the first handling fails on the module load.
    next = report({ finalized: fin });
    await s.refresh("/r");
    expect(offerPush).not.toHaveBeenCalled();
    // A later plan B is applied before the retry.
    s.flow.value = { ...s.flow.value, phase: "preview", plan: planOf("zzz") };
    await s.applyRestack(0).catch(() => {});
    failing = false;
    await s.refresh("/r");
    expect(offerPush).toHaveBeenCalledTimes(1);
    expect(offerPush.mock.calls[0][0].push.pushable).toEqual([{ branch: "step-2", lease: "aaa" }]);
  });
});
