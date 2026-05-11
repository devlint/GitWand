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

/**
 * Lightweight circuit-breaker for dev-server fetches.
 *
 * After THRESHOLD consecutive "Failed to fetch" (connection refused / server
 * down), all outgoing fetches are blocked for BACKOFF_MS milliseconds so the
 * browser doesn't spray thousands of failed requests into the Network tab.
 *
 * The breaker resets automatically after the backoff period, trying one probe
 * request.  If that succeeds, normal operation resumes; if it fails the cycle
 * repeats with the same backoff.
 *
 * Only active in browser/dev mode — Tauri uses invoke() and is unaffected.
 */
const _cb = {
  failures:   0,
  openUntil:  0,           // epoch ms — while Date.now() < openUntil, block all fetches
  THRESHOLD:  3,           // consecutive failures before opening the breaker
  BACKOFF_MS: 15_000,      // how long to stay open before probing again
};

/**
 * Thin wrapper around `fetch` that honours the circuit breaker.
 * All dev-server fetches should call this instead of `fetch()` directly.
 */
async function devFetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
  if (Date.now() < _cb.openUntil) {
    throw new Error("dev-server unreachable (circuit breaker open)");
  }
  try {
    const res = await fetch(input, init);
    _cb.failures = 0;           // any successful TCP connection resets the counter
    return res;
  } catch (err: any) {
    // Only count network-level errors (connection refused / server down).
    // HTTP 4xx/5xx responses are fine — they don't mean the server is down.
    if (err?.name === "TypeError" && err?.message?.includes("fetch")) {
      _cb.failures += 1;
      if (_cb.failures >= _cb.THRESHOLD) {
        _cb.openUntil = Date.now() + _cb.BACKOFF_MS;
        console.warn(
          `[backend] dev-server unreachable after ${_cb.failures} attempts — ` +
          `polling paused for ${_cb.BACKOFF_MS / 1000}s`,
        );
        _cb.failures = 0;       // reset so the next probe starts fresh
      }
    }
    throw err;
  }
}

/** Check if we're inside a Tauri webview. */
export function isTauri(): boolean {
  return !!(window as any).__TAURI_INTERNALS__;
}

/**
 * Call a Tauri command via the invoke IPC bridge.
 *
 * `timeoutMs` controls the IPC timeout:
 *   - default 30 000 ms — safe for any read-only command (git_status,
 *     git_log, git_diff, git_branches, workspace_*_all, etc.)
 *   - pass a higher value (e.g. 300 000) for network operations:
 *     git_push, git_pull, git_fetch, git_clone — these can legitimately
 *     take minutes on a slow link
 *   - pass `0` to disable the timeout entirely for arbitrarily-long
 *     operations like AI prompts (claude_cli_prompt, codex_cli_prompt)
 *
 * The timer is cleared when the underlying invoke resolves so we don't
 * leak a no-op setTimeout for the full timeout duration.
 */
async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
  const internals = (window as any).__TAURI_INTERNALS__;
  if (!internals?.invoke) {
    throw new Error("Tauri invoke not available");
  }
  const promise = internals.invoke(cmd, args) as Promise<T>;
  if (timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.finally(() => { if (timer) clearTimeout(timer); }),
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`IPC timeout after ${timeoutMs}ms: ${cmd}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Timeout presets for tauriInvoke. Use these instead of hardcoding
 * magic numbers at call sites — keeps the policy in one place.
 */
const IPC_TIMEOUT = {
  /** Default — short read-only commands. */
  DEFAULT: 30_000,
  /** Network git operations: push, pull, fetch, clone. */
  NETWORK: 300_000,       // 5 min
  /** AI prompts — no timeout, can run arbitrarily long. */
  NONE: 0,
} as const;

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
    // Rust backend validates that `path`, resolved under `cwd`, stays inside cwd.
    return tauriInvoke<string>("read_file", { cwd, path });
  }
  const res = await devFetch(`${DEV_SERVER}/api/read-file`, {
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
    // Rust backend validates that `path`, resolved under `cwd`, stays inside cwd.
    await tauriInvoke("write_file", { cwd, path, content });
    return;
  }
  const res = await devFetch(`${DEV_SERVER}/api/write-file`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, path, content }),
  });
  if (!res.ok) throw new Error(`Failed to write ${path}`);
}

/**
 * Shape returned by `readFileAtRevision`. Bytes are base64-encoded to cross
 * the IPC boundary without lossy JSON number-array serialization.
 */
export interface FileAtRevision {
  /** Base64-encoded file bytes. Empty string when `absent` is true. */
  bytesBase64: string;
  /** Length in bytes of the decoded payload. */
  byteLength: number;
  /** MIME type guessed from the path extension. */
  mime: string;
  /** True when the file does not exist at the requested revision. */
  absent: boolean;
}

/**
 * Read the raw bytes of a file at a specific git revision (or the working tree).
 *
 * Introduced for the v1.6.2 image-diff pipeline. Accepts any file type — the
 * caller decides how to decode. The path is always relative to `cwd`.
 *
 * - `rev === ""`  → read from disk (working tree, including modified/untracked)
 * - `rev === ":0"` → staged version (index)
 * - otherwise     → `git show <rev>:<path>` (HEAD, HEAD^, hash, branch, tag…)
 *
 * Returns `{ absent: true, bytesBase64: "" }` when the file does not exist at
 * the requested revision (e.g. an added file that is absent from HEAD).
 */
export async function readFileAtRevision(
  cwd: string,
  rev: string,
  path: string,
): Promise<FileAtRevision> {
  if (isTauri()) {
    const raw = await tauriInvoke<{
      bytes_base64: string;
      byte_length: number;
      mime: string;
      absent: boolean;
    }>("read_file_at_revision", { cwd, rev, path });
    return {
      bytesBase64: raw.bytes_base64,
      byteLength: raw.byte_length,
      mime: raw.mime,
      absent: raw.absent,
    };
  }
  const res = await devFetch(`${DEV_SERVER}/api/read-file-at-revision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, rev, path }),
  });
  if (!res.ok) throw new Error(`Failed to read ${path} at rev ${rev || "(working tree)"}`);
  return res.json();
}

// ─── Folder diff (v1.6.3) ────────────────────────────────

/**
 * One node in the folder diff tree. The root is a synthetic folder whose
 * `children` are the top-level changed paths (folders or files) — callers
 * render `root.children` directly.
 */
export interface FolderDiffNode {
  /** Repo-relative path, "" for the root. */
  path: string;
  /** Last path segment, "" for the root. */
  name: string;
  /** "folder" or "file". */
  kind: "folder" | "file";
  /** Status letter for files (A/M/D/R/C/T). `null` for folders and the root. */
  status: string | null;
  /** For renamed/copied files: original path before the rename. */
  oldPath: string | null;
  /** Aggregate changed-file count (1 for a file, sum of descendants for a folder). */
  filesChanged: number;
  /** Aggregate added lines (0 for binary files). */
  additions: number;
  /** Aggregate deleted lines (0 for binary files). */
  deletions: number;
  /** True when the file reports as binary in `git diff --numstat`. */
  binary: boolean;
  /** Child entries, pre-sorted folders-first then alphabetical by name. */
  children: FolderDiffNode[];
}

/**
 * Get the folder-aggregated diff tree between two git revisions.
 *
 * Ref semantics:
 * - `refA === "" && refB === ""` → working tree vs HEAD (default diff flow)
 * - `refA` set, `refB === ""`    → working tree vs refA
 * - both set                     → refB relative to refA (`git diff refA refB`)
 *
 * The returned tree has stats (additions, deletions, filesChanged) propagated
 * up from each changed file to every ancestor folder. Renames are detected
 * via `--find-renames` and attached to the new path's node with `oldPath` set.
 */
