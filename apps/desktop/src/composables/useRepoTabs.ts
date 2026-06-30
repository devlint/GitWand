import { ref, computed, watch } from "vue";
import { useFolderHistory } from "./useFolderHistory";

/**
 * Unique identifier for a tab. Ids are regenerated every module load
 * (they're just an in-memory handle), so we never persist them — the
 * `path` is the stable identity we save to localStorage instead.
 */
let nextTabId = 1;

export interface RepoTab {
  /** Unique numeric ID for this tab (memory-only, resets on reload). */
  id: number;
  /** Path to the repository. */
  path: string;
  /** Display name (last path segment). */
  name: string;
}

const STORAGE_KEY = "gitwand-open-tabs";
const MAX_TABS = 10;

/**
 * Persisted shape. We keep paths + the active path (not id — ids are
 * regenerated on every module load so a numeric id wouldn't survive a
 * restart). Older releases saved just `string[]`; `load()` still reads
 * that shape so first-run-after-update doesn't lose tabs.
 */
interface PersistedTabs {
  paths: string[];
  activePath: string | null;
}

/** Extract display name from a path. */
function nameFromPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.split("/").pop() ?? path;
}

/**
 * Top-level tabs represent *projects* (main worktrees). AI-task scratch
 * worktrees are reached from the per-project worktree submenu, not as their
 * own top-level chips — so drop any `gitwand-scratch-*` path that an older
 * build persisted as a flat tab.
 */
function isScratchPath(path: string): boolean {
  const base = path.replace(/\/+$/, "").split("/").pop() ?? "";
  return base.startsWith("gitwand-scratch-");
}

/** Persist open tab paths + which one is active to localStorage. */
function save(entries: RepoTab[], activeId: number | null) {
  try {
    const active = entries.find((t) => t.id === activeId);
    const payload: PersistedTabs = {
      paths: entries.map((t) => t.path),
      activePath: active?.path ?? null,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* not fatal — persistence is best-effort */
  }
}

/**
 * Read from localStorage at module load. Handles two formats:
 *   - current: `{ paths: string[], activePath: string | null }`
 *   - legacy:  `string[]` (just paths, no active marker)
 * Any parse error or shape mismatch → returns empty; never throws.
 */
function load(): PersistedTabs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { paths: [], activePath: null };
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // Legacy format — array of paths only.
      return {
        paths: parsed.filter((p): p is string => typeof p === "string" && !isScratchPath(p)),
        activePath: null,
      };
    }
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as PersistedTabs).paths)) {
      const obj = parsed as PersistedTabs;
      return {
        paths: obj.paths.filter((p): p is string => typeof p === "string" && !isScratchPath(p)),
        activePath: typeof obj.activePath === "string" ? obj.activePath : null,
      };
    }
    return { paths: [], activePath: null };
  } catch {
    return { paths: [], activePath: null };
  }
}

// ─── Singleton state ────────────────────────────────────────
// Hydrate from localStorage immediately so the very first render already
// has the tabs ready and no "empty-tab-strip flash" happens on launch.
// Running this at module load is fine: localStorage is synchronous and
// available before any Vue component mounts.
const persisted = load();
const tabs = ref<RepoTab[]>(
  persisted.paths.map((path) => ({
    id: nextTabId++,
    path,
    name: nameFromPath(path),
  })),
);
const activeTabId = ref<number | null>(
  (() => {
    if (tabs.value.length === 0) return null;
    if (persisted.activePath) {
      const match = tabs.value.find((t) => t.path === persisted.activePath);
      if (match) return match.id;
    }
    // Fallback: first tab (legacy format or the saved active path was
    // removed from the list for some reason).
    return tabs.value[0]?.id ?? null;
  })(),
);

// Persist whenever the active tab changes, even without add/close —
// so the "active on relaunch" marker stays fresh as the user switches
// between tabs. Add/close paths already call save() explicitly, so we
// skip the change-detection dance there.
watch(activeTabId, (id) => save(tabs.value, id));

// ─── Per-project worktree selection ─────────────────────────
// Each project tab can have one of its worktrees active "in place" (the
// submenu lets the user switch the checkout without opening a new tab).
// Keyed by tab id (in-memory only — ids regenerate per load, so on restart
// every project starts back on its main worktree). Absence of an entry, or
// a value equal to the tab's own path, both mean "main".
const worktreeSelections = ref<Record<number, string>>({});

