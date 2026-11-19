/**
 * Issue references in commit messages (#301, part 4): the text helpers.
 */
import { describe, it, expect } from "vitest";
import type { Issue } from "../backend";
import { hashTokenAt, filterIssues, repoSlugFromUrl, remoteSlug, issueRef, insertRef, appendRef, addCreatedIssueToCommit } from "../issueRefs";

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
  it("gives the token's end, past the caret", () => {
    expect(hashTokenAt("see #123 x", 7)).toEqual({ start: 4, query: "12", end: 8 });
  });
  it("opens at the start, after a space, a newline or (", () => {
    expect(hashTokenAt("#", 1)).toEqual({ start: 0, query: "", end: 1 });
    expect(hashTokenAt("fix #12", 7)).toEqual({ start: 4, query: "12", end: 7 });
    expect(hashTokenAt("a\n#lo", 5)).toEqual({ start: 2, query: "lo", end: 5 });
    expect(hashTokenAt("(#4", 3)).toEqual({ start: 1, query: "4", end: 3 });
  });
  it("never after a letter or a digit", () => {
    expect(hashTokenAt("C#", 2)).toBeNull();
    expect(hashTokenAt("abc#1", 5)).toBeNull();
  });
  it("closes on punctuation after the query", () => {
    expect(hashTokenAt("(#12)", 5)).toBeNull();
    expect(hashTokenAt("#12,", 4)).toBeNull();
    expect(hashTokenAt("see #12.", 8)).toBeNull();
    expect(hashTokenAt("#a/b", 4)).toBeNull();
    expect(hashTokenAt("#log-in_v2", 10)).toEqual({ start: 0, query: "log-in_v2", end: 10 });
  });
  it("closes on a space after the query, or when the caret is before the #", () => {
    expect(hashTokenAt("#12 x", 5)).toBeNull();
    expect(hashTokenAt("ab #12", 2)).toBeNull();
  });
});