export async function folderDiff(
  cwd: string,
  refA: string,
  refB: string,
): Promise<FolderDiffNode> {
  if (isTauri()) {
    // Rust struct already serializes with rename_all = "camelCase", so no
    // field translation is needed here — the shape matches FolderDiffNode.
    return await tauriInvoke<FolderDiffNode>("folder_diff", { cwd, refA, refB });
  }
  const res = await devFetch(`${DEV_SERVER}/api/folder-diff`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, refA, refB }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`folder_diff failed: ${body || res.statusText}`);
  }
  return res.json();
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
  const res = await devFetch(`${DEV_SERVER}/api/list-dir${qs}`);
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
  /** Push remote when it differs from upstream (fork / triangular workflow). */
  pushRemote: string | null;
  /** Commits ahead of the push remote (relevant when pushRemote differs from remote). */
  aheadPush: number;
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
      push_remote: string | null;
      ahead_push: number;
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
      pushRemote: raw.push_remote ?? null,
      aheadPush: raw.ahead_push ?? 0,
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

  const res = await devFetch(`${DEV_SERVER}/api/git-status?cwd=${encodeURIComponent(cwd)}`);
  if (!res.ok) throw new Error(`Failed to get git status: ${res.status}`);
  const data = await res.json();
  // dev-server doesn't compute push remote — fill defaults
  return { pushRemote: null, aheadPush: 0, ...data };
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
  /**
   * File-level status as reported by the diff's extended header
   * (`new file mode`, `deleted file mode`, `rename from/to`). Absent for a
   * plain in-place modification. Used by `patchBuilder` to emit the correct
   * `--- a/<path>` vs `--- /dev/null` header — a new file's patch must use
   * `/dev/null` as source or `git apply --cached` fails with "does not
   * exist in index" during a commit split.
   */
  status?: "added" | "modified" | "deleted" | "renamed";
  /** Original path for renames. */
  oldPath?: string;
  /** True when the "file" is actually a new untracked directory */
  isDirectory?: boolean;
  /** List of new files inside the directory (when isDirectory=true) */
  newFiles?: string[];
  /**
   * P2.4 — When set, the raw `git diff` output exceeded the backend's
   * truncation threshold (5 MB). Hunks were parsed from the truncated
   * prefix. The value is the *original* byte size, suitable for showing
   * a "diff truncated at X MB" banner.
   */
  truncatedFromBytes?: number;
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
  const res = await devFetch(`${DEV_SERVER}/api/git-diff${qs}`);
  if (!res.ok) throw new Error(`Failed to get git diff: ${res.status}`);
  return res.json();
}

// ─── Git user ─────────────────────────────────────────────

export interface GitUser {
  name: string;
  email: string;
}

/**
 * Get the current git user from `git config user.name` / `git config user.email`.
 */
