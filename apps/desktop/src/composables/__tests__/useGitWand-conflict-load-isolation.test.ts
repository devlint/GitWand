/**
 * A conflicted file the app cannot read must not take the whole merge editor
 * down with it.
 *
 * `loadRealFiles` reads every unmerged path inside one `Promise.all`, and
 * `read_file` on the Rust side is `std::fs::read_to_string`, which rejects any
 * file that is not valid UTF-8 (a minified build artifact, a Latin-1 source
 * file). One rejection therefore rejects the whole batch, `openPath` catches
 * it and calls `loadDemoData()`, and the merge editor ends up holding *demo*
 * paths. `App.vue` renders `MergeEditor` only on
 * `showingMergeEditor && mergeSelectedFile`, so the real conflicted path is no
 * longer in `files`, the lookup returns null, and the view silently falls
 * through to the read-only `DiffViewer`: the sidebar lists N conflicts that
 * the user cannot open.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { readFileMock, CONFLICTED } = vi.hoisted(() => {
  /** A perfectly ordinary content conflict, the kind the engine handles daily. */
  const CONFLICTED = [
    "<?php",
    "return [",
    "<<<<<<< HEAD",
    "  'last_update' => '2026-09-09 12:22:00',",
    "=======",
    "  'last_update' => '2026-09-09 07:29:00',",
    ">>>>>>> origin/master",
    "];",
  ].join("\n");
  return {
    CONFLICTED,
    readFileMock: vi.fn(async (_cwd: string, path: string) => {
      if (path === "public/build/bundle.js") {
        throw new Error(
          "Failed to read public/build/bundle.js: stream did not contain valid UTF-8",
        );
      }
      return CONFLICTED;
    }),
  };
});

vi.mock("@/utils/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/backend")>();
  return {
    ...actual,
    pickFolder: vi.fn(),
    getConflictedFiles: vi.fn(async () => ["config/dendreo.php", "public/build/bundle.js"]),
    readFile: readFileMock,
    writeFile: vi.fn(),
    readGitwandrc: vi.fn(async () => ""),
    getTreeConflicts: vi.fn(async () => []),
    reconstructConflict: vi.fn(async () => {
      throw new Error("no recoverable stage");
    }),
    gitRepoState: vi.fn(async () => ({ state: "rebase", targetBranch: "feat/x" })),
    resolveTreeConflict: vi.fn(),
    gitStage: vi.fn(),
  };
});

vi.mock("../../utils/coreEngine", () => ({
  engine: async () => {
    const core = await import("@gitwand/core");
    return {
      resolve: (c: string, p: string, o?: unknown) => core.resolve(c, p, o as never),
      resolveAsync: (c: string, p: string, o?: unknown) => core.resolveAsync(c, p, o as never),
      parseConflictMarkers: (c: string) => core.parseConflictMarkers(c),
    };
  },
}));

import { useGitWand } from "../useGitWand";

describe("loadRealFiles: one unreadable conflicted file", () => {
  beforeEach(() => {
    readFileMock.mockClear();
  });

  it("still exposes the conflicted files it COULD read", async () => {
    const gw = useGitWand();
    await gw.openPath("/repo");

    const paths = gw.files.value.map((f) => f.path);
    expect(paths).toContain("config/dendreo.php");
  });

  it("never swaps a real repo's conflicts for demo data", async () => {
    const gw = useGitWand();
    await gw.openPath("/repo");

    const paths = gw.files.value.map((f) => f.path);
    // `loadDemoData()` seeds these fabricated paths. Showing them for a real
    // repo is worse than showing nothing: they are not the user's files.
    expect(paths).not.toContain("src/components/Header.tsx");
  });

  it("keeps the unreadable file in the list, so the editor matches git's count", async () => {
    const gw = useGitWand();
    await gw.openPath("/repo");

    // Dropping it would desync the sidebar ("4 conflicts") from what the editor
    // can open, and git will not let the rebase continue until it is settled.
    const bad = gw.files.value.find((f) => f.path === "public/build/bundle.js");
    expect(bad).toBeDefined();
    expect(bad?.loadError).toMatch(/valid UTF-8/);
  });

  it("keeps the readable file free of any load error", async () => {
    const gw = useGitWand();
    await gw.openPath("/repo");

    const ok = gw.files.value.find((f) => f.path === "config/dendreo.php");
    expect(ok?.loadError).toBeUndefined();
  });

  it("keeps the readable file selectable, which is what gates the MergeEditor", async () => {
    const gw = useGitWand();
    await gw.openPath("/repo");
    gw.selectFile("config/dendreo.php");

    // App.vue renders MergeEditor on `showingMergeEditor && mergeSelectedFile`.
    // A null here is exactly the silent fall-through to the read-only DiffViewer.
    expect(gw.selectedFile.value).not.toBeNull();
    expect(gw.selectedFile.value?.result.stats.totalConflicts).toBeGreaterThan(0);
  });
});
