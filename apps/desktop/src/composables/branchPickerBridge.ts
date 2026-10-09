import type { InjectionKey, Ref } from "vue";

/**
 * Counter-bump bridges between the native macOS menu (or any other
 * external trigger) and the components that own a popover / focus state.
 *
 * Pattern: the producer (App.vue) `provide()`s a `Ref<number>`. Each
 * caller does `ref.value++`. The consumer `inject()`s and `watch()`es —
 * any change reopens the target. Counter (not boolean) so repeated taps
 * still fire even when the popover was already open.
 *
 * Adding a new bridge: declare a new symbol here, provide it once in
 * App.vue, watch it once in the owning component. Don't reuse a key
 * across consumers — each popover gets its own counter.
 */
export const BRANCH_CREATE_REQUEST_KEY: InjectionKey<Ref<number>> = Symbol("branchCreateRequest");

/** Open AppHeader's merge-into popover (Repository menu → Merge…). */
export const MERGE_POPOVER_REQUEST_KEY: InjectionKey<Ref<number>> = Symbol("mergePopoverRequest");

/** Open AppHeader's undo/rewind popover (Repository menu → Undo Last Operation…). */
export const UNDO_POPOVER_REQUEST_KEY: InjectionKey<Ref<number>> = Symbol("undoPopoverRequest");

/** Focus CommitLog's existing search input (Edit menu → Find in Log). */
export const LOG_FOCUS_SEARCH_KEY: InjectionKey<Ref<number>> = Symbol("logFocusSearch");

/** Open Launchpad view (View menu → Open Launchpad, ⌘L). */
export const LAUNCHPAD_OPEN_REQUEST_KEY: InjectionKey<Ref<number>> = Symbol("launchpadOpenRequest");

/** Toggle the commit-graph git-tree panel (double-click on any file in Changes or Diff). */
export const TOGGLE_GIT_TREE_KEY: InjectionKey<() => void> = Symbol("toggleGitTree");

/** Settings tab identifiers accepted by {@link OPEN_SETTINGS_KEY}. */
export type SettingsTabTarget =
  | "general" | "dock" | "git" | "editor" | "ai" | "automations" | "logs" | "hooks" | "accounts" | "mcp" | "aiTemplates";

/** Open the Settings panel, optionally on a specific tab (e.g. from the PR sidebar). */
export const OPEN_SETTINGS_KEY: InjectionKey<(tab?: SettingsTabTarget) => void> = Symbol("openSettings");


/**
 * Write an AI-generated commit message into the App-owned commit draft.
 *
 * RepoSidebar's commit pane unmounts when the user switches view, and Vue
 * drops `emit()` from an unmounted instance — so an AI generation that
 * resolves after navigation must not rely on `update:commitSummary`. The
 * sink ignores results whose `cwd` is no longer the open repo.
 */
export const COMMIT_MESSAGE_SINK_KEY: InjectionKey<
  (cwd: string, summary: string, description: string) => void
> = Symbol("commitMessageSink");
