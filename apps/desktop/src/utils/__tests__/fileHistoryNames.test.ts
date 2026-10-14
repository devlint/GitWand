import { describe, it, expect } from "vitest";
import type { FileLogEntry } from "../backend";
import { isNameUnknown, nameAtCommit } from "../fileHistoryNames";

const e = (hashFull: string, path?: string): FileLogEntry => ({
  ...(path !== undefined ? { path } : {}),
  hashFull,
  hash: hashFull.slice(0, 7),
  author: "A",
  date: "2024-01-01T00:00:00Z",
  message: hashFull,
  body: "",
});

// Newest first, as `git log --follow` lists it: edited after a rename, the
// rename itself, a merge with no name, then two edits under the old name.
const history = [
  e("b", "new.txt"),
  e("rename", "new.txt"),
  e("merge"),
  e("a2", "old.txt"),
  e("a1", "old.txt"),
];

describe("nameAtCommit", () => {
  it("uses the entry's own name", () => {
    expect(nameAtCommit("a2", history)).toBe("old.txt");
    expect(nameAtCommit("rename", history)).toBe("new.txt");
  });

  it("gives an unnamed merge in the history the name of the nearest older entry", () => {
    // Before the rename: the old name, not the current one.
    expect(nameAtCommit("merge", history)).toBe("old.txt");
  });

  it("falls back to the nearest newer entry when nothing older is named", () => {
    expect(nameAtCommit("root-merge", [e("b", "new.txt"), e("root-merge")])).toBe("new.txt");
  });

  it("uses a name carried by an extra list (pickaxe)", () => {
    expect(nameAtCommit("p", history, [[e("p", "older.txt")]])).toBe("older.txt");
  });

  it("does not guess for a commit outside the loaded history", () => {
    // A line-range result older than the loaded log: no name, no inference.
    const range = [e("r-ancient")];
    expect(nameAtCommit("r-ancient", history, [range])).toBeUndefined();
    expect(nameAtCommit("x", [])).toBeUndefined();
  });
});

describe("isNameUnknown", () => {
  it("is false for anything the loaded history or a named result covers", () => {
    expect(isNameUnknown("merge", history)).toBe(false);
    expect(isNameUnknown("a1", history)).toBe(false);
    expect(isNameUnknown("p", history, [[e("p", "older.txt")]])).toBe(false);
  });

  it("is true for an unnamed commit outside the loaded history", () => {
    expect(isNameUnknown("r-ancient", history, [[e("r-ancient")]])).toBe(true);
  });

  it("is true for an unnamed commit in the history when no neighbour is named", () => {
    expect(isNameUnknown("m", [e("m"), e("m2")])).toBe(true);
  });
});
