// @vitest-environment jsdom
/**
 * CombinedDiffView.vue — header chips, fallback banners, own file list,
 * error / empty states, Esc. The fetcher is injected (no backend mock).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createApp, h, nextTick, ref, type App } from "vue";
import CombinedDiffView from "../CombinedDiffView.vue";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const paletteCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../assets/combined-palette.css"), "utf-8");
import type { CombinedDiff, DiffHunk, DiffLine, GitDiff } from "../../utils/backend";

vi.mock("../../composables/useI18n", () => ({
  useI18n: () => ({
    t: (key: string, ...args: unknown[]) => (args.length ? `${key}:${args.join(",")}` : key),
    locale: ref("en"),
  }),
}));

const add = (n: number, content = "x"): DiffLine => ({ type: "add", content, newLineNo: n });
const hunk = (lines: DiffLine[]): DiffHunk => ({
  header: "@@ -0,0 +1,1 @@", oldStart: 0, oldCount: 0, newStart: 1, newCount: lines.length, lines,
});
const file = (path: string, lines: DiffLine[] = [add(1)], extra: Partial<GitDiff> = {}): GitDiff =>
  ({ path, hunks: lines.length ? [hunk(lines)] : [], ...extra });

const H1 = "1".repeat(40);
const H2 = "2".repeat(40);
const H3 = "3".repeat(40);
const commits = [
  { hash: H1, shortHash: "1111111", subject: "first", author: "a", date: "d" },
  { hash: H2, shortHash: "2222222", subject: "second", author: "a", date: "d" },
  { hash: H3, shortHash: "3333333", subject: "third", author: "a", date: "d" },
];
function combined(over: Partial<CombinedDiff> = {}): CombinedDiff {
  return {
    base: "b", commits, diffs: [file("a.txt"), file("b.txt")], steps: [[file("a.txt")], [file("b.txt")], []],
    fallback: [], ...over,
  };
}

// jsdom has no layout: the viewer's scroll-to-file calls this.
Element.prototype.scrollIntoView = vi.fn();

let app: App | null = null;
let container: HTMLElement | null = null;

async function mount(c: CombinedDiff | Error, request = { hashes: [H1, H2, H3] } as { hashes: string[]; paths?: string[] }) {
  const emitted: Record<string, unknown[][]> = { close: [], "select-commit": [], "update:diffMode": [] };
  const fetcher = vi.fn(async () => { if (c instanceof Error) throw c; return c; });
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp({
    render: () =>
      h(CombinedDiffView, {
        cwd: "/r", request, diffMode: "inline", fetcher,
        onClose: (...a: unknown[]) => emitted.close.push(a),
        "onSelect-commit": (...a: unknown[]) => emitted["select-commit"].push(a),
        "onUpdate:diffMode": (...a: unknown[]) => emitted["update:diffMode"].push(a),
      }),
  });
  app.mount(container);
  for (let i = 0; i < 6; i++) { await Promise.resolve(); await nextTick(); }
  return { emitted, fetcher };
}

afterEach(() => {
  app?.unmount();
  container?.remove();
  app = null;
  container = null;
  document.body.innerHTML = "";
});

const q = (sel: string) => container!.querySelector(sel) as HTMLElement | null;
const qa = (sel: string) => Array.from(container!.querySelectorAll(sel)) as HTMLElement[];

describe("CombinedDiffView", () => {
  it("renders one chip per commit in replay order; a click selects that commit", async () => {
    const { emitted } = await mount(combined());
    const chips = qa(".cmb-chip");
    expect(chips.map((c) => c.textContent)).toEqual([
      expect.stringContaining("1111111"), expect.stringContaining("2222222"), expect.stringContaining("3333333"),
    ]);
    expect(chips[1].textContent).toContain("second");
    chips[1].click();
    expect(emitted["select-commit"]).toEqual([[H2]]);
  });

  it("names the blockers in the fallback note when the file is conflicted", async () => {
    await mount(combined({
      fallback: [{ path: "c.txt", conflicted: true, blockers: [H2], perCommit: [{ hash: H1, diff: file("c.txt") }, { hash: H3, diff: file("c.txt") }] }],
    }));
    const notes = qa(".cdv-file-note").map((n) => n.textContent);
    expect(notes).toEqual(["combined.fallbackBlocked:c.txt,2222222"]);
  });

  it("says conflict-between when conflicted without blockers", async () => {
    await mount(combined({
      fallback: [{ path: "c.txt", conflicted: true, blockers: [], perCommit: [{ hash: H1, diff: file("c.txt") }, { hash: H2, diff: file("c.txt") }] }],
    }));
    expect(qa(".cdv-file-note").map((n) => n.textContent)).toEqual(["combined.fallbackBetween:c.txt"]);
  });

  it("uses the companion wording for a non-conflicted fallback", async () => {
    await mount(combined({
      fallback: [{ path: "c.txt", conflicted: false, blockers: [], perCommit: [{ hash: H1, diff: file("c.txt") }] }],
    }));
    expect(qa(".cdv-file-note").map((n) => n.textContent)).toEqual(["combined.fallbackCompanion:c.txt"]);
  });

  it("shows a limited-to chip when paths are given", async () => {
    await mount(combined(), { hashes: [H1, H2], paths: ["a.txt", "old/a.txt"] });
    expect(q(".cmb-limited")!.textContent).toContain("combined.limitedTo:a.txt, old/a.txt");
  });

  it("renders the error message and a retry that refetches", async () => {
    const { fetcher } = await mount(new Error("Unknown commit: abc1234"));
    expect(q(".cmb-error")!.textContent).toContain("Unknown commit: abc1234");
    q(".cmb-retry")!.click();
    for (let i = 0; i < 4; i++) { await Promise.resolve(); await nextTick(); }
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("renders the empty state when nothing nets out", async () => {
    await mount(combined({ diffs: [], steps: [[], [], []] }));
    expect(q(".cmb-empty")!.textContent).toContain("combined.empty");
  });

  it("flags a truncated file instead of an empty diff", async () => {
    await mount(combined({ diffs: [file("big.bin", [], { truncatedFromBytes: 9_000_000 })] }));
    expect(q(".cdv-file-note")!.textContent).toContain("combined.tooLarge");
  });

  it("lists the files in its own list", async () => {
    await mount(combined());
    expect(qa(".cmb-file").map((f) => f.textContent)).toEqual([
      expect.stringContaining("a.txt"), expect.stringContaining("b.txt"),
    ]);
    qa(".cmb-file")[1].click();
    await nextTick();
    expect(qa(".cmb-file")[1].classList.contains("cmb-file--active")).toBe(true);
  });

  it("Esc emits close; ignored in fields and under a modal", async () => {
    const { emitted } = await mount(combined());
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(emitted.close).toHaveLength(0);
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    document.body.appendChild(modal);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(emitted.close).toHaveLength(0);
    modal.remove();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(emitted.close).toHaveLength(1);
  });

  it("Esc closes from the bare page (document, html, body) and from inside the view", async () => {
    const { emitted } = await mount(combined());
    const ev = () => new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
    document.dispatchEvent(ev());
    document.documentElement.dispatchEvent(ev());
    q(".cmb-chip")!.dispatchEvent(ev());
    expect(emitted.close).toHaveLength(3);
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.dispatchEvent(ev());
    expect(emitted.close).toHaveLength(3);
  });

  it("counts unique paths, not fallback sections", async () => {
    await mount(combined({
      diffs: [file("a.txt")],
      fallback: [{ path: "c.txt", conflicted: true, blockers: [], perCommit: [{ hash: H1, diff: file("c.txt") }, { hash: H2, diff: file("c.txt") }, { hash: H3, diff: file("c.txt") }] }],
    }));
    expect(q(".cmb-counts")!.textContent).toContain("2 header.files");
  });

  it("keeps the fallback banner on the first section when a fallback file is truncated", async () => {
    await mount(combined({
      diffs: [],
      fallback: [{ path: "c.txt", conflicted: true, blockers: [], perCommit: [
        { hash: H1, diff: file("c.txt", [], { truncatedFromBytes: 9_000_000 }) },
        { hash: H2, diff: file("c.txt") },
      ] }],
    }));
    const notes = qa(".cdv-file-note").map((n) => n.textContent);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("combined.fallbackBetween:c.txt");
    expect(notes[0]).toContain("combined.tooLarge");
  });

  it("the close button emits close", async () => {
    const { emitted } = await mount(combined());
    q(".cmb-close")!.click();
    expect(emitted.close).toHaveLength(1);
  });
  it("the commit dots resolve their colour: the palette is defined on the view itself (both themes)", async () => {
    await mount(combined({
      fallback: [{ path: "c.txt", conflicted: false, blockers: [], perCommit: [{ hash: H2, diff: file("c.txt") }] }],
    }));
    expect(q(".cmb")!.classList.contains("combined-palette")).toBe(true);
    expect(q(".commit-diff-viewer")!.classList.contains("combined-palette")).toBe(true);
    expect(qa(".cmb-chip .cmb-chip-dot").map((d) => d.style.background)).toEqual([
      "var(--combined-c0)", "var(--combined-c1)", "var(--combined-c2)",
    ]);
    expect(q(".cmb-file .cmb-chip-dot")!.style.background).toBe("var(--combined-c1)");
    const block = (selector: string) => {
      const at = paletteCss.indexOf(`${selector} {`);
      expect(at, selector).toBeGreaterThanOrEqual(0);
      return paletteCss.slice(at, paletteCss.indexOf("}", at));
    };
    for (const sel of [".combined-palette", '[data-theme="light"] .combined-palette']) {
      const body = block(sel);
      for (let i = 0; i < 8; i++) expect(body).toMatch(new RegExp(`--combined-c${i}:\\s*#[0-9a-f]{6};`));
    }
  });

  it("counts +/- on the net diff only and the commit-by-commit files apart", async () => {
    await mount(combined({
      diffs: [file("a.txt", [add(1), add(2)])],
      fallback: [{ path: "c.txt", conflicted: true, blockers: [], perCommit: [
        { hash: H1, diff: file("c.txt", [add(1)]) }, { hash: H3, diff: file("c.txt", [add(1)]) },
      ] }],
    }));
    expect(q(".cmb-add")!.textContent).toBe("+2");
    expect(q(".cmb-percommit")!.textContent).toBe("combined.perCommitCount:1");
  });

  it("no commit-by-commit count and no summary line without fallback", async () => {
    await mount(combined());
    expect(q(".cmb-percommit")).toBeNull();
    expect(q(".cmb-fallback")).toBeNull();
  });

  it("sums up the fallback under the header with the distinct blockers", async () => {
    await mount(combined({
      fallback: [
        { path: "c.txt", conflicted: true, blockers: [H2], perCommit: [{ hash: H1, diff: file("c.txt") }] },
        { path: "d.txt", conflicted: true, blockers: [H2, "4".repeat(40)], perCommit: [{ hash: H3, diff: file("d.txt") }] },
        { path: "e.txt", conflicted: false, blockers: [], perCommit: [{ hash: H3, diff: file("e.txt") }] },
      ],
    }));
    expect(q(".cmb-fallback")!.textContent).toBe("combined.fallbackSummary:3 header.files,2222222, 4444444");
  });

  it("the fallback summary says between-selected without blockers, and other for companions only", async () => {
    await mount(combined({
      fallback: [{ path: "c.txt", conflicted: true, blockers: [], perCommit: [{ hash: H1, diff: file("c.txt") }] }],
    }));
    expect(q(".cmb-fallback")!.textContent).toBe("combined.fallbackSummaryBetween:1 header.file");
    app?.unmount();
    container?.remove();
    await mount(combined({
      fallback: [{ path: "u.txt", conflicted: false, blockers: [], perCommit: [{ hash: H1, diff: file("u.txt") }] }],
    }));
    expect(q(".cmb-fallback")!.textContent).toBe("combined.fallbackSummaryOther:1 header.file");
  });
});
