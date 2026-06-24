import { ref, reactive, type Ref } from "vue";

export type TerminalShortcut = "new" | "close" | { switch: number } | null;

/** Route un keydown vers une action terminal si le terminal a le focus. */
export function resolveTerminalShortcut(e: KeyboardEvent, focused: boolean): TerminalShortcut {
  if (!focused) return null;
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return null;
  if (e.key === "t") return "new";
  if (e.key === "w") return "close";
  if (/^[1-9]$/.test(e.key)) return { switch: Number(e.key) - 1 };
  return null;
}
import {
  terminalOpen,
  terminalWrite,
  terminalResize,
  terminalClose,
} from "../utils/backend";

export interface TerminalTab {
  id: number; // id local (mémoire)
  sessionId: number; // id PTY backend
  title: string;
  titleManual: boolean;
  alive: boolean;
}

// État module (pattern store-composable, pas de Pinia).
const tabsByRepo = reactive(new Map<string, TerminalTab[]>());
const activeByRepo = reactive(new Map<string, number | null>());
let nextLocalId = 1;

// Debounce refresh par repo.
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
let mutationHandler: ((repoPath: string) => void) | null = null;
const DEBOUNCE_MS = 800;

const terminalFocused = ref(false);

function listFor(repoPath: string): TerminalTab[] {
  if (!tabsByRepo.has(repoPath)) tabsByRepo.set(repoPath, []);
  return tabsByRepo.get(repoPath)!;
}

/** Reset all module-level state. Used in tests only. */
export function __resetForTests(): void {
  tabsByRepo.clear();
  activeByRepo.clear();
  nextLocalId = 1;
  for (const timer of debounceTimers.values()) clearTimeout(timer);
  debounceTimers.clear();
  mutationHandler = null;
  terminalFocused.value = false;
}

export function useTerminalSessions() {
  function tabsFor(repoPath: string): TerminalTab[] {
    return listFor(repoPath);
  }

  function activeTabId(repoPath: string): number | null {
    return activeByRepo.get(repoPath) ?? null;
  }

  async function openTab(
    repoPath: string,
    cwd: string,
    onChunk: (tabId: number, chunk: string) => void,
    opts?: { shell?: string },
  ): Promise<TerminalTab> {
    const tab: TerminalTab = {
      id: nextLocalId++,
      sessionId: -1,
      title: "shell",
      titleManual: false,
      alive: true,
    };
    const list = listFor(repoPath);
    list.push(tab);
    activeByRepo.set(repoPath, tab.id);
    // Taille initiale standard ; le panel re-fit au mount.
    // Route output by stable tab.id so chunks arriving before terminalOpen
    // resolves (and before sessionId is assigned) are never dropped.
    try {
      const sessionId = await terminalOpen(
        cwd,
        { cols: 80, rows: 24, shell: opts?.shell || undefined },
        (chunk) => onChunk(tab.id, chunk),
      );

      // Fix 3 — Check if the tab was closed while we were awaiting the PTY spawn.
      // If closeTab() fired during the await window, it skipped terminalClose()
      // because sessionId was still -1. Now that we have the real sessionId, we
      // must clean up the orphaned PTY process.
      const stillExists = list.includes(tab);
      if (!stillExists) {
        await terminalClose(sessionId);
        return tab; // caller has the ref; the tab is already gone from the list
      }

      tab.sessionId = sessionId;
    } catch (err) {
      // Fix 4 — PTY spawn failed (backend error, invalid cwd, PTY exhaustion, etc.).
      // Remove the ghost tab that was pushed before the await, so the UI doesn't
      // render a non-functional tab.
      const idx = list.indexOf(tab);
      if (idx !== -1) list.splice(idx, 1);
      tab.alive = false;
      // Restore focus to the previous active tab if we displaced it.
      if (activeByRepo.get(repoPath) === tab.id) {
        activeByRepo.set(repoPath, list.length ? list[list.length - 1].id : null);
      }
      throw err; // re-throw so the caller (App.vue) can surface the error
    }
    return tab;
  }

  async function closeTab(repoPath: string, tabId: number): Promise<void> {
    const list = listFor(repoPath);
    const idx = list.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const [tab] = list.splice(idx, 1);
    tab.alive = false;
    if (tab.sessionId >= 0) await terminalClose(tab.sessionId);
    if (activeByRepo.get(repoPath) === tabId) {
      activeByRepo.set(repoPath, list.length ? list[list.length - 1].id : null);
    }
  }

  function setActive(repoPath: string, tabId: number): void {
    activeByRepo.set(repoPath, tabId);
  }

  function renameTab(repoPath: string, tabId: number, title: string): void {
    const tab = listFor(repoPath).find((t) => t.id === tabId);
    if (tab) {
      tab.title = title;
      tab.titleManual = true;
    }
  }

  function setTitleFromShell(repoPath: string, tabId: number, title: string): void {
    const tab = listFor(repoPath).find((t) => t.id === tabId);
    if (tab && !tab.titleManual && title.trim()) tab.title = title;
  }

  async function disposeRepo(repoPath: string): Promise<void> {
    const t = debounceTimers.get(repoPath);
    if (t) { clearTimeout(t); debounceTimers.delete(repoPath); }
    const list = listFor(repoPath);
    for (const tab of list) {
      if (tab.sessionId >= 0) await terminalClose(tab.sessionId);
    }
    tabsByRepo.set(repoPath, []);
    activeByRepo.set(repoPath, null);
  }

  function notifyOutput(repoPath: string): void {
    const prev = debounceTimers.get(repoPath);
    if (prev) clearTimeout(prev);
    debounceTimers.set(
      repoPath,
      setTimeout(() => {
        debounceTimers.delete(repoPath);
        mutationHandler?.(repoPath);
      }, DEBOUNCE_MS),
    );
  }

  function setMutationHandler(cb: (repoPath: string) => void): void {
    mutationHandler = cb;
  }

  function write(sessionId: number, data: string) {
    return terminalWrite(sessionId, data);
  }

  function resize(sessionId: number, cols: number, rows: number) {
    return terminalResize(sessionId, cols, rows);
  }

  return {
    tabsFor,
    activeTabId,
    openTab,
    closeTab,
    setActive,
    renameTab,
    setTitleFromShell,
    disposeRepo,
    notifyOutput,
    setMutationHandler,
    write,
    resize,
    terminalFocused: terminalFocused as Ref<boolean>,
  };
}
