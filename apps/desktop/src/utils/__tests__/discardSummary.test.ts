import { describe, it, expect } from "vitest";
import { selectDiscardEntries, summarizeDiscard } from "../discardPlan";
import type { RepoFileEntry } from "../../composables/useGitRepo";

const entries: RepoFileEntry[] = [
  { path: "a.txt", status: "modified", section: "staged" },
  { path: "part.txt", status: "modified", section: "staged" },
  { path: "part.txt", status: "modified", section: "unstaged" },
  { path: "b.txt", status: "modified", section: "unstaged" },
  { path: "new.txt", status: "added", section: "untracked" },
];

describe("summarizeDiscard", () => {
  it("counts the staged section and flags files with unstaged changes too", () => {
    expect(summarizeDiscard(entries, "staged", ["a.txt", "part.txt"])).toEqual({
      kind: "staged", fileCount: 2, stagedCount: 2, alsoUnstagedCount: 1,
    });
  });

  it("counts the changes section without any staged entry", () => {
    expect(summarizeDiscard(entries, "changes", ["part.txt", "b.txt", "new.txt"])).toEqual({
      kind: "changes", fileCount: 3, stagedCount: 0, alsoUnstagedCount: 0,
    });
  });

  it("counts a partially staged file once when discarding everything", () => {
    expect(summarizeDiscard(entries, "all", ["a.txt", "part.txt", "b.txt", "new.txt"])).toEqual({
      kind: "all", fileCount: 4, stagedCount: 2, alsoUnstagedCount: 0,
    });
  });

  it("returns null for a section key it does not know", () => {
    expect(summarizeDiscard(entries, "conflicted", ["a.txt"])).toBeNull();
  });
});

describe("selectDiscardEntries", () => {
  it("limits 'all' to the confirmed paths, so a file that appeared since is kept", () => {
    const confirmed = ["a.txt", "part.txt", "b.txt"];
    const now = [...entries, { path: "build.log", status: "added", section: "untracked" } as RepoFileEntry];
    const picked = selectDiscardEntries(now, "all", confirmed).map((e) => `${e.section}:${e.path}`);
    expect(picked).toEqual(["staged:a.txt", "staged:part.txt", "unstaged:part.txt", "unstaged:b.txt"]);
  });

  it("selects nothing for an unknown section key", () => {
    expect(selectDiscardEntries(entries, "conflicted", ["a.txt", "b.txt"])).toEqual([]);
  });
});
