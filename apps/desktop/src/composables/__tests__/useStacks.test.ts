import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { createStacks, preloadStacksFlow, registerRestackHost, type StacksDeps, type RestackHost } from "../useStacks";
import type {
  StackLayerStatus,
  StackReport,
  RestackPlan,
  FinalizedRestack,
  GitPushPullResult,
} from "../../utils/backend";
import type { BranchPr } from "../../utils/backend-pr";
import type { ApplyOutcome } from "../useApplyFromPreview";

const layer = (over: Partial<StackLayerStatus> = {}): StackLayerStatus => ({
  branch: "step-2",
  parent: "step-1",
  base: "b1",
  parent_tip: "p1",
  state: "up_to_date",
  inherited: false,
  actionable: false,
  merge_signal: null,
  merged_pr: null,
  parent_behind_upstream: 0,
  top: "step-3",
  ...over,
});

/** step-1 on main, step-2 on step-1, step-3 on step-2. */
const stack = (over: Record<string, Partial<StackLayerStatus>> = {}): StackLayerStatus[] => [
  layer({ branch: "step-1", parent: "main", ...over["step-1"] }),
  layer({ branch: "step-2", parent: "step-1", ...over["step-2"] }),
  layer({ branch: "step-3", parent: "step-2", ...over["step-3"] }),
];

const report = (over: Partial<StackReport> = {}): StackReport => ({
  trunk: "main",
  remote_trunk: "origin/main",
  layers: stack(),
  rebase_in_progress: false,
  finalized: null,
  git_supports_restack: true,
  pending_errors: [],
  ...over,
});

const plan = (over: Partial<RestackPlan> = {}): RestackPlan => ({
  moment: "parent_moved",
  bottom: "step-2",
  parent: "step-1",
  onto_ref: "refs/heads/step-1",
  onto_sha: "onto",
  upstream_sha: "up",
  top: "step-3",
  top_sha: "top",
  moving: [
    { branch: "step-2", in_stack: true, upstream: "origin/step-2", remote_sha: "aaa" },
    { branch: "step-3", in_stack: true, upstream: null, remote_sha: null },
  ],
  new_parent: null,
  refusal: null,
  ...over,
});

const finalized = (over: Partial<FinalizedRestack> = {}): FinalizedRestack => ({
  moment: "parent_moved",
  bottom: "step-2",
  merged_parent: null,
  new_parent: null,
  moved: ["step-2", "step-3"],
  switched_back_to: null,
  switch_error: null,
  ...over,
});

