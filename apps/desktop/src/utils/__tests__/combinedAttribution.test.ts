import { describe, it, expect } from "vitest";
import type { CombinedDiff, DiffHunk, DiffLine, GitDiff } from "../backend";
import { buildCombinedEntries } from "../combinedAttribution";
import { lineKeyFor } from "../diffLineKey";

const add = (n: number, content = "x"): DiffLine => ({ type: "add", content, newLineNo: n });
const del = (n: number, content = "x"): DiffLine => ({ type: "delete", content, oldLineNo: n });

function hunk(oldStart: number, oldCount: number, newStart: number, newCount: number, lines: DiffLine[]): DiffHunk {
  return { header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, oldStart, oldCount, newStart, newCount, lines };
}
function file(path: string, hunks: DiffHunk[], extra: Partial<GitDiff> = {}): GitDiff {
  return { path, hunks, ...extra };
}
const commits = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ hash: `h${i}`, shortHash: `h${i}`, subject: `c${i}`, author: "a", date: "d" }));
function combined(n: number, diffs: GitDiff[], steps: GitDiff[][], fallback: CombinedDiff["fallback"] = []): CombinedDiff {
  return { base: "base", commits: commits(n), diffs, steps, fallback };
}

describe("buildCombinedEntries", () => {
  it("attributes_added_lines_to_their_commit", () => {
    const e = buildCombinedEntries(
      combined(
        2,
        [file("f", [hunk(3, 0, 4, 1, [add(4)]), hunk(8, 0, 10, 1, [add(10)])])],
        [[file("f", [hunk(3, 0, 4, 1, [add(4)])])], [file("f", [hunk(9, 0, 10, 1, [add(10)])])]],
      ),
    )[0];
    expect(e.attribution.lineCommit.get("RIGHT:4")).toBe(0);
    expect(e.attribution.lineCommit.get("RIGHT:10")).toBe(1);
    expect(e.attribution.lineCommit.size).toBe(2);
  });

  it("later_step_shifts_earlier_lines", () => {
    const e = buildCombinedEntries(
      combined(
        2,
        [file("f", [hunk(1, 0, 2, 3, [add(2), add(3), add(4)]), hunk(9, 0, 13, 1, [add(13)])])],
        [[file("f", [hunk(9, 0, 10, 1, [add(10)])])], [file("f", [hunk(1, 0, 2, 3, [add(2), add(3), add(4)])])]],
      ),
    )[0];
    expect(e.attribution.lineCommit.get("RIGHT:13")).toBe(0);
    expect(e.attribution.lineCommit.get("RIGHT:2")).toBe(1);
    expect(e.attribution.lineCommit.get("RIGHT:4")).toBe(1);
  });

  it("deleted_base_line_attributed_to_deleter", () => {
    const e = buildCombinedEntries(
      combined(
        2,
        [file("f", [hunk(5, 1, 4, 0, [del(5)])])],
        [[file("f", [hunk(1, 0, 2, 1, [add(2)])])], [file("f", [hunk(6, 1, 5, 0, [del(6)])])]],
      ),
    )[0];
    expect(e.attribution.lineCommit.get("LEFT:5")).toBe(1);
  });

  it("line_added_then_removed_has_no_marker", () => {
    const e = buildCombinedEntries(
      combined(
        2,
        [file("f", [hunk(7, 1, 7, 1, [del(7), add(7)])])],
        [[file("f", [hunk(2, 0, 3, 1, [add(3)])])], [file("f", [hunk(3, 1, 2, 0, [del(3)])]), ]],
      ),
    )[0];
    // net diff has no line from the add/remove pair; only unaligned lines remain
    expect(e.attribution.lineCommit.has("RIGHT:3")).toBe(false);
    expect(e.attribution.lineCommit.size).toBe(0);
  });

  it("rename_moves_the_model", () => {
    const e = buildCombinedEntries(
      combined(
        2,
        [file("b", [hunk(1, 0, 2, 1, [add(2)]), hunk(4, 1, 5, 0, [del(4)])], { status: "renamed", oldPath: "a" })],
        [
          [file("b", [], { status: "renamed", oldPath: "a" })],
          [file("b", [hunk(1, 0, 2, 1, [add(2)]), hunk(4, 1, 4, 0, [del(4)])])],
        ],
      ),
    )[0];
    expect(e.attribution.lineCommit.get("RIGHT:2")).toBe(1);
    expect(e.attribution.lineCommit.get("LEFT:4")).toBe(1);
  });

  it("added_file_starts_empty", () => {
    const e = buildCombinedEntries(
      combined(
        2,
        [file("n", [hunk(0, 0, 1, 3, [add(1), add(2), add(3)])], { status: "added" })],
        [
          [file("n", [hunk(0, 0, 1, 2, [add(1), add(2)])], { status: "added" })],
          [file("n", [hunk(2, 0, 3, 1, [add(3)])])],
        ],
      ),
    )[0];
    expect(e.attribution.lineCommit.get("RIGHT:1")).toBe(0);
    expect(e.attribution.lineCommit.get("RIGHT:2")).toBe(0);
    expect(e.attribution.lineCommit.get("RIGHT:3")).toBe(1);
  });

  it("hunk_commits_are_union", () => {
    const e = buildCombinedEntries(
      combined(
        3,
        [file("f", [hunk(1, 0, 2, 3, [add(2), add(3), add(4)])])],
        [
          [file("f", [hunk(1, 0, 2, 1, [add(2)])])],
          [],
          [file("f", [hunk(1, 0, 2, 1, [add(2)]), hunk(2, 0, 4, 1, [add(4)])])],
        ].map((s) => s as GitDiff[]),
      ),
    )[0];
    // step0: [c0] ; step2 inserts before and after c0 line -> [c2, c0, c2]... net lines 2..4
    expect(e.attribution.hunkCommits).toEqual([[0, 2]]);
  });

  it("unaligned_line_gets_no_marker", () => {
    const e = buildCombinedEntries(
      combined(1, [file("f", [hunk(1, 0, 6, 1, [add(6)])])], [[file("f", [hunk(1, 0, 2, 1, [add(2)])])]]),
    )[0];
    expect(e.attribution.lineCommit.has("RIGHT:6")).toBe(false);
    expect(e.attribution.hunkCommits).toEqual([[]]);
  });

  it("fallback_sections_are_whole_commit", () => {
    const sec = (hash: string, n: number) => ({ hash, diff: file("g", [hunk(1, 1, 1, 1, [del(1), add(n)])]) });
    const entries = buildCombinedEntries(
      combined(3, [], [], [{ path: "g", perCommit: [sec("h2", 1), sec("h0", 1)], blockers: ["b"], conflicted: true }]),
    );
    expect(entries.length).toBe(2);
    expect(entries[0].attribution.sectionCommit).toBe(2);
    expect(entries[0].attribution.lineCommit.get("RIGHT:1")).toBe(2);
    expect(entries[0].attribution.lineCommit.get("LEFT:1")).toBe(2);
    expect(entries[1].attribution.sectionCommit).toBe(0);
    expect(entries[1].fallback).toEqual({ blockers: ["b"], conflicted: true });
  });

  it("fallback_sections_attribute_changed_lines_only", () => {
    const ctx: DiffLine = { type: "context", content: "c", oldLineNo: 1, newLineNo: 1 };
    const entries = buildCombinedEntries(
      combined(1, [], [], [{
        path: "g",
        perCommit: [{ hash: "h0", diff: file("g", [hunk(1, 2, 1, 2, [ctx, del(2), add(2)])]) }],
        blockers: [],
        conflicted: false,
      }]),
    );
    const a = entries[0].attribution;
    expect(a.sectionCommit).toBe(0);
    expect(a.lineCommit.get(lineKeyFor(ctx)!)).toBeUndefined();
    expect(a.lineCommit.get("LEFT:2")).toBe(0);
    expect(a.lineCommit.get("RIGHT:2")).toBe(0);
    expect(a.lineCommit.size).toBe(2);
  });

  it("hunkless_file_is_ignored", () => {
    const e = buildCombinedEntries(combined(2, [file("bin", [])], [[file("bin", [])], []]));
    expect(e[0].attribution.lineCommit.size).toBe(0);
    expect(e[0].attribution.hunkCommits).toEqual([]);
  });
});

describe("lineKeyFor", () => {
  it("keys by side and tolerates missing numbers", () => {
    expect(lineKeyFor(del(3))).toBe("LEFT:3");
    expect(lineKeyFor(add(4))).toBe("RIGHT:4");
    expect(lineKeyFor({ type: "context", content: "", newLineNo: 2 })).toBe("RIGHT:2");
    expect(lineKeyFor({ type: "add", content: "" })).toBeNull();
  });
});
