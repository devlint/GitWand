import { describe, it, expect } from "vitest";
import { ref } from "vue";
import type { WorkspaceWipItem } from "../../utils/backend";
import { useRepoActionCards } from "../useRepoActionCards";

function wip(overrides: Partial<WorkspaceWipItem>): WorkspaceWipItem {
  return {
    path: "/repo",
    name: "repo",
    branch: "main",
    ahead: 0,
    behind: 0,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    lastCommitAt: "",
    hasNoUpstream: false,
    error: null,
    changedFiles: [],
    ...overrides,
  };
}

describe("useRepoActionCards", () => {
  it("emits a commit card when there are working-tree changes", () => {
    const { cards } = useRepoActionCards(ref([wip({ stagedCount: 2, untrackedCount: 1 })]));
    expect(cards.value).toHaveLength(1);
    expect(cards.value[0]).toMatchObject({ kind: "commit", count: 3, repoPath: "/repo" });
  });

  it("emits push + sync when ahead and behind", () => {
    const { cards } = useRepoActionCards(ref([wip({ ahead: 2, behind: 4 })]));
    expect(cards.value.map((c) => c.kind)).toEqual(["push", "sync"]);
    expect(cards.value.find((c) => c.kind === "push")?.count).toBe(2);
    expect(cards.value.find((c) => c.kind === "sync")?.count).toBe(4);
  });

  it("emits a publish card (not push/sync) when the branch has no upstream", () => {
    const { cards } = useRepoActionCards(ref([wip({ hasNoUpstream: true, ahead: 5, behind: 1 })]));
    expect(cards.value.map((c) => c.kind)).toEqual(["publish"]);
  });

  it("a repo can yield several cards (commit + push), priority-ordered", () => {
    const { cards } = useRepoActionCards(ref([wip({ unstagedCount: 1, ahead: 1 })]));
    expect(cards.value.map((c) => c.kind)).toEqual(["commit", "push"]);
  });

  it("skips repos in error and clean repos", () => {
    const { cards, totalCount } = useRepoActionCards(
      ref([wip({ error: "boom", stagedCount: 9 }), wip({ name: "clean" })])
    );
    expect(cards.value).toEqual([]);
    expect(totalCount.value).toBe(0);
  });

  it("orders across repos by priority then repo name", () => {
    const { cards } = useRepoActionCards(
      ref([
        wip({ path: "/z", name: "zed", behind: 1 }), // sync (prio 3)
        wip({ path: "/a", name: "alpha", stagedCount: 1 }), // commit (prio 0)
        wip({ path: "/b", name: "beta", ahead: 1 }), // push (prio 1)
      ])
    );
    expect(cards.value.map((c) => c.kind)).toEqual(["commit", "push", "sync"]);
  });
});
