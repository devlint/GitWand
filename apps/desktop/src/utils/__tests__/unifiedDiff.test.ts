/**
 * Task 0 (v3.7.0) — `indexDiffFiles` / `parseFileDiff` / `parseUnifiedDiff` lifted
 * out of `usePrPanel.ts` into a pure, Vue-free, backend-free module so a
 * commit-review composable never has to import the PR panel to parse a diff.
 *
 * These three assertions are copied from `usePrPanel-lazy-diff.test.ts` — the
 * blank-context-line one is the diff-parsing gotcha guard (AGENTS.md): an
 * empty string is a context line, never a phantom add/delete.
 */
import { describe, it, expect } from "vitest";
import { indexDiffFiles, parseFileDiff, parseUnifiedDiff } from "../unifiedDiff";

const THREE_FILE_DIFF = [
  "diff --git a/a.ts b/a.ts",
  "index 111..222 100644",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,2 +1,2 @@",
  " context a",
  "-old a",
  "+new a",
  "diff --git a/b.ts b/b.ts",
  "index 333..444 100644",
  "--- a/b.ts",
  "+++ b/b.ts",
  "@@ -1,3 +1,3 @@",
  " context b",
  "",
  "-old b",
  "+new b",
  "diff --git a/c.ts b/c.ts",
  "index 555..666 100644",
  "--- a/c.ts",
  "+++ b/c.ts",
  "@@ -1,1 +1,1 @@",
  "-old c",
  "+new c",
].join("\n");

