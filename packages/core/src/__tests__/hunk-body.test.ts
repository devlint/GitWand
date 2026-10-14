import { describe, it, expect } from "vitest";
import {
  classifyHunkLine,
  hunkBodyActive,
  hunkBodyFor,
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
      const r = parseHunkHeader(line);
      body = hunkBodyFor(line, r?.oldCount ?? 1, r?.newCount ?? 1);
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

  it("never treats an empty string as context, and closes once the counts are used up", () => {
    const body = hunkBodyFor("@@ -1,1 +1,1 @@", 1, 1);
    expect(classifyHunkLine(body, "")).toBeNull();
    expect(classifyHunkLine(body, " a")).toBe("context");
    expect(hunkBodyActive(body)).toBe(false);
    expect(classifyHunkLine(body, "--- a/next")).toBeNull();
  });

  it("leaves a combined @@@ hunk open until the next diff line", () => {
    const body = hunkBodyFor("@@@ -1,1 -1,1 +1,3 @@@", 1, 1);
    for (const l of ["++<<<<<<< HEAD", " +ours", "++======="]) {
      expect(classifyHunkLine(body, l)).not.toBeNull();
    }
    expect(hunkBodyActive(body)).toBe(true);
  });

  it("is exported from @gitwand/core", () => {
    for (const name of ["parseHunkHeader", "noHunkBody", "hunkBodyFor", "hunkBodyActive", "classifyHunkLine"]) {
      expect(core).toHaveProperty(name);
    }
  });
});