const outcome = (over: Partial<ApplyOutcome> = {}): ApplyOutcome => ({
  operation: "rebase",
  ref: "step-1",
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

const openPr = (number: number): BranchPr => ({
  number,
  base: "step-1",
  head_ref_oid: "h",
  merged_at: null,
  url: `https://github.com/o/r/pull/${number}`,
});

/** Fakes for every IPC dep. `world.report` is what `status` returns; `world.next` is returned once. */
function setup(over: Partial<StacksDeps> = {}) {
  const world = {
    report: report(),
    next: null as StackReport | null,
    clock: 1_000_000,
    dismissed: [] as string[],
    forge: "github" as string | null,
  };
  const deps: StacksDeps = {
    status: vi.fn(async () => {
      const r = world.next ?? world.report;
      world.next = null;
      return r;
    }),
    setParent: vi.fn(async (_c: string, branch: string, parent: string) => ({ branch, parent, base: null })),
    unset: vi.fn(async () => {}),
    plan: vi.fn(async () => plan()),
    fetch: vi.fn(async () => ({ success: true, message: "" })),
    branchPr: vi.fn(async (_c: string, _b: string, state: "open" | "merged") =>
      state === "open" ? openPr(813) : null,
    ),
    setPrBase: vi.fn(async () => {}),
    pushBranch: vi.fn(async (): Promise<GitPushPullResult> => ({ success: true, message: "pushed" })),
    deleteBranch: vi.fn(async () => {}),
    forge: () => world.forge,
    trunkSetting: () => "main",
    dismissed: () => world.dismissed,
    dismiss: vi.fn((_c: string, b: string) => {
      world.dismissed = [...world.dismissed, b];
    }),
    now: () => world.clock,
    ...over,
  };
  const s = createStacks(deps);
  s.setContext({ forge: null,
    cwd: "/r",
    currentBranch: "step-3",
    localBranches: ["main", "step-1", "step-2", "step-3"],
    prs: [],
  });
  return { s, deps, world };
}

function host(over: Partial<RestackHost> = {}) {
  const h: RestackHost = {
    apply: vi.fn(async () => outcome()),
    offerPush: vi.fn(),
    notify: vi.fn(),
    ...over,
  };
  registerRestackHost(h);
  return h;
}

/** Let queued refreshes (scheduled after a finalization) run to the end. */
const settle = () => new Promise((r) => setTimeout(r, 0));

// The restack flow is a lazy module: tests that read the phase synchronously need it loaded.
beforeAll(() => preloadStacksFlow());

beforeEach(() => {
  registerRestackHost(null);
});

describe("useStacks — refresh", () => {
  it("asks GitHub for merged parents once per minute, never on other forges", async () => {
    const { s, deps, world } = setup();
    await s.refresh("/r");
    await s.refresh("/r");
    // step-1 and step-2 are parents; main is the trunk and is never asked.
    expect(deps.branchPr).toHaveBeenCalledTimes(2);
    expect(deps.branchPr).toHaveBeenCalledWith("/r", "step-1", "merged");
    expect(deps.branchPr).toHaveBeenCalledWith("/r", "step-2", "merged");
    world.clock += 60_001;
    await s.refresh("/r");
    expect(deps.branchPr).toHaveBeenCalledTimes(4);

    const gl = setup();
    gl.world.forge = "gitlab";
    await gl.s.refresh("/r");
    await gl.s.refresh("/r");
    expect(gl.deps.branchPr).not.toHaveBeenCalled();
  });

  it("passes merged-parent hints to status, and swallows lookup errors", async () => {
    const { s, deps } = setup({
      branchPr: vi.fn(async (_c: string, b: string) => {
        if (b === "step-2") throw new Error("gh down");
        return { ...openPr(42), head_ref_oid: "old1" };
      }),
    });
    await s.refresh("/r");
    await s.refresh("/r");
    expect(deps.status).toHaveBeenLastCalledWith("/r", "main", [
      { branch: "step-1", number: 42, head_ref_oid: "old1" },
    ]);
    expect(s.report.value?.trunk).toBe("main");
  });

  it("coalesces refreshes: one in flight, one queued", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { s, deps, world } = setup();
    world.forge = "gitlab";
    (deps.status as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      await gate;
      return world.report;
    });
    const a = s.refresh("/r");
    const b = s.refresh("/r");
    const c = s.refresh("/r");
    release();
    await Promise.all([a, b, c]);
    expect(deps.status).toHaveBeenCalledTimes(2);
  });

  it("refreshes once more after a finalized restack, to settle the next record", async () => {
    const { s, deps, world } = setup();
    world.forge = "gitlab";
    world.next = report({ finalized: finalized() });
    await s.refresh("/r");
    await settle();
    expect(deps.status).toHaveBeenCalledTimes(2);
  });

  it("exposes the pending record error of the report", async () => {
    const { s, world } = setup();
    world.forge = "gitlab";
    world.report = report({ pending_errors: [{ top: "step-3", error: "cannot settle" }] });
    await s.refresh("/r");
    expect(s.pendingErrors.value).toEqual([{ top: "step-3", error: "cannot settle" }]);
    // A chain is blocked iff its top has an entry.
    expect(s.isBlocked("step-1")).toBe(true);
    expect(s.isBlocked("other")).toBe(false);
  });
});

