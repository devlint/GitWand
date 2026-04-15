/**
 * Backend abstraction layer.
 *
 * Provides the same API whether running inside Tauri (native) or
 * in a browser with the dev server (Node HTTP on port 3001).
 *
 * No static import of @tauri-apps/* — we access Tauri internals
 * at runtime via window.__TAURI_INTERNALS__ to avoid Vite resolution errors.
 */

const DEV_SERVER = "http://localhost:3001";

/** Check if we're inside a Tauri webview. */
export function isTauri(): boolean {
  return !!(window as any).__TAURI_INTERNALS__;
}

/** Call a Tauri command via the invoke IPC bridge. */
async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const internals = (window as any).__TAURI_INTERNALS__;
  if (!internals?.invoke) {
    throw new Error("Tauri invoke not available");
  }
  return internals.invoke(cmd, args) as Promise<T>;
}

/** Open a native folder picker (Tauri only). */
async function tauriOpenFolder(): Promise<string | null> {
  const internals = (window as any).__TAURI_INTERNALS__;
  if (!internals?.invoke) return null;
  // The dialog plugin is registered as a Tauri plugin command
  try {
    const result = await internals.invoke("plugin:dialog|open", {
      options: { directory: true, multiple: false },
    });
    return result as string | null;
  } catch {
    return null;
  }
}

// ─── Folder picker callback ─────────────────────────────

/**
 * In browser mode, the UI layer (App.vue) registers a callback
 * that opens the FolderPicker modal and resolves with the selected path.
 * This avoids coupling backend.ts to any Vue component.
 */
let _browserFolderPicker: (() => Promise<string | null>) | null = null;

/** Register the browser folder picker (called once from App.vue). */
export function registerBrowserFolderPicker(
  fn: () => Promise<string | null>,
): void {
  _browserFolderPicker = fn;
}

// ─── Public API ──────────────────────────────────────────

/**
 * Pick a folder. Tauri: native dialog. Browser: FolderPicker modal.
 */
export async function pickFolder(_defaultPath?: string): Promise<string | null> {
  if (isTauri()) {
    return tauriOpenFolder();
  }
  if (_browserFolderPicker) {
    return _browserFolderPicker();
  }
  // Fallback if no picker registered (shouldn't happen in practice)
  return window.prompt(
    "Chemin du repo avec des conflits Git :",
    _defaultPath ?? "~/Documents/GitHub/Dendreo",
  );
}

/**
 * List conflicted files in a Git repository.
 */
export async function getConflictedFiles(cwd: string): Promise<string[]> {
  if (isTauri()) {
    return tauriInvoke<string[]>("get_conflicted_files", { cwd });
  }
  const res = await fetch(
    `${DEV_SERVER}/api/conflicted-files?cwd=${encodeURIComponent(cwd)}`,
  );
  if (!res.ok) throw new Error(`Dev server error: ${res.status}`);
  const data = await res.json();
  return data.files;
}

/**
 * Read a file's content.
 */
export async function readFile(cwd: string, path: string): Promise<string> {
  if (isTauri()) {
    return tauriInvoke<string>("read_file", { path: `${cwd}/${path}` });
  }
  const res = await fetch(`${DEV_SERVER}/api/read-file`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, path }),
  });
  if (!res.ok) throw new Error(`Failed to read ${path}`);
  const data = await res.json();
  return data.content;
}

/**
 * Write a file's content back to disk.
 */
export async function writeFile(
  cwd: string,
  path: string,
  content: string,
): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("write_file", { path: `${cwd}/${path}`, content });
    return;
  }
  const res = await fetch(`${DEV_SERVER}/api/write-file`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, path, content }),
  });
  if (!res.ok) throw new Error(`Failed to write ${path}`);
}

// ─── Directory listing (for FolderPicker) ────────────────

export interface DirEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
}

export interface ListDirResult {
  current: string;
  parent: string | null;
  home: string;
  dirs: DirEntry[];
}

/**
 * List directories in a given path. Used by FolderPicker.
 */
export async function listDir(dirPath?: string): Promise<ListDirResult> {
  if (isTauri()) {
    const raw = await tauriInvoke<{
      current: string;
      parent: string | null;
      home: string;
      dirs: Array<{ name: string; path: string; is_git_repo: boolean }>;
    }>("list_dir", { path: dirPath ?? null });
    // Map snake_case from Rust to camelCase
    return {
      current: raw.current,
      parent: raw.parent,
      home: raw.home,
      dirs: raw.dirs.map((d) => ({
        name: d.name,
        path: d.path,
        isGitRepo: d.is_git_repo,
      })),
    };
  }
  const qs = dirPath ? `?path=${encodeURIComponent(dirPath)}` : "";
  const res = await fetch(`${DEV_SERVER}/api/list-dir${qs}`);
  if (!res.ok) throw new Error(`Failed to list directory: ${res.status}`);
  return res.json();
}

// ─── Git status ────────────────────────────────────────────

export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  oldPath?: string;
}

export interface GitStatus {
  branch: string;
  remote: string | null;
  ahead: number;
  behind: number;
  staged: FileChange[];
  unstaged: FileChange[];
  untracked: string[];
  conflicted: string[];
}

/**
 * Get the full status of a Git repository.
 */
export async function getGitStatus(cwd: string): Promise<GitStatus> {
  if (isTauri()) {
    const raw = await tauriInvoke<{
      branch: string;
      remote: string | null;
      ahead: number;
      behind: number;
      staged: Array<{ path: string; status: string; old_path?: string }>;
      unstaged: Array<{ path: string; status: string; old_path?: string }>;
      untracked: string[];
      conflicted: string[];
    }>("git_status", { cwd });

    return {
      branch: raw.branch,
      remote: raw.remote,
      ahead: raw.ahead,
      behind: raw.behind,
      staged: raw.staged.map((f) => ({
        path: f.path,
        status: f.status as "added" | "modified" | "deleted" | "renamed",
        oldPath: f.old_path,
      })),
      unstaged: raw.unstaged.map((f) => ({
        path: f.path,
        status: f.status as "added" | "modified" | "deleted" | "renamed",
        oldPath: f.old_path,
      })),
      untracked: raw.untracked,
      conflicted: raw.conflicted,
    };
  }

  const res = await fetch(`${DEV_SERVER}/api/git-status?cwd=${encodeURIComponent(cwd)}`);
  if (!res.ok) throw new Error(`Failed to get git status: ${res.status}`);
  return res.json();
}