/**
 * The path of the checkout that should actually be loaded for the active
 * tab — its selected worktree, or the project root when none is selected.
 * App.vue watches this (not `activeTabId`) to drive `openRepo`.
 */
const activeRepoPath = computed<string | null>(() => {
  if (activeTabId.value === null) return null;
  const sel = worktreeSelections.value[activeTabId.value];
  if (sel) return sel;
  const tab = tabs.value.find((t) => t.id === activeTabId.value);
  return tab?.path ?? null;
});

/**
 * Lightweight tab tracker — stores only paths and display names.
 * The actual repo state lives in a single useGitRepo() instance in App.vue,
 * which reloads when the active tab changes.
 */
export function useRepoTabs() {
  const { addToHistory } = useFolderHistory();

  /**
   * Open a path in a tab. If already open, switch to it.
   * Returns the tab.
   */
  function openTab(path: string): RepoTab {
    const normalized = path.replace(/\/+$/, "") || path;

    // Already open? Just switch.
    const existing = tabs.value.find((t) => t.path === normalized);
    if (existing) {
      activeTabId.value = existing.id;
      return existing;
    }

    // Enforce max tabs
    if (tabs.value.length >= MAX_TABS) {
      const toClose = tabs.value.find((t) => t.id !== activeTabId.value);
      if (toClose) closeTab(toClose.id);
    }

    const id = nextTabId++;
    const tab: RepoTab = { id, path: normalized, name: nameFromPath(normalized) };

    tabs.value.push(tab);
    activeTabId.value = id;

    addToHistory(normalized);
    save(tabs.value, activeTabId.value);
    return tab;
  }

  /**
   * Close a tab by ID. Switches to an adjacent tab if active.
   */
  function closeTab(tabId: number) {
    const index = tabs.value.findIndex((t) => t.id === tabId);
    if (index === -1) return;

    tabs.value.splice(index, 1);

    // Drop any worktree selection bound to this tab.
    if (tabId in worktreeSelections.value) {
      const next = { ...worktreeSelections.value };
      delete next[tabId];
      worktreeSelections.value = next;
    }

    if (activeTabId.value === tabId) {
      if (tabs.value.length > 0) {
        const newIndex = Math.min(index, tabs.value.length - 1);
        activeTabId.value = tabs.value[newIndex].id;
      } else {
        activeTabId.value = null;
      }
    }

    save(tabs.value, activeTabId.value);
  }

  /**
   * Switch a project tab's active checkout to one of its worktrees, in place.
   * Passing the tab's own project path (the main worktree) clears the
   * selection. Does not open a new tab; `activeRepoPath` recomputes so the
   * watcher in App.vue reloads the chosen checkout.
   */
  function selectWorktree(tabId: number, path: string) {
    const tab = tabs.value.find((t) => t.id === tabId);
    if (!tab) return;
    const normalized = path.replace(/\/+$/, "") || path;
    if (normalized === tab.path) {
      if (!(tabId in worktreeSelections.value)) return;
      const next = { ...worktreeSelections.value };
      delete next[tabId];
      worktreeSelections.value = next;
    } else {
      worktreeSelections.value = { ...worktreeSelections.value, [tabId]: normalized };
    }
  }

  /**
   * Switch to a tab by ID.
   */
  function switchTab(tabId: number) {
    if (tabs.value.some((t) => t.id === tabId)) {
      activeTabId.value = tabId;
    }
  }

  /**
   * Reorder tabs by moving a tab from one index to another.
   */
  function reorderTabs(oldIndex: number, newIndex: number) {
    if (oldIndex < 0 || oldIndex >= tabs.value.length) return;
    if (newIndex < 0 || newIndex >= tabs.value.length) return;
    if (oldIndex === newIndex) return;

    const tab = tabs.value[oldIndex];
    tabs.value.splice(oldIndex, 1);
    tabs.value.splice(newIndex, 0, tab);

    save(tabs.value, activeTabId.value);
  }

  return {
    tabs,
    activeTabId,
    openTab,
    closeTab,
    selectWorktree,
    activeRepoPath,
    switchTab,
    reorderTabs,
  };
}
