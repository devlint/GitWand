/**
 * Today (Launchpad) must stay silent about Cursor Origin repos.
 *
 * `isForgeConnected()` returns false for any forge without an in-app account,
 * so an Origin repo would land in `needsConnection` and render the banner
 * "Connect your Cursor Origin account to see its pull requests and issues".
 * That is a lie: there is no Origin account to connect, and connecting one
 * would change nothing while the provider has no PR integration.
 *
 * Origin repos must therefore be dropped before the connection check, without
 * firing a forge call.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { _resetPinsForTesting } from "../useLaunchpadPins";

const listPRs = vi.fn();
const listIssues = vi.fn();
vi.mock("../forge/useForge", () => ({
  forgeForRepo: vi.fn(async (cwd: string) => ({
    name: cwd.includes("cursor") ? "cursor" : "github",
    listPRs,
    listIssues,
  })),
  // Mirrors production: only GitHub is connected without an explicit account.
  isForgeConnected: vi.fn((forge: string) => forge === "github"),
}));

import { useLaunchpadPrs } from "../useLaunchpadPrs";
import { useLaunchpadIssues } from "../useLaunchpadIssues";

const PR = {
  number: 1, title: "PR", state: "open", author: "me", branch: "f", base: "main",
  draft: false, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  url: "https://x/1", additions: 0, deletions: 0, labels: [], assignees: [],
  reviewRequested: [], reviewDecision: "", mergeStateStatus: "", checksRollup: "",
  commentCount: 0,
};

describe("Today — Cursor Origin repos", () => {
  beforeEach(() => {
    localStorage.clear();
    _resetPinsForTesting();
    listPRs.mockReset();
    listIssues.mockReset();
    listPRs.mockImplementation(async () => [PR]);
    listIssues.mockImplementation(async () => []);
  });

  it("never asks the user to connect a Cursor Origin account", async () => {
    const lp = useLaunchpadPrs();
    await lp.refresh([
      { path: "/repo-gh", name: "gh" },
      { path: "/repo-cursor", name: "origin-repo" },
    ] as any);

    expect(lp.needsConnection.value).not.toContain("cursor");
  });

  it("does not fire a forge call for a Cursor Origin repo", async () => {
    const lp = useLaunchpadPrs();
    await lp.refresh([
      { path: "/repo-gh", name: "gh" },
      { path: "/repo-cursor", name: "origin-repo" },
    ] as any);

    // Only the GitHub repo is fetched.
    expect(listPRs).toHaveBeenCalledTimes(1);
    expect(lp.allPrs.value).toHaveLength(1);
  });

  it("applies the same rule to the issues inbox", async () => {
    const li = useLaunchpadIssues();
    await li.refresh([
      { path: "/repo-gh", name: "gh" },
      { path: "/repo-cursor", name: "origin-repo" },
    ] as any);

    expect(li.needsConnection.value).not.toContain("cursor");
  });
});
