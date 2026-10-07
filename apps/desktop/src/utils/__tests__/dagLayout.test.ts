/**
 * dagLayout.ts — parseRefs() ref-classification tests.
 *
 * Regression coverage for #137: `git branch test/some_experiment` then
 * switching away leaves the branch decorated as the bare name
 * `test/some_experiment` (no `HEAD -> ` prefix, since it isn't checked out).
 * parseRefs() used to classify ANY ref containing `/` as `type: "remote"`
 * on the assumption it must have shape `<remote>/<branch>` — which silently
 * mis-tags a slash-named local branch too. Consumers (CommitGraph.vue) then
 * stripped everything up to the first `/`, truncating `test/some_experiment`
 * down to `some_experiment` for checkout and delete actions.
 *
 * parseRefs() no longer guesses "remote" from the presence of `/` alone —
 * genuine remote refs are only resolved downstream against the real branch
 * list (see CommitGraph.vue's commitRefs()). This file only pins the
 * behavior parseRefs() itself is responsible for: it must not eagerly
 * label a slash-containing name "remote".
 */

import { describe, it, expect } from "vitest";
import { buildLaneIndex, computeDagLayout, mergeLaneIsClear, parseRefs } from "../dagLayout";

describe("parseRefs", () => {
  it("does not classify a slash-containing name as remote by default", () => {
    const parsed = parseRefs("test/some_experiment");
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("test/some_experiment");
    expect(parsed[0].type).not.toBe("remote");
  });

  it("keeps the full name intact for a slash-named ref (no truncation)", () => {
    const parsed = parseRefs("test/some_experiment");
    expect(parsed[0].name).toBe("test/some_experiment");
  });

  it("still classifies a checked-out slash-named branch as branch (HEAD -> prefix)", () => {
    const parsed = parseRefs("HEAD -> test/some_experiment");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({ type: "branch", name: "test/some_experiment" });
  });

  it("classifies a plain (no-slash) name as branch", () => {
    const parsed = parseRefs("main");
    expect(parsed[0]).toEqual({ type: "branch", name: "main" });
  });

  it("still classifies HEAD, tag: and stash markers correctly", () => {
    expect(parseRefs("HEAD")[0]).toEqual({ type: "head", name: "HEAD" });
    expect(parseRefs("tag: v1.0.0")[0]).toEqual({ type: "tag", name: "v1.0.0" });
    expect(parseRefs("refs/stash")[0]).toEqual({ type: "stash", name: "stash" });
  });

  it("parses multiple comma-separated decorations, including a slash-named one", () => {
    const parsed = parseRefs("HEAD -> main, test/some_experiment, tag: v2.0.0");
    const names = parsed.map((r) => r.name);
    expect(names).toContain("main");
    expect(names).toContain("test/some_experiment");
    expect(names).toContain("v2.0.0");
    const experiment = parsed.find((r) => r.name === "test/some_experiment");
    expect(experiment?.type).not.toBe("remote");
  });
});

describe("computeDagLayout — WIP on trunk", () => {
  const commits = [
    { hashFull: "WIP", parents: ["m2"] },
    { hashFull: "m2", parents: ["m1"] },
    { hashFull: "m1", parents: [] },
  ];

  it("pushes WIP off lane 0 when the trunk is pinned from its head", () => {
    const layout = computeDagLayout(commits, "m2");
    expect(layout.nodes[0].lane).toBe(1);
  });

  it("keeps WIP on lane 0 when the trunk chain starts at the WIP node", () => {
    const layout = computeDagLayout(commits, "WIP");
    expect(layout.nodes.map((n) => n.lane)).toEqual([0, 0, 0]);
    expect(layout.maxLane).toBe(0);
  });
});

describe("mergeLaneIsClear", () => {
  function mergeEdge(layout: ReturnType<typeof computeDagLayout>) {
    const e = layout.edges.find((x) => x.isMerge);
    if (!e) throw new Error("no merge edge");
    return e;
  }

  it("is clear when nothing sits in the merged branch's lane before its parent", () => {
    // M merges feature f1 into main; f1 gets its own lane down to a1.
    const layout = computeDagLayout([
      { hashFull: "M", parents: ["a2", "f1"] },
      { hashFull: "a2", parents: ["a1"] },
      { hashFull: "f1", parents: ["a1"] },
      { hashFull: "a1", parents: [] },
    ]);
    const e = mergeEdge(layout);
    expect(e.toLane).not.toBe(e.fromLane);
    expect(mergeLaneIsClear(buildLaneIndex(layout), e)).toBe(true);
  });

  it("is blocked when another commit sits in the parent's lane between the rows", () => {
    // Feature F2 merges m2 from main, but main moved on (m3) — m3 sits on
    // lane 0 between F2 and m2, so a curve into lane 0 would hide where the
    // merge actually lands.
    const layout = computeDagLayout(
      [
        { hashFull: "F2", parents: ["F1", "m2"] },
        { hashFull: "m3", parents: ["m2"] },
        { hashFull: "F1", parents: ["m1"] },
        { hashFull: "m2", parents: ["m1"] },
        { hashFull: "m1", parents: [] },
      ],
      "m3",
    );
    const e = mergeEdge(layout);
    expect(e.toLane).toBe(0);
    expect(mergeLaneIsClear(buildLaneIndex(layout), e)).toBe(false);
  });

  it("is blocked when an edge to another parent runs down the lane", () => {
    const e = { fromIndex: 1, fromLane: 1, toIndex: 4, toLane: 0, isMerge: true };
    const index = buildLaneIndex({
      nodes: [
        { index: 0, hash: "a", parents: ["z"], lane: 0 },
        { index: 1, hash: "b", parents: ["c", "y"], lane: 1 },
        { index: 4, hash: "y", parents: [], lane: 0 },
        { index: 6, hash: "z", parents: [], lane: 0 },
      ],
      edges: [{ fromIndex: 0, fromLane: 0, toIndex: 6, toLane: 0, isMerge: false }, e],
      maxLane: 1,
    });
    expect(mergeLaneIsClear(index, e)).toBe(false);
  });

  it("ignores an edge converging on the same parent", () => {
    const e = { fromIndex: 1, fromLane: 1, toIndex: 4, toLane: 0, isMerge: true };
    const index = buildLaneIndex({
      nodes: [
        { index: 0, hash: "a", parents: ["y"], lane: 0 },
        { index: 1, hash: "b", parents: ["c", "y"], lane: 1 },
        { index: 4, hash: "y", parents: [], lane: 0 },
      ],
      edges: [{ fromIndex: 0, fromLane: 0, toIndex: 4, toLane: 0, isMerge: false }, e],
      maxLane: 1,
    });
    expect(mergeLaneIsClear(index, e)).toBe(true);
  });
});
