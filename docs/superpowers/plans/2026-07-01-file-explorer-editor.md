# File Explorer/Editor Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Terminal-style panel to GitWand desktop that browses the full repo file tree (`.gitignore`-aware) and opens files in a lightweight CodeMirror 6 editor with save and read-only Git status badges.

**Architecture:** A new Rust command `list_repo_tree` (built on `git ls-files -z --cached --others --exclude-standard`) feeds a new `useRepoFileTree` composable; a new `useFileExplorer` composable manages per-repo open-file tabs (mirroring `useTerminalSessions`); `FileExplorerPanel.vue` clones `TerminalPanel.vue`'s floating/bottom/fullscreen layout shell and hosts the tree + tab strip + a lazy-loaded CodeMirror 6 editor.

**Tech Stack:** Tauri 2 (Rust), Vue 3 `<script setup>`, CodeMirror 6 (`codemirror`, `@codemirror/language-data`, `@codemirror/theme-one-dark`).

Design doc: `docs/superpowers/specs/2026-07-01-file-explorer-editor-design.md`.

## Global Constraints

- No Node.js modules may leak into `packages/core` — not touched by this plan (it's `apps/desktop`-only).
- Git commands: always `.args([...])` arrays, never string interpolation (AGENTS.md security rule).
- Every filesystem operation on a user path must go through `safe_repo_path()` — N/A here for `list_repo_tree` (it returns paths, not content, exactly like the existing `list_dir` doesn't call it either); `read_file`/`write_file` already enforce it and are reused unchanged.
- Every new `#[tauri::command]` needs: (1) registration in `lib.rs`'s `generate_handler!`, (2) a typed wrapper in `apps/desktop/src/utils/backend.ts`, (3) a `dev-server.mjs` mock route — same PR, per `apps/desktop/CLAUDE.md`.
- Settings: any new field goes in **both** `useSettings.ts`'s `AppSettings` and `SettingsPanel.vue`'s local `Settings` interface in the same commit.
- No unconditional `setInterval`; no `{ deep: true }` watchers on large reactive structures; any `v-if`-gated panel (default off) must be `defineAsyncComponent`-loaded (apps/desktop/CLAUDE.md perf invariants).
- Any new Tauri command that can return >1MB must cap/truncate — `list_repo_tree` caps at `MAX_REPO_TREE_ENTRIES = 20_000` and reports `truncated: true`.
- Every user-visible string needs a key in all 5 locales: `en.ts`, `fr.ts`, `es.ts`, `pt-BR.ts`, `zh-CN.ts`.
- No native `confirm()` — unsaved-changes prompts go through the existing `askConfirm` (`App.vue`, injected as `"askConfirm"`).
- v1 scope: no Git actions (stage/discard/revert) from this panel, no binary/image preview (placeholder text instead), no LSP/autocomplete — CodeMirror with syntax highlighting only.

---

### Task 1: Rust — `list_repo_tree` command

**Files:**
- Modify: `apps/desktop/src-tauri/src/types.rs` (add `RepoTreeNode`, `RepoTreeResult`)
- Modify: `apps/desktop/src-tauri/src/git/parse.rs` (add `insert_repo_path`, `sort_repo_tree` helpers + their tests)
- Modify: `apps/desktop/src-tauri/src/commands/files.rs` (add `build_repo_tree` + `list_repo_tree` command + its tests)
- Modify: `apps/desktop/src-tauri/src/lib.rs` (register the command)

**Interfaces:**
- Produces: `list_repo_tree(cwd: String) -> Result<RepoTreeResult, String>` (Tauri command), `RepoTreeNode { path: String, name: String, kind: String, children: Vec<RepoTreeNode> }`, `RepoTreeResult { root: RepoTreeNode, truncated: bool }` — both `#[serde(rename_all = "camelCase")]`.

- [ ] **Step 1: Add the types**

In `apps/desktop/src-tauri/src/types.rs`, add near `FolderDiffNode` (after its definition):

```rust
/// One node in the full repo file tree (File Explorer panel). Unlike
/// `FolderDiffNode` this carries no diff-specific fields — it's a plain
/// tracked + untracked (`.gitignore`-aware) directory listing.
#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RepoTreeNode {
    pub path: String,
    pub name: String,
    pub kind: String, // "folder" | "file"
    pub children: Vec<RepoTreeNode>,
}

/// Result of `list_repo_tree`. `truncated` is set when the repo has more
/// than `MAX_REPO_TREE_ENTRIES` trackable paths and the list was capped.
#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RepoTreeResult {
    pub root: RepoTreeNode,
    pub truncated: bool,
}
```

- [ ] **Step 2: Add the tree-building helpers to `git/parse.rs`**

Add near `insert_change`/`sort_node` (these are `pub(crate)` and re-exported to the rest of the crate via `pub(crate) use parse::*;` in `git/mod.rs`, so no extra registration is needed):

```rust
/// Insert a single repo-relative path into the tree, creating intermediate
/// folder nodes as needed. Mirrors `insert_change` but for a plain path
/// list (no diff status/stat fields).
pub(crate) fn insert_repo_path(root: &mut RepoTreeNode, path: &str) {
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() {
        return;
    }
    insert_repo_segments(root, &segments, 0, "");
}

fn insert_repo_segments(node: &mut RepoTreeNode, segments: &[&str], idx: usize, parent_path: &str) {
    let seg = segments[idx];
    let full_path = if parent_path.is_empty() {
        seg.to_string()
    } else {
        format!("{}/{}", parent_path, seg)
    };
    let is_last = idx + 1 == segments.len();

    let child_idx = match node.children.iter().position(|c| c.name == seg) {
        Some(p) => p,
        None => {
            node.children.push(RepoTreeNode {
                path: full_path.clone(),
                name: seg.to_string(),
                kind: if is_last { "file" } else { "folder" }.to_string(),
                children: Vec::new(),
            });
            node.children.len() - 1
        }
    };

    if !is_last {
        insert_repo_segments(&mut node.children[child_idx], segments, idx + 1, &full_path);
    }
}

/// Sort a repo tree node's children folders-first, then alphabetically —
/// same ordering as `sort_node`, on `RepoTreeNode`.
pub(crate) fn sort_repo_tree(node: &mut RepoTreeNode) {
    node.children.sort_by(|a, b| {
        let a_is_folder = a.kind == "folder";
        let b_is_folder = b.kind == "folder";
        match (a_is_folder, b_is_folder) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });
    for c in node.children.iter_mut() {
        sort_repo_tree(c);
    }
}
```

- [ ] **Step 3: Write the failing test for the helpers**

In `apps/desktop/src-tauri/src/git/parse.rs`, add a new test module near the existing `#[cfg(test)] mod workspace_detection_tests`:

```rust
#[cfg(test)]
mod repo_tree_tests {
    use super::*;

    #[test]
    fn builds_nested_folders_and_sorts_folders_first() {
        let mut root = RepoTreeNode {
            path: String::new(),
            name: String::new(),
            kind: "folder".to_string(),
            children: Vec::new(),
        };
        insert_repo_path(&mut root, "src/main.rs");
        insert_repo_path(&mut root, "README.md");
        insert_repo_path(&mut root, "src/lib.rs");
        sort_repo_tree(&mut root);

        assert_eq!(root.children.len(), 2);
        assert_eq!(root.children[0].name, "src");
        assert_eq!(root.children[0].kind, "folder");
        assert_eq!(root.children[1].name, "README.md");
        assert_eq!(root.children[1].kind, "file");

        let src = &root.children[0];
        assert_eq!(src.children.len(), 2);
        assert_eq!(src.children[0].name, "lib.rs");
        assert_eq!(src.children[0].path, "src/lib.rs");
        assert_eq!(src.children[1].name, "main.rs");
    }
}
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd apps/desktop/src-tauri && cargo test repo_tree_tests`
Expected: FAIL to compile — `insert_repo_path`/`sort_repo_tree`/`RepoTreeNode` not usable yet from this scope, or (if Step 2 already applied) simply run it to confirm it currently passes before moving on. Since Steps 2 and 3 are both being added in this task, run this after Step 2 is in place — expect PASS immediately since the helpers are pure and simple. If it fails, the sort/insert logic has a bug — fix before continuing.

- [ ] **Step 5: Add `build_repo_tree` + the `list_repo_tree` command**

In `apps/desktop/src-tauri/src/commands/files.rs`, add after `list_dir`:

```rust
// ─── Full repo file tree (File Explorer panel) ─────────────

/// Cap on total tree entries returned by `list_repo_tree` — see the
/// apps/desktop/CLAUDE.md P6.4 "IPC payloads > 1MB need truncation" rule.
/// 20k entries covers all but pathological monorepos while keeping the
/// payload small.
const MAX_REPO_TREE_ENTRIES: usize = 20_000;

/// Pure, synchronously-testable core of `list_repo_tree` (kept separate
/// from the `async fn` Tauri command so it can be unit-tested directly
/// without an async runtime).
fn build_repo_tree(cwd: &str) -> Result<RepoTreeResult, String> {
    if cwd.trim().is_empty() {
        return Err("cwd must not be empty".to_string());
    }

    let output = git_cmd()
        .args(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("Failed to run git ls-files: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git ls-files failed: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut paths: Vec<&str> = stdout.split('\0').filter(|p| !p.is_empty()).collect();
    paths.sort_unstable();

    let truncated = paths.len() > MAX_REPO_TREE_ENTRIES;
    if truncated {
        paths.truncate(MAX_REPO_TREE_ENTRIES);
    }

    let mut root = RepoTreeNode {
        path: String::new(),
        name: String::new(),
        kind: "folder".to_string(),
        children: Vec::new(),
    };
    for path in &paths {
        insert_repo_path(&mut root, path);
    }
    sort_repo_tree(&mut root);

    Ok(RepoTreeResult { root, truncated })
}

#[tauri::command]
pub(crate) async fn list_repo_tree(cwd: String) -> Result<RepoTreeResult, String> {
    build_repo_tree(&cwd)
}
```

- [ ] **Step 6: Write the failing test for `build_repo_tree`**

In `apps/desktop/src-tauri/src/commands/files.rs`, add at the bottom of the file (real temp git repo, per AGENTS.md — no mocked git layer):

```rust
#[cfg(test)]
mod list_repo_tree_tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command as StdCommand;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TempRepo {
        path: PathBuf,
    }

    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    impl TempRepo {
        fn new(label: &str) -> Self {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let pid = std::process::id();
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir()
                .join(format!("gitwand-tree-test-{}-{}-{}-{}", label, pid, n, nanos));
            std::fs::create_dir_all(&dir).unwrap();
            let repo = TempRepo { path: dir };
            repo.git(&["init", "-q"]);
            repo.git(&["config", "user.email", "test@gitwand.dev"]);
            repo.git(&["config", "user.name", "GitWand Test"]);
            repo
        }

        fn cwd(&self) -> String {
            self.path.to_string_lossy().to_string()
        }

        fn write(&self, rel: &str, content: &str) {
            let p = self.path.join(rel);
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(p, content).unwrap();
        }

        fn git(&self, args: &[&str]) {
            let status = StdCommand::new("git")
                .args(args)
                .current_dir(&self.path)
                .status()
                .unwrap();
            assert!(status.success(), "git {:?} failed", args);
        }
    }

    #[test]
    fn respects_gitignore_and_includes_untracked() {
        let repo = TempRepo::new("basic");
        repo.write(".gitignore", "ignored_dir/\n");
        repo.write("src/main.rs", "fn main() {}");
        repo.write("ignored_dir/secret.txt", "nope");
        repo.write("untracked.md", "# hi");
        repo.git(&["add", "src/main.rs", ".gitignore"]);
        repo.git(&["commit", "-q", "-m", "init"]);

        let result = build_repo_tree(&repo.cwd()).unwrap();

        assert!(!result.truncated);
        let names: Vec<&str> = result.root.children.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"src"));
        assert!(names.contains(&"untracked.md"));
        assert!(names.contains(&".gitignore"));
        assert!(!names.contains(&"ignored_dir"));

        let src_folder = result.root.children.iter().find(|c| c.name == "src").unwrap();
        assert_eq!(src_folder.kind, "folder");
        assert_eq!(src_folder.children.len(), 1);
        assert_eq!(src_folder.children[0].name, "main.rs");
        assert_eq!(src_folder.children[0].path, "src/main.rs");
    }

    #[test]
    fn rejects_empty_cwd() {
        let err = build_repo_tree("").unwrap_err();
        assert!(err.contains("cwd must not be empty"));
    }
}
```

- [ ] **Step 7: Run the tests**

Run: `cd apps/desktop/src-tauri && cargo test list_repo_tree_tests`
Expected: PASS (2 tests).

- [ ] **Step 8: Register the command in `lib.rs`**

In `apps/desktop/src-tauri/src/lib.rs`, find the line `commands::files::list_dir,` inside the `generate_handler!` macro and add immediately after it:

```rust
commands::files::list_repo_tree,
```

- [ ] **Step 9: Confirm the crate builds**

Run: `cd apps/desktop/src-tauri && cargo build`
Expected: builds with no errors.

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src-tauri/src/types.rs apps/desktop/src-tauri/src/git/parse.rs apps/desktop/src-tauri/src/commands/files.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): add list_repo_tree Tauri command"
```

---

### Task 2: dev-server mock route + `backend.ts` wrapper

**Files:**
- Modify: `apps/desktop/dev-server.mjs` (add `/api/list-repo-tree` route)
- Modify: `apps/desktop/src/utils/backend.ts` (add `RepoTreeNode`, `RepoTreeResult` types + `listRepoTree` wrapper)

**Interfaces:**
- Consumes: nothing new (uses existing `GIT`, `execFileSync`, `readBody`, `jsonResponse` helpers already in `dev-server.mjs`; existing `isTauri()`, `tauriInvoke()`, `devFetch()`, `DEV_SERVER` in `backend.ts`).
- Produces: `listRepoTree(cwd: string): Promise<RepoTreeResult>` for later tasks to import from `@/utils/backend`.

- [ ] **Step 1: Add the dev-server route**

In `apps/desktop/dev-server.mjs`, insert right before the `/api/list-dir` route (currently at line 1058):

```javascript
// POST /api/list-repo-tree  { cwd }
//
// Mirrors the Tauri `list_repo_tree` command (File Explorer panel). Lists
// tracked + untracked non-ignored paths via `git ls-files -z --cached
// --others --exclude-standard`, then folds them into a nested folder tree.
//
// Response: { root: RepoTreeNode, truncated: boolean } — camelCase to match
// the Rust struct's `rename_all = "camelCase"` serialization.
if (url.pathname === "/api/list-repo-tree" && req.method === "POST") {
  const { cwd } = await readBody(req);
  if (!cwd || !cwd.trim()) return jsonResponse(req, res, { error: "cwd must not be empty" }, 400);

  const MAX_REPO_TREE_ENTRIES = 20000;
  let stdout;
  try {
    stdout = execFileSync(GIT, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    }).toString("utf8");
  } catch (e) {
    const stderr = e.stderr ? e.stderr.toString() : e.message;
    return jsonResponse(req, res, { error: `git ls-files failed: ${stderr.trim()}` }, 500);
  }

  let paths = stdout.split("\0").filter((p) => p.length > 0).sort();
  const truncated = paths.length > MAX_REPO_TREE_ENTRIES;
  if (truncated) paths = paths.slice(0, MAX_REPO_TREE_ENTRIES);

  const root = { path: "", name: "", kind: "folder", children: [] };
  const insert = (node, segments, idx, parentPath) => {
    const seg = segments[idx];
    const fullPath = parentPath ? `${parentPath}/${seg}` : seg;
    const isLast = idx === segments.length - 1;
    let child = node.children.find((c) => c.name === seg);
    if (!child) {
      child = { path: fullPath, name: seg, kind: isLast ? "file" : "folder", children: [] };
      node.children.push(child);
    }
    if (!isLast) insert(child, segments, idx + 1, fullPath);
  };
  for (const p of paths) {
    const segments = p.split("/").filter((s) => s.length > 0);
    if (segments.length) insert(root, segments, 0, "");
  }
  const sortNode = (node) => {
    node.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    node.children.forEach(sortNode);
  };
  sortNode(root);

  return jsonResponse(req, res, { root, truncated });
}
```

- [ ] **Step 2: Add the TypeScript types and wrapper**

In `apps/desktop/src/utils/backend.ts`, add after the `listDir` function:

```typescript
export interface RepoTreeNode {
  path: string;
  name: string;
  kind: "folder" | "file";
  children: RepoTreeNode[];
}

