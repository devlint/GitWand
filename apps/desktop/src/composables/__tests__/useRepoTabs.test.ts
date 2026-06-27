import { describe, it, expect, beforeEach } from "vitest";
import { useRepoTabs } from "../useRepoTabs";

describe("useRepoTabs.selectWorktree", () => {
  beforeEach(() => {
    // Reset the singleton: close every open tab.
    const { tabs, closeTab } = useRepoTabs();
    for (const t of [...tabs.value]) closeTab(t.id);
  });

  it("switches the active checkout in place without opening a tab", () => {
    const { openTab, selectWorktree, activeRepoPath, tabs } = useRepoTabs();
    const project = openTab("/repos/myrepo");

    selectWorktree(project.id, "/repos/gitwand-scratch-1");

    expect(activeRepoPath.value).toBe("/repos/gitwand-scratch-1");
    // No new tab — the project is still the only chip.
    expect(tabs.value.map((t) => t.path)).toEqual(["/repos/myrepo"]);
  });

  it("clears the selection (back to main) when the project path is chosen", () => {
    const { openTab, selectWorktree, activeRepoPath } = useRepoTabs();
    const project = openTab("/repos/myrepo");

    selectWorktree(project.id, "/repos/gitwand-scratch-1");
    selectWorktree(project.id, "/repos/myrepo");

    expect(activeRepoPath.value).toBe("/repos/myrepo");
  });

  it("activeRepoPath follows the selection of whichever tab is active", () => {
    const { openTab, selectWorktree, switchTab, activeRepoPath } = useRepoTabs();
    const a = openTab("/repos/a");
    const b = openTab("/repos/b");

    selectWorktree(a.id, "/repos/a-scratch");
    // b is active and has no selection → its own path.
    expect(activeRepoPath.value).toBe("/repos/b");

    switchTab(a.id);
    expect(activeRepoPath.value).toBe("/repos/a-scratch");
  });

  it("drops the selection when the tab is closed", () => {
    const { openTab, selectWorktree, closeTab, activeRepoPath } = useRepoTabs();
    const project = openTab("/repos/myrepo");
    selectWorktree(project.id, "/repos/gitwand-scratch-1");

    closeTab(project.id);

    expect(activeRepoPath.value).toBeNull();
  });
});
