import { computed, type Ref } from "vue";
import { useSettings, saveSettings } from "./useSettings";
import type { WorkspaceRepo } from "../utils/backend";

/**
 * Launchpad scope (v3) — which of the open repo tabs the Launchpad shows.
 *
 * The selection is a list of repo *paths* persisted in `launchpadScopePaths`.
 * An empty list means "all open repos" (the default, le matin). The selection
 * is always intersected with what's currently open, so closing a tab silently
 * drops it from the scope and a stale persisted path never resurrects a repo.
 *
 * `allRepos` is the live list of open repo tabs (App.vue derives it from
 * `useRepoTabs`).
 */
export function useLaunchpadScope(allRepos: Ref<WorkspaceRepo[]>) {
  const { settings } = useSettings();

  const selectedPaths = computed<string[]>(() => settings.value.launchpadScopePaths ?? []);

  /** True when no explicit selection → every open repo is in scope. */
  const isAll = computed(() => selectedPaths.value.length === 0);

  /**
   * The repos actually shown. Falls back to "all" when the selection matches
   * nothing currently open (e.g. the only selected repo's tab was closed).
   */
  const scopedRepos = computed<WorkspaceRepo[]>(() => {
    if (isAll.value) return allRepos.value;
    const sel = new Set(selectedPaths.value);
    const filtered = allRepos.value.filter((r) => sel.has(r.path));
    return filtered.length > 0 ? filtered : allRepos.value;
  });

  function isSelected(path: string): boolean {
    return isAll.value || selectedPaths.value.includes(path);
  }

  function persist(paths: string[]): void {
    settings.value.launchpadScopePaths = paths;
    saveSettings(settings.value);
  }

  /** Reset to "all open repos". */
  function setAll(): void {
    persist([]);
  }

  /**
   * Toggle a repo in/out of the scope. Toggling out of the "all" state first
   * expands to every open path, so unchecking one repo yields "all except it".
   * Normalises back to "all" ([]) when every open repo ends up selected (or
   * none does — unchecking the last repo reverts to all rather than an empty
   * launchpad).
   */
  function toggle(path: string): void {
    const openPaths = allRepos.value.map((r) => r.path);
    const current = isAll.value
      ? [...openPaths]
      : selectedPaths.value.filter((p) => openPaths.includes(p));
    const next = current.includes(path)
      ? current.filter((p) => p !== path)
      : [...current, path];
    if (next.length === 0 || next.length === openPaths.length) {
      persist([]);
    } else {
      persist(next);
    }
  }

  return { selectedPaths, isAll, scopedRepos, isSelected, setAll, toggle };
}
