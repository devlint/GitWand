// @vitest-environment jsdom
/**
 * CombinedDiffBody.vue — AI summary button: shown only when the provider is
 * available, loading state, result block, inline error. From props alone.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createApp, h, nextTick, ref, type App } from "vue";
import CombinedDiffBody from "../CombinedDiffBody.vue";
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
const data: CombinedDiff = { base: "b", commits, diffs: [file("a.txt")], steps: [[file("a.txt")], []], fallback: [], truncated: false, budgetOmitted: [] };

Element.prototype.scrollIntoView = vi.fn();
let app: App | null = null;
let container: HTMLElement | null = null;

type SummaryProps = { aiAvailable: boolean; summary?: string | null; summarizing?: boolean; summaryError?: boolean };
let emittedSummarize = 0;

async function mount(p: SummaryProps) {
  emittedSummarize = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp({
    render: () =>
      h(CombinedDiffBody, {
        request: { hashes: commits.map((c) => c.hash) }, diffMode: "inline",
        data, loading: false, error: null,
        summary: null, summarizing: false, summaryError: false, ...p,
        onSummarize: () => { emittedSummarize++; },
      }),
  });
  app.mount(container);
  for (let i = 0; i < 3; i++) { await Promise.resolve(); await nextTick(); }
}
const q = (s: string) => container!.querySelector(s) as HTMLElement | null;

afterEach(() => { app?.unmount(); container?.remove(); app = null; container = null; document.body.innerHTML = ""; });

describe("CombinedDiffBody AI summary", () => {
  it("hides the button when no provider is available", async () => {
    await mount({ aiAvailable: false });
    expect(q(".cmb-summarize")).toBeNull();
  });

  it("the button asks for a summary of the N commits", async () => {
    await mount({ aiAvailable: true });
    const btn = q(".cmb-summarize") as HTMLButtonElement;
    expect(btn.textContent).toBe("combined.summarize:2");
    expect(btn.disabled).toBe(false);
    btn.click();
    expect(emittedSummarize).toBe(1);
  });

  it("disables the button while summarizing", async () => {
    await mount({ aiAvailable: true, summarizing: true });
    expect((q(".cmb-summarize") as HTMLButtonElement).disabled).toBe(true);
    expect(q(".cmb-summarize")!.getAttribute("aria-busy")).toBe("true");
  });

  it("shows the result block", async () => {
    await mount({ aiAvailable: true, summary: "What: stuff" });
    expect(q(".cmb-summary")?.textContent?.trim()).toBe("What: stuff");
    expect(q(".cmb-summary")!.getAttribute("role")).toBe("status");
  });

  it("shows the error inline on failure", async () => {
    await mount({ aiAvailable: true, summaryError: true });
    expect(q(".cmb-summary--error")?.textContent?.trim()).toBe("combined.summaryError");
    expect(q(".cmb-summary")!.getAttribute("role")).toBe("alert");
  });
});
