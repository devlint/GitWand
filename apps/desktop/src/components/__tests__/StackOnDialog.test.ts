// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { createApp, h, nextTick, ref, type App } from "vue";

// A plain function, not a vi.fn(): the spy keeps a derived promise of a
// rejected result, which vitest then reports as an unhandled rejection.
let stackOnImpl: (cwd: string, branch: string, parent: string) => Promise<void> = async () => {};
const stackOnCalls: string[][] = [];
vi.mock("../../composables/useStacks", () => ({
  useStacks: () => ({
    stackOn: (cwd: string, branch: string, parent: string) => {
      stackOnCalls.push([cwd, branch, parent]);
      return stackOnImpl(cwd, branch, parent);
    },
  }),
}));

import StackOnDialog from "../StackOnDialog.vue";

let app: App | null = null;
let container: HTMLElement;

beforeEach(() => {
  stackOnImpl = async () => {};
  stackOnCalls.length = 0;
});
afterEach(() => {
  app?.unmount();
  app = null;
  container?.remove();
});

function mountDialog(over: { candidates?: string[]; forge?: string | null } = {}, onClose = vi.fn()) {
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp({
    render: () =>
      h(StackOnDialog, {
        cwd: "/r",
        branch: "step-2",
        candidates: over.candidates ?? ["step-1"],
        forge: over.forge === undefined ? "github" : over.forge,
        onClose,
      }),
  });
  app.mount(container);
  return onClose;
}

const confirmBtn = () => document.querySelector<HTMLButtonElement>(".bm-btn--primary")!;
const flush = async () => { for (let i = 0; i < 5; i++) await nextTick(); await Promise.resolve(); };
const HINT = "Squash merges of more than one commit are detected on GitHub only.";

describe("StackOnDialog", () => {
  it("shows the backend error verbatim and does not close", async () => {
    stackOnImpl = async () => { throw new Error("step-1 is stacked on step-2 (cycle)"); };
    const onClose = mountDialog();
    confirmBtn().click();
    await flush();
    expect(document.querySelector("[role=alert]")?.textContent).toBe("step-1 is stacked on step-2 (cycle)");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on success", async () => {
    const onClose = mountDialog();
    confirmBtn().click();
    await flush();
    expect(stackOnCalls).toEqual([["/r", "step-2", "step-1"]]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each(["gitlab", "unknown"])("shows the forge hint for %s", (forge) => {
    mountDialog({ forge });
    expect(document.body.textContent).toContain(HINT);
  });

  it.each(["github", null])("hides the forge hint for %s", (forge) => {
    mountDialog({ forge });
    expect(document.body.textContent).not.toContain(HINT);
  });

  it("disables Stack and explains when there is no candidate", () => {
    mountDialog({ candidates: [] });
    expect(confirmBtn().disabled).toBe(true);
    expect(document.body.textContent).toContain("No branch can be a parent here");
  });
});

describe("StackOnDialog — QA2 item 10", () => {
  it("keeps the chosen parent selected after an inline error, even when a refresh drops it from the list", async () => {
    stackOnImpl = async () => { throw new Error("step-3 already has a stacked branch (step-4). Stacks are linear for now: stack on step-4 instead."); };
    const candidates = ref(["step-1", "step-3", "other"]);
    container = document.createElement("div");
    document.body.appendChild(container);
    app = createApp({
      render: () => h(StackOnDialog, { cwd: "/r", branch: "step-2", candidates: candidates.value, forge: "github" }),
    });
    app.mount(container);
    const select = document.querySelector<HTMLSelectElement>("#sod-parent")!;
    select.value = "step-3";
    select.dispatchEvent(new Event("change"));
    await flush();
    confirmBtn().click();
    await flush();
    expect(document.querySelector("[role=alert]")).not.toBeNull();
    // The refresh that follows the refusal: step-3 is no longer a candidate.
    candidates.value = ["step-1", "other"];
    await flush();
    expect(select.value).toBe("step-3");
    expect(stackOnCalls).toEqual([["/r", "step-2", "step-3"]]);
  });

  it.each([
    ["A branch cannot be stacked on itself.", "A branch can't be stacked on itself."],
    ["main is the trunk and cannot be stacked.", "main is the trunk: it can't be stacked."],
    ["main is the trunk: stacking on it is not a stack. Use Unstack instead.", "main is the trunk: stacking on it makes no stack. Use Unstack instead."],
    ["Unknown local branch: ghost", "ghost is not a local branch."],
    [
      "step-1 already has a stacked branch (step-2). Stacks are linear for now: stack on step-2 instead.",
      "step-1 already has a stacked branch (step-2). Stacks are linear: stack on step-2 instead.",
    ],
    ["Stacking C on A would create a cycle.", "Stacking C on A would create a cycle."],
  ])("shows the known refusal %j localized", async (raw, shown) => {
    stackOnImpl = async () => { throw new Error(raw); };
    mountDialog();
    confirmBtn().click();
    await flush();
    expect(document.querySelector("[role=alert]")?.textContent).toBe(shown);
  });
});