export interface RepoTreeResult {
  root: RepoTreeNode;
  truncated: boolean;
}

/**
 * List the full repo file tree (tracked + untracked, `.gitignore`-aware)
 * for the File Explorer panel.
 */
export async function listRepoTree(cwd: string): Promise<RepoTreeResult> {
  if (isTauri()) {
    return tauriInvoke<RepoTreeResult>("list_repo_tree", { cwd });
  }
  const res = await devFetch(`${DEV_SERVER}/api/list-repo-tree`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`list_repo_tree failed: ${body || res.statusText}`);
  }
  return res.json();
}
```

- [ ] **Step 3: Manually verify the route**

Run: `cd apps/desktop && pnpm dev:server` (in one terminal), then in another:
```bash
curl -s -X POST http://localhost:1421/api/list-repo-tree \
  -H "Content-Type: application/json" \
  -d "{\"cwd\": \"$(pwd)/../..\"}" | head -c 400
```
Expected: JSON starting with `{"root":{"path":"","name":"","kind":"folder","children":[...` — adjust the port if `dev-server.mjs` logs a different one on startup (check its startup log line). Stop the dev server after checking.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/dev-server.mjs apps/desktop/src/utils/backend.ts
git commit -m "feat(desktop): wire list_repo_tree through dev-server and backend.ts"
```

---

### Task 3: `useFileExplorer.ts` — per-repo open-file tab state

**Files:**
- Create: `apps/desktop/src/composables/useFileExplorer.ts`
- Test: `apps/desktop/src/composables/__tests__/useFileExplorer.test.ts`

**Interfaces:**
- Consumes: `readFile(cwd: string, path: string): Promise<string>`, `writeFile(cwd: string, path: string, content: string): Promise<void>` from `@/utils/backend`.
- Produces: `FileTab { id: number; path: string; content: string; originalContent: string; pinned: boolean; binary: boolean }`, `useFileExplorer()` returning `{ tabsFor, activeTabId, setActive, isDirty, openTab, saveTab, closeTab, updateContent, disposeRepo }`, and `resolveFileExplorerShortcut(e: KeyboardEvent, focused: boolean)` returning `"save" | "close" | { switch: number } | null` — consumed by Task 6/7. `openTab`'s `pin` param already sets `pinned` on both the new-tab and existing-tab paths, so there's no separate "promote to pinned" function.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/composables/__tests__/useFileExplorer.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/utils/backend", () => ({
  readFile: vi.fn(async (_cwd: string, path: string) => `content of ${path}`),
  writeFile: vi.fn(async () => {}),
}));

