# Issue #150 — Auto-stash on pull (implementation plan)

**Date:** 2026-08-11
**Branch:** `feat/150-auto-stash-pull` (off `main`)
**Scope:** `apps/desktop` only. No `packages/core`, `packages/cli`, `packages/mcp`, `packages/vscode` changes.

---

## 1. Problem

`pull()` (`apps/desktop/src/composables/useGitRepo.ts:990-1026`) runs `gitFetch` then
`gitPull(folderPath, rebase ? "rebase" : "merge")` with no dirty-tree handling. With local
uncommitted changes, git refuses and GitWand surfaces the raw error string
(`error.value = "pull: " + result.message`):

- `git pull --rebase` on a dirty tree → **always** fails: `error: cannot pull with rebase: You have unstaged changes.` (exit 128). Since `pullMode` defaults to `"rebase"` (`useSettings.ts:402`), this is the *default* experience.
- `git pull --no-rebase` on a dirty tree → fails only when the incoming changes touch a dirty file: `error: Your local changes to the following files would be overwritten by merge` (exit 1).

Branch checkout already has a full dirty-tree story (`switchBehavior` setting +
`resolveDirtySwitchAction()` + `confirmSwitchStash()` / `carryChangesToBranch()`), and the
narrow post-checkout "Update branch" prompt already does stash → `pull --ff-only` → pop
(`useGitRepo.ts:1028-1079`). Manual pull has none of it. The issue asks for the same
convenience on pull.

---

## 2. Load-bearing finding: use git's native `--autostash`, not a hand-rolled stash/pop

The instinct is to copy `updateBranchFastForward()`'s manual `gitStash` → `gitPull` →
`gitStashPop` dance. **That is the wrong mechanism here**, because a merge/rebase pull can
stop mid-operation, and popping a stash into a half-finished merge/rebase produces a broken
tree. git's own `--autostash` handles the whole sequencing correctly.

I verified the following against **git 2.50.1** with real temp repos (bare remote + two
clones). Every claim below is measured, not assumed. These are the facts the design rests
on, and Step 7 turns them into a regression test.

| # | Scenario | Result |
|---|---|---|
| A | clean tree + `--autostash` | no-op, identical to today |
| B | dirty (non-overlapping) + `pull --no-rebase --autostash` | `Created autostash` → fast-forward → `Applied autostash.` **Index state preserved** (a staged `A  g.txt` came back staged) |
| C | dirty **overlapping** + `--autostash` | `Applying autostash resulted in conflicts. / Your changes are safe in the stash.` → **exit code 0**, `UU` file, **no** `MERGE_HEAD`, and a real `stash@{0}: autostash` entry in `git stash list` |
| D | rebase-mode pull where a **local commit** conflicts, tree also dirty | autostash parked in `.git/rebase-merge/autostash`, WIP **not** applied yet; `git rebase --continue` after resolving prints `Applied autostash.` and restores the WIP |
| E | merge-mode pull where the **merge itself** conflicts, tree also dirty | autostash parked in `.git/MERGE_AUTOSTASH`; **both** `git commit` and `git merge --continue` print `Applied autostash.` and restore the WIP |
| F | `git merge --abort` / `git rebase --abort` with a pending autostash | both print `Applied autostash.` — WIP restored, no data loss |
| G | untracked local file collides with an incoming file | `error: The following untracked working tree files would be overwritten by merge` — **`--autostash` does NOT help** (autostash never includes untracked files) |
| H | `--autostash` combined with `--ff-only` | accepted, works |

**Consequences for the design:**

- **Decision 3 (rebase + stash sequencing) is solved for free.** D/E/F mean GitWand must do
  *nothing* about sequencing — git parks the autostash and applies it when the operation
  concludes or aborts. GitWand's existing rebase banner (`App.vue:1966-1988`,
  auto-refreshed by `watch(repoStatus, …)` at `App.vue:2097`) and merge-conflict flow keep
  working untouched. **The implementation must never call `gitStashPop` itself.**
- **C is a trap.** `git pull` exits **0** with conflict markers in the tree. If we do
  nothing, `pull()` reports `successMessage = "sync-done"` ("Sync completed") while the tree
  is conflicted. We must detect this explicitly.