export async function getGitUser(cwd: string): Promise<GitUser> {
  if (isTauri()) {
    const raw = await tauriInvoke<{ name: string; email: string }>("git_get_user", { cwd });
    return { name: raw.name, email: raw.email };
  }
  const qs = `?cwd=${encodeURIComponent(cwd)}`;
  const res = await devFetch(`${DEV_SERVER}/api/git-get-user${qs}`);
  if (!res.ok) return { name: "", email: "" };
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
 * @param author  When set, only show commits matching this author (passed as `--author`).
 */
export async function getGitLog(
  cwd: string,
  count?: number,
  all?: boolean,
  author?: string,
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
    >("git_log", { cwd, count: count ?? 50, all: all ?? false, author: author ?? null });

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

  const qs = `?cwd=${encodeURIComponent(cwd)}&count=${count ?? 50}&all=${all ? "true" : "false"}${author ? `&author=${encodeURIComponent(author)}` : ""}`;
  const res = await devFetch(`${DEV_SERVER}/api/git-log${qs}`);
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
  const res = await devFetch(`${DEV_SERVER}/api/git-stage`, {
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
  const res = await devFetch(`${DEV_SERVER}/api/git-unstage`, {
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
  const res = await devFetch(`${DEV_SERVER}/api/git-stage-patch`, {
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
  const res = await devFetch(`${DEV_SERVER}/api/git-unstage-patch`, {
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
  const res = await devFetch(`${DEV_SERVER}/api/git-commit`, {
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
  const res = await devFetch(`${DEV_SERVER}/api/git-amend-commit`, {
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

export interface GitSplitCommitResult {
  firstHash: string;
  secondHash: string;
}

/**
 * Split the HEAD commit into two commits by sequencing:
 *   reset --mixed HEAD^ → apply --cached (firstPatch) → commit (firstMessage)
 *                       → add -A . → commit (secondMessage)
 *
 * Requires a clean working tree. On any failure, rolls back to the original
 * HEAD via `git reset --hard` (best-effort).
 *
 * Works in both standalone (split HEAD directly) and rebase-edit-stop contexts.
 * In a rebase edit-stop, the caller is expected to run `git rebase --continue`
 * after a successful split.
 *
 * @param firstPatch  Unified diff of the hunks that should land in the FIRST
 *                    (new parent) commit. The remaining hunks land in the
 *                    second commit via `git add -A .`.
 * @param firstMessage Message for the first commit (often user-authored, empty by default).
 * @param secondMessage Message for the second commit (usually the original commit message).
 */
export async function gitSplitCommit(
  cwd: string,
  firstPatch: string,
  firstMessage: string,
  secondMessage: string,
): Promise<GitSplitCommitResult> {
  if (isTauri()) {
    const raw = await tauriInvoke<{ first_hash: string; second_hash: string }>(
      "git_split_commit",
      { cwd, firstPatch, firstMessage, secondMessage },
    );
    return { firstHash: raw.first_hash, secondHash: raw.second_hash };
  }
  const res = await devFetch(`${DEV_SERVER}/api/git-split-commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, firstPatch, firstMessage, secondMessage }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to split commit: ${res.status}`);
  }
  const data = await res.json();
  return { firstHash: data.firstHash, secondHash: data.secondHash };
}

// ─── Git push / pull ──────────────────────────────────────────

export interface GitPushPullResult {
  success: boolean;
  message: string;
  conflicts?: boolean;
}

/**
 * Push to remote.
 *
 * When `setUpstream` is true, runs `git push --set-upstream origin HEAD`,
 * which publishes the current branch to a same-named branch on origin and
 * records it as the upstream. Used when pushing a branch that has no
 * tracking configured yet.
 */
export async function gitPush(
  cwd: string,
  setUpstream: boolean = false,
): Promise<GitPushPullResult> {
  if (isTauri()) {
    return tauriInvoke<GitPushPullResult>("git_push", { cwd, setUpstream }, IPC_TIMEOUT.NETWORK);
  }
  const res = await devFetch(`${DEV_SERVER}/api/git-push`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, setUpstream }),
  });
  return res.json();
}

/**
 * Pull from remote. Supports optional rebase mode.
 */
export async function gitPull(cwd: string, rebase: boolean = false): Promise<GitPushPullResult> {
  if (isTauri()) {
    return tauriInvoke<GitPushPullResult>("git_pull", { cwd, rebase }, IPC_TIMEOUT.NETWORK);
  }
  const res = await devFetch(`${DEV_SERVER}/api/git-pull`, {
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
    return tauriInvoke<GitPushPullResult>("git_fetch", { cwd }, IPC_TIMEOUT.NETWORK);
  }
  const res = await devFetch(`${DEV_SERVER}/api/git-fetch`, {
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
  const res = await devFetch(`${DEV_SERVER}/api/git-merge`, {
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
  const res = await devFetch(`${DEV_SERVER}/api/git-merge-abort`, {
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
  const res = await devFetch(`${DEV_SERVER}/api/git-merge-continue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
  return res.json();
}

// ─── Git repo operation state ─────────────────────────────────

export interface RepoOperationState {
  /** "clean" | "rebase" | "rebase_interactive" | "merge" | "cherry_pick" | "revert" */
  state: 'clean' | 'rebase' | 'rebase_interactive' | 'merge' | 'cherry_pick' | 'revert';
  /** True when there are still unresolved conflict markers in the working tree. */
  hasConflict: boolean;
  /** SHA of the commit being applied (REBASE_HEAD / MERGE_HEAD / …). */
  operationHead: string | null;
  /** Branch being rebased onto (from rebase-merge/head-name). */
  targetBranch: string | null;
  /** 1-based current step (0 when unknown). */
  step: number;
  /** Total steps (0 when unknown). */
  total: number;
}

/**
 * Reads the repository's current operation state directly from the .git
 * directory — reliable across all git locales.
 */
export async function gitRepoState(cwd: string): Promise<RepoOperationState> {
  if (isTauri()) {
    return tauriInvoke<RepoOperationState>("git_repo_state", { cwd });
  }
  const res = await devFetch(`${DEV_SERVER}/api/git-repo-state`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
  return res.json();
}

/**
 * Run `git rebase --continue`, `--abort`, or `--skip`.
 */
export async function gitRebaseAction(
  cwd: string,
  action: 'continue' | 'abort' | 'skip'
): Promise<void> {
  if (isTauri()) {
    return tauriInvoke<void>("git_rebase_action", { cwd, action });
  }
  const res = await devFetch(`${DEV_SERVER}/api/git-rebase-action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, action }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? "git rebase action failed");
  }
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
        status?: string;
        oldPath?: string;
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
      status: d.status as GitDiff["status"],
      oldPath: d.oldPath,
    }));
  }

  const qs = `?cwd=${encodeURIComponent(cwd)}&hash=${encodeURIComponent(hash)}`;
  const res = await devFetch(`${DEV_SERVER}/api/git-show${qs}`);
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

export type BlameAlgorithm = "histogram" | "patience" | "minimal" | "myers";

/**
 * Get blame info for a file.
 * @param algorithm diff algorithm passed to `git blame --diff-algorithm=<algo>`. Defaults to "histogram".
 */
export async function getGitBlame(cwd: string, path: string, algorithm: BlameAlgorithm = "histogram"): Promise<BlameLine[]> {
  if (isTauri()) {
    // Rust returns snake_case keys — map to camelCase
    const raw = await tauriInvoke<Array<{
      hash: string; hash_full: string; final_line: number; orig_line: number;
      author: string; author_date: string; summary: string; content: string;
    }>>("git_blame", { cwd, path, algorithm });
    return raw.map(r => ({
      hash: r.hash, hashFull: r.hash_full, finalLine: r.final_line, origLine: r.orig_line,
      author: r.author, authorDate: r.author_date, summary: r.summary, content: r.content,
    }));
  }
  const qs = `?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}&algorithm=${algorithm}`;
  const res = await devFetch(`${DEV_SERVER}/api/git-blame${qs}`);
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
    const raw = await tauriInvoke<Array<{ hash_full: string; hash: string; author: string; date: string; message: string; body: string }>>("git_file_log", { cwd, path, count });
    return raw.map(r => ({ hashFull: r.hash_full, hash: r.hash, author: r.author, date: r.date, message: r.message, body: r.body }));
  }
  const qs = `?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}&count=${count}`;
  const res = await devFetch(`${DEV_SERVER}/api/git-file-log${qs}`);
  if (!res.ok) throw new Error(`Failed to get file log: ${res.status}`);
  return res.json();
}

export type PickaxeMode = "S" | "G";

/**
 * Pickaxe search: find commits where `search` was added or removed in `path`.
 * mode "S" = literal string match, "G" = regex match.
 */
export async function getGitFileLogPickaxe(cwd: string, path: string, search: string, mode: PickaxeMode = "S"): Promise<FileLogEntry[]> {
  if (isTauri()) {
    const raw = await tauriInvoke<Array<{ hash_full: string; hash: string; author: string; date: string; message: string; body: string }>>("git_file_log_pickaxe", { cwd, path, search, mode });
    return raw.map(r => ({ hashFull: r.hash_full, hash: r.hash, author: r.author, date: r.date, message: r.message, body: r.body }));
  }
  const qs = `?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}&search=${encodeURIComponent(search)}&mode=${mode}`;
  const res = await devFetch(`${DEV_SERVER}/api/git-file-log-pickaxe${qs}`);
  if (!res.ok) throw new Error(`Failed to get pickaxe log: ${res.status}`);
  return res.json();
}

/**
 * Line-range history: commits that touched lines [startLine..endLine] in path.
 * Uses `git log -L <start>,<end>:<path>`.
 */
export async function getGitFileLogRange(cwd: string, path: string, startLine: number, endLine: number): Promise<FileLogEntry[]> {
  if (isTauri()) {
    const raw = await tauriInvoke<Array<{ hash_full: string; hash: string; author: string; date: string; message: string; body: string }>>("git_file_log_range", { cwd, path, startLine, endLine });
    return raw.map(r => ({ hashFull: r.hash_full, hash: r.hash, author: r.author, date: r.date, message: r.message, body: r.body }));
  }
  const qs = `?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}&startLine=${startLine}&endLine=${endLine}`;
  const res = await devFetch(`${DEV_SERVER}/api/git-file-log-range${qs}`);
  if (!res.ok) throw new Error(`Failed to get range log: ${res.status}`);
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
  const res = await devFetch(`${DEV_SERVER}/api/git-file-diff${qs}`);
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
  const res = await devFetch(`${DEV_SERVER}/api/git-discard`, {
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
  const res = await devFetch(`${DEV_SERVER}/api/git-gitignore`, {
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

  const res = await devFetch(`${DEV_SERVER}/api/git-branches?cwd=${encodeURIComponent(cwd)}`);
  if (!res.ok) throw new Error(`Failed to get branches: ${res.status}`);
  return res.json();
}

/**
 * Create a new branch. If checkout=true, switch to it.
 */
export async function gitCreateBranch(
  cwd: string,
  name: string,
  checkout: boolean = true,
  startPoint?: string,
): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("git_create_branch", { cwd, name, checkout, startPoint: startPoint ?? null });
    return;
  }
  const res = await devFetch(`${DEV_SERVER}/api/git-create-branch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, name, checkout, startPoint }),
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
  const res = await devFetch(`${DEV_SERVER}/api/git-switch-branch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, name }),
  });
  if (!res.ok) throw new Error(`Failed to switch branch: ${res.status}`);
}

/**
 * Stash all local changes (staged + unstaged + untracked).
 * Passes an optional custom message (shown in `git stash list`).
 */
export async function gitStash(cwd: string, message?: string): Promise<void> {
  const trimmed = message?.trim() || undefined;
  if (isTauri()) {
    await tauriInvoke("git_stash", { cwd, message: trimmed });
    return;
  }
  const res = await devFetch(`${DEV_SERVER}/api/git-stash`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, message: trimmed }),
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
  const res = await devFetch(`${DEV_SERVER}/api/git-stash-pop`, {
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
 * Run a user-authored shell command in `cwd` (custom automation rules).
 * Returns combined stdout+stderr. Throws on non-zero exit.
 */
export async function shellExec(cwd: string, command: string): Promise<string> {
  if (isTauri()) {
    return tauriInvoke<string>("shell_exec", { cwd, command });
  }
  // Dev-server stub: echo command back so the UI can be tested without Tauri
  console.info(`[dev] shellExec in ${cwd}: ${command}`);
  return `[dev mode] ${command}`;
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
    const res = await devFetch(`${DEV_SERVER}/api/read-gitwandrc`, {
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
 * v2.5 — Write the repo's `.gitwandrc` (or `.gitwandrc.json` if present).
 *
 * The config object is serialized as pretty-printed JSON (2-space indent).
 * Comments in an existing `.gitwandrc` JSONC file are NOT preserved —
 * the round-trip is pure JSON. Documented in the .gitwandrc doc page.
 *
 * Throws on:
 *   - empty `cwd`
 *   - JSON.stringify failures (circular refs, BigInt, …)
 *   - filesystem errors on the Rust / dev-server side
 */
export async function writeGitwandrc(cwd: string, config: object): Promise<void> {
  if (!cwd || !cwd.trim()) {
    throw new Error("writeGitwandrc: cwd must not be empty");
  }
  const content = JSON.stringify(config, null, 2);
  if (isTauri()) {
    await tauriInvoke("write_gitwandrc", { cwd, content });
    return;
  }
  const res = await devFetch(`${DEV_SERVER}/api/write-gitwandrc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, content }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Failed to write .gitwandrc: ${res.status} ${body}`);
  }
}

/**
 * Delete a branch.
 */
export async function gitDeleteBranch(cwd: string, name: string, force: boolean = false): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("git_delete_branch", { cwd, name, force });
    return;
  }
  const res = await devFetch(`${DEV_SERVER}/api/git-delete-branch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, name, force }),
  });
  if (!res.ok) throw new Error(`Failed to delete branch: ${res.status}`);
}

/**
 * Rename a branch (git branch -m oldName newName).
 * Works whether oldName is the current branch or another local branch.
 */
export async function gitRenameBranch(cwd: string, oldName: string, newName: string): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("git_rename_branch", { cwd, oldName, newName });
    return;
  }
  const res = await devFetch(`${DEV_SERVER}/api/git-rename-branch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, oldName, newName }),
  });
  if (!res.ok) throw new Error(`Failed to rename branch: ${res.status}`);
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
  const res = await devFetch(`${DEV_SERVER}/api/git-cherry-pick`, {
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
  await devFetch(`${DEV_SERVER}/api/git-cherry-pick-abort`, {
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
  const res = await devFetch(`${DEV_SERVER}/api/git-cherry-pick-continue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
  return res.json();
}

// ─── Commit context-menu operations (v1.9) ─────────────────

/**
 * Checkout a specific commit SHA — puts the repo in detached HEAD state.
 */
export async function gitCheckoutCommit(cwd: string, sha: string): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("git_checkout_commit", { cwd, sha });
    return;
  }
  const res = await devFetch(`${DEV_SERVER}/api/git-checkout-commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, sha }),
  });
  if (!res.ok) throw new Error(((await res.json()) as any).error ?? `git checkout failed: ${res.status}`);
}

/**
 * Reset the current branch to a specific commit.
 * mode: "soft" | "mixed" | "hard"
 */
export async function gitResetToCommit(cwd: string, sha: string, mode: "soft" | "mixed" | "hard"): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("git_reset_to_commit", { cwd, sha, mode });
    return;
  }
  const res = await devFetch(`${DEV_SERVER}/api/git-reset-to-commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, sha, mode }),
  });
  if (!res.ok) throw new Error(((await res.json()) as any).error ?? `git reset failed: ${res.status}`);
}

/**
 * Revert a commit — creates a new commit undoing its changes.
 * Pass mainline=1 for merge commits (uses -m 1).
 */
export async function gitRevertCommit(cwd: string, sha: string, mainline?: number): Promise<GitPushPullResult> {
  if (isTauri()) {
    return tauriInvoke<GitPushPullResult>("git_revert_commit", { cwd, sha, mainline: mainline ?? null });
  }
  const res = await devFetch(`${DEV_SERVER}/api/git-revert-commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, sha, mainline }),
  });
  return res.json();
}

/**
 * Create a tag at a specific commit SHA.
 * If message is provided, creates an annotated tag; otherwise lightweight.
 */
export async function gitCreateTag(cwd: string, name: string, sha: string, message?: string): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("git_create_tag", { cwd, name, sha, message: message ?? null });
    return;
  }
  const res = await devFetch(`${DEV_SERVER}/api/git-create-tag`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, name, sha, message }),
  });
  if (!res.ok) throw new Error(((await res.json()) as any).error ?? `git tag failed: ${res.status}`);
}

