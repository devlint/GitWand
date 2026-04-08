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
}

/**
 * Get recent commits from a Git repository.
 */
export async function getGitLog(cwd: string, count?: number): Promise<GitLogEntry[]> {
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
      }>
    >("git_log", { cwd, count: count ?? 50 });

    return raw.map((e) => ({
      hash: e.hash,
      hashFull: e.hash_full,
      author: e.author,
      email: e.email,
      date: e.date,
      message: e.message,
      body: e.body,
    }));
  }

  const qs = `?cwd=${encodeURIComponent(cwd)}&count=${count ?? 50}`;
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

// ─── Git push / pull ──────────────────────────────────────────

export interface GitPushPullResult {
  success: boolean;
  message: string;
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
 * Pull from remote.
 */
export async function gitPull(cwd: string): Promise<GitPushPullResult> {
  if (isTauri()) {
    return tauriInvoke<GitPushPullResult>("git_pull", { cwd });
  }
  const res = await fetch(`${DEV_SERVER}/api/git-pull`, {
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

// ─── Git discard ──────────────────────────────────────────────

/**
 * Discard changes to tracked files (git checkout --).
 */
export async function gitDiscard(cwd: string, paths: string[]): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("git_discard", { cwd, paths });
    return;
  }
  const res = await fetch(`${DEV_SERVER}/api/git-discard`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, paths }),
  });
  if (!res.ok) throw new Error(`Failed to discard changes: ${res.status}`);
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