- **C's detection must be state-based, not string-based.** `git_cmd()`
  (`src-tauri/src/git/cmd.rs:309`, via `hidden_cmd` at :272) does **not** force `LC_ALL=C`,
  so git's messages are localized under a non-English system locale. Do not grep for
  `"Applying autostash resulted in conflicts"`. The locale-proof signature of C is:
  **`gitRepoState().state === "clean"` (no merge/rebase in progress) AND
  `status.conflicted.length > 0`** — a conflicted file with no in-progress operation can only
  come from a stash/autostash apply. (This mirrors the situation `updateBranchFastForward`
  already reports as `"pop-conflict"` → `branches.updatePopConflict`.)
- **G is a documented limitation**, not a bug to fix. Stashing untracked files to make room
  for an incoming file is surprising; that error stays surfaced as-is.

---

## 3. Design decisions

### 3.1 New dedicated setting, not a reuse of `switchBehavior`

**Decision:** add `pullDirtyBehavior: "ask" | "refuse" | "autostash"`, default `"ask"`.
Do **not** read `switchBehavior`.

**Why:**

1. **Reusing it would silently change behavior for existing users.** Anyone who set
   `switchBehavior: "stash"` would suddenly get their WIP shuffled on every pull — a change
   they never opted into, in an operation they didn't configure.
2. **The semantics genuinely differ.** `switchBehavior: "stash"` means "carry my WIP to
   *another branch*", and it is wired to a dedicated AI-labelled stash modal
   (`App.vue:3677-3709`). Pull keeps you on the same branch and the WIP is restored to the
   same place. `switchBehavior: "refuse"` is also a *new* restriction for switch, whereas
   for pull "refuse" is merely today's status quo.
3. **The cost is small and bounded:** one field in `useSettings.ts` + `SettingsPanel.vue`
   (AGENTS.md rule), one `<select>` row, 5 i18n keys × 5 locales. No new component.

**Default `"ask"`** — matches `switchBehavior`'s default, and keeps the change opt-in-per-pull
rather than silently altering what a pull does. Users who want the issue's literal ask
("auto stash when pull") set it to `"autostash"` once.

Naming: `pullDirtyBehavior`, not `pullBehavior`, so it can't be confused with the existing
`pullMode` (merge/rebase). Value `"autostash"`, not `"stash"`, because it maps 1:1 onto
`git --autostash` and is not the same thing as `switchBehavior`'s `"stash"`.

### 3.2 Ask via the existing generic confirm; never the AI stash-message modal

**Decision:** in `"ask"` mode, use the existing `askConfirm()` modal (`App.vue:2293`) with a
"Stash & pull" confirm label. Reuse — no new component.

**Why not the AI stash-message modal (`confirmSwitchStash`)?** With `--autostash` the stash
is an internal ref that lives ~200 ms and never appears in `git stash list` (measured: B, D,
E leave `git stash list` empty). Spending an LLM round-trip to label a stash the user will
never see is pure waste. The only case where a real stash entry materializes is C
(autostash-apply conflict), where git names it `autostash` and the user gets an explicit
error message pointing at it.

**Why not silent-unconditional like `updateBranchFastForward`?** Because C is materially more
likely for a merge/rebase pull than for the `--ff-only` pull that function performs, and
silently ending up with conflict markers after clicking "Pull" is a bad surprise. `"ask"`
default + `"autostash"` opt-in gives both audiences what they want.

### 3.3 Sequencing / rebase interaction

**Decision:** delegate entirely to `git --autostash`. GitWand never calls `gitStashPop` on
the pull path. See findings D/E/F. The only added UX is:

- After an autostash pull that left a rebase in progress (`state === "rebase" | "rebase_interactive"`),
  show a non-blocking hint that the WIP is stashed and will come back when the rebase
  finishes — otherwise the user sees their changes "vanish" mid-rebase and panics.
- On the C signature, replace the bogus "Sync completed" toast with an explicit error and
  switch to the Changes view (same treatment as `branches.updatePopConflict`).

### 3.4 Explicit non-goals

- `updateBranchFastForward()` (`useGitRepo.ts:1028-1079`) is **left alone**. Its manual
  stash/pop is safe for `--ff-only` (no mid-operation stop is possible) and its
  `"pop-conflict"` return is already wired to a specific message. Migrating it to
  `--autostash` is a valid follow-up, not part of this change.