// ─── Tags manager (v1.9) ───────────────────────────────────

export interface GitTag {
  name: string;
  /** Short commit SHA the tag points to (dereferenced for annotated tags). */
  hash: string;
  isAnnotated: boolean;
  /** ISO date string (tagger date for annotated, committer date for lightweight). */
  date: string;
  /** Subject line from the tag message (annotated only). */
  message: string;
}

export async function gitListTags(cwd: string): Promise<GitTag[]> {
  if (isTauri()) {
    const raw = await tauriInvoke<Array<{ name: string; hash: string; is_annotated: boolean; date: string; message: string }>>("git_list_tags", { cwd });
    return raw.map(t => ({ name: t.name, hash: t.hash, isAnnotated: t.is_annotated, date: t.date, message: t.message }));
  }
  const res = await devFetch(`${DEV_SERVER}/api/git-list-tags?cwd=${encodeURIComponent(cwd)}`);
  if (!res.ok) throw new Error(`git list-tags failed: ${res.status}`);
  const raw = await res.json() as Array<{ name: string; hash: string; is_annotated: boolean; date: string; message: string }>;
  return raw.map(t => ({ name: t.name, hash: t.hash, isAnnotated: t.is_annotated, date: t.date, message: t.message }));
}

/** Returns names of local tags that have not been pushed to the given remote. */
export async function gitUnpushedTags(cwd: string, remote = "origin"): Promise<string[]> {
  if (isTauri()) {
    return tauriInvoke<string[]>("git_unpushed_tags", { cwd, remote });
  }
  const res = await devFetch(`${DEV_SERVER}/api/git-unpushed-tags?cwd=${encodeURIComponent(cwd)}&remote=${encodeURIComponent(remote)}`);
  if (!res.ok) throw new Error(`git unpushed-tags failed: ${res.status}`);
  return res.json();
}

export async function gitDeleteTag(cwd: string, name: string): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("git_delete_tag", { cwd, name });
    return;
  }
  const res = await devFetch(`${DEV_SERVER}/api/git-delete-tag`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, name }),
  });
  if (!res.ok) throw new Error(((await res.json()) as any).error ?? `git delete-tag failed: ${res.status}`);
}

/** Push tags to a remote.
 *  mode "all" = --tags (all local tags), "follow" = --follow-tags, "single" = push one tag by name. */
export async function gitPushTags(
  cwd: string,
  remote: string,
  mode: "all" | "follow" | "single" = "all",
  tagName?: string,
): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("git_push_tags", { cwd, remote, mode, tagName: tagName ?? null });
    return;
  }
  const res = await devFetch(`${DEV_SERVER}/api/git-push-tags`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, remote, mode, tagName }),
  });
  if (!res.ok) throw new Error(((await res.json()) as any).error ?? `git push-tags failed: ${res.status}`);
}

export async function gitDeleteRemoteTag(cwd: string, remote: string, name: string): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("git_delete_remote_tag", { cwd, remote, name });
    return;
  }
  const res = await devFetch(`${DEV_SERVER}/api/git-delete-remote-tag`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, remote, name }),
  });
  if (!res.ok) throw new Error(((await res.json()) as any).error ?? `git delete-remote-tag failed: ${res.status}`);
}

// ─── Shortlog (v2.0) ───────────────────────────────────────

export interface ShortlogEntry {
  name: string;
  email: string;
  count: number;
}

/**
 * `git shortlog -sne HEAD` — full-history per-author commit count.
 * Returns entries sorted by count descending.
 */
export async function getGitShortlog(cwd: string): Promise<ShortlogEntry[]> {
  if (isTauri()) {
    return tauriInvoke<ShortlogEntry[]>("git_shortlog", { cwd });
  }
  const res = await fetch(
    `${DEV_SERVER}/api/git-shortlog?cwd=${encodeURIComponent(cwd)}`,
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `git shortlog failed: ${res.status}`);
  }
  return (await res.json()) as ShortlogEntry[];
}

// ─── Clone & Fork (v2.0) ───────────────────────────────────
// Synchronous on both backends — no real-time progress events. The caller
// (CloneModal / ForkModal) shows a spinner while the promise settles.

/**
 * Run `git clone <url> <dest>`. Returns the destination path on success.
 * `dest` must be absolute and not yet exist; git refuses otherwise.
 */
export async function gitClone(url: string, dest: string): Promise<string> {
  if (isTauri()) {
    return tauriInvoke<string>("git_clone", { url, dest }, IPC_TIMEOUT.NETWORK);
  }
  const res = await devFetch(`${DEV_SERVER}/api/git-clone`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, dest }),
  });
  const body = (await res.json()) as { dest?: string; error?: string };
  if (!res.ok || body.error) throw new Error(body.error ?? `git clone failed: ${res.status}`);
  return body.dest ?? dest;
}

/**
 * Run `gh repo fork <url> --clone --remote-name=upstream` inside `parentDir`.
 * Returns the absolute path of the cloned directory (parentDir + /repoName).
 * Requires the GitHub CLI (`gh`) to be installed and authenticated.
 */
