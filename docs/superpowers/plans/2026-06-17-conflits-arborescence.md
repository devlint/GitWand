# Tree-Conflict Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect and resolve git tree conflicts (modify/delete, both-deleted, add/delete) that currently show as "0 conflit", with a sidebar badge and a dedicated resolution panel offering keep-ours / keep-theirs / delete.

**Architecture:** A Rust backend command reads unmerged index stages from `git status --porcelain=v2` and returns per-path `{hasOurs, hasTheirs, hasBase, code}`; a second command applies a resolution via `git checkout --ours/--theirs + add` or `git rm -f`. The frontend tags such `ConflictFile`s with a `tree` field, shows a distinct badge in the file list, and renders a dedicated panel (instead of the diff) whose available actions are driven by which sides exist. No `packages/core` change.

**Tech Stack:** Rust (Tauri commands, `std::process::Command`), Vue 3 `<script setup>` + TypeScript, Vitest, `cargo test`, pnpm.

## Global Constraints

- pnpm only. No `packages/core` change (preserves Rust↔TS parity).
- **Security (AGENTS.md):** never build git commands via shell string interpolation — pass args as arrays / `.arg()` chaining. Validate every user-supplied path through `safe_repo_path()` (from `src/git/cmd.rs`). Never log secrets.
- **IPC:** every new `#[tauri::command]` gets a typed wrapper in `apps/desktop/src/utils/backend.ts` in the same task; register the command in `lib.rs`'s `tauri::generate_handler![]`. Never call `invoke()` outside `backend.ts`.
- **Vue:** Composition API `<script setup>` only; business logic in composables.
- **i18n:** every user-visible string keyed in all 5 locales (`en.ts`, `fr.ts`, `es.ts`, `pt-BR.ts`, `zh-CN.ts`). Interpolation positional `{0}`. `t(key, ...args)`.
- **Versions:** never hand-edit version files.
- **Tests:** real temp git repos, no git mocking. Rust tests in `#[cfg(test)] mod tests` in the same file; use a `TempRepo` helper (see Task 1).
- **`.bm-btn`** stays unprefixed at specificity `(0,1,0)` — new buttons use their own classes.
- Commands from `apps/desktop/`: `pnpm test` (Vitest), `pnpm build` (vue-tsc + vite). Rust from `apps/desktop/src-tauri/`: `cargo test`.

**Stage-driven model.** A tree conflict is an unmerged path where NOT both ours(stage2) and theirs(stage3) are present (`!(has_ours && has_theirs)`) — this captures modify/delete (one side missing), both-deleted (both missing), and add/delete; it excludes content conflicts `UU`/`AA` (both present → they carry `<<<<<<<` markers, handled by the existing flow). Actions: "keep ours" iff `hasOurs`, "keep theirs" iff `hasTheirs`, "delete" always.

---

### Task 1: Rust — `get_tree_conflicts` + `TreeConflict` struct

**Files:**
- Modify: `apps/desktop/src-tauri/src/types.rs` (add `TreeConflict` struct)
- Modify: `apps/desktop/src-tauri/src/commands/ops.rs` (add `get_tree_conflicts` + tests)
- Modify: `apps/desktop/src-tauri/src/lib.rs` (register command in `generate_handler!`)

**Interfaces:**
- Produces:
  ```rust
  #[derive(Serialize)]
  #[serde(rename_all = "camelCase")]
  pub struct TreeConflict { pub path: String, pub code: String, pub has_base: bool, pub has_ours: bool, pub has_theirs: bool }

  #[tauri::command]
  pub(crate) async fn get_tree_conflicts(cwd: String) -> Result<Vec<TreeConflict>, String>
  ```
  Serializes to TS as `{ path, code, hasBase, hasOurs, hasTheirs }`. Returns only unmerged paths where `!(has_ours && has_theirs)`.

- [ ] **Step 1: Add the struct to `types.rs`**

Append near the other `#[derive(Serialize)]` structs in `apps/desktop/src-tauri/src/types.rs`:

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeConflict {
    pub path: String,
    /// git short-status code, e.g. "UD", "DU", "DD", "AU", "UA"
    pub code: String,
    pub has_base: bool,
    pub has_ours: bool,
    pub has_theirs: bool,
}
```

- [ ] **Step 2: Write the failing test**

Add to the `#[cfg(test)] mod tests` block at the bottom of `apps/desktop/src/../src-tauri/src/commands/ops.rs` (i.e. `apps/desktop/src-tauri/src/commands/ops.rs`). If that file has no test module yet, create one using this `TempRepo` helper (copied from the codebase pattern in `read.rs`):

