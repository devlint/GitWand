# Markerless Content-Conflict Reconstruction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make GitWand resolve content conflicts (`UU`) whose working tree has no `<<<<<<<` markers, by reconstructing the 3-way from the index stages and feeding it through the existing hunk-resolution UI.

**Architecture:** A Rust `reconstruct_conflict` command reads the stage-1/2/3 blobs and runs `git merge-file -p --diff3` to produce conflict-marker text, plus a flag for whether the working tree equals one side. The frontend detects a conflicted, non-tree file whose marker parse yields 0 conflicts, reconstructs it: if the working tree is just one side it swaps in the reconstructed markers and resolves normally (with an info banner); if the working tree matches neither side (possible manual edit) it offers Reconstruct vs Keep-my-version. No `packages/core` change.

**Tech Stack:** Rust (Tauri commands, `std::process::Command`, `git merge-file`), Vue 3 `<script setup>` + TypeScript, Vitest, `cargo test`, pnpm.

## Global Constraints

- pnpm only. No `packages/core` change (preserves Rust↔TS parity).
- **Security (AGENTS.md):** git args as arrays / `.arg()` (never shell interpolation); validate user paths via `safe_repo_path()`; never log secrets; always clean up temp files.
- **IPC:** new `#[tauri::command]` gets a `backend.ts` wrapper + `lib.rs` registration in the same task; no `invoke()` outside `backend.ts`.
- **Vue:** Composition API `<script setup>`; logic in composables; never touch `.bm-btn`.
- **i18n:** every user-visible string keyed in all 5 locales (`en/fr/es/pt-BR/zh-CN`).
- **Versions:** never hand-edit version files.
- **Tests:** real temp git repos, no git mocking. Rust tests in `#[cfg(test)] mod` (reuse a `TempRepo` helper); use the sync-helper pattern (no tokio in tests).
- Commands from `apps/desktop/`: `pnpm test`, `pnpm build`. Rust from `apps/desktop/src-tauri/`: `cargo test`.

**Key mechanism.** `git merge-file -p --diff3 -L ours -L base -L theirs <ours> <base> <theirs>` prints the 3-way merge to stdout with diff3 markers. The middle file is the common ancestor (stage 1). `merge-file` exits 0 (clean), N>0 (N conflicts — EXPECTED, not an error), or 255 (real error). Capture stdout regardless; only treat 255/spawn-failure as an error.

---

### Task 1: Rust — `reconstruct_conflict` + `ReconstructedConflict`

**Files:**
- Modify: `apps/desktop/src-tauri/src/types.rs` (struct)
- Modify: `apps/desktop/src-tauri/src/commands/ops.rs` (sync helper + async command + tests)
- Modify: `apps/desktop/src-tauri/src/lib.rs` (register)

**Interfaces:**
- Produces:
  ```rust
  #[derive(Serialize)] #[serde(rename_all = "camelCase")]
  pub struct ReconstructedConflict { pub content: String, pub wt_matches_side: bool }

  #[tauri::command]
  pub(crate) async fn reconstruct_conflict(cwd: String, path: String) -> Result<ReconstructedConflict, String>
  ```
  TS shape: `{ content: string, wtMatchesSide: boolean }`. `content` is diff3 conflict-marker text built from index stages; `wtMatchesSide` is true iff the current working-tree bytes equal stage-2 (ours) or stage-3 (theirs).

- [ ] **Step 1: Add the struct to `types.rs`**

Append near the other serialized structs in `apps/desktop/src-tauri/src/types.rs`:

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconstructedConflict {
    /// 3-way merge of the index stages, with diff3 conflict markers.
    pub content: String,
    /// Whether the current working-tree bytes equal stage 2 (ours) or stage 3 (theirs).
    pub wt_matches_side: bool,
}
```

- [ ] **Step 2: Write the failing tests**

Add to the existing `#[cfg(test)] mod tree_conflict_tests` in `ops.rs` (reuse its `TempRepo` helper). These tests call the sync helper `reconstruct_conflict_impl` (defined in Step 3):