// ─── Git diff ──────────────────────────────────────────────

export interface DiffLine {
  type: "context" | "add" | "delete";
  content: string;
  oldLineNo?: number;
  newLineNo?: number;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface GitDiff {
  path: string;
  hunks: DiffHunk[];
  /** True when the "file" is actually a new untracked directory */
  isDirectory?: boolean;
  /** List of new files inside the directory (when isDirectory=true) */
  newFiles?: string[];
}

/**
 * Get the diff for a specific file.
 */
export async function getGitDiff(
  cwd: string,
  path: string,
  staged: boolean,
): Promise<GitDiff> {
  if (isTauri()) {
    const raw = await tauriInvoke<{
      path: string;
      hunks: Array<{
        header: string;
        old_start: number;
        old_count: number;
        new_start: number;
        new_count: number;
        lines: Array<{
          type: string;
          content: string;
          old_line_no?: number;
          new_line_no?: number;
        }>;
      }>;
    }>("git_diff", { cwd, path, staged });

    return {
      path: raw.path,
      hunks: raw.hunks.map((h) => ({
        header: h.header,
        oldStart: h.old_start,
        oldCount: h.old_count,
        newStart: h.new_start,
        newCount: h.new_count,
        lines: h.lines.map((l) => ({
          type: l.type as "context" | "add" | "delete",
          content: l.content,
          oldLineNo: l.old_line_no,
          newLineNo: l.new_line_no,
        })),
      })),
    };
  }

  const qs = `?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}&staged=${staged}`;
  const res = await fetch(`${DEV_SERVER}/api/git-diff${qs}`);
  if (!res.ok) throw new Error(`Failed to get git diff: ${res.status}`);
  return res.json();
}

// ─── Git log ───────────────────────────────────────────────

export interface GitLogEntry {
  hash: string;
  hashFull: string;
  author: string;
  email: string;
  date: string;
  message: string;
  body: string;
  /** Parent commit full hashes */
  parents: string[];
  /** Ref decorations (branches, tags) */
  refs: string;
}

/**
 * Get recent commits from a Git repository.
 *
 * @param cwd  Repository path.
 * @param count  Max number of commits to return (default 50).
 * @param all  When `true`, include commits from all refs (`git log --all`).
 *             Default `false` → only commits reachable from the current branch HEAD.
 */
export async function getGitLog(
  cwd: string,
  count?: number,
  all?: boolean,
): Promise<GitLogEntry[]> {
  if (isTauri()) {
    const raw = await tauriInvoke<
      Array<{
        hash: string;
        hash_full: string;
        author: string;
        email: string;
        date: string;
        message: string;
        body: string;
        parents: string[];
        refs: string;
      }>
    >("git_log", { cwd, count: count ?? 50, all: all ?? false });

    return raw.map((e) => ({
      hash: e.hash,
      hashFull: e.hash_full,
      author: e.author,
      email: e.email,
      date: e.date,
      message: e.message,
      body: e.body,
      parents: e.parents,
      refs: e.refs,
    }));
  }

  const qs = `?cwd=${encodeURIComponent(cwd)}&count=${count ?? 50}&all=${all ? "true" : "false"}`;
  const res = await fetch(`${DEV_SERVER}/api/git-log${qs}`);
  if (!res.ok) throw new Error(`Failed to get git log: ${res.status}`);
  return res.json();
}

// ─── Git stage / unstage ──────────────────────────────────────

/**
 * Stage files (git add).
 */
export async function gitStage(cwd: string, paths: string[]): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("git_stage", { cwd, paths });
    return;
  }
  const res = await fetch(`${DEV_SERVER}/api/git-stage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, paths }),
  });
  if (!res.ok) throw new Error(`Failed to stage files: ${res.status}`);
}

/**
 * Unstage files (git reset HEAD).
 */
export async function gitUnstage(cwd: string, paths: string[]): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("git_unstage", { cwd, paths });
    return;
  }
  const res = await fetch(`${DEV_SERVER}/api/git-unstage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, paths }),
  });
  if (!res.ok) throw new Error(`Failed to unstage files: ${res.status}`);
}

/**
 * Stage a partial diff patch (git apply --cached).
 * Used for hunk/line-level staging.
 */
export async function gitStagePatch(cwd: string, patch: string): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("git_stage_patch", { cwd, patch });
    return;
  }
  const res = await fetch(`${DEV_SERVER}/api/git-stage-patch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, patch }),
  });
  if (!res.ok) throw new Error(`Failed to stage patch: ${res.status}`);
}

/**
 * Unstage a partial diff patch (git apply --cached --reverse).
 * Used for hunk/line-level unstaging.
 */
export async function gitUnstagePatch(cwd: string, patch: string): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("git_unstage_patch", { cwd, patch });
    return;
  }
  const res = await fetch(`${DEV_SERVER}/api/git-unstage-patch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, patch }),
  });
  if (!res.ok) throw new Error(`Failed to unstage patch: ${res.status}`);
}

// ─── Git commit ───────────────────────────────────────────────

/**
 * Create a commit with the given message. Returns the short hash.
 */
export async function gitCommit(cwd: string, message: string): Promise<string> {
  if (isTauri()) {
    return tauriInvoke<string>("git_commit", { cwd, message });
  }
  const res = await fetch(`${DEV_SERVER}/api/git-commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, message }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to commit: ${res.status}`);
  }
  const data = await res.json();
  return data.hash;
}