```rust
#[cfg(test)]
mod tree_conflict_tests {
    use super::*;
    use crate::git::cmd::git_binary;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TempRepo { path: PathBuf }
    impl Drop for TempRepo { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.path); } }
    impl TempRepo {
        fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let pid = std::process::id();
            let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let dir = std::env::temp_dir().join(format!("gitwand-tree-test-{}-{}-{}", pid, n, nanos));
            std::fs::create_dir_all(&dir).unwrap();
            let repo = TempRepo { path: dir };
            repo.git(&["init", "-q", "-b", "main"]);
            repo.git(&["config", "user.name", "Test"]);
            repo.git(&["config", "user.email", "test@example.com"]);
            repo.git(&["config", "commit.gpgsign", "false"]);
            repo
        }
        fn cwd(&self) -> String { self.path.to_str().unwrap().to_string() }
        fn git(&self, args: &[&str]) -> std::process::Output {
            let out = Command::new(git_binary()).args(args).current_dir(&self.path).output()
                .unwrap_or_else(|e| panic!("git {:?} spawn: {}", args, e));
            // NOTE: callers that expect non-zero status (e.g. a conflicting merge) must use git_allow_fail.
            out
        }
        fn git_ok(&self, args: &[&str]) {
            let out = self.git(args);
            assert!(out.status.success(), "git {:?} failed: {}", args, String::from_utf8_lossy(&out.stderr));
        }
        fn write(&self, rel: &str, content: &str) {
            let p = self.path.join(rel);
            if let Some(parent) = p.parent() { std::fs::create_dir_all(parent).unwrap(); }
            std::fs::write(p, content).unwrap();
        }
        fn commit_all(&self, msg: &str) { self.git_ok(&["add", "-A"]); self.git_ok(&["commit", "-q", "-m", msg]); }
    }

    /// Build a modify/delete conflict: main deletes the file, feature modifies it,
    /// then merge main into feature → "UD" (modified by us / deleted by them).
    fn make_modify_delete(repo: &TempRepo) {
        repo.write("doomed.txt", "original\n");
        repo.commit_all("base");
        repo.git_ok(&["checkout", "-q", "-b", "feature"]);
        repo.write("doomed.txt", "MODIFIED by feature\n");
        repo.commit_all("feature modifies");
        repo.git_ok(&["checkout", "-q", "main"]);
        repo.git_ok(&["rm", "-q", "doomed.txt"]);
        repo.commit_all("main deletes");
        repo.git_ok(&["checkout", "-q", "feature"]);
        // Merge main into feature — conflicts, returns non-zero; ignore status.
        let _ = repo.git(&["merge", "--no-edit", "main"]);
    }

    #[test]
    fn detects_modify_delete_as_tree_conflict() {
        let repo = TempRepo::new();
        make_modify_delete(&repo);
        let conflicts = tokio_test_block(get_tree_conflicts(repo.cwd()));
        let tc = conflicts.iter().find(|c| c.path == "doomed.txt").expect("doomed.txt is a tree conflict");
        assert!(tc.has_ours, "feature (ours) modified it → stage 2 present");
        assert!(!tc.has_theirs, "main (theirs) deleted it → stage 3 absent");
        assert_eq!(tc.code, "UD");
    }

    #[test]
    fn excludes_pure_content_conflict() {
        let repo = TempRepo::new();
        repo.write("shared.txt", "a\nb\nc\n");
        repo.commit_all("base");
        repo.git_ok(&["checkout", "-q", "-b", "feature"]);
        repo.write("shared.txt", "a\nFEATURE\nc\n");
        repo.commit_all("feature");
        repo.git_ok(&["checkout", "-q", "main"]);
        repo.write("shared.txt", "a\nMAIN\nc\n");
        repo.commit_all("main");
        repo.git_ok(&["checkout", "-q", "feature"]);
        let _ = repo.git(&["merge", "--no-edit", "main"]);
        let conflicts = tokio_test_block(get_tree_conflicts(repo.cwd()));
        assert!(conflicts.iter().all(|c| c.path != "shared.txt"), "content conflict (UU) must NOT be reported as a tree conflict");
    }

    // Minimal async test driver (commands are async). Uses a current-thread runtime.
    fn tokio_test_block<F: std::future::Future>(fut: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(fut)
    }
}
```