```rust
    /// Build a UU content conflict on `shared.txt`, leaving markers in the working tree.
    fn make_content_conflict(repo: &TempRepo) {
        repo.write("shared.txt", "line1\nbase\nline3\n");
        repo.commit_all("base");
        repo.git_ok(&["checkout", "-q", "-b", "feature"]);
        repo.write("shared.txt", "line1\nFEATURE\nline3\n");
        repo.commit_all("feature");
        repo.git_ok(&["checkout", "-q", "main"]);
        repo.write("shared.txt", "line1\nMAIN\nline3\n");
        repo.commit_all("main");
        repo.git_ok(&["checkout", "-q", "feature"]);
        let _ = repo.git(&["merge", "--no-edit", "main"]); // conflicts; non-zero status expected
    }

    #[test]
    fn reconstruct_produces_markers_and_matches_side_after_checkout_ours() {
        let repo = TempRepo::new();
        make_content_conflict(&repo);
        // Remove markers, leave working tree == ours (stage 2).
        repo.git_ok(&["checkout", "--ours", "--", "shared.txt"]);
        let rec = reconstruct_conflict_impl(&repo.cwd(), "shared.txt").unwrap();
        assert!(rec.content.contains("<<<<<<<"), "reconstructed content must carry conflict markers");
        assert!(rec.content.contains(">>>>>>>"));
        assert!(rec.wt_matches_side, "working tree == ours → matches a side");
    }

    #[test]
    fn reconstruct_flags_manual_edit_when_wt_matches_no_side() {
        let repo = TempRepo::new();
        make_content_conflict(&repo);
        // Working tree is a distinct manual resolution (matches neither ours nor theirs).
        repo.write("shared.txt", "line1\nMANUAL RESOLUTION\nline3\n");
        let rec = reconstruct_conflict_impl(&repo.cwd(), "shared.txt").unwrap();
        assert!(rec.content.contains("<<<<<<<"));
        assert!(!rec.wt_matches_side, "working tree matches neither side → manual edit");
    }
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/desktop/src-tauri && cargo test tree_conflict_tests 2>&1 | tail -20`
Expected: FAIL — `reconstruct_conflict_impl` not found.

- [ ] **Step 4: Implement the helper + command**

Add to `ops.rs` (near `get_tree_conflicts`). Add `use std::io::Write;` at the top of the file if not present.

```rust
use crate::types::ReconstructedConflict;

/// Read the blob bytes for a given index stage of `path`, or empty if the stage is absent.
fn read_stage_blob(cwd: &str, stage: u8, path: &str) -> Vec<u8> {
    let spec = format!(":{}:{}", stage, path);
    match git_cmd().args(["show", &spec]).current_dir(cwd).output() {
        Ok(o) if o.status.success() => o.stdout,
        _ => Vec::new(),
    }
}

/// Reconstruct a content conflict from the index stages. Sync so it is unit-testable
/// without an async runtime; the #[tauri::command] is a thin wrapper.
fn reconstruct_conflict_impl(cwd: &str, path: &str) -> Result<ReconstructedConflict, String> {
    let _ = safe_repo_path(cwd, path)?; // traversal guard

    let base = read_stage_blob(cwd, 1, path);   // may be empty (add/add)
    let ours = read_stage_blob(cwd, 2, path);
    let theirs = read_stage_blob(cwd, 3, path);
    if ours.is_empty() && theirs.is_empty() {
        return Err(format!("no index stages for {}", path));
    }

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("gitwand-recon-{}-{}", std::process::id(), nanos));
    std::fs::create_dir_all(&dir).map_err(|e| format!("temp dir: {}", e))?;

    let write_tmp = |name: &str, data: &[u8]| -> Result<std::path::PathBuf, String> {
        let p = dir.join(name);
        std::fs::File::create(&p)
            .and_then(|mut f| f.write_all(data))
            .map_err(|e| format!("write {}: {}", name, e))?;
        Ok(p)
    };

    let result = (|| -> Result<String, String> {
        let ours_p = write_tmp("ours", &ours)?;
        let base_p = write_tmp("base", &base)?;
        let theirs_p = write_tmp("theirs", &theirs)?;
        let out = git_cmd()
            .args([
                "merge-file", "-p", "--diff3",
                "-L", "ours", "-L", "base", "-L", "theirs",
                ours_p.to_str().ok_or("bad temp path")?,
                base_p.to_str().ok_or("bad temp path")?,
                theirs_p.to_str().ok_or("bad temp path")?,
            ])
            .current_dir(cwd)
            .output()
            .map_err(|e| format!("git merge-file: {}", e))?;
        // exit 255 = real error; 0/N = clean/conflicts (stdout is the merged content either way)
        if out.status.code() == Some(255) {
            return Err(format!("git merge-file error: {}", String::from_utf8_lossy(&out.stderr)));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    })();

    let _ = std::fs::remove_dir_all(&dir); // always clean up
    let content = result?;

    let wt = std::fs::read(safe_repo_path(cwd, path)?).unwrap_or_default();
    let wt_matches_side = (!ours.is_empty() && wt == ours) || (!theirs.is_empty() && wt == theirs);

    Ok(ReconstructedConflict { content, wt_matches_side })
}

#[tauri::command]
pub(crate) async fn reconstruct_conflict(cwd: String, path: String) -> Result<ReconstructedConflict, String> {
    reconstruct_conflict_impl(&cwd, &path)
}
```

