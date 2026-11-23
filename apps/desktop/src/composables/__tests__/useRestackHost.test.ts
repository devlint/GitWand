import { describe, it, expect, vi } from "vitest";
import { createRestackHost, type RestackHostDeps } from "../useRestackHost";
import type { AfterRestack, PushResult } from "../useStacks";
import type { RestackPlan } from "../../utils/backend";
import type { ApplyOutcome } from "../useApplyFromPreview";

const after = (push: AfterRestack["push"]): AfterRestack => ({
  cwd: "/r",
  finalized: {
    moment: "parent_moved",
    bottom: "step-2",
    merged_parent: null,
    new_parent: null,
    moved: ["step-2", "step-3"],
    switched_back_to: null,
    switch_error: null,
  },
  retarget: { state: "none", number: null, base: null, error: null },
  deleteOffer: null,
  push,
});

const plan = { bottom: "step-2", onto_ref: "step-1" } as RestackPlan;

function setup(cwd: string | null = "/r") {
  const toast = vi.fn();
  const applyRebase = vi.fn(async () => ({ stoppedReason: "clean" }) as ApplyOutcome);
  const deps: RestackHostDeps = { currentCwd: () => cwd, applyRebase, toast };
  return { host: createRestackHost(deps), toast, applyRebase };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createRestackHost", () => {
  it("refuses to apply in another repo than the plan's, without running anything", async () => {
    const { host, applyRebase } = setup("/other");
    await expect(
      host.apply("/r", plan, { onto_sha: "", upstream_sha: "", top_sha: "", moving: [] }, [], 0),
    ).rejects.toThrow("Another repository is open now. Reopen /r and preview the restack again.");
    expect(applyRebase).not.toHaveBeenCalled();
  });

  it("applies through the rebase runner in the open repo", async () => {
    const { host, applyRebase } = setup();
    const previewed = { onto_sha: "o", upstream_sha: "u", top_sha: "t", moving: ["step-2"] };
    await host.apply("/r", plan, previewed, [], 3);
    expect(applyRebase).toHaveBeenCalledWith("/r", plan, previewed, [], 3);
  });

  it("noLeases: says so, with no action", () => {
    const { host, toast } = setup();
    const run = vi.fn();
    host.offerPush(after({ pushable: [], skipped: [], noLeases: true }), run);
    expect(toast).toHaveBeenCalledTimes(1);
    const [title, detail, , extras] = toast.mock.calls[0];
    expect(title).toMatch(/^Restacked\. Push the moved branches yourself/);
    expect(detail).toBeNull();
    expect(extras.action).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("skipped only: names them, with no action", () => {
    const { host, toast } = setup();
    host.offerPush(after({ pushable: [], skipped: ["step-3"], noLeases: false }), vi.fn());
    const [title, detail, , extras] = toast.mock.calls[0];
    expect(title).toBe("Restacked.");
    expect(detail).toBe("Not pushed (no upstream): step-3");
    expect(extras.action).toBeUndefined();
  });

  it("offers Push with the skipped detail, and pushes only on click", async () => {
    const { host, toast } = setup();
    const run = vi.fn(async (): Promise<PushResult[]> => [
      { branch: "step-2", ok: true, message: "" },
      { branch: "step-3", ok: false, message: "stale info" },
    ]);
    host.offerPush(
      after({ pushable: [{ branch: "step-2", lease: "a" }, { branch: "step-3", lease: "b" }], skipped: ["x"], noLeases: false }),
      run,
    );
    const [title, detail, , extras] = toast.mock.calls[0];
    expect([title, detail]).toEqual(["2 restacked branches can be pushed.", "Not pushed (no upstream): x"]);
    expect(extras.action.label).toBe("Push");
    expect(run).not.toHaveBeenCalled();
    extras.action.run();
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    // A failure keeps the result on screen (sticky: 0 ms).
    expect(toast.mock.calls[1]).toEqual(["Pushed 1 of 2.", "step-3: stale info", 0]);
  });

  it("a fully successful push is a short toast", async () => {
    const { host, toast } = setup();
    host.offerPush(after({ pushable: [{ branch: "step-2", lease: "a" }], skipped: [], noLeases: false }), async () => [
      { branch: "step-2", ok: true, message: "" },
    ]);
    toast.mock.calls[0][3].action.run();
    await flush();
    expect(toast.mock.calls[1]).toEqual(["Pushed 1 of 1.", null, 4000]);
  });

  it("notify shows the error in the detail toast", () => {
    const { host, toast } = setup();
    host.notify("boom");
    expect(toast).toHaveBeenCalledWith("Error", "boom", 8000);
  });
});
