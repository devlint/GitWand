/**
 * Internal evidence for the Git Advent Calendar tips: for each door day with a
 * `tip`, the file(s) that prove the tip is true. Checked by the content-lint
 * tests (advent-doors.test.ts), never rendered or emitted in JSON.
 *
 * Deliberately NOT re-exported from `index.ts`, so the website never bundles
 * it. Imports nothing, no enums.
 *
 * Each entry starts with a repo-relative path, optionally followed by ":line"
 * or " — note".
 */

export const TIP_EVIDENCE: Readonly<Record<number, readonly string[]>> = {
  2: [
    "apps/desktop/src/components/DiffViewer.vue — stageHunk, toggleLine, stageSelected",
    "apps/desktop/src-tauri/src/commands/ops.rs:78 — git_stage_patch",
    "apps/desktop/src/locales/en.ts:425 — stageHunk, stageSelected",
  ],
  3: [
    "apps/desktop/src/utils/wordDiff.ts",
    "apps/desktop/src/components/DiffViewer.vue",
    "apps/desktop/src/components/FileHistoryViewer.vue",
    "apps/desktop/src/components/MergeEditor.vue",
  ],
  4: [
    "apps/desktop/src-tauri/src/commands/ops.rs:1543 — git_stash (stash push --include-untracked)",
    "apps/desktop/src/locales/en.ts:2201 — Stash Manager, AI message",
  ],
  5: [
    "apps/desktop/src-tauri/src/commands/ops.rs:1142 — git_discard (snapshot_before first)",
    "apps/desktop/src-tauri/src/commands/ops.rs:1157 — the git clean -f call",
    "apps/desktop/src-tauri/src/git/snapshot.rs",
    "apps/desktop/src/composables/useSettings.ts:591 — snapshotsEnabled true by default",
  ],
  6: [
    "packages/cli/src/commands/scan.ts",
    "packages/core/src/secrets",
    "apps/desktop/src-tauri/src/commands/secrets.rs",
    "apps/desktop/src/locales/en.ts:2980 — Potential secrets in this commit",
  ],
  7: [
    "apps/desktop/src-tauri/src/commands/read.rs:1378 — git_file_log_pickaxe",
    "apps/desktop/src/components/FileHistoryViewer.vue",
    "apps/desktop/src/locales/en.ts:2238 — pickaxePlaceholder",
  ],
  8: [
    "apps/desktop/src-tauri/src/commands/read.rs:1420 — git_file_log_range (line ranges, not :funcname)",
    "apps/desktop/src/locales/en.ts:2240 — showLineHistory",
  ],
  9: [
    "apps/desktop/src-tauri/src/commands/read.rs:1714 — git_blame (no -w or -C)",
    "apps/desktop/src/locales/en.ts:2231 — whyThisChange",
  ],
  12: [
    "apps/desktop/src/composables/useUndoStack.ts:129 — reads git reflog",
    "apps/desktop/src/composables/useTimeMachine.ts",
    "apps/desktop/src/locales/en.ts:2037 — Time Machine, Operation history, Rewind",
  ],
  13: [
    "apps/desktop/src/composables/useAbsorb.ts — absorb, autoSquash = false",
    "apps/desktop/src/components/RepoSidebar.vue:1981 — Absorb context menu entry (absorb.action)",
    "apps/desktop/src/locales/en.ts:2111 — Absorb",
    "apps/desktop/src/components/RebaseEditor.vue:211",
  ],
  15: [
    "apps/desktop/src-tauri/src/commands/ops.rs:451 — git_push",
    "apps/desktop/src/composables/useGitRepo.ts:1225",
    "apps/desktop/src/locales/en.ts:152 — forcePush",
  ],
  16: [
    "apps/desktop/src/components/WorktreeManager.vue",
    "apps/desktop/src-tauri/src/worktree",
    "apps/desktop/src/locales/en.ts:2368 — Worktrees, New AI task",
  ],
  18: [
    "apps/desktop/src/components/SplitCommitModal.vue",
    "apps/desktop/src/locales/en.ts:689 — Split commit",
  ],
  19: [
    "apps/desktop/src/components/MergeEditor.vue:1442",
    "apps/desktop/src/composables/useGitWand.ts:720",
    "apps/desktop/src/locales/en.ts:872 — baseEnrichedBanner",
  ],
  20: [
    "apps/desktop/src-tauri/src/git/libgit2.rs:162 — honours config, falls back to git CLI for histogram",
    "apps/desktop/src/locales/en.ts:1472 — blame algorithm dropdown",
  ],
  21: [
    "apps/desktop/src-tauri/src/commands/ops.rs:4436 — reconstruct_conflict_impl (git merge-file -p --diff3, stages 1/2/3)",
    "apps/desktop/src/components/MergeEditor.vue:1123",
    "apps/desktop/src/locales/en.ts:876 — reconstructConflict",
  ],
  22: [
    "apps/desktop/src/components/header/BranchRowActions.vue:65",
    "apps/desktop/src-tauri/src/commands/read.rs:1765 — preview_merge (git merge-file, not merge-tree)",
    "packages/cli/src/commands/preview.ts",
    "apps/desktop/src/locales/en.ts:554 — previewMerge",
  ],
  23: [
    "packages/core/src/resolvers/lockfile-npm.ts",
    "packages/core/src/resolvers/lockfile-pnpm.ts",
    "packages/core/src/resolvers/lockfile-yarn.ts",
    "packages/core/src/resolvers/cargo.ts",
    "packages/core/src/resolvers/json.ts",
    "packages/core/src/resolvers/yaml.ts",
  ],
  24: [
    "packages/core/src/patterns",
    "packages/core/src/resolvers",
    "apps/desktop/src/composables/useResolutionMemory.ts",
    "apps/desktop/src/locales/en.ts:2150 — memorySaveOffer",
  ],
};
