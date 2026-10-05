import { ref, computed, type Ref } from "vue";
import { workspaceRead, pathExists } from "../utils/backend";
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
 * call shares the same `activeScope`.
 *
 * Persistence is local, per repo: the app's storage, keyed by repo path. The
 * scope is a personal view preference, so it is never written into the
 * repository. It used to be merged into the repo's `.gitwand-workspace.json`,
 * which created that file, untracked, in any repo where someone picked a
 * scope. A `scope` still present in such a file is read once, when nothing is
 * stored locally for the repo, and the file is left untouched.
 *
 * The stored value is the scope path, or "" for the whole repo. A missing key
 * means "never decided here", which is the only case that consults the file.
 */

export const SCOPE_STORAGE_PREFIX = "gitwand-scope:";

// Module-scoped singleton state.
const activeScope: Ref<string | null> = ref(null);

// The repo whose scope is currently loaded, so set/clear persist to the
// right key.
const scopeRepoPath: Ref<string | null> = ref(null);

// Guard so the invalid-scope notice fires at most once per load.
let _invalidNoticeShown = false;

/** The locally stored scope: a path, "" for the whole repo, null if never stored. */
function readStoredScope(repoPath: string): string | null {
  try {
    return localStorage.getItem(SCOPE_STORAGE_PREFIX + repoPath);
  } catch {
    return null;
  }
}

/** Persist the scope locally. Storage errors are non-fatal: the scope still applies for this session. */
function persistScope(repoPath: string, scope: string | null): void {
  try {
    localStorage.setItem(SCOPE_STORAGE_PREFIX + repoPath, scope ?? "");
  } catch {
    /* storage unavailable: the scope is simply not remembered */
  }
}

/** A `scope` left in the repo's `.gitwand-workspace.json` by an older version, if any. */
async function readLegacyScope(repoPath: string): Promise<string | null> {
  try {
    return (await workspaceRead(repoPath))?.scope || null;
  } catch {
    // No workspace file / parse error → nothing to migrate.
    return null;
  }
}

/**
 * Activate a scope (repo-relative directory path) and persist it.
 */
async function setScope(path: string): Promise<void> {
  activeScope.value = path || null;
  if (scopeRepoPath.value) persistScope(scopeRepoPath.value, activeScope.value);
}

/**
 * Clear the scope (back to whole repo) and persist the removal.
 */
async function clearScope(): Promise<void> {
  activeScope.value = null;
  if (scopeRepoPath.value) persistScope(scopeRepoPath.value, null);
}

/**
 * Load the persisted scope for a repo on open.
 *
 * Reads the local value, or migrates one from an older `.gitwand-workspace.json`
 * the first time, then validates that the path still exists on disk (via
 * `pathExists` → Rust `safe_repo_path`). On an invalid / deleted path, falls
 * back to whole repo (`null`) and surfaces a one-time non-blocking notice.
 * Never throws.
 */
async function loadScope(repoPath: string): Promise<void> {
  scopeRepoPath.value = repoPath;
  _invalidNoticeShown = false;

  const stored = readStoredScope(repoPath);
  const persisted = stored !== null ? stored : await readLegacyScope(repoPath);
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
  // The repo may have changed while the check ran.
  if (scopeRepoPath.value !== repoPath) return;

  if (exists) {
    activeScope.value = persisted;
    persistScope(repoPath, persisted);
  } else {
    activeScope.value = null;
    if (!_invalidNoticeShown) {
      _invalidNoticeShown = true;
      const { pushLog } = useLogs();
      pushLog("warn", t("scope.invalidNotice", persisted));
    }
    // Drop the stale scope locally so the notice doesn't keep firing.
    persistScope(repoPath, null);
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
