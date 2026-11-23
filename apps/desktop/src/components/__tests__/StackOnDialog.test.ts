// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { createApp, h, nextTick, type App } from "vue";

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