describe("indexDiffFiles", () => {
  it("splits a raw multi-file diff into per-file slices with correct b/ paths", () => {
    const slices = indexDiffFiles(THREE_FILE_DIFF);
    expect(slices.map((s) => s.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
    for (const s of slices) {
      expect(s.raw.startsWith(`diff --git a/${s.path} b/${s.path}`)).toBe(true);
    }
  });

  it("returns [] for an empty diff", () => {
    expect(indexDiffFiles("")).toEqual([]);
    expect(indexDiffFiles("   ")).toEqual([]);
  });
});

describe("parseFileDiff", () => {
  it("matches parseUnifiedDiff's per-file output (regression parity)", () => {
    const expected = parseUnifiedDiff(THREE_FILE_DIFF);
    const slices = indexDiffFiles(THREE_FILE_DIFF);
    const actual = slices.map((s) => parseFileDiff(s.raw));
    expect(actual).toEqual(expected);
  });

  it("classifies an empty-string context line as context, not add/delete", () => {
    const slice = indexDiffFiles(THREE_FILE_DIFF)[1]; // b.ts has a blank context line
    const parsed = parseFileDiff(slice.raw);
    const blank = parsed.hunks[0].lines.find((l) => l.content === "" && l.type !== undefined);
    expect(blank?.type).toBe("context");
  });

  // v3.7.0 review-round fix (finding #10): a raw `git diff` always ends
  // with "\n" (indexDiffFiles joins slices with "\n" too), so
  // `split("\n")` used to yield one trailing "" element that landed on the
  // LAST hunk of the LAST file as a phantom zero-length context line,
  // pushing its line counters past what the hunk header declared. Same bug
  // class the Rust parser fixed (src-tauri/src/commands/read.rs).
  describe("phantom trailing context line (finding #10)", () => {
    it("a single-file diff ending in \\n has no trailing phantom context line, and its last real line's counters match the hunk header", () => {
      const diff = [
        "diff --git a/a.ts b/a.ts",
        "index 111..222 100644",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1,2 +1,2 @@",
        " context a",
        "-old a",
        "+new a",
        "", // trailing "\n" via join, below
      ].join("\n");

      const parsed = parseFileDiff(diff);
      const lastHunk = parsed.hunks[parsed.hunks.length - 1];
      const lastLine = lastHunk.lines[lastHunk.lines.length - 1];

      expect(lastLine).not.toEqual(expect.objectContaining({ type: "context", content: "" }));
      // Hunk header says "+1,2": 2 new lines declared (context a, new a).
      // The last real line (the "+new a" add) must land at newLine 2, not 3.
      expect(lastLine.type).toBe("add");
      expect(lastLine.newLineNo).toBe(2);
    });

    it("a multi-file diff ending in \\n only ever affected the LAST file's last hunk", () => {
      const diff = THREE_FILE_DIFF + "\n";
      const slices = indexDiffFiles(diff);
      expect(slices).toHaveLength(3);

      for (const slice of slices) {
        const parsed = parseFileDiff(slice.raw);
        const lastHunk = parsed.hunks[parsed.hunks.length - 1];
        const lastLine = lastHunk.lines[lastHunk.lines.length - 1];
        expect(lastLine).not.toEqual(expect.objectContaining({ type: "context", content: "" }));
      }
    });

    it("the existing blank-context-line case (THREE_FILE_DIFF's b.ts) still classifies the interior \"\" as context, unmodified", () => {
      const slice = indexDiffFiles(THREE_FILE_DIFF)[1];
      const parsed = parseFileDiff(slice.raw);
      const blank = parsed.hunks[0].lines.find((l) => l.content === "" && l.type !== undefined);
      expect(blank?.type).toBe("context");
    });

    it("a diff ending in \\n\\n strips exactly one trailing element, so the genuine blank line before EOF survives as context", () => {
      const diff = [
        "diff --git a/a.ts b/a.ts",
        "index 111..222 100644",
        "--- a/a.ts",
        "+++ b/a.ts",
        // Counts as git writes them: context a, blank, old|new a, blank.
        // The parser now bounds a hunk by these counts (see the `--`/`++`
        // tests below), so they must match the body.
        "@@ -1,4 +1,4 @@",
        " context a",
        "",
        "-old a",
        "+new a",
        "",
        "",
      ].join("\n");

      const parsed = parseFileDiff(diff);
      const lastHunk = parsed.hunks[parsed.hunks.length - 1];
      const lastLine = lastHunk.lines[lastHunk.lines.length - 1];
      // The genuine blank context line right before EOF must survive.
      expect(lastLine.type).toBe("context");
      expect(lastLine.content).toBe("");
    });

    it("a diff NOT ending in a newline produces identical output to before (no line lost)", () => {
      // THREE_FILE_DIFF itself has no trailing "\n": regression guard that
      // the fix does not drop a real line when there is no trailing "\n".
      const parsed = parseUnifiedDiff(THREE_FILE_DIFF);
      const cFile = parsed[parsed.length - 1];
      const lastHunk = cFile.hunks[cFile.hunks.length - 1];
      const lastLine = lastHunk.lines[lastHunk.lines.length - 1];
      expect(lastLine.type).toBe("add");
      expect(lastLine.content).toBe("new c");
    });

    it("parseFileDiff still matches parseUnifiedDiff per file when the raw diff ends in \\n", () => {
      const diff = THREE_FILE_DIFF + "\n";
      const expected = parseUnifiedDiff(diff);
      const slices = indexDiffFiles(diff);
      const actual = slices.map((s) => parseFileDiff(s.raw));
      expect(actual).toEqual(expected);
    });
  });

  // A removed SQL comment `-- old` is the diff line `--- old`, an added `++x`
  // is `+++x`. They used to be skipped as `---`/`+++` file headers, leaving
  // the hunk with only its context lines and every later line number off.
  // `diff.suppressBlankEmpty=true` prints a blank context line as "". It is
  // context only while counts remain on both sides; past them it is ignored.
  it('treats "" as context only while both hunk counts remain', () => {
    const diff = [
      "diff --git a/f.txt b/f.txt",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1,4 +1,2 @@",
      " a",
      "",
      "-x",
      "",
      "-y",
      "",
      "",
    ].join("\n");
    expect(parseFileDiff(diff).hunks[0].lines).toEqual([
      { type: "context", content: "a", oldLineNo: 1, newLineNo: 1 },
      { type: "context", content: "", oldLineNo: 2, newLineNo: 2 },
      { type: "delete", content: "x", oldLineNo: 3 },
      { type: "delete", content: "y", oldLineNo: 4 },
    ]);
  });

  describe("hunk lines whose content starts with -- or ++", () => {
    const SQL_DIFF = [
      "diff --git a/q.sql b/q.sql",
      "index 111..222 100644",
      "--- a/q.sql",
      "+++ b/q.sql",
      "@@ -1,5 +1,5 @@",
      " SELECT 1;",
      "--- old comment",
      "+++x",
      " SELECT 2;",
      "---- x",
      "++++ y",
      " SELECT 3;",
      "diff --git a/z.ts b/z.ts",
      "index 333..444 100644",
      "--- a/z.ts",
      "+++ b/z.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "\\ No newline at end of file",
      "",
    ].join("\n");

    it("keeps them, with the right line numbers", () => {
      const [sql, z] = parseUnifiedDiff(SQL_DIFF);
      expect(sql.path).toBe("q.sql");
      expect(sql.hunks).toHaveLength(1);
      expect(sql.hunks[0].lines).toEqual([
        { type: "context", content: "SELECT 1;", oldLineNo: 1, newLineNo: 1 },
        { type: "delete", content: "-- old comment", oldLineNo: 2 },
        { type: "add", content: "++x", newLineNo: 2 },
        { type: "context", content: "SELECT 2;", oldLineNo: 3, newLineNo: 3 },
        { type: "delete", content: "--- x", oldLineNo: 4 },
        { type: "add", content: "+++ y", newLineNo: 4 },
        { type: "context", content: "SELECT 3;", oldLineNo: 5, newLineNo: 5 },
      ]);
      // The next file's headers are still headers.
      expect(z.path).toBe("z.ts");
      expect(z.hunks[0].lines.map((l) => [l.type, l.content])).toEqual([
        ["delete", "a"],
        ["add", "b"],
      ]);
    });
  });
});