export async function gitAmendCommit(cwd: string, message: string): Promise<string> {
  if (isTauri()) {
    return tauriInvoke<string>("git_amend_commit", { cwd, message });
  }
  const res = await fetch(`${DEV_SERVER}/api/git-amend-commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, message }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to amend commit: ${res.status}`);
  }
  const data = await res.json();
  return data.hash;
}

// ─── Git push / pull ──────────────────────────────────────────

export interface GitPushPullResult {
  success: boolean;
  message: string;
  conflicts?: boolean;
}

/**
 * Push to remote.
 */
export async function gitPush(cwd: string): Promise<GitPushPullResult> {
  if (isTauri()) {
    return tauriInvoke<GitPushPullResult>("git_push", { cwd });
  }
  const res = await fetch(`${DEV_SERVER}/api/git-push`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
  return res.json();
}

/**
 * Pull from remote. Supports optional rebase mode.
 */
export async function gitPull(cwd: string, rebase: boolean = false): Promise<GitPushPullResult> {
  if (isTauri()) {
    return tauriInvoke<GitPushPullResult>("git_pull", { cwd, rebase });
  }
  const res = await fetch(`${DEV_SERVER}/api/git-pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, rebase }),
  });
  return res.json();
}

/**
 * Fetch from remote (updates tracking info without merging).
 */
export async function gitFetch(cwd: string): Promise<GitPushPullResult> {
  if (isTauri()) {
    return tauriInvoke<GitPushPullResult>("git_fetch", { cwd });
  }
  const res = await fetch(`${DEV_SERVER}/api/git-fetch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
  return res.json();
}

/**
 * Merge a branch into the current branch.
 */
export async function gitMerge(cwd: string, branch: string): Promise<GitPushPullResult> {
  if (isTauri()) {
    return tauriInvoke<GitPushPullResult>("git_merge", { cwd, branch });
  }
  const res = await fetch(`${DEV_SERVER}/api/git-merge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, branch }),
  });
  return res.json();
}

/**
 * Abort an in-progress merge.
 */
export async function gitMergeAbort(cwd: string): Promise<GitPushPullResult> {
  if (isTauri()) {
    return tauriInvoke<GitPushPullResult>("git_merge_abort", { cwd });
  }
  const res = await fetch(`${DEV_SERVER}/api/git-merge-abort`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
  return res.json();
}

/**
 * Continue a merge after all conflicts are resolved.
 */
export async function gitMergeContinue(cwd: string): Promise<GitPushPullResult> {
  if (isTauri()) {
    return tauriInvoke<GitPushPullResult>("git_merge_continue", { cwd });
  }
  const res = await fetch(`${DEV_SERVER}/api/git-merge-continue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
  return res.json();
}

// ─── Git show (commit diff) ───────────────────────────────────

/**
 * Get the diff(s) for a specific commit.
 */
export async function getGitShow(cwd: string, hash: string): Promise<GitDiff[]> {
  if (isTauri()) {
    const raw = await tauriInvoke<
      Array<{
        path: string;
        hunks: Array<{
          header: string;
          old_start: number;
          old_count: number;
          new_start: number;
          new_count: number;
          lines: Array<{
            type: string;
            content: string;
            old_line_no?: number;
            new_line_no?: number;
          }>;
        }>;
      }>
    >("git_show", { cwd, hash });

    return raw.map((d) => ({
      path: d.path,
      hunks: d.hunks.map((h) => ({
        header: h.header,
        oldStart: h.old_start,
        oldCount: h.old_count,
        newStart: h.new_start,
        newCount: h.new_count,
        lines: h.lines.map((l) => ({
          type: l.type as "context" | "add" | "delete",
          content: l.content,
          oldLineNo: l.old_line_no,
          newLineNo: l.new_line_no,
        })),
      })),
    }));
  }

  const qs = `?cwd=${encodeURIComponent(cwd)}&hash=${encodeURIComponent(hash)}`;
  const res = await fetch(`${DEV_SERVER}/api/git-show${qs}`);
  if (!res.ok) throw new Error(`Failed to get commit diff: ${res.status}`);
  return res.json();
}

// ─── Git blame ───────────────────────────────────────────────

export interface BlameLine {
  hash: string;
  hashFull: string;
  finalLine: number;
  origLine: number;
  author: string;
  authorDate: string;
  summary: string;
  content: string;
}

/**
 * Get blame info for a file.
 */
export async function getGitBlame(cwd: string, path: string): Promise<BlameLine[]> {
  if (isTauri()) {
    return tauriInvoke<BlameLine[]>("git_blame", { cwd, path });
  }
  const qs = `?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`;
  const res = await fetch(`${DEV_SERVER}/api/git-blame${qs}`);
  if (!res.ok) throw new Error(`Failed to get blame: ${res.status}`);
  return res.json();
}

// ─── Git file log ────────────────────────────────────────────

export interface FileLogEntry {
  hashFull: string;
  hash: string;
  author: string;
  date: string;
  message: string;
  body: string;
}

/**
 * Get commit history for a specific file.
 */
export async function getGitFileLog(cwd: string, path: string, count = 50): Promise<FileLogEntry[]> {
  if (isTauri()) {
    return tauriInvoke<FileLogEntry[]>("git_file_log", { cwd, path, count });
  }
  const qs = `?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}&count=${count}`;
  const res = await fetch(`${DEV_SERVER}/api/git-file-log${qs}`);
  if (!res.ok) throw new Error(`Failed to get file log: ${res.status}`);
  return res.json();
}

// ─── Git file diff between two commits ─────────────────────────

/**
 * Get diff for a specific file between two commits (time-travel diff).
 */
export async function getGitFileDiff(
  cwd: string,
  path: string,
  fromHash: string,
  toHash: string,
): Promise<GitDiff> {
  if (isTauri()) {
    const raw = await tauriInvoke<{
      path: string;
      hunks: Array<{
        header: string;
        old_start: number;
        old_count: number;
        new_start: number;
        new_count: number;
        lines: Array<{
          type: string;
          content: string;
          old_line_no?: number;
          new_line_no?: number;
        }>;
      }>;
    }>("git_file_diff", { cwd, path, fromHash, toHash });

    return {
      path: raw.path,
      hunks: raw.hunks.map((h) => ({
        header: h.header,
        oldStart: h.old_start,
        oldCount: h.old_count,
        newStart: h.new_start,
        newCount: h.new_count,
        lines: h.lines.map((l) => ({
          type: l.type as "context" | "add" | "delete",
          content: l.content,
          oldLineNo: l.old_line_no,
          newLineNo: l.new_line_no,
        })),
      })),
    };
  }

  const qs = `?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}&from=${encodeURIComponent(fromHash)}&to=${encodeURIComponent(toHash)}`;
  const res = await fetch(`${DEV_SERVER}/api/git-file-diff${qs}`);
  if (!res.ok) throw new Error(`Failed to get file diff: ${res.status}`);
  return res.json();
}

// ─── Git discard ──────────────────────────────────────────────

/**
 * Discard changes to tracked files (git restore) or delete untracked files (git clean -f).
 */
export async function gitDiscard(cwd: string, paths: string[], untracked = false): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("git_discard", { cwd, paths, untracked });
    return;
  }
  const res = await fetch(`${DEV_SERVER}/api/git-discard`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, paths, untracked }),
  });
  if (!res.ok) throw new Error(`Failed to discard changes: ${res.status}`);
}

