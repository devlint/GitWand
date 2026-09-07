/**
 * useFileTree — builds a nested folder tree from a flat list of changed files
 * and flattens it into render-ready rows for the changes sidebar.
 *
 * Used by RepoSidebar's "tree" layout, where each git section (staged,
 * unstaged, …) is rendered as a collapsible directory tree instead of a flat
 * file list. The flatten step mirrors FolderDiffTree's approach: a recursive
 * tree is projected into a single list of rows that respect the collapsed
 * state, keeping the template a simple `v-for` rather than a recursive
 * component.
 */
import type { RepoFileEntry } from "./useGitRepo";

/** Minimal shape the tree builder needs from an entry: just a path. */
export interface PathLike {
  path: string;
}

export interface TreeRow<T extends PathLike = RepoFileEntry> {
  kind: "folder" | "file";
  /** Folder rows: cumulative dir path (no trailing slash). File rows: the entry's full path. */
  path: string;
  /** Display segment (folder name, or file leaf — may keep a trailing "/" for untracked dirs). */
  name: string;
  /** Nesting depth (0 = section root). */
  depth: number;
  /** File rows only: the underlying entry. */
  file?: T;
  /** Folder rows only: rolled-up count of files under this folder. */
  count?: number;
}

interface FolderNode<T extends PathLike> {
  name: string;
  path: string;
  folders: Map<string, FolderNode<T>>;
  files: T[];
  count: number;
}

function newNode<T extends PathLike>(name: string, path: string): FolderNode<T> {
  return { name, path, folders: new Map(), files: [], count: 0 };
}

/**
 * The display leaf of a path. Untracked directory entries keep their trailing
 * "/": since `--untracked-files=all` (issue #181) those are only untracked
 * *nested git repos*, which git never expands.
 *
 * Exported because the sidebar's flat-list layout needs the same labels as the
 * tree layout: `"nestedrepo/".split("/").pop()` is the empty string, which used
 * to render as a nameless row.
 */
export function leafName(path: string): string {
  const segs = path.split("/").filter(Boolean);
  const leaf = segs[segs.length - 1] ?? path;
  return path.endsWith("/") ? `${leaf}/` : leaf;
}

/** The parent directory of a path, slash-terminated, or "" at the root. */
export function parentDir(path: string): string {
  const segs = path.split("/").filter(Boolean);
  return segs.length > 1 ? `${segs.slice(0, -1).join("/")}/` : "";
}

/** Build a nested folder tree from a flat list of entries. */
export function buildFileTree<T extends PathLike>(files: T[]): FolderNode<T> {
  const root = newNode<T>("", "");
  for (const f of files) {
    // The leaf (last non-empty segment) is the file; preceding segments are folders.
    // Trailing "/" entries (untracked dirs) collapse to a single leaf node.
    const segs = f.path.split("/").filter(Boolean);
    const folderSegs = segs.slice(0, -1);
    let node = root;
    let acc = "";
    for (const seg of folderSegs) {
      acc = acc ? `${acc}/${seg}` : seg;
      let child = node.folders.get(seg);
      if (!child) {
        child = newNode(seg, acc);
        node.folders.set(seg, child);
      }
      node = child;
    }
    node.files.push(f);
  }
  computeCount(root);
  return root;
}

function computeCount<T extends PathLike>(node: FolderNode<T>): number {
  let c = node.files.length;
  for (const child of node.folders.values()) c += computeCount(child);
  node.count = c;
  return c;
}

/**
 * Project the tree into a flat list of rows, depth-first. Folders are listed
 * before files at each level, both sorted by name. A folder for which
 * `isCollapsed(path)` returns true hides its descendants.
 */
export function flattenTree<T extends PathLike>(
  root: FolderNode<T>,
  isCollapsed: (folderPath: string) => boolean,
  depth = 0,
  out: TreeRow<T>[] = [],
): TreeRow<T>[] {
  const folders = [...root.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const folder of folders) {
    out.push({ kind: "folder", path: folder.path, name: folder.name, depth, count: folder.count });
    if (!isCollapsed(folder.path)) {
      flattenTree(folder, isCollapsed, depth + 1, out);
    }
  }
  const files = [...root.files].sort((a, b) => leafName(a.path).localeCompare(leafName(b.path)));
  for (const f of files) {
    out.push({ kind: "file", path: f.path, name: leafName(f.path), depth, file: f });
  }
  return out;
}
