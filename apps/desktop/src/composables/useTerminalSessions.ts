import { ref, reactive, type Ref } from "vue";
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
    onChunk: (sessionId: number, chunk: string) => void,
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
    const sessionId = await terminalOpen(
      cwd,
      { cols: 80, rows: 24 },
      (chunk) => onChunk(tab.sessionId, chunk),
    );
    tab.sessionId = sessionId;
    return tab;
  }

  async function closeTab(repoPath: string, tabId: number): Promise<void> {
    const list = listFor(repoPath);
    const idx = list.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const [tab] = list.splice(idx, 1);
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
