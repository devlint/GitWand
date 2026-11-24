// @vitest-environment jsdom
/**
 * CombinedDiffView.vue — AI summary button: shown only when the provider is
 * available, loading state, result block, inline error. Fakes injected.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createApp, h, nextTick, ref, type App } from "vue";
import CombinedDiffView from "../CombinedDiffView.vue";
import type { CombinedDiff, GitDiff } from "../../utils/backend";

vi.mock("../../composables/useI18n", () => ({
  useI18n: () => ({
    t: (key: string, ...args: unknown[]) => (args.length ? `${key}:${args.join(",")}` : key),
    locale: ref("fr"),
  }),
}));

const file = (path: string): GitDiff => ({
  path,
  hunks: [{ header: "@@ -0,0 +1,1 @@", oldStart: 0, oldCount: 0, newStart: 1, newCount: 1, lines: [{ type: "add", content: "x", newLineNo: 1 }] }],
});
const commits = ["1", "2"].map((n) => ({ hash: n.repeat(40), shortHash: n.repeat(7), subject: `s${n}`, author: "a", date: "d" }));
const data: CombinedDiff = { base: "b", commits, diffs: [file("a.txt")], steps: [[file("a.txt")], []], fallback: [] };

Element.prototype.scrollIntoView = vi.fn();
let app: App | null = null;
let container: HTMLElement | null = null;

async function mount(deps: { rawPrompt: (s: string, u: string) => Promise<string>; available: boolean }) {
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp({
    render: () =>
      h(CombinedDiffView, {
        cwd: "/r", request: { hashes: commits.map((c) => c.hash) }, diffMode: "inline",
        fetcher: async () => data,
        summaryDeps: { rawPrompt: deps.rawPrompt, isAvailable: ref(deps.available) },
      }),
  });
  app.mount(container);
  for (let i = 0; i < 6; i++) { await Promise.resolve(); await nextTick(); }
}
const flush = async () => { for (let i = 0; i < 6; i++) { await Promise.resolve(); await nextTick(); } };
const q = (s: string) => container!.querySelector(s) as HTMLElement | null;

afterEach(() => { app?.unmount(); container?.remove(); app = null; container = null; document.body.innerHTML = ""; });

describe("CombinedDiffView AI summary", () => {
  it("hides the button when no provider is available", async () => {
    await mount({ rawPrompt: async () => "", available: false });
    expect(q(".cmb-summarize")).toBeNull();
  });

  it("shows loading, then the result block", async () => {
    let resolve!: (v: string) => void;
    await mount({ rawPrompt: () => new Promise((r) => { resolve = r; }), available: true });
    const btn = q(".cmb-summarize") as HTMLButtonElement;
    expect(btn.textContent).toBe("combined.summarize:2");
    btn.click();
    await flush();
    expect((q(".cmb-summarize") as HTMLButtonElement).disabled).toBe(true);
    resolve("What: stuff");
    await flush();
    expect(q(".cmb-summary")?.textContent?.trim()).toBe("What: stuff");
    expect((q(".cmb-summarize") as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows the error inline on failure", async () => {
    await mount({ rawPrompt: async () => { throw new Error("boom"); }, available: true });
    (q(".cmb-summarize") as HTMLButtonElement).click();
    await flush();
    expect(q(".cmb-summary--error")?.textContent?.trim()).toBe("combined.summaryError");
  });
});
