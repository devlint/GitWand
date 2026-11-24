// @vitest-environment jsdom
/**
 * StackOnHost — the single mount point of StackOnDialog (QA bug 1): the Git
 * Tree and the header branch selector only set `stackOnRequest`; the host
 * opens the dialog from it and clears it on close.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createApp, h, nextTick, ref, type App } from "vue";

vi.mock("../../composables/useI18n", () => ({
  useI18n: () => ({ t: (key: string, ...args: unknown[]) => (args.length ? `${key}:${args.join(",")}` : key) }),
}));

import { __setStacksForTest, type Stacks } from "../../composables/useStacks";
import { useStackActions } from "../../composables/useStackActions";
import StackOnHost from "../StackOnHost.vue";

let app: App | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  app?.unmount();
  app = null;
  container?.remove();
  container = null;
  useStackActions().closeStackOn();
  __setStacksForTest(null);
});

const flush = async () => {
  for (let i = 0; i < 10; i++) {
    await nextTick();
    await new Promise((r) => setTimeout(r, 0));
  }
};

describe("StackOnHost", () => {
  it("opens StackOnDialog from a request, with the branch's candidates and the forge", async () => {
    const stackOnCandidates = vi.fn(() => ["main", "step-1"]);
    __setStacksForTest({
      report: ref(null),
      context: ref({ cwd: "/r", forge: "gitlab", currentBranch: null, localBranches: [], prs: [] }),
      stackOnCandidates,
      stackOn: vi.fn(),
    } as unknown as Stacks);
    container = document.createElement("div");
    document.body.appendChild(container);
    app = createApp({ render: () => h(StackOnHost) });
    app.mount(container);
    await flush();
    expect(document.querySelector("#sod-parent")).toBeNull();

    useStackActions().requestStackOn("/r", "step-2");
    await flush();
    // The dialog is lazy: wait for its chunk.
    await vi.waitFor(() => expect(document.querySelector("#sod-parent")).not.toBeNull());
    const select = document.querySelector<HTMLSelectElement>("#sod-parent");
    expect(select).not.toBeNull();
    expect(Array.from(select!.options).map((o) => o.value)).toEqual(["main", "step-1"]);
    expect(stackOnCandidates).toHaveBeenCalledWith("step-2");
    expect(document.body.textContent).toContain("stacks.stackOn.title:step-2");
    // gitlab → the squash-merge hint is shown (forge came from the stacks context).
    expect(document.body.textContent).toContain("stacks.stackOn.forgeHint");

    document.querySelector<HTMLButtonElement>(".bm-btn--ghost")!.click();
    await flush();
    expect(useStackActions().stackOnRequest.value).toBeNull();
    expect(document.querySelector("#sod-parent")).toBeNull();
  });
});

describe("StackOnHost — QA2", () => {
  it("ignores a request made for another repository (item 7)", async () => {
    __setStacksForTest({
      report: ref(null),
      context: ref({ cwd: "/other", forge: null, currentBranch: null, localBranches: [], prs: [] }),
      stackOnCandidates: vi.fn(() => ["main"]),
      stackOn: vi.fn(),
    } as unknown as Stacks);
    container = document.createElement("div");
    document.body.appendChild(container);
    app = createApp({ render: () => h(StackOnHost) });
    app.mount(container);
    useStackActions().requestStackOn("/r", "step-2");
    await flush();
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector("#sod-parent")).toBeNull();
  });
});

describe("lazyStackView — chunk load failure (item 8)", () => {
  it("runs the cleanup and reports the error through the stack error channel", async () => {
    const { lazyStackView } = await import("../../composables/useStackActions");
    const { registerRestackHost } = await import("../../composables/useStacks");
    const notify = vi.fn();
    registerRestackHost({ apply: vi.fn(), offerPush: vi.fn(), notify } as never);
    const onFail = vi.fn();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const View = lazyStackView(() => Promise.reject(new Error("Failed to fetch dynamically imported module")), onFail);
      container = document.createElement("div");
      document.body.appendChild(container);
      app = createApp({ render: () => h(View) });
      app.config.errorHandler = () => {};
      app.mount(container);
      await vi.waitFor(() => expect(onFail).toHaveBeenCalledTimes(1));
      expect(notify).toHaveBeenCalledWith("Failed to fetch dynamically imported module");
    } finally {
      registerRestackHost(null);
      errSpy.mockRestore();
    }
  });
});
