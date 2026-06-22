import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkspaceRepoIssues, WorkspaceRepo, Issue } from "../../utils/backend";
import { useLaunchpadPins, _resetPinsForTesting } from "../useLaunchpadPins";

// --- Forge mocks (shared across all describe blocks) ---
// listIssues is the shared mock fn; forgeForRepo routes by cwd substring.
// Azure repos (cwd contains "az") return a provider without listIssues → skipped.
const listIssues = vi.fn();
vi.mock("../forge/useForge", () => ({
  forgeForRepo: vi.fn(async (cwd: string) => {
    if (cwd.includes("az")) return { name: "azure" }; // no listIssues → skipped
    return { name: cwd.includes("gl") ? "gitlab" : "github", listIssues };
  }),
  isForgeConnected: vi.fn(() => true),
}));

import { useLaunchpadIssues } from "../useLaunchpadIssues";

const REPOS: WorkspaceRepo[] = [
  { path: "/repo/a", name: "alpha" },
  { path: "/repo/b", name: "beta" },
];

const MOCK_ISSUE: Issue = {
  number: 7,
  title: "Fix crash on startup",
  state: "OPEN",
  author: "alice",
  assignees: ["bob"],
  labels: ["bug"],
  url: "https://github.com/org/alpha/issues/7",
  createdAt: "2026-03-01T10:00:00Z",
  updatedAt: "2026-03-02T12:00:00Z",
  milestone: "v2.9.0",
};

describe("useLaunchpadIssues", () => {
  beforeEach(() => {
    listIssues.mockReset();
    listIssues.mockResolvedValue([]);
  });

  it("starts with empty repos, loading false, error null", () => {
    const { repos, loading, error } = useLaunchpadIssues();
    expect(repos.value).toEqual([]);
    expect(loading.value).toBe(false);
    expect(error.value).toBeNull();
  });

  it("activeFilter defaults to 'assigned'", () => {
    const { activeFilter } = useLaunchpadIssues();
    expect(activeFilter.value).toBe("assigned");
  });

  it("populates repos after successful refresh", async () => {
    listIssues.mockResolvedValue([MOCK_ISSUE]);
    const { repos, loading, error, refresh, activeFilter } = useLaunchpadIssues();

    await refresh(REPOS);

    expect(repos.value.length).toBeGreaterThan(0);
    const foundIssue = repos.value.some((r) => r.issues.includes(MOCK_ISSUE));
    expect(foundIssue).toBe(true);
    expect(loading.value).toBe(false);
    expect(error.value).toBeNull();
    expect(activeFilter.value).toBe("assigned");
  });

  it("allIssues computed flattens issues with repo context", async () => {
    // Only alpha returns an issue; beta returns nothing
    listIssues.mockImplementation(async (cwd: string) => {
      if (cwd === "/repo/a") return [MOCK_ISSUE];
      return [];
    });
    const { allIssues, refresh } = useLaunchpadIssues();
    await refresh(REPOS);

    expect(allIssues.value.length).toBeGreaterThan(0);
    const alpha = allIssues.value.find((i) => i.repoPath === "/repo/a");
    expect(alpha).toBeDefined();
    expect(alpha!.number).toBe(7);
  });

  it("per-repo errors are captured without setting top-level error", async () => {
    listIssues.mockRejectedValue(new Error("network error"));
    const { error, repos, refresh } = useLaunchpadIssues();
    await refresh(REPOS);

    // Individual repo errors are stored in each WorkspaceRepoIssues entry
    expect(error.value).toBeNull(); // no global throw
    // Repos should still be populated (with error fields)
    expect(repos.value.length).toBeGreaterThan(0);
    const repoWithError = repos.value.find((r) => r.error !== null);
    expect(repoWithError).toBeDefined();
    expect(repoWithError!.error).toBe("network error");
  });

  it("sets loading true during fetch", async () => {
    let resolve!: (v: Issue[]) => void;
    listIssues.mockReturnValue(new Promise((r) => { resolve = r; }));

    const { loading, refresh } = useLaunchpadIssues();
    const p = refresh(REPOS);
    expect(loading.value).toBe(true);
    resolve([]);
    await p;
    expect(loading.value).toBe(false);
  });
});