(If `tokio` is not already a dev/dependency usable in tests, the implementer should instead make `get_tree_conflicts` delegate to a synchronous helper `fn collect_tree_conflicts(cwd: &str) -> Result<Vec<TreeConflict>, String>` and test that helper directly without an async runtime. Prefer the sync-helper approach if it avoids adding a tokio test dependency — see Step 4 note.)

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/desktop/src-tauri && cargo test tree_conflict_tests 2>&1 | tail -20`
Expected: FAIL — `get_tree_conflicts` not found / unresolved.

- [ ] **Step 4: Implement `get_tree_conflicts`**

Add to `apps/desktop/src-tauri/src/commands/ops.rs` (near `get_conflicted_files`, ~line 2454). To keep the unit test free of an async runtime, split into a sync helper + thin async command:

```rust
use crate::types::TreeConflict;

/// Parse `git status --porcelain=v2` and return unmerged paths that are *tree*
/// conflicts (not pure content conflicts). A porcelain-v2 unmerged line looks like:
///   u <XY> <sub> <m1> <m2> <m3> <h1> <h2> <h3> <path>
/// where m1/m2/m3 are the octal modes for stages 1/2/3 ("000000" when the stage
/// is absent). We treat a path as a tree conflict when NOT (stage2 && stage3),
/// i.e. at least one of ours/theirs is missing — modify/delete, both-deleted,
/// add/delete. Pure content conflicts (UU, AA) have both stages and carry
/// `<<<<<<<` markers, so the existing content flow handles them.
fn collect_tree_conflicts(cwd: &str) -> Result<Vec<TreeConflict>, String> {
    let output = git_cmd()
        .args(["status", "--porcelain=v2", "--untracked-files=no"])
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("Failed to run git status: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git status failed: {}", stderr));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut result = Vec::new();
    for line in stdout.lines() {
        // Unmerged entries start with "u ".
        let Some(rest) = line.strip_prefix("u ") else { continue };
        // Split off the first 9 fields; the path is everything after them.
        let mut parts = rest.splitn(9, ' ');
        let code = parts.next().unwrap_or("").to_string();   // XY
        let _sub = parts.next();                              // submodule state
        let m1 = parts.next().unwrap_or("000000");           // stage 1 (base)
        let m2 = parts.next().unwrap_or("000000");           // stage 2 (ours)
        let m3 = parts.next().unwrap_or("000000");           // stage 3 (theirs)
        let _h1 = parts.next();
        let _h2 = parts.next();
        let _h3 = parts.next();
        let path = parts.next().unwrap_or("").to_string();   // remainder = path
        if path.is_empty() { continue; }
        let has_base = m1 != "000000";
        let has_ours = m2 != "000000";
        let has_theirs = m3 != "000000";
        // Only markerless tree conflicts: at least one side missing.
        if has_ours && has_theirs { continue; }
        result.push(TreeConflict { path, code, has_base, has_ours, has_theirs });
    }
    Ok(result)
}

#[tauri::command]
pub(crate) async fn get_tree_conflicts(cwd: String) -> Result<Vec<TreeConflict>, String> {
    collect_tree_conflicts(&cwd)
}
```

If you used the sync-helper testing approach, change the tests to call `collect_tree_conflicts(&repo.cwd())` directly (no `tokio_test_block`).

- [ ] **Step 5: Register the command in `lib.rs`**

In `apps/desktop/src-tauri/src/lib.rs`, inside `tauri::generate_handler![...]` (lines ~272-399), add next to `commands::ops::get_conflicted_files,`:

```rust
    commands::ops::get_tree_conflicts,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/desktop/src-tauri && cargo test tree_conflict_tests 2>&1 | tail -20`
Expected: PASS — both tests green (modify/delete detected with `has_ours && !has_theirs`, `code=="UD"`; content conflict excluded).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/src/types.rs apps/desktop/src-tauri/src/commands/ops.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): get_tree_conflicts backend command for markerless conflicts"
```

---

