/**
 * The restack flow module (`useStacksFlow.ts`) is loaded on first use (T13):
 * these tests start from a fresh `useStacks` module that has not loaded it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { StacksDeps } from "../useStacks";
import type { StackReport } from "../../utils/backend";

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
});
