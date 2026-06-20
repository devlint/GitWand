/**
 * LaunchpadView.vue — UI smoke tests (Phase 2 / v2.29 sections rework).
 *
 * Coverage goal:
 *   - inbox tab renders; Team tab toggleable by teamTabEnabled
 *   - NO filter chips, NO group-by toggle (removed in v2.29 sections rework)
 *   - repos section rendered first only when non-empty (local action cards)
 *   - each section from the composable renders as a titled collapsible header
 *   - sections are only rendered when non-empty (count > 0)
 *   - collapsing a section header hides its rows
 *   - action buttons emit open-pr / open-issue
 *   - Refresh-all fans out to all data source refreshes
 *   - Team lazy placeholder renders + Load button triggers refreshTeam
 *
 * We mount with the native `createApp` (no @vue/test-utils dep) into a jsdom
 * container, then assert against the live DOM and spy calls on mocked composables.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createApp, ref, nextTick, type App } from "vue";
import LaunchpadView from "../LaunchpadView.vue";
import type { AppSettings } from "../../composables/useSettings";

// ─── Mocks ────────────────────────────────────────────────

const refreshWipMock = vi.fn(async (_repos: unknown) => {});
const refreshPrsMock = vi.fn(async (_repos: unknown) => {});
const refreshIssuesMock = vi.fn(async (_repos: unknown) => {});
const refreshTeamMock = vi.fn(async (_repos: unknown) => {});
const persistSettingsMock = vi.fn();

const wipRef = ref<unknown[]>([]);
const wipLoadingRef = ref(false);

const allPrsRef = ref<unknown[]>([]);
const prsLoadingRef = ref(false);
const prsErrorRef = ref<string | null>(null);

const allIssuesRef = ref<unknown[]>([]);
const issuesLoadingRef = ref(false);

const teamActivityRef = ref<unknown[]>([]);
const teamLoadingRef = ref(false);
const teamErrorRef = ref<string | null>(null);

// Phase 2 sections-based inbox API.
const inboxTotalRef = ref(0);
const inboxNowCountRef = ref(0);
const sectionsRef = ref<unknown[]>([]);
const loadInboxUserMock = vi.fn(async () => {});

// Reactive AppSettings stand-in — no launchpadFilter / launchpadGroupBy.
const settingsRef = ref<Partial<AppSettings>>({
  launchpadActiveTab: "inbox",
  launchpadTeamTabEnabled: true,
});

vi.mock("../../composables/useSettings", () => ({
  useSettings: () => ({
    settings: settingsRef,
    refreshSettings: vi.fn(),
    loadSettings: () => settingsRef.value,
    saveSettings: persistSettingsMock,
  }),
  saveSettings: (s: AppSettings) => persistSettingsMock(s),
}));

vi.mock("../../composables/useI18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("../../composables/useLaunchpadWip", () => ({
  useLaunchpadWip: () => ({
    wip: wipRef,
    loading: wipLoadingRef,
    refresh: refreshWipMock,
  }),
}));

vi.mock("../../composables/useLaunchpadPrs", () => ({
  useLaunchpadPrs: () => ({
    allPrs: allPrsRef,
    loading: prsLoadingRef,
    error: prsErrorRef,
    refresh: refreshPrsMock,
  }),
}));

vi.mock("../../composables/useLaunchpadIssues", () => ({
  useLaunchpadIssues: () => ({
    allIssues: allIssuesRef,
    loading: issuesLoadingRef,
    refresh: refreshIssuesMock,
  }),
}));

vi.mock("../../composables/useLaunchpadTeam", () => ({
  useLaunchpadTeam: () => ({
    teamActivity: teamActivityRef,
    loading: teamLoadingRef,
    error: teamErrorRef,
    refresh: refreshTeamMock,
  }),
}));

vi.mock("../../composables/useLaunchpadInbox", () => ({
  useLaunchpadInbox: () => ({
    totalCount: inboxTotalRef,
    nowCount: inboxNowCountRef,
    sections: sectionsRef,
    allItems: ref([]),
    loadUser: loadInboxUserMock,
  }),
}));

// ─── Helpers ──────────────────────────────────────────────

interface MountResult {
  app: App;
  container: HTMLDivElement;
  emitted: { close: number; openPr: unknown[]; openIssue: unknown[] };
}

function mountLaunchpad(repos: { path: string; name: string }[] = []): MountResult {
  const container = document.createElement("div");
  document.body.appendChild(container);

  const emitted = { close: 0, openPr: [] as unknown[], openIssue: [] as unknown[] };

  const app = createApp(LaunchpadView, {
    repos,
    onClose: () => {
      emitted.close += 1;
    },
    onOpenPr: (pr: unknown) => {
      emitted.openPr.push(pr);
    },
    onOpenIssue: (issue: unknown) => {
      emitted.openIssue.push(issue);
    },
  });
  app.mount(container);

  return { app, container, emitted };
}

function fakeIssue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 21,
    title: "Sample issue",
    state: "OPEN",
    author: "octocat",
    assignees: [],
    labels: [],
    url: "https://github.com/org/repo/issues/21",
    createdAt: "2026-06-01T10:00:00Z",
    updatedAt: "2026-06-01T10:00:00Z",
    milestone: "",
    repoName: "repo",
    repoPath: "/tmp/repo",
    ...overrides,
  };
}

function unmount({ app, container }: MountResult): void {
  app.unmount();
  if (container.parentNode) container.parentNode.removeChild(container);
}

function fakePr(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 42,
    title: "Sample PR",
    state: "OPEN",
    author: "octocat",
    branch: "feature/x",
    base: "main",
    draft: false,
    createdAt: "2026-05-12T10:00:00Z",
    updatedAt: "2026-05-12T10:00:00Z",
    url: "https://github.com/org/repo/pull/42",
    additions: 0,
    deletions: 0,
    labels: [],
    assignees: [],
    reviewRequested: [],
    reviewDecision: "",
    mergeStateStatus: "",
    checksRollup: "",
    repoName: "repo",
    repoPath: "/tmp/repo",
    ...overrides,
  };
}

// ─── Lifecycle ────────────────────────────────────────────

beforeEach(() => {
  wipRef.value = [];
  wipLoadingRef.value = false;
  allPrsRef.value = [];
  prsLoadingRef.value = false;
  prsErrorRef.value = null;
  allIssuesRef.value = [];
  issuesLoadingRef.value = false;
  teamActivityRef.value = [];
  teamLoadingRef.value = false;
  teamErrorRef.value = null;
  inboxTotalRef.value = 0;
  inboxNowCountRef.value = 0;
  sectionsRef.value = [];
  settingsRef.value = {
    launchpadActiveTab: "inbox",
    launchpadTeamTabEnabled: true,
  };
});

afterEach(() => {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
});

// ─── Tests ────────────────────────────────────────────────

describe("LaunchpadView — tab bar", () => {
  it("renders 2 tabs when teamTabEnabled is true (inbox + team)", async () => {
    const mounted = mountLaunchpad();
    await nextTick();

    const tabs = mounted.container.querySelectorAll(".launchpad-view__tab");
    expect(tabs).toHaveLength(2);
    const labels = Array.from(tabs).map((t) => t.textContent?.trim() ?? "");
    expect(labels[0]).toContain("launchpad.inboxTab");
    expect(labels[1]).toContain("launchpad.teamTab");

    unmount(mounted);
  });

  it("renders only 1 tab when teamTabEnabled is false", async () => {
    settingsRef.value.launchpadTeamTabEnabled = false;
    const mounted = mountLaunchpad();
    await nextTick();

    const tabs = mounted.container.querySelectorAll(".launchpad-view__tab");
    expect(tabs).toHaveLength(1);
    expect(tabs[0].textContent).toContain("launchpad.inboxTab");

    unmount(mounted);
  });

  it("does NOT render filter chips (removed in sections rework)", async () => {
    const mounted = mountLaunchpad();
    await nextTick();

    // Filter chips were removed — the CSS class must not appear.
    const chips = mounted.container.querySelectorAll(".launchpad-view__chip-btn");
    expect(chips).toHaveLength(0);

    unmount(mounted);
  });

  it("does NOT render group-by toggle (removed in sections rework)", async () => {
    const mounted = mountLaunchpad();
    await nextTick();

    const groupBtns = mounted.container.querySelectorAll(".launchpad-view__groupby-btn");
    expect(groupBtns).toHaveLength(0);

    unmount(mounted);
  });
});

describe("LaunchpadView — sections inbox rendering", () => {
  function sectionsFixture() {
    return [
      {
        key: "mine",
        titleKey: "launchpad.section.mine",
        count: 2,
        items: [
          {
            pr: fakePr({ number: 42, reviewDecision: "APPROVED" }),
            classification: { tier: "now", case: "merge", action: "merge", kind: "pr" },
          },
          {
            pr: fakePr({ number: 43, mergeStateStatus: "DIRTY" }),
            classification: { tier: "now", case: "conflicts", action: "resolve", kind: "pr" },
          },
        ],
      },
      {
        key: "review",
        titleKey: "launchpad.section.review",
        count: 1,
        items: [
          {
            pr: fakePr({ number: 44 }),
            classification: { tier: "now", case: "review", action: "review", kind: "pr" },
          },
        ],
      },
    ];
  }

  it("renders section headers with titles and counts", async () => {
    settingsRef.value.launchpadActiveTab = "inbox";
    sectionsRef.value = sectionsFixture();
    inboxTotalRef.value = 3;
    inboxNowCountRef.value = 2;

    const mounted = mountLaunchpad();
    await nextTick();

    // Summary line present.
    const summary = mounted.container.querySelector(".launchpad-view__inbox-summary");
    expect(summary?.textContent).toContain("launchpad.inboxSummary");

    // Two section headers (no local-cards band: wip is empty).
    const headers = mounted.container.querySelectorAll(".launchpad-view__inbox-header");
    expect(headers).toHaveLength(2);
    expect(headers[0].textContent).toContain("launchpad.section.mine");
    expect(headers[0].textContent).toContain("2");
    expect(headers[1].textContent).toContain("launchpad.section.review");
    expect(headers[1].textContent).toContain("1");

    // One action button per item.
    const actions = mounted.container.querySelectorAll(".launchpad-view__pr-action");
    expect(actions).toHaveLength(3);
    const labels = Array.from(actions).map((a) => a.textContent?.trim() ?? "");
    expect(labels[0]).toContain("launchpad.action.merge");
    expect(labels[1]).toContain("launchpad.action.resolve");
    expect(labels[2]).toContain("launchpad.action.review");

    unmount(mounted);
  });

  it("renders sections with all 6 section keys when provided", async () => {
    settingsRef.value.launchpadActiveTab = "inbox";
    sectionsRef.value = [
      { key: "mine",     titleKey: "launchpad.section.mine",     count: 1, items: [{ pr: fakePr({ number: 1 }),  classification: { tier: "now", case: "merge",  action: "merge",  kind: "pr"    } }] },
      { key: "assigned", titleKey: "launchpad.section.assigned", count: 1, items: [{ pr: fakePr({ number: 2 }),  classification: { tier: "now", case: "review", action: "view",   kind: "pr"    } }] },
      { key: "review",   titleKey: "launchpad.section.review",   count: 1, items: [{ pr: fakePr({ number: 3 }),  classification: { tier: "now", case: "review", action: "review", kind: "pr"    } }] },
      { key: "issues",   titleKey: "launchpad.section.issues",   count: 1, items: [{ issue: fakeIssue({ number: 4 }), classification: { tier: "now", case: "issue",  action: "view",   kind: "issue" } }] },
      { key: "deps",     titleKey: "launchpad.section.deps",     count: 1, items: [{ pr: fakePr({ number: 5 }),  classification: { tier: "later", case: "merge", action: "autoMerge", kind: "dep" } }] },
    ];
    inboxTotalRef.value = 5;

    const mounted = mountLaunchpad();
    await nextTick();

    const headers = mounted.container.querySelectorAll(".launchpad-view__inbox-header");
    // 5 sections = 5 headers (repos section absent because wip is empty).
    expect(headers).toHaveLength(5);
    const headerTexts = Array.from(headers).map((h) => h.textContent ?? "");
    expect(headerTexts[0]).toContain("launchpad.section.mine");
    expect(headerTexts[1]).toContain("launchpad.section.assigned");
    expect(headerTexts[2]).toContain("launchpad.section.review");
    expect(headerTexts[3]).toContain("launchpad.section.issues");
    expect(headerTexts[4]).toContain("launchpad.section.deps");

    unmount(mounted);
  });

  it("does NOT render a section header when sections array is empty", async () => {
    settingsRef.value.launchpadActiveTab = "inbox";
    sectionsRef.value = [];
    inboxTotalRef.value = 0;

    const mounted = mountLaunchpad();
    await nextTick();

    const headers = mounted.container.querySelectorAll(".launchpad-view__inbox-header");
    expect(headers).toHaveLength(0);

    unmount(mounted);
  });

  it("emits open-pr when a section action button is clicked", async () => {
    settingsRef.value.launchpadActiveTab = "inbox";
    sectionsRef.value = sectionsFixture();
    inboxTotalRef.value = 3;
    inboxNowCountRef.value = 2;

    const mounted = mountLaunchpad();
    await nextTick();

    const action = mounted.container.querySelector<HTMLButtonElement>(".launchpad-view__pr-action");
    expect(action).not.toBeNull();
    action!.click();
    await nextTick();

    expect(mounted.emitted.openPr).toHaveLength(1);
    expect((mounted.emitted.openPr[0] as { number: number }).number).toBe(42);

    unmount(mounted);
  });

  it("collapses a section when its header is clicked", async () => {
    settingsRef.value.launchpadActiveTab = "inbox";
    sectionsRef.value = sectionsFixture();
    inboxTotalRef.value = 3;
    inboxNowCountRef.value = 2;

    const mounted = mountLaunchpad();
    await nextTick();

    // Both sections expanded: 3 action buttons visible.
    expect(mounted.container.querySelectorAll(".launchpad-view__pr-action")).toHaveLength(3);

    const firstHeader = mounted.container.querySelector<HTMLButtonElement>(".launchpad-view__inbox-header");
    firstHeader!.click();
    await nextTick();

    // Collapsing "mine" removes its 2 rows; the "review" row remains.
    expect(mounted.container.querySelectorAll(".launchpad-view__pr-action")).toHaveLength(1);

    unmount(mounted);
  });

  it("renders issue items with open-issue emit", async () => {
    settingsRef.value.launchpadActiveTab = "inbox";
    sectionsRef.value = [
      {
        key: "issues",
        titleKey: "launchpad.section.issues",
        count: 1,
        items: [
          {
            issue: fakeIssue({ number: 21 }),
            classification: { tier: "now", case: "issue", action: "view", kind: "issue" },
          },
        ],
      },
    ];
    inboxTotalRef.value = 1;
    inboxNowCountRef.value = 1;

    const mounted = mountLaunchpad();
    await nextTick();

    const action = mounted.container.querySelector<HTMLButtonElement>(".launchpad-view__pr-action");
    expect(action).not.toBeNull();
    expect(action!.textContent?.trim()).toContain("launchpad.action.view");
    action!.click();
    await nextTick();

    expect(mounted.emitted.openIssue).toHaveLength(1);
    expect((mounted.emitted.openIssue[0] as { number: number }).number).toBe(21);

    unmount(mounted);
  });

  it("repos section renders first when local cards (wip) are non-empty", async () => {
    settingsRef.value.launchpadActiveTab = "inbox";
    // Provide a valid WorkspaceWipItem with ahead > 0 so useRepoActionCards generates a card.
    wipRef.value = [{
      path: "/tmp/myrepo",
      name: "myrepo",
      branch: "main",
      ahead: 2,
      behind: 0,
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      lastCommitAt: "2026-06-01T10:00:00Z",
      hasNoUpstream: false,
      error: null,
      changedFiles: [],
    }];
    sectionsRef.value = [
      {
        key: "mine",
        titleKey: "launchpad.section.mine",
        count: 1,
        items: [{ pr: fakePr({ number: 10 }), classification: { tier: "now", case: "merge", action: "merge", kind: "pr" } }],
      },
    ];
    inboxTotalRef.value = 1;

    const mounted = mountLaunchpad();
    await nextTick();

    const headers = mounted.container.querySelectorAll(".launchpad-view__inbox-header");
    // repos section first, then mine section.
    expect(headers).toHaveLength(2);
    expect(headers[0].textContent).toContain("launchpad.section.repos");
    expect(headers[1].textContent).toContain("launchpad.section.mine");

    unmount(mounted);
  });

  it("assigned section action is 'view'", async () => {
    settingsRef.value.launchpadActiveTab = "inbox";
    sectionsRef.value = [
      {
        key: "assigned",
        titleKey: "launchpad.section.assigned",
        count: 1,
        items: [
          {
            pr: fakePr({ number: 55 }),
            classification: { tier: "now", case: "review", action: "view", kind: "pr" },
          },
        ],
      },
    ];
    inboxTotalRef.value = 1;

    const mounted = mountLaunchpad();
    await nextTick();

    const action = mounted.container.querySelector<HTMLButtonElement>(".launchpad-view__pr-action");
    expect(action).not.toBeNull();
    expect(action!.textContent?.trim()).toContain("launchpad.action.view");

    unmount(mounted);
  });
});

describe("LaunchpadView — Team surface", () => {
  it("Team tab triggers refreshTeam on first visit", async () => {
    const mounted = mountLaunchpad();
    await nextTick();

    const tabs = mounted.container.querySelectorAll<HTMLButtonElement>(".launchpad-view__tab");
    refreshTeamMock.mockClear();
    tabs[1].click();
    await nextTick();

    expect(refreshTeamMock).toHaveBeenCalledTimes(1);

    unmount(mounted);
  });

  it("clicking a Team PR emits open-pr", async () => {
    const teamPr = fakePr({ number: 99, repoPath: "/tmp/other", repoName: "other" });
    teamActivityRef.value = [
      {
        login: "octocat",
        prs: [teamPr],
        overlappingPrs: [{ ...teamPr, overlappingFiles: ["src/a.ts"], myContext: "wip" }],
      },
    ];
    settingsRef.value.launchpadActiveTab = "team";
    const mounted = mountLaunchpad();
    await nextTick();
    await nextTick();

    const link = mounted.container.querySelector<HTMLButtonElement>(".launchpad-view__team-pr-link");
    expect(link).not.toBeNull();
    link!.click();
    await nextTick();

    expect(mounted.emitted.openPr).toHaveLength(1);
    expect((mounted.emitted.openPr[0] as { number: number }).number).toBe(99);

    unmount(mounted);
  });
});

describe("LaunchpadView — Refresh-all", () => {
  it("Refresh-all button fires all data source refreshes (WIP / PRs / Issues / Team)", async () => {
    const mounted = mountLaunchpad([{ path: "/tmp/r1", name: "r1" }]);
    await nextTick();

    refreshWipMock.mockClear();
    refreshPrsMock.mockClear();
    refreshIssuesMock.mockClear();
    refreshTeamMock.mockClear();

    const refreshAllBtn = mounted.container.querySelector<HTMLButtonElement>(
      ".launchpad-view__refresh--all",
    );
    expect(refreshAllBtn).not.toBeNull();
    refreshAllBtn!.click();
    await nextTick();
    await nextTick();

    expect(refreshWipMock).toHaveBeenCalledTimes(1);
    expect(refreshPrsMock).toHaveBeenCalledTimes(1);
    expect(refreshIssuesMock).toHaveBeenCalledTimes(1);
    expect(refreshTeamMock).toHaveBeenCalledTimes(1);

    unmount(mounted);
  });
});

describe("LaunchpadView — onMounted eager refresh", () => {
  it("eager onMounted refreshes wip / prs / issues with the supplied repos", async () => {
    refreshWipMock.mockClear();
    refreshPrsMock.mockClear();
    refreshIssuesMock.mockClear();

    const repos = [{ path: "/tmp/a", name: "a" }];
    const mounted = mountLaunchpad(repos);
    await nextTick();

    expect(refreshWipMock).toHaveBeenCalledTimes(1);
    expect(refreshWipMock).toHaveBeenCalledWith(repos);
    expect(refreshPrsMock).toHaveBeenCalledTimes(1);
    expect(refreshIssuesMock).toHaveBeenCalledTimes(1);
    // Team must NOT auto-fetch on mount (lazy contract).
    expect(refreshTeamMock).not.toHaveBeenCalled();

    unmount(mounted);
  });
});
