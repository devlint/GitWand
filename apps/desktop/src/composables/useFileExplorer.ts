import { reactive } from "vue";
import { readFile, writeFile } from "@/utils/backend";

export interface FileTab {
  id: number;
  path: string;
  content: string;
  originalContent: string;
  /** Preview tabs (single-click) are replaced by the next preview open;
   * pinned tabs (double-click, or edited) persist alongside them. */
  pinned: boolean;
  /**
   * True when `readFile` failed to decode the file as UTF-8 text (binary
   * file). Binary tabs show a "not editable" placeholder instead of an
   * editor — see spec non-goal "no binary preview in v1".
   */
  binary: boolean;
}

export type FileExplorerShortcut = "save" | "close" | { switch: number } | null;

export function resolveFileExplorerShortcut(e: KeyboardEvent, focused: boolean): FileExplorerShortcut {
  if (!focused) return null;
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return null;
  if (e.key === "s") return "save";
  if (e.key === "w") return "close";
  if (/^[1-9]$/.test(e.key)) return { switch: Number(e.key) - 1 };
  return null;
}

const tabsByRepo = reactive(new Map<string, FileTab[]>());
const activeByRepo = reactive(new Map<string, number | null>());
let nextLocalId = 1;

export function useFileExplorer() {
  function tabsFor(repoPath: string): FileTab[] {
    if (!tabsByRepo.has(repoPath)) tabsByRepo.set(repoPath, []);
    return tabsByRepo.get(repoPath)!;
  }

  function activeTabId(repoPath: string): number | null {
    return activeByRepo.get(repoPath) ?? null;
  }

  function setActive(repoPath: string, tabId: number) {
    activeByRepo.set(repoPath, tabId);
  }

  function isDirty(tab: FileTab): boolean {
    return tab.content !== tab.originalContent;
  }

  /**
   * Open `path` in a tab. `pin: false` (default) reuses the single
   * "preview" tab (VS Code-style, replaced by the next preview open);
   * `pin: true` creates/keeps a permanent tab.
   */
  async function openTab(repoPath: string, cwd: string, path: string, pin = false): Promise<FileTab> {
    const tabs = tabsFor(repoPath);
    const existing = tabs.find((t) => t.path === path);
    if (existing) {
      if (pin) existing.pinned = true;
      setActive(repoPath, existing.id);
      return existing;
    }

    let content = "";
    let binary = false;
    try {
      content = await readFile(cwd, path);
    } catch {
      // `read_file` fails when the file isn't valid UTF-8 text (binary
      // file) — show a placeholder instead of surfacing the raw error.
      binary = true;
    }
    const tab: FileTab = {
      id: nextLocalId++,
      path,
      content,
      originalContent: content,
      pinned: pin,
      binary,
    };

    if (!pin) {
      const previewIdx = tabs.findIndex((t) => !t.pinned);
      if (previewIdx !== -1) {
        tabs.splice(previewIdx, 1, tab);
      } else {
        tabs.push(tab);
      }
    } else {
      tabs.push(tab);
    }

    setActive(repoPath, tab.id);
    return tab;
  }

  async function saveTab(repoPath: string, cwd: string, tabId: number): Promise<void> {
    const tab = tabsFor(repoPath).find((t) => t.id === tabId);
    if (!tab || tab.binary || !isDirty(tab)) return;
    await writeFile(cwd, tab.path, tab.content);
    tab.originalContent = tab.content;
  }

  function closeTab(repoPath: string, tabId: number) {
    const tabs = tabsFor(repoPath);
    const idx = tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    tabs.splice(idx, 1);
    if (activeByRepo.get(repoPath) === tabId) {
      const next = tabs[Math.max(0, idx - 1)];
      activeByRepo.set(repoPath, next ? next.id : null);
    }
  }

  function updateContent(repoPath: string, tabId: number, content: string) {
    const tab = tabsFor(repoPath).find((t) => t.id === tabId);
    if (tab) tab.content = content;
  }

  function disposeRepo(repoPath: string) {
    tabsByRepo.delete(repoPath);
    activeByRepo.delete(repoPath);
  }

  return {
    tabsFor,
    activeTabId,
    setActive,
    isDirty,
    openTab,
    saveTab,
    closeTab,
    updateContent,
    disposeRepo,
  };
}
