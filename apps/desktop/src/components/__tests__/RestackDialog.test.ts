// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { createApp, nextTick, ref, computed, type App } from "vue";

// The preview itself is useMergePreview's job (tested there): a fake records
// what the dialog asks of it.
const computeRestackPreview = vi.fn(async () => {});
vi.mock("../../composables/useMergePreview", () => ({
  useMergePreview: () => ({
    loading: ref(false),
    error: ref(null),
    summary: ref({
      sourceBranch: "step-3",
      files: [],
      conflictingFiles: 0,
      autoResolvableFiles: 0,
      manualFiles: 0,
      cleanFiles: 0,
      fullyAutoMergeable: true,
    }),
    conflictingFiles: computed(() => []),
    riskLevel: computed(() => "low"),
    threshold: ref(0),
    estimatedAutoResolutions: computed(() => 4),
    heldByThreshold: computed(() => 0),
    manualHunks: computed(() => 0),
    computeRestackPreview,
  }),
}));

import {
  createStacks,
  preloadStacksFlow,
  __setStacksForTest,
  idleFlow,
  type Stacks,
  type StacksDeps,
  type RestackFlow,
} from "../../composables/useStacks";
import type { RestackPlan } from "../../utils/backend";
import RestackDialog from "../RestackDialog.vue";

const plan: RestackPlan = {
  moment: "parent_moved",
  bottom: "step-2",
  parent: "step-1",
  onto_ref: "refs/heads/step-1",
  onto_sha: "onto",
  upstream_sha: "up",
  top: "step-3",
  top_sha: "top",
  moving: [
    { branch: "step-2", in_stack: true, upstream: null, remote_sha: null, push_block: null },
    { branch: "tag-along", in_stack: false, upstream: null, remote_sha: null, push_block: null },
  ],
  new_parent: null,
  refusal: null,
};

function store(): Stacks {
  const none = vi.fn();
  const s = createStacks({
    status: none, setParent: none, unset: none, plan: none, fetch: none, branchPr: none, setPrBase: none,
    pushBranch: none, deleteBranch: none, forge: () => null, trunkSetting: () => "main",
    dismissed: () => [], dismiss: none, now: () => 0,
  } as unknown as StacksDeps);
  __setStacksForTest(s);
  return s;
}

let app: App | null = null;
let s: Stacks;

beforeAll(() => preloadStacksFlow());
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
  __setStacksForTest(null);
  computeRestackPreview.mockClear();
});

async function mount(flow: Partial<RestackFlow>) {
  s = store();
  s.flow.value = { ...idleFlow(), cwd: "/r", branch: "step-2", ...flow };
  const el = document.createElement("div");
  document.body.appendChild(el);
  app = createApp(RestackDialog);
  app.mount(el);
  for (let i = 0; i < 4; i++) await nextTick();
}

const body = () => document.body.textContent ?? "";
const footerButtons = () => [...document.querySelectorAll<HTMLButtonElement>(".bm-btn")].map((b) => b.textContent?.trim());

describe("RestackDialog", () => {
  it.each([
    ["fetching", "Fetching…"],
    ["planning", "Preparing the restack…"],
  ] as const)("%s: shows its text, with Cancel", async (phase, text) => {
    await mount({ phase });
    expect(body()).toContain("Restack step-2");
    expect(body()).toContain(text);
    expect(footerButtons()).toEqual(["Cancel"]);
  });

  it("refused: the localized refusal with its branch and path, and Close", async () => {
    await mount({
      phase: "refused",
      refusal: { code: "occupied", message: "raw", branch: "step-3", path: "/wt", detail: null },
    });
    expect(body()).toContain("step-3 is checked out in another worktree (/wt). Restacking would leave it behind.");
    expect(body()).not.toContain("raw");
    expect(footerButtons()).toEqual(["Close"]);
  });

  it.each([
    [
      { code: "occupied_rebasing", branch: "step-3", path: "/wt", detail: null },
      "step-3 is being rebased in another worktree (/wt). Finish or abort that rebase first.",
    ],
    [{ code: "parent_behind", branch: "step-1", path: null, detail: "2" }, "step-1 is 2 commit(s) behind its remote. Pull it first."],
    [{ code: "git_too_old", branch: null, path: null, detail: "2.37" }, "Restacking needs git 2.38 or later (found 2.37)."],
    [
      { code: "fetch_failed", branch: null, path: null, detail: "offline" },
      "Could not fetch (offline): the merged commit may be missing locally. Try again when online.",
    ],
    [
      { code: "merged_work_missing", branch: "origin/main", path: null, detail: null },
      "The merged work is not in origin/main yet: update origin/main first.",
    ],
  ] as const)("refused %#: the backend detail goes into the text (M-3)", async (r, text) => {
    await mount({ phase: "refused", refusal: { ...r, message: "raw" } });
    expect(body()).toContain(text);
  });

  it("merged_work_missing onto the remote trunk says the work was likely merged elsewhere (wave 4, M2)", async () => {
    const refusal = { code: "merged_work_missing", message: "raw", branch: "origin/main", path: null, detail: null } as const;
    const trunkPlan = { ...plan, moment: "parent_merged", onto_ref: "origin/main", new_parent: null, refusal } as const;
    await mount({ phase: "refused", plan: trunkPlan, refusal });
    expect(body()).toContain(
      "GitWand cannot find the merged work of step-1 in origin/main. If the pull request was squash-merged elsewhere, unstack step-1's child and restack it by hand.",
    );
    app?.unmount();
    document.body.innerHTML = "";
    const stacked = { ...trunkPlan, parent: "step-2", onto_ref: "step-1", new_parent: "step-1", refusal: { ...refusal, branch: "step-1" } };
    await mount({ phase: "refused", plan: stacked, refusal: stacked.refusal });
    expect(body()).toContain("The merged work is not in step-1 yet: update step-1 first.");
  });

  it("preview: intro, fetch warning, the moving refs, and the restack preview asked for the plan", async () => {
    await mount({ phase: "preview", plan, fetchWarning: "offline" });
    expect(body()).toContain("Moves step-2 onto the new tip of step-1.");
    expect(body()).toContain("Fetch failed (offline). Restacking onto the local step-1.");
    expect(body()).toContain("step-2tag-along(not in the stack)");
    expect(computeRestackPreview).toHaveBeenCalledWith({ onto: "onto", upstream: "up", branch: "step-3", label: "step-3" });
    expect(footerButtons()).toContain("Cancel");
  });

  it("applying: nothing in the footer, and the dialog cannot be closed", async () => {
    await mount({ phase: "applying", plan });
    expect(footerButtons().filter((b) => b === "Cancel" || b === "Close")).toEqual([]);
    expect(document.querySelector(".base-modal__close, [aria-label='Close']")).toBeNull();
    const close = vi.spyOn(s, "closeRestack");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await nextTick();
    expect(close).not.toHaveBeenCalled();
    expect(s.flow.value.phase).toBe("applying");
  });

  it.each([
    ["residual", "The restack stopped on conflicts."],
    ["done", "Restacked."],
  ] as const)("%s: its text and Close, which closes the flow", async (phase, text) => {
    await mount({ phase, plan });
    expect(body()).toContain(text);
    expect(footerButtons()).toEqual(["Close"]);
    document.querySelector<HTMLButtonElement>(".bm-btn")!.click();
    expect(s.flow.value.phase).toBe("idle");
  });

  it("error: the error verbatim, and Close", async () => {
    await mount({ phase: "error", error: "restack step-1 first" });
    expect(body()).toContain("restack step-1 first");
    expect(footerButtons()).toEqual(["Close"]);
  });
});