export async function ghFork(url: string, parentDir: string): Promise<string> {
  if (isTauri()) {
    return tauriInvoke<string>("gh_fork", { url, parentDir });
  }
  const res = await devFetch(`${DEV_SERVER}/api/gh-fork`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, parentDir }),
  });
  const body = (await res.json()) as { dest?: string; error?: string };
  if (!res.ok || body.error) throw new Error(body.error ?? `gh repo fork failed: ${res.status}`);
  if (!body.dest) throw new Error("gh repo fork: missing dest in response");
  return body.dest;
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
  const res = await devFetch(`${DEV_SERVER}/api/git-stash-list?cwd=${encodeURIComponent(cwd)}`);
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
  const res = await devFetch(`${DEV_SERVER}/api/git-stash-apply`, {
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
  const res = await devFetch(`${DEV_SERVER}/api/git-stash-drop`, {
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
  const res = await devFetch(`${DEV_SERVER}/api/git-stash-show?cwd=${encodeURIComponent(cwd)}&index=${index}`);
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
    // Tauri 2 may serialize the Rust struct field `exit_code` as either
    // snake_case or camelCase depending on the serde config — accept both.
    const raw = await tauriInvoke<Record<string, unknown>>("git_exec", { cwd, args });
    return {
      stdout: (raw.stdout as string) ?? "",
      stderr: (raw.stderr as string) ?? "",
      exitCode: (raw.exitCode ?? raw.exit_code ?? -1) as number,
    };
  }
  const res = await devFetch(`${DEV_SERVER}/api/git-exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, args }),
  });
  const data = await res.json();
  return {
    stdout: data.stdout ?? "",
    stderr: data.stderr ?? "",
    exitCode: data.exitCode ?? data.exit_code ?? -1,
  };
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
  try {
    const res = await fetch(
      `${DEV_SERVER}/api/git-remote-info?cwd=${encodeURIComponent(cwd)}`,
    );
    if (!res.ok) {
      return { name: "origin", url: "", provider: "unknown", owner: "", repo: "" };
    }
    return (await res.json()) as RemoteInfo;
  } catch {
    return { name: "origin", url: "", provider: "unknown", owner: "", repo: "" };
  }
}

// Module-level identity cache — one `gh api user` call per app session.
// Store the Promise so concurrent callers reuse the same in-flight request.
let _currentUserPromise: Promise<string> | null = null;

/**
 * Returns the GitHub login of the currently authenticated user (via `gh` CLI or token).
 * Result is cached for the lifetime of the app session.
 */
export function ghCurrentUser(): Promise<string> {
  if (_currentUserPromise) return _currentUserPromise;
  if (isTauri()) {
    _currentUserPromise = tauriInvoke<string>("gh_current_user");
  } else {
    _currentUserPromise = devFetch(`${DEV_SERVER}/api/gh-current-user`).then(
      async (res) => {
        if (!res.ok) throw new Error(`Failed to get current user: ${res.status}`);
        return res.json() as Promise<string>;
      }
    );
  }
  return _currentUserPromise;
}

/** Returns the list of file paths changed by a PR (lazy — call only when needed). */
export async function ghPrFiles(repoPath: string, prNumber: number): Promise<string[]> {
  if (isTauri()) {
    return tauriInvoke<string[]>("pr_files", { cwd: repoPath, number: prNumber });
  }
  const res = await devFetch(
    `${DEV_SERVER}/api/pr-files?repo=${encodeURIComponent(repoPath)}&pr=${prNumber}`
  );
  if (!res.ok) throw new Error(`Failed to get PR files: ${res.status}`);
  return res.json() as Promise<string[]>;
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
  /** Logins of users assigned to this PR. */
  assignees: string[];
  /** Logins of users requested as reviewers (pending review). */
  reviewRequested: string[];
  /** "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "" */
  reviewDecision: string;
  /** "CLEAN" | "BLOCKED" | "DIRTY" | "HAS_HOOKS" | "UNKNOWN" | "" */
  mergeStateStatus: string;
  /** Overall CI rollup: "SUCCESS" | "FAILURE" | "PENDING" | "" */
  checksRollup: string;
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
        assignees: string[];
        review_requested: string[];
        review_decision: string;
        merge_state_status: string;
        checks_rollup: string;
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
      assignees: pr.assignees ?? [],
      reviewRequested: pr.review_requested ?? [],
      reviewDecision: pr.review_decision ?? "",
      mergeStateStatus: pr.merge_state_status ?? "",
      checksRollup: pr.checks_rollup ?? "",
    }));
  }
  // Browser dev mode — call dev server
  const res = await devFetch(`${DEV_SERVER}/api/gh-list-prs?cwd=${encodeURIComponent(cwd)}&state=${state}`);
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
    assignees: pr.assignees ?? [],
    reviewRequested: pr.review_requested ?? [],
    reviewDecision: pr.review_decision ?? "",
    mergeStateStatus: pr.merge_state_status ?? "",
    checksRollup: pr.checks_rollup ?? "",
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
  reviewers: string[] = [],
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
      review_decision: string;
      merge_state_status: string;
      checks_rollup: string;
    }>("gh_create_pr", { cwd, title, body, base, draft, reviewers });
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
      assignees: [],
      reviewRequested: [],
      reviewDecision: raw.review_decision ?? "",
      mergeStateStatus: raw.merge_state_status ?? "",
      checksRollup: raw.checks_rollup ?? "",
    };
  }
  // Browser dev mode — call dev server (uses GitHub REST API directly)
  const res = await devFetch(`${DEV_SERVER}/api/gh-create-pr`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, title, body, base, draft, reviewers }),
  });
  const raw = await res.json();
  if (!res.ok || raw.error) {
    throw new Error(raw.error || `gh create pr failed: ${res.status}`);
  }
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
    assignees: [],
    reviewRequested: [],
    reviewDecision: raw.review_decision ?? "",
    mergeStateStatus: raw.merge_state_status ?? "",
    checksRollup: raw.checks_rollup ?? "",
  };
}

/**
 * Reviewer suggestion (assignee/collaborator candidate from the GitHub repo).
 */
export interface ReviewerCandidate {
  login: string;
  name?: string | null;
  avatarUrl?: string | null;
}

/**
 * List candidate reviewers for the current repo (requires `gh` CLI).
 * Returns assignees from `gh api /repos/:owner/:repo/assignees` — i.e. users with push access.
 */
export async function ghListReviewerCandidates(cwd: string): Promise<ReviewerCandidate[]> {
  if (isTauri()) {
    const raw = await tauriInvoke<
      Array<{ login: string; name?: string | null; avatar_url?: string | null }>
    >("gh_list_reviewer_candidates", { cwd });
    return raw.map((u) => ({
      login: u.login,
      name: u.name ?? null,
      avatarUrl: u.avatar_url ?? null,
    }));
  }
  // Browser dev mode — call dev server (uses GitHub REST API directly)
  const res = await devFetch(`${DEV_SERVER}/api/gh-reviewer-candidates?cwd=${encodeURIComponent(cwd)}`);
  if (!res.ok) return [];
  const raw = await res.json();
  if (!Array.isArray(raw)) return [];
  return raw.map((u: { login: string; name?: string | null; avatar_url?: string | null }) => ({
    login: u.login,
    name: u.name ?? null,
    avatarUrl: u.avatar_url ?? null,
  }));
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
  const resp = await devFetch(`${DEV_SERVER}/api/gh-merge-pr`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, number, method }),
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error);
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
  const res = await devFetch(`${DEV_SERVER}/api/gh-pr-detail?cwd=${encodeURIComponent(cwd)}&number=${number}`);
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
  const res = await devFetch(`${DEV_SERVER}/api/gh-pr-diff?cwd=${encodeURIComponent(cwd)}&number=${number}`);
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
  const res = await devFetch(`${DEV_SERVER}/api/gh-pr-checks?cwd=${encodeURIComponent(cwd)}&number=${number}`);
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
  const res = await devFetch(`${DEV_SERVER}/api/gh-pr-comments?cwd=${encodeURIComponent(cwd)}&number=${prNumber}`);
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
  const res = await devFetch(`${DEV_SERVER}/api/gh-pr-comment`, {
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
  const res = await devFetch(`${DEV_SERVER}/api/gh-pr-comment?id=${commentId}`, {
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
  const res = await devFetch(`${DEV_SERVER}/api/gh-pr-submit-review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, number: prNumber, ...opts }),
  });
  // Prefer the server's JSON error body over a generic status message.
  const raw = await res.json().catch(() => null);
  if (!res.ok || (raw && raw.error)) {
    const msg = raw?.error || `gh pr submit review failed (HTTP ${res.status})`;
    throw new Error(msg);
  }
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
  const res = await devFetch(`${DEV_SERVER}/api/git-file-count?cwd=${encodeURIComponent(cwd)}`);
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

// ─── Claude Code CLI wrapper ─────────────────────────────
//
// Thin wrappers around the Rust/dev-server commands that shell out to the
// user's locally-installed `claude` binary (official Claude Code CLI).
// This is how we piggyback on the user's Max/Pro subscription without
// implementing OAuth ourselves — same trick as Solo / SoloTerm.

export interface ClaudeCliInfo {
  /** True when the `claude` binary was found on disk. */
  found: boolean;
  /** Absolute path to the binary, or "" if not found. */
  path: string;
  /** Raw `claude --version` output. */
  version: string;
  /** True if a ping prompt answered without an auth error. */
  logged_in: boolean;
  /** Machine-readable status: "ok" | "not_found" | "not_logged_in" | "error". */
  status: "ok" | "not_found" | "not_logged_in" | "error" | string;
  /** Optional error detail line. */
  detail: string;
}

/**
 * Detect whether the Claude Code CLI is installed and authenticated.
 * Safe to call on app boot — returns `found: false` instead of throwing
 * when the binary is missing.
 */
export async function detectClaudeCli(): Promise<ClaudeCliInfo> {
  if (isTauri()) {
    return tauriInvoke<ClaudeCliInfo>("detect_claude_cli");
  }
  try {
    const res = await devFetch(`${DEV_SERVER}/api/claude-cli-detect`);
    if (res.ok) return (await res.json()) as ClaudeCliInfo;
  } catch {
    // Dev server unavailable
  }
  return {
    found: false,
    path: "",
    version: "",
    logged_in: false,
    status: "not_found",
    detail: "",
  };
}

/**
 * Run a prompt through the local Claude Code CLI.
 *
 * @param prompt User prompt (main content).
 * @param systemPrompt Optional system-level instructions (prepended as a
 *                     `# System` section since `claude -p` has no separate
 *                     system channel).
 * @param cwd Optional working directory for the CLI process.
 * @param outputFormat "text" (default) or "json".
 * @returns Raw stdout from the CLI.
 */