/**
 * Append a path to the repo's .gitignore file.
 */
export async function gitAddToGitignore(cwd: string, path: string): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("git_add_to_gitignore", { cwd, path });
    return;
  }
  const res = await fetch(`${DEV_SERVER}/api/git-gitignore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, path }),
  });
  if (!res.ok) throw new Error(`Failed to add to .gitignore: ${res.status}`);
}

// ─── Git branches ─────────────────────────────────────────────

export interface GitBranch {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  lastCommit: string;
  lastCommitDate: string;
}

/**
 * List all branches (local + remote).
 */
export async function getGitBranches(cwd: string): Promise<GitBranch[]> {
  if (isTauri()) {
    const raw = await tauriInvoke<
      Array<{
        name: string;
        is_current: boolean;
        is_remote: boolean;
        upstream: string | null;
        ahead: number;
        behind: number;
        last_commit: string;
        last_commit_date: string;
      }>
    >("git_branches", { cwd });

    return raw.map((b) => ({
      name: b.name,
      isCurrent: b.is_current,
      isRemote: b.is_remote,
      upstream: b.upstream,
      ahead: b.ahead,
      behind: b.behind,
      lastCommit: b.last_commit,
      lastCommitDate: b.last_commit_date ?? "",
    }));
  }

  const res = await fetch(`${DEV_SERVER}/api/git-branches?cwd=${encodeURIComponent(cwd)}`);
  if (!res.ok) throw new Error(`Failed to get branches: ${res.status}`);
  return res.json();
}

/**
 * Create a new branch. If checkout=true, switch to it.
 */
export async function gitCreateBranch(cwd: string, name: string, checkout: boolean = true): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("git_create_branch", { cwd, name, checkout });
    return;
  }
  const res = await fetch(`${DEV_SERVER}/api/git-create-branch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, name, checkout }),
  });
  if (!res.ok) throw new Error(`Failed to create branch: ${res.status}`);
}

/**
 * Switch to an existing branch.
 */
export async function gitSwitchBranch(cwd: string, name: string): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("git_switch_branch", { cwd, name });
    return;
  }
  const res = await fetch(`${DEV_SERVER}/api/git-switch-branch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, name }),
  });
  if (!res.ok) throw new Error(`Failed to switch branch: ${res.status}`);
}

/**
 * Stash all local changes (staged + unstaged + untracked).
 */
export async function gitStash(cwd: string): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("git_stash", { cwd });
    return;
  }
  const res = await fetch(`${DEV_SERVER}/api/git-stash`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
  if (!res.ok) throw new Error(`Failed to stash: ${res.status}`);
}

/**
 * Restore the most recent stash (git stash pop).
 */
export async function gitStashPop(cwd: string): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("git_stash_pop", { cwd });
    return;
  }
  const res = await fetch(`${DEV_SERVER}/api/git-stash-pop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
  if (!res.ok) throw new Error(`Failed to stash pop: ${res.status}`);
}

/**
 * Open a file in the configured external editor.
 * @param editor - editor binary (e.g. "code", "vim"). Defaults to "code".
 */
export async function openInEditor(cwd: string, path: string, editor: string = ""): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("open_in_editor", { cwd, path, editor });
    return;
  }
  // In browser dev mode, just log — no meaningful way to open an editor
  console.info(`[dev] openInEditor: ${cwd}/${path} (editor: ${editor || "code"})`);
}

/**
 * Configure the git binary path used by all Rust git commands.
 * Pass an empty string to reset to the system default ("git").
 */
export async function setGitConfig(gitPath: string): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("set_git_config", { gitPath });
    return;
  }
  // In browser dev mode, store for potential future use
  (window as any).__gitwand_git_path = gitPath || "git";
}

/**
 * Read the .gitwandrc configuration from a repository root (Phase 7.4).
 * Returns the raw JSON string, or "" if not found.
 * Searches: .gitwandrc → .gitwandrc.json → package.json#gitwand
 */
export async function readGitwandrc(cwd: string): Promise<string> {
  if (isTauri()) {
    return (await tauriInvoke("read_gitwandrc", { cwd })) as string;
  }
  // In browser dev mode, try to fetch from a potential dev endpoint
  try {
    const res = await fetch(`${DEV_SERVER}/api/read-gitwandrc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd }),
    });
    if (res.ok) return await res.text();
  } catch {
    // ignore — no .gitwandrc in dev mode is fine
  }
  return "";
}

/**
 * Delete a branch.
 */
export async function gitDeleteBranch(cwd: string, name: string, force: boolean = false): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("git_delete_branch", { cwd, name, force });
    return;
  }
  const res = await fetch(`${DEV_SERVER}/api/git-delete-branch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, name, force }),
  });
  if (!res.ok) throw new Error(`Failed to delete branch: ${res.status}`);
}

