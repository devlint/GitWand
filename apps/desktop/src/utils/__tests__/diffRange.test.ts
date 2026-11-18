import { describe, it, expect } from "vitest";
import { githubRangeStart, findBlock, rowGroup, parseRowGroup, rowsInColumn } from "../diffRange";
import type { DiffLine, GitDiff } from "../backend";

const add = (n: number, c: string): DiffLine => ({ type: "add", content: c, newLineNo: n });
const del = (n: number, c: string): DiffLine => ({ type: "delete", content: c, oldLineNo: n });
const ctx = (o: number, n: number, c: string): DiffLine => ({ type: "context", content: c, oldLineNo: o, newLineNo: n });

describe("githubRangeStart", () => {
  it("starts on the first row, on its own side, when the range ends on the new side", () => {
    expect(githubRangeStart([del(2, "old"), add(2, "new")])).toEqual({ line: 2, side: "LEFT" });
    expect(githubRangeStart([ctx(3, 3, "a"), add(4, "b")])).toEqual({ line: 3, side: "RIGHT" });
  });

  it("starts on the first old-side row when the range ends on a deleted line", () => {
    expect(githubRangeStart([ctx(1, 1, "a"), del(2, "b")])).toEqual({ line: 1, side: "LEFT" });
    expect(githubRangeStart([add(1, "b"), ctx(2, 2, "c"), del(3, "d")])).toEqual({ line: 2, side: "LEFT" });
  });

  it("no start for fewer than two rows", () => {
    expect(githubRangeStart([add(1, "x")])).toBeNull();
    expect(githubRangeStart([])).toBeNull();
  });
});

function diffOf(...hunks: DiffLine[][]): GitDiff {
  return { path: "f", hunks: hunks.map((lines) => ({ header: "@@", oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines })) } as GitDiff;
}

describe("findBlock", () => {
  it("finds the same rows after lines moved", () => {
    const rows = [ctx(3, 3, "c3"), ctx(4, 4, "c4")];
    const next = diffOf([add(1, "top"), ctx(1, 2, "c1"), ctx(2, 3, "c2"), ctx(3, 4, "c3"), ctx(4, 5, "c4")]);
    expect(findBlock(next, rows)).toEqual({ hunkIdx: 0, start: 3 });
  });

  it("matches the whole block, not each end alone, among duplicated lines", () => {
    const rows = [ctx(10, 10, "}"), ctx(11, 11, "x"), add(12, "}")];
    const next = diffOf(
      [ctx(1, 1, "}"), add(2, "}"), ctx(2, 3, "}")],
      [ctx(10, 14, "}"), ctx(11, 15, "x"), add(16, "}")],
    );
    expect(findBlock(next, rows)).toEqual({ hunkIdx: 1, start: 0 });
  });

  it("prefers the copy at the same old line numbers", () => {
    const rows = [ctx(20, 20, "}"), ctx(21, 21, "}")];
    const next = diffOf([ctx(5, 5, "}"), ctx(6, 6, "}")], [ctx(20, 22, "}"), ctx(21, 23, "}")]);
    expect(findBlock(next, rows)).toEqual({ hunkIdx: 1, start: 0 });
  });

  it("is null when the rows are gone", () => {
    expect(findBlock(diffOf([ctx(1, 1, "a")]), [ctx(3, 3, "zz")])).toBeNull();
  });
});

describe("row groups and columns", () => {
  it("encodes and decodes a file, hunk and column", () => {
    expect(parseRowGroup(rowGroup(3, 7, "old"))).toEqual({ fileIdx: 3, hunkIdx: 7, side: "old" });
    expect(parseRowGroup(rowGroup(0, 0, "row"))).toEqual({ fileIdx: 0, hunkIdx: 0, side: "row" });
  });

  it("takes one column of side-by-side pairs, dropping the gaps", () => {
    const pairs = [
      { left: ctx(1, 1, "a"), right: ctx(1, 1, "a") },
      { left: del(2, "b"), right: add(2, "B") },
      { left: null, right: add(3, "C") },
    ];
    expect(rowsInColumn(pairs, "old", 0, 2).map((l) => l.content)).toEqual(["a", "b"]);
    expect(rowsInColumn(pairs, "new", 1, 2).map((l) => l.content)).toEqual(["B", "C"]);
  });
});
