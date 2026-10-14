/**
 * Git Tree layout cache (#266): the fingerprint and the trunk pin follow ref
 * moves that keep the top commit, and an infinite-scroll append still keeps
 * the pin so rendered rows never jump lanes.
 */
import { describe, it, expect } from "vitest";
import {
  EMPTY_PIN,
  findTrunkHash,
  layoutFingerprint,
  nextTrunkPin,
  refsSignature,
  type GraphRow,
  type TrunkPin,
} from "../graphLayoutPin";

/** Linear history c5 → c1 (top first) with the given decorations. */
function rows(refs: Record<string, string>, names = ["c5", "c4", "c3", "c2", "c1"]): GraphRow[] {
  return names.map((h, i) => ({
    hashFull: h,
    parents: i + 1 < names.length ? [names[i + 1]] : [],
    refs: refs[h] ?? "",
  }));
}

/** What CommitGraph's `layout` computed does on one pass. */
function pass(prev: { fp: string; pin: TrunkPin }, commits: GraphRow[], currentBranch = "main") {
  const sig = refsSignature(commits, prev.pin.rowCount);
  const fp = layoutFingerprint(commits, currentBranch, false, "", sig.full);
  if (fp === prev.fp) return { fp, pin: prev.pin, recomputed: false };
  const pin = nextTrunkPin(prev.pin, commits, commits[0]?.hashFull ?? "", sig);
  return { fp, pin, recomputed: true };
}

const START = { fp: "", pin: EMPTY_PIN };

describe("refsSignature", () => {
  it("covers only decorated rows and splits at the prefix", () => {
    const r = rows({ c5: "HEAD -> main", c2: "tag: v1" });
    const sig = refsSignature(r, 2);
    expect(sig.full).toContain("c5");
    expect(sig.full).toContain("c2");
    expect(sig.prefix).toContain("c5");
    expect(sig.prefix).not.toContain("c2");
    expect(refsSignature(r, 99).prefix).toBe(sig.full);
    expect(refsSignature(r, 0).prefix).toBe("");
  });
});

describe("layout fingerprint + trunk pin", () => {
  it("re-pins the trunk when main is reset onto an older commit and the top stays (case 1)", () => {
    const before = rows({ c5: "HEAD -> main, feature", c3: "origin/main" });
    const a = pass(START, before);
    expect(a.pin.trunkHash).toBe("c5");

    // `git reset --hard origin/main` while `feature` keeps c5 on top.
    const after = rows({ c5: "feature", c3: "HEAD -> main, origin/main" });
    const b = pass(a, after);
    expect(b.recomputed).toBe(true);
    expect(b.pin.trunkHash).toBe("c3");
  });

  it("recomputes the layout on a checkout of a previous branch (case 3)", () => {
    const before = rows({ c5: "HEAD -> feature, main", c3: "old" });
    const a = pass(START, before, "feature");
    const after = rows({ c5: "feature, main", c3: "HEAD -> old" });
    const b = pass(a, after, "feature");
    expect(b.recomputed).toBe(true);
    expect(b.pin.trunkHash).toBe("c5");
  });

  it("re-pins when main lands on a commit of another branch", () => {
    const before = rows({ c5: "HEAD -> main", c4: "topic" });
    const a = pass(START, before);
    expect(a.pin.trunkHash).toBe("c5");
    const after = rows({ c5: "other", c4: "HEAD -> main, topic" });
    const b = pass(a, after);
    expect(b.pin.trunkHash).toBe("c4");
  });

  it("recomputes when a branch is created on an existing commit", () => {
    const before = rows({ c5: "HEAD -> main" });
    const a = pass(START, before);
    const b = pass(a, rows({ c5: "HEAD -> main", c2: "topic" }));
    expect(b.recomputed).toBe(true);
  });

  it("keeps the layout when nothing changed", () => {
    const a = pass(START, rows({ c5: "HEAD -> main" }));
    const b = pass(a, rows({ c5: "HEAD -> main" }));
    expect(b.recomputed).toBe(false);
    expect(b.pin).toBe(a.pin);
  });

  it("keeps the pin across an infinite-scroll append, even if it brings main into view", () => {
    // First page has no main/master → no trunk pinned.
    const page1 = rows({ c5: "HEAD -> feature" }, ["c5", "c4", "c3"]);
    const a = pass(START, page1);
    expect(a.pin.trunkHash).toBeUndefined();

    // Next page appends c2, c1 — c1 carries main.
    const page2 = rows({ c5: "HEAD -> feature", c1: "main" }, ["c5", "c4", "c3", "c2", "c1"]);
    const b = pass(a, page2);
    expect(b.recomputed).toBe(true); // more rows → new layout
    expect(b.pin.trunkHash).toBeUndefined(); // but rendered rows keep their lanes
    expect(b.pin.rowCount).toBe(5);

    // A later ref move among the pinned rows re-detects.
    const c = pass(b, rows({ c5: "HEAD -> feature", c3: "main" }, ["c5", "c4", "c3", "c2", "c1"]));
    expect(c.pin.trunkHash).toBe("c3");
  });

  it("finds origin/main as the trunk", () => {
    expect(findTrunkHash(rows({ c4: "origin/main" }))).toBe("c4");
    expect(findTrunkHash(rows({ c4: "origin/feature" }))).toBeUndefined();
  });
});
