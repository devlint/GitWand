// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import {
  createStacks,
  registerRestackHost,
  __setStacksForTest,
  type StacksDeps,
  type Stacks,
  type AfterRestack,
} from "../../composables/useStacks";
import type { StackLayerStatus, StackReport, GitPushPullResult } from "../../utils/backend";
import StackBanner from "../StackBanner.vue";

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
  top: "step-2",
  ...over,
});

const report = (over: Partial<StackReport> = {}): StackReport => ({
  trunk: "main",
  remote_trunk: "origin/main",
  layers: [layer({ branch: "step-1", parent: "main" }), layer()],
  rebase_in_progress: false,
  finalized: null,
  git_supports_restack: true,
  pending_error: null,
  ...over,
});

async function seed(r: StackReport, currentBranch = "step-2"): Promise<{ s: Stacks; deps: StacksDeps }> {
  const deps: StacksDeps = {
    status: vi.fn(async () => r),
    setParent: vi.fn(async (_c: string, branch: string, parent: string) => ({ branch, parent, base: null })),
    unset: vi.fn(async () => {}),
    plan: vi.fn(async () => {
      throw new Error("not planned in this test");
    }),
    fetch: vi.fn(async () => ({ success: true, message: "" })),
    branchPr: vi.fn(async () => null),
    setPrBase: vi.fn(async () => {}),
    pushBranch: vi.fn(async (): Promise<GitPushPullResult> => ({ success: true, message: "" })),
    deleteBranch: vi.fn(async () => {}),
    forge: () => "gitlab",
    trunkSetting: () => "main",
    dismissed: () => [],
    dismiss: vi.fn(),
    now: () => 0,
  };
  const s = createStacks(deps);
  s.setContext({
    cwd: "/r",
    forge: "gitlab",
    currentBranch,
    localBranches: ["main", "step-1", "step-2"],
    prs: [],
  });
  await s.refresh("/r");
  __setStacksForTest(s);
  return { s, deps };
}

const after = (over: Partial<AfterRestack> = {}): AfterRestack => ({
  cwd: "/r",
  finalized: {
    moment: "parent_merged",
    bottom: "step-2",
    merged_parent: "step-1",
    new_parent: null,
    moved: ["step-2"],
    switched_back_to: null,
    switch_error: null,
  },
  retarget: { state: "none", number: null, base: null, error: null },
  deleteOffer: null,
  push: { pushable: [], skipped: [], noLeases: false },
  ...over,
});

let app: App | null = null;
let container: HTMLElement;

afterEach(() => {
  app?.unmount();
  app = null;
  container?.remove();
  __setStacksForTest(null);
  registerRestackHost(null);
});

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp(StackBanner);
  app.mount(container);
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await nextTick();
  await Promise.resolve();
};
const text = () => container.textContent ?? "";
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) ?? null;

describe("StackBanner — restack mode", () => {
  const outOfDate = () =>
    report({ layers: [layer({ branch: "step-1", parent: "main" }), layer({ state: "out_of_date", actionable: true })] });

  it("says the parent moved, and Preview starts the restack of that layer", async () => {
    const { s } = await seed(outOfDate());
    const start = vi.fn(async () => {});
    s.startRestack = start;
    mount();
    expect(text()).toContain("step-1 has new commits that step-2 is not on yet.");
    button("Preview restack")!.click();
    await flush();
    expect(start).toHaveBeenCalledWith("/r", "step-2");
  });

  it("Later hides it", async () => {
    await seed(outOfDate());
    mount();
    button("Later")!.click();
    await flush();
    expect(text()).not.toContain("has new commits");
  });

  it("shows no Preview for a layer that cannot be restacked now", async () => {
    await seed(
      report({ layers: [layer({ branch: "step-1", parent: "main" }), layer({ state: "out_of_date", actionable: false })] }),
    );
    mount();
    expect(text()).toContain("step-1 has new commits that step-2 is not on yet.");
    expect(button("Preview restack")).toBeNull();
  });

  it("names the merged PR and the old commits for a merged parent", async () => {
    await seed(
      report({
        layers: [
          layer({ branch: "step-1", parent: "main" }),
          layer({ state: "parent_merged", actionable: true, merged_pr: 41 }),
        ],
      }),
    );
    mount();
    expect(text()).toContain("step-1 was merged into main (PR #41).");
    expect(text()).toContain("step-2 still contains its old commits.");
  });

  it("offers Unstack for a lost base", async () => {
    const { deps } = await seed(
      report({ layers: [layer({ branch: "step-1", parent: "main" }), layer({ state: "base_lost" })] }),
    );
    mount();
    expect(text()).toContain("GitWand no longer knows where step-2 sits on step-1.");
    expect(button("Preview restack")).toBeNull();
    button("Unstack")!.click();
    await flush();
    expect(deps.unset).toHaveBeenCalledWith("/r", "step-2");
  });

  it("shows a pending record error with Unstack of the chain's top", async () => {
    const { deps } = await seed(
      report({
        layers: [layer({ branch: "step-1", parent: "main", top: "step-2" }), layer({ state: "out_of_date" })],
        pending_error: "cannot settle step-2",
      }),
    );
    mount();
    expect(text()).toContain("GitWand could not finish the last restack: cannot settle step-2. Unstack the branch to clear it.");
    expect(button("Preview restack")).toBeNull();
    button("Unstack")!.click();
    await flush();
    expect(deps.unset).toHaveBeenCalledWith("/r", "step-2");
  });
});

describe("StackBanner — after a restack", () => {
  it("a failed retarget offers Retry, which calls retryRetarget", async () => {
    const { s } = await seed(report());
    const retry = vi.fn(async () => {});
    s.retryRetarget = retry;
    s.after.value = after({ retarget: { state: "failed", number: 7, base: "main", error: "422" } });
    mount();
    expect(text()).toContain("Could not retarget PR #7 to main: 422");
    button("Retry retarget")!.click();
    await flush();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("offers to delete the merged parent", async () => {
    const { s, deps } = await seed(report());
    s.after.value = after({ deleteOffer: "step-1" });
    mount();
    button("Delete local step-1")!.click();
    await flush();
    expect(deps.deleteBranch).toHaveBeenCalledWith("/r", "step-1");
  });

  it("says when the restack could not switch back", async () => {
    const { s } = await seed(report());
    s.after.value = after({
      finalized: { ...after().finalized, switch_error: "not switched back to step-1: uncommitted changes on step-2" },
    });
    mount();
    expect(text()).toContain("Restacked, but could not switch back to step-1: uncommitted changes on step-2");
  });

  it("is hidden while another repo is open, and ✕ dismisses it", async () => {
    const { s } = await seed(report());
    s.after.value = after({ cwd: "/other", deleteOffer: "step-1" });
    mount();
    expect(button("Delete local step-1")).toBeNull();
    s.after.value = after({ deleteOffer: "step-1" });
    await flush();
    container.querySelector<HTMLButtonElement>(".stack-banner__dismiss")!.click();
    await flush();
    expect(s.after.value).toBeNull();
    expect(button("Delete local step-1")).toBeNull();
  });
});
