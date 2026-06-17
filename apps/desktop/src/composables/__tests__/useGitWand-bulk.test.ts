import { describe, it, expect } from "vitest";
import { resolveAllConflictBlocks } from "../useGitWand";

const THREE = [
  "head",
  "<<<<<<< ours",
  "ours1",
  "=======",
  "theirs1",
  ">>>>>>> theirs",
  "mid",
  "<<<<<<< ours",
  "ours2",
  "=======",
  "theirs2",
  ">>>>>>> theirs",
  "<<<<<<< ours",
  "ours3",
  "=======",
  "theirs3",
  ">>>>>>> theirs",
  "tail",
].join("\n");

const DIFF3 = [
  "<<<<<<< ours",
  "ours1",
  "||||||| base",
  "base1",
  "=======",
  "theirs1",
  ">>>>>>> theirs",
].join("\n");

describe("resolveAllConflictBlocks", () => {
  it("applies 'theirs' to every block and removes all markers", () => {
    const r = resolveAllConflictBlocks(THREE, (b) => b.theirsLines.join("\n"));
    expect(r.total).toBe(3);
    expect(r.applied).toBe(3);
    expect(r.content).toBe(["head", "theirs1", "mid", "theirs2", "theirs3", "tail"].join("\n"));
    expect(r.content).not.toContain("<<<<<<<");
  });

  it("applies 'both' as ours then theirs", () => {
    const r = resolveAllConflictBlocks(THREE, (b) => [...b.oursLines, ...b.theirsLines].join("\n"));
    expect(r.applied).toBe(3);
    expect(r.content).toContain("ours1\ntheirs1");
  });

  it("keeps markers for blocks the resolver skips (returns null)", () => {
    const r = resolveAllConflictBlocks(THREE, (_b, i) => (i === 1 ? null : _b.theirsLines.join("\n")));
    expect(r.total).toBe(3);
    expect(r.applied).toBe(2);
    // block 1 still conflicted, blocks 0 and 2 resolved
    expect(r.content).toContain("<<<<<<< ours\nours2\n=======\ntheirs2\n>>>>>>> theirs");
    expect(r.content).toContain("theirs1");
    expect(r.content).toContain("theirs3");
  });

  it("passes parsed ours/base/theirs lines to the resolver", () => {
    const seen: any[] = [];
    resolveAllConflictBlocks(DIFF3, (b) => { seen.push(b); return null; });
    expect(seen[0]).toEqual({ oursLines: ["ours1"], baseLines: ["base1"], theirsLines: ["theirs1"] });
  });

  it("preserves diff3 base markers when a block is skipped", () => {
    const r = resolveAllConflictBlocks(DIFF3, () => null);
    expect(r.content).toContain("||||||| base");
    expect(r.content).toContain("base1");
    expect(r.applied).toBe(0);
  });

  it("treats an empty replacement as deleting the block's lines", () => {
    const r = resolveAllConflictBlocks(DIFF3, () => "");
    expect(r.applied).toBe(1);
    expect(r.content).toBe("");
  });
});