### Task 2: Rust — `resolve_tree_conflict`

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/ops.rs` (add `resolve_tree_conflict` + tests)
- Modify: `apps/desktop/src-tauri/src/lib.rs` (register command)

**Interfaces:**
- Consumes: `collect_tree_conflicts` (Task 1), `git_cmd`, `safe_repo_path`.
- Produces:
  ```rust
  #[tauri::command]
  pub(crate) async fn resolve_tree_conflict(cwd: String, path: String, choice: String) -> Result<(), String>
  ```
  `choice` ∈ `"ours" | "theirs" | "delete"`.

- [ ] **Step 1: Write the failing test**

Add to the same test module in `ops.rs` (reuses `TempRepo` and `make_modify_delete` from Task 1):

```rust
    #[test]
    fn resolve_keep_ours_stages_modified_version() {
        let repo = TempRepo::new();
        make_modify_delete(&repo); // feature(ours) modified doomed.txt, main(theirs) deleted it
        tokio_test_block(resolve_tree_conflict(repo.cwd(), "doomed.txt".into(), "ours".into())).unwrap();
        // No longer unmerged:
        assert!(collect_tree_conflicts(&repo.cwd()).unwrap().iter().all(|c| c.path != "doomed.txt"));
        // Working tree keeps the modified version:
        assert_eq!(std::fs::read_to_string(repo.path.join("doomed.txt")).unwrap(), "MODIFIED by feature\n");
    }

    #[test]
    fn resolve_delete_removes_the_file() {
        let repo = TempRepo::new();
        make_modify_delete(&repo);
        tokio_test_block(resolve_tree_conflict(repo.cwd(), "doomed.txt".into(), "delete".into())).unwrap();
        assert!(collect_tree_conflicts(&repo.cwd()).unwrap().iter().all(|c| c.path != "doomed.txt"));
        assert!(!repo.path.join("doomed.txt").exists(), "file removed from working tree");
    }

    #[test]
    fn resolve_rejects_unknown_choice() {
        let repo = TempRepo::new();
        make_modify_delete(&repo);
        let err = tokio_test_block(resolve_tree_conflict(repo.cwd(), "doomed.txt".into(), "bogus".into()));
        assert!(err.is_err(), "unknown choice must error");
    }
```

(If using the sync-helper approach from Task 1, give `resolve_tree_conflict` a sync helper `apply_tree_resolution(cwd, path, choice)` and test that instead.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop/src-tauri && cargo test tree_conflict_tests 2>&1 | tail -20`
Expected: FAIL — `resolve_tree_conflict` not found.

- [ ] **Step 3: Implement `resolve_tree_conflict`**

Add to `ops.rs` (after `get_tree_conflicts`). Validate the path with `safe_repo_path` (guard against traversal), then run git with the relative pathspec and `current_dir`:

```rust
use crate::git::cmd::safe_repo_path;

/// Run a git command (args array, no shell interpolation) in `cwd`, mapping failure to a message.
fn run_git_checked(cwd: &str, args: &[&str], what: &str) -> Result<(), String> {
    let output = git_cmd()
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("Failed to run git {}: {}", what, e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git {} failed: {}", what, stderr.trim()));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn resolve_tree_conflict(cwd: String, path: String, choice: String) -> Result<(), String> {
    // Guard against path traversal; we still pass the *relative* path to git.
    let _ = safe_repo_path(&cwd, &path)?;
    match choice.as_str() {
        "ours" => {
            run_git_checked(&cwd, &["checkout", "--ours", "--", &path], "checkout --ours")?;
            run_git_checked(&cwd, &["add", "--", &path], "add")?;
        }
        "theirs" => {
            run_git_checked(&cwd, &["checkout", "--theirs", "--", &path], "checkout --theirs")?;
            run_git_checked(&cwd, &["add", "--", &path], "add")?;
        }
        "delete" => {
            run_git_checked(&cwd, &["rm", "-f", "--", &path], "rm")?;
        }
        other => return Err(format!("unknown choice: {}", other)),
    }
    Ok(())
}
```

- [ ] **Step 4: Register the command in `lib.rs`**

In `tauri::generate_handler![...]`, add next to `commands::ops::get_tree_conflicts,`:

```rust
    commands::ops::resolve_tree_conflict,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/desktop/src-tauri && cargo test tree_conflict_tests 2>&1 | tail -20`
Expected: PASS — keep-ours stages the modified file, delete removes it, unknown choice errors.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/commands/ops.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): resolve_tree_conflict backend command (ours/theirs/delete)"
```

---

### Task 3: IPC wrappers in `backend.ts`

**Files:**
- Modify: `apps/desktop/src/utils/backend.ts`

**Interfaces:**
- Consumes: Tauri commands `get_tree_conflicts`, `resolve_tree_conflict` (Tasks 1-2).
- Produces:
  ```ts
  export interface TreeConflict { path: string; code: string; hasBase: boolean; hasOurs: boolean; hasTheirs: boolean }
  export function getTreeConflicts(cwd: string): Promise<TreeConflict[]>
  export function resolveTreeConflict(cwd: string, path: string, choice: "ours" | "theirs" | "delete"): Promise<void>
  ```

- [ ] **Step 1: Add the wrappers**

In `apps/desktop/src/utils/backend.ts`, near `getConflictedFiles` / `gitStage`, add (match the existing `isTauri()` / `tauriInvoke` pattern; the dev server has no tree-conflict support, so degrade safely):

```ts
export interface TreeConflict {
  path: string;
  /** git short-status code: "UD" | "DU" | "DD" | "AU" | "UA" | ... */
  code: string;
  hasBase: boolean;
  hasOurs: boolean;
  hasTheirs: boolean;
}

