/**
 * useRepoFileTree — fetches the full repo file tree via the `listRepoTree`
 * Tauri command and flattens it into render-ready rows for the File
 * Explorer panel, plus a status-badge lookup keyed by path.
 */
import { ref, computed, type Ref } from "vue";
import { listRepoTree, type RepoTreeNode } from "@/utils/backend";
import type { TreeRow } from "./useFileTree";
import type { RepoFileEntry } from "./useGitRepo";

export function useRepoFileTree(repoPath: Ref<string>, changedFiles: Ref<RepoFileEntry[]>) {
  const root = ref<RepoTreeNode | null>(null);
  const truncated = ref(false);
  const collapsedFolders = ref<Record<string, boolean>>({});

  async function refresh(): Promise<void> {
    const result = await listRepoTree(repoPath.value);
    root.value = result.root;
    truncated.value = result.truncated;
  }

  function toggleFolder(path: string) {
    // Negate the *effective* state (via isCollapsed), not the raw stored
    // flag — collapsedFolders only ever holds explicit overrides, so an
    // untouched path is `undefined`. Negating `undefined` directly would
    // always produce `true`, making the very first toggle on any
    // never-touched folder a no-op once isCollapsed defaults missing
    // entries to collapsed (`true`).
    collapsedFolders.value[path] = !isCollapsed(path);
  }

  function isCollapsed(path: string): boolean {
    return collapsedFolders.value[path] ?? true;
  }

  const statusByPath = computed(() => {
    const map = new Map<string, RepoFileEntry["status"]>();
    for (const f of changedFiles.value) map.set(f.path, f.status);
    return map;
  });

  // Folder counts depend only on the tree shape, not the collapse state, so
  // compute them in one walk when `root` changes rather than re-walking every
  // subtree on each expand/collapse (which made a single toggle O(N) over the
  // whole tree).
  const folderCounts = computed<Map<string, number>>(() => {
    const counts = new Map<string, number>();
    if (root.value) countFiles(root.value, counts);
    return counts;
  });

  const rows = computed<TreeRow[]>(() => {
    if (!root.value) return [];
    return flatten(root.value, isCollapsed, folderCounts.value);
  });

  return { rows, truncated, refresh, toggleFolder, isCollapsed, statusByPath };
}

/** Populate `counts` with the rolled-up file count for every folder path in one walk. */
function countFiles(node: RepoTreeNode, counts: Map<string, number>): number {
  let count = 0;
  for (const child of node.children) {
    count += child.kind === "file" ? 1 : countFiles(child, counts);
  }
  if (node.kind === "folder") counts.set(node.path, count);
  return count;
}

function flatten(
  node: RepoTreeNode,
  isCollapsed: (path: string) => boolean,
  counts: Map<string, number>,
  depth = 0,
  out: TreeRow[] = [],
): TreeRow[] {
  for (const child of node.children) {
    if (child.kind === "folder") {
      out.push({ kind: "folder", path: child.path, name: child.name, depth, count: counts.get(child.path) ?? 0 });
      if (!isCollapsed(child.path)) {
        flatten(child, isCollapsed, counts, depth + 1, out);
      }
    } else {
      out.push({ kind: "file", path: child.path, name: child.name, depth });
    }
  }
  return out;
}
