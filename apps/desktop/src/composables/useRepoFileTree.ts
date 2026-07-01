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
  const loading = ref(false);
  const error = ref<string | null>(null);
  const collapsedFolders = ref<Record<string, boolean>>({});

  async function refresh(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const result = await listRepoTree(repoPath.value);
      root.value = result.root;
      truncated.value = result.truncated;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  function toggleFolder(path: string) {
    collapsedFolders.value[path] = !collapsedFolders.value[path];
  }

  function isCollapsed(path: string): boolean {
    return !!collapsedFolders.value[path];
  }

  const statusByPath = computed(() => {
    const map = new Map<string, RepoFileEntry["status"]>();
    for (const f of changedFiles.value) map.set(f.path, f.status);
    return map;
  });

  const rows = computed<TreeRow[]>(() => {
    if (!root.value) return [];
    return flatten(root.value, isCollapsed);
  });

  return { rows, truncated, loading, error, refresh, toggleFolder, isCollapsed, statusByPath };
}

function countFiles(node: RepoTreeNode): number {
  let count = 0;
  for (const child of node.children) {
    count += child.kind === "file" ? 1 : countFiles(child);
  }
  return count;
}

function flatten(
  node: RepoTreeNode,
  isCollapsed: (path: string) => boolean,
  depth = 0,
  out: TreeRow[] = [],
): TreeRow[] {
  for (const child of node.children) {
    if (child.kind === "folder") {
      out.push({ kind: "folder", path: child.path, name: child.name, depth, count: countFiles(child) });
      if (!isCollapsed(child.path)) {
        flatten(child, isCollapsed, depth + 1, out);
      }
    } else {
      out.push({ kind: "file", path: child.path, name: child.name, depth });
    }
  }
  return out;
}