// ─── Conflict Prevention (Phase 8.1) ───────────────────────

export interface ConflictRisk {
  branch: string;
  overlappingFiles: string[];
  currentChanged: number;
  targetChanged: number;
}

/**
 * Check which files overlap between the current branch and a target branch.
 * Useful for conflict prevention — alerts when two branches touch the same files.
 */
export async function gitConflictCheck(cwd: string, targetBranch: string): Promise<ConflictRisk> {
  if (isTauri()) {
    const raw = await tauriInvoke<{
      branch: string;
      overlapping_files: string[];
      current_changed: number;
      target_changed: number;
    }>("git_conflict_check", { cwd, targetBranch });
    return {
      branch: raw.branch,
      overlappingFiles: raw.overlapping_files,
      currentChanged: raw.current_changed,
      targetChanged: raw.target_changed,
    };
  }
  // Dev mode fallback
  return { branch: targetBranch, overlappingFiles: [], currentChanged: 0, targetChanged: 0 };
}

// ─── Cherry-pick (Phase 8.2) ───────────────────────────────

/**
 * Cherry-pick one or more commits onto the current branch.
 */
export async function gitCherryPick(cwd: string, hashes: string[]): Promise<GitPushPullResult> {
  if (isTauri()) {
    return tauriInvoke<GitPushPullResult>("git_cherry_pick", { cwd, hashes });
  }
  const res = await fetch(`${DEV_SERVER}/api/git-cherry-pick`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, hashes }),
  });
  return res.json();
}

/**
 * Abort an in-progress cherry-pick.
 */
export async function gitCherryPickAbort(cwd: string): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("git_cherry_pick_abort", { cwd });
    return;
  }
  await fetch(`${DEV_SERVER}/api/git-cherry-pick-abort`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
}

/**
 * Continue a cherry-pick after resolving conflicts.
 */
export async function gitCherryPickContinue(cwd: string): Promise<GitPushPullResult> {
  if (isTauri()) {
    return tauriInvoke<GitPushPullResult>("git_cherry_pick_continue", { cwd });
  }
  const res = await fetch(`${DEV_SERVER}/api/git-cherry-pick-continue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
  return res.json();
}

// ─── Stash Manager (Phase 8.2) ─────────────────────────────

export interface StashEntry {
  index: number;
  message: string;
  branch: string;
  date: string;
  hash: string;
}

/**
 * List all stash entries.
 */
export async function gitStashList(cwd: string): Promise<StashEntry[]> {
  if (isTauri()) {
    return tauriInvoke<StashEntry[]>("git_stash_list", { cwd });
  }
  const res = await fetch(`${DEV_SERVER}/api/git-stash-list?cwd=${encodeURIComponent(cwd)}`);
  if (!res.ok) throw new Error(`Failed to list stashes: ${res.status}`);
  return res.json();
}

/**
 * Apply a stash by index (without removing it).
 */
export async function gitStashApply(cwd: string, index: number): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("git_stash_apply", { cwd, index });
    return;
  }
  const res = await fetch(`${DEV_SERVER}/api/git-stash-apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, index }),
  });
  if (!res.ok) throw new Error(`Failed to apply stash: ${res.status}`);
}

/**
 * Drop a stash by index.
 */
export async function gitStashDrop(cwd: string, index: number): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("git_stash_drop", { cwd, index });
    return;
  }
  const res = await fetch(`${DEV_SERVER}/api/git-stash-drop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, index }),
  });
  if (!res.ok) throw new Error(`Failed to drop stash: ${res.status}`);
}

/**
 * Show the diff of a stash entry.
 */
export async function gitStashShow(cwd: string, index: number): Promise<string> {
  if (isTauri()) {
    return tauriInvoke<string>("git_stash_show", { cwd, index });
  }
  const res = await fetch(`${DEV_SERVER}/api/git-stash-show?cwd=${encodeURIComponent(cwd)}&index=${index}`);
  if (!res.ok) throw new Error(`Failed to show stash: ${res.status}`);
  const data = await res.json();
  return data.diff;
}

// ─── Monorepo Detection (Phase 8.4) ────────────────────────

export interface MonorepoPackage {
  name: string;
  path: string;
  version: string;
}

export interface MonorepoInfo {
  isMonorepo: boolean;
  manager: string;
  packages: MonorepoPackage[];
}

/**
 * Detect monorepo workspaces (pnpm, npm, yarn).
 */
export async function detectMonorepo(cwd: string): Promise<MonorepoInfo> {
  if (isTauri()) {
    const raw = await tauriInvoke<{
      is_monorepo: boolean;
      manager: string;
      packages: Array<{ name: string; path: string; version: string }>;
    }>("detect_monorepo", { cwd });
    return {
      isMonorepo: raw.is_monorepo,
      manager: raw.manager,
      packages: raw.packages,
    };
  }
  // Dev mode fallback
  return { isMonorepo: false, manager: "", packages: [] };
}

// ─── Terminal Execution (Phase 8.5) ─────────────────────────

export interface TerminalResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Execute a git command in the repo directory. Returns stdout, stderr, and exit code.
 */
export async function gitExec(cwd: string, args: string[]): Promise<TerminalResult> {
  if (isTauri()) {
    const raw = await tauriInvoke<{
      stdout: string;
      stderr: string;
      exit_code: number;
    }>("git_exec", { cwd, args });
    return {
      stdout: raw.stdout,
      stderr: raw.stderr,
      exitCode: raw.exit_code,
    };
  }
  const res = await fetch(`${DEV_SERVER}/api/git-exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, args }),
  });
  return res.json();
}

