// @vitest-environment jsdom
/**
 * CommitDiffViewer.vue — combined-diff attribution (v3.15): gutter markers,
 * per-hunk commit chips, fallback-section chip and per-file notes, all driven
 * by optional props. Without them the viewer is unchanged.
 */
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { createApp, h, nextTick, ref, type App } from "vue";
import CommitDiffViewer from "../CommitDiffViewer.vue";
import type { CombinedDiff, DiffLine, GitDiff } from "../../utils/backend";
import { buildCombinedEntries, type FileAttribution } from "../../utils/combinedAttribution";
import { commitColor } from "../../utils/commitColors";

vi.mock("../../composables/useI18n", () => ({
  useI18n: () => ({
    t: (key: string, ...args: unknown[]) => (args.length ? `${key}:${args.join(",")}` : key),
    locale: ref("en"),
  }),
}));

beforeAll(() => {
  (globalThis as any).IntersectionObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const DIFFS: GitDiff[] = [
  {
    path: "src/a.ts",
    hunks: [
      {
        header: "@@ -1,3 +1,3 @@",
        oldStart: 1, oldCount: 3, newStart: 1, newCount: 3,
        lines: [
          { type: "context", content: "a", oldLineNo: 1, newLineNo: 1 },
          { type: "delete", content: "b", oldLineNo: 2 },
          { type: "add", content: "B", newLineNo: 2 },
          { type: "context", content: "c", oldLineNo: 3, newLineNo: 3 },
        ],
      },
    ],
  } as unknown as GitDiff,
  {
    path: "src/b.ts",
    hunks: [
      {
        header: "@@ -0,0 +1,1 @@",
        oldStart: 0, oldCount: 0, newStart: 1, newCount: 1,
        lines: [{ type: "add", content: "x", newLineNo: 1 }],
      },
    ],
  } as unknown as GitDiff,
];

const H0 = "a".repeat(40);
const H1 = "b".repeat(40);
const COMMITS = [
  { hash: H0, shortHash: "aaaaaaa", subject: "first change" },
  { hash: H1, shortHash: "bbbbbbb", subject: "second change" },
];
const ATTR: FileAttribution[] = [
  { lineCommit: new Map([["RIGHT:2", 1], ["LEFT:2", 0]]), hunkCommits: [[0, 1]] },
  { lineCommit: new Map(), hunkCommits: [[1]], sectionCommit: 1 },
];

let app: App | null = null;
let container: HTMLElement | null = null;
const jumps: string[] = [];

afterEach(() => {
  app?.unmount();
  app = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
  jumps.length = 0;
});

function mount(extra: Record<string, unknown> = {}, diffMode: "inline" | "side-by-side" = "inline") {
  container = document.createElement("div");
  document.body.appendChild(container);
  app = createApp({
    setup: () => () =>
      h(CommitDiffViewer as any, {
        diffs: DIFFS,
        commitHash: "x",
        commitInfo: null,
        diffMode,
        ...extra,
        "onJump-to-commit": (hash: string) => jumps.push(hash),
      }),
  });
  app.mount(container);
}

const FULL = { attribution: ATTR, attributionCommits: COMMITS, fileNotes: ["note for a", null] };

describe("CommitDiffViewer — attribution", () => {
  it("renders nothing extra without the new props (4 cells per inline row)", async () => {
    mount();
    await nextTick();
    expect(document.querySelector(".cdv-attr-marker")).toBeNull();
    expect(document.querySelector(".cdv-attr-chip")).toBeNull();
    expect(document.querySelector(".cdv-file-note")).toBeNull();
    for (const row of document.querySelectorAll("tr.cdv-line")) expect(row.querySelectorAll("td").length).toBe(4);
  });

  it("marks an attributed line with its commit colour and a hash + subject title", async () => {
    mount(FULL);
    await nextTick();
    const rows = document.querySelectorAll(".cdv-hunk")[0].querySelectorAll("tr.cdv-line");
    const add = rows[2].querySelector<HTMLElement>(".cdv-attr-marker")!;
    expect(add.getAttribute("style")).toContain("var(--combined-c1)");
    expect(add.getAttribute("title")).toContain("bbbbbbb");
    expect(add.getAttribute("title")).toContain("second change");
    const del = rows[1].querySelector<HTMLElement>(".cdv-attr-marker")!;
    expect(del.getAttribute("style")).toContain("var(--combined-c0)");
    expect(rows[2].querySelectorAll("td").length).toBe(5);
    // Unattributed context line: marker cell kept (alignment), but no colour.
    expect(rows[0].querySelector<HTMLElement>(".cdv-attr-marker")!.getAttribute("style") ?? "").not.toContain("--combined-c");
  });

  it("shows one chip per hunk commit; clicking emits the full hash", async () => {
    mount(FULL);
    await nextTick();
    const chips = document.querySelectorAll(".cdv-hunk")[0].querySelectorAll<HTMLButtonElement>(".cdv-hunk-header .cdv-attr-chip");
    expect(chips.length).toBe(2);
    expect(chips[0].getAttribute("aria-label")).toBe(`combined.jumpToCommit:aaaaaaa`);
    chips[1].click();
    expect(jumps).toEqual([H1]);
  });

  it("past 8 commits a colour repeats, but the marker title and the hunk chip name the short hash", async () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({ hash: String(i).repeat(40), shortHash: `${i}`.repeat(7), subject: `s${i}` }));
    const attr: FileAttribution[] = [
      { lineCommit: new Map([["RIGHT:2", 8], ["LEFT:2", 0]]), hunkCommits: [[0, 8]] },
      { lineCommit: new Map(), hunkCommits: [[]] },
    ];
    mount({ attribution: attr, attributionCommits: nine });
    await nextTick();
    const rows = document.querySelectorAll(".cdv-hunk")[0].querySelectorAll("tr.cdv-line");
    const ninth = rows[2].querySelector<HTMLElement>(".cdv-attr-marker")!;
    const first = rows[1].querySelector<HTMLElement>(".cdv-attr-marker")!;
    expect(ninth.getAttribute("style")).toContain("var(--combined-c0)");
    expect(first.getAttribute("style")).toContain("var(--combined-c0)");
    expect(ninth.getAttribute("title")).toContain("8888888");
    expect(first.getAttribute("title")).toContain("0000000");
    const chips = document.querySelectorAll(".cdv-hunk")[0].querySelectorAll<HTMLElement>(".cdv-hunk-header .cdv-attr-chip");
    expect([...chips].map((c) => c.textContent?.trim())).toEqual(["0000000", "8888888"]);
  });

  it("shows the section commit chip on a fallback file header", async () => {
    mount(FULL);
    await nextTick();
    const header = document.querySelectorAll(".cdv-file-header")[1];
    const chip = header.querySelector<HTMLButtonElement>(".cdv-attr-chip")!;
    expect(chip.textContent).toContain("bbbbbbb");
    expect(document.querySelectorAll(".cdv-file-header")[0].querySelector(".cdv-attr-chip")).toBeNull();
    chip.click();
    expect(jumps).toEqual([H1]);
  });

  it("renders a file note under its header only", async () => {
    mount(FULL);
    await nextTick();
    const notes = document.querySelectorAll(".cdv-file-note");
    expect(notes.length).toBe(1);
    expect(notes[0].textContent).toContain("note for a");
    expect(notes[0].previousElementSibling?.classList.contains("cdv-file-header")).toBe(true);
  });

  it("puts the marker in td.cdv-sbs-gutter in side-by-side mode", async () => {
    mount(FULL, "side-by-side");
    await nextTick();
    const rows = document.querySelectorAll(".cdv-hunk")[0].querySelectorAll("tr.cdv-line");
    // A paired delete/add: both commits, the deletion's on the left half.
    const markers = rows[1].querySelectorAll<HTMLElement>("td.cdv-sbs-gutter .cdv-attr-marker");
    expect(markers.length).toBe(2);
    expect(markers[0].classList.contains("cdv-attr-marker--old")).toBe(true);
    expect(markers[0].getAttribute("style")).toContain("var(--combined-c0)");
    expect(markers[0].getAttribute("title")).toContain("aaaaaaa");
    expect(markers[1].classList.contains("cdv-attr-marker--new")).toBe(true);
    expect(markers[1].getAttribute("style")).toContain("var(--combined-c1)");
    expect(markers[1].getAttribute("title")).toContain("bbbbbbb");
    expect(rows[1].querySelectorAll("td").length).toBe(7);
    // A context pair keeps one (uncoloured) marker.
    const ctx = rows[0].querySelectorAll<HTMLElement>("td.cdv-sbs-gutter .cdv-attr-marker");
    expect(ctx.length).toBe(1);
    expect(ctx[0].getAttribute("style") ?? "").not.toContain("--combined-c");
  });

  it("side-by-side: an unpaired deletion or addition gets the whole gutter", async () => {
    const diffs: GitDiff[] = [{
      path: "src/c.ts",
      hunks: [{
        header: "@@ -1,2 +1,2 @@", oldStart: 1, oldCount: 2, newStart: 1, newCount: 2,
        lines: [
          { type: "delete", content: "gone", oldLineNo: 1 },
          { type: "context", content: "k", oldLineNo: 2, newLineNo: 1 },
          { type: "add", content: "new", newLineNo: 2 },
        ],
      }],
    } as unknown as GitDiff];
    const attr: FileAttribution[] = [{ lineCommit: new Map([["LEFT:1", 0], ["RIGHT:2", 1]]), hunkCommits: [[0, 1]] }];
    mount({ diffs, attribution: attr, attributionCommits: COMMITS }, "side-by-side");
    await nextTick();
    const rows = document.querySelectorAll(".cdv-hunk")[0].querySelectorAll("tr.cdv-line");
    const markersOf = (i: number) => [...rows[i].querySelectorAll<HTMLElement>("td.cdv-sbs-gutter .cdv-attr-marker")];
    const del = markersOf(0);
    expect(del.length).toBe(1);
    expect(del[0].classList.contains("cdv-attr-marker--old")).toBe(true);
    expect(del[0].getAttribute("style")).toContain("var(--combined-c0)");
    const add = markersOf(rows.length - 1);
    expect(add.length).toBe(1);
    expect(add[0].getAttribute("style")).toContain("var(--combined-c1)");
  });

  // QA: a fallback section's deleted lines, and a net deletion attributed
  // through the replay's `deletedBy`, carry their commit's marker like the
  // added ones — inline on the row, side by side on the gutter's left half.
  // Payload shaped like the backend's (nulls on the absent side).
  const fbSection = (hash: string, lines: DiffLine[]): GitDiff => ({
    path: "f",
    hunks: [{ header: "@@ -1,4 +1,3 @@", oldStart: 1, oldCount: 4, newStart: 1, newCount: 3, lines }],
  });
  const C = (n: number, content: string): DiffLine => ({ type: "context", content, oldLineNo: n, newLineNo: n });
  const D = (n: number, content: string): DiffLine => ({ type: "delete", content, oldLineNo: n, newLineNo: null } as unknown as DiffLine);
  const A = (n: number, content: string): DiffLine => ({ type: "add", content, oldLineNo: null, newLineNo: n } as unknown as DiffLine);
  const COMBINED: CombinedDiff = {
    base: "base",
    commits: COMMITS.map((c) => ({ ...c, author: "t", date: "d" })),
    diffs: [{
      path: "g",
      hunks: [{ header: "@@ -2,1 +1,0 @@", oldStart: 2, oldCount: 1, newStart: 1, newCount: 0, lines: [D(2, "gone")] }],
    }],
    steps: [[], [{ path: "g", hunks: [{ header: "@@ -2,1 +1,0 @@", oldStart: 2, oldCount: 1, newStart: 1, newCount: 0, lines: [D(2, "gone")] }] }]],
    fallback: [{
      path: "f",
      conflicted: true,
      blockers: [],
      perCommit: [{ hash: H1, diff: fbSection(H1, [C(1, "a"), D(2, "B2"), A(2, "B3"), C(3, "c"), D(4, "d")]) }],
    }],
    truncated: false,
    budgetOmitted: [],
  } as unknown as CombinedDiff;
  const fromEntries = () => {
    const entries = buildCombinedEntries(COMBINED);
    return { diffs: entries.map((e) => e.diff), attribution: entries.map((e) => e.attribution), attributionCommits: COMMITS };
  };

  it("inline: a net deletion and a fallback section's deletions show their commit's marker", async () => {
    mount(fromEntries());
    await nextTick();
    const hunks = document.querySelectorAll(".cdv-hunk");
    const marker = (hunk: Element, row: number) =>
      hunk.querySelectorAll("tr.cdv-line")[row].querySelector<HTMLElement>(".cdv-attr-marker")!;
    // Net view: `gone` was deleted by commit 1 (deletedBy).
    expect(marker(hunks[0], 0).getAttribute("style")).toContain("var(--combined-c1)");
    expect(marker(hunks[0], 0).getAttribute("title")).toContain("bbbbbbb");
    // Fallback section of commit 1: both its deletions and its addition.
    for (const row of [1, 2, 4]) expect(marker(hunks[1], row).getAttribute("style")).toContain("var(--combined-c1)");
    expect(marker(hunks[1], 0).getAttribute("style") ?? "").not.toContain("--combined-c");
  });

  it("side-by-side: the deletions of a fallback section and of the net view mark the gutter's left half", async () => {
    mount(fromEntries(), "side-by-side");
    await nextTick();
    const hunks = document.querySelectorAll(".cdv-hunk");
    const markers = (hunk: Element, row: number) =>
      [...hunk.querySelectorAll("tr.cdv-line")[row].querySelectorAll<HTMLElement>("td.cdv-sbs-gutter .cdv-attr-marker")];
    const net = markers(hunks[0], 0);
    expect(net.length).toBe(1);
    expect(net[0].classList.contains("cdv-attr-marker--old")).toBe(true);
    expect(net[0].getAttribute("style")).toContain("var(--combined-c1)");
    // Row 1 pairs B2 / B3; row 3 is the unpaired deletion of `d`.
    const paired = markers(hunks[1], 1);
    expect(paired.map((m) => m.classList.contains("cdv-attr-marker--old"))).toEqual([true, false]);
    for (const m of paired) expect(m.getAttribute("style")).toContain("var(--combined-c1)");
    const lone = markers(hunks[1], 3);
    expect(lone.length).toBe(1);
    expect(lone[0].classList.contains("cdv-attr-marker--old")).toBe(true);
    expect(lone[0].getAttribute("style")).toContain("var(--combined-c1)");
  });

  it("commitColor cycles through 8 variables", () => {
    expect(commitColor(0)).toBe("var(--combined-c0)");
    expect(commitColor(9)).toBe("var(--combined-c1)");
  });
});