export async function getTreeConflicts(cwd: string): Promise<TreeConflict[]> {
  if (isTauri()) {
    return tauriInvoke<TreeConflict[]>("get_tree_conflicts", { cwd });
  }
  return []; // dev-server mock has no tree conflicts
}

export async function resolveTreeConflict(
  cwd: string,
  path: string,
  choice: "ours" | "theirs" | "delete",
): Promise<void> {
  if (isTauri()) {
    await tauriInvoke("resolve_tree_conflict", { cwd, path, choice });
    return;
  }
  throw new Error("resolveTreeConflict is not available in dev-server mode");
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/desktop && pnpm build`
Expected: PASS — vue-tsc no errors. (Confirm `isTauri` and `tauriInvoke` are already imported in `backend.ts`; they are used by neighbouring wrappers.)

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/utils/backend.ts
git commit -m "feat(desktop): backend.ts wrappers for tree-conflict commands"
```

---

### Task 4: i18n keys (5 locales)

**Files:**
- Modify: `apps/desktop/src/locales/{en,fr,es,pt-BR,zh-CN}.ts`

**Interfaces:**
- Produces these keys (English source; French given verbatim, translate es/pt-BR/zh-CN), under a `merge` (or `mergeEditor`) namespace — place near existing `merge.*` conflict keys:
  - `merge.treeTitle` = `"Tree conflict"` / fr `"Conflit d'arborescence"`
  - `merge.treeBadge` = `"deleted"` / fr `"supprimé"`
  - `merge.treeKeepOurs` = `"Keep current version"` / fr `"Garder la version courante"`
  - `merge.treeKeepTheirs` = `"Keep incoming version"` / fr `"Garder la version entrante"`
  - `merge.treeAcceptDelete` = `"Accept deletion"` / fr `"Accepter la suppression"`
  - `merge.treeModifiedOursDeletedTheirs` = `"Modified on current side, deleted on incoming side"` / fr `"Modifié côté courant, supprimé côté entrant"`
  - `merge.treeDeletedOursModifiedTheirs` = `"Deleted on current side, modified on incoming side"` / fr `"Supprimé côté courant, modifié côté entrant"`
  - `merge.treeBothDeleted` = `"Deleted on both sides"` / fr `"Supprimé des deux côtés"`
  - `merge.treeBothPresent` = `"Added on both sides"` / fr `"Ajouté des deux côtés"`
  - `merge.treePreviewLabel` = `"Preview of the kept content"` / fr `"Aperçu du contenu conservé"`

- [ ] **Step 1: Invoke the i18n-sync skill**

Use the `i18n-sync` skill to add the 10 keys above into all 5 locale files in the `merge` namespace, with translations for fr (verbatim above), es, pt-BR, zh-CN.

- [ ] **Step 2: Typecheck the locale index**

Run: `cd apps/desktop && pnpm build`
Expected: PASS — locale `index.ts` type-merges with no missing-key errors.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/locales
git commit -m "i18n: tree-conflict resolution keys across 5 locales"
```

---

### Task 5: `useGitWand` — tag tree conflicts + resolve flow

**Files:**
- Modify: `apps/desktop/src/composables/useGitWand.ts`

**Interfaces:**
- Consumes: `getTreeConflicts`, `resolveTreeConflict`, `TreeConflict` (Task 3).
- Produces:
  ```ts
  export interface TreeConflictInfo { code: string; hasOurs: boolean; hasTheirs: boolean; hasBase: boolean }
  // ConflictFile gains: tree?: TreeConflictInfo
  resolveTreeConflictFile(path: string, choice: "ours" | "theirs" | "delete"): Promise<void>
  ```

- [ ] **Step 1: Extend imports and `ConflictFile`**

Add to the `@/utils/backend` import in `useGitWand.ts`:
```ts
import { getTreeConflicts, resolveTreeConflict } from "@/utils/backend";
```
(extend the existing import line if one already pulls from that module). Add the type and field:
```ts
export interface TreeConflictInfo {
  code: string;
  hasOurs: boolean;
  hasTheirs: boolean;
  hasBase: boolean;
}
```
And in `ConflictFile` (around line 15):
```ts
export interface ConflictFile {
  path: string;
  content: string;
  result: MergeResult;
  tree?: TreeConflictInfo;
}
```

- [ ] **Step 2: Enrich `loadRealFiles` to tag tree conflicts**

In `loadRealFiles` (around line 324), after `const conflictedPaths = await getConflictedFiles(cwd);`, fetch tree conflicts and build a lookup, then branch per path. Replace the existing per-path mapping so tree-conflict paths are built without marker parsing and tolerate a missing working-tree file:

```ts
const treeConflicts = await getTreeConflicts(cwd);
const treeMap = new Map(treeConflicts.map(t => [t.path, t]));
// Union: tree conflicts may include paths (e.g. both-deleted) the marker scan would choke on.
const allPaths = Array.from(new Set([...conflictedPaths, ...treeConflicts.map(t => t.path)]));

const loaded: ConflictFile[] = await Promise.all(
  allPaths.map(async (filePath) => {
    const tc = treeMap.get(filePath);
    if (tc) {
      // Tree conflict: do not parse markers. Read working-tree content best-effort (for preview).
      let content = "";
      try { content = await readFile(cwd, filePath); } catch { /* file may be absent (both-deleted) */ }
      return {
        path: filePath,
        content,
        result: await resolveAsync(content, filePath, resolveOptionsWithLlm, structuralOpts),
        tree: { code: tc.code, hasOurs: tc.hasOurs, hasTheirs: tc.hasTheirs, hasBase: tc.hasBase },
      };
    }
    const content = await readFile(cwd, filePath);
    return {
      path: filePath,
      content,
      result: await resolveAsync(content, filePath, resolveOptionsWithLlm, structuralOpts),
    };
  }),
);
```

(Use the exact `resolveAsync(...)` argument list already present in the file — copy it from the existing mapping; the names `resolveOptionsWithLlm` / `structuralOpts` are placeholders for whatever the current call uses.)

- [ ] **Step 3: Add `resolveTreeConflictFile`**

Add a method (near `resolveFileBulk`), and export it in the `return {...}` block:

```ts
/**
 * Resolve a tree conflict (modify/delete, both-deleted, …) via the backend,
 * then drop the file from the conflict list. The backend stages/removes the
 * path, so no save is needed. Throws on backend error.
 */
async function resolveTreeConflictFile(
  path: string,
  choice: "ours" | "theirs" | "delete",
): Promise<void> {
  if (!folderPath.value) return;
  await resolveTreeConflict(folderPath.value, path, choice);
  files.value = files.value.filter((f) => f.path !== path);
  if (selectedPath.value === path) {
    selectedPath.value = files.value[0]?.path ?? null;
  }
}
```
Add `resolveTreeConflictFile,` to the returned object.

- [ ] **Step 4: Typecheck + tests**

Run: `cd apps/desktop && pnpm build && pnpm test`
Expected: PASS — vue-tsc clean, full Vitest suite green (no regressions).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/composables/useGitWand.ts
git commit -m "feat(desktop): tag tree conflicts in loadRealFiles + resolveTreeConflictFile"
```

---

### Task 6: `FileList` — tree-conflict badge

**Files:**
- Modify: `apps/desktop/src/components/FileList.vue`

**Interfaces:**
- Consumes: `ConflictFile.tree` (Task 5), i18n key `merge.treeBadge` (Task 4).

- [ ] **Step 1: Add a tree branch to the per-file status indicator**

In `FileList.vue`, the per-file status icon/badge is chosen from `file.result.stats` (around lines 28-31 for the icon, line 72 for the count badge). Add a FIRST branch that, when `file.tree` is set, renders a distinct badge instead of the "0 conflit"/resolved state. Concretely, wrap the existing status display so a tree conflict shows the `merge.treeBadge` label with a distinct class. Add, at the top of the status area:

```vue
<span v-if="file.tree" class="file-status file-status--tree" :title="t('merge.treeBadge')">
  {{ t('merge.treeBadge') }}
</span>
<template v-else>
  <!-- existing status icon / count badge markup stays here unchanged -->
</template>
```

(Adapt the exact element/structure to the existing markup — the key requirement: when `file.tree` is truthy, the row must NOT show "0 conflit"/resolved, and must show the `merge.treeBadge` text with the `file-status--tree` class.)

- [ ] **Step 2: Add minimal styling**

In `FileList.vue`'s `<style>`, add:
```css
.file-status--tree {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--color-warning-bg, rgba(184, 134, 11, 0.15));
  color: var(--color-warning, #b8860b);
}
```
(Match neighbouring status-badge styles if the component already defines a palette.)

- [ ] **Step 3: Typecheck**

Run: `cd apps/desktop && pnpm build`
Expected: PASS — no type errors; `file.tree` is a known optional field.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/components/FileList.vue
git commit -m "feat(desktop): distinct sidebar badge for tree conflicts"
```

---

### Task 7: `MergeEditor` tree panel + `App.vue` wiring

**Files:**
- Modify: `apps/desktop/src/components/MergeEditor.vue` (tree panel + new emit)
- Modify: `apps/desktop/src/App.vue` (handler + binding + small refactor)

**Interfaces:**
- Consumes: `ConflictFile.tree` (Task 5), `resolveTreeConflictFile` (Task 5), i18n keys (Task 4).
- Produces: MergeEditor emit `resolveTreeConflict: [path: string, choice: "ours" | "theirs" | "delete"]`.

- [ ] **Step 1: Add the emit + helpers to `MergeEditor.vue`**

In `defineEmits` (lines ~34-40), add:
```ts
  resolveTreeConflict: [path: string, choice: "ours" | "theirs" | "delete"];
```
In `<script setup>`, add a computed for the explanation text (place after `hunks` is defined, ~line 264 area, to avoid TDZ):
```ts
const treeExplanation = computed(() => {
  const tr = props.file.tree;
  if (!tr) return "";
  if (tr.hasOurs && !tr.hasTheirs) return t("merge.treeModifiedOursDeletedTheirs");
  if (!tr.hasOurs && tr.hasTheirs) return t("merge.treeDeletedOursModifiedTheirs");
  if (!tr.hasOurs && !tr.hasTheirs) return t("merge.treeBothDeleted");
  return t("merge.treeBothPresent");
});
```

- [ ] **Step 2: Render the tree panel instead of the diff when `file.tree` is set**

In the template, the editor body (the `<div class="merge-body">` region, ~line 683) renders the diff/segments. Wrap so that when `file.tree` is set, a dedicated panel renders INSTEAD. Add immediately before the `<div class="merge-body">`:

```vue
    <!-- Tree conflict panel (modify/delete, both-deleted, …) -->
    <div v-if="file.tree" class="me-tree-panel">
      <h3 class="me-tree-title">{{ t('merge.treeTitle') }} — <span class="mono">{{ file.path }}</span></h3>
      <p class="me-tree-explanation">{{ treeExplanation }}</p>
      <div class="me-tree-actions">
        <button v-if="file.tree.hasOurs" class="me-bulk-btn" @click="emit('resolveTreeConflict', file.path, 'ours')">
          {{ t('merge.treeKeepOurs') }}
        </button>
        <button v-if="file.tree.hasTheirs" class="me-bulk-btn" @click="emit('resolveTreeConflict', file.path, 'theirs')">
          {{ t('merge.treeKeepTheirs') }}
        </button>
        <button class="me-bulk-btn me-tree-delete" @click="emit('resolveTreeConflict', file.path, 'delete')">
          {{ t('merge.treeAcceptDelete') }}
        </button>
      </div>
      <template v-if="file.content">
        <div class="me-tree-preview-label muted">{{ t('merge.treePreviewLabel') }}</div>
        <pre class="me-tree-preview">{{ file.content }}</pre>
      </template>
    </div>
```
Then guard the existing body so it does NOT render for tree conflicts — change the `<div class="merge-body">` opening to:
```vue
    <div class="merge-body" v-if="!file.tree">
```

- [ ] **Step 3: Add minimal styling**

In `MergeEditor.vue`'s `<style>`, add (do NOT touch `.bm-btn`; reuse `.me-bulk-btn` from the existing bulk buttons):
```css
.me-tree-panel { padding: 20px; overflow: auto; }
.me-tree-title { font-size: 14px; margin: 0 0 8px; }
.me-tree-explanation { margin: 0 0 14px; color: var(--color-text-secondary, #888); }
.me-tree-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
.me-tree-delete { color: var(--color-danger, #c0392b); }
.me-tree-preview-label { font-size: 11px; margin-bottom: 4px; }
.me-tree-preview {
  margin: 0; padding: 10px; max-height: 320px; overflow: auto;
  background: var(--color-bg-secondary, #f5f5f5); border-radius: 6px;
  font-family: var(--font-mono, monospace); font-size: 12px; white-space: pre-wrap;
}
```

- [ ] **Step 4: Wire `App.vue` — extract advance helper + add handler + binding**

(a) Refactor the tail of `checkAndSaveIfResolved` (lines 571-582) into a reusable helper so the tree handler shares the exact advance/continue logic. Add this function just before `checkAndSaveIfResolved`:
```ts
async function advanceToNextConflictOrFinalize() {
  await repoRefresh();
  if (repoStatus.value && repoStatus.value.conflicted.length > 0) {
    await repoSelectFile(repoStatus.value.conflicted[0], false);
  } else if (isCherryPicking.value) {
    await doCherryPickContinue();
  } else {
    await doMergeContinue();
    showMergeSuccess.value = true;
  }
}
```
Then replace lines 571-582 inside `checkAndSaveIfResolved`'s `try` (the block from `// Move to the next conflicted file` through the `showMergeSuccess.value = true;` else-branch) with:
```ts
    await advanceToNextConflictOrFinalize();
```
(Keep the preceding `await saveFile(filePath); await stageFiles([filePath]);` lines.)

(b) Destructure `resolveTreeConflictFile` from `useGitWand()` (near line 124, alongside `resolveFileBulk`).

(c) Add the handler after `handleResolveFileBulk` (~line 608):
```ts
async function handleResolveTreeConflict(path: string, choice: "ours" | "theirs" | "delete") {
  try {
    await resolveTreeConflictFile(path, choice);
    await advanceToNextConflictOrFinalize();
  } catch (err: any) {
    repoError.value = `tree-resolve: ${err?.message || String(err)}`;
  }
}
```

(d) Bind the event on `<MergeEditor>` (~line 2313), extending the existing bindings:
```vue
                @resolve-tree-conflict="(path, choice) => handleResolveTreeConflict(path, choice)"
```

- [ ] **Step 5: Typecheck + tests**

Run: `cd apps/desktop && pnpm build && pnpm test`
Expected: PASS — vue-tsc clean (App binding matches the new MergeEditor emit), Vitest suite green.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/components/MergeEditor.vue apps/desktop/src/App.vue
git commit -m "feat(desktop): tree-conflict panel + wiring with shared merge-advance helper"
```

---

### Task 8: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Rust tests**

Run: `cd apps/desktop/src-tauri && cargo test tree_conflict_tests 2>&1 | tail -20`
Expected: PASS — all tree-conflict Rust tests green.

- [ ] **Step 2: Frontend tests + build**

Run: `cd apps/desktop && pnpm test && pnpm build`
Expected: PASS — Vitest suite green, vue-tsc + vite build clean.

- [ ] **Step 3: Confirm zero `packages/core` change**

Run: `git diff --stat <merge-base>..HEAD -- packages/core`
Expected: empty (parity intact).

- [ ] **Step 4: Manual verification**

Build the app (`cd apps/desktop && pnpm dev`) against a repo with a real modify/delete conflict. Verify: the file shows the `deleted` badge in the sidebar (not "0 conflit"); selecting it shows the tree panel with the correct explanation and only the applicable buttons; "Accept deletion" removes it and advances; "Keep current version" stages the modified file and advances; resolving the last conflict finalizes the merge.

- [ ] **Step 5: Final commit (if verification fixes were needed)**

```bash
git add -A && git commit -m "test(desktop): verify tree-conflict resolution end-to-end"
```

---

## Self-Review

**Spec coverage:**
- `get_tree_conflicts` (porcelain v2 `u`-line parse, stage presence, `!(ours&&theirs)` filter) → Task 1. ✓
- `resolve_tree_conflict` (checkout --ours/--theirs + add, rm -f; arg arrays; safe_repo_path) → Task 2. ✓
- IPC wrappers same-PR → Task 3. ✓
- i18n 5 locales → Task 4. ✓
- `ConflictFile.tree`, loadRealFiles enrichment tolerant of absent file, `resolveTreeConflictFile` → Task 5. ✓
- Sidebar badge (not "0 conflit") → Task 6. ✓
- Dedicated panel with explanation + availability-driven buttons + read-only preview → Task 7. ✓
- Merge advance/continue after tree resolution (shared helper) → Task 7. ✓
- Real-repo Rust tests, no core change → Tasks 1-2, 8. ✓

**Placeholder scan:** Code is concrete. Two flagged adaptation points are explicit, not vague: (a) the `resolveAsync(...)` arg list in Task 5 Step 2 must be copied from the existing call — named so the implementer reads the real one; (b) FileList Task 6 markup adapts to existing structure with a stated hard requirement. The async-test-runtime note in Task 1 offers a concrete sync-helper fallback. No "TODO/handle errors/etc."

**Type consistency:** `TreeConflict` (Rust camelCase → TS `{path, code, hasBase, hasOurs, hasTheirs}`) is identical in Task 1, 3, 5. `TreeConflictInfo` `{code, hasOurs, hasTheirs, hasBase}` consistent in Task 5 and consumed in Tasks 6-7. `resolveTreeConflict(cwd, path, choice)` and the emit `resolveTreeConflict: [path, choice]` and handler `handleResolveTreeConflict(path, choice)` all use `choice: "ours"|"theirs"|"delete"`. Event kebab `@resolve-tree-conflict` ↔ camel `resolveTreeConflict` follows the existing `resolve-hunk`/`resolveHunk` convention. ✓
