/**
 * The Changes dock entry is retired: the WIP is now a tab glued to the Git
 * Tree entry (viewMode "changes" renders inside the Git Tree view). These pin
 * what an existing user's saved dock order meets after the upgrade.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_DOCK_ORDER, normalizeDockOrder, type DockEntryId } from "../useSettings";

describe("Changes dock entry → Git Tree WIP tab", () => {
  it("is no longer a dock entry", () => {
    expect(DEFAULT_DOCK_ORDER).not.toContain("changes");
  });

  it("drops a stored 'changes' id and keeps the rest of the order", () => {
    const stored = ["changes", "graph", "prs", "dashboard", "launchpad"] as unknown as DockEntryId[];
    expect(normalizeDockOrder(stored)).toEqual(["graph", "prs", "dashboard", "launchpad"]);
  });
});
