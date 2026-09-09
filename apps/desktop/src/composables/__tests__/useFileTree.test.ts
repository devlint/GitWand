import { describe, it, expect } from "vitest";
import { buildFileTree, flattenTree, leafName, parentDir } from "../useFileTree";
import type { RepoFileEntry } from "../useGitRepo";

function file(path: string): RepoFileEntry {
  return { path, status: "modified", section: "unstaged" };
}

const never = () => false;

describe("buildFileTree / flattenTree", () => {
  it("nests files under their folders and rolls up counts", () => {
    const root = buildFileTree([
      file("src/a.ts"),
      file("src/components/B.vue"),
      file("README.md"),
    ]);

    const rows = flattenTree(root, never);
    // Folders before files; folders sorted by name.
    expect(rows.map((r) => `${r.kind}:${r.name}:${r.depth}`)).toEqual([
      "folder:src:0",
      "folder:components:1",
      "file:B.vue:2",
      "file:a.ts:1",
      "file:README.md:0",
    ]);

    const srcFolder = rows.find((r) => r.kind === "folder" && r.path === "src");
    expect(srcFolder?.count).toBe(2);
  });

  it("hides descendants of a collapsed folder", () => {
    const root = buildFileTree([file("src/a.ts"), file("src/b.ts")]);
    const rows = flattenTree(root, (p) => p === "src");
    expect(rows.map((r) => r.name)).toEqual(["src"]);
  });

  it("treats trailing-slash entries (untracked dirs) as a single leaf", () => {
    const root = buildFileTree([file("dist/"), file("logs/nested/")]);
    const rows = flattenTree(root, never);
    expect(rows.map((r) => `${r.kind}:${r.name}`)).toEqual([
      "folder:logs",
      "file:nested/",
      "file:dist/",
    ]);
  });

  it("uses folder paths as unique cumulative keys", () => {
    const root = buildFileTree([file("a/b/c.ts")]);
    const rows = flattenTree(root, never);
    expect(rows.filter((r) => r.kind === "folder").map((r) => r.path)).toEqual([
      "a",
      "a/b",
    ]);
  });

  it("labels a trailing-slash entry with its directory name, not an empty string", () => {
    // With `--untracked-files=all` the only remaining trailing-slash entries
    // are untracked *nested git repos*, which git never expands. The flat
    // list layout used to render them with a blank name (issue #181):
    // "nestedrepo/".split("/").pop() === "".
    expect(leafName("nestedrepo/")).toBe("nestedrepo/");
    expect(parentDir("nestedrepo/")).toBe("");
    expect(leafName("libs/nestedrepo/")).toBe("nestedrepo/");
    expect(parentDir("libs/nestedrepo/")).toBe("libs/");
    // Plain files are unaffected.
    expect(leafName("src/a.ts")).toBe("a.ts");
    expect(parentDir("src/a.ts")).toBe("src/");
    expect(parentDir("README.md")).toBe("");
  });

  it("is generic over any PathLike entry (e.g. commit diffs)", () => {
    // Mirrors the history sidebar: entries carry a `path` plus extra fields
    // (here a diff `status`) that must survive on the file row via `row.file`.
    interface DiffLike {
      path: string;
      status: "added" | "modified" | "deleted";
    }
    const diff = (path: string, status: DiffLike["status"]): DiffLike => ({ path, status });

    const root = buildFileTree<DiffLike>([
      diff("src/a.ts", "modified"),
      diff("src/b.ts", "added"),
    ]);
    const rows = flattenTree(root, never);

    expect(rows.map((r) => `${r.kind}:${r.name}`)).toEqual([
      "folder:src",
      "file:a.ts",
      "file:b.ts",
    ]);
    // The underlying typed entry is preserved on file rows.
    const aRow = rows.find((r) => r.kind === "file" && r.name === "a.ts");
    expect(aRow?.file).toEqual({ path: "src/a.ts", status: "modified" });
  });
});
