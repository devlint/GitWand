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
