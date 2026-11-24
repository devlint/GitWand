import { describe, it, expect } from "vitest";
import { ref } from "vue";
import { useCommitSelection, COMBINE_MAX } from "../useCommitSelection";

let n = 0;
const fresh = () => ref(`/repo/${n++}`);
const hashes = (k: number) => Array.from({ length: k }, (_, i) => `h${i}`);

describe("useCommitSelection", () => {
  it("first toggle seeds with the current commit, then toggles the clicked one", () => {
    const s = useCommitSelection(fresh());
    s.toggle("b", "a");
    expect(s.selected.value).toEqual(["a", "b"]);
    expect(s.anchor.value).toBe("b");
    s.toggle("b", "a");
    expect(s.selected.value).toEqual(["a"]);
  });

  it("never re-seeds a commit the user removed: X, ⌘Y, ⌘X, ⌘Y, ⌘Z → [Z]", () => {
    const s = useCommitSelection(fresh());
    s.clear();
    s.setAnchor("X");
    s.toggle("Y", "X");
    expect(s.selected.value).toEqual(["X", "Y"]);
    s.toggle("X", "X");
    s.toggle("Y", "X");
    expect(s.selected.value).toEqual([]);
    s.toggle("Z", "X");
    expect(s.selected.value).toEqual(["Z"]);
  });

  it("a plain click (clear / setAnchor) seeds the next toggle again; a range counts as seeded", () => {
    const s = useCommitSelection(fresh());
    s.toggle("Y", "X");
    s.clear();
    s.setAnchor("W");
    s.toggle("Y", "W");
    expect(s.selected.value).toEqual(["W", "Y"]);
    s.clear();
    s.range("b", ["a", "b"], "a");
    s.toggle("a", "a");
    s.toggle("b", "a");
    s.toggle("c", "a");
    expect(s.selected.value).toEqual(["c"]);
  });

  it("toggle works without a current commit and toggles off", () => {
    const s = useCommitSelection(fresh());
    s.toggle("a", null);
    expect(s.selected.value).toEqual(["a"]);
    s.toggle("a", null);
    expect(s.selected.value).toEqual([]);
  });

  it("range selects anchor..hash in visibleOrder, either direction, skipping hashes not in it", () => {
    const s = useCommitSelection(fresh());
    s.toggle("c", "a");
    s.range("e", ["a", "b", "c", "d", "e"]);
    expect(s.selected.value).toEqual(["c", "d", "e"]);
    s.range("b", ["a", "b", "x", "c", "d", "e"].filter((h) => h !== "x"));
    expect(s.selected.value).toEqual(["b", "c"]);
    // stale selected hashes absent from visibleOrder are not part of a range
    s.range("d", ["c", "d"]);
    expect(s.selected.value).toEqual(["c", "d"]);
  });

  it("range falls back to the current commit as anchor, and to the clicked row alone", () => {
    const s = useCommitSelection(fresh());
    s.range("c", ["a", "b", "c"], "a");
    expect(s.selected.value).toEqual(["a", "b", "c"]);
    const t = useCommitSelection(fresh());
    t.range("c", ["a", "b", "c"]);
    expect(t.selected.value).toEqual(["c"]);
    t.range("zzz", ["a", "b", "c"]);
    expect(t.selected.value).toEqual(["c"]);
  });

  it("clear empties selection and anchor", () => {
    const s = useCommitSelection(fresh());
    s.toggle("b", "a");
    s.clear();
    expect(s.selected.value).toEqual([]);
    expect(s.anchor.value).toBeNull();
  });

  it("canCombine is true for 2..50 only", () => {
    const s = useCommitSelection(fresh());
    expect(COMBINE_MAX).toBe(50);
    s.toggle("h0", null);
    expect(s.canCombine.value).toBe(false);
    s.toggle("h1", null);
    expect(s.canCombine.value).toBe(true);
    s.clear();
    s.toggle("h0", null);
    s.range("h49", hashes(60));
    expect(s.selected.value).toHaveLength(50);
    expect(s.canCombine.value).toBe(true);
    s.range("h50", hashes(60));
    expect(s.selected.value).toHaveLength(51);
    expect(s.canCombine.value).toBe(false);
  });

  it("keeps state across calls for the same path and isolates paths", () => {
    const p = ref("/same");
    useCommitSelection(p).toggle("b", "a");
    expect(useCommitSelection(ref("/same")).selected.value).toEqual(["a", "b"]);
    expect(useCommitSelection(ref("/other")).selected.value).toEqual([]);
    useCommitSelection(p).clear();
  });

  it("follows the repo path when it changes", () => {
    const p = ref("/r1");
    const s = useCommitSelection(p);
    s.toggle("b", "a");
    p.value = "/r2";
    expect(s.selected.value).toEqual([]);
    p.value = "/r1";
    expect(s.selected.value).toEqual(["a", "b"]);
    s.clear();
  });

  it("prune drops hashes that left the log and a stale anchor", () => {
    const s = useCommitSelection(fresh());
    s.toggle("b", "a");
    s.toggle("c", null);
    s.prune(["a", "c"]);
    expect(s.selected.value).toEqual(["a", "c"]);
    s.prune(["a"]);
    expect(s.anchor.value).toBeNull();
  });

  it("anchor follows plain click / toggle: click, shift, cmd, shift", () => {
    const order = ["a", "b", "c", "d", "e", "f", "g"];
    const s = useCommitSelection(fresh());
    s.setAnchor("b"); // plain click on b
    s.range("d", order, "b");
    expect(s.selected.value).toEqual(["b", "c", "d"]);
    s.toggle("f", "b"); // cmd-click f: anchor moves to f
    expect(s.selected.value).toEqual(["b", "c", "d", "f"]);
    s.range("e", order, "b");
    expect(s.selected.value).toEqual(["e", "f"]);
  });

  it("a stale anchor falls back to the current commit", () => {
    const s = useCommitSelection(fresh());
    s.setAnchor("gone");
    s.range("c", ["a", "b", "c"], "a");
    expect(s.selected.value).toEqual(["a", "b", "c"]);
  });
});