- `carryChangesToBranch()` / `confirmSwitchStash()` untouched.
- The untracked-collision case (G) keeps failing with git's own error.
- No new `#[tauri::command]` — `git_pull`, `git_stash`, `git_stash_pop` all already exist
  with dev-server routes. Only `git_pull` gains a parameter.

---

## 4. Implementation steps

Each step is independently verifiable. Run `pnpm --filter @gitwand/desktop test` and
`pnpm --filter @gitwand/desktop build` (which runs `vue-tsc`) after every step that touches
TypeScript.

### Step 1 — Pure decision helper + unit tests

**New file** `apps/desktop/src/utils/pullDirtyDecision.ts`, modelled exactly on
`apps/desktop/src/utils/branchSwitchDecision.ts` (which owns `SwitchBehavior` the same way):

```ts
/** What happens to a dirty working tree when the user pulls. */
export type PullDirtyBehavior = "ask" | "refuse" | "autostash";

/**
 * Decide what to do when the user triggers a pull.
 *
 * - "direct"    → pull as-is (clean tree — `--autostash` would be a no-op anyway).
 * - "autostash" → pull with `--autostash`, no prompt.
 * - "modal"     → confirm first (dirty + ask).
 * - "refuse"    → block with an error (dirty + refuse).
 */
export function resolveDirtyPullAction(
  dirty: boolean,
  behavior: PullDirtyBehavior,
): "direct" | "autostash" | "modal" | "refuse" {
  if (!dirty) return "direct";
  if (behavior === "autostash") return "autostash";
  if (behavior === "refuse") return "refuse";
  return "modal";
}
```

**New test** `apps/desktop/src/utils/__tests__/pullDirtyDecision.test.ts`, mirroring
`apps/desktop/src/utils/__tests__/branchSwitchDecision.test.ts`: all 6 combinations
(3 behaviors × clean/dirty).

**Acceptance:** `pnpm --filter @gitwand/desktop test` green; 6 new assertions.

---

### Step 2 — Setting in both interfaces + settings UI + settings i18n

AGENTS.md: a new settings field goes in **both** files in the same commit.

1. `apps/desktop/src/composables/useSettings.ts`
   - Alongside the existing `import type { SwitchBehavior } from "../utils/branchSwitchDecision";`
     (line 16) add `import type { PullDirtyBehavior } from "../utils/pullDirtyDecision";`
   - Alongside `export type { SwitchBehavior };` (line 23) add `export type { PullDirtyBehavior };`
   - `AppSettings`: add `pullDirtyBehavior: PullDirtyBehavior;` right after
     `switchBehavior: SwitchBehavior;` (line 122).
   - `defaultAppSettings`: add `pullDirtyBehavior: "ask",` right after
     `switchBehavior: "ask",` (line 403).

2. `apps/desktop/src/components/SettingsPanel.vue`
   - Near the local `export type SwitchBehavior = "stash" | "ask" | "refuse";` (line 79) add
     `export type PullDirtyBehavior = "ask" | "refuse" | "autostash";`
   - Local `Settings` interface: add `pullDirtyBehavior: PullDirtyBehavior;` after line 138.
   - Local defaults: add `pullDirtyBehavior: "ask",` after line 234.
   - Handler next to `onSwitchBehaviorChange` (line 557):
     ```ts
     function onPullDirtyBehaviorChange(val: PullDirtyBehavior) {
       updateSetting("pullDirtyBehavior", val);
     }
     ```
   - Template: new `.sp-row` **between** the "Pull mode" row (ends line 1753) and the
     "Switch behavior" row (starts line 1755), so the two pull settings sit together:
     ```html
     <!-- Dirty-tree behavior on pull -->
     <div class="sp-row">
       <label class="sp-label" for="setting-pull-dirty">{{ t('settings.pullDirtyBehavior') }}</label>
       <select id="setting-pull-dirty" class="sp-select" :value="settings.pullDirtyBehavior"
         @change="onPullDirtyBehaviorChange(($event.target as HTMLSelectElement).value as PullDirtyBehavior)">
         <option value="autostash">{{ t('settings.pullDirtyAutostash') }}</option>
         <option value="ask">{{ t('settings.pullDirtyAsk') }}</option>
         <option value="refuse">{{ t('settings.pullDirtyRefuse') }}</option>
       </select>
       <span class="sp-hint">{{ t('settings.pullDirtyHint') }}</span>
     </div>
     ```

