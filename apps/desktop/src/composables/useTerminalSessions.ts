import { ref, reactive, type Ref } from "vue";
import {
  terminalOpen,
  terminalWrite,
  terminalResize,
  terminalClose,
} from "../utils/backend";
import { isUnderPath } from "../utils/paths";

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

export type TerminalTabType = "shell" | "claude" | "codex" | "opencode" | "antigravity" | "setup";

/**
 * Opens a backend session for a tab in place of `terminalOpen` (a worktree
 * hook's `worktreeRunHook`, for instance). Returns the session id.
 */
export type TabSpawner = (
  onChunk: (chunk: string) => void,
  onExit: (code: number | null) => void,
) => Promise<number>;

export interface OpenTabOptions {
  shell?: string;
  type?: TerminalTabType;
  /** Tab title; defaults from the type. */
  title?: string;
  /** Input is never sent to the session (setup / teardown tabs). */
  readOnly?: boolean;
  spawn?: TabSpawner;
  /** Called once, when the session ends; the tab is then marked dead. */
  onExit?: (code: number | null) => void;
}

export interface TerminalTab {
  id: number; // id local (mémoire)
  sessionId: number; // id PTY backend
  title: string;
  titleManual: boolean;
  alive: boolean;
  type: TerminalTabType;
  hasUnread: boolean;
  /** The directory the session was opened in: what `disposeCwd` matches. */
  cwd: string;
  /** Typing is not forwarded to the session. */
  readOnly: boolean;
}

// État module (pattern store-composable, pas de Pinia).
const tabsByRepo = reactive(new Map<string, TerminalTab[]>());
const activeByRepo = reactive(new Map<string, number | null>());
let nextLocalId = 1;
// openTab calls still awaiting their PTY, by tab id: disposeRepo waits for
// them, so no session spawned meanwhile outlives the repo's disposal.
const opening = new Map<number, Promise<unknown>>();

