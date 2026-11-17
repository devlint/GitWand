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

  it("quotes every line of the full message, body included", () => {
    const b = commitIssuePrefill(entry({ message: "s", body: "l1\n\nl2" }), null).body;
    expect(b).toContain("> s\n>\n> l1\n>\n> l2");
  });

  it("names the author", () => {
    expect(commitIssuePrefill(entry(), null).body).toContain("Ada Lovelace");
  });

  it("does not leave a trailing blank quote line when the body ends with a newline", () => {
    const b = commitIssuePrefill(entry({ message: "s", body: "l1\n" }), null).body;
    expect(b.trimEnd().endsWith("> l1")).toBe(true);
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
