/**
 * Issue references in commit messages (#301, part 4): the text helpers.
 */
import { describe, it, expect } from "vitest";
import type { Issue } from "../backend";
import { hashTokenAt, filterIssues, repoSlugFromUrl, issueRef, insertRef, appendRef, addCreatedIssueToCommit } from "../issueRefs";

function issue(number: number, title: string, updatedAt: string, url = `https://github.com/me/app/issues/${number}`): Issue {
  return { number, title, state: "OPEN", author: "a", assignees: [], labels: [], url, createdAt: updatedAt, updatedAt, milestone: "" };
}
const issues = [
  issue(42, "Login fails with SSO", "2026-11-10T00:00:00Z"),
  issue(57, "Logout keeps cache", "2026-11-12T00:00:00Z"),
  issue(4, "Docs", "2026-11-01T00:00:00Z"),
];
const many = (n: number) => Array.from({ length: n }, (_, i) => issue(i + 1, `t${i}`, `2026-11-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`));

describe("hashTokenAt", () => {
  it("opens at the start, after a space, a newline or (", () => {
    expect(hashTokenAt("#", 1)).toEqual({ start: 0, query: "" });
    expect(hashTokenAt("fix #12", 7)).toEqual({ start: 4, query: "12" });
    expect(hashTokenAt("a\n#lo", 5)).toEqual({ start: 2, query: "lo" });
    expect(hashTokenAt("(#4", 3)).toEqual({ start: 1, query: "4" });
  });
  it("never after a letter or a digit", () => {
    expect(hashTokenAt("C#", 2)).toBeNull();
    expect(hashTokenAt("abc#1", 5)).toBeNull();
  });
  it("closes on a space after the query, or when the caret is before the #", () => {
    expect(hashTokenAt("#12 x", 5)).toBeNull();
    expect(hashTokenAt("ab #12", 2)).toBeNull();
  });
});

describe("filterIssues", () => {
  it("digits match the number by prefix", () => expect(filterIssues(issues, "4").map((i) => i.number)).toEqual([42, 4]));
  it("text matches the title, case-insensitively, most recently updated first", () =>
    expect(filterIssues(issues, "LOG").map((i) => i.number)).toEqual([57, 42]));
  it("an empty query lists the most recently updated first", () =>
    expect(filterIssues(issues, "").map((i) => i.number)).toEqual([57, 42, 4]));
  it("caps at 8", () => expect(filterIssues(many(20), "")).toHaveLength(8));
});

describe("repoSlugFromUrl", () => {
  it("GitHub, Gitea, GitLab", () => {
    expect(repoSlugFromUrl("https://github.com/iamvdo/mq/issues/4")).toBe("iamvdo/mq");
    expect(repoSlugFromUrl("https://gitlab.com/g/sub/p/-/issues/9")).toBe("g/sub/p");
    expect(repoSlugFromUrl("nope")).toBeNull();
  });
});

describe("issueRef", () => {
  it("bare when same repository or unknown, qualified otherwise", () => {
    expect(issueRef(4, "Me/App", "me/app")).toBe("#4");
    expect(issueRef(4, null, "me/app")).toBe("#4");
    expect(issueRef(4, "up/app", null)).toBe("#4");
    expect(issueRef(4, "up/app", "me/app")).toBe("up/app#4");
  });
  it("ignores a trailing slash or .git on the push repository", () => {
    expect(issueRef(4, "o/r", "o/r/")).toBe("#4");
    expect(issueRef(4, "o/r", "o/r.git")).toBe("#4");
  });
});

describe("insertRef", () => {
  it("replaces #query with the reference and a space", () =>
    expect(insertRef("fix #lo now", 4, 7, "#42", false)).toEqual({ text: "fix #42  now", caret: 8 }));
  it("Fixes form", () => expect(insertRef("#4", 0, 2, "#42", true)).toEqual({ text: "Fixes #42 ", caret: 10 }));
});

describe("appendRef", () => {
  it("appends, sets when empty, never duplicates", () => {
    expect(appendRef("body", "#4")).toBe("body #4");
    expect(appendRef("", "#4")).toBe("#4");
    expect(appendRef("see #4 here", "#4")).toBe("see #4 here");
    expect(appendRef("", "#4", "Fix #4")).toBe("");
    expect(appendRef("see #42", "#4")).toBe("see #42 #4");
    expect(appendRef("up/app#4", "#4")).toBe("up/app#4 #4");
  });
});

describe("addCreatedIssueToCommit", () => {
  const URL7 = "https://github.com/me/app/issues/7";
  it("appends the reference to the active repository's description", () =>
    expect(addCreatedIssueToCommit(URL7, 7, "/r", "/r", "me/app", "s", "d")).toBe("d #7"));
  it("sets an empty description", () => expect(addCreatedIssueToCommit(URL7, 7, "/r", "/r", "me/app", "", "")).toBe("#7"));
  it("qualifies an issue filed on the parent", () =>
    expect(addCreatedIssueToCommit("https://github.com/up/app/issues/7", 7, "/r", "/r", "me/app", "", "")).toBe("up/app#7"));
  it("does nothing after a repository switch", () =>
    expect(addCreatedIssueToCommit(URL7, 7, "/r", "/other", "me/app", "", "")).toBeNull());
  it("does nothing when already referenced", () =>
    expect(addCreatedIssueToCommit(URL7, 7, "/r", "/r", "me/app", "Fix #7", "")).toBeNull());
});