describe("useLaunchpadIssues — totalCount (union across filters)", () => {
  beforeEach(() => {
    localStorage.clear();
    _resetPinsForTesting();
    listIssues.mockReset();
  });

  function issue(url: string, number: number): Issue {
    return { ...MOCK_ISSUE, number, url };
  }
  const X = "https://github.com/org/alpha/issues/1"; // assigned only
  const Y = "https://github.com/org/alpha/issues/2"; // assigned AND created
  const Z = "https://github.com/org/beta/issues/3"; // mentioned only

  it("counts each issue once even when it matches multiple filters", async () => {
    listIssues.mockImplementation(async (_cwd: string, opts?: { filter?: string }) => {
      const filter = opts?.filter ?? "assigned";
      const map: Record<string, Issue[]> = {
        assigned: [issue(X, 1), issue(Y, 2)],
        mentioned: [issue(Z, 3)],
        created: [issue(Y, 2)], // Y duplicates the assigned one
      };
      return map[filter] ?? [];
    });
    const { totalCount, allIssues, refresh } = useLaunchpadIssues();
    await refresh([{ path: "/repo/a", name: "alpha" }]);

    // Union of {X,Y} ∪ {Z} ∪ {Y} = {X,Y,Z} = 3 — not 4.
    expect(totalCount.value).toBe(3);
    // The visible list still reflects only the active ("assigned") filter.
    expect(allIssues.value).toHaveLength(2);
  });

  it("excludes snoozed issues from totalCount", async () => {
    listIssues.mockImplementation(async (_cwd: string, opts?: { filter?: string }) => {
      const filter = opts?.filter ?? "assigned";
      const map: Record<string, Issue[]> = {
        assigned: [issue(X, 1), issue(Y, 2)],
        mentioned: [issue(Z, 3)],
        created: [issue(Y, 2)],
      };
      return map[filter] ?? [];
    });
    const pins = useLaunchpadPins();
    pins.snooze(Z, "issue", 1);

    const { totalCount, refresh } = useLaunchpadIssues();
    await refresh([{ path: "/repo/a", name: "alpha" }]);

    expect(totalCount.value).toBe(2); // {X,Y}, Z snoozed out
  });
});

describe("useLaunchpadIssues — pin/snooze integration", () => {
  const ISSUE1_URL = "https://github.com/org/alpha/issues/10";
  const ISSUE2_URL = "https://github.com/org/alpha/issues/20";

  const ISSUE1: Issue = {
    ...MOCK_ISSUE,
    number: 10,
    url: ISSUE1_URL,
    updatedAt: "2026-03-01T10:00:00Z", // older
    createdAt: "2026-02-01T10:00:00Z",
  };
  const ISSUE2: Issue = {
    ...MOCK_ISSUE,
    number: 20,
    url: ISSUE2_URL,
    updatedAt: "2026-05-01T10:00:00Z", // newer
    createdAt: "2026-04-01T10:00:00Z",
  };

  // Single-repo list: keeps assertions deterministic (no duplicate entries across repos).
  const SINGLE_REPO: WorkspaceRepo[] = [{ path: "/repo/a", name: "alpha" }];

  beforeEach(() => {
    localStorage.clear();
    _resetPinsForTesting();
    listIssues.mockReset();
    listIssues.mockResolvedValue([ISSUE1, ISSUE2]);
  });

  it("pinned issue appears before non-pinned issue in allIssues", async () => {
    const pins = useLaunchpadPins();
    // Pin ISSUE1 (the older one) — it should jump to the front
    pins.pin(ISSUE1_URL, "issue");

    const { allIssues, refresh } = useLaunchpadIssues();
    await refresh(SINGLE_REPO);

    expect(allIssues.value[0].url).toBe(ISSUE1_URL);
    expect(allIssues.value[1].url).toBe(ISSUE2_URL);
  });

  it("snoozed issue is absent from allIssues and present in snoozedIssues", async () => {
    const pins = useLaunchpadPins();
    pins.snooze(ISSUE1_URL, "issue", 1);

    const { allIssues, snoozedIssues, refresh } = useLaunchpadIssues();
    await refresh(SINGLE_REPO);

    expect(allIssues.value.find((i) => i.url === ISSUE1_URL)).toBeUndefined();
    expect(allIssues.value.find((i) => i.url === ISSUE2_URL)).toBeDefined();
    expect(snoozedIssues.value.find((i) => i.url === ISSUE1_URL)).toBeDefined();
  });

  it("pinned+snoozed issue is absent from allIssues (snooze takes priority)", async () => {
    const pins = useLaunchpadPins();
    pins.pin(ISSUE1_URL, "issue");
    pins.snooze(ISSUE1_URL, "issue", 1);

    const { allIssues, refresh } = useLaunchpadIssues();
    await refresh(SINGLE_REPO);

    expect(allIssues.value.find((i) => i.url === ISSUE1_URL)).toBeUndefined();
  });
});

describe("useLaunchpadIssues multi-forge", () => {
  beforeEach(() => {
    listIssues.mockReset();
    listIssues.mockImplementation(async (cwd: string) => [
      { number: 1, title: `issue ${cwd}`, state: "open", author: "me", assignees: [],
        labels: [], url: `https://x/${cwd}/1`, createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z", milestone: "" },
    ]);
  });

  it("aggregates issues from forges that support listIssues and skips Azure", async () => {
    const li = useLaunchpadIssues();
    await li.refresh([
      { path: "/repo-gh", name: "gh" },
      { path: "/repo-gl", name: "gl" },
      { path: "/repo-az", name: "az" }, // azure → no listIssues → skipped
    ] as any);
    // 2 forges × 3 filters (assigned/mentioned/created) = 6 calls
    expect(listIssues).toHaveBeenCalledTimes(6);
    li.activeFilter.value = "assigned";
    expect(li.allIssues.value.length).toBeGreaterThan(0);
  });
});