export async function claudeCliPrompt(
  prompt: string,
  systemPrompt?: string,
  cwd?: string,
  outputFormat: "text" | "json" = "text",
): Promise<string> {
  if (isTauri()) {
    return tauriInvoke<string>("claude_cli_prompt", {
      prompt,
      systemPrompt,
      cwd,
      outputFormat,
    }, IPC_TIMEOUT.NONE);
  }
  const res = await devFetch(`${DEV_SERVER}/api/claude-cli-prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, systemPrompt, cwd, outputFormat }),
  });
  if (!res.ok) {
    let msg = `claude CLI error ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return await res.text();
}

// ─── Codex CLI provider (v2.0) ─────────────────────────────
// Mirrors the Claude CLI shape — same struct, different binary. Codex CLI
// uses `codex exec "<prompt>"` for non-interactive runs and authenticates
// via OAuth (`codex login`) or `OPENAI_API_KEY`.

export interface CodexCliInfo {
  found: boolean;
  path: string;
  version: string;
  logged_in: boolean;
  status: "ok" | "not_found" | "not_logged_in" | "error" | string;
  detail: string;
}

/**
 * Detect whether the OpenAI Codex CLI is installed and authenticated.
 * Safe to call on app boot.
 */
export async function detectCodexCli(): Promise<CodexCliInfo> {
  if (isTauri()) {
    return tauriInvoke<CodexCliInfo>("detect_codex_cli");
  }
  try {
    const res = await devFetch(`${DEV_SERVER}/api/codex-cli-detect`);
    if (res.ok) return (await res.json()) as CodexCliInfo;
  } catch {
    // Dev server unavailable
  }
  return {
    found: false,
    path: "",
    version: "",
    logged_in: false,
    status: "not_found",
    detail: "",
  };
}

/**
 * Run a prompt through the local Codex CLI (`codex exec`).
 */
export async function codexCliPrompt(
  prompt: string,
  systemPrompt?: string,
  cwd?: string,
): Promise<string> {
  if (isTauri()) {
    return tauriInvoke<string>("codex_cli_prompt", {
      prompt,
      systemPrompt,
      cwd,
    }, IPC_TIMEOUT.NONE);
  }
  const res = await devFetch(`${DEV_SERVER}/api/codex-cli-prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, systemPrompt, cwd }),
  });
  if (!res.ok) {
    let msg = `codex CLI error ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return await res.text();
}

/**
 * Open the native terminal with `claude login` so the user can complete
 * the OAuth-style setup. Not a PTY integration — just a one-shot bootstrap.
 */
export async function claudeCliLogin(): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("claude_cli_login");
    return;
  }
  const res = await devFetch(`${DEV_SERVER}/api/claude-cli-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) {
    let msg = `claude login failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
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
    const res = await devFetch(`${DEV_SERVER}/api/preview-merge`, {
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

// ─── Git Hooks ──────────────────────────────────────────

export interface HookEntry {
  name: string;
  enabled: boolean;
  executable: boolean;
  /** First line of the hook script (shebang / short preview). */
  preview: string;
}

/** List all Git hooks for the repository. */
export async function gitHookList(cwd: string): Promise<HookEntry[]> {
  if (isTauri()) {
    return tauriInvoke<HookEntry[]>("git_hook_list", { cwd });
  }
  const res = await devFetch(`${DEV_SERVER}/api/git-hook-list?cwd=${encodeURIComponent(cwd)}`);
  if (!res.ok) throw new Error(`Failed to list hooks: ${res.status}`);
  return res.json();
}

/** Enable or disable a hook. */
export async function gitHookToggle(cwd: string, name: string, enabled: boolean): Promise<void> {
  if (isTauri()) {
    return tauriInvoke("git_hook_toggle", { cwd, name, enabled });
  }
  const res = await devFetch(`${DEV_SERVER}/api/git-hook-toggle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, name, enabled }),
  });
  if (!res.ok) throw new Error(`Failed to toggle hook: ${res.status}`);
}

/** Create or overwrite a hook script. */
export async function gitHookCreate(cwd: string, name: string, content: string): Promise<void> {
  if (isTauri()) {
    return tauriInvoke("git_hook_create", { cwd, name, content });
  }
  const res = await devFetch(`${DEV_SERVER}/api/git-hook-create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, name, content }),
  });
  if (!res.ok) throw new Error(`Failed to create hook: ${res.status}`);
}

/** Delete a hook (both enabled and disabled variants). */
export async function gitHookDelete(cwd: string, name: string): Promise<void> {
  if (isTauri()) {
    return tauriInvoke("git_hook_delete", { cwd, name });
  }
  const res = await devFetch(`${DEV_SERVER}/api/git-hook-delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, name }),
  });
  if (!res.ok) throw new Error(`Failed to delete hook: ${res.status}`);
}

// ─── Workspaces ─────────────────────────────────────────

export interface WorkspaceRepo {
  path: string;
  name: string;
}

export interface WorkspaceConfig {
  name: string;
  repos: WorkspaceRepo[];
}

export interface WorkspaceRepoStatus {
  path: string;
  name: string;
  branch: string;
  ahead: number;
  behind: number;
  modified: number;
  error: string | null;
}

export interface WorkspaceWipItem {
  path: string;
  name: string;
  branch: string;
  ahead: number;
  behind: number;
  /** Files staged for commit (index modified). */
  stagedCount: number;
  /** Tracked files modified in working tree (not staged). */
  unstagedCount: number;
  /** Untracked files not ignored by .gitignore. */
  untrackedCount: number;
  /** ISO 8601 committer date of HEAD commit. Empty on brand-new repos. */
  lastCommitAt: string;
  /** True when no upstream is configured for the current branch. */
  hasNoUpstream: boolean;
  error: string | null;
  /** Relative paths of staged and unstaged changed files (excludes untracked). */
  changedFiles: string[];
}

/** Per-repo container for the Launchpad PRs panel. */
export interface WorkspaceRepoPrs {
  /** Filesystem path to the repo. */
  repoPath: string;
  /** Display name for the repo. */
  repoName: string;
  /** Open pull requests (empty on error or when none exist). */
  prs: PullRequest[];
  /** Error if gh pr list failed for this repo (null = OK). */
  error: string | null;
}

/**
 * A GitHub issue as returned by `workspace_issues_all`.
 * All fields are camelCase — the Rust `Issue` struct uses `rename_all = "camelCase"`.
 */
export interface Issue {
  number: number;
  title: string;
  state: string;
  author: string;
  assignees: string[];
  labels: string[];
  url: string;
  createdAt: string;
  updatedAt: string;
  milestone: string;
}

/** Per-repo container for the Launchpad Issues panel. */
export interface WorkspaceRepoIssues {
  /** Filesystem path to the repo. */
  repoPath: string;
  /** Display name for the repo. */
  repoName: string;
  /** Open issues filtered by `filter`. */
  issues: Issue[];
  /** The filter that was applied: "" | "assigned" | "mentioned" | "created". */
  filter: string;
  /** Error if gh issue list failed for this repo (null = OK). */
  error: string | null;
}

/** Read a .gitwand-workspace.json from the given directory. */
export async function workspaceRead(path: string): Promise<WorkspaceConfig> {
  if (isTauri()) {
    return tauriInvoke<WorkspaceConfig>("workspace_read", { path });
  }
  const res = await devFetch(`${DEV_SERVER}/api/workspace-read?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`Failed to read workspace: ${res.status}`);
  return res.json();
}

/** Write a .gitwand-workspace.json to the given directory. */
export async function workspaceWrite(path: string, workspace: WorkspaceConfig): Promise<void> {
  if (isTauri()) {
    return tauriInvoke("workspace_write", { path, workspace });
  }
  const res = await devFetch(`${DEV_SERVER}/api/workspace-write`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, workspace }),
  });
  if (!res.ok) throw new Error(`Failed to write workspace: ${res.status}`);
}

/** Get the status of all repos in a workspace. */
export async function workspaceStatusAll(repos: WorkspaceRepo[]): Promise<WorkspaceRepoStatus[]> {
  if (isTauri()) {
    return tauriInvoke<WorkspaceRepoStatus[]>("workspace_status_all", { repos });
  }
  const res = await devFetch(`${DEV_SERVER}/api/workspace-status-all`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repos }),
  });
  if (!res.ok) throw new Error(`Failed to get workspace status: ${res.status}`);
  return res.json();
}

/** Fetch all repos in a workspace and return updated statuses. */
export async function workspaceFetchAll(repos: WorkspaceRepo[]): Promise<WorkspaceRepoStatus[]> {
  if (isTauri()) {
    return tauriInvoke<WorkspaceRepoStatus[]>("workspace_fetch_all", { repos }, IPC_TIMEOUT.NETWORK);
  }
  const res = await devFetch(`${DEV_SERVER}/api/workspace-fetch-all`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repos }),
  });
  if (!res.ok) throw new Error(`Failed to fetch workspace: ${res.status}`);
  return res.json();
}

