/**
 * usePinnedBranches — per-repo user-chosen branch pinning (v2.12).
 *
 * Replaces the former auto-computed "top 5 by activity" heuristic in
 * RepoSidebar.vue. Pinned branches appear in a fixed "Épinglées" section
 * above the branch list in display order. The current branch is always shown
 * in that section regardless of pins.
 *
 * State persisted in AppSettings.pinnedBranchesByRepo (keyed by cwd).
 */

import { computed } from "vue";
import { loadSettings, saveSettings, settingsRevision } from "./useSettings";

const MAX_PINS = 20;

// ─── helpers ─────────────────────────────────────────────────────────────────

function normaliseCwd(cwd: string): string {
  return cwd.replace(/\\/g, "/").replace(/\/+$/, "");
}

// ─── actions ─────────────────────────────────────────────────────────────────

/** Pin a branch for the given repo. Appended at the end of the ordered list. */
export function pinBranch(cwd: string, name: string): void {
  const s = loadSettings();
  const key = normaliseCwd(cwd);
  const list = s.pinnedBranchesByRepo[key] ?? [];
  if (!list.includes(name) && list.length < MAX_PINS) {
    s.pinnedBranchesByRepo[key] = [...list, name];
    saveSettings(s);
  }
}

/** Remove a branch from the pinned list. */
export function unpinBranch(cwd: string, name: string): void {
  const s = loadSettings();
  const key = normaliseCwd(cwd);
  s.pinnedBranchesByRepo[key] = (s.pinnedBranchesByRepo[key] ?? []).filter((b) => b !== name);
  saveSettings(s);
}

/** Move a pinned branch one position up (toward index 0). */
export function movePinUp(cwd: string, name: string): void {
  const s = loadSettings();
  const key = normaliseCwd(cwd);
  const list = [...(s.pinnedBranchesByRepo[key] ?? [])];
  const idx = list.indexOf(name);
  if (idx <= 0) return;
  [list[idx - 1], list[idx]] = [list[idx], list[idx - 1]];
  s.pinnedBranchesByRepo[key] = list;
  saveSettings(s);
}

/** Move a pinned branch one position down. */
export function movePinDown(cwd: string, name: string): void {
  const s = loadSettings();
  const key = normaliseCwd(cwd);
  const list = [...(s.pinnedBranchesByRepo[key] ?? [])];
  const idx = list.indexOf(name);
  if (idx < 0 || idx >= list.length - 1) return;
  [list[idx], list[idx + 1]] = [list[idx + 1], list[idx]];
  s.pinnedBranchesByRepo[key] = list;
  saveSettings(s);
}

/** Return the ordered pinned branch names for a repo. */
export function pinnedForRepo(cwd: string): string[] {
  return loadSettings().pinnedBranchesByRepo[normaliseCwd(cwd)] ?? [];
}

/** Return true if the branch is pinned in the given repo. */
export function isPinned(cwd: string, name: string): boolean {
  return pinnedForRepo(cwd).includes(name);
}

// ─── composable ──────────────────────────────────────────────────────────────

export function usePinnedBranches(cwd: () => string) {
  const pinned = computed(() => {
    // Depend on the settings revision so pin/unpin reflect immediately.
    void settingsRevision.value;
    return pinnedForRepo(cwd());
  });
  const count = computed(() => pinned.value.length);

  return {
    pinned,
    count,
    pin:        (name: string) => pinBranch(cwd(), name),
    unpin:      (name: string) => unpinBranch(cwd(), name),
    moveUp:     (name: string) => movePinUp(cwd(), name),
    moveDown:   (name: string) => movePinDown(cwd(), name),
    isPinned:   (name: string) => isPinned(cwd(), name),
  };
}