import { readFile, writeFile } from "@/utils/backend";
import { useFileExplorer, resolveFileExplorerShortcut } from "../useFileExplorer";

describe("useFileExplorer", () => {
  const REPO_A = "/repo/a";
  const REPO_B = "/repo/b";

  beforeEach(() => {
    vi.clearAllMocks();
    // Each test starts a fresh explorer instance, but the module-level
    // Maps persist across tests (same as useTerminalSessions) — clean up
    // by disposing both repos used in these tests.
    const explorer = useFileExplorer();
    explorer.disposeRepo(REPO_A);
    explorer.disposeRepo(REPO_B);
  });

  it("keeps separate tab lists per repo", async () => {
    const explorer = useFileExplorer();
    await explorer.openTab(REPO_A, REPO_A, "a.ts", true);
    await explorer.openTab(REPO_B, REPO_B, "b.ts", true);

    expect(explorer.tabsFor(REPO_A).map((t) => t.path)).toEqual(["a.ts"]);
    expect(explorer.tabsFor(REPO_B).map((t) => t.path)).toEqual(["b.ts"]);
  });

  it("reuses the single preview tab for non-pinned opens", async () => {
    const explorer = useFileExplorer();
    await explorer.openTab(REPO_A, REPO_A, "a.ts");
    await explorer.openTab(REPO_A, REPO_A, "b.ts");

    expect(explorer.tabsFor(REPO_A).map((t) => t.path)).toEqual(["b.ts"]);
  });

  it("pinning keeps both a preview and a pinned tab open", async () => {
    const explorer = useFileExplorer();
    await explorer.openTab(REPO_A, REPO_A, "a.ts", true);
    await explorer.openTab(REPO_A, REPO_A, "b.ts");

    expect(explorer.tabsFor(REPO_A).map((t) => t.path)).toEqual(["a.ts", "b.ts"]);
  });

  it("derives dirty state from content vs originalContent", async () => {
    const explorer = useFileExplorer();
    const tab = await explorer.openTab(REPO_A, REPO_A, "a.ts", true);
    expect(explorer.isDirty(tab)).toBe(false);

    explorer.updateContent(REPO_A, tab.id, "changed");
    expect(explorer.isDirty(tab)).toBe(true);
  });

  it("saveTab writes content and clears dirty state", async () => {
    const explorer = useFileExplorer();
    const tab = await explorer.openTab(REPO_A, REPO_A, "a.ts", true);
    explorer.updateContent(REPO_A, tab.id, "changed");

    await explorer.saveTab(REPO_A, REPO_A, tab.id);

    expect(writeFile).toHaveBeenCalledWith(REPO_A, "a.ts", "changed");
    expect(explorer.isDirty(tab)).toBe(false);
  });

  it("marks a tab binary when readFile rejects (non-UTF8 content)", async () => {
    (readFile as any).mockRejectedValueOnce(new Error("stream did not contain valid UTF-8"));
    const explorer = useFileExplorer();
    const tab = await explorer.openTab(REPO_A, REPO_A, "image.png", true);

    expect(tab.binary).toBe(true);
    expect(explorer.isDirty(tab)).toBe(false);
  });

  it("closeTab removes the tab and reassigns the active tab", async () => {
    const explorer = useFileExplorer();
    const tabA = await explorer.openTab(REPO_A, REPO_A, "a.ts", true);
    const tabB = await explorer.openTab(REPO_A, REPO_A, "b.ts", true);
    explorer.setActive(REPO_A, tabB.id);

    explorer.closeTab(REPO_A, tabB.id);

    expect(explorer.tabsFor(REPO_A).map((t) => t.path)).toEqual(["a.ts"]);
    expect(explorer.activeTabId(REPO_A)).toBe(tabA.id);
  });
});

