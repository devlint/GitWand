import { ref } from "vue";

export interface FolderEntry {
  path: string;
  /** Display name (last segment of the path). */
  name: string;
  /** ISO timestamp of last use. */
  lastUsed: string;
  /** Whether this entry is pinned as a favorite. */
  pinned: boolean;
}

const STORAGE_KEY = "gitwand-folder-history";
const MAX_ENTRIES = 15;

/** Read persisted history from localStorage. */
function load(): FolderEntry[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

/** Persist history to localStorage. */
function save(entries: FolderEntry[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // localStorage might not be available
  }
}

/** Extract display name from a path. */
function nameFromPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.split("/").pop() ?? path;
}

const history = ref<FolderEntry[]>(load());

/**
 * Composable for managing folder history & favorites.
 * Shared singleton state across all components.
 */
export function useFolderHistory() {
  /**
   * Record a folder as recently used.
   * Moves it to the top if already present, otherwise adds it.
   */
  function addToHistory(path: string) {
    const normalized = path.replace(/\/+$/, "") || path;
    const existing = history.value.find((e) => e.path === normalized);

    if (existing) {
      existing.lastUsed = new Date().toISOString();
    } else {
      history.value.unshift({
        path: normalized,
        name: nameFromPath(normalized),
        lastUsed: new Date().toISOString(),
        pinned: false,
      });
    }

    // Sort: pinned first, then by last used
    history.value.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.lastUsed.localeCompare(a.lastUsed);
    });

    // Trim to max size (keep pinned entries)
    if (history.value.length > MAX_ENTRIES) {
      const pinned = history.value.filter((e) => e.pinned);
      const unpinned = history.value.filter((e) => !e.pinned);
      history.value = [...pinned, ...unpinned.slice(0, MAX_ENTRIES - pinned.length)];
    }

    save(history.value);
  }

  /** Toggle pin/favorite status. */
  function togglePin(path: string) {
    const entry = history.value.find((e) => e.path === path);
    if (!entry) return;

    entry.pinned = !entry.pinned;

    // Re-sort
    history.value.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.lastUsed.localeCompare(a.lastUsed);
    });

    save(history.value);
  }

  /** Remove a folder from history. */
  function removeFromHistory(path: string) {
    history.value = history.value.filter((e) => e.path !== path);
    save(history.value);
  }

  /** Clear all non-pinned entries. */
  function clearHistory() {
    history.value = history.value.filter((e) => e.pinned);
    save(history.value);
  }

  return {
    history,
    addToHistory,
    togglePin,
    removeFromHistory,
    clearHistory,
  };
}
