// @vitest-environment jsdom
/**
 * FileHistoryViewer.vue — combine versions from the log tab (v3.15).
 * Blame/log loaders are injected (no backend mock).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createApp, h, nextTick, type App } from "vue";
import FileHistoryViewer from "../FileHistoryViewer.vue";
import type { FileLogEntry } from "../../utils/backend";

vi.mock("../../composables/useI18n", () => ({
  useI18n: () => ({
    t: (key: string, ...args: unknown[]) => (args.length ? `${key}:${args.join(",")}` : key),
    locale: { value: "en" },
  }),
}));

const H = (c: string) => c.repeat(40);
const entry = (c: string, path?: string): FileLogEntry => ({
  ...(path ? { path } : {}),
  hashFull: H(c), hash: c.repeat(7), author: "Dev", date: "2026-08-01T00:00:00Z", message: `msg ${c}`, body: "",
});
// c is the newest; b and a predate a rename old.txt -> new.txt
const LOG = [entry("c", "new.txt"), entry("b", "old.txt"), entry("a", "old.txt")];

let app: App | null = null;
let container: HTMLElement | null = null;

async function flush() {
  for (let i = 0; i < 6; i++) { await Promise.resolve(); await nextTick(); }
}

let seq = 0;
// Selection state is module-scoped: a fresh repo path per test keeps them apart.
async function mount(log: FileLogEntry[] = LOG, cwd = `/r${++seq}`) {
  const emitted: Record<string, unknown[][]> = { "select-commit": [], "open-combined": [], close: [] };
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp({
    render: () =>
      h(FileHistoryViewer, {
        cwd, filePath: "new.txt",
        blameFetcher: async () => [],
        logFetcher: async () => log,
        "onSelect-commit": (...a: unknown[]) => emitted["select-commit"].push(a),
        "onOpen-combined": (...a: unknown[]) => emitted["open-combined"].push(a),
        onClose: (...a: unknown[]) => emitted.close.push(a),
      }),
  });
  app.mount(container);
  await flush();
  container.querySelectorAll<HTMLElement>(".fhv-tab")[1].click();
  await flush();
  return emitted;
}

const infos = () => [...container!.querySelectorAll<HTMLElement>(".fhv-log-info")];
const click = async (el: HTMLElement, init: MouseEventInit = {}) => {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, ...init }));
  await flush();
};
const combineBtn = () => container!.querySelector<HTMLButtonElement>(".fhv-combine-btn");

afterEach(() => {
  app?.unmount(); app = null;
  container?.remove(); container = null;
});

describe("FileHistoryViewer combined", () => {
  it("plain click keeps emitting select-commit", async () => {
    const e = await mount();
    await click(infos()[0]);
    expect(e["select-commit"]).toEqual([[H("c")]]);
    expect(combineBtn()).toBeNull();
  });

  it("modifier-click builds a selection without select-commit and shows the button", async () => {
    const e = await mount();
    await click(infos()[0], { metaKey: true, ctrlKey: true });
    expect(combineBtn()).toBeNull();
    await click(infos()[2], { metaKey: true, ctrlKey: true });
    expect(e["select-commit"]).toEqual([]);
    expect(combineBtn()?.textContent).toContain("combined.historyButton:2");
  });

  it("opens with both hashes and the union of paths (rename)", async () => {
    const e = await mount();
    await click(infos()[0], { metaKey: true, ctrlKey: true });
    await click(infos()[1], { metaKey: true, ctrlKey: true });
    combineBtn()!.click();
    await flush();
    expect(e["open-combined"]).toEqual([[{ hashes: expect.arrayContaining([H("c"), H("b")]), paths: ["new.txt", "old.txt"] }]]);
    expect((e["open-combined"][0][0] as { hashes: string[] }).hashes).toHaveLength(2);
  });

  it("shift-click selects the range from the anchor", async () => {
    await mount();
    await click(infos()[0], { metaKey: true, ctrlKey: true });
    await click(infos()[2], { shiftKey: true });
    expect(combineBtn()?.textContent).toContain("combined.historyButton:3");
  });
});