3. i18n — `settings` namespace, insert next to `switchRefuse` in all 5 locales
   (`en.ts:1290`, `fr.ts:1274`, `es.ts:1265`, `pt-BR.ts:1266`, `zh-CN.ts:1324`).
   English source strings:
   | key | en |
   |---|---|
   | `pullDirtyBehavior` | `Pull with uncommitted changes` |
   | `pullDirtyAutostash` | `Auto stash & restore` |
   | `pullDirtyAsk` | `Ask` |
   | `pullDirtyRefuse` | `Refuse if dirty` |
   | `pullDirtyHint` | `Stashes your changes for the pull and restores them right after.` |

**Acceptance:** `pnpm --filter @gitwand/desktop build` passes (vue-tsc catches a field added
to only one of the two interfaces); the new select appears in Settings → Git under "Pull
mode" and its value survives an app reload; `grep -c pullDirtyBehavior src/locales/*.ts`
returns 1 for all five files.

---

### Step 3 — Thread `autostash` through the IPC boundary (Rust + dev-server + backend.ts)

No new command; `git_pull` gains one optional parameter. Per AGENTS.md's dev:web parity rule,
all three sides change in the same commit.

1. **Rust** `apps/desktop/src-tauri/src/commands/ops.rs:500` —
   `git_pull(cwd: String, strategy: String)` → `git_pull(cwd: String, strategy: String, autostash: Option<bool>)`.
   Keep the existing strategy match (lines 509-513), then build the arg vector — flags stay
   discrete `.args()` entries, no string interpolation (AGENTS.md security rule):
   ```rust
   let mut args: Vec<&str> = vec!["pull", strategy];
   if autostash.unwrap_or(false) {
       args.push("--autostash");
   }
   ```
   and use `.args(&args)` / `record_cmd(&format!("git {}", args.join(" ")), …)`. `Option<bool>`
   (not `bool`) so an older frontend bundle that omits the field still deserializes.

2. **dev-server** `apps/desktop/dev-server.mjs:2155` `/api/git-pull` — read `autostash` from
   the body and append the flag:
   ```js
   const { cwd, strategy, autostash } = await readBody(req);
   …
   const flag = strategy === "rebase" ? "--rebase"
     : strategy === "ff-only" ? "--ff-only" : "--no-rebase";
   const cmd = `git pull ${flag}${autostash ? " --autostash" : ""} 2>&1`;
   ```
   *Deliberately keeping the existing `execSync` + `2>&1` shape.* The appended flag is a
   static literal chosen by a boolean — no user data enters the string, exactly like the
   existing `${flag}` on line 2164. Converting this route to `execFileSync` would also change
   what lands in `message` on the success path (git writes progress to stderr, which `2>&1`
   currently folds in), and `pull()`'s "Already up to date" check reads that field. Out of
   scope; note it as an optional follow-up cleanup.

3. **`apps/desktop/src/utils/backend.ts:901`** —
   ```ts
   export async function gitPull(
     cwd: string,
     strategy: PullStrategy = "merge",
     autostash: boolean = false,
   ): Promise<GitPushPullResult> {
   ```
   pass `autostash` in both the `tauriInvoke("git_pull", { cwd, strategy, autostash }, …)`
   payload and the dev-server JSON body. Extend the doc comment to say `--autostash` parks the
   WIP for the duration of the pull and that git — not GitWand — re-applies it, including
   after a `rebase --continue` / `merge --continue` / `--abort`.