/** Pull all repos in a workspace and return updated statuses. */
export async function workspacePullAll(repos: WorkspaceRepo[]): Promise<WorkspaceRepoStatus[]> {
  if (isTauri()) {
    return tauriInvoke<WorkspaceRepoStatus[]>("workspace_pull_all", { repos }, IPC_TIMEOUT.NETWORK);
  }
  const res = await devFetch(`${DEV_SERVER}/api/workspace-pull-all`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repos }),
  });
  if (!res.ok) throw new Error(`Failed to pull workspace: ${res.status}`);
  return res.json();
}

/** Get detailed WIP status (staged/unstaged/untracked/last-commit/upstream) for all repos. */
export async function workspaceWipAll(repos: WorkspaceRepo[]): Promise<WorkspaceWipItem[]> {
  if (isTauri()) {
    return tauriInvoke<WorkspaceWipItem[]>("workspace_wip_all", { repos });
  }
  const res = await devFetch(`${DEV_SERVER}/api/workspace-wip-all`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repos }),
  });
  if (!res.ok) throw new Error(`Failed to get workspace WIP: ${res.status}`);
  const raw = (await res.json()) as Array<Record<string, unknown>>;
  return raw.map((item) => ({
    path: (item.path as string) ?? "",
    name: (item.name as string) ?? "",
    branch: (item.branch as string) ?? "",
    ahead: (item.ahead as number) ?? 0,
    behind: (item.behind as number) ?? 0,
    stagedCount: (item.staged_count as number) ?? 0,
    unstagedCount: (item.unstaged_count as number) ?? 0,
    untrackedCount: (item.untracked_count as number) ?? 0,
    lastCommitAt: (item.last_commit_at as string) ?? "",
    hasNoUpstream: (item.has_no_upstream as boolean) ?? false,
    error: (item.error as string | null) ?? null,
    changedFiles: (item.changed_files as string[]) ?? [],
  }));
}

/** Map a raw snake_case PR object (from Tauri or dev-server) to the typed PullRequest interface. */
function mapRawPr(pr: Record<string, unknown>): PullRequest {
  return {
    number: (pr.number as number) ?? 0,
    title: (pr.title as string) ?? "",
    state: (pr.state as string) ?? "",
    author: (pr.author as string) ?? "",
    branch: (pr.branch as string) ?? "",
    base: (pr.base as string) ?? "",
    draft: (pr.draft as boolean) ?? false,
    createdAt: (pr.created_at as string) ?? "",
    updatedAt: (pr.updated_at as string) ?? "",
    url: (pr.url as string) ?? "",
    additions: (pr.additions as number) ?? 0,
    deletions: (pr.deletions as number) ?? 0,
    labels: (pr.labels as string[]) ?? [],
    assignees: (pr.assignees as string[]) ?? [],
    reviewRequested: (pr.review_requested as string[]) ?? [],
    reviewDecision: (pr.review_decision as string) ?? "",
    mergeStateStatus: (pr.merge_state_status as string) ?? "",
    checksRollup: (pr.checks_rollup as string) ?? "",
  };
}

/** Aggregate open PRs from all repos in a workspace (requires `gh` CLI). */
export async function workspacePrsAll(repos: WorkspaceRepo[]): Promise<WorkspaceRepoPrs[]> {
  if (isTauri()) {
    // Tauri bridge: outer fields are camelCase (serde rename_all),
    // but nested PullRequest fields are still snake_case.
    const raw = await tauriInvoke<
      Array<{
        repoPath: string;
        repoName: string;
        prs: Array<Record<string, unknown>>;
        error: string | null;
      }>
    >("workspace_prs_all", { repos });
    return raw.map((item) => ({
      repoPath: item.repoPath,
      repoName: item.repoName,
      prs: item.prs.map(mapRawPr),
      error: item.error,
    }));
  }
  const res = await devFetch(`${DEV_SERVER}/api/workspace-prs-all`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repos }),
  });
  if (!res.ok) throw new Error(`Failed to get workspace PRs: ${res.status}`);
  const raw = (await res.json()) as Array<Record<string, unknown>>;
  return raw.map((item) => ({
    repoPath: (item.repo_path as string) ?? "",
    repoName: (item.repo_name as string) ?? "",
    prs: ((item.prs as Array<Record<string, unknown>>) ?? []).map(mapRawPr),
    error: (item.error as string | null) ?? null,
  }));
}

/**
 * Aggregate open GitHub Issues from all repos in a workspace (requires `gh` CLI).
 * @param filter — "" (all), "assigned", "mentioned", or "created"
 */
export async function workspaceIssuesAll(
  repos: WorkspaceRepo[],
  filter: string,
): Promise<WorkspaceRepoIssues[]> {
  if (isTauri()) {
    // Both outer fields (repoPath, repoName) and inner Issue fields are camelCase —
    // Issue struct has rename_all = "camelCase". Direct cast, no mapping needed.
    return tauriInvoke<WorkspaceRepoIssues[]>("workspace_issues_all", { repos, filter });
  }
  const res = await devFetch(`${DEV_SERVER}/api/workspace-issues-all`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repos, filter }),
  });
  if (!res.ok) throw new Error(`Failed to get workspace issues: ${res.status}`);
  const raw = (await res.json()) as Array<Record<string, unknown>>;
  // Dev-server uses snake_case for outer fields; issues array is already camelCase.
  return raw.map((item) => ({
    repoPath: (item.repo_path as string) ?? "",
    repoName: (item.repo_name as string) ?? "",
    issues: ((item.issues as Issue[]) ?? []),
    filter: (item.filter as string) ?? "",
    error: (item.error as string | null) ?? null,
  }));
}

/** Get the cross-worktree status for a repository (ahead/behind + modified per worktree). */
export async function gitWorktreeStatusAll(cwd: string): Promise<WorkspaceRepoStatus[]> {
  if (isTauri()) {
    return tauriInvoke<WorkspaceRepoStatus[]>("git_worktree_status_all", { cwd });
  }
  const res = await devFetch(`${DEV_SERVER}/api/git-worktree-status-all?cwd=${encodeURIComponent(cwd)}`);
  if (!res.ok) throw new Error(`Failed to get worktree status: ${res.status}`);
  return res.json();
}

// ─── Worktrees ──────────────────────────────────────────

export interface WorktreeEntry {
  path: string;
  branch: string;
  head: string;
  is_main: boolean;
  is_locked: boolean;
  is_bare: boolean;
}

/** List all git worktrees for the given repo. */
export async function gitWorktreeList(cwd: string): Promise<WorktreeEntry[]> {
  if (isTauri()) {
    return tauriInvoke<WorktreeEntry[]>("git_worktree_list", { cwd });
  }
  const res = await devFetch(`${DEV_SERVER}/api/git-worktree-list?cwd=${encodeURIComponent(cwd)}`);
  if (!res.ok) throw new Error(`Failed to list worktrees: ${res.status}`);
  return res.json();
}

/** Add a new worktree. Pass `newBranch` to create a new branch at the worktree. */
export async function gitWorktreeAdd(
  cwd: string,
  path: string,
  branch: string,
  newBranch?: string,
): Promise<WorktreeEntry> {
  if (isTauri()) {
    return tauriInvoke<WorktreeEntry>("git_worktree_add", {
      cwd,
      path,
      branch,
      new_branch: newBranch ?? null,
    });
  }
  const res = await devFetch(`${DEV_SERVER}/api/git-worktree-add`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, path, branch, new_branch: newBranch ?? null }),
  });
  if (!res.ok) throw new Error(`Failed to add worktree: ${res.status}`);
  return res.json();
}

/** Remove a worktree. Set `force` to true to discard uncommitted changes. */
export async function gitWorktreeRemove(cwd: string, path: string, force?: boolean): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("git_worktree_remove", { cwd, path, force: force ?? false });
    return;
  }
  const res = await devFetch(`${DEV_SERVER}/api/git-worktree-remove`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, path, force: force ?? false }),
  });
  if (!res.ok) throw new Error(`Failed to remove worktree: ${res.status}`);
}

/** Prune stale worktree administrative files. */
export async function gitWorktreePrune(cwd: string): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("git_worktree_prune", { cwd });
    return;
  }
  const res = await devFetch(`${DEV_SERVER}/api/git-worktree-prune`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
  if (!res.ok) throw new Error(`Failed to prune worktrees: ${res.status}`);
}

// ─── Agent Sessions ───────────────────────────────────────

export interface AgentSession {
  /** Absolute path of the worktree. */
  path: string;
  /** Short branch name. */
  branch: string;
  /** Detected tool: "claude" | "cursor" | "windsurf" | "other". */
  tool: string;
  /** Whether a process for this tool is currently running in this cwd. */
  active: boolean;
  ahead: number;
  behind: number;
  modified: number;
}

