import { ref, computed, type Ref } from "vue";
import { workspaceRead, workspaceWrite, pathExists, type WorkspaceConfig } from "../utils/backend";
import { useLogs } from "./useLogs";
import { t } from "./useI18n";

/**
 * Monorepo scope state (v2.21.0).
 *
 * A "scope" is a single repo-relative directory path (e.g. `packages/core`)
 * that narrows the commit graph, search and stats to a sub-tree. `null` means
 * the whole repo. Single scope at a time (locked design decision).
 *
 * State is module-scoped (singleton, no Pinia) so every `useWorkspaceScope()`
 * call shares the same `activeScope`. Persistence is additive: the `scope`
 * field is merged into the existing per-repo `.gitwand-workspace.json` via
 * `workspaceRead` / `workspaceWrite`. No `AppSettings` field (per-repo state,
 * not a global setting).
 */

// Module-scoped singleton state.
const activeScope: Ref<string | null> = ref(null);

// The repo whose scope is currently loaded — needed so set/clear persist to
// the right `.gitwand-workspace.json`.
const scopeRepoPath: Ref<string | null> = ref(null);

// Guard so the invalid-scope notice fires at most once per load.
let _invalidNoticeShown = false;

/**
 * Persist the current `scope` value into the repo's `.gitwand-workspace.json`,
 * merging it with the existing config (so `name` / `repos` are preserved).
 *
 * `workspaceRead` throws when no workspace file exists yet — in that case we
 * start from a minimal config rather than failing. Persistence errors are
 * non-fatal: surfaced as a warn log, never blocking the UI.
 */
async function persistScope(repoPath: string, scope: string | null): Promise<void> {
  let config: WorkspaceConfig;
  try {
    config = await workspaceRead(repoPath);
  } catch {
    // No workspace file yet — start from a minimal config. The directory name
    // is a reasonable default workspace name.
    const name = repoPath.split(/[\\/]/).filter(Boolean).pop() ?? repoPath;
    config = { name, repos: [] };
  }

  const merged: WorkspaceConfig = { ...config };
  if (scope) {
    merged.scope = scope;
  } else {
    // Clearing: drop the field entirely (absent === whole repo).
    delete merged.scope;
  }

  try {
    await workspaceWrite(repoPath, merged);
  } catch (err: any) {
    const { pushLog } = useLogs();
    pushLog("warn", t("scope.persistError"), err?.message);
  }
}

/**
 * Activate a scope (repo-relative directory path) and persist it.
 */
async function setScope(path: string): Promise<void> {
  activeScope.value = path || null;
  if (scopeRepoPath.value) {
    await persistScope(scopeRepoPath.value, activeScope.value);
  }
}

/**
 * Clear the scope (back to whole repo) and persist the removal.
 */
async function clearScope(): Promise<void> {
  activeScope.value = null;
  if (scopeRepoPath.value) {
    await persistScope(scopeRepoPath.value, null);
  }
}

/**
 * Load the persisted scope for a repo on open.
 *
 * Reads `.gitwand-workspace.json`, validates the persisted scope path still
 * exists on disk (via `pathExists` → Rust `safe_repo_path`). On an invalid /
 * deleted path, falls back to whole repo (`null`) and surfaces a one-time
 * non-blocking notice. Never throws — a missing/malformed workspace file just
 * yields `null` (whole repo).
 */
async function loadScope(repoPath: string): Promise<void> {
  scopeRepoPath.value = repoPath;
  _invalidNoticeShown = false;

  let config: WorkspaceConfig | null = null;
  try {
    config = await workspaceRead(repoPath);
  } catch {
    // No workspace file / parse error → whole repo.
    activeScope.value = null;
    return;
  }

  const persisted = config?.scope;
  if (!persisted) {
    activeScope.value = null;
    return;
  }

  // Validate the persisted scope still exists.
  let exists = false;
  try {
    exists = await pathExists(repoPath, persisted);
  } catch {
    exists = false;
  }

  if (exists) {
    activeScope.value = persisted;
  } else {
    activeScope.value = null;
    if (!_invalidNoticeShown) {
      _invalidNoticeShown = true;
      const { pushLog } = useLogs();
      pushLog("warn", t("scope.invalidNotice", persisted));
    }
    // Drop the stale scope from the persisted config so it doesn't keep firing.
    await persistScope(repoPath, null);
  }
}

export function useWorkspaceScope() {
  return {
    activeScope,
    /** True when a sub-tree scope is active. */
    isScoped: computed(() => activeScope.value !== null),
    setScope,
    clearScope,
    loadScope,
  };
}