/**
 * Get autocomplete suggestions for a partial git command.
 */
export async function gitAutocomplete(cwd: string, partial: string): Promise<string[]> {
  if (isTauri()) {
    return tauriInvoke<string[]>("git_autocomplete", { cwd, partial });
  }
  return [];
}

// ─── PR Workflow (Phase 8.3) ────────────────────────────────

export interface RemoteInfo {
  name: string;
  url: string;
  provider: "github" | "gitlab" | "bitbucket" | "unknown";
  owner: string;
  repo: string;
}

/**
 * Get remote info (provider, owner, repo).
 */
export async function gitRemoteInfo(cwd: string): Promise<RemoteInfo> {
  if (isTauri()) {
    return tauriInvoke<RemoteInfo>("git_remote_info", { cwd });
  }
  return { name: "origin", url: "", provider: "unknown", owner: "", repo: "" };
}

export interface PullRequest {
  number: number;
  title: string;
  state: string;
  author: string;
  branch: string;
  base: string;
  draft: boolean;
  createdAt: string;
  updatedAt: string;
  url: string;
  additions: number;
  deletions: number;
  labels: string[];
}

/**
 * List pull requests (requires `gh` CLI).
 */
export async function ghListPrs(cwd: string, state: string = "open"): Promise<PullRequest[]> {
  if (isTauri()) {
    const raw = await tauriInvoke<
      Array<{
        number: number;
        title: string;
        state: string;
        author: string;
        branch: string;
        base: string;
        draft: boolean;
        created_at: string;
        updated_at: string;
        url: string;
        additions: number;
        deletions: number;
        labels: string[];
      }>
    >("gh_list_prs", { cwd, state });
    return raw.map((pr) => ({
      number: pr.number,
      title: pr.title,
      state: pr.state,
      author: pr.author,
      branch: pr.branch,
      base: pr.base,
      draft: pr.draft,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      url: pr.url,
      additions: pr.additions,
      deletions: pr.deletions,
      labels: pr.labels,
    }));
  }
  // Browser dev mode — call dev server
  const res = await fetch(`${DEV_SERVER}/api/gh-list-prs?cwd=${encodeURIComponent(cwd)}&state=${state}`);
  if (!res.ok) throw new Error(`gh pr list failed: ${res.status}`);
  const raw = await res.json();
  if (raw.error) throw new Error(raw.error);
  return raw.map((pr: any) => ({
    number: pr.number,
    title: pr.title,
    state: pr.state,
    author: pr.author,
    branch: pr.branch,
    base: pr.base,
    draft: pr.draft,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    url: pr.url,
    additions: pr.additions,
    deletions: pr.deletions,
    labels: pr.labels,
  }));
}

/**
 * Create a pull request (requires `gh` CLI).
 */
export async function ghCreatePr(
  cwd: string,
  title: string,
  body: string,
  base: string = "",
  draft: boolean = false,
): Promise<PullRequest> {
  if (isTauri()) {
    const raw = await tauriInvoke<{
      number: number;
      title: string;
      state: string;
      author: string;
      branch: string;
      base: string;
      draft: boolean;
      created_at: string;
      updated_at: string;
      url: string;
      additions: number;
      deletions: number;
      labels: string[];
    }>("gh_create_pr", { cwd, title, body, base, draft });
    return {
      number: raw.number,
      title: raw.title,
      state: raw.state,
      author: raw.author,
      branch: raw.branch,
      base: raw.base,
      draft: raw.draft,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
      url: raw.url,
      additions: raw.additions,
      deletions: raw.deletions,
      labels: raw.labels,
    };
  }
  throw new Error("PR creation not available in dev mode");
}

/**
 * Checkout a PR branch locally (requires `gh` CLI).
 */
export async function ghCheckoutPr(cwd: string, number: number): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("gh_checkout_pr", { cwd, number });
    return;
  }
  throw new Error("PR checkout not available in dev mode");
}

/**
 * Merge a PR (requires `gh` CLI).
 * @param method - "merge", "squash", or "rebase"
 */
export async function ghMergePr(cwd: string, number: number, method: string = "merge"): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("gh_merge_pr", { cwd, number, method });
    return;
  }
  throw new Error("PR merge not available in dev mode");
}

// ─── PR Detail, Diff & Checks (Phase 9.1) ──────────────────

export interface PullRequestDetail {
  number: number;
  title: string;
  body: string;
  state: string;
  author: string;
  branch: string;
  base: string;
  draft: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt: string;
  url: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  comments: number;
  reviewComments: number;
  labels: string[];
  reviewers: string[];
  mergeable: string;
  checksStatus: string;
}

export interface CICheck {
  name: string;
  state: string;
  conclusion: string;
  detailsUrl: string;
}

/**
 * Get detailed PR information (requires `gh` CLI).
 */
export async function ghPrDetail(cwd: string, number: number): Promise<PullRequestDetail> {
  if (isTauri()) {
    const raw = await tauriInvoke<{
      number: number;
      title: string;
      body: string;
      state: string;
      author: string;
      branch: string;
      base: string;
      draft: boolean;
      created_at: string;
      updated_at: string;
      merged_at: string;
      url: string;
      additions: number;
      deletions: number;
      changed_files: number;
      comments: number;
      review_comments: number;
      labels: string[];
      reviewers: string[];
      mergeable: string;
      checks_status: string;
    }>("gh_pr_detail", { cwd, number });
    return {
      number: raw.number,
      title: raw.title,
      body: raw.body,
      state: raw.state,
      author: raw.author,
      branch: raw.branch,
      base: raw.base,
      draft: raw.draft,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
      mergedAt: raw.merged_at,
      url: raw.url,
      additions: raw.additions,
      deletions: raw.deletions,
      changedFiles: raw.changed_files,
      comments: raw.comments,
      reviewComments: raw.review_comments,
      labels: raw.labels,
      reviewers: raw.reviewers,
      mergeable: raw.mergeable,
      checksStatus: raw.checks_status,
    };
  }
  // Browser dev mode
  const res = await fetch(`${DEV_SERVER}/api/gh-pr-detail?cwd=${encodeURIComponent(cwd)}&number=${number}`);
  if (!res.ok) throw new Error(`gh pr detail failed: ${res.status}`);
  const raw = await res.json();
  if (raw.error) throw new Error(raw.error);
  return {
    number: raw.number, title: raw.title, body: raw.body, state: raw.state,
    author: raw.author, branch: raw.branch, base: raw.base, draft: raw.draft,
    createdAt: raw.created_at, updatedAt: raw.updated_at, mergedAt: raw.merged_at,
    url: raw.url, additions: raw.additions, deletions: raw.deletions,
    changedFiles: raw.changed_files, comments: raw.comments, reviewComments: raw.review_comments,
    labels: raw.labels, reviewers: raw.reviewers, mergeable: raw.mergeable, checksStatus: raw.checks_status,
  };
}

