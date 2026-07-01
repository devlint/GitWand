import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/utils/backend", () => ({
  readFile: vi.fn(async (_cwd: string, path: string) => `content of ${path}`),
  writeFile: vi.fn(async () => {}),
}));

import { readFile, writeFile } from "@/utils/backend";
import { useFileExplorer, resolveFileExplorerShortcut } from "../useFileExplorer";

describe("useFileExplorer", () => {
  const REPO_A = "/repo/a";
  const REPO_B = "/repo/b";

  beforeEach(() => {
    vi.clearAllMocks();
    // Each test starts a fresh explorer instance, but the module-level
    // Maps persist across tests (same as useTerminalSessions) — clean up
    // by disposing both repos used in these tests.
    const explorer = useFileExplorer();
    explorer.disposeRepo(REPO_A);
    explorer.disposeRepo(REPO_B);
  });

  it("keeps separate tab lists per repo", async () => {
    const explorer = useFileExplorer();
    await explorer.openTab(REPO_A, REPO_A, "a.ts", true);
    await explorer.openTab(REPO_B, REPO_B, "b.ts", true);

    expect(explorer.tabsFor(REPO_A).map((t) => t.path)).toEqual(["a.ts"]);
    expect(explorer.tabsFor(REPO_B).map((t) => t.path)).toEqual(["b.ts"]);
  });

  it("reuses the single preview tab for non-pinned opens", async () => {
    const explorer = useFileExplorer();
    await explorer.openTab(REPO_A, REPO_A, "a.ts");
    await explorer.openTab(REPO_A, REPO_A, "b.ts");

    expect(explorer.tabsFor(REPO_A).map((t) => t.path)).toEqual(["b.ts"]);
  });

  it("pinning keeps both a preview and a pinned tab open", async () => {
    const explorer = useFileExplorer();
    await explorer.openTab(REPO_A, REPO_A, "a.ts", true);
    await explorer.openTab(REPO_A, REPO_A, "b.ts");

    expect(explorer.tabsFor(REPO_A).map((t) => t.path)).toEqual(["a.ts", "b.ts"]);
  });

  it("derives dirty state from content vs originalContent", async () => {
    const explorer = useFileExplorer();
    const tab = await explorer.openTab(REPO_A, REPO_A, "a.ts", true);
    expect(explorer.isDirty(tab)).toBe(false);

    explorer.updateContent(REPO_A, tab.id, "changed");
    expect(explorer.isDirty(tab)).toBe(true);
  });

  it("saveTab writes content and clears dirty state", async () => {
    const explorer = useFileExplorer();
    const tab = await explorer.openTab(REPO_A, REPO_A, "a.ts", true);
    explorer.updateContent(REPO_A, tab.id, "changed");

    await explorer.saveTab(REPO_A, REPO_A, tab.id);

    expect(writeFile).toHaveBeenCalledWith(REPO_A, "a.ts", "changed");
    expect(explorer.isDirty(tab)).toBe(false);
  });

  it("marks a tab binary when readFile rejects (non-UTF8 content)", async () => {
    (readFile as any).mockRejectedValueOnce(new Error("stream did not contain valid UTF-8"));
    const explorer = useFileExplorer();
    const tab = await explorer.openTab(REPO_A, REPO_A, "image.png", true);

    expect(tab.binary).toBe(true);
    expect(explorer.isDirty(tab)).toBe(false);
  });

  it("closeTab removes the tab and reassigns the active tab", async () => {
    const explorer = useFileExplorer();
    const tabA = await explorer.openTab(REPO_A, REPO_A, "a.ts", true);
    const tabB = await explorer.openTab(REPO_A, REPO_A, "b.ts", true);
    explorer.setActive(REPO_A, tabB.id);

    explorer.closeTab(REPO_A, tabB.id);

    expect(explorer.tabsFor(REPO_A).map((t) => t.path)).toEqual(["a.ts"]);
    expect(explorer.activeTabId(REPO_A)).toBe(tabA.id);
  });
});

describe("resolveFileExplorerShortcut", () => {
  it("returns null when not focused", () => {
    const e = new KeyboardEvent("keydown", { key: "s", metaKey: true });
    expect(resolveFileExplorerShortcut(e, false)).toBeNull();
  });

  it("maps cmd+s to save", () => {
    const e = new KeyboardEvent("keydown", { key: "s", metaKey: true });
    expect(resolveFileExplorerShortcut(e, true)).toBe("save");
  });

  it("maps cmd+w to close", () => {
    const e = new KeyboardEvent("keydown", { key: "w", metaKey: true });
    expect(resolveFileExplorerShortcut(e, true)).toBe("close");
  });

  it("maps cmd+1..9 to switch", () => {
    const e = new KeyboardEvent("keydown", { key: "3", metaKey: true });
    expect(resolveFileExplorerShortcut(e, true)).toEqual({ switch: 2 });
  });
});
