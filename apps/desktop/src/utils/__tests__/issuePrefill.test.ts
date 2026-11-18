import { describe, it, expect } from "vitest";
import {
  commitIssuePrefill,
  commitUrlFor,
  permalinkSpan,
  blobPermalink,
  selectionIssuePrefill,
  SELECTION_MAX_LINES,
  type DiffSelection,
} from "../issuePrefill";
import type { DiffLine, GitLogEntry } from "../backend";

const FULL = "abc1234ff00112233445566778899aabbccddeeff";

function entry(over: Partial<GitLogEntry> = {}): GitLogEntry {
  return {
    hash: "abc1234",
    hashFull: FULL,
    author: "Ada Lovelace",
    email: "ada@example.com",
    date: "2026-11-17T10:00:00Z",
    message: "fix: x",
    body: "",
    parents: [],
    refs: "",
    ...over,
  };
}

describe("commitIssuePrefill", () => {
  it("titles the issue with the commit summary", () => {
    expect(commitIssuePrefill(entry({ message: "fix: x" }), null).title).toBe("fix: x");
  });

  it("links the short SHA when the commit is pushed", () => {
    const url = `https://github.com/o/r/commit/${FULL}`;
    const b = commitIssuePrefill(entry(), url).body;
    expect(b).toContain(`[\`abc1234\`](${url})`);
  });

  it("writes the full SHA unlinked when the commit is not pushed", () => {
    const b = commitIssuePrefill(entry(), null).body;
    expect(b).toContain(`\`${FULL}\``);
    expect(b).not.toContain("](");
  });

  it("puts the full message, body included, in a code block", () => {
    const b = commitIssuePrefill(entry({ message: "s", body: "l1\n\nl2" }), null).body;
    expect(b).toContain("```text\ns\n\nl1\n\nl2\n```");
  });

  it("keeps mentions and issue references inert (inside the code block)", () => {
    const b = commitIssuePrefill(entry({ message: "Fix race (#123), thanks @alice" }), null).body;
    const block = b.slice(b.indexOf("```"));
    expect(block).toContain("Fix race (#123), thanks @alice");
    expect(b.slice(0, b.indexOf("```"))).not.toMatch(/@alice|#123/);
  });

  it("uses a longer fence than any backtick run in the message", () => {
    const b = commitIssuePrefill(entry({ message: "s", body: "see ```js\nx\n```" }), null).body;
    expect(b).toContain("````text\n");
    expect(b.trimEnd().endsWith("````")).toBe(true);
  });

  it("keeps the title within GitHub's 256-character limit", () => {
    const t = commitIssuePrefill(entry({ message: "x".repeat(300) }), null).title;
    expect([...t].length).toBeLessThanOrEqual(256);
    expect(t.endsWith("…")).toBe(true);
    expect(commitIssuePrefill(entry({ message: "short" }), null).title).toBe("short");
  });

  it("measures the title in UTF-16 units (the input's maxlength) without splitting a pair", () => {
    const t = commitIssuePrefill(entry({ message: "😀".repeat(200) }), null).title;
    expect(t.length).toBeLessThanOrEqual(256);
    expect(/[\uD800-\uDBFF]$/.test(t.slice(0, -1))).toBe(false);
    expect(t.endsWith("…")).toBe(true);
  });

  it("names the author", () => {
    expect(commitIssuePrefill(entry(), null).body).toContain("Ada Lovelace");
  });

  it("keeps the author name inert (no mention, reference or link)", () => {
    const b = commitIssuePrefill(entry({ author: "Jane (@jane) #1 [x](http://e)" }), null).body;
    expect(b).toContain("by `Jane (@jane) #1 [x](http://e)`");
  });

  it("does not leave a trailing blank line inside the block when the body ends with a newline", () => {
    const b = commitIssuePrefill(entry({ message: "s", body: "l1\n" }), null).body;
    expect(b).toContain("l1\n```");
  });
});

describe("commitUrlFor", () => {
  it("appends /commit/<sha> to the repository page", () => {
    expect(commitUrlFor("https://ghe.example.com/o/r", FULL)).toBe(`https://ghe.example.com/o/r/commit/${FULL}`);
  });

  it("does not double a trailing slash", () => {
    expect(commitUrlFor("https://github.com/o/r/", "abc")).toBe("https://github.com/o/r/commit/abc");
  });
});

const add = (n: number, c: string): DiffLine => ({ type: "add", content: c, newLineNo: n });
const del = (n: number, c: string): DiffLine => ({ type: "delete", content: c, oldLineNo: n });
const ctx = (o: number, n: number, c: string): DiffLine => ({ type: "context", content: c, oldLineNo: o, newLineNo: n });

describe("permalinkSpan", () => {
  it("spans the new side when lines were added, the old one when lines were only deleted", () => {
    expect(permalinkSpan([ctx(9, 10, "a"), del(10, "b"), add(11, "c")])).toEqual({ side: "new", from: 10, to: 11 });
    expect(permalinkSpan([del(4, "x"), del(5, "y")])).toEqual({ side: "old", from: 4, to: 5 });
    // Deleted lines and context: all of them exist in the old version.
    expect(permalinkSpan([del(10, "x"), del(11, "y"), ctx(12, 9, "z")])).toEqual({ side: "old", from: 10, to: 12 });
    expect(permalinkSpan([ctx(3, 3, "a")])).toEqual({ side: "new", from: 3, to: 3 });
    expect(permalinkSpan([])).toBeNull();
  });

  it("follows the column the lines were picked in", () => {
    expect(permalinkSpan([ctx(12, 9, "z"), ctx(13, 10, "w")], "old")).toEqual({ side: "old", from: 12, to: 13 });
    expect(permalinkSpan([del(4, "x"), ctx(5, 3, "y")], "new")).toEqual({ side: "new", from: 3, to: 3 });
  });
});

describe("blobPermalink", () => {
  it("builds a blob permalink, one line or a range, path segments encoded", () => {
    expect(blobPermalink("https://github.com/o/r/", "abc", "src/a b#c/é.ts", { side: "new", from: 3, to: 3 }))
      .toBe("https://github.com/o/r/blob/abc/src/a%20b%23c/%C3%A9.ts#L3");
    expect(blobPermalink("https://github.com/o/r", "abc", "x.ts", { side: "new", from: 3, to: 7 }))
      .toBe("https://github.com/o/r/blob/abc/x.ts#L3-L7");
  });
});

describe("selectionIssuePrefill", () => {
  it("writes the permalink, a diff block and the origin of the lines", () => {
    const sel: DiffSelection = {
      path: "src/x.ts",
      lines: [ctx(9, 10, "a"), del(10, "b"), add(11, "c")],
      source: { kind: "commit", hash: "abc1234", hashFull: "abc1234ffff", parent: "p" },
    };
    expect(
      selectionIssuePrefill(sel, {
        repoHtmlUrl: "https://g/o/r",
        newSha: "abc",
        oldSha: "p",
        commitUrl: "https://g/o/r/commit/abc1234ffff",
      }),
    ).toEqual({
      title: "",
      body:
        "https://g/o/r/blob/abc/src/x.ts#L10-L11\n\n```diff\n a\n-b\n+c\n```\n\n`src/x.ts` lines 10–11, commit [`abc1234`](https://g/o/r/commit/abc1234ffff)\n",
    });
  });

  it("without links: no permalink line, the full SHA unlinked", () => {
    const sel: DiffSelection = {
      path: "x.ts",
      lines: [add(3, "c")],
      source: { kind: "commit", hash: "abc1234", hashFull: "abc1234ffff", parent: null },
    };
    expect(selectionIssuePrefill(sel, { repoHtmlUrl: null, newSha: null, oldSha: null, commitUrl: null }).body).toBe(
      "```diff\n+c\n```\n\n`x.ts` line 3, commit `abc1234ffff`\n",
    );
  });

  it("a PR selection names the pull request and starts with the typed text", () => {
    const sel: DiffSelection = {
      path: "x.ts",
      lines: [add(3, "c")],
      intro: "Looks wrong",
      source: { kind: "pr", number: 12, url: "https://github.com/o/r/pull/12", headSha: "h" },
    };
    expect(selectionIssuePrefill(sel, { repoHtmlUrl: null, newSha: null, oldSha: null, commitUrl: null }).body).toBe(
      "Looks wrong\n\n```diff\n+c\n```\n\n`x.ts` line 3, pull request [#12](https://github.com/o/r/pull/12)\n",
    );
  });

  it("fences past backtick runs and caps the block at 200 lines", () => {
    const pr = { kind: "pr" as const, number: 1, url: "u", headSha: null };
    const ticks = selectionIssuePrefill({ path: "x", lines: [add(1, "```")], source: pr }, { repoHtmlUrl: null, newSha: null, oldSha: null, commitUrl: null });
    expect(ticks.body.startsWith("````diff\n+```\n````\n")).toBe(true);
    const many = Array.from({ length: 250 }, (_, i) => add(i + 1, "x"));
    const body = selectionIssuePrefill({ path: "x", lines: many, source: pr }, { repoHtmlUrl: null, newSha: null, oldSha: null, commitUrl: null }).body;
    expect(body.split("\n").filter((l) => l === "+x")).toHaveLength(SELECTION_MAX_LINES);
    expect(body).toContain("\n(first 200 of 250 lines)\n");
  });

  it("says when the lines are from the old version", () => {
    const sel: DiffSelection = { path: "x.ts", lines: [del(4, "a"), del(5, "b")], source: { kind: "pr", number: 1, url: "u", headSha: null } };
    expect(selectionIssuePrefill(sel, { repoHtmlUrl: null, newSha: null, oldSha: null, commitUrl: null }).body).toContain("`x.ts` old lines 4–5, ");
  });

  it("keeps the body under GitHub's limit when lines are very long", () => {
    const pr = { kind: "pr" as const, number: 1, url: "u", headSha: null };
    const long = Array.from({ length: 100 }, (_, i) => add(i + 1, "y".repeat(5000)));
    const body = selectionIssuePrefill({ path: "x", lines: long, source: pr }, { repoHtmlUrl: null, newSha: null, oldSha: null, commitUrl: null }).body;
    expect(body.length).toBeLessThan(65536);
    expect(body).toMatch(/\n\(first \d+ of 100 lines\)\n/);
  });

  it("names a renamed file's old path for deleted lines", () => {
    const sel: DiffSelection = { path: "b/new.ts", oldPath: "a/old.ts", lines: [del(4, "a")], source: { kind: "pr", number: 1, url: "u", headSha: null } };
    expect(selectionIssuePrefill(sel, { repoHtmlUrl: null, newSha: null, oldSha: null, commitUrl: null }).body).toContain("`a/old.ts` old line 4, ");
    const added: DiffSelection = { ...sel, lines: [add(4, "a")] };
    expect(selectionIssuePrefill(added, { repoHtmlUrl: null, newSha: null, oldSha: null, commitUrl: null }).body).toContain("`b/new.ts` line 4, ");
  });

  it("stays under GitHub's limit with a long intro too", () => {
    const pr = { kind: "pr" as const, number: 1, url: "u", headSha: null };
    const long = Array.from({ length: 100 }, (_, i) => add(i + 1, "y".repeat(5000)));
    const body = selectionIssuePrefill(
      { path: "x", lines: long, source: pr, intro: "w".repeat(80_000) },
      { repoHtmlUrl: "https://github.com/o/r", newSha: "s", oldSha: null, commitUrl: null },
    ).body;
    expect(body.length).toBeLessThan(65536);
  });

  it("links the old version at the old SHA, under a renamed file's old path", () => {
    const sel: DiffSelection = {
      path: "b/new.ts", oldPath: "a/old.ts", lines: [del(4, "a")],
      source: { kind: "commit", hash: "c", hashFull: "cfull", parent: "pfull" },
    };
    const body = selectionIssuePrefill(sel, { repoHtmlUrl: "https://g/o/r", newSha: "cfull", oldSha: "pfull", commitUrl: "u" }).body;
    expect(body.startsWith("https://g/o/r/blob/pfull/a/old.ts#L4\n")).toBe(true);
    const noOld = selectionIssuePrefill(sel, { repoHtmlUrl: "https://g/o/r", newSha: "cfull", oldSha: null, commitUrl: "u" }).body;
    expect(noOld).not.toContain("/blob/");
  });

  it("says when a single line had to be cut", () => {
    const pr = { kind: "pr" as const, number: 1, url: "u", headSha: null };
    const body = selectionIssuePrefill({ path: "x", lines: [add(1, "z".repeat(80_000))], source: pr }, { repoHtmlUrl: null, newSha: null, oldSha: null, commitUrl: null }).body;
    expect(body.length).toBeLessThan(65536);
    expect(body).toMatch(/\n\(cut to its first \d+ characters\)\n/);
  });

  it("a PR's deleted lines with context link the context at the head (no base SHA)", () => {
    const sel: DiffSelection = {
      path: "x.ts", lines: [ctx(9, 9, "a"), del(10, "b"), ctx(11, 10, "c")],
      source: { kind: "pr", number: 1, url: "https://github.com/o/r/pull/1", headSha: "h" },
    };
    const body = selectionIssuePrefill(sel, { repoHtmlUrl: "https://github.com/o/r", newSha: "h", oldSha: null, commitUrl: null }).body;
    expect(body.startsWith("https://github.com/o/r/blob/h/x.ts#L9-L10\n")).toBe(true);
    expect(body).toContain("`x.ts` lines 9–10, ");
  });
});