**Acceptance:** `cargo check` clean in `apps/desktop/src-tauri`;
`pnpm --filter @gitwand/desktop build` clean; every existing `gitPull(...)` two-arg call site
still compiles (default `false` = today's behavior byte-for-byte); a `pnpm dev:web` pull on a
clean tree behaves exactly as before.

---

### Step 4 — `pull()` accepts `autostash` and detects the exit-0 conflict

`apps/desktop/src/composables/useGitRepo.ts`.

1. Add `gitRepoState` to the backend import block (lines 3-50, next to `gitPull` on line 13).
2. Signature: `async function pull(rebase: boolean = false, autostash: boolean = false)`.
   Return type stays `void` — `pull()` already owns its own `error` / `successMessage` /
   `viewMode` plumbing, so all existing call sites stay source-compatible.
3. Forward the flag: `await gitPull(folderPath.value, rebase ? "rebase" : "merge", autostash)`.
4. Track whether a post-pull state probe is needed, and run it in the `finally` **after** the
   existing `await refresh(true)` (line 1020) so `status.value` is fresh:

   ```ts
   let probeAutostash = false;
   try {
     …
     const result = await gitPull(folderPath.value, rebase ? "rebase" : "merge", autostash);
     if (!result.success) { … }            // unchanged
     else { …; probeAutostash = autostash; } // only meaningful when git reported success
   } catch { … }
   finally {
     isPulling.value = false;
     await refresh(true);
     if (probeAutostash) await settleAutostash();
   }
   ```

5. New private helper in the same composable, right after `pull()`:

   ```ts
   /**
    * `git pull --autostash` exits 0 even when re-applying the parked WIP hit
    * conflicts, so a plain success check reports "Sync completed" over a tree
    * full of markers. A conflicted file with NO merge/rebase in progress can
    * only come from an autostash apply, which is how we tell the two apart
    * without grepping git's (localized) output.
    *
    * A rebase still in progress is NOT an error: git holds the autostash in
    * .git/rebase-merge/autostash and applies it itself on `rebase --continue`
    * or `--abort`. We only tell the user their WIP is parked.
    */
   async function settleAutostash() {
     if (!folderPath.value) return;
     const st = await gitRepoState(folderPath.value).catch(() => null);
     if (!st) return;
     if (st.state === "rebase" || st.state === "rebase_interactive" || st.state === "merge") {
       successMessage.value = "autostash-parked";
       return;
     }
     if ((status.value?.conflicted.length ?? 0) > 0) {
       successMessage.value = null;
       error.value = t("header.pullAutostashConflict");
       viewMode.value = "changes";
     }
   }
   ```

   Notes: `t` is already imported (line 53); `viewMode` already exists (line 104) and is
   already driven this way by `mergeBranch` (line 1098). Setting `successMessage = null`
   before `error` prevents a "Sync completed" toast racing the error banner.

**Acceptance:**
- `pull()` with `autostash = false` on any tree state is byte-identical to today (diff review
  + existing tests still green).
- Unit-testable pieces are covered in Step 1; the git-level behavior is covered in Step 7.

---

### Step 5 — `handlePull()` gate in App.vue + reroute every UI call site

`pull()` is also called headlessly by `useScheduler` (`App.vue:2862-2864`), so the
`ask` / `refuse` gate must **not** live inside the composable — a scheduled pull must never
block on a modal.

1. New function next to the other sync handlers (after `doSync`, ~`App.vue:1280`):

   ```ts
   /**
    * Single entry point for every user-triggered pull. Applies the
    * pullDirtyBehavior setting to a dirty working tree before delegating.
    * The scheduler deliberately bypasses this (it can't answer a modal).
    */
   async function handlePull(rebase: boolean = pullMode.value === "rebase") {
     switch (resolveDirtyPullAction(isDirty(), settings.value.pullDirtyBehavior)) {
       case "refuse":
         repoError.value = t("header.pullRefusedDirty");
         return;
       case "autostash":
         await doPull(rebase, true);
         return;
       case "modal": {
         const ok = await askConfirm({
           title: t("header.pullDirtyTitle"),
           message: t("header.pullDirtyMessage"),
           confirmLabel: t("header.pullDirtyConfirm"),
         });
         if (!ok) return;
         await doPull(rebase, true);
         return;
       }
       default:
         await doPull(rebase);
     }
   }
   ```

   `isDirty()` already exists (`App.vue:1133`); `askConfirm` at `:2293`; `pullMode` at `:2672`.
   Declaration order matters in `<script setup>` for values read at setup time — `handlePull`
   is a function hoisted at module scope and only *called* after user interaction, so
   referencing `pullMode` / `settings` defined further down is fine (same as the existing
   `doSync`, which reads `pullMode`).

2. Reroute every **user-triggered** call site from `doPull(...)` to `handlePull(...)`:

   | Location | Today | After |
   |---|---|---|
   | `App.vue:1237` (`promptPullIfBehind` → generic-pull confirm) | `await doPull()` | `await handlePull(false)` — preserve the current merge default |
   | `App.vue:1275` (`doSync`) | `await doPull(pullMode.value === "rebase")` | `await handlePull()` |
   | `App.vue:1320` (`doRebaseOntoRemote`) | `await doPull(true)` | `await handlePull(true)` |
   | `App.vue:1325` (`doMergeRemote`) | `await doPull(false)` | `await handlePull(false)` |
   | `App.vue:1452` (command palette `"pull"`) | `doPull(pullMode.value === "rebase")` | `void handlePull()` |
   | `App.vue:2998` (shortcut map `pull`) | `() => doPull(pullMode.value === "rebase")` | `() => handlePull()` |
   | `App.vue:3212` (`AppHeader @pull`) | `() => doPull(pullMode === 'rebase')` | `() => handlePull()` |
   | `App.vue:3292` (`DashboardView @sync`) | `() => doPull(pullMode === 'rebase')` | `() => handlePull()` |

   `doSync()` (line 1274) keeps its `if (!repoError.value && canPush.value)` guard — a
   refused/cancelled pull sets `repoError` or leaves `canPush` unchanged, so it will not push
   over a half-done sync. Verify this explicitly during QA.

3. **Scheduler** (`App.vue:2862-2864`) — keep it out of `handlePull`, but give it autostash
   unconditionally so a scheduled rebase-pull no longer dies on a dirty tree:
   ```ts
   pullAndRebase: async () => {
     // Headless: can't prompt, so always park the WIP (git restores it itself).
     await doPull(true, true);
   },
   ```

4. **Toast** — register the new success signal in the meta map at `App.vue:608-615`:
   ```ts
   "autostash-parked": { key: "header.pullAutostashParked" },
   ```

**Acceptance:** `grep -n "doPull(" src/App.vue` shows `doPull` only inside `handlePull` and in
the scheduler block. No component or composable calls `pull()` directly for a user action.

---

### Step 6 — Runtime i18n keys (5 locales)

Add to the `header` namespace, next to `syncUpToDate` / `syncDone`
(`en.ts:79-82`, `fr.ts:73`, `es.ts:79`, `pt-BR.ts:80`, `zh-CN.ts:84`):

| key | en |
|---|---|
| `pullDirtyTitle` | `Uncommitted changes` |
| `pullDirtyMessage` | `Your uncommitted changes will be stashed for the pull, then restored automatically.` |
| `pullDirtyConfirm` | `Stash & pull` |
| `pullRefusedDirty` | `Pull refused: uncommitted changes are present.` |
| `pullAutostashParked` | `Pulled — your changes are stashed and will come back when the operation finishes.` |
| `pullAutostashConflict` | `Pull done, but restoring your changes hit conflicts — resolve them in the Changes view. Your changes are safe in the stash.` |

`pullAutostashConflict` deliberately echoes `branches.updatePopConflict`'s wording (the same
situation reached via a different door) and repeats git's own reassurance, because at that
point a real `stash@{0}: autostash` entry exists (finding C).