describe("resolveFileExplorerShortcut", () => {
  it("returns null when not focused", () => {
    const e = new KeyboardEvent("keydown", { key: "s", metaKey: true });
    expect(resolveFileExplorerShortcut(e, false)).toBeNull();
  });

  it("maps cmd+s to save", () => {
    const e = new KeyboardEvent("keydown", { key: "s", metaKey: true });
    expect(resolveFileExplorerShortcut(e, true)).toBe("save");
  });

  it("maps cmd+w to close", () => {
    const e = new KeyboardEvent("keydown", { key: "w", metaKey: true });
    expect(resolveFileExplorerShortcut(e, true)).toBe("close");
  });

  it("maps cmd+1..9 to switch", () => {
    const e = new KeyboardEvent("keydown", { key: "3", metaKey: true });
    expect(resolveFileExplorerShortcut(e, true)).toEqual({ switch: 2 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/desktop && pnpm vitest run src/composables/__tests__/useFileExplorer.test.ts`
Expected: FAIL — `../useFileExplorer` does not exist.

- [ ] **Step 3: Implement `useFileExplorer.ts`**

Create `apps/desktop/src/composables/useFileExplorer.ts`:

```typescript
import { reactive } from "vue";
import { readFile, writeFile } from "@/utils/backend";

export interface FileTab {
  id: number;
  path: string;
  content: string;
  originalContent: string;
  /** Preview tabs (single-click) are replaced by the next preview open;
   * pinned tabs (double-click, or edited) persist alongside them. */
  pinned: boolean;
  /**
   * True when `readFile` failed to decode the file as UTF-8 text (binary
   * file). Binary tabs show a "not editable" placeholder instead of an
   * editor — see spec non-goal "no binary preview in v1".
   */
  binary: boolean;
}

export type FileExplorerShortcut = "save" | "close" | { switch: number } | null;

export function resolveFileExplorerShortcut(e: KeyboardEvent, focused: boolean): FileExplorerShortcut {
  if (!focused) return null;
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return null;
  if (e.key === "s") return "save";
  if (e.key === "w") return "close";
  if (/^[1-9]$/.test(e.key)) return { switch: Number(e.key) - 1 };
  return null;
}

const tabsByRepo = reactive(new Map<string, FileTab[]>());
const activeByRepo = reactive(new Map<string, number | null>());
let nextLocalId = 1;

export function useFileExplorer() {
  function tabsFor(repoPath: string): FileTab[] {
    if (!tabsByRepo.has(repoPath)) tabsByRepo.set(repoPath, []);
    return tabsByRepo.get(repoPath)!;
  }

  function activeTabId(repoPath: string): number | null {
    return activeByRepo.get(repoPath) ?? null;
  }

  function setActive(repoPath: string, tabId: number) {
    activeByRepo.set(repoPath, tabId);
  }

  function isDirty(tab: FileTab): boolean {
    return tab.content !== tab.originalContent;
  }

  /**
   * Open `path` in a tab. `pin: false` (default) reuses the single
   * "preview" tab (VS Code-style, replaced by the next preview open);
   * `pin: true` creates/keeps a permanent tab.
   */
  async function openTab(repoPath: string, cwd: string, path: string, pin = false): Promise<FileTab> {
    const tabs = tabsFor(repoPath);
    const existing = tabs.find((t) => t.path === path);
    if (existing) {
      if (pin) existing.pinned = true;
      setActive(repoPath, existing.id);
      return existing;
    }

    let content = "";
    let binary = false;
    try {
      content = await readFile(cwd, path);
    } catch {
      // `read_file` fails when the file isn't valid UTF-8 text (binary
      // file) — show a placeholder instead of surfacing the raw error.
      binary = true;
    }
    const tab: FileTab = {
      id: nextLocalId++,
      path,
      content,
      originalContent: content,
      pinned: pin,
      binary,
    };

    if (!pin) {
      const previewIdx = tabs.findIndex((t) => !t.pinned);
      if (previewIdx !== -1) {
        tabs.splice(previewIdx, 1, tab);
      } else {
        tabs.push(tab);
      }
    } else {
      tabs.push(tab);
    }

    setActive(repoPath, tab.id);
    return tab;
  }

  async function saveTab(repoPath: string, cwd: string, tabId: number): Promise<void> {
    const tab = tabsFor(repoPath).find((t) => t.id === tabId);
    if (!tab || tab.binary || !isDirty(tab)) return;
    await writeFile(cwd, tab.path, tab.content);
    tab.originalContent = tab.content;
  }

  function closeTab(repoPath: string, tabId: number) {
    const tabs = tabsFor(repoPath);
    const idx = tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    tabs.splice(idx, 1);
    if (activeByRepo.get(repoPath) === tabId) {
      const next = tabs[Math.max(0, idx - 1)];
      activeByRepo.set(repoPath, next ? next.id : null);
    }
  }

  function updateContent(repoPath: string, tabId: number, content: string) {
    const tab = tabsFor(repoPath).find((t) => t.id === tabId);
    if (tab) tab.content = content;
  }

  function disposeRepo(repoPath: string) {
    tabsByRepo.delete(repoPath);
    activeByRepo.delete(repoPath);
  }

  return {
    tabsFor,
    activeTabId,
    setActive,
    isDirty,
    openTab,
    saveTab,
    closeTab,
    updateContent,
    disposeRepo,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/desktop && pnpm vitest run src/composables/__tests__/useFileExplorer.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/composables/useFileExplorer.ts apps/desktop/src/composables/__tests__/useFileExplorer.test.ts
git commit -m "feat(desktop): add useFileExplorer composable for per-repo open-file tabs"
```

---

### Task 4: `useRepoFileTree.ts` — tree fetch, flatten, status badges

**Files:**
- Create: `apps/desktop/src/composables/useRepoFileTree.ts`
- Test: `apps/desktop/src/composables/__tests__/useRepoFileTree.test.ts`

**Interfaces:**
- Consumes: `listRepoTree(cwd: string): Promise<RepoTreeResult>` and `RepoTreeNode` from `@/utils/backend`; `TreeRow<T>` type from `./useFileTree` (rendering shape, reused as-is — `{ kind: "folder" | "file"; path: string; name: string; depth: number; file?: T; count?: number }`); `RepoFileEntry { path: string; status: "added"|"modified"|"deleted"|"renamed"; section: "staged"|"unstaged"|"untracked"|"conflicted" }` from `./useGitRepo`.
- Produces: `useRepoFileTree(repoPath: Ref<string>, changedFiles: Ref<RepoFileEntry[]>)` returning `{ rows: ComputedRef<TreeRow[]>, truncated: Ref<boolean>, loading: Ref<boolean>, error: Ref<string|null>, refresh(): Promise<void>, toggleFolder(path: string): void, isCollapsed(path: string): boolean, statusByPath: ComputedRef<Map<string, RepoFileEntry["status"]>> }` — consumed by Task 6.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/composables/__tests__/useRepoFileTree.test.ts`:

```typescript
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
  it("flattens the fetched tree into rows and rolls up folder counts", async () => {
    const repoPath = ref("/repo");
    const changedFiles = ref([]);
    const tree = useRepoFileTree(repoPath, changedFiles);

    await tree.refresh();

    expect(listRepoTree).toHaveBeenCalledWith("/repo");
    expect(tree.rows.value.map((r) => [r.kind, r.path, r.depth])).toEqual([
      ["folder", "src", 0],
      ["file", "src/main.ts", 1],
      ["file", "src/util.ts", 1],
      ["file", "README.md", 0],
    ]);
    expect(tree.rows.value[0].count).toBe(2);
  });

  it("collapsing a folder hides its descendants", async () => {
    const repoPath = ref("/repo");
    const changedFiles = ref([]);
    const tree = useRepoFileTree(repoPath, changedFiles);
    await tree.refresh();

    tree.toggleFolder("src");
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/desktop && pnpm vitest run src/composables/__tests__/useRepoFileTree.test.ts`
Expected: FAIL — `../useRepoFileTree` does not exist.

- [ ] **Step 3: Implement `useRepoFileTree.ts`**

Create `apps/desktop/src/composables/useRepoFileTree.ts`:

```typescript
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/desktop && pnpm vitest run src/composables/__tests__/useRepoFileTree.test.ts`
Expected: PASS (all tests). If `TreeRow` doesn't accept an object without `file`/`count` set, check `useFileTree.ts`'s `TreeRow` interface — both fields must already be optional (`file?`, `count?`); if not, this step surfaces a pre-existing type worth widening, not a bug in this new code.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/composables/useRepoFileTree.ts apps/desktop/src/composables/__tests__/useRepoFileTree.test.ts
git commit -m "feat(desktop): add useRepoFileTree composable"
```

---

### Task 5: Settings — `filesMode`/`filesPrevMode`/`filesHideOnNav`

**Files:**
- Modify: `apps/desktop/src/composables/useSettings.ts`
- Modify: `apps/desktop/src/components/SettingsPanel.vue`

**Interfaces:**
- Produces: `AppSettings.filesMode: FilesMode` (`"floating" | "fullscreen" | "bottom"`), `AppSettings.filesPrevMode: Exclude<FilesMode, "fullscreen">`, `AppSettings.filesHideOnNav: boolean` — consumed by Task 8 (AppDock) and Task 6 (panel layout).

- [ ] **Step 1: Add the fields to `AppSettings` in `useSettings.ts`**

Find the `// ── v3.x Terminal ─────` block in the `AppSettings` interface (ends with `terminalPasteOnRightClick: boolean;`) and add immediately after it, still inside the interface:

```typescript
  // ── v3.x File Explorer ───────────────────────────────────
  /**
   * File Explorer panel layout mode — same semantics as `terminalMode`:
   * "floating" (default), "fullscreen", or "bottom".
   */
  filesMode: FilesMode;
  /** Layout to restore when leaving fullscreen. Never "fullscreen" itself. */
  filesPrevMode: Exclude<FilesMode, "fullscreen">;
  /** Hide the File Explorer when switching views from the dock. Default: false. */
  filesHideOnNav: boolean;
```

Add the type alias right after `export type TerminalMode = "floating" | "fullscreen" | "bottom";`:

```typescript
export type FilesMode = "floating" | "fullscreen" | "bottom";
```

Add the defaults in `defaultAppSettings`, right after `terminalPasteOnRightClick: false,`:

```typescript
  filesMode: "floating",
  filesPrevMode: "floating",
  filesHideOnNav: false,
```

- [ ] **Step 2: Mirror the fields in `SettingsPanel.vue`**

In `apps/desktop/src/components/SettingsPanel.vue`'s local `Settings` interface, find `terminalPasteOnRightClick: boolean;` (the last terminal field) and add immediately after it:

```typescript
  filesMode: "floating" | "fullscreen" | "bottom";
  filesPrevMode: "floating" | "bottom";
  filesHideOnNav: boolean;
```

- [ ] **Step 3: Verify the frontend still type-checks**

Run: `cd apps/desktop && pnpm vue-tsc --noEmit`
Expected: no new errors. (Existing unrelated errors, if any predate this change, are out of scope — only check that this diff didn't introduce new ones.)

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/composables/useSettings.ts apps/desktop/src/components/SettingsPanel.vue
git commit -m "feat(desktop): add File Explorer layout settings (filesMode/filesPrevMode/filesHideOnNav)"
```

---

### Task 6: `FileExplorerPanel.vue` shell — layout, tree pane, tab strip

**Files:**
- Create: `apps/desktop/src/components/FileExplorerPanel.vue`

**Interfaces:**
- Consumes: `useFileExplorer()` (Task 3), `useRepoFileTree()` (Task 4), `useSettings()`, `RepoFileEntry` from `./useGitRepo`.
- Props: `{ repoPath: string; changedFiles: RepoFileEntry[] }`.
- Emits: `close`, `request-close-tab: [tabId: number]` (bubbled up so `App.vue` can run the unsaved-changes confirmation with `askConfirm`, which this component does not have access to — see Task 9).
- Produces: a mountable panel matching `TerminalPanel.vue`'s prop/emit shape closely enough that `App.vue` wiring in Task 9 is a straightforward mirror of the existing Terminal wiring.

This task builds the shell with a plain `<pre>` for file content — no editor yet (Task 7 replaces it with CodeMirror). This keeps this task's diff reviewable and independently testable end-to-end (tree → open tab → see raw content → close tab) before adding editor complexity.

- [ ] **Step 1: Create the component**

Create `apps/desktop/src/components/FileExplorerPanel.vue`:

```vue
<script setup lang="ts">
import { computed, ref, watch, onMounted } from "vue";
import { useFileExplorer } from "../composables/useFileExplorer";
import { useRepoFileTree } from "../composables/useRepoFileTree";
import { useSettings } from "../composables/useSettings";
import { useI18n } from "../composables/useI18n";
import type { RepoFileEntry } from "../composables/useGitRepo";

const props = defineProps<{
  repoPath: string;
  changedFiles: RepoFileEntry[];
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "request-close-tab", tabId: number): void;
}>();

const { t } = useI18n();
const { settings } = useSettings();
const explorer = useFileExplorer();

const repoPathRef = computed(() => props.repoPath);
const changedFilesRef = computed(() => props.changedFiles);
const tree = useRepoFileTree(repoPathRef, changedFilesRef);

onMounted(() => tree.refresh());
watch(repoPathRef, () => tree.refresh());

const tabs = computed(() => explorer.tabsFor(props.repoPath));
const activeId = computed(() => explorer.activeTabId(props.repoPath));
const activeTab = computed(() => tabs.value.find((t) => t.id === activeId.value) ?? null);

const mode = computed(() => settings.value.filesMode);
const fullscreen = computed(() => mode.value === "fullscreen");
const bottom = computed(() => mode.value === "bottom");

// ── Floating position/size, persisted — mirrors TerminalPanel.vue ──
const HEIGHT_KEY = "gitwand-explorer-height";
const LEFT_KEY = "gitwand-explorer-left";
const WIDTH_KEY = "gitwand-explorer-width";
const TOP_KEY = "gitwand-explorer-top";
const height = ref(Number(localStorage.getItem(HEIGHT_KEY)) || 360);
const left = ref(Number(localStorage.getItem(LEFT_KEY)) || 16);
const width = ref(Number(localStorage.getItem(WIDTH_KEY)) || 640);
const top = ref(Number(localStorage.getItem(TOP_KEY)) || 80);

const panelStyle = computed(() => {
  if (fullscreen.value || bottom.value) return {};
  return {
    left: `${left.value}px`,
    top: `${top.value}px`,
    width: `${width.value}px`,
    height: `${height.value}px`,
  };
});

async function onFileClick(path: string) {
  await explorer.openTab(props.repoPath, props.repoPath, path, false);
}

async function onFileDblClick(path: string) {
  await explorer.openTab(props.repoPath, props.repoPath, path, true);
}

function onTabClick(tabId: number) {
  explorer.setActive(props.repoPath, tabId);
}

function onTabClose(tabId: number) {
  const tab = tabs.value.find((t) => t.id === tabId);
  if (tab && explorer.isDirty(tab)) {
    emit("request-close-tab", tabId);
  } else {
    explorer.closeTab(props.repoPath, tabId);
  }
}
</script>

<template>
  <div
    class="fe"
    :class="{ 'fe--full': fullscreen, 'fe--bottom': bottom, 'fe--floating': !fullscreen && !bottom }"
    :style="panelStyle"
  >
    <div class="fe__header">
      <span class="fe__title">{{ t("files.headerLabel") }}</span>
      <button v-if="tree.truncated.value" class="fe__truncated" :title="t('files.truncatedTooltip')">
        {{ t("files.truncatedBadge") }}
      </button>
      <button class="fe__close" :title="t('common.close')" @click="emit('close')">✕</button>
    </div>

    <div class="fe__body">
      <div class="fe__tree" role="tree">
        <div
          v-for="row in tree.rows.value"
          :key="`${row.kind}-${row.path}`"
          class="file-item"
          :class="{ 'tree-folder': row.kind === 'folder' }"
          :style="{ paddingLeft: `${row.depth * 14 + (row.kind === 'folder' ? 5 : 18)}px` }"
          role="treeitem"
          tabindex="0"
          @click="row.kind === 'folder' ? tree.toggleFolder(row.path) : onFileClick(row.path)"
          @dblclick="row.kind === 'file' && onFileDblClick(row.path)"
        >
          <template v-if="row.kind === 'folder'">
            <svg
              class="tree-chevron"
              :class="{ 'tree-chevron--collapsed': tree.isCollapsed(row.path) }"
              width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
            <svg class="tree-folder-icon" width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 5h6l2 2h10v12H3z" />
            </svg>
            <span class="file-name mono tree-folder-name">{{ row.name }}</span>
            <span class="tree-folder-count">{{ row.count }}</span>
          </template>
          <template v-else>
            <span
              v-if="tree.statusByPath.value.get(row.path)"
              class="file-status-dot"
              :class="`file-status-dot--${tree.statusByPath.value.get(row.path)}`"
              :title="tree.statusByPath.value.get(row.path)"
            />
            <span class="file-name mono">{{ row.name }}</span>
          </template>
        </div>
      </div>

      <div class="fe__editor-pane">
        <div v-if="tabs.length" class="fe__tabs">
          <button
            v-for="tab in tabs"
            :key="tab.id"
            class="fe__tab"
            :class="{ 'fe__tab--active': tab.id === activeId, 'fe__tab--preview': !tab.pinned }"
            @click="onTabClick(tab.id)"
          >
            <span class="fe__tab-name">{{ tab.path.split('/').pop() }}</span>
            <span v-if="explorer.isDirty(tab)" class="fe__tab-dot" />
            <span class="fe__tab-close" @click.stop="onTabClose(tab.id)">✕</span>
          </button>
        </div>
        <div v-if="activeTab" class="fe__content">
          <pre class="fe__pre">{{ activeTab.content }}</pre>
        </div>
        <div v-else class="fe__empty">{{ t("files.emptyHint") }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fe {
  position: absolute;
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  z-index: 40;
  overflow: hidden;
}

.fe--full {
  position: static;
  inset: 0;
  width: 100%;
  height: 100%;
  border-radius: 0;
}

.fe--bottom {
  position: static;
  width: 100%;
  height: 360px;
  border-radius: 0;
  border-left: none;
  border-right: none;
  border-bottom: none;
}

.fe__header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.fe__title {
  font-weight: var(--font-weight-medium);
  flex: 1;
}

.fe__close {
  color: var(--color-text-muted);
}

.fe__body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.fe__tree {
  width: 220px;
  flex-shrink: 0;
  overflow-y: auto;
  border-right: 1px solid var(--color-border);
}

.fe__editor-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.fe__tabs {
  display: flex;
  overflow-x: auto;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.fe__tab {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-right: 1px solid var(--color-border);
  color: var(--color-text-muted);
  white-space: nowrap;
}

.fe__tab--active {
  color: var(--color-text);
  background: var(--color-bg-tertiary);
}

.fe__tab--preview {
  font-style: italic;
}

.fe__tab-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-accent);
}

.fe__content {
  flex: 1;
  overflow: auto;
}

.fe__pre {
  margin: 0;
  padding: var(--space-3);
  font-family: var(--font-mono);
  font-size: var(--font-size-base);
  white-space: pre-wrap;
}

.fe__empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-muted);
}

.file-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--color-text-muted);
}

.file-status-dot--added { background: var(--color-status-added); }
.file-status-dot--modified { background: var(--color-status-modified, var(--color-accent)); }
.file-status-dot--deleted { background: var(--color-danger); }
.file-status-dot--renamed { background: var(--color-status-added); }

/* ── Tree rows — copied from RepoSidebar.vue's scoped .file-item/.tree-*
   rules (lines 2091-2337) so this panel's tree matches the Changes tree
   visually without depending on cross-component scoped styles (Vue scoped
   CSS never leaks between components). Keep these two blocks in sync if
   RepoSidebar's tree styling changes. */
.file-item {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-2) var(--space-3);
  cursor: pointer;
  transition: background var(--transition-hover);
  border-left: 3px solid transparent;
}

.file-item:hover {
  background: var(--color-bg-tertiary);
}

.file-name {
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tree-folder {
  border-left: 3px solid transparent;
}

.tree-chevron {
  color: var(--color-text-subtle);
  flex-shrink: 0;
  transition: transform 0.15s ease;
}

.tree-chevron--collapsed {
  transform: rotate(-90deg);
}

.tree-folder-icon {
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.tree-folder-name {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text);
}

.tree-folder-count {
  flex-shrink: 0;
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
  color: var(--color-text-subtle);
}
</style>
```

- [ ] **Step 2: Type-check**

Run: `cd apps/desktop && pnpm vue-tsc --noEmit`
Expected: no new errors from `FileExplorerPanel.vue`.

- [ ] **Step 3: Manual smoke test**

Run: `cd apps/desktop && pnpm dev:web`, open the app in the browser, open a repo. This component isn't mounted anywhere yet (that's Task 9) — for now, temporarily add `<FileExplorerPanel :repo-path="repoFolderPath!" :changed-files="repoFiles" @close="() => {}" />` right after the `TerminalPanel` `KeepAlive` block in `App.vue` to eyeball it, then **revert that temporary edit** before committing (Task 9 wires it properly with layout modes, AppDock toggle, and the unsaved-changes guard — mounting it unconditionally here would skip all of that).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/components/FileExplorerPanel.vue
git commit -m "feat(desktop): add FileExplorerPanel shell (tree + tabs, no editor yet)"
```

---

### Task 7: CodeMirror 6 integration

**Files:**
- Modify: `apps/desktop/package.json` (add CodeMirror deps)
- Modify: `apps/desktop/src/components/FileExplorerPanel.vue` (replace the `<pre>` with a CodeMirror editor)

**Interfaces:**
- Consumes: `FileTab`/`explorer.updateContent` from Task 3.
- Produces: a working code editor bound to `activeTab.content`, syncing keystrokes back into `useFileExplorer`'s state so `saveTab`/dirty-tracking keep working unchanged.

- [ ] **Step 1: Install CodeMirror**

Run:
```bash
pnpm --filter @gitwand/desktop add codemirror @codemirror/view @codemirror/state @codemirror/language-data @codemirror/theme-one-dark
```
Expected: `apps/desktop/package.json` gains these 5 entries under `dependencies`; `pnpm-lock.yaml` updates.

- [ ] **Step 2: Replace the `<pre>` with a CodeMirror host + lazy loader**

In `apps/desktop/src/components/FileExplorerPanel.vue`, replace the `<script setup>` block's imports and add editor state. Full replacement of the `<script setup>` section:

```vue
<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import { useFileExplorer, resolveFileExplorerShortcut, type FileTab } from "../composables/useFileExplorer";
import { useRepoFileTree } from "../composables/useRepoFileTree";
import { useSettings } from "../composables/useSettings";
import { useI18n } from "../composables/useI18n";
import type { RepoFileEntry } from "../composables/useGitRepo";
import type { EditorView as EditorViewType } from "@codemirror/view";
import type { EditorState as EditorStateType } from "@codemirror/state";

const props = defineProps<{
  repoPath: string;
  changedFiles: RepoFileEntry[];
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "request-close-tab", tabId: number): void;
}>();

const { t } = useI18n();
const { settings } = useSettings();
const explorer = useFileExplorer();

const repoPathRef = computed(() => props.repoPath);
const changedFilesRef = computed(() => props.changedFiles);
const tree = useRepoFileTree(repoPathRef, changedFilesRef);

onMounted(() => tree.refresh());
watch(repoPathRef, () => tree.refresh());

const tabs = computed(() => explorer.tabsFor(props.repoPath));
const activeId = computed(() => explorer.activeTabId(props.repoPath));
const activeTab = computed(() => tabs.value.find((t) => t.id === activeId.value) ?? null);

const mode = computed(() => settings.value.filesMode);
const fullscreen = computed(() => mode.value === "fullscreen");
const bottom = computed(() => mode.value === "bottom");

const HEIGHT_KEY = "gitwand-explorer-height";
const LEFT_KEY = "gitwand-explorer-left";
const WIDTH_KEY = "gitwand-explorer-width";
const TOP_KEY = "gitwand-explorer-top";
const height = ref(Number(localStorage.getItem(HEIGHT_KEY)) || 360);
const left = ref(Number(localStorage.getItem(LEFT_KEY)) || 16);
const width = ref(Number(localStorage.getItem(WIDTH_KEY)) || 640);
const top = ref(Number(localStorage.getItem(TOP_KEY)) || 80);

const panelStyle = computed(() => {
  if (fullscreen.value || bottom.value) return {};
  return {
    left: `${left.value}px`,
    top: `${top.value}px`,
    width: `${width.value}px`,
    height: `${height.value}px`,
  };
});

async function onFileClick(path: string) {
  await explorer.openTab(props.repoPath, props.repoPath, path, false);
}

async function onFileDblClick(path: string) {
  await explorer.openTab(props.repoPath, props.repoPath, path, true);
}

function onTabClick(tabId: number) {
  explorer.setActive(props.repoPath, tabId);
}

function onTabClose(tabId: number) {
  const tab = tabs.value.find((t) => t.id === tabId);
  if (tab && explorer.isDirty(tab)) {
    emit("request-close-tab", tabId);
  } else {
    explorer.closeTab(props.repoPath, tabId);
  }
}

// ── CodeMirror 6 (lazy-loaded, one EditorView with per-tab cached EditorState) ──
const editorHost = ref<HTMLElement | null>(null);
let view: EditorViewType | null = null;
let EditorViewCtor: typeof import("@codemirror/view").EditorView | null = null;
let EditorStateCtor: typeof import("@codemirror/state").EditorState | null = null;
let basicSetup: any = null;
let oneDark: any = null;
const docStates = new Map<number, EditorStateType>();

async function ensureCodeMirrorLibs() {
  if (EditorViewCtor) return;
  const [{ EditorView }, { EditorState }, cmMeta, { oneDark: theme }] = await Promise.all([
    import("@codemirror/view"),
    import("@codemirror/state"),
    import("codemirror"),
    import("@codemirror/theme-one-dark"),
  ]);
  EditorViewCtor = EditorView;
  EditorStateCtor = EditorState;
  basicSetup = (cmMeta as any).basicSetup;
  oneDark = theme;
}

async function detectLanguageExtension(path: string) {
  const { languages, LanguageDescription } = await import("@codemirror/language-data");
  const desc = LanguageDescription.matchFilename(languages, path);
  if (!desc) return [];
  try {
    return [await desc.load()];
  } catch {
    return [];
  }
}

function updateListenerFor(tabId: number) {
  return EditorViewCtor!.updateListener.of((update) => {
    if (!update.docChanged) return;
    docStates.set(tabId, update.state);
    explorer.updateContent(props.repoPath, tabId, update.state.doc.toString());
  });
}

async function mountTab(tab: FileTab) {
  if (tab.binary) {
    // Binary files get a placeholder (see FileTab.binary) — tear down any
    // mounted editor so a previously-open text tab's view doesn't linger.
    view?.destroy();
    view = null;
    return;
  }

  await ensureCodeMirrorLibs();
  await nextTick();
  if (!editorHost.value) return;

  let state = docStates.get(tab.id);
  if (!state) {
    const langExt = await detectLanguageExtension(tab.path);
    state = EditorStateCtor!.create({
      doc: tab.content,
      extensions: [basicSetup, oneDark, langExt, updateListenerFor(tab.id)],
    });
    docStates.set(tab.id, state);
  }

  if (!view) {
    view = new EditorViewCtor!({ state, parent: editorHost.value });
  } else {
    view.setState(state);
  }
}

watch(activeTab, (tab) => {
  if (tab) mountTab(tab);
});

watch(
  () => tabs.value.map((t) => t.id),
  (ids, oldIds) => {
    for (const id of oldIds ?? []) {
      if (!ids.includes(id)) docStates.delete(id);
    }
  },
);

onBeforeUnmount(() => {
  view?.destroy();
  view = null;
});

function onKeyDown(e: KeyboardEvent) {
  const shortcut = resolveFileExplorerShortcut(e, true);
  if (!shortcut || !activeTab.value) return;
  if (shortcut === "save") {
    e.preventDefault();
    if (!activeTab.value.binary) explorer.saveTab(props.repoPath, props.repoPath, activeTab.value.id);
  } else if (shortcut === "close") {
    e.preventDefault();
    onTabClose(activeTab.value.id);
  } else if (typeof shortcut === "object") {
    const target = tabs.value[shortcut.switch];
    if (target) onTabClick(target.id);
  }
}
</script>
```

Then replace the template's `<div v-if="activeTab" class="fe__content"><pre class="fe__pre">{{ activeTab.content }}</pre></div>` with:

```vue
        <div v-show="activeTab && !activeTab.binary" class="fe__content" ref="editorHost"></div>
        <div v-if="activeTab && activeTab.binary" class="fe__empty">{{ t("files.binaryPlaceholder") }}</div>
        <div v-if="!activeTab" class="fe__empty">{{ t("files.emptyHint") }}</div>
```

And add `@keydown="onKeyDown"` to the root `.fe` div, plus `tabindex="0"` so it can receive keyboard focus:

```vue
  <div
    class="fe"
    :class="{ 'fe--full': fullscreen, 'fe--bottom': bottom, 'fe--floating': !fullscreen && !bottom }"
    :style="panelStyle"
    tabindex="0"
    @keydown="onKeyDown"
  >
```

Remove the now-unused `.fe__pre` CSS rule and add a minimal size rule for the CodeMirror host instead:

```css
.fe__content :deep(.cm-editor) {
  height: 100%;
}
```

- [ ] **Step 3: Type-check**

Run: `cd apps/desktop && pnpm vue-tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Manual smoke test**

Run: `cd apps/desktop && pnpm dev:web`. Re-apply the temporary mount from Task 6 Step 3, open a repo, click a `.ts` file in the tree, confirm:
- The file content appears with syntax highlighting.
- Typing marks the tab dirty (dot appears).
- `⌘S` saves and clears the dot (check the file's mtime/content on disk changed).
- Switching tabs and back preserves undo history (type something, switch tabs, switch back, `⌘Z` still undoes it).

Revert the temporary mount again afterward.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/package.json apps/desktop/pnpm-lock.yaml apps/desktop/src/components/FileExplorerPanel.vue
git commit -m "feat(desktop): integrate CodeMirror 6 editor into FileExplorerPanel"
```

---

### Task 8: `AppDock.vue` — Files tile

**Files:**
- Modify: `apps/desktop/src/components/AppDock.vue`

**Interfaces:**
- Consumes: `settings.value.filesMode`/`filesPrevMode`/`filesHideOnNav` (Task 5).
- Produces: prop `filesActive?: boolean`, emit `toggleFiles: []` — consumed by `App.vue` in Task 9.

- [ ] **Step 1: Add the prop and emit**

In `apps/desktop/src/components/AppDock.vue`, extend the existing `defineProps`/`defineEmits` blocks (find `terminalActive?: boolean;` and `toggleTerminal: [];`):

```typescript
const props = defineProps<{
  viewMode: ViewMode;
  changesCount?: number;
  prCount?: number;
  terminalActive?: boolean;
  /** Files (File Explorer) panel currently open — drives the tile's active state. */
  filesActive?: boolean;
}>();

const emit = defineEmits<{
  changeView: [mode: ViewMode];
  toggleTerminal: [];
  toggleFiles: [];
}>();
```

- [ ] **Step 2: Add the layout computeds and actions**

Right after the existing `toggleTerminalHideOnNav` function, add:

```typescript
const filesHideOnNav = computed(() => settings.value.filesHideOnNav);
const filesIsFullscreen = computed(() => settings.value.filesMode === "fullscreen");
const filesLayout = computed<"floating" | "bottom">(() =>
  filesIsFullscreen.value ? settings.value.filesPrevMode : (settings.value.filesMode as "floating" | "bottom"),
);

function setFilesLayout(m: "floating" | "bottom") {
  patch({ filesMode: m, filesPrevMode: m });
  closeMenu();
}

function toggleFilesFullscreen() {
  if (filesIsFullscreen.value) {
    patch({ filesMode: settings.value.filesPrevMode });
  } else {
    patch({ filesPrevMode: settings.value.filesMode as "floating" | "bottom", filesMode: "fullscreen" });
  }
  closeMenu();
}

function toggleFilesHideOnNav() {
  patch({ filesHideOnNav: !settings.value.filesHideOnNav });
  closeMenu();
}
```

- [ ] **Step 3: Add the tile + dropdown to the template**

Right after the existing `<!-- Terminal tile ... -->` `<button class="dock-terminal" ...>` block, add:

```vue
<!-- Files tile — same mechanics as the Terminal tile, opens the File
     Explorer panel. -->
<button
  class="dock-files"
  :class="{ 'dock-files--active': filesActive }"
  :aria-pressed="filesActive"
  :title="t('files.headerTooltip')"
  :aria-label="t('files.headerLabel')"
  @click="emit('toggleFiles')"
  @contextmenu="openMenu($event, 'files')"
>
  <svg class="dock-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M3 5h6l2 2h10v12H3z" />
  </svg>
</button>
```

And inside the `<Teleport to="body"><div v-if="menu" ...>` context menu, right after the `<template v-if="menu.target === 'terminal'">...</template>` block, add:

```vue
<template v-if="menu.target === 'files'">
  <div class="dock-menu-label">{{ t('files.headerLabel') }}</div>
  <button class="dock-menu-item" role="menuitemcheckbox"
    :aria-checked="filesHideOnNav" @click="toggleFilesHideOnNav">
    {{ t('files.menuHideOnNav') }}
    <span class="dock-menu-check">{{ filesHideOnNav ? '✓' : '' }}</span>
  </button>
  <button class="dock-menu-item" role="menuitemcheckbox"
    :aria-checked="filesIsFullscreen" @click="toggleFilesFullscreen">
    {{ t('files.modeFullscreen') }}
    <span class="dock-menu-check">{{ filesIsFullscreen ? '✓' : '' }}</span>
  </button>
  <div class="dock-menu-sep" role="separator"></div>
  <div class="dock-menu-label">{{ t('files.menuLayout') }}</div>
  <button class="dock-menu-item" role="menuitemradio"
    :aria-checked="filesLayout === 'floating'" @click="setFilesLayout('floating')">
    {{ t('files.modeFloating') }}
    <span class="dock-menu-check">{{ filesLayout === 'floating' ? '✓' : '' }}</span>
  </button>
  <button class="dock-menu-item" role="menuitemradio"
    :aria-checked="filesLayout === 'bottom'" @click="setFilesLayout('bottom')">
    {{ t('files.modeBottom') }}
    <span class="dock-menu-check">{{ filesLayout === 'bottom' ? '✓' : '' }}</span>
  </button>
</template>
```

- [ ] **Step 4: Add minimal `.dock-files` CSS**

In the `<style scoped>` block, find the `.dock-terminal { ... }` rule and add right after it:

```css
.dock-files {
  /* Mirrors .dock-terminal's chrome — same standalone rounded-square tile. */
}

.dock-files--active {
  color: var(--color-accent);
}
```

If `.dock-terminal`'s full rule block has more properties than a placeholder comment implies, copy them verbatim into `.dock-files` instead of the comment (open `AppDock.vue`'s existing `.dock-terminal` CSS rule and duplicate it, renaming the class) — the two tiles must look identical except for the icon and active-state color.

- [ ] **Step 5: Type-check**

Run: `cd apps/desktop && pnpm vue-tsc --noEmit`
Expected: no new errors (the `t("files.*")` calls will show as missing keys at runtime, not at type-check time, until Task 10 adds them — that's expected and resolved by Task 10).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/components/AppDock.vue
git commit -m "feat(desktop): add Files tile to AppDock"
```

---

### Task 9: `App.vue` wiring

**Files:**
- Modify: `apps/desktop/src/App.vue`

**Interfaces:**
- Consumes: `FileExplorerPanel` (Task 6/7), `AppDock`'s `filesActive`/`toggleFiles` (Task 8), `useFileExplorer()` (Task 3), `askConfirm` (existing `App.vue` function).

- [ ] **Step 1: Async-import the component**

Near `const TerminalPanel = defineAsyncComponent(() => import("./components/TerminalPanel.vue"));`, add:

```typescript
const FileExplorerPanel = defineAsyncComponent(() => import("./components/FileExplorerPanel.vue"));
```

- [ ] **Step 2: Add the open/close state**

Near `const showTerminal = ref(false);` / `const termSessions = useTerminalSessions();`, add:

```typescript
const showFiles = ref(false);
const fileExplorer = useFileExplorer();

function toggleFiles() {
  showFiles.value = !showFiles.value;
}

async function onRequestCloseFileTab(tabId: number) {
  if (!repoFolderPath.value) return;
  const tab = fileExplorer.tabsFor(repoFolderPath.value).find((t) => t.id === tabId);
  if (!tab) return;
  if (
    await askConfirm({
      title: t("files.unsavedTitle"),
      message: t("files.unsavedMessage", tab.path),
      confirmLabel: t("files.discardChanges"),
      danger: true,
    })
  ) {
    fileExplorer.closeTab(repoFolderPath.value, tabId);
  }
}
```

(`useFileExplorer` needs importing at the top of `App.vue` alongside the existing `useTerminalSessions` import: `import { useFileExplorer } from "./composables/useFileExplorer";`.)

- [ ] **Step 3: Mount the panel**

Right after the existing `<KeepAlive><TerminalPanel ... /></KeepAlive>` block, add:

```vue
<!-- KeepAlive so toggling the panel deactivates (not unmounts) the
     CodeMirror instance — open tabs and undo history survive a hide/show
     cycle, same rationale as TerminalPanel. -->
<KeepAlive>
  <FileExplorerPanel
    v-if="showFiles && repoFolderPath"
    :repo-path="repoFolderPath"
    :changed-files="repoFiles"
    @close="showFiles = false"
    @request-close-tab="onRequestCloseFileTab"
  />
</KeepAlive>
```

- [ ] **Step 4: Wire the AppDock props/emit**

Find the existing `<AppDock v-if="hasRepo" ... />` line and extend it:

```vue
<AppDock v-if="hasRepo" :view-mode="viewMode" :changes-count="repoFiles.length"
  :pr-count="prPanel.prs.value.length" :terminal-active="showTerminal" :files-active="showFiles"
  @change-view="onViewModeChange" @toggle-terminal="toggleTerminal()" @toggle-files="toggleFiles()" />
```

- [ ] **Step 5: Type-check**

Run: `cd apps/desktop && pnpm vue-tsc --noEmit`
Expected: no new errors.

- [ ] **Step 6: Manual smoke test**

Run: `cd apps/desktop && pnpm dev:web`, open a repo, click the new Files tile in the dock: the panel opens floating by default. Open a file, edit it without saving, click the tab's ✕ — confirm the "unsaved changes" modal appears (via `askConfirm`, not a native browser dialog) and that "Discard changes" actually closes the tab. Right-click the Files tile and confirm the layout submenu switches floating/bottom/fullscreen, matching Terminal's behavior.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/App.vue
git commit -m "feat(desktop): wire FileExplorerPanel into App.vue"
```

---

### Task 10: i18n — `files.*` keys in all 5 locales

**Files:**
- Modify: `apps/desktop/src/locales/en.ts`
- Modify: `apps/desktop/src/locales/fr.ts`
- Modify: `apps/desktop/src/locales/es.ts`
- Modify: `apps/desktop/src/locales/pt-BR.ts`
- Modify: `apps/desktop/src/locales/zh-CN.ts`

**Interfaces:**
- Produces: the `files.*` keys referenced by Task 6/7/8/9 (`headerLabel`, `headerTooltip`, `truncatedBadge`, `truncatedTooltip`, `emptyHint`, `menuHideOnNav`, `menuLayout`, `modeFullscreen`, `modeFloating`, `modeBottom`, `unsavedTitle`, `unsavedMessage`, `discardChanges`).

- [ ] **Step 1: Add the English block (source of truth for keys)**

In `apps/desktop/src/locales/en.ts`, add a new top-level `files: { ... }` block right after the existing `terminal: { ... }` block (before the closing `} as const;`):

```typescript
  files: {
    headerLabel: "Files",
    headerTooltip: "Open file explorer",
    emptyHint: "Click a file in the tree to open it",
    binaryPlaceholder: "This file isn't text — binary preview isn't supported yet",
    truncatedBadge: "Truncated",
    truncatedTooltip: "This repo has more files than can be shown — the list was capped",
    menuHideOnNav: "Hide on menu switch",
    menuLayout: "Layout",
    modeFullscreen: "Fullscreen",
    modeFloating: "Floating",
    modeBottom: "Full-width bottom",
    unsavedTitle: "Unsaved changes",
    unsavedMessage: "\"{0}\" has unsaved changes. Discard them?",
    discardChanges: "Discard changes",
  },
```

- [ ] **Step 2: Add matching blocks to the other 4 locales**

Add the same `files: { ... }` key set (same key names, translated values) to `fr.ts`, `es.ts`, `pt-BR.ts`, `zh-CN.ts`, in the same position relative to their own `terminal: { ... }` block. Translated values:

`fr.ts`:
```typescript
  files: {
    headerLabel: "Fichiers",
    headerTooltip: "Ouvrir l'explorateur de fichiers",
    emptyHint: "Cliquez sur un fichier dans l'arbre pour l'ouvrir",
    binaryPlaceholder: "Ce fichier n'est pas du texte — l'aperçu binaire n'est pas encore pris en charge",
    truncatedBadge: "Tronqué",
    truncatedTooltip: "Ce repo a plus de fichiers qu'il n'est possible d'afficher — la liste a été plafonnée",
    menuHideOnNav: "Masquer au changement de menu",
    menuLayout: "Disposition",
    modeFullscreen: "Plein écran",
    modeFloating: "Flottant",
    modeBottom: "Pleine largeur en bas",
    unsavedTitle: "Modifications non enregistrées",
    unsavedMessage: "« {0} » a des modifications non enregistrées. Les abandonner ?",
    discardChanges: "Abandonner les modifications",
  },
```

`es.ts`:
```typescript
  files: {
    headerLabel: "Archivos",
    headerTooltip: "Abrir explorador de archivos",
    emptyHint: "Haz clic en un archivo del árbol para abrirlo",
    binaryPlaceholder: "Este archivo no es texto — la vista previa binaria aún no es compatible",
    truncatedBadge: "Truncado",
    truncatedTooltip: "Este repo tiene más archivos de los que se pueden mostrar — la lista se limitó",
    menuHideOnNav: "Ocultar al cambiar de menú",
    menuLayout: "Diseño",
    modeFullscreen: "Pantalla completa",
    modeFloating: "Flotante",
    modeBottom: "Ancho completo abajo",
    unsavedTitle: "Cambios sin guardar",
    unsavedMessage: "\"{0}\" tiene cambios sin guardar. ¿Descartarlos?",
    discardChanges: "Descartar cambios",
  },
```

`pt-BR.ts`:
```typescript
  files: {
    headerLabel: "Arquivos",
    headerTooltip: "Abrir explorador de arquivos",
    emptyHint: "Clique em um arquivo na árvore para abri-lo",
    binaryPlaceholder: "Este arquivo não é texto — a pré-visualização binária ainda não é compatível",
    truncatedBadge: "Truncado",
    truncatedTooltip: "Este repositório tem mais arquivos do que é possível exibir — a lista foi limitada",
    menuHideOnNav: "Ocultar ao trocar de menu",
    menuLayout: "Layout",
    modeFullscreen: "Tela cheia",
    modeFloating: "Flutuante",
    modeBottom: "Largura total embaixo",
    unsavedTitle: "Alterações não salvas",
    unsavedMessage: "\"{0}\" tem alterações não salvas. Descartá-las?",
    discardChanges: "Descartar alterações",
  },
```

`zh-CN.ts`:
```typescript
  files: {
    headerLabel: "文件",
    headerTooltip: "打开文件浏览器",
    emptyHint: "点击树中的文件以打开它",
    binaryPlaceholder: "该文件不是文本文件 — 暂不支持二进制预览",
    truncatedBadge: "已截断",
    truncatedTooltip: "此仓库的文件数量超出可显示范围 — 列表已被截断",
    menuHideOnNav: "切换菜单时隐藏",
    menuLayout: "布局",
    modeFullscreen: "全屏",
    modeFloating: "浮动",
    modeBottom: "底部通栏",
    unsavedTitle: "未保存的更改",
    unsavedMessage: "「{0}」有未保存的更改。要放弃吗？",
    discardChanges: "放弃更改",
  },
```

- [ ] **Step 3: Verify locale key parity**

Run: `cd apps/desktop && pnpm vue-tsc --noEmit`
Expected: no errors. The `Widen<T>` type machinery in `en.ts` (referenced by the other locale files' type) will fail to compile if any locale is missing a key that `en.ts` has — this is the existing built-in guard for i18n parity, so a clean type-check here is sufficient proof all 5 locales match.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/locales/en.ts apps/desktop/src/locales/fr.ts apps/desktop/src/locales/es.ts apps/desktop/src/locales/pt-BR.ts apps/desktop/src/locales/zh-CN.ts
git commit -m "feat(desktop): add files.* i18n keys for the File Explorer panel"
```

---

### Task 11: Full verification pass

**Files:** none (verification only).

- [ ] **Step 1: Run the full Rust test suite**

Run: `cd apps/desktop/src-tauri && cargo test`
Expected: all tests pass, including the new `repo_tree_tests` and `list_repo_tree_tests`.

- [ ] **Step 2: Run the full frontend test suite**

Run: `cd apps/desktop && pnpm test`
Expected: all tests pass, including the new `useFileExplorer.test.ts` and `useRepoFileTree.test.ts`.

- [ ] **Step 3: Full type-check and build**

Run: `cd apps/desktop && pnpm build`
Expected: builds cleanly (Vite + `vue-tsc`).

- [ ] **Step 4: End-to-end manual walkthrough with `pnpm dev:web`**

Run: `cd apps/desktop && pnpm dev:web`. In the running app:
1. Open the GitWand repo itself (or any repo) as the test target.
2. Click the Files tile in `AppDock` — panel opens floating.
3. Expand a few folders, confirm `.gitignore`d directories (e.g. `node_modules`, `dist`) are absent.
4. Single-click a file — opens as an italic preview tab; single-click a second file — replaces the preview tab (only one non-pinned tab at a time).
5. Double-click a file — opens as a permanent (non-italic) tab that survives opening other files.
6. Edit a file, confirm the dirty dot appears, press `⌘S`, confirm it's saved (re-open the file externally or check `git diff` reflects the change) and the dot disappears.
7. Try closing a dirty tab via its ✕ — confirm the `askConfirm` modal appears (not a native browser `confirm()`), and "Discard changes" actually discards.
8. Right-click the Files tile, switch to "Full-width bottom", confirm the panel docks at the bottom pushing nothing else broken; switch to "Fullscreen"; toggle back to floating.
9. Switch the app's language (Settings) to French and confirm the Files tile tooltip and panel labels are translated.
10. Confirm the Terminal panel still works unaffected (regression check — Terminal and Files should be independently toggleable, both open simultaneously without layout collision if both are "floating").

- [ ] **Step 5: Report results**

If every check in Step 4 passes and Steps 1-3 are green, the feature is complete. If any check fails, fix forward with a new task-scoped commit rather than amending — note the failure and the fix in the final summary to the user.