// Debounce refresh par repo.
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
// Timestamp of the first un-fired notifyOutput in the current burst, per repo.
// Used to cap how long a continuous output stream can keep resetting the
// debounce (see MAX_WAIT_MS).
const firstPendingAt = new Map<string, number>();
let mutationHandler: ((repoPath: string) => void) | null = null;
const DEBOUNCE_MS = 800;
// A process that emits output continuously (tail -f, a dev server, an agent
// streaming) would reset the 800ms debounce on every chunk, so a `git commit`
// run in that same tab would never refresh the UI while output keeps flowing.
// Cap the wait: once output has been pending this long, fire the refresh even
// if more output is still arriving.
const MAX_WAIT_MS = 4000;

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
  opening.clear();
  for (const timer of debounceTimers.values()) clearTimeout(timer);
  debounceTimers.clear();
  firstPendingAt.clear();
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
    opts?: OpenTabOptions,
  ): Promise<TerminalTab> {
    const tabType = opts?.type ?? "shell";
    const tab: TerminalTab = {
      id: nextLocalId++,
      sessionId: -1,
      title: opts?.title ?? (tabType === "claude" ? "Claude Code" : tabType === "codex" ? "Codex" : tabType === "opencode" ? "OpenCode" : tabType === "antigravity" ? "Antigravity" : tabType === "setup" ? "setup" : "shell"),
      titleManual: false,
      alive: true,
      type: tabType,
      hasUnread: false,
      cwd,
      readOnly: opts?.readOnly ?? false,
    };
    const list = listFor(repoPath);
    list.push(tab);
    activeByRepo.set(repoPath, tab.id);
    // Taille initiale standard ; le panel re-fit au mount.
    // Route output by stable tab.id so chunks arriving before terminalOpen
    // resolves (and before sessionId is assigned) are never dropped.
    const done = spawnInto(tab, list, repoPath, cwd, onChunk, opts);
    opening.set(tab.id, done);
    try {
      await done;
    } finally {
      opening.delete(tab.id);
    }
    return tab;
  }

  async function spawnInto(
    tab: TerminalTab,
    list: TerminalTab[],
    repoPath: string,
    cwd: string,
    onChunk: (tabId: number, chunk: string) => void,
    opts?: OpenTabOptions,
  ): Promise<void> {
    const tabType = tab.type;
    const onOutput = (chunk: string) => {
      if (activeByRepo.get(repoPath) !== tab.id) {
        tab.hasUnread = true;
      }
      onChunk(tab.id, chunk);
    };
    const onExit = (code: number | null) => {
      tab.alive = false;
      opts?.onExit?.(code);
    };
    try {
      const sessionId = opts?.spawn
        ? await opts.spawn(onOutput, onExit)
        : await terminalOpen(
            cwd,
            {
              cols: 80,
              rows: 24,
              shell: opts?.shell || undefined,
              // Agent tabs ("claude"/"codex") launch as a first-class agent CLI,
              // never smuggled through the `shell` parameter.
              agent: tabType !== "shell" ? tabType : undefined,
              onExit,
            },
            onOutput,
          );

      // Fix 3 — Check if the tab was closed while we were awaiting the PTY spawn.
      // If closeTab() fired during the await window, it skipped terminalClose()
      // because sessionId was still -1. Now that we have the real sessionId, we
      // must clean up the orphaned PTY process.
      const stillExists = list.includes(tab);
      if (!stillExists) {
        await terminalClose(sessionId);
        return; // caller has the ref; the tab is already gone from the list
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
  }

  async function closeTab(repoPath: string, tabId: number): Promise<void> {
    const list = listFor(repoPath);
    const idx = list.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const [tab] = list.splice(idx, 1);
    tab.alive = false;
    if (tab.sessionId >= 0) {
      await terminalClose(tab.sessionId);
    }
    // sessionId === -1 means openTab is still awaiting terminalOpen. The "Fix 3"
    // guard inside openTab detects that the tab is gone from the list and calls
    // terminalClose once the sessionId arrives. No extra bookkeeping needed here —
    // `tab` is still referenced by openTab's closure even after being spliced.
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
    firstPendingAt.delete(repoPath);
    const list = listFor(repoPath);
    // Emptied in place: a tab still spawning checks this very array once its
    // PTY is up, and closes it when gone (openTab's Fix 3) — we wait for that.
    const tabs = list.splice(0);
    activeByRepo.set(repoPath, null);
    // Independent IPC calls — close all sessions concurrently.
    await Promise.all([
      ...tabs.filter((tab) => tab.sessionId >= 0).map((tab) => terminalClose(tab.sessionId)),
      ...tabs.map((tab) => opening.get(tab.id)?.catch(() => {})),
    ]);
  }

  /**
   * Close every tab opened in `root` or under it (a worktree's path), in any
   * repo, waiting for tabs still opening — like `disposeRepo`, but by the
   * tabs' own directory rather than the repo they are listed under.
   */
  async function disposeCwd(root: string): Promise<void> {
    const closing: Promise<unknown>[] = [];
    for (const [repoPath, list] of tabsByRepo) {
      // Removed in place: a tab still spawning checks this very array once
      // its PTY is up, and closes it when gone (openTab's Fix 3).
      const gone = list.filter((tab) => isUnderPath(tab.cwd, root));
      if (gone.length === 0) continue;
      for (const tab of gone) list.splice(list.indexOf(tab), 1);
      const active = activeByRepo.get(repoPath);
      if (gone.some((tab) => tab.id === active)) {
        activeByRepo.set(repoPath, list.length ? list[list.length - 1].id : null);
      }
      for (const tab of gone) {
        if (tab.sessionId >= 0) closing.push(terminalClose(tab.sessionId));
        const pending = opening.get(tab.id);
        if (pending) closing.push(pending.catch(() => {}));
      }
    }
    await Promise.all(closing);
  }

  function notifyOutput(repoPath: string): void {
    const now = Date.now();
    const pendingSince = firstPendingAt.get(repoPath);
    if (pendingSince === undefined) {
      firstPendingAt.set(repoPath, now);
    } else if (now - pendingSince >= MAX_WAIT_MS) {
      // Output has been flowing past the max wait — fire now instead of
      // rescheduling, so a continuous stream can't starve the refresh forever.
      const prev = debounceTimers.get(repoPath);
      if (prev) clearTimeout(prev);
      debounceTimers.delete(repoPath);
      firstPendingAt.delete(repoPath);
      mutationHandler?.(repoPath);
      return;
    }
    const prev = debounceTimers.get(repoPath);
    if (prev) clearTimeout(prev);
    debounceTimers.set(
      repoPath,
      setTimeout(() => {
        debounceTimers.delete(repoPath);
        firstPendingAt.delete(repoPath);
        mutationHandler?.(repoPath);
      }, DEBOUNCE_MS),
    );
  }

  function setMutationHandler(cb: (repoPath: string) => void): void {
    mutationHandler = cb;
  }

  function markRead(repoPath: string, tabId: number): void {
    const tab = listFor(repoPath).find((t) => t.id === tabId);
    if (tab) tab.hasUnread = false;
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
    disposeCwd,
    notifyOutput,
    setMutationHandler,
    write,
    resize,
    markRead,
    terminalFocused: terminalFocused as Ref<boolean>,
  };
}

/** Test-only helper: simulates a PTY chunk arriving for a tab.
 * Used in tests to trigger the hasUnread path without a real PTY.
 */
export function simulateChunkForTab(repoPath: string, tabId: number): void {
  if (activeByRepo.get(repoPath) !== tabId) {
    const tab = listFor(repoPath).find((t) => t.id === tabId);
    if (tab) tab.hasUnread = true;
  }
}