**Acceptance:** for each of the 6 keys, `grep -c <key> src/locales/*.ts` returns 1 across all
five files. FR/ES/PT-BR/ZH-CN translations written in the register already used in the
neighbouring keys.

---

### Step 7 — Tests

Per AGENTS.md: real temp git repos, never a mocked git layer.

**7a. Pure-unit (Step 1)** — `src/utils/__tests__/pullDirtyDecision.test.ts`, 6 cases. Runs in
`pnpm test` → CI.

**7b. git-contract regression test (new)** —
`apps/desktop/src/composables/__tests__/pullAutostash.git.test.ts`.

This is the drift lock for §2. Vitest runs under Node even with the `jsdom` environment, so
`node:child_process` / `node:fs` work in a `src/**/*.test.ts` file — which matters because CI
runs only `pnpm test` (`.github/workflows/ci.yml:32`), not `test:parity`. Build a bare remote
+ two clones per test with `execFileSync` (no shell), fixed `user.name`/`user.email` and
`GIT_CONFIG_GLOBAL=/dev/null` + `GIT_CONFIG_SYSTEM=/dev/null` (same hygiene as
`tests/parity/fixtures.mjs`), `rmSync(dir, { recursive: true })` in `afterEach`.

Cases — each asserts the exact property the implementation depends on:

1. **clean pull is unchanged** — `pull --no-rebase --autostash` on a clean tree fast-forwards,
   exit 0, `git stash list` empty, no `.git/MERGE_AUTOSTASH`.
2. **dirty pull with successful auto-restore** — non-overlapping dirty file (plus one *staged*
   file): exit 0, incoming change present, local edit still present, staged file still staged,
   `git stash list` empty.
3. **autostash apply conflicts** — overlapping edit: **exit code 0** (assert this explicitly —
   it is the surprising fact), `git status --porcelain` shows `UU`, `.git/MERGE_HEAD` absent,
   `git stash list` contains exactly one entry. Then assert the detection predicate the
   implementation uses: *conflicted file present AND no operation in progress*.
4. **rebase-mode variant, rebase itself conflicts** — `.git/rebase-merge/autostash` exists,
   the dirty file is **still pristine** mid-rebase, and after resolving + `rebase --continue`
   the WIP is back and `git stash list` is empty.
5. **rebase-mode variant, abort** — `rebase --abort` restores the WIP (finding F) — proves the
   existing rebase-banner "Abort" button can't eat a user's work.
6. **untracked collision is still an error** (finding G) — documents the limitation so nobody
   "fixes" it by adding `--include-untracked` semantics later.

Skip the suite gracefully if `git --version` is unavailable.

**7c. dev-server route test** — `apps/desktop/tests/parity/git-pull-autostash.test.mjs`
(node env, `startDevServer` from `dev-server-runner.mjs`, no Rust probe needed — same shape as
`scan-secrets.test.mjs`). Asserts the wire contract: `POST /api/git-pull` with
`{ autostash: true }` on a dirty tree succeeds and restores the WIP, and with
`{ autostash: false }` (or the field absent) still fails the way it does today. This guards
the `pnpm dev:web` path, which is where manual QA happens.

**Acceptance:** `pnpm --filter @gitwand/desktop test` green (7a + 7b);
`pnpm --filter @gitwand/desktop test:parity` green (7c).

---

### Step 8 — Manual QA via `pnpm dev:web`

Drive the real UI against a real repo (no Tauri build needed). Set up a local bare remote +
clone so pulls are offline-safe.

1. `pullDirtyBehavior = "ask"` (default), `pullMode = rebase`, dirty non-overlapping file →
   click Pull in the header → modal appears → "Stash & pull" → pull succeeds, WIP still there,
   "Sync completed" toast.
2. Same, click Cancel → nothing happens, no error banner, no stash created.
3. `pullDirtyBehavior = "refuse"`, dirty tree → Pull → "Pull refused" message, repo untouched.
4. `pullDirtyBehavior = "autostash"`, dirty tree → Pull → no modal, WIP restored.
5. `"autostash"` + **overlapping** dirty edit → error banner is
   `header.pullAutostashConflict` (**not** a "Sync completed" toast), view switches to Changes,
   markers visible, Stash Manager shows the `autostash` entry.
6. `"autostash"` + rebase-mode pull where a **local commit** conflicts → rebase banner appears,
   `header.pullAutostashParked` toast, dirty file untouched; resolve + Continue → WIP back.
7. Same as 6 then **Abort** → WIP back, no stash left behind.
8. Clean tree, every entry point (header Pull, sync-split dropdown "Rebase onto origin" /
   "Merge origin into current", `⌘⇧P` palette → Pull, keyboard shortcut, Dashboard Sync) →
   behaves exactly as before, no modal.