/**
 * Get the diff of a PR (requires `gh` CLI).
 */
export async function ghPrDiff(cwd: string, number: number): Promise<string> {
  if (isTauri()) {
    return await tauriInvoke<string>("gh_pr_diff", { cwd, number });
  }
  const res = await fetch(`${DEV_SERVER}/api/gh-pr-diff?cwd=${encodeURIComponent(cwd)}&number=${number}`);
  if (!res.ok) throw new Error(`gh pr diff failed: ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.diff;
}

/**
 * Get CI checks for a PR (requires `gh` CLI).
 */
export async function ghPrChecks(cwd: string, number: number): Promise<CICheck[]> {
  if (isTauri()) {
    const raw = await tauriInvoke<Array<{
      name: string;
      state: string;
      conclusion: string;
      details_url: string;
    }>>("gh_pr_checks", { cwd, number });
    return raw.map((c) => ({
      name: c.name,
      state: c.state,
      conclusion: c.conclusion,
      detailsUrl: c.details_url,
    }));
  }
  const res = await fetch(`${DEV_SERVER}/api/gh-pr-checks?cwd=${encodeURIComponent(cwd)}&number=${number}`);
  if (!res.ok) throw new Error(`gh pr checks failed: ${res.status}`);
  const raw = await res.json();
  if (raw.error) throw new Error(raw.error);
  return raw.map((c: any) => ({
    name: c.name, state: c.state, conclusion: c.conclusion, detailsUrl: c.details_url,
  }));
}

// ─── PR Review Comments (Phase 9.2) ────────────────────────

/** A single review comment anchored to a diff line. */
export interface PrReviewComment {
  id: number;
  body: string;
  author: string;
  created_at: string;
  updated_at: string;
  /** File path the comment is anchored to. */
  path: string;
  /** New-file line number (null for comments on deleted lines). */
  line: number | null;
  /** Line number in the original (old) file. */
  original_line: number | null;
  /** Which side of the diff: LEFT (old) or RIGHT (new). */
  side: "LEFT" | "RIGHT";
  /** First line of a multi-line comment range. */
  start_line: number | null;
  start_side: "LEFT" | "RIGHT" | null;
  /** ID of parent comment if this is a reply. */
  in_reply_to_id: number | null;
  /** Raw diff hunk context. */
  diff_hunk: string;
  url: string;
}

/** Params for creating a new review comment. */
export interface CreatePrCommentParams {
  /** Comment text (Markdown). */
  body: string;
  /** File path. Required for new comments (not replies). */
  path?: string;
  /** Last line number (new-file side). */
  line?: number;
  side?: "LEFT" | "RIGHT";
  /** Start of a multi-line comment. */
  start_line?: number;
  start_side?: "LEFT" | "RIGHT";
  /** Reply to this comment ID instead of creating a new thread. */
  in_reply_to_id?: number;
}

/** Fetch all review comments for a PR. */
export async function ghPrComments(cwd: string, prNumber: number): Promise<PrReviewComment[]> {
  // No Tauri implementation — browser only for now
  const res = await fetch(`${DEV_SERVER}/api/gh-pr-comments?cwd=${encodeURIComponent(cwd)}&number=${prNumber}`);
  if (!res.ok) throw new Error(`gh pr comments failed: ${res.status}`);
  const raw = await res.json();
  if (raw.error) throw new Error(raw.error);
  return raw as PrReviewComment[];
}

/** Create a new review comment (or reply to an existing one). */
export async function ghPrCreateComment(
  cwd: string,
  prNumber: number,
  params: CreatePrCommentParams,
): Promise<PrReviewComment> {
  const res = await fetch(`${DEV_SERVER}/api/gh-pr-comment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, number: prNumber, ...params }),
  });
  if (!res.ok) throw new Error(`create comment failed: ${res.status}`);
  const raw = await res.json();
  if (raw.error) throw new Error(raw.error);
  return raw as PrReviewComment;
}

