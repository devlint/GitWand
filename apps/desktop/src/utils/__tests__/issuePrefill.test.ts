import { describe, it, expect } from "vitest";
import { commitIssuePrefill, commitUrlFor } from "../issuePrefill";
import type { GitLogEntry } from "../backend";

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

  it("names the author", () => {
    expect(commitIssuePrefill(entry(), null).body).toContain("Ada Lovelace");
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
