import { describe, it, expect, vi } from "vitest";
import { createStackActions } from "../useStackActions";
import type { Stacks, BridgeOffer } from "../useStacks";
import type { StackLayerStatus } from "../../utils/backend";

const offer: BridgeOffer = { branch: "step-2", parent: "step-1", pr: 7 };

function fakeStacks(over: Partial<Stacks>): Stacks {
  return over as Stacks;
}

describe("createStackActions", () => {
  it("surfaces a failed acceptBridge through the toast instead of rejecting", async () => {
    const notify = vi.fn();
    const actions = createStackActions(
      fakeStacks({ acceptBridge: vi.fn().mockRejectedValue(new Error("branch is already stacked")) }),
      notify,
    );
    await expect(actions.accept("/r", offer)).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledWith("branch is already stacked");
  });

  it("surfaces a failed unstack", async () => {
    const notify = vi.fn();
    const actions = createStackActions(fakeStacks({ unstack: vi.fn().mockRejectedValue("boom") }), notify);
    await actions.unstack("/r", "b");
    expect(notify).toHaveBeenCalledWith("boom");
  });

  it("restackFrom starts the restack at the actionable layer's branch", async () => {
    const startRestack = vi.fn().mockResolvedValue(undefined);
    const actions = createStackActions(
      fakeStacks({
        actionableFor: () => ({ branch: "step-1" }) as StackLayerStatus,
        startRestack,
      }),
      vi.fn(),
    );
    await actions.restackFrom("/r", "step-3");
    expect(startRestack).toHaveBeenCalledWith("/r", "step-1");
  });

  it("restackFrom does nothing without an actionable layer", async () => {
    const startRestack = vi.fn();
    const actions = createStackActions(fakeStacks({ actionableFor: () => null, startRestack }), vi.fn());
    await actions.restackFrom("/r", "x");
    expect(startRestack).not.toHaveBeenCalled();
  });
});

describe("useStackActions — error channel", () => {
  it("sends errors to the registered restack host", async () => {
    const { registerRestackHost, __setStacksForTest } = await import("../useStacks");
    const { useStackActions } = await import("../useStackActions");
    const notify = vi.fn();
    registerRestackHost({ apply: vi.fn(), offerPush: vi.fn(), notify });
    __setStacksForTest(fakeStacks({ unstack: vi.fn().mockRejectedValue(new Error("nope")) }));
    try {
      await useStackActions().unstack("/r", "b");
      expect(notify).toHaveBeenCalledWith("nope");
    } finally {
      registerRestackHost(null);
      __setStacksForTest(null);
    }
  });

  it("deleteMergedParent surfaces a failure", async () => {
    const notify = vi.fn();
    const actions = createStackActions(
      fakeStacks({ deleteMergedParent: vi.fn().mockRejectedValue(new Error("not deleted")) }),
      notify,
    );
    await actions.deleteMergedParent();
    expect(notify).toHaveBeenCalledWith("not deleted");
  });

  it("preview and retryRetarget surface failures instead of rejecting (M-5)", async () => {
    const notify = vi.fn();
    const startRestack = vi.fn().mockRejectedValue(new Error("flow module failed to load"));
    const actions = createStackActions(
      fakeStacks({ startRestack, retryRetarget: vi.fn().mockRejectedValue(new Error("offline")) }),
      notify,
    );
    await expect(actions.preview("/r", "step-2")).resolves.toBeUndefined();
    expect(startRestack).toHaveBeenCalledWith("/r", "step-2");
    await expect(actions.retryRetarget()).resolves.toBeUndefined();
    expect(notify.mock.calls).toEqual([["flow module failed to load"], ["offline"]]);
  });
});

