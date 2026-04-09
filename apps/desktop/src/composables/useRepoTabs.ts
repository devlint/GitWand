import { ref, computed } from "vue";
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
}

const STORAGE_KEY = "gitwand-open-tabs";
const MAX_TABS = 10;

/** Persist open tab paths to localStorage. */
function save(entries: RepoTab[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.map((t) => t.path)));
  } catch { /* not fatal */ }
}

/** Extract display name from a path. */
function nameFromPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.split("/").pop() ?? path;
}

// ─── Singleton state ────────────────────────────────────────
const tabs = ref<RepoTab[]>([]);
const activeTabId = ref<number | null>(null);

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
    save(tabs.value);
    return tab;
  }

  /**
   * Close a tab by ID. Switches to an adjacent tab if active.
   */
  function closeTab(tabId: number) {
    const index = tabs.value.findIndex((t) => t.id === tabId);
    if (index === -1) return;

    tabs.value.splice(index, 1);

    if (activeTabId.value === tabId) {
      if (tabs.value.length > 0) {
        const newIndex = Math.min(index, tabs.value.length - 1);
        activeTabId.value = tabs.value[newIndex].id;
      } else {
        activeTabId.value = null;
      }
    }

    save(tabs.value);
  }

  /**
   * Switch to a tab by ID.
   */
  function switchTab(tabId: number) {
    if (tabs.value.some((t) => t.id === tabId)) {
      activeTabId.value = tabId;
    }
  }

  return {
    tabs,
    activeTabId,
    openTab,
    closeTab,
    switchTab,
  };
}