9. Diverged state → header **Sync** → the pull half prompts, and cancelling it does **not**
   push (`doSync`'s guard).

Also confirm no stray branches/commits were left in the working repo (`git status`,
`git branch`, `git stash list`) before opening the PR.

---

### Step 9 — Changelog

Add to `CHANGELOG.md` under the existing `## [Unreleased]` (line 8), `### Added`:

> **Auto-stash on pull (#150)** — pulling with uncommitted changes no longer dead-ends on
> `cannot pull with rebase: You have unstaged changes`. A new Settings → Git → "Pull with
> uncommitted changes" option (Ask — default · Auto stash & restore · Refuse) parks the
> working tree via `git pull --autostash` and lets git restore it, including across a
> conflicted rebase/merge (`rebase --continue`, `merge --continue`, and both `--abort` paths).
> When re-applying the parked changes conflicts, GitWand now says so explicitly instead of
> reporting a successful sync over a conflicted tree.

Do **not** touch version fields (`./scripts/bump-version.sh` owns those, at release time).
`website/changelog.md` and the `roadmap.md` **Shipped** entry are updated at tag time, not in
this PR (AGENTS.md).

---

## 5. Files touched (summary)

| File | Change |
|---|---|
| `apps/desktop/src/utils/pullDirtyDecision.ts` | **new** — `PullDirtyBehavior` + `resolveDirtyPullAction()` |
| `apps/desktop/src/utils/__tests__/pullDirtyDecision.test.ts` | **new** — 6 cases |
| `apps/desktop/src/composables/__tests__/pullAutostash.git.test.ts` | **new** — real-git contract, 6 cases |
| `apps/desktop/tests/parity/git-pull-autostash.test.mjs` | **new** — dev-server wire contract |
| `apps/desktop/src/composables/useSettings.ts` | `pullDirtyBehavior` field + default + type re-export |
| `apps/desktop/src/components/SettingsPanel.vue` | local type + field + default + handler + `<select>` row |
| `apps/desktop/src/composables/useGitRepo.ts` | `pull(rebase, autostash)`, `settleAutostash()`, `gitRepoState` import |
| `apps/desktop/src/App.vue` | `handlePull()`, 8 call sites rerouted, scheduler autostash, toast entry |
| `apps/desktop/src/utils/backend.ts` | `gitPull(cwd, strategy, autostash)` |
| `apps/desktop/src-tauri/src/commands/ops.rs` | `git_pull(..., autostash: Option<bool>)` |
| `apps/desktop/dev-server.mjs` | `/api/git-pull` accepts `autostash` |
| `apps/desktop/src/locales/{en,fr,es,pt-BR,zh-CN}.ts` | 5 `settings.*` + 6 `header.*` keys each |
| `CHANGELOG.md` | `[Unreleased] → Added` entry |

No `packages/**` changes. No new Tauri command. No version-file edits. No `[[bin]]` changes.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| `git pull --autostash` exits **0** on an apply conflict → a false "Sync completed" | Step 4's `settleAutostash()` state probe; test 7b-3 asserts the exit code so the assumption can't silently rot |
| Locale-dependent git output | Detection is state-based (`gitRepoState` + `status.conflicted`), never string matching |
| `--autostash` unsupported on an ancient git | `--autostash` for `pull --rebase` since git 2.6, for merge/pull generally since 2.27 (2020). Older git returns a clean `unknown option` error surfaced through the existing failure path — no corruption. Not gating on a version probe |
| A user's WIP silently disappearing mid-rebase | `header.pullAutostashParked` toast; test 7b-4/7b-5 prove it comes back on continue *and* abort |
| `doSync()` pushing after a cancelled pull | Existing `!repoError.value && canPush.value` guard; QA case 9 |
| The scheduler blocking on a modal | Scheduler bypasses `handlePull` entirely and passes `autostash: true` |
| Untracked-file collision still fails (G) | Deliberate, documented; a follow-up could offer `--include-untracked` stashing behind its own explicit prompt |

---

## 7. Open decisions for the human checkpoint

1. **Default `"ask"` vs `"autostash"`.** The issue title literally says "auto stash when pull".
   I chose `"ask"` to avoid silently changing what the Pull button does for every existing
   user, with one-click opt-in to always-autostash. If you'd rather ship the convenience on by
   default, it's a one-line change (`useSettings.ts` default + `SettingsPanel.vue` default) —
   everything else in the plan is unchanged.
2. **A separate `pullDirtyBehavior` setting vs reusing `switchBehavior`.** Recommended
   separate (§3.1). The cost is one extra row in Settings → Git; the alternative silently
   repurposes an existing user choice.
3. **Confirm dialog vs a richer modal with the dirty-file list.** I reuse the generic
   `askConfirm` (no new component, matches the existing post-checkout pull prompt). If you
   want the file list like `BranchDirtySwitchModal`, that's a new component and roughly one
   extra step.
4. **`updateBranchFastForward()` left on its manual stash/pop.** Migrating it to `--autostash`
   would delete code and unify the two paths, but it changes shipped v3.6.0 behavior and its
   `"pop-conflict"` message contract. Deliberately out of scope — say the word to fold it in.
