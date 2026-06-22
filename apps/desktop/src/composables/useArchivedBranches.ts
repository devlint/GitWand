/**
 * useArchivedBranches — per-repo branch archiving (v2.12).
 *
 * Archived branches are hidden from the main branch list and shown in a
 * collapsed "Archivées" section at the bottom of the sidebar. They are never
 * deleted from git — only visually suppressed in GitWand.
 *
 * State is persisted in AppSettings.archivedBranches (keyed by cwd) via
 * localStorage. The module-level singleton ensures all components share the
 * same reactive reference.
 */

import { computed } from "vue";
import { loadSettings, saveSettings, settingsRevision } from "./useSettings";

// ─── helpers ─────────────────────────────────────────────────────────────────

function normaliseCwd(cwd: string): string {
  return cwd.replace(/\\/g, "/").replace(/\/+$/, "");
}

// ─── actions ─────────────────────────────────────────────────────────────────

/** Archive a branch for the given repo. No-op if already archived. */
export function archiveBranch(cwd: string, name: string): void {
  const s = loadSettings();
  const key = normaliseCwd(cwd);
  const list = s.archivedBranches[key] ?? [];
  if (!list.includes(name)) {
    s.archivedBranches[key] = [...list, name];
    saveSettings(s);
  }
}

/** Remove a branch from the archive for the given repo. */
export function unarchiveBranch(cwd: string, name: string): void {
  const s = loadSettings();
  const key = normaliseCwd(cwd);
  const list = s.archivedBranches[key] ?? [];
  s.archivedBranches[key] = list.filter((b) => b !== name);
  saveSettings(s);
}

/** Archive multiple branches at once (e.g. "archive all merged"). */
export function archiveBranches(cwd: string, names: string[]): void {
  const s = loadSettings();
  const key = normaliseCwd(cwd);
  const existing = new Set(s.archivedBranches[key] ?? []);
  for (const n of names) existing.add(n);
  s.archivedBranches[key] = [...existing];
  saveSettings(s);
}

/** Clear all archived branches for a repo. */
export function unarchiveAll(cwd: string): void {
  const s = loadSettings();
  const key = normaliseCwd(cwd);
  s.archivedBranches[key] = [];
  saveSettings(s);
}

/** Return the list of archived branch names for a repo. */
export function archivedForRepo(cwd: string): string[] {
  return loadSettings().archivedBranches[normaliseCwd(cwd)] ?? [];
}

/** Return true if the branch is archived in the given repo. */
export function isArchived(cwd: string, name: string): boolean {
  return archivedForRepo(cwd).includes(name);
}

// ─── composable ──────────────────────────────────────────────────────────────

/**
 * Composable that scopes all operations to a single repo (cwd).
 * Reactivity is intentionally thin — components re-read after mutations.
 */
export function useArchivedBranches(cwd: () => string) {
  const archived = computed(() => {
    // Depend on the settings revision so archive/unarchive reflect immediately.
    void settingsRevision.value;
    return archivedForRepo(cwd());
  });
  const count = computed(() => archived.value.length);

  return {
    archived,
    count,
    archive:      (name: string) => archiveBranch(cwd(), name),
    unarchive:    (name: string) => unarchiveBranch(cwd(), name),
    archiveMany:  (names: string[]) => archiveBranches(cwd(), names),
    unarchiveAll: () => unarchiveAll(cwd()),
    isArchived:   (name: string) => isArchived(cwd(), name),
  };
}
