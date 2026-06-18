import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkspaceRepoIssues, WorkspaceRepo, Issue } from "../../utils/backend";
import { useLaunchpadPins, _resetPinsForTesting } from "../useLaunchpadPins";

vi.mock("../../utils/backend", () => ({
  workspaceIssuesAll: vi.fn(),
}));

import { workspaceIssuesAll } from "../../utils/backend";
import { useLaunchpadIssues } from "../useLaunchpadIssues";

const mockFetch = vi.mocked(workspaceIssuesAll);

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

const MOCK_DATA: WorkspaceRepoIssues[] = [
  { repoPath: "/repo/a", repoName: "alpha", issues: [MOCK_ISSUE], filter: "assigned", error: null },
  { repoPath: "/repo/b", repoName: "beta", issues: [], filter: "assigned", error: null },
];

describe("useLaunchpadIssues", () => {
  beforeEach(() => { mockFetch.mockReset(); });

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
    mockFetch.mockResolvedValue(MOCK_DATA);
    const { repos, loading, error, refresh, activeFilter } = useLaunchpadIssues();

    await refresh(REPOS);

    expect(mockFetch).toHaveBeenCalledWith(REPOS, activeFilter.value);
    expect(repos.value).toEqual(MOCK_DATA);
    expect(loading.value).toBe(false);
    expect(error.value).toBeNull();
  });

  it("allIssues computed flattens issues with repo context", async () => {
    mockFetch.mockResolvedValue(MOCK_DATA);
    const { allIssues, refresh } = useLaunchpadIssues();
    await refresh(REPOS);

    expect(allIssues.value).toHaveLength(1); // only alpha has an issue
    expect(allIssues.value[0].repoName).toBe("alpha");
    expect(allIssues.value[0].number).toBe(7);
  });

  it("sets error and keeps previous repos when workspaceIssuesAll throws", async () => {
    mockFetch.mockResolvedValue(MOCK_DATA);
    const { repos, error, refresh } = useLaunchpadIssues();
    await refresh(REPOS);

    mockFetch.mockRejectedValue(new Error("network error"));
    await refresh(REPOS);

    expect(error.value).toBe("network error");
    expect(repos.value).toEqual(MOCK_DATA); // preserved
  });

  it("sets loading true during fetch", async () => {
    let resolve!: (v: WorkspaceRepoIssues[]) => void;
    mockFetch.mockReturnValue(new Promise(r => { resolve = r; }));

    const { loading, refresh } = useLaunchpadIssues();
    const p = refresh(REPOS);
    expect(loading.value).toBe(true);
    resolve(MOCK_DATA);
    await p;
    expect(loading.value).toBe(false);
  });
});

describe("useLaunchpadIssues — totalCount (union across filters)", () => {
  beforeEach(() => {
    localStorage.clear();
    _resetPinsForTesting();
    mockFetch.mockReset();
  });

  function issue(url: string, number: number): Issue {
    return { ...MOCK_ISSUE, number, url };
  }
  const X = "https://github.com/org/alpha/issues/1"; // assigned only
  const Y = "https://github.com/org/alpha/issues/2"; // assigned AND created
  const Z = "https://github.com/org/beta/issues/3"; // mentioned only

  function perFilter(filter: string): WorkspaceRepoIssues[] {
    const map: Record<string, Issue[]> = {
      assigned: [issue(X, 1), issue(Y, 2)],
      mentioned: [issue(Z, 3)],
      created: [issue(Y, 2)], // Y duplicates the assigned one
    };
    return [
      { repoPath: "/repo/a", repoName: "alpha", issues: map[filter] ?? [], filter, error: null },
    ];
  }

  it("counts each issue once even when it matches multiple filters", async () => {
    mockFetch.mockImplementation(async (_repos: WorkspaceRepo[], filter?: string) =>
      perFilter(filter ?? "assigned")
    );
    const { totalCount, allIssues, refresh } = useLaunchpadIssues();
    await refresh(REPOS);

    // Union of {X,Y} ∪ {Z} ∪ {Y} = {X,Y,Z} = 3 — not 4.
    expect(totalCount.value).toBe(3);
    // The visible list still reflects only the active ("assigned") filter.
    expect(allIssues.value).toHaveLength(2);
  });

  it("excludes snoozed issues from totalCount", async () => {
    mockFetch.mockImplementation(async (_repos: WorkspaceRepo[], filter?: string) =>
      perFilter(filter ?? "assigned")
    );
    const pins = useLaunchpadPins();
    pins.snooze(Z, "issue", 1);

    const { totalCount, refresh } = useLaunchpadIssues();
    await refresh(REPOS);

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
  const DATA_TWO: WorkspaceRepoIssues[] = [
    { repoPath: "/repo/a", repoName: "alpha", issues: [ISSUE1, ISSUE2], filter: "assigned", error: null },
  ];

  beforeEach(() => {
    localStorage.clear();
    _resetPinsForTesting();
    mockFetch.mockReset();
  });

  it("pinned issue appears before non-pinned issue in allIssues", async () => {
    mockFetch.mockResolvedValue(DATA_TWO);
    const pins = useLaunchpadPins();
    // Pin ISSUE1 (the older one) — it should jump to the front
    pins.pin(ISSUE1_URL, "issue");

    const { allIssues, refresh } = useLaunchpadIssues();
    await refresh(REPOS);

    expect(allIssues.value[0].url).toBe(ISSUE1_URL);
    expect(allIssues.value[1].url).toBe(ISSUE2_URL);
  });

  it("snoozed issue is absent from allIssues and present in snoozedIssues", async () => {
    mockFetch.mockResolvedValue(DATA_TWO);
    const pins = useLaunchpadPins();
    pins.snooze(ISSUE1_URL, "issue", 1);

    const { allIssues, snoozedIssues, refresh } = useLaunchpadIssues();
    await refresh(REPOS);

    expect(allIssues.value.find((i) => i.url === ISSUE1_URL)).toBeUndefined();
    expect(allIssues.value.find((i) => i.url === ISSUE2_URL)).toBeDefined();
    expect(snoozedIssues.value.find((i) => i.url === ISSUE1_URL)).toBeDefined();
  });

  it("pinned+snoozed issue is absent from allIssues (snooze takes priority)", async () => {
    mockFetch.mockResolvedValue(DATA_TWO);
    const pins = useLaunchpadPins();
    pins.pin(ISSUE1_URL, "issue");
    pins.snooze(ISSUE1_URL, "issue", 1);

    const { allIssues, refresh } = useLaunchpadIssues();
    await refresh(REPOS);

    expect(allIssues.value.find((i) => i.url === ISSUE1_URL)).toBeUndefined();
  });
});