describe("useStacks — after a restack", () => {
  const momentTwo = () =>
    report({
      finalized: finalized({ moment: "parent_merged", merged_parent: "step-1", new_parent: null }),
    });

  it("finalized moment two retargets the child PR to the trunk on GitHub", async () => {
    const { s, deps, world } = setup();
    world.next = momentTwo();
    await s.refresh("/r");
    expect(deps.branchPr).toHaveBeenCalledWith("/r", "step-2", "open");
    expect(deps.setPrBase).toHaveBeenCalledWith("/r", 813, "main");
    expect(s.after.value?.retarget).toEqual({ state: "done", number: 813, base: "main", error: null });
    expect(s.after.value?.deleteOffer).toBe("step-1");
  });

  it("retargets onto the new parent when the merged parent was itself stacked", async () => {
    const { s, deps, world } = setup();
    world.next = report({
      finalized: finalized({ moment: "parent_merged", merged_parent: "step-1", new_parent: "base-0" }),
    });
    await s.refresh("/r");
    expect(deps.setPrBase).toHaveBeenCalledWith("/r", 813, "base-0");
  });

  it("a child without an open PR has nothing to retarget", async () => {
    const { s, deps, world } = setup({ branchPr: vi.fn(async () => null) });
    world.next = momentTwo();
    await s.refresh("/r");
    expect(deps.setPrBase).not.toHaveBeenCalled();
    expect(s.after.value?.retarget.state).toBe("none");
  });

  it("a failed retarget keeps the restack and can be retried", async () => {
    const setPrBase = vi.fn().mockRejectedValueOnce(new Error("422 base invalid")).mockResolvedValue(undefined);
    const { s, world } = setup({ setPrBase });
    world.next = momentTwo();
    await s.refresh("/r");
    expect(s.after.value?.retarget).toMatchObject({ state: "failed", error: "422 base invalid", number: 813 });
    await s.retryRetarget();
    expect(s.after.value?.retarget).toEqual({ state: "done", number: 813, base: "main", error: null });
    expect(setPrBase).toHaveBeenCalledTimes(2);
  });

  it("off GitHub the retarget is left to the user", async () => {
    const { s, deps, world } = setup();
    world.forge = "gitlab";
    world.next = momentTwo();
    await s.refresh("/r");
    expect(s.after.value?.retarget.state).toBe("manual");
    expect(deps.setPrBase).not.toHaveBeenCalled();
  });

  it("moment one does not retarget", async () => {
    const { s, deps, world } = setup();
    world.next = report({ finalized: finalized() });
    await s.refresh("/r");
    expect(s.after.value?.retarget.state).toBe("none");
    expect(s.after.value?.deleteOffer).toBeNull();
    expect(deps.setPrBase).not.toHaveBeenCalled();
  });

  it("push offer leases the remote shas read before the restack", async () => {
    const h = host();
    const { s, deps, world } = setup();
    world.report = report({ layers: stack({ "step-2": { state: "out_of_date", actionable: true } }) });
    await s.refresh("/r");
    await s.startRestack("/r", "step-2");
    expect(s.flow.value.phase).toBe("preview");
    world.next = report({ finalized: finalized() });
    await s.applyRestack(3);
    expect(s.flow.value.phase).toBe("done");
    expect(s.after.value?.push).toEqual({
      pushable: [{ branch: "step-2", lease: "aaa" }],
      skipped: ["step-3"],
      noLeases: false,
    });
    expect(h.offerPush).toHaveBeenCalledTimes(1);
    const res = await s.pushMoved();
    expect(deps.pushBranch).toHaveBeenCalledWith("/r", "step-2", "aaa");
    expect(deps.pushBranch).toHaveBeenCalledTimes(1);
    expect(res).toEqual([{ branch: "step-2", ok: true, message: "pushed" }]);
  });

  it("a restack finalized without a plan in memory offers no push", async () => {
    const h = host();
    const { s, deps, world } = setup();
    world.next = report({ finalized: finalized() });
    await s.refresh("/r");
    expect(s.after.value?.push).toEqual({ pushable: [], skipped: [], noLeases: true });
    expect(h.offerPush).toHaveBeenCalledTimes(1);
    expect(await s.pushMoved()).toEqual([]);
    expect(deps.pushBranch).not.toHaveBeenCalled();
  });

  it("deleting the merged parent force-deletes it and clears the offer", async () => {
    const { s, deps, world } = setup();
    world.next = momentTwo();
    await s.refresh("/r");
    await s.deleteMergedParent();
    expect(deps.deleteBranch).toHaveBeenCalledWith("/r", "step-1");
    expect(s.after.value?.deleteOffer).toBeNull();
  });
});

