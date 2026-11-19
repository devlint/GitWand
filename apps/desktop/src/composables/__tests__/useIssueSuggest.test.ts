/**
 * useIssueSuggest (#301, part 4): `#` in a commit field lists open issues.
 */
import { describe, it, expect, vi } from "vitest";
import type { Issue } from "../../utils/backend";
import { useIssueSuggest, createIssueCache, invalidateIssues, ISSUE_CACHE_TTL_MS, ISSUE_CACHE_MAX_REPOS, type IssueSuggestDeps } from "../useIssueSuggest";
import type { Issue as I } from "../../utils/backend";

function issue(number: number, title: string, updatedAt = "2026-11-10T00:00:00Z", repo = "me/app"): Issue {
  return { number, title, state: "OPEN", author: "a", assignees: [], labels: [], url: `https://github.com/${repo}/issues/${number}`, createdAt: updatedAt, updatedAt, milestone: "" };
}
const ISSUES = [issue(42, "Login fails"), issue(57, "Logout cache", "2026-11-12T00:00:00Z")];
const flush = async () => { for (let i = 0; i < 3; i++) await Promise.resolve(); };
const key = (k: string, extra: Partial<KeyboardEvent> = {}) => ({ key: k, shiftKey: false, isComposing: false, ...extra }) as KeyboardEvent;

function setup(over: Partial<IssueSuggestDeps> = {}) {
  let t = 1_000;
  let cwd: string | null = "/r";
  const loadIssues = vi.fn(async (_c: string) => ISSUES);
  const deps: IssueSuggestDeps = {
    cwd: () => cwd,
    loadIssues,
    pushRepo: () => "me/app",
    now: () => t,
    ...over,
  };
  const s = useIssueSuggest(deps);
  return { s, loadIssues: (over.loadIssues as typeof loadIssues) ?? loadIssues, advance: (ms: number) => { t += ms; }, setCwd: (c: string) => { cwd = c; } };
}

