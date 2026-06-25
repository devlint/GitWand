import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../utils/backend", () => ({
  terminalOpen: vi.fn(async () => 42),
  terminalWrite: vi.fn(async () => {}),
  terminalResize: vi.fn(async () => {}),
  terminalClose: vi.fn(async () => {}),
}));

import { useTerminalSessions, __resetForTests, simulateChunkForTab } from "../useTerminalSessions";
import { terminalClose } from "../../utils/backend";

describe("useTerminalSessions", () => {
  beforeEach(() => {
    __resetForTests();
    vi.clearAllMocks();
  });

  it("scope les onglets par repoPath", async () => {
    const s = useTerminalSessions();
    await s.openTab("/repo/a", "/repo/a", () => {});
    expect(s.tabsFor("/repo/a")).toHaveLength(1);
    expect(s.tabsFor("/repo/b")).toHaveLength(0);
  });

  it("openTab crée un onglet actif avec un sessionId backend", async () => {
    const s = useTerminalSessions();
    const tab = await s.openTab("/repo/a", "/repo/a", () => {});
    expect(tab.sessionId).toBe(42);
    expect(s.activeTabId("/repo/a")).toBe(tab.id);
    expect(tab.alive).toBe(true);
  });

  it("closeTab appelle le backend et retire l'onglet", async () => {
    const s = useTerminalSessions();
    const tab = await s.openTab("/repo/a", "/repo/a", () => {});
    await s.closeTab("/repo/a", tab.id);
    expect(terminalClose).toHaveBeenCalledWith(42);
    expect(s.tabsFor("/repo/a")).toHaveLength(0);
  });

  it("setTitleFromShell n'écrase pas un titre manuel", async () => {
    const s = useTerminalSessions();
    const tab = await s.openTab("/repo/a", "/repo/a", () => {});
    s.renameTab("/repo/a", tab.id, "build");
    s.setTitleFromShell("/repo/a", tab.id, "vim");
    expect(s.tabsFor("/repo/a")[0].title).toBe("build");
  });

  it("notifyOutput appelle le mutation handler après debounce", async () => {
    vi.useFakeTimers();
    const s = useTerminalSessions();
    const cb = vi.fn();
    s.setMutationHandler(cb);
    await s.openTab("/repo/a", "/repo/a", () => {});
    s.notifyOutput("/repo/a");
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(800);
    expect(cb).toHaveBeenCalledWith("/repo/a");
    vi.useRealTimers();
  });

  it("notifyOutput coalesce : appels multiples dans la fenêtre ne déclenchent le handler qu'une fois", async () => {
    vi.useFakeTimers();
    const s = useTerminalSessions();
    const cb = vi.fn();
    s.setMutationHandler(cb);
    await s.openTab("/repo/a", "/repo/a", () => {});
    s.notifyOutput("/repo/a");
    vi.advanceTimersByTime(400);
    // second call resets the debounce window
    s.notifyOutput("/repo/a");
    // 400ms past the second call — not yet at 800ms
    vi.advanceTimersByTime(400);
    expect(cb).not.toHaveBeenCalled();
    // advance past the full 800ms window from the last call
    vi.advanceTimersByTime(401);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith("/repo/a");
    vi.useRealTimers();
  });

  it("disposeRepo ferme toutes les sessions du repo", async () => {
    const s = useTerminalSessions();
    await s.openTab("/repo/b", "/repo/b", () => {});
    await s.openTab("/repo/b", "/repo/b", () => {});
    await s.disposeRepo("/repo/b");
    expect(s.tabsFor("/repo/b")).toHaveLength(0);
    expect(terminalClose).toHaveBeenCalled();
  });

  it("openTab crée un onglet de type 'shell' par défaut", async () => {
    const s = useTerminalSessions();
    const tab = await s.openTab("/repo/a", "/repo/a", () => {});
    expect(tab.type).toBe("shell");
  });

  it("openTab crée un onglet de type 'claude' quand opts.type='claude'", async () => {
    const s = useTerminalSessions();
    const tab = await s.openTab("/repo/a", "/repo/a", () => {}, { type: "claude" });
    expect(tab.type).toBe("claude");
  });

  it("hasUnread est faux à l'ouverture", async () => {
    const s = useTerminalSessions();
    const tab = await s.openTab("/repo/a", "/repo/a", () => {});
    expect(tab.hasUnread).toBe(false);
  });

  it("markRead vide le flag hasUnread", async () => {
    const s = useTerminalSessions();
    const tabA = await s.openTab("/repo/a", "/repo/a", () => {});
    const tabB = await s.openTab("/repo/a", "/repo/a", () => {});
    // tabB is now active; tabA is background
    // Simulate a chunk arriving for tabA (not active)
    simulateChunkForTab("/repo/a", tabA.id);
    expect(tabA.hasUnread).toBe(true);
    s.markRead("/repo/a", tabA.id);
    expect(tabA.hasUnread).toBe(false);
  });
});
