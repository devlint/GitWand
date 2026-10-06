// @vitest-environment jsdom
/**
 * CommitGraph.vue — remote-tracking twin dedup.
 *
 * When a local branch and its remote-tracking ref point at the same commit
 * (`release/9.0.0` and `origin/release/9.0.0`), the row must show only the
 * local badge. commitRefs() relies on props.branches to tell the two apart,
 * and useGitRepo.openRepo() resets that list on every project switch — so
 * coming back to a project showed both badges until something else reloaded
 * the branches (e.g. updating the branch).
 *
 * Covered here:
 *  - project switch: branches empty → twin still collapsed, and the graph
 *    asks the parent to load branches (once per repo);
 *  - after a rebase: local and remote diverge onto different rows, then
 *    re-converge after a force push;
 *  - stale branch list (a remote ref the list doesn't know yet).
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { createApp, h, nextTick, reactive, type App } from "vue";
import CommitGraph from "../CommitGraph.vue";
import type { GitBranch, GitLogEntry } from "../../utils/backend";

vi.mock("../../composables/useI18n", () => ({
  useI18n: () => ({ t: (key: string, ...args: unknown[]) => (args.length ? `${key}:${args.join(",")}` : key) }),
}));

function commit(hash: string, refs: string, parents: string[] = []): GitLogEntry {
  return {
    hash: hash.slice(0, 7),
    hashFull: hash.padEnd(40, "0"),
    author: "Dev",
    email: "dev@example.com",
    date: "2026-08-01T00:00:00Z",
    message: `commit ${hash}`,
    body: "",
    parents: parents.map((p) => p.padEnd(40, "0")),
    refs,
  };
}

function branch(name: string, isRemote: boolean, upstream: string | null = null): GitBranch {
  return {
    name,
    isCurrent: false,
    isRemote,
    upstream,
    ahead: 0,
    behind: 0,
    mainCommitCount: 1,
    lastCommit: "aaa1111",
    lastCommitDate: "2026-08-01T00:00:00Z",
  };
}

const RELEASE_BRANCHES: GitBranch[] = [
  { ...branch("release/9.0.0", false, "origin/release/9.0.0"), isCurrent: true },
  branch("origin/release/9.0.0", true),
];

let app: App | null = null;
let container: HTMLElement | null = null;

function mount(initial: Record<string, unknown>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  const props = reactive<Record<string, unknown>>({
    currentBranch: "release/9.0.0",
    branches: [],
    cwd: "/repo/a",
    ...initial,
  });
  const loadBranches = vi.fn();
  app = createApp({
    setup() {
      return () => h(CommitGraph, { ...props, onLoadBranches: loadBranches });
    },
  });
  app.mount(container);
  return { props, loadBranches };
}

function badgeNames(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".cg-ref")).map((el) => el.getAttribute("title") ?? "");
}

function badge(name: string): HTMLElement {
  const el = Array.from(document.querySelectorAll<HTMLElement>(".cg-ref")).find(
    (b) => b.getAttribute("title") === name,
  );
  if (!el) throw new Error(`ref badge "${name}" not found (have: ${badgeNames().join(", ")})`);
  return el;
}

afterEach(() => {
  app?.unmount();
  app = null;
  container?.remove();
  container = null;
});

describe("CommitGraph — remote twin on the same commit", () => {
  it("shows only the local badge when branches are loaded", async () => {
    mount({
      commits: [commit("aaa1111", "HEAD -> release/9.0.0, origin/release/9.0.0")],
      branches: RELEASE_BRANCHES,
    });
    await nextTick();
    expect(badgeNames()).toEqual(["release/9.0.0"]);
  });

  it("shows only the local badge right after a project switch (branches still empty)", async () => {
    mount({ commits: [commit("aaa1111", "HEAD -> release/9.0.0, origin/release/9.0.0")] });
    await nextTick();
    expect(badgeNames()).toEqual(["release/9.0.0"]);
    expect(badge("release/9.0.0").className).toContain("cg-ref--branch");
  });

  it("collapses the twin of a non-checked-out slash-named branch too", async () => {
    mount({
      commits: [
        commit("aaa1111", "HEAD -> main", ["bbb2222"]),
        commit("bbb2222", "release/9.0.0, origin/release/9.0.0"),
      ],
      currentBranch: "main",
    });
    await nextTick();
    expect(badgeNames()).not.toContain("origin/release/9.0.0");
    expect(badgeNames()).toContain("release/9.0.0");
  });

  it("collapses the twin when the branch list is stale and lacks the remote ref", async () => {
    mount({
      commits: [commit("aaa1111", "HEAD -> release/9.0.0, origin/release/9.0.0")],
      // Loaded before `git fetch` brought in origin/release/9.0.0.
      branches: [{ ...branch("release/9.0.0", false), isCurrent: true }],
    });
    await nextTick();
    expect(badgeNames()).toEqual(["release/9.0.0"]);
  });

  it("does not treat an unrelated slash-named local branch as a remote", async () => {
    mount({
      commits: [commit("aaa1111", "HEAD -> main, feature/login")],
      currentBranch: "main",
    });
    await nextTick();
    expect(badge("feature/login").className).toContain("cg-ref--branch");
  });
});

describe("CommitGraph — lazy branch loading on project switch", () => {
  it("asks the parent for branches once when it has commits but no branches", async () => {
    const { props, loadBranches } = mount({ commits: [commit("aaa1111", "HEAD -> main")] });
    await nextTick();
    expect(loadBranches).toHaveBeenCalledTimes(1);

    // Re-render with new commits on the same repo — no second request.
    props.commits = [commit("ccc3333", "HEAD -> main", ["aaa1111"]), commit("aaa1111", "")];
    await nextTick();
    expect(loadBranches).toHaveBeenCalledTimes(1);
  });

  it("asks again after switching to another project", async () => {
    const { props, loadBranches } = mount({ commits: [commit("aaa1111", "HEAD -> main")] });
    await nextTick();
    expect(loadBranches).toHaveBeenCalledTimes(1);

    // Switch project: cwd changes, log is reloaded, branches reset to [].
    props.cwd = "/repo/b";
    props.commits = [commit("ddd4444", "HEAD -> release/9.0.0, origin/release/9.0.0")];
    await nextTick();
    expect(loadBranches).toHaveBeenCalledTimes(2);

    // Come back to the first project.
    props.cwd = "/repo/a";
    await nextTick();
    expect(loadBranches).toHaveBeenCalledTimes(3);
  });

  it("does not ask when branches are already loaded", async () => {
    const { loadBranches } = mount({
      commits: [commit("aaa1111", "HEAD -> release/9.0.0, origin/release/9.0.0")],
      branches: RELEASE_BRANCHES,
    });
    await nextTick();
    expect(loadBranches).not.toHaveBeenCalled();
  });

  it("waits for the log before asking", async () => {
    const { props, loadBranches } = mount({ commits: [] });
    await nextTick();
    expect(loadBranches).not.toHaveBeenCalled();

    props.commits = [commit("aaa1111", "HEAD -> main")];
    await nextTick();
    expect(loadBranches).toHaveBeenCalledTimes(1);
  });

  it("collapses the twin once the requested branches arrive", async () => {
    const { props } = mount({ commits: [commit("aaa1111", "HEAD -> release/9.0.0, origin/release/9.0.0")] });
    await nextTick();
    props.branches = RELEASE_BRANCHES;
    await nextTick();
    expect(badgeNames()).toEqual(["release/9.0.0"]);
  });
});

describe("CommitGraph — after a rebase", () => {
  // Before: release/9.0.0 and origin/release/9.0.0 both on bbb2222.
  // After `git rebase main`: the local branch moves to a rewritten commit,
  // the remote ref stays on the old one until a force push.
  const rebased = [
    commit("eee5555", "HEAD -> release/9.0.0", ["aaa1111"]),
    commit("bbb2222", "origin/release/9.0.0", ["fff6666"]),
    commit("aaa1111", "main", ["fff6666"]),
    commit("fff6666", ""),
  ];

  it("shows both badges on their own rows once they diverge", async () => {
    mount({ commits: rebased, branches: RELEASE_BRANCHES });
    await nextTick();
    expect(badge("release/9.0.0").className).toContain("cg-ref--branch");
    expect(badge("origin/release/9.0.0").className).toContain("cg-ref--remote");
  });

  it("reclassifies the lone remote ref as remote once branches load", async () => {
    const { props } = mount({ commits: rebased });
    await nextTick();
    props.branches = [...RELEASE_BRANCHES, branch("main", false)];
    await nextTick();
    expect(badge("origin/release/9.0.0").className).toContain("cg-ref--remote");
  });

  it("collapses back to one badge after the force push", async () => {
    const { props } = mount({ commits: rebased, branches: RELEASE_BRANCHES });
    await nextTick();
    expect(badgeNames()).toContain("origin/release/9.0.0");

    props.commits = [
      commit("eee5555", "HEAD -> release/9.0.0, origin/release/9.0.0", ["aaa1111"]),
      commit("aaa1111", "main", ["fff6666"]),
      commit("fff6666", ""),
    ];
    await nextTick();
    expect(badgeNames()).not.toContain("origin/release/9.0.0");
    expect(badgeNames()).toContain("release/9.0.0");
  });
});