(`safe_repo_path` and `git_cmd` are already imported in `ops.rs` from earlier work; if `safe_repo_path` is not in scope, add `use crate::git::cmd::safe_repo_path;`.)

- [ ] **Step 5: Register in `lib.rs`**

In `tauri::generate_handler![...]`, add next to `commands::ops::resolve_tree_conflict,`:
```rust
    commands::ops::reconstruct_conflict,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/desktop/src-tauri && cargo test tree_conflict_tests 2>&1 | tail -20`
Expected: PASS — the two new tests plus the pre-existing tree-conflict tests are green.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/src/types.rs apps/desktop/src-tauri/src/commands/ops.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): reconstruct_conflict backend command (3-way from index stages)"
```

---

### Task 2: IPC wrapper in `backend.ts`

**Files:**
- Modify: `apps/desktop/src/utils/backend.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ReconstructedConflict { content: string; wtMatchesSide: boolean }
  export function reconstructConflict(cwd: string, path: string): Promise<ReconstructedConflict>
  ```

- [ ] **Step 1: Add the wrapper**

In `backend.ts`, near `getTreeConflicts` / `resolveTreeConflict`:

```ts
export interface ReconstructedConflict {
  content: string;
  wtMatchesSide: boolean;
}

export async function reconstructConflict(
  cwd: string,
  path: string,
): Promise<ReconstructedConflict> {
  if (isTauri()) {
    return tauriInvoke<ReconstructedConflict>("reconstruct_conflict", { cwd, path });
  }
  throw new Error("reconstructConflict is not available in dev-server mode");
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/desktop && pnpm build`
Expected: PASS — vue-tsc no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/utils/backend.ts
git commit -m "feat(desktop): backend.ts wrapper for reconstruct_conflict"
```

---

### Task 3: i18n keys (5 locales)

**Files:**
- Modify: `apps/desktop/src/locales/{en,fr,es,pt-BR,zh-CN}.ts`

**Interfaces:**
- Produces (English source / French verbatim; translate es/pt-BR/zh-CN), in the `merge` namespace:
  - `merge.reconstructedBanner` = `"Conflict reconstructed from the index — the file had no markers"` / fr `"Conflit reconstruit depuis l'index — le fichier n'avait pas de marqueurs"`
  - `merge.markerlessTitle` = `"Conflict in the index, no markers in the file"` / fr `"Conflit dans l'index, pas de marqueurs dans le fichier"`
  - `merge.markerlessExplanation` = `"Git records a conflict for this file, but the working copy has no conflict markers and matches neither side."` / fr `"Git enregistre un conflit pour ce fichier, mais la copie de travail n'a pas de marqueurs et ne correspond à aucun des deux côtés."`
  - `merge.reconstructConflict` = `"Reconstruct conflict"` / fr `"Reconstruire le conflit"`
  - `merge.keepWorkingTree` = `"Keep my version (stage as-is)"` / fr `"Garder ma version (stager tel quel)"`

- [ ] **Step 1: Invoke the i18n-sync skill**

Use the `i18n-sync` skill to add the 5 keys above into all 5 locale files in the `merge` namespace (near the existing `merge.tree*` keys), with translations for fr (verbatim above), es, pt-BR, zh-CN. None take interpolation args.

- [ ] **Step 2: Typecheck**

Run: `cd apps/desktop && pnpm build`
Expected: PASS — locale index type-merges cleanly.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/locales
git commit -m "i18n: markerless content-conflict keys across 5 locales"
```

---

### Task 4: `useGitWand` — detect, reconstruct, and resolve-by-staging

**Files:**
- Modify: `apps/desktop/src/composables/useGitWand.ts`

**Interfaces:**
- Consumes: `reconstructConflict` (Task 2); `gitStage` from `@/utils/backend`; existing `resolve` / `resolveAsync` / `readFile` / `files` / `folderPath` / `selectedPath` / `resolveOptions`.
- Produces:
  ```ts
  // ConflictFile gains: reconstructed?: boolean; markerless?: { reconstructed: string }
  reconstructAndResolve(path: string): void
  resolveByStaging(path: string): Promise<void>
  ```

- [ ] **Step 1: Extend imports and `ConflictFile`**

Add to the `@/utils/backend` import line: `reconstructConflict` and `gitStage` (extend the existing import; don't duplicate).
Add the two optional fields to `ConflictFile`:
```ts
export interface ConflictFile {
  path: string;
  content: string;
  result: MergeResult;
  tree?: TreeConflictInfo;
  /** True when content was rebuilt from the index because the working tree had no markers. */
  reconstructed?: boolean;
  /** Set when an unmerged file has no markers AND the working tree matches no side (possible manual edit). */
  markerless?: { reconstructed: string };
}
```

- [ ] **Step 2: Detect + reconstruct in `loadRealFiles`**

In the NON-tree branch of the `allPaths.map(...)` (the `else` after the tree-conflict branch), replace the current return with reconstruction logic. Read the file's REAL existing `resolveAsync(...)` argument list and reuse it verbatim (the names below — `resolveOptionsWithLlm`, `structuralOpts` — must match what's already in the file):

```ts
        const content = await readFile(cwd, filePath);
        const result = await resolveAsync(content, filePath, resolveOptionsWithLlm, structuralOpts);
        // Unmerged file with no parseable markers → reconstruct the 3-way from the index.
        if (result.stats.totalConflicts === 0) {
          try {
            const rec = await reconstructConflict(cwd, filePath);
            if (rec.content.includes("<<<<<<<")) {
              if (rec.wtMatchesSide) {
                // Working tree is just one side → swap in reconstructed markers and resolve normally.
                return {
                  path: filePath,
                  content: rec.content,
                  result: await resolveAsync(rec.content, filePath, resolveOptionsWithLlm, structuralOpts),
                  reconstructed: true,
                };
              }
              // Working tree matches no side → possible manual edit; keep it, offer a choice.
              return { path: filePath, content, result, markerless: { reconstructed: rec.content } };
            }
          } catch { /* not reconstructable → fall through to plain result */ }
        }
        return { path: filePath, content, result };
```

- [ ] **Step 3: Add `reconstructAndResolve` and `resolveByStaging`**

Add near `resolveTreeConflictFile`, and export both in the `return {...}` block:
```ts
/** Markerless file → swap to the reconstructed conflict content and resolve via the normal pipeline. */
function reconstructAndResolve(path: string): void {
  const file = files.value.find((f) => f.path === path);
  if (!file?.markerless) return;
  const newContent = file.markerless.reconstructed;
  const idx = files.value.indexOf(file);
  files.value[idx] = {
    path: file.path,
    content: newContent,
    result: resolve(newContent, file.path, resolveOptions.value),
    reconstructed: true,
  };
}

/** Resolve an unmerged file by staging the current working-tree content as the resolution. */
async function resolveByStaging(path: string): Promise<void> {
  if (!folderPath.value) return;
  await gitStage(folderPath.value, [path]);
  files.value = files.value.filter((f) => f.path !== path);
  if (selectedPath.value === path) {
    selectedPath.value = files.value[0]?.path ?? null;
  }
}
```
Add `reconstructAndResolve,` and `resolveByStaging,` to the returned object.

- [ ] **Step 4: Typecheck + tests**

Run: `cd apps/desktop && pnpm build && pnpm test`
Expected: PASS — vue-tsc clean, full Vitest suite green. (If a backend mock factory like `llm-fallback-integration.test.ts` needs `reconstructConflict`/`gitStage` stubs to keep `loadRealFiles` from throwing, add inert stubs — `reconstructConflict: vi.fn().mockResolvedValue({ content: "", wtMatchesSide: false })`, and `gitStage` if not already mocked — without changing assertions.)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/composables/useGitWand.ts apps/desktop/src/__tests__/*.test.ts
git commit -m "feat(desktop): detect+reconstruct markerless content conflicts in loadRealFiles"
```

---

### Task 5: `MergeEditor` — reconstructed banner + markerless choice panel

**Files:**
- Modify: `apps/desktop/src/components/MergeEditor.vue`

**Interfaces:**
- Consumes: `ConflictFile.reconstructed` / `ConflictFile.markerless` (Task 4); i18n keys (Task 3).
- Produces: emits `reconstructConflict: [path: string]` and `keepWorkingTree: [path: string]`.

- [ ] **Step 1: Add the emits**

In `defineEmits` (the block already holding `resolveTreeConflict`), add:
```ts
  reconstructConflict: [path: string];
  keepWorkingTree: [path: string];
```

- [ ] **Step 2: Render the markerless choice panel + reconstructed banner**

In the template, the body currently renders the tree panel (`v-if="file.tree"`) and the diff body (`<div class="merge-body" v-if="!file.tree">`). Change the diff-body guard to also exclude markerless, add the markerless panel, and add the reconstructed info banner just inside the normal body.

Change the merge-body opening line to:
```vue
    <div class="merge-body" v-if="!file.tree && !file.markerless">
```
Add, immediately before that `<div class="merge-body" ...>` (and after the tree panel):
```vue
    <!-- Markerless content conflict: working tree matches no side (possible manual edit) -->
    <div v-if="file.markerless" class="me-tree-panel">
      <h3 class="me-tree-title">{{ t('merge.markerlessTitle') }} — <span class="mono">{{ file.path }}</span></h3>
      <p class="me-tree-explanation">{{ t('merge.markerlessExplanation') }}</p>
      <div class="me-tree-actions">
        <button class="me-bulk-btn" @click="emit('reconstructConflict', file.path)">
          {{ t('merge.reconstructConflict') }}
        </button>
        <button class="me-bulk-btn" @click="emit('keepWorkingTree', file.path)">
          {{ t('merge.keepWorkingTree') }}
        </button>
      </div>
      <template v-if="file.content">
        <div class="me-tree-preview-label muted">{{ t('merge.treePreviewLabel') }}</div>
        <pre class="me-tree-preview">{{ file.content }}</pre>
      </template>
    </div>
```
Add the reconstructed banner as the FIRST child inside the `<div class="merge-body" ...>` (before the existing content), so it shows above the hunks:
```vue
      <div v-if="file.reconstructed" class="me-reconstructed-banner">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm.75 10.5h-1.5v-1.5h1.5v1.5zm0-3h-1.5V4.5h1.5V8.5z"/>
        </svg>
        <span>{{ t('merge.reconstructedBanner') }}</span>
      </div>
```

- [ ] **Step 3: Add the banner style**

In `MergeEditor.vue`'s `<style>` (reuse `.me-tree-*` for the panel; add only the banner):
```css
.me-reconstructed-banner {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 12px;
  color: var(--color-text-secondary, #888);
  background: var(--color-bg-secondary, rgba(0,0,0,0.03));
  border-bottom: 1px solid var(--color-border, #e0e0e0);
}
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/desktop && pnpm build`
Expected: PASS — vue-tsc clean (the new emits are declared; App binds them in Task 6).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/MergeEditor.vue
git commit -m "feat(desktop): reconstructed banner + markerless choice panel in MergeEditor"
```

---

### Task 6: `App.vue` — wire the two actions

**Files:**
- Modify: `apps/desktop/src/App.vue`

**Interfaces:**
- Consumes: `reconstructAndResolve` / `resolveByStaging` (Task 4); the shared `advanceToNextConflictOrFinalize` (already present); MergeEditor emits `reconstructConflict` / `keepWorkingTree` (Task 5).

- [ ] **Step 1: Destructure the new composable methods**

In the `useGitWand()` destructure (near `resolveTreeConflictFile`), add:
```ts
  reconstructAndResolve,
  resolveByStaging,
```

- [ ] **Step 2: Add the handlers**

After `handleResolveTreeConflict`:
```ts
function handleReconstructConflict(path: string) {
  // Swap to reconstructed markers; the file now flows through the normal hunk UI.
  reconstructAndResolve(path);
}

async function handleKeepWorkingTree(path: string) {
  try {
    await resolveByStaging(path);
    await advanceToNextConflictOrFinalize();
  } catch (err: any) {
    repoError.value = `keep-working-tree: ${err?.message || String(err)}`;
  }
}
```

- [ ] **Step 3: Bind the events on `<MergeEditor>`**

Extend the existing bindings:
```vue
                @reconstruct-conflict="(path) => handleReconstructConflict(path)"
                @keep-working-tree="(path) => handleKeepWorkingTree(path)"
```

- [ ] **Step 4: Typecheck + tests**

Run: `cd apps/desktop && pnpm build && pnpm test`
Expected: PASS — vue-tsc clean (bindings match MergeEditor emits), Vitest suite green.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/App.vue
git commit -m "feat(desktop): wire markerless-conflict reconstruct/keep actions"
```

---

### Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Rust tests**

Run: `cd apps/desktop/src-tauri && cargo test tree_conflict 2>&1 | tail -20`
Expected: PASS — including the two new `reconstruct_*` tests.

- [ ] **Step 2: Frontend tests + build**

Run: `cd apps/desktop && pnpm test && pnpm build`
Expected: PASS — Vitest green, vue-tsc + vite build clean.

- [ ] **Step 3: Confirm zero `packages/core` change**

Run: `git diff --stat <task1-base>..HEAD -- packages/core`
Expected: empty.

- [ ] **Step 4: Manual verification**

In a repo, create a `UU` content conflict, then `git checkout --ours -- <file>` (markers gone, working tree == ours). Open GitWand: the file should now show real hunks (not "0 conflit") with the "reconstructed from the index" banner, and resolve normally (accept ours/theirs/both, Accept all). Then make a `UU`, overwrite the working tree with a third distinct content: the file should show the markerless choice panel — "Reconstruct conflict" turns it into resolvable hunks; "Keep my version" stages it and advances.

- [ ] **Step 5: Final commit (if fixes needed)**

```bash
git add -A && git commit -m "test(desktop): verify markerless content-conflict reconstruction"
```

---

## Self-Review

**Spec coverage:**
- `reconstruct_conflict` (stage blobs → `git merge-file -p --diff3`, `wtMatchesSide` byte compare, temp cleanup, 255-error handling) → Task 1. ✓
- IPC wrapper same-PR → Task 2. ✓
- i18n 5 locales → Task 3. ✓
- Detection (conflicted, non-tree, 0 markers) + silent reconstruct when `wtMatchesSide` + manual-edit `markerless` path → Task 4. ✓
- Reconstructed banner + markerless choice panel (Reconstruct vs Keep-my-version) → Tasks 5 (UI) + 6 (wiring). ✓
- Keep-my-version = stage as-is + advance via shared helper → Tasks 4 (`resolveByStaging`) + 6. ✓
- Real-repo Rust tests, no core change → Tasks 1, 7. ✓

**Placeholder scan:** Concrete code throughout. The one adaptation point (Task 4 `resolveAsync` arg names) is explicitly flagged to copy from the real call, as in prior tasks. No vague "handle errors".

**Type consistency:** `ReconstructedConflict` Rust camelCase → TS `{ content, wtMatchesSide }` identical in Tasks 1, 2, 4. `reconstructConflict(cwd, path)` consistent in Tasks 2 and 4. Emits `reconstructConflict`/`keepWorkingTree` (camel) ↔ `@reconstruct-conflict`/`@keep-working-tree` (kebab) and handlers `handleReconstructConflict`/`handleKeepWorkingTree` consistent across Tasks 5-6. `reconstructAndResolve` / `resolveByStaging` defined in Task 4, consumed in Task 6. `ConflictFile.reconstructed`/`markerless` defined in Task 4, consumed in Tasks 5-6. ✓
