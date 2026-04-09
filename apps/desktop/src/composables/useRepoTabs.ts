import { ref, computed, shallowRef, triggerRef } from "vue";
import { useGitRepo } from "./useGitRepo";
import { useFolderHistory } from "./useFolderHistory";

/**
 * Unique identifier for a tab.
 */
let nextTabId = 1;

export interface RepoTab {
  /** Unique numeric ID for this tab. */
  id: number;
  /** Path to the repository. */
  path: string;
  /** Display name (last path segment). */
  name: string;
  /** The full useGitRepo() instance for this tab. */
  repo: ReturnType<typeof useGitRepo>;
}

const STORAGE_KEY = "gitwand-open-tabs";
const MAX_TABS = 10;

/** Read persisted tab paths from localStorage. */
function loadTabPaths(): string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p: unknown) => typeof p === "string");
  } catch {
    return [];
  }
}

/** Persist open tab paths to localStorage. */
function saveTabPaths(tabs: RepoTab[]) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(tabs.map((t) => t.path)),
    );
  } catch {
    // Not fatal
  }
}

/** Extract display name from a path. */
function nameFromPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.split("/").pop() ?? path;
}

// ─── Singleton state ────────────────────────────────────────
const tabs = ref<RepoTab[]>([]);
const activeTabId = ref<number | null>(null);

/** Singleton computed — shared across all callers. */
const activeTab = computed<RepoTab | null>(() => {
  if (activeTabId.value === null) return null;
  return tabs.value.find((t) => t.id === activeTabId.value) ?? null;
});

const tabCount = computed(() => tabs.value.length);

/**
 * Composable for managing multiple repo tabs.
 * Singleton — shared state across all components.
 */
export function useRepoTabs() {
  const { addToHistory } = useFolderHistory();

  /**
   * Open a new repo in a tab. If the repo is already open, switch to it.
   * Returns the tab that was opened or activated.
   */
  function openTab(path: string): RepoTab {
    const normalized = path.replace(/\/+$/, "") || path;

    // Already open? Just switch to it.
    const existing = tabs.value.find((t) => t.path === normalized);
    if (existing) {
      activeTabId.value = existing.id;
      return existing;
    }

    // Enforce max tabs
    if (tabs.value.length >= MAX_TABS) {
      // Close the oldest non-active tab
      const toClose = tabs.value.find((t) => t.id !== activeTabId.value);
      if (toClose) {
        closeTab(toClose.id);
      }
    }

    const id = nextTabId++;
    const repo = useGitRepo();
    const tab: RepoTab = {
      id,
      path: normalized,
      name: nameFromPath(normalized),
      repo,
    };

    tabs.value.push(tab);
    activeTabId.value = id;

    // Initialize the repo
    repo.openRepo(normalized);

    // Record in history
    addToHistory(normalized);

    saveTabPaths(tabs.value);
    return tab;
  }

  /**
   * Close a tab by ID. If it's the active tab, switch to an adjacent one.
   */
  function closeTab(tabId: number) {
    const index = tabs.value.findIndex((t) => t.id === tabId);
    if (index === -1) return;

    tabs.value.splice(index, 1);

    // If we closed the active tab, pick a new one
    if (activeTabId.value === tabId) {
      if (tabs.value.length > 0) {
        // Prefer the tab at the same index, or the one before
        const newIndex = Math.min(index, tabs.value.length - 1);
        activeTabId.value = tabs.value[newIndex].id;
      } else {
        activeTabId.value = null;
      }
    }

    saveTabPaths(tabs.value);
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
   * Move a tab from one position to another (for drag reorder).
   */
  function moveTab(fromIndex: number, toIndex: number) {
    if (
      fromIndex < 0 ||
      fromIndex >= tabs.value.length ||
      toIndex < 0 ||
      toIndex >= tabs.value.length
    ) {
      return;
    }
    const [moved] = tabs.value.splice(fromIndex, 1);
    tabs.value.splice(toIndex, 0, moved);
    saveTabPaths(tabs.value);
  }

  /**
   * Close all tabs except the specified one.
   */
  function closeOtherTabs(keepTabId: number) {
    tabs.value = tabs.value.filter((t) => t.id === keepTabId);
    if (tabs.value.length > 0) {
      activeTabId.value = tabs.value[0].id;
    } else {
      activeTabId.value = null;
    }
    saveTabPaths(tabs.value);
  }

  /**
   * Restore tabs from localStorage on app startup.
   * Called once from App.vue onMounted.
   */
  function restoreTabs() {
    const paths = loadTabPaths();
    for (const path of paths) {
      openTab(path);
    }
    // If nothing was restored, no active tab
    if (tabs.value.length > 0 && activeTabId.value === null) {
      activeTabId.value = tabs.value[0].id;
    }
  }

  return {
    tabs,
    activeTabId,
    activeTab,
    tabCount,
    openTab,
    closeTab,
    switchTab,
    moveTab,
    closeOtherTabs,
    restoreTabs,
  };
}