describe("stack menu (QA bug 1)", () => {
  it("stackMenuFor: Stack on… for a non-trunk branch, Unstack for a layer, Restack… when actionable", async () => {
    const { stackMenuFor } = await import("../useStackActions");
    const stacks = fakeStacks({
      trunk: () => "main",
      layerOf: (b: string) => (b === "step-2" ? ({ branch: "step-2" } as StackLayerStatus) : null),
      actionableFor: (b: string) => (b === "step-2" ? ({ branch: "step-2" } as StackLayerStatus) : null),
    });
    expect(stackMenuFor(stacks, "step-2")).toEqual({ stackOn: true, unstack: true, restack: true });
    expect(stackMenuFor(stacks, "feature")).toEqual({ stackOn: true, unstack: false, restack: false });
    expect(stackMenuFor(stacks, "main")).toEqual({ stackOn: false, unstack: false, restack: false });
  });

  it("requestStackOn / closeStackOn drive the shared stackOnRequest", async () => {
    const { useStackActions } = await import("../useStackActions");
    const a = useStackActions();
    const b = useStackActions();
    expect(a.stackOnRequest.value).toBeNull();
    a.requestStackOn("/r", "step-2");
    expect(b.stackOnRequest.value).toEqual({ cwd: "/r", branch: "step-2" });
    b.closeStackOn();
    expect(a.stackOnRequest.value).toBeNull();
  });
});

describe("QA2 wave", () => {
  async function realStacks(trunkSetting: string | null) {
    const { createStacks } = await import("../useStacks");
    const deps = {
      status: vi.fn(),
      setParent: vi.fn(),
      unset: vi.fn(),
      plan: vi.fn(),
      fetch: vi.fn(),
      branchPr: vi.fn(),
      setPrBase: vi.fn(),
      pushBranch: vi.fn(),
      deleteMergedParent: vi.fn(),
      forge: () => null,
      trunkSetting: () => trunkSetting,
      dismissed: () => [],
      dismiss: vi.fn(),
      now: () => 0,
    };
    return createStacks(deps as never);
  }

  it("stackMenuFor: with no report yet, the trunk comes from the settings (item 2)", async () => {
    const { stackMenuFor } = await import("../useStackActions");
    const s = await realStacks("main");
    expect(s.report.value).toBeNull();
    expect(stackMenuFor(s, "main").stackOn).toBe(false);
    expect(stackMenuFor(s, "feature").stackOn).toBe(true);
  });

  it("stackMenuFor: no trunk known at all → no Stack on… (item 2)", async () => {
    const { stackMenuFor } = await import("../useStackActions");
    const s = await realStacks(null);
    expect(stackMenuFor(s, "feature")).toEqual({ stackOn: false, unstack: false, restack: false });
  });

  it("stackMenuHandlers run on the current repo and do nothing without one (item 3)", async () => {
    const { stackMenuHandlers } = await import("../useStackActions");
    const actions = { requestStackOn: vi.fn(), unstack: vi.fn(), restackFrom: vi.fn() };
    let cwd: string | null = null;
    const h = stackMenuHandlers(actions, () => cwd);
    h.stackOn("b");
    h.unstack("b");
    h.restack("b");
    expect(actions.requestStackOn).not.toHaveBeenCalled();
    expect(actions.unstack).not.toHaveBeenCalled();
    expect(actions.restackFrom).not.toHaveBeenCalled();
    cwd = "/r";
    h.stackOn("b");
    h.unstack("b");
    h.restack("b");
    expect(actions.requestStackOn).toHaveBeenCalledWith("/r", "b");
    expect(actions.unstack).toHaveBeenCalledWith("/r", "b");
    expect(actions.restackFrom).toHaveBeenCalledWith("/r", "b");
  });

  it("repoSwitched clears a Stack on… request made in another repo (item 7)", async () => {
    const { useStackActions } = await import("../useStackActions");
    const a = useStackActions();
    a.requestStackOn("/r", "b");
    a.repoSwitched("/r");
    expect(a.stackOnRequest.value).toEqual({ cwd: "/r", branch: "b" });
    a.repoSwitched("/other");
    expect(a.stackOnRequest.value).toBeNull();
    a.requestStackOn("/r", "b");
    a.repoSwitched(null);
    expect(a.stackOnRequest.value).toBeNull();
  });
});