describe("useStacks — restack flow", () => {
  it("moment_two_is_refused_when_the_fetch_fails", async () => {
    const { s, deps, world } = setup({ fetch: vi.fn(async () => ({ success: false, message: "offline" })) });
    world.report = report({ layers: stack({ "step-2": { state: "parent_merged", actionable: true } }) });
    await s.refresh("/r");
    await s.startRestack("/r", "step-2");
    expect(s.flow.value.phase).toBe("refused");
    expect(s.flow.value.refusal?.code).toBe("fetch_failed");
    expect(s.flow.value.refusal?.message).toBe("offline");
    expect(deps.plan).not.toHaveBeenCalled();
  });

  it("moment one continues after a failed fetch with a warning", async () => {
    const { s, deps, world } = setup({ fetch: vi.fn(async () => ({ success: false, message: "offline" })) });
    world.report = report({ layers: stack({ "step-2": { state: "out_of_date", actionable: true } }) });
    await s.refresh("/r");
    await s.startRestack("/r", "step-2");
    expect(s.flow.value.fetchWarning).toBe("offline");
    expect(deps.plan).toHaveBeenCalledWith("/r", "step-2", "main", expect.any(Array));
    expect(s.flow.value.phase).toBe("preview");
  });

  it("a plan refusal stops at refused", async () => {
    const refusal = { code: "dirty" as const, message: "dirty tree", branch: null, path: null };
    const { s } = setup({ plan: vi.fn(async () => plan({ refusal })) });
    await s.startRestack("/r", "step-2");
    expect(s.flow.value.phase).toBe("refused");
    expect(s.flow.value.refusal).toEqual(refusal);
  });

  it("a plain plan error becomes the flow's error and never throws", async () => {
    const { s } = setup({ plan: vi.fn(async () => Promise.reject(new Error("restack step-1 first"))) });
    await expect(s.startRestack("/r", "step-2")).resolves.toBeUndefined();
    expect(s.flow.value.phase).toBe("error");
    expect(s.flow.value.error).toBe("restack step-1 first");
  });

  it("a stale preview error becomes a refusal", async () => {
    host({ apply: vi.fn(async () => outcome({ stoppedReason: "op-failed", operationError: "stale preview: step-1 moved" })) });
    const { s } = setup();
    await s.startRestack("/r", "step-2");
    await s.applyRestack(0);
    expect(s.flow.value.phase).toBe("refused");
    expect(s.flow.value.refusal?.code).toBe("stale_preview");
  });

  it("another run failure is an error, a residual hands over to the banner", async () => {
    host({ apply: vi.fn(async () => outcome({ stoppedReason: "op-failed", operationError: "restack step-1 first" })) });
    const a = setup();
    await a.s.startRestack("/r", "step-2");
    await a.s.applyRestack(0);
    expect(a.s.flow.value.phase).toBe("error");
    expect(a.s.flow.value.error).toBe("restack step-1 first");

    host({ apply: vi.fn(async () => outcome({ stoppedReason: "residual", finalized: false })) });
    const b = setup();
    await b.s.startRestack("/r", "step-2");
    await b.s.applyRestack(0);
    expect(b.s.flow.value.phase).toBe("residual");
  });

  it("applies the previewed plan through the host, then refreshes", async () => {
    const h = host();
    const { s, deps, world } = setup();
    world.forge = "gitlab";
    await s.startRestack("/r", "step-2");
    const before = (deps.status as ReturnType<typeof vi.fn>).mock.calls.length;
    await s.applyRestack(5);
    expect(h.apply).toHaveBeenCalledWith(
      "/r",
      plan(),
      { onto_sha: "onto", upstream_sha: "up", top_sha: "top", moving: ["step-2", "step-3"] },
      [],
      5,
    );
    expect((deps.status as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before + 1);
  });

  it("without a registered host, apply fails with a clear error", async () => {
    const { s } = setup();
    await s.startRestack("/r", "step-2");
    await expect(s.applyRestack(0)).resolves.toBeUndefined();
    expect(s.flow.value.phase).toBe("error");
    expect(s.flow.value.error).toMatch(/host/i);
  });

  it("closing the flow resets it", async () => {
    const { s } = setup();
    await s.startRestack("/r", "step-2");
    s.closeRestack();
    expect(s.flow.value.phase).toBe("idle");
    expect(s.flow.value.plan).toBeNull();
  });
});

describe("useStacks — bridge, banner, candidates", () => {
  it("bridge offers skip trunk bases, existing layers, taken parents and dismissed branches", async () => {
    const { s, world } = setup();
    world.forge = "gitlab";
    world.dismissed = ["d"];
    // q is a layer on p (p is not a layer): a PR p → q would make a cycle.
    world.report = report({ layers: [...stack(), layer({ branch: "q", parent: "p", top: "q" })] });
    await s.refresh("/r");
    s.setContext({ forge: null,
      cwd: "/r",
      currentBranch: "main",
      localBranches: ["main", "step-1", "step-2", "step-3", "a", "b", "c", "d", "x", "y", "p", "q"],
      prs: [
        { branch: "a", base: "main", number: 1, state: "OPEN" }, // trunk base
        { branch: "step-2", base: "step-1", number: 2, state: "OPEN" }, // already a layer
        { branch: "b", base: "step-1", number: 3, state: "OPEN" }, // step-1 has a stacked child
        { branch: "c", base: "x", number: 4, state: "OPEN" }, // offered
        { branch: "d", base: "y", number: 5, state: "OPEN" }, // dismissed
        { branch: "e", base: "x", number: 6, state: "OPEN" }, // e not local
        { branch: "y", base: "z", number: 7, state: "OPEN" }, // z not local
        { branch: "x", base: "y", number: 8, state: "MERGED" }, // not open
        { branch: "p", base: "q", number: 9, state: "OPEN" }, // cycle
      ],
    });
    expect([...s.offers.value.keys()]).toEqual(["c"]);
    expect(s.offers.value.get("c")).toEqual({ branch: "c", parent: "x", pr: 4 });
  });

  it("dismissing a bridge offer is remembered for that branch", async () => {
    const { s, deps, world } = setup();
    world.forge = "gitlab";
    await s.refresh("/r");
    s.setContext({ forge: null,
      cwd: "/r",
      currentBranch: "main",
      localBranches: ["main", "c", "x"],
      prs: [{ branch: "c", base: "x", number: 4, state: "open" }],
    });
    expect(s.offers.value.has("c")).toBe(true);
    s.dismissBridge("/r", "c");
    expect(deps.dismiss).toHaveBeenCalledWith("/r", "c");
    expect(s.offers.value.has("c")).toBe(false);
  });

  it("accepting a bridge offer stacks the branch on the PR's base", async () => {
    const { s, deps } = setup();
    await s.acceptBridge("/r", { branch: "c", parent: "x", pr: 4 });
    expect(deps.setParent).toHaveBeenCalledWith("/r", "c", "x", "main");
  });

  it("the banner shows the lowest problem at or below the current branch and Later hides it until it changes", async () => {
    const { s, world } = setup();
    world.forge = "gitlab";
    world.report = report({
      layers: stack({
        "step-2": { state: "out_of_date", actionable: true },
        "step-3": { state: "out_of_date", inherited: true },
      }),
    });
    await s.refresh("/r");
    expect(s.banner.value?.layer.branch).toBe("step-2");
    expect(s.banner.value?.kind).toBe("parent_moved");

    s.setContext({ forge: null, cwd: "/r", currentBranch: "step-1", localBranches: ["main", "step-1", "step-2", "step-3"], prs: [] });
    expect(s.banner.value).toBeNull();
    s.setContext({ forge: null, cwd: "/r", currentBranch: "step-3", localBranches: ["main", "step-1", "step-2", "step-3"], prs: [] });

    s.later();
    expect(s.banner.value).toBeNull();
    await s.refresh("/r");
    expect(s.banner.value, "same state, same parent tip: still hidden").toBeNull();

    world.report = report({
      layers: stack({
        "step-2": { state: "out_of_date", actionable: true, parent_tip: "p2" },
        "step-3": { state: "out_of_date", inherited: true },
      }),
    });
    await s.refresh("/r");
    expect(s.banner.value?.layer.branch).toBe("step-2");
  });

  it("the banner reports a parent behind its upstream", async () => {
    const { s, world } = setup();
    world.forge = "gitlab";
    world.report = report({ layers: stack({ "step-2": { state: "out_of_date", parent_behind_upstream: 2 } }) });
    await s.refresh("/r");
    expect(s.banner.value?.kind).toBe("parent_behind");
  });

  it("layerOf and actionableFor find a branch's layer and the layer to restack for it", async () => {
    const { s, world } = setup();
    world.forge = "gitlab";
    world.report = report({
      layers: stack({
        "step-2": { state: "out_of_date", actionable: true },
        "step-3": { state: "out_of_date", inherited: true },
      }),
    });
    await s.refresh("/r");
    expect(s.layerOf("step-3")?.parent).toBe("step-2");
    expect(s.layerOf("main")).toBeNull();
    expect(s.actionableFor("step-3")?.branch).toBe("step-2");
    expect(s.actionableFor("step-1")).toBeNull();
  });

  it("stack-on candidates leave out the branch, the trunk, taken parents and its descendants", async () => {
    const { s, world } = setup();
    world.forge = "gitlab";
    await s.refresh("/r");
    s.setContext({ forge: null,
      cwd: "/r",
      currentBranch: "step-2",
      localBranches: ["main", "step-1", "step-2", "step-3", "other"],
      prs: [],
    });
    // step-1 already has a stacked child, but it is step-2 itself: allowed.
    expect(s.stackOnCandidates("step-2")).toEqual(["step-1", "other"]);
    // step-1 and step-2 have stacked children; step-3 is free.
    expect(s.stackOnCandidates("other")).toEqual(["step-3"]);
  });

  it("stackOn and unstack call the backend and refresh", async () => {
    const { s, deps } = setup();
    await s.stackOn("/r", "other", "step-3");
    expect(deps.setParent).toHaveBeenCalledWith("/r", "other", "step-3", "main");
    await s.unstack("/r", "step-3");
    expect(deps.unset).toHaveBeenCalledWith("/r", "step-3");
    expect(deps.status).toHaveBeenCalledTimes(2);
  });
});

describe("useStacks — review round 1", () => {
  const momentTwo = () =>
    report({
      finalized: finalized({ moment: "parent_merged", merged_parent: "step-1", new_parent: null }),
    });

  it("refuses a moment-two plan when the fetch failed, even without a report", async () => {
    const h = host();
    const { s, deps } = setup({
      fetch: vi.fn(async () => ({ success: false, message: "offline" })),
      plan: vi.fn(async () => plan({ moment: "parent_merged", onto_ref: "refs/remotes/origin/main" })),
    });
    expect(s.report.value).toBeNull();
    await s.startRestack("/r", "step-2");
    expect(deps.plan).toHaveBeenCalled();
    expect(s.flow.value.phase).toBe("refused");
    expect(s.flow.value.refusal?.code).toBe("fetch_failed");
    await s.applyRestack(0);
    expect(h.apply).not.toHaveBeenCalled();
  });

  it("handles a finalized report even when the repo switched meanwhile", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { s, deps } = setup();
    (deps.status as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      await gate;
      return momentTwo();
    });
    const run = s.refresh("/r");
    s.setContext({ forge: null, cwd: "/other", currentBranch: "main", localBranches: ["main"], prs: [] });
    release();
    await run;
    expect(s.report.value, "the old repo's report is not shown").toBeNull();
    expect(s.after.value?.cwd).toBe("/r");
    expect(s.after.value?.retarget.state).toBe("done");
    expect(deps.setPrBase).toHaveBeenCalledWith("/r", 813, "main");
  });

  it("ignores a finalized report identical to the one just handled", async () => {
    const h = host();
    const { s, deps, world } = setup();
    world.report = momentTwo(); // a backend that keeps returning it
    await s.refresh("/r");
    await settle();
    await settle();
    expect(deps.setPrBase).toHaveBeenCalledTimes(1);
    expect(h.offerPush).toHaveBeenCalledTimes(1);
    expect(deps.status).toHaveBeenCalledTimes(2);
  });

  it("handles the same finalization again once a report in between had none", async () => {
    const { s, deps, world } = setup();
    world.next = momentTwo();
    await s.refresh("/r");
    await settle();
    world.next = momentTwo();
    await s.refresh("/r");
    await settle();
    expect(deps.setPrBase).toHaveBeenCalledTimes(2);
  });

  it("a GitHub finalization followed by the extra refresh retargets exactly once", async () => {
    const { s, deps, world } = setup();
    world.next = momentTwo();
    await s.refresh("/r");
    await settle();
    expect((deps.status as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(deps.setPrBase).toHaveBeenCalledTimes(1);
  });

  it("offers one bridge per base, the lowest PR number", async () => {
    const { s, world } = setup();
    world.forge = "gitlab";
    await s.refresh("/r");
    s.setContext({
      forge: null,
      cwd: "/r",
      currentBranch: "main",
      localBranches: ["main", "c", "d", "x"],
      prs: [
        { branch: "c", base: "x", number: 9, state: "OPEN" },
        { branch: "d", base: "x", number: 4, state: "OPEN" },
      ],
    });
    expect([...s.offers.value.values()]).toEqual([{ branch: "d", parent: "x", pr: 4 }]);
  });

  it("closing during the apply still refreshes once a clean run lands", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    host({
      apply: vi.fn(async () => {
        await gate;
        return outcome();
      }),
    });
    const { s, deps, world } = setup();
    world.forge = "gitlab";
    await s.startRestack("/r", "step-2");
    const applying = s.applyRestack(0);
    expect(s.flow.value.phase).toBe("applying");
    s.closeRestack();
    const before = (deps.status as ReturnType<typeof vi.fn>).mock.calls.length;
    release();
    await applying;
    expect((deps.status as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before + 1);
    expect(s.flow.value.phase).toBe("idle");
  });

  it("a kept plan for another bottom gives no leases", async () => {
    host({ apply: vi.fn(async () => outcome({ stoppedReason: "residual", finalized: false })) });
    const { s, world } = setup();
    world.forge = "gitlab";
    await s.startRestack("/r", "step-2");
    await s.applyRestack(0);
    world.next = report({ finalized: finalized({ bottom: "step-1", moved: ["step-1"] }) });
    await s.refresh("/r");
    expect(s.after.value?.push).toEqual({ pushable: [], skipped: [], noLeases: true });
  });
});

describe("useStacks — banner support (Task 13)", () => {
  it("the push offer's run pushes the restack it was offered for, even once the banner is dismissed", async () => {
    let run: (() => Promise<{ branch: string; ok: boolean; message: string }[]>) | null = null;
    host({ offerPush: vi.fn((_a, r) => { run = r; }) });
    const { s, deps, world } = setup();
    world.report = report({ layers: stack({ "step-2": { state: "out_of_date", actionable: true } }) });
    await s.refresh("/r");
    await s.startRestack("/r", "step-2");
    world.next = report({ finalized: finalized() });
    await s.applyRestack(0);
    s.dismissAfter();
    expect(s.after.value).toBeNull();
    const res = await run!();
    expect(deps.pushBranch).toHaveBeenCalledWith("/r", "step-2", "aaa");
    expect(res).toEqual([{ branch: "step-2", ok: true, message: "pushed" }]);
  });

  it("exposes the context and names the branch being restacked", async () => {
    const { s } = setup();
    expect(s.context.value).toMatchObject({ cwd: "/r", currentBranch: "step-3" });
    const pending = s.startRestack("/r", "step-2");
    expect(s.flow.value).toMatchObject({ phase: "fetching", branch: "step-2" });
    await pending;
  });
});

describe("useStacks — push offer with nothing pushable (review M-5)", () => {
  it("still tells the host when every moved branch was skipped", async () => {
    const h = host();
    const { s, world } = setup();
    world.forge = "gitlab";
    world.report = report({ layers: stack({ "step-2": { state: "out_of_date", actionable: true } }) });
    await s.refresh("/r");
    await s.startRestack("/r", "step-3");
    // A plan whose moved layers have no upstream lease at all.
    world.next = report({ finalized: finalized({ bottom: "step-2", moved: ["step-3"] }) });
    await s.applyRestack(0);
    expect(s.after.value?.push).toEqual({ pushable: [], skipped: ["step-3"], noLeases: false });
    expect(h.offerPush).toHaveBeenCalledTimes(1);
  });
});