/** List agent sessions for all worktrees of the repo at `cwd`. */
export async function agentSessionList(cwd: string): Promise<AgentSession[]> {
  if (isTauri()) {
    return tauriInvoke<AgentSession[]>("agent_session_list", { cwd });
  }
  const res = await devFetch(`${DEV_SERVER}/api/agent-session-list?cwd=${encodeURIComponent(cwd)}`);
  if (!res.ok) throw new Error(`Failed to list agent sessions: ${res.status}`);
  return res.json();
}

/** Launch the given agent CLI (defaults to `claude`) in the worktree at `cwd`. */
export async function agentSessionLaunch(cwd: string, tool: string): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("agent_session_launch", { cwd, tool });
    return;
  }
  const res = await devFetch(`${DEV_SERVER}/api/agent-session-launch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, tool }),
  });
  if (!res.ok) throw new Error(`Failed to launch agent session: ${res.status}`);
}

// ─── Submodules ──────────────────────────────────────────

export interface SubmoduleEntry {
  path: string;
  url: string;
  sha: string;
  branch: string | null;
  /** "clean" | "modified" | "uninitialized" */
  status: "clean" | "modified" | "uninitialized";
}

/** List all submodules declared in .gitmodules with their live status. */
export async function gitSubmoduleList(cwd: string): Promise<SubmoduleEntry[]> {
  if (isTauri()) {
    return tauriInvoke<SubmoduleEntry[]>("git_submodule_list", { cwd });
  }
  const res = await devFetch(`${DEV_SERVER}/api/git-submodule-list?cwd=${encodeURIComponent(cwd)}`);
  if (!res.ok) throw new Error(`Failed to list submodules: ${res.status}`);
  return res.json();
}

/** Run `git submodule init`. */
export async function gitSubmoduleInit(cwd: string): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("git_submodule_init", { cwd });
    return;
  }
  const res = await devFetch(`${DEV_SERVER}/api/git-submodule-init`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
  if (!res.ok) throw new Error(`Failed to init submodules: ${res.status}`);
}

/** Run `git submodule update`, optionally with --init and --recursive. */
export async function gitSubmoduleUpdate(
  cwd: string,
  init: boolean,
  recursive: boolean,
): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("git_submodule_update", { cwd, init, recursive });
    return;
  }
  const res = await devFetch(`${DEV_SERVER}/api/git-submodule-update`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, init, recursive }),
  });
  if (!res.ok) throw new Error(`Failed to update submodules: ${res.status}`);
}

/** Add a new submodule. */
export async function gitSubmoduleAdd(cwd: string, url: string, path: string): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("git_submodule_add", { cwd, url, path });
    return;
  }
  const res = await devFetch(`${DEV_SERVER}/api/git-submodule-add`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, url, path }),
  });
  if (!res.ok) throw new Error(`Failed to add submodule: ${res.status}`);
}

// ─── Updater ────────────────────────────────────────────

export interface UpdateInfo {
  /** New version string, e.g. "1.10.0" */
  version: string;
  /** Release notes in plain text / Markdown (may be empty) */
  body: string;
  /**
   * How the update is installed (v2.0):
   *   - `auto`: Tauri plugin downloads + replaces the binary in place. Used
   *     for the stable channel — endpoints are baked into tauri.conf.json,
   *     so the plugin's `check()` only knows that one URL.
   *   - `manual`: we fetched a separate manifest (e.g. `latest-beta.json`)
   *     and the user has to download from the GitHub release page. The
   *     plugin can't be told to use a different endpoint at runtime, so
   *     manual is the honest path until either Tauri exposes that or we
   *     run a redirect server.
   */
  installMethod: "auto" | "manual";
  /** Browser-opens-this URL when `installMethod === "manual"`. */
  downloadUrl?: string;
}

/**
 * Compare two semver strings (X.Y.Z, optionally `-prerelease.N`).
 * Returns -1 / 0 / +1. Pre-release < release for the same X.Y.Z.
 * Crude string compare on the prerelease tail — adequate for our
 * `1.7.0` vs `1.7.0-beta.1` case; not a full semver implementation.
 */
function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const stripped = v.replace(/^v/, "");
    const [main, pre = ""] = stripped.split("-");
    const parts = main.split(".").map((p) => parseInt(p, 10) || 0);
    return { parts, pre };
  };
  const va = parse(a);
  const vb = parse(b);
  for (let i = 0; i < 3; i++) {
    const da = va.parts[i] ?? 0;
    const db = vb.parts[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  if (va.pre === vb.pre) return 0;
  if (va.pre === "") return 1; // 1.7.0 > 1.7.0-beta.1
  if (vb.pre === "") return -1;
  return va.pre.localeCompare(vb.pre);
}

/** GitHub Pages-hosted manifest for the beta channel (v2.0). */
const BETA_MANIFEST_URL = "https://devlint.github.io/GitWand/update/latest-beta.json";

/**
 * Fetch the beta manifest manually and return an `UpdateInfo` if it's
 * newer than `currentVersion`. Used when the user opts into the beta
 * channel — see UpdateInfo.installMethod for why this can't reuse the
 * Tauri plugin's `check()`.
 */
export async function fetchBetaUpdate(currentVersion: string): Promise<UpdateInfo | null> {
  try {
    const res = await fetch(BETA_MANIFEST_URL, { cache: "no-store" });
    if (!res.ok) return null;
    const manifest = (await res.json()) as { version?: string; notes?: string };
    if (!manifest.version) return null;
    if (compareVersions(manifest.version, currentVersion) <= 0) return null;
    return {
      version: manifest.version,
      body: manifest.notes ?? "",
      installMethod: "manual",
      downloadUrl: `https://github.com/devlint/GitWand/releases/tag/v${manifest.version}`,
    };
  } catch {
    return null;
  }
}

// Keep a reference to the Update object so installUpdate() can use it.
// The @tauri-apps/plugin-updater `Update` object carries the download handle.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pendingUpdate: any = null;

/**
 * Check for app updates via the Tauri updater plugin.
 *
 * With `"dialog": false` in tauri.conf.json, Tauri returns the update
 * metadata without showing any native UI. We show our own modal instead.
 *
 * Returns `null` when:
 * - Running in browser (dev) mode
 * - No update is available
 * - The network request failed (silently ignored)
 */
export async function checkForUpdates(): Promise<UpdateInfo | null> {
  if (!isTauri()) return null;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (update?.available) {
      _pendingUpdate = update;
      return {
        version: update.version,
        body: update.body ?? "",
        installMethod: "auto",
      };
    }
    return null;
  } catch {
    // Silently ignore — updater errors shouldn't affect the app UX.
    return null;
  }
}

/**
 * Download the pending update, install it, then relaunch the app.
 * Must only be called after `checkForUpdates()` returned a non-null value.
 *
 * Progress callback receives fraction 0–1 as bytes are downloaded.
 *
 * Note: `downloadAndInstall()` replaces the binary on disk but does NOT
 * automatically relaunch — we call `relaunch()` from plugin-process ourselves
 * so the user sees the new version without having to quit manually.
 */
export async function installUpdate(
  onProgress?: (fraction: number) => void
): Promise<void> {
  if (!isTauri() || !_pendingUpdate) return;
  let downloaded = 0;
  let contentLength = 0;
  await _pendingUpdate.downloadAndInstall((event: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => {
    if (event.event === "Started") {
      contentLength = event.data?.contentLength ?? 0;
    } else if (event.event === "Progress") {
      downloaded += event.data?.chunkLength ?? 0;
      if (contentLength > 0 && onProgress) {
        onProgress(downloaded / contentLength);
      }
    } else if (event.event === "Finished") {
      // Ensure bar reaches 100% even when server omits Content-Length.
      onProgress?.(1);
    }
  });

  // On macOS, give Gatekeeper up to 3 s to finish its signature/quarantine
  // check on the newly-written binary before we relaunch. Without this delay,
  // relaunch() can throw "operation not permitted".
  //
  // On Windows the updater uses the NSIS installer which kills and restarts
  // the process itself — our relaunch() below is a no-op safety net only.
  // On Linux the binary is replaced in-place like macOS but without Gatekeeper.
  const isMac = navigator.userAgent.toLowerCase().includes("macos") ||
                (navigator as any).userAgentData?.platform?.toLowerCase() === "macos";
  if (isMac) {
    await new Promise<void>(resolve => setTimeout(resolve, 3000));
  }

  try {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (err) {
    // relaunch() failed — surface the error so the caller can show it
    // rather than leaving the modal stuck on a spinner forever.
    throw new Error(
      `Update downloaded successfully but automatic relaunch failed: ${err}.\n` +
      `Please quit and reopen GitWand to apply the update.`
    );
  }
}