/** Edit the body of an existing review comment. */
export async function ghPrUpdateComment(
  cwd: string,
  commentId: number,
  body: string,
): Promise<void> {
  const res = await fetch(`${DEV_SERVER}/api/gh-pr-comment?id=${commentId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, body }),
  });
  if (!res.ok) throw new Error(`update comment failed: ${res.status}`);
}

/** Delete a review comment. */
export async function ghPrDeleteComment(cwd: string, commentId: number): Promise<void> {
  const res = await fetch(
    `${DEV_SERVER}/api/gh-pr-comment?cwd=${encodeURIComponent(cwd)}&id=${commentId}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw new Error(`delete comment failed: ${res.status}`);
}

// ─── PR Reviews (Phase 9.3) ────────────────────────────────

/** A top-level pull-request review (Approve / Request Changes / Comment). */
export interface PrReview {
  id: number;
  /** "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING" */
  state: string;
  body: string;
  user: { login: string; avatar_url: string };
  submitted_at: string;
  html_url: string;
}

/** A pending inline comment included when submitting a review. */
export interface PendingReviewComment {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  start_line?: number;
  start_side?: "LEFT" | "RIGHT";
  body: string;
}

/** Fetch all reviews for a PR. */
export async function ghPrListReviews(cwd: string, prNumber: number): Promise<PrReview[]> {
  const res = await fetch(
    `${DEV_SERVER}/api/gh-pr-reviews?cwd=${encodeURIComponent(cwd)}&number=${prNumber}`,
  );
  if (!res.ok) throw new Error(`gh pr reviews failed: ${res.status}`);
  const raw = await res.json();
  if (raw.error) throw new Error(raw.error);
  return raw as PrReview[];
}

/** Submit a review (Approve / Request Changes / Comment) with optional inline comments. */
export async function ghPrSubmitReview(
  cwd: string,
  prNumber: number,
  opts: {
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
    body?: string;
    comments?: PendingReviewComment[];
  },
): Promise<PrReview> {
  const res = await fetch(`${DEV_SERVER}/api/gh-pr-submit-review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, number: prNumber, ...opts }),
  });
  if (!res.ok) throw new Error(`gh pr submit review failed: ${res.status}`);
  const raw = await res.json();
  if (raw.error) throw new Error(raw.error);
  return raw as PrReview;
}

// ─── Phase 9.4 — Intelligence GitWand ──────────────────────

/** Result of a conflict simulation (merge-tree analysis). */
export interface PrConflictPreview {
  /** GitHub mergeable flag (true/false/null=unknown). */
  mergeable: boolean | null;
  mergeableState: string;
  /** Files very likely to conflict (appear on both sides since merge-base). */
  conflictingFiles: string[];
  /** Files changed only in the PR — no conflict risk. */
  cleanFiles: string[];
  /** Files that both sides changed (potential conflicts even if GH says clean). */
  overlappingFiles: string[];
  totalPrFiles: number;
  summary: string;
}

/** Hotspot score for a file — how often it has been involved in merge commits. */
export interface PrHotspot {
  path: string;
  /** Number of merge commits that touched this file. */
  mergeCount: number;
  /** Total commits touching this file. */
  totalCount: number;
  /** Percentage of commits that were merges (0–100). */
  score: number;
  lastChange: string;
}

/** Historical review activity on a specific file. */
export interface PrFileHistory {
  reviewCommentCount: number;
  reviewers: string[];
  lastComment: { author: string; body: string; pr_number: string } | null;
}

/** Fetch conflict prediction for a PR (git merge-tree analysis). */
export async function ghPrConflictPreview(cwd: string, prNumber: number): Promise<PrConflictPreview> {
  const res = await fetch(
    `${DEV_SERVER}/api/gh-pr-conflict-preview?cwd=${encodeURIComponent(cwd)}&number=${prNumber}`,
  );
  if (!res.ok) throw new Error(`conflict preview failed: ${res.status}`);
  const raw = await res.json();
  if (raw.error) throw new Error(raw.error);
  return raw as PrConflictPreview;
}

/** Fetch hotspot scores for a list of file paths. */
export async function ghPrHotspots(cwd: string, paths: string[]): Promise<PrHotspot[]> {
  const res = await fetch(
    `${DEV_SERVER}/api/gh-pr-hotspots?cwd=${encodeURIComponent(cwd)}&paths=${encodeURIComponent(paths.join(","))}`,
  );
  if (!res.ok) throw new Error(`hotspots failed: ${res.status}`);
  const raw = await res.json();
  if (raw.error) throw new Error(raw.error);
  return raw as PrHotspot[];
}

/** Total number of tracked files in the repo (for scope %). */
export async function gitFileCount(cwd: string): Promise<number> {
  const res = await fetch(`${DEV_SERVER}/api/git-file-count?cwd=${encodeURIComponent(cwd)}`);
  if (!res.ok) throw new Error(`file count failed: ${res.status}`);
  const raw = await res.json();
  if (raw.error) throw new Error(raw.error);
  return raw.count as number;
}

/** Fetch past review activity on a set of files (last 100 review comments from repo). */
export async function ghPrFileHistory(
  cwd: string,
  paths: string[],
): Promise<Record<string, PrFileHistory>> {
  const res = await fetch(
    `${DEV_SERVER}/api/gh-pr-file-history?cwd=${encodeURIComponent(cwd)}&paths=${encodeURIComponent(paths.join(","))}`,
  );
  if (!res.ok) throw new Error(`file history failed: ${res.status}`);
  const raw = await res.json();
  if (raw.error) throw new Error(raw.error);
  return raw as Record<string, PrFileHistory>;
}

// ─── Merge Preview (Phase 8.1) ─────────────────────────────

/** Résultat brut d'un fichier analysé par preview_merge (Rust) */
export interface FileMergePreview {
  /** Chemin relatif du fichier dans le repo */
  file_path: string;
  /** Contenu avec marqueurs de conflit (vide si pas de conflit) */
  conflict_content: string;
  /** True si le contenu contient des marqueurs <<<<<<<  */
  has_conflicts: boolean;
  /** True si fichier ajouté d'un côté et supprimé de l'autre */
  is_add_delete: boolean;
}

/**
 * Calcule un aperçu de merge sans toucher au working tree.
 * Utilise git merge-base + git show + git merge-file -p côté Rust.
 */
export async function previewMerge(
  cwd: string,
  sourceBranch: string,
): Promise<FileMergePreview[]> {
  if (isTauri()) {
    return tauriInvoke<FileMergePreview[]>("preview_merge", {
      cwd,
      sourceBranch,
    });
  }
  // Dev mode: endpoint optionnel (pas critique pour le dev)
  try {
    const res = await fetch(`${DEV_SERVER}/api/preview-merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, sourceBranch }),
    });
    if (res.ok) return await res.json();
  } catch {
    // Pas de serveur dev → retourner un tableau vide
  }
  return [];
}

