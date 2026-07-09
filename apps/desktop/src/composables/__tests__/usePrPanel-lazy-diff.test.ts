/**
 * Task A1 (v3.6.0) — lazy per-file diff parse. `getPRDiff` stays a single
 * fetch, but the raw unified diff is only *indexed* (cheap) up front; the
 * expensive hunk/line parse runs once per file, only when selected.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";

vi.mock("@/utils/backend", async () => {
  const actual = await vi.importActual<typeof import("@/utils/backend")>("@/utils/backend");
  return {
    ...actual,
    gitFileCount: vi.fn(async () => 0),
    gitRemoteInfo: vi.fn(async () => ({ url: "", host: "github.com", owner: "o", repo: "r" })),
    ghForkInfo: vi.fn(async () => ({ isFork: false, origin: "", parent: "" })),
    ghPrDiff: vi.fn(),
  };
});

import { ghPrDiff } from "@/utils/backend";
import { indexDiffFiles, parseFileDiff, parseUnifiedDiff, usePrPanel } from "../usePrPanel";

const THREE_FILE_DIFF = [
  "diff --git a/a.ts b/a.ts",
  "index 111..222 100644",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,2 +1,2 @@",
  " context a",
  "-old a",
  "+new a",
  "diff --git a/b.ts b/b.ts",
  "index 333..444 100644",
  "--- a/b.ts",
  "+++ b/b.ts",
  "@@ -1,3 +1,3 @@",
  " context b",
  "",
  "-old b",
  "+new b",
  "diff --git a/c.ts b/c.ts",
  "index 555..666 100644",
  "--- a/c.ts",
  "+++ b/c.ts",
  "@@ -1,1 +1,1 @@",
  "-old c",
  "+new c",
].join("\n");

describe("indexDiffFiles", () => {
  it("splits a raw multi-file diff into per-file slices with correct b/ paths", () => {
    const slices = indexDiffFiles(THREE_FILE_DIFF);
    expect(slices.map((s) => s.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
    for (const s of slices) {
      expect(s.raw.startsWith(`diff --git a/${s.path} b/${s.path}`)).toBe(true);
    }
  });

  it("returns [] for an empty diff", () => {
    expect(indexDiffFiles("")).toEqual([]);
    expect(indexDiffFiles("   ")).toEqual([]);
  });
});

describe("parseFileDiff", () => {
  it("matches parseUnifiedDiff's per-file output (regression parity)", () => {
    const expected = parseUnifiedDiff(THREE_FILE_DIFF);
    const slices = indexDiffFiles(THREE_FILE_DIFF);
    const actual = slices.map((s) => parseFileDiff(s.raw));
    expect(actual).toEqual(expected);
  });

  it("classifies an empty-string context line as context, not add/delete", () => {
    const slice = indexDiffFiles(THREE_FILE_DIFF)[1]; // b.ts has a blank context line
    const parsed = parseFileDiff(slice.raw);
    const blank = parsed.hunks[0].lines.find((l) => l.content === "" && l.type !== undefined);
    expect(blank?.type).toBe("context");
  });
});

describe("usePrPanel — lazy diff parse wiring", () => {
  beforeEach(() => {
    vi.mocked(ghPrDiff).mockReset();
  });

  it("after loadDiff, only the first file has hunks; others are shells", async () => {
    vi.mocked(ghPrDiff).mockResolvedValue(THREE_FILE_DIFF);
    const cwd = ref("/repo");
    const p = usePrPanel(cwd);
    (p as any).selectedPr.value = { number: 1 } as any;
    await (p as any).loadDiff();

    const files = p.prDiffFiles.value;
    expect(files.map((f) => f.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(files[0].hunks.length).toBeGreaterThan(0);
    expect(files[1].hunks).toEqual([]);
    expect(files[2].hunks).toEqual([]);
  });

  it("selecting a second file parses it exactly once", async () => {
    vi.mocked(ghPrDiff).mockResolvedValue(THREE_FILE_DIFF);
    const cwd = ref("/repo");
    const p = usePrPanel(cwd);
    (p as any).selectedPr.value = { number: 1 } as any;
    await (p as any).loadDiff();

    p.selectedDiffFile.value = "b.ts";
    await Promise.resolve();
    const parsedOnce = p.prDiffFiles.value.find((f) => f.path === "b.ts");
    expect(parsedOnce?.hunks.length).toBeGreaterThan(0);

    // Re-selecting must not re-parse (identity of the hunks array is stable).
    const hunksRef = parsedOnce?.hunks;
    p.selectedDiffFile.value = "a.ts";
    await Promise.resolve();
    p.selectedDiffFile.value = "b.ts";
    await Promise.resolve();
    const again = p.prDiffFiles.value.find((f) => f.path === "b.ts");
    expect(again?.hunks).toBe(hunksRef);
  });
});
