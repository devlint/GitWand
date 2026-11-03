import { describe, it, expect } from "vitest";
import {
  classifyHunkLine,
  hunkBodyFor,
  hunkBodyFromHeader,
  noHunkBody,
  parseHunkHeader,
  type HunkBody,
} from "../hunk-body.js";
import * as core from "../index.js";

/** Classify every line of a multi-file diff, the way the parsers do. */
function classifyAll(diff: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let body: HunkBody = noHunkBody();
  for (const line of diff.split("\n")) {
    const kind = classifyHunkLine(body, line);
    if (kind) {
      out.push([kind, line.slice(1)]);
    } else if (line.startsWith("diff ")) {
      body = noHunkBody();
    } else if (line.startsWith("@@")) {
      body = hunkBodyFromHeader(line);
    }
  }
  return out;
}

describe("hunk-body", () => {
  it("parses a hunk header, an omitted count meaning 1", () => {
    expect(parseHunkHeader("@@ -3 +4,2 @@ fn x")).toEqual({ oldStart: 3, oldCount: 1, newStart: 4, newCount: 2 });
    expect(parseHunkHeader("@@ -0,0 +1 @@")).toEqual({ oldStart: 0, oldCount: 0, newStart: 1, newCount: 1 });
    expect(parseHunkHeader("--- a/x")).toBeNull();
  });

  it("keeps hunk lines whose content starts with -- or ++", () => {
    const diff = [
      "diff --git a/q.sql b/q.sql",
      "--- a/q.sql",
      "+++ b/q.sql",
      "@@ -1,4 +1,4 @@",
      " SELECT 1;",
      "--- old comment",
      "+++x",
      " SELECT 2;",
      "---- x",
      "++++ y",
      "diff --git a/b.txt b/b.txt",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    expect(classifyAll(diff)).toEqual([
      ["context", "SELECT 1;"],
      ["delete", "-- old comment"],
      ["add", "++x"],
      ["context", "SELECT 2;"],
      ["delete", "--- x"],
      ["add", "+++ y"],
      ["delete", "a"],
      ["add", "b"],
    ]);
  });

  it("treats \"\" as a blank context line only while both counts remain", () => {
    // `diff.suppressBlankEmpty=true` prints a blank context line as "".
    const body = hunkBodyFromHeader("@@ -1,3 +1,1 @@");
    expect(classifyHunkLine(body, "")).toBe("context");
    // new side used up, old side has two left: "" cannot be context.
    expect(classifyHunkLine(body, "")).toBeNull();
    expect(classifyHunkLine(body, "-a")).toBe("delete");
    expect(classifyHunkLine(body, "-b")).toBe("delete");
    // body exhausted: "" and headers are not hunk lines.
    expect(classifyHunkLine(body, "")).toBeNull();
    expect(classifyHunkLine(body, "--- a/next")).toBeNull();
  });

  it("enforces the counts per side", () => {
    const body = hunkBodyFromHeader("@@ -1,1 +1,2 @@");
    expect(classifyHunkLine(body, "-a")).toBe("delete");
    // Old side used up: neither a delete nor a context line fits.
    expect(classifyHunkLine(body, "-b")).toBeNull();
    expect(classifyHunkLine(body, " c")).toBeNull();
    expect(classifyHunkLine(body, "")).toBeNull();
    expect(classifyHunkLine(body, "+d")).toBe("add");
    expect(classifyHunkLine(body, "+e")).toBe("add");
    expect(classifyHunkLine(body, "+f")).toBeNull();
  });

  it("does not take a header for a deletion once the old side is used up (fails closed)", () => {
    // A header that overcounts the new side, then the next file's headers
    // with no `diff` line between: `--- a/b` is no deletion (old side done).
    const diff = ["--- a/a", "+++ b/a", "@@ -1 +1,3 @@", "-x", "+y", "--- a/b", "@@ -1 +1 @@", "-p", "+q"].join("\n");
    expect(classifyAll(diff)).toEqual([
      ["delete", "x"],
      ["add", "y"],
      ["delete", "p"],
      ["add", "q"],
    ]);
  });

  it("ignores \"\" outside a hunk", () => {
    expect(classifyHunkLine(noHunkBody(), "")).toBeNull();
    expect(classifyHunkLine(noHunkBody(), "+x")).toBeNull();
  });

  it("hunkBodyFromHeader reads the counts from the header, 1 when omitted", () => {
    expect(hunkBodyFromHeader("@@ -3,0 +4,2 @@ fn")).toEqual({ oldLeft: 0, newLeft: 2, unbounded: false });
    expect(hunkBodyFromHeader("@@ -3 +4 @@")).toEqual({ oldLeft: 1, newLeft: 1, unbounded: false });
    expect(hunkBodyFromHeader("@@@ -1,1 -1,1 +1,3 @@@").unbounded).toBe(true);
  });

  it("leaves a combined @@@ hunk open until the next diff line", () => {
    const body = hunkBodyFor("@@@ -1,1 -1,1 +1,3 @@@", 1, 1);
    for (const l of ["++<<<<<<< HEAD", " +ours", "++=======", "+ theirs"]) {
      expect(classifyHunkLine(body, l)).not.toBeNull();
    }
    expect(classifyHunkLine(body, "")).toBeNull();
  });

  it("is exported from @gitwand/core", () => {
    for (const name of ["parseHunkHeader", "noHunkBody", "hunkBodyFor", "hunkBodyFromHeader", "classifyHunkLine"]) {
      expect(core).toHaveProperty(name);
    }
  });
});