describe("filterIssues", () => {
  it("digits match the number by prefix", () => expect(filterIssues(issues, "4").map((i) => i.number)).toEqual([4, 42]));
  it("an exact number comes first, before more recently updated longer ones", () => {
    const list = [issue(120, "a", "2026-11-12T00:00:00Z"), issue(12, "b", "2026-11-01T00:00:00Z"), issue(121, "c", "2026-11-11T00:00:00Z")];
    expect(filterIssues(list, "12").map((i) => i.number)).toEqual([12, 120, 121]);
  });
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

describe("remoteSlug", () => {
  it("owner/repo, or null when a part is missing", () => {
    expect(remoteSlug({ owner: "g", repo: "sub/p" })).toBe("g/sub/p");
    expect(remoteSlug({ owner: "", repo: "r" })).toBeNull();
    expect(remoteSlug(null)).toBeNull();
  });
});

describe("issueRef", () => {
  it("bare when same repository or unknown, qualified otherwise", () => {
    expect(issueRef(4, "Me/App", "me/app")).toBe("#4");
    expect(issueRef(4, null, "me/app")).toBe("#4");
    expect(issueRef(4, "up/app", null)).toBe("up/app#4");
    expect(issueRef(4, "up/app", "me/app")).toBe("up/app#4");
  });
  it("a forge served under a path prefix is still the same repository", () => {
    expect(issueRef(5, "gitlab/grp/proj", "grp/proj")).toBe("#5");
    expect(issueRef(5, "gitlab/grp/proj", "rp/proj")).toBe("gitlab/grp/proj#5");
  });
  it("ignores a trailing slash or .git on the push repository", () => {
    expect(issueRef(4, "o/r", "o/r/")).toBe("#4");
    expect(issueRef(4, "o/r", "o/r.git")).toBe("#4");
  });
});

describe("insertRef", () => {
  it("replaces the whole #token, adding a space only when none follows", () => {
    expect(insertRef("fix #lo now", 4, 7, "#42", false)).toEqual({ text: "fix #42 now", caret: 8 });
    expect(insertRef("see #123", 4, 8, "#12", false)).toEqual({ text: "see #12 ", caret: 8 });
    expect(insertRef("#foobar", 0, 7, "#42", false)).toEqual({ text: "#42 ", caret: 4 });
    expect(insertRef("Fixes # the bug", 6, 7, "#12", false)).toEqual({ text: "Fixes #12 the bug", caret: 10 });
  });
  it("Fixes form", () => expect(insertRef("#4", 0, 2, "#42", true)).toEqual({ text: "Fixes #42 ", caret: 10 }));
});

describe("appendRef", () => {
  it("adds the reference as its own paragraph, sets when empty, never duplicates", () => {
    expect(appendRef("body", "#4")).toBe("body\n\n#4");
    expect(appendRef("body\n\n", "#4")).toBe("body\n\n#4");
    expect(appendRef("", "#4")).toBe("#4");
    expect(appendRef("see #4 here", "#4")).toBe("see #4 here");
    expect(appendRef("", "#4", "Fix #4")).toBe("");
    expect(appendRef("see #42", "#4")).toBe("see #42\n\n#4");
    expect(appendRef("up/app#4", "#4")).toBe("up/app#4\n\n#4");
  });
  it("never breaks a closing fence or a list item", () => {
    expect(appendRef("```\nx\n```", "#4")).toBe("```\nx\n```\n\n#4");
    expect(appendRef("- a\n- b", "#4")).toBe("- a\n- b\n\n#4");
  });
  it("a last paragraph that only looks like a trailer is prose", () => {
    expect(appendRef("body\n\nNote: this also fixes the tooltip.", "#4")).toBe("body\n\nNote: this also fixes the tooltip.\n\n#4");
  });
  it("goes before GitWand's commit signature, which stays last", () => {
    expect(appendRef("\u{1FA84} Commit via GitWand", "#4")).toBe("#4\n\n\u{1FA84} Commit via GitWand");
    expect(appendRef("body\n\n\u{1FA84} Commit via GitWand", "#4")).toBe("body\n\n#4\n\n\u{1FA84} Commit via GitWand");
  });
  it("goes before a trailer block, which must stay last", () => {
    expect(appendRef("body\n\nSigned-off-by: A <a@x.com>", "#4")).toBe("body\n\n#4\n\nSigned-off-by: A <a@x.com>");
    expect(appendRef("Signed-off-by: A <a@x.com>\nReviewed-by: B <b@x.com>", "#4")).toBe("#4\n\nSigned-off-by: A <a@x.com>\nReviewed-by: B <b@x.com>");
  });
});

describe("addCreatedIssueToCommit", () => {
  const ctx = (o: Partial<{ createdIn: string; activeCwd: string; pushRepo: string | null; summary: string; description: string }> = {}) => ({
    createdIn: "/r", activeCwd: "/r", pushRepo: "me/app", summary: "s", description: "d", ...o,
  });
  const ISSUE7 = { url: "https://github.com/me/app/issues/7", number: 7, repo: "me/app" };
  it("adds the reference to the active repository's description", () =>
    expect(addCreatedIssueToCommit(ISSUE7, ctx())).toEqual({ status: "added", description: "d\n\n#7" }));
  it("sets an empty description", () =>
    expect(addCreatedIssueToCommit(ISSUE7, ctx({ description: "" }))).toEqual({ status: "added", description: "#7" }));
  it("qualifies an issue filed on the parent", () =>
    expect(addCreatedIssueToCommit({ ...ISSUE7, url: "https://github.com/up/app/issues/7", repo: "up/app" }, ctx({ description: "" })))
      .toEqual({ status: "added", description: "up/app#7" }));
  it("falls back to the target repository when the issue has no URL", () =>
    expect(addCreatedIssueToCommit({ url: "", number: 7, repo: "up/app" }, ctx({ description: "" })))
      .toEqual({ status: "added", description: "up/app#7" }));
  it("no repository open is not a match", () =>
    expect(addCreatedIssueToCommit(ISSUE7, ctx({ createdIn: "", activeCwd: "" }))).toEqual({ status: "otherRepo" }));
  it("says so after a repository switch", () =>
    expect(addCreatedIssueToCommit(ISSUE7, ctx({ activeCwd: "/other" }))).toEqual({ status: "otherRepo" }));
  it("an issue already cited in another form is not added again", () => {
    expect(addCreatedIssueToCommit(ISSUE7, ctx({ description: "see me/app#7" }))).toEqual({ status: "alreadyCited" });
    expect(addCreatedIssueToCommit(ISSUE7, ctx({ description: "see https://github.com/me/app/issues/7" }))).toEqual({ status: "alreadyCited" });
  });
  it("says so when already referenced", () =>
    expect(addCreatedIssueToCommit(ISSUE7, ctx({ summary: "Fix #7" }))).toEqual({ status: "alreadyCited" }));
});
