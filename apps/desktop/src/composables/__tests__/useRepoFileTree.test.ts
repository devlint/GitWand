import { describe, it, expect, vi } from "vitest";
import { ref } from "vue";

vi.mock("@/utils/backend", () => ({
  listRepoTree: vi.fn(async () => ({
    root: {
      path: "",
      name: "",
      kind: "folder",
      children: [
        {
          path: "src",
          name: "src",
          kind: "folder",
          children: [
            { path: "src/main.ts", name: "main.ts", kind: "file", children: [] },
            { path: "src/util.ts", name: "util.ts", kind: "file", children: [] },
          ],
        },
        { path: "README.md", name: "README.md", kind: "file", children: [] },
      ],
    },
    truncated: false,
  })),
}));

import { listRepoTree } from "@/utils/backend";
import { useRepoFileTree } from "../useRepoFileTree";

describe("useRepoFileTree", () => {
  it("all folders are collapsed by default and rolls up folder counts", async () => {
    const repoPath = ref("/repo");
    const changedFiles = ref([]);
    const tree = useRepoFileTree(repoPath, changedFiles);

    await tree.refresh();

    expect(listRepoTree).toHaveBeenCalledWith("/repo");
    expect(tree.isCollapsed("src")).toBe(true);
    expect(tree.rows.value.map((r) => [r.kind, r.path, r.depth])).toEqual([
      ["folder", "src", 0],
      ["file", "README.md", 0],
    ]);
    expect(tree.rows.value[0].count).toBe(2);
  });

  it("toggling a collapsed folder reveals its descendants", async () => {
    const repoPath = ref("/repo");
    const changedFiles = ref([]);
    const tree = useRepoFileTree(repoPath, changedFiles);
    await tree.refresh();

    tree.toggleFolder("src");

    expect(tree.isCollapsed("src")).toBe(false);
    expect(tree.rows.value.map((r) => [r.kind, r.path, r.depth])).toEqual([
      ["folder", "src", 0],
      ["file", "src/main.ts", 1],
      ["file", "src/util.ts", 1],
      ["file", "README.md", 0],
    ]);
  });

  it("toggling an expanded folder collapses it again", async () => {
    const repoPath = ref("/repo");
    const changedFiles = ref([]);
    const tree = useRepoFileTree(repoPath, changedFiles);
    await tree.refresh();

    tree.toggleFolder("src"); // expand
    tree.toggleFolder("src"); // collapse again

    expect(tree.isCollapsed("src")).toBe(true);
    expect(tree.rows.value.map((r) => r.path)).toEqual(["src", "README.md"]);
  });

  it("exposes a status lookup keyed by path", async () => {
    const repoPath = ref("/repo");
    const changedFiles = ref([{ path: "src/main.ts", status: "modified", section: "unstaged" }] as any);
    const tree = useRepoFileTree(repoPath, changedFiles);
    await tree.refresh();

    expect(tree.statusByPath.value.get("src/main.ts")).toBe("modified");
    expect(tree.statusByPath.value.get("README.md")).toBeUndefined();
  });
});