describe("useIssueSuggest", () => {
  it("fetches nothing until a # opens the list", () => {
    const { s, loadIssues } = setup();
    s.update("abc", 3);
    expect(loadIssues).not.toHaveBeenCalled();
    expect(s.open.value).toBe(false);
  });

  it("shows loading, then rows filtered by the query", async () => {
    const { s } = setup();
    s.update("fix #", 5);
    expect(s.open.value).toBe(true);
    expect(s.status.value).toBe("loading");
    await flush();
    expect(s.status.value).toBe("ready");
    expect(s.rows.value.map((i) => i.number)).toEqual([57, 42]);
    s.update("fix #4", 6);
    expect(s.rows.value.map((i) => i.number)).toEqual([42]);
  });

  it("fetches once, then again after 60 s", async () => {
    const { s, loadIssues, advance } = setup();
    s.update("#", 1);
    await flush();
    s.close();
    s.update("#", 1);
    await flush();
    expect(loadIssues).toHaveBeenCalledTimes(1);
    advance(ISSUE_CACHE_TTL_MS + 1);
    s.update("#", 1);
    await flush();
    expect(loadIssues).toHaveBeenCalledTimes(2);
  });

  it("shows error and keeps the text on failure", async () => {
    const { s } = setup({ loadIssues: vi.fn(async () => { throw new Error("offline"); }) });
    s.update("#", 1);
    await flush();
    expect(s.status.value).toBe("error");
    expect(s.rows.value).toEqual([]);
    expect(s.keydown(key("Enter"), "#")).toBeNull();
  });

  it("no list when the forge cannot list issues", () => {
    const { s } = setup({ loadIssues: vi.fn(() => null) });
    s.update("#", 1);
    expect(s.open.value).toBe(false);
  });

  it("Enter inserts #N, Shift+Enter Fixes #N, Tab like Enter", async () => {
    const { s } = setup();
    s.update("fix #lo", 7);
    await flush();
    s.keydown(key("ArrowDown"), "fix #lo");
    expect(s.keydown(key("Enter"), "fix #lo")).toEqual({ text: "fix #57 ", caret: 8 });
    expect(s.open.value).toBe(false);
    s.update("#lo", 3);
    s.keydown(key("ArrowDown"), "#lo");
    expect(s.keydown(key("Enter", { shiftKey: true }), "#lo")).toEqual({ text: "Fixes #57 ", caret: 10 });
    s.update("#lo", 3);
    s.keydown(key("ArrowDown"), "#lo");
    expect(s.keydown(key("Tab"), "#lo")).toEqual({ text: "#57 ", caret: 4 });
  });

  it("arrows move the active row and wrap; the first one highlights the top row", async () => {
    const { s } = setup();
    s.update("#lo", 3);
    await flush();
    expect(s.keydown(key("ArrowDown"), "#lo")).toBe("handled");
    expect(s.active.value).toBe(0);
    expect(s.keydown(key("ArrowDown"), "#lo")).toBe("handled");
    expect(s.active.value).toBe(1);
    expect(s.keydown(key("ArrowDown"), "#lo")).toBe("handled");
    expect(s.active.value).toBe(0);
    expect(s.keydown(key("ArrowUp"), "#lo")).toBe("handled");
    expect(s.active.value).toBe(1);
    expect(s.keydown(key("Enter"), "#lo")).toEqual({ text: "#42 ", caret: 4 });
  });

  it("a refresh that reorders the rows keeps the chosen issue, or drops the choice", async () => {
    const cache = createIssueCache();
    let t = 0;
    const loadIssues = vi.fn().mockResolvedValueOnce(ISSUES).mockResolvedValueOnce([issue(99, "Login new", "2026-11-20T00:00:00Z"), ...ISSUES]);
    const s = useIssueSuggest({ cwd: () => "/r", loadIssues, pushRepo: () => "me/app", cache, now: () => t });
    s.update("#Lo", 3);
    await flush();
    s.keydown(key("ArrowDown"), "#Lo");
    s.keydown(key("ArrowDown"), "#Lo"); // #42 (row 1)
    t += ISSUE_CACHE_TTL_MS + 1;
    invalidateIssues(cache, { cwd: "/r" });
    await flush();
    expect(s.rows.value.map((i) => i.number)).toEqual([99, 57, 42]);
    expect(s.keydown(key("Enter"), "#Lo")).toEqual({ text: "#42 ", caret: 4 });
  });

  it("a first ArrowUp highlights the bottom row", async () => {
    const { s } = setup();
    s.update("#lo", 3);
    await flush();
    s.keydown(key("ArrowUp"), "#lo");
    expect(s.active.value).toBe(1);
  });

  it("a typed number leaves the arrows to the text (moving to another line)", async () => {
    const { s } = setup();
    s.update("Fixes #42", 9);
    await flush();
    expect(s.keydown(key("ArrowDown"), "Fixes #42")).toBeNull();
  });

  it("a closed list forgets a missed #: retry later does not open it", () => {
    let known = false;
    const { s } = setup({ loadIssues: vi.fn(() => (known ? Promise.resolve(ISSUES) : null)) });
    s.update("#", 1);
    s.close();
    known = true;
    s.retry("#", 1);
    expect(s.open.value).toBe(false);
  });

  it("an entry dropped while the list is open is fetched again", async () => {
    const cache = createIssueCache();
    const loadIssues = vi.fn(async () => ISSUES);
    const s = useIssueSuggest({ cwd: () => "/r", loadIssues, pushRepo: () => "me/app", cache });
    s.update("#lo", 3);
    await flush();
    invalidateIssues(cache, { cwd: "/r" });
    await flush();
    expect(loadIssues).toHaveBeenCalledTimes(2);
    expect(s.status.value).toBe("ready");
  });

  it("Escape closes and is handled, even with no row", () => {
    const { s } = setup();
    s.update("#", 1);
    expect(s.keydown(key("Escape"), "#")).toBe("handled");
    expect(s.open.value).toBe(false);
    expect(s.keydown(key("Escape"), "#")).toBeNull();
  });

  it("ignores Enter while composing (IME)", async () => {
    const { s } = setup();
    s.update("#", 1);
    await flush();
    expect(s.keydown(key("Enter", { isComposing: true }), "#")).toBeNull();
    expect(s.open.value).toBe(true);
  });

  it("Enter with no row falls through", () => {
    const { s } = setup();
    s.update("#", 1);
    expect(s.status.value).toBe("loading");
    expect(s.keydown(key("Enter"), "#")).toBeNull();
  });

  it("drops a late answer for another repository", async () => {
    let resolve!: (v: Issue[]) => void;
    const { s, setCwd } = setup({ loadIssues: vi.fn(() => new Promise<Issue[]>((r) => { resolve = r; })) });
    s.update("#", 1);
    setCwd("/other");
    resolve(ISSUES);
    await flush();
    expect(s.rows.value).toEqual([]);
  });

  it("qualifies issues from another repository", async () => {
    const { s } = setup({ loadIssues: vi.fn(async () => [issue(4, "Up", undefined, "up/app")]) });
    s.update("#Up", 3);
    await flush();
    s.keydown(key("ArrowDown"), "#Up");
    expect(s.keydown(key("Enter"), "#Up")).toEqual({ text: "up/app#4 ", caret: 9 });
  });

  it("closes when the caret leaves the token", async () => {
    const { s } = setup();
    s.update("ab #12", 6);
    expect(s.open.value).toBe(true);
    s.update("ab #12", 2);
    expect(s.open.value).toBe(false);
  });

  it("a key with Cmd, Ctrl or Alt never picks", async () => {
    const { s } = setup();
    s.update("#", 1);
    await flush();
    expect(s.keydown(key("Enter", { metaKey: true }), "#")).toBeNull();
    expect(s.keydown(key("Enter", { ctrlKey: true }), "#")).toBeNull();
    expect(s.keydown(key("ArrowDown", { altKey: true }), "#")).toBeNull();
    expect(s.open.value).toBe(true);
  });

  it("ignores the Enter that ends a WebKit composition (keyCode 229)", async () => {
    const { s } = setup();
    s.update("#", 1);
    await flush();
    expect(s.keydown(key("Enter", { keyCode: 229 } as Partial<KeyboardEvent>), "#")).toBeNull();
    expect(s.open.value).toBe(true);
  });

  it("serves the cached rows while refreshing after 60 s", async () => {
    const { s, loadIssues, advance } = setup();
    s.update("#", 1);
    await flush();
    s.close();
    advance(ISSUE_CACHE_TTL_MS + 1);
    s.update("#Logout", 7);
    expect(loadIssues).toHaveBeenCalledTimes(2);
    expect(s.rows.value.map((i) => i.number)).toEqual([57]);
    s.keydown(key("ArrowDown"), "#Logout");
    expect(s.keydown(key("Enter"), "#Logout")).toEqual({ text: "#57 ", caret: 4 });
  });

  it("retries at once after an error", async () => {
    const loadIssues = vi.fn().mockRejectedValueOnce(new Error("signed out")).mockResolvedValue(ISSUES);
    const { s } = setup({ loadIssues });
    s.update("#", 1);
    await flush();
    expect(s.status.value).toBe("error");
    s.close();
    s.update("#", 1);
    await flush();
    expect(loadIssues).toHaveBeenCalledTimes(2);
    expect(s.status.value).toBe("ready");
  });

  it("after an error, typing in the open list does not fetch again", async () => {
    const loadIssues = vi.fn(async () => { throw new Error("offline"); });
    const { s } = setup({ loadIssues });
    s.update("#", 1);
    await flush();
    s.update("#1", 2);
    s.update("#12", 3);
    await flush();
    expect(loadIssues).toHaveBeenCalledTimes(1);
    expect(s.status.value).toBe("error");
  });

  it("an invalidated repository is fetched again at the next #", async () => {
    const cache = createIssueCache();
    const loadIssues = vi.fn(async () => ISSUES);
    const s = useIssueSuggest({ cwd: () => "/r", loadIssues, pushRepo: () => null, cache });
    s.update("#", 1);
    await flush();
    s.close();
    invalidateIssues(cache, { cwd: "/r" });
    s.update("#", 1);
    expect(loadIssues).toHaveBeenCalledTimes(2);
  });

  it("keeps at most a few repositories, dropping the least recently used", async () => {
    const cache = createIssueCache();
    let cwd = "/r0";
    const s = useIssueSuggest({ cwd: () => cwd, loadIssues: async () => ISSUES, pushRepo: () => null, cache });
    for (let i = 0; i <= ISSUE_CACHE_MAX_REPOS; i++) {
      cwd = `/r${i}`;
      s.update("#", 1);
      await flush();
      s.close();
    }
    expect(cache.map.size).toBe(ISSUE_CACHE_MAX_REPOS);
    expect(cache.map.has("/r0")).toBe(false);
  });

  it("a title match takes Enter only after an arrow chose it", async () => {
    const { s } = setup();
    s.update("Tested on #lo", 13);
    await flush();
    expect(s.rows.value.length).toBeGreaterThan(0);
    expect(s.keydown(key("Enter"), "Tested on #lo")).toBeNull();
    expect(s.armed.value).toBe(false);
    expect(s.keydown(key("ArrowDown"), "Tested on #lo")).toBe("handled");
    expect(s.armed.value).toBe(true);
    expect(s.keydown(key("Enter"), "Tested on #lo")).not.toBeNull();
  });

  it("a bare # leaves the arrows to the text (a Markdown heading)", async () => {
    const { s } = setup();
    s.update("#", 1);
    await flush();
    expect(s.rows.value.length).toBeGreaterThan(0);
    expect(s.keydown(key("ArrowUp"), "#")).toBeNull();
    expect(s.keydown(key("ArrowDown"), "#")).toBeNull();
  });

  it("picking with the caret inside a token replaces the whole token", async () => {
    const { s } = setup();
    s.update("see #Login", 7);
    await flush();
    s.keydown(key("ArrowDown"), "see #Login");
    expect(s.keydown(key("Enter"), "see #Login")).toEqual({ text: "see #57 ", caret: 8 });
  });

  it("does not offer the old remote's issues while the new one loads", async () => {
    let push: string | null = "me/app";
    let resolve!: (v: I[]) => void;
    const loadIssues = vi.fn().mockResolvedValueOnce(ISSUES).mockImplementation(() => new Promise<I[]>((r) => { resolve = r; }));
    const { s } = setup({ loadIssues, pushRepo: () => push });
    s.update("#4", 2);
    await flush();
    s.close();
    push = "me/other";
    s.update("#4", 2);
    expect(s.rows.value).toEqual([]);
    resolve([]);
  });

  it("retry opens a list missed because the remote was not known yet", async () => {
    let known = false;
    const loadIssues = vi.fn((_c: string) => (known ? Promise.resolve(ISSUES) : null));
    const { s } = setup({ loadIssues });
    s.retry("#", 1);
    expect(s.open.value).toBe(false);
    s.update("#", 1);
    expect(s.open.value).toBe(false);
    known = true;
    s.retry("#", 1);
    expect(s.open.value).toBe(true);
  });

  it("a typed number never takes Enter or Tab: it already is the reference", async () => {
    const { s } = setup();
    s.update("Fixes #42", 9);
    await flush();
    expect(s.armed.value).toBe(false);
    expect(s.keydown(key("Enter"), "Fixes #42")).toBeNull();
    expect(s.keydown(key("Tab"), "Fixes #42")).toBeNull();
  });

  it("refresh only follows an open list: a caret landing after a # does not open it", async () => {
    const { s } = setup();
    s.refresh("see #3", 6);
    expect(s.open.value).toBe(false);
    s.update("see #3", 6);
    expect(s.open.value).toBe(true);
    s.refresh("see #3", 2);
    expect(s.open.value).toBe(false);
  });

  it("a failed refresh keeps the issues it would have replaced", async () => {
    const loadIssues = vi.fn().mockResolvedValueOnce(ISSUES).mockRejectedValue(new Error("offline"));
    const { s, advance } = setup({ loadIssues });
    s.update("#", 1);
    await flush();
    s.close();
    advance(ISSUE_CACHE_TTL_MS + 1);
    s.update("#", 1);
    await flush();
    expect(s.status.value).toBe("ready");
    expect(s.rows.value).toHaveLength(2);
  });

  it("a remote that changed since the fetch is fetched again", async () => {
    let push: string | null = "me/app";
    const { s, loadIssues } = setup({ pushRepo: () => push });
    s.update("#", 1);
    await flush();
    s.close();
    push = "me/other";
    s.update("#", 1);
    expect(loadIssues).toHaveBeenCalledTimes(2);
  });

  it("invalidating a repository clears every folder holding its issues (worktrees)", async () => {
    const cache = createIssueCache();
    let cwd = "/main";
    const loadIssues = vi.fn(async () => ISSUES);
    const s = useIssueSuggest({ cwd: () => cwd, loadIssues, pushRepo: () => "me/app", cache });
    s.update("#", 1); await flush(); s.close();
    cwd = "/wt";
    s.update("#", 1); await flush(); s.close();
    invalidateIssues(cache, { cwd: "/main", repo: "me/app" });
    expect(cache.map.size).toBe(0);
  });

  it("Shift+Tab never picks", async () => {
    const { s } = setup();
    s.update("#lo", 3);
    await flush();
    s.keydown(key("ArrowDown"), "#lo");
    expect(s.keydown(key("Tab", { shiftKey: true }), "#lo")).toBeNull();
  });

  it("Enter and Tab on a bare # are not taken: no issue was chosen", async () => {
    const { s } = setup();
    s.update("#", 1);
    await flush();
    expect(s.keydown(key("Tab"), "#")).toBeNull();
    expect(s.keydown(key("Enter"), "#")).toBeNull();
  });

  it("drops an answer that started before an invalidation", async () => {
    const cache = createIssueCache();
    let resolve!: (v: I[]) => void;
    const loadIssues = vi.fn(() => new Promise<I[]>((r) => { resolve = r; }));
    const s = useIssueSuggest({ cwd: () => "/r", loadIssues, pushRepo: () => null, cache });
    s.update("#", 1);
    invalidateIssues(cache, { cwd: "/r" });
    resolve(ISSUES);
    await flush();
    expect(cache.map.get("/r")?.status).not.toBe("ready");
    s.close();
    s.update("#", 1);
    expect(loadIssues).toHaveBeenCalledTimes(2);
  });

  it("a fetch that never settles is retried after 60 s", async () => {
    const loadIssues = vi.fn(() => new Promise<I[]>(() => {}));
    const { s, advance } = setup({ loadIssues });
    s.update("#", 1);
    s.close();
    advance(ISSUE_CACHE_TTL_MS + 1);
    s.update("#", 1);
    expect(loadIssues).toHaveBeenCalledTimes(2);
  });

  it("reading a repository keeps it from being evicted first", async () => {
    const cache = createIssueCache();
    let cwd = "/r0";
    const s = useIssueSuggest({ cwd: () => cwd, loadIssues: async () => ISSUES, pushRepo: () => null, cache });
    const visit = async (c: string) => { cwd = c; s.update("#", 1); await flush(); s.close(); };
    for (let i = 0; i < ISSUE_CACHE_MAX_REPOS; i++) await visit(`/r${i}`);
    await visit("/r0");
    await visit("/new");
    expect(cache.map.has("/r0")).toBe(true);
    expect(cache.map.has("/r1")).toBe(false);
  });

  it("two fields sharing a cache fetch once", async () => {
    const cache = createIssueCache();
    const loadIssues = vi.fn(async () => ISSUES);
    const deps = { cwd: () => "/r", loadIssues, pushRepo: () => "me/app", cache };
    const a = useIssueSuggest(deps);
    const b = useIssueSuggest(deps);
    a.update("#", 1);
    await flush();
    b.update("#", 1);
    expect(loadIssues).toHaveBeenCalledTimes(1);
    expect(b.rows.value).toHaveLength(2);
  });

  it("sync closes the list when the text changed without an input event", () => {
    const { s } = setup();
    s.update("fix #", 5);
    s.sync("fix #");
    expect(s.open.value).toBe(true);
    s.sync("");
    expect(s.open.value).toBe(false);
  });

  it("keys pass through when the list is closed", () => {
    const { s } = setup();
    expect(s.keydown(key("Enter"), "x")).toBeNull();
    expect(s.keydown(key("ArrowDown"), "x")).toBeNull();
  });
});
