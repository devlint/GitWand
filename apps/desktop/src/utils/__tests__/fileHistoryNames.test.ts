import { describe, it, expect } from "vitest";
import type { FileLogEntry } from "../backend";
import { nameAtCommit } from "../fileHistoryNames";

const e = (hashFull: string, date: string, path?: string): FileLogEntry => ({
  ...(path !== undefined ? { path } : {}),
  hashFull,
  hash: hashFull.slice(0, 7),
  author: "A",
  date,
  message: hashFull,
  body: "",
});

// Newest first, as `git log --follow` lists it: edited after a rename, the
// rename itself, a merge with no name, then two edits under the old name.
const history = [
  e("b", "2024-01-05T00:00:00Z", "new.txt"),
  e("rename", "2024-01-04T00:00:00Z", "new.txt"),
  e("merge", "2024-01-03T00:00:00Z"),
  e("a2", "2024-01-02T00:00:00Z", "old.txt"),
  e("a1", "2024-01-01T00:00:00Z", "old.txt"),
];

describe("nameAtCommit", () => {
  it("uses the entry's own name", () => {
    expect(nameAtCommit("a2", history)).toBe("old.txt");
    expect(nameAtCommit("rename", history)).toBe("new.txt");
  });

  it("gives an unnamed merge the name of the nearest older entry", () => {
    // Before the rename: the old name, not the current one.
    expect(nameAtCommit("merge", history)).toBe("old.txt");
  });

  it("falls back to the nearest newer entry when nothing older is named", () => {
    const h = [e("b", "2024-01-02T00:00:00Z", "new.txt"), e("root-merge", "2024-01-01T00:00:00Z")];
    expect(nameAtCommit("root-merge", h)).toBe("new.txt");
  });

  it("uses a name carried by an extra list (pickaxe)", () => {
    expect(nameAtCommit("p", history, [[e("p", "2023-12-01T00:00:00Z", "older.txt")]])).toBe("older.txt");
  });

  it("places a line-range result outside the loaded history by its date", () => {
    const range = [e("r-old", "2024-01-01T12:00:00Z"), e("r-new", "2024-01-04T12:00:00Z"), e("r-ancient", "2020-01-01T00:00:00Z")];
    expect(nameAtCommit("r-old", history, [range])).toBe("old.txt");
    expect(nameAtCommit("r-new", history, [range])).toBe("new.txt");
    // Older than everything loaded: the oldest loaded name.
    expect(nameAtCommit("r-ancient", history, [range])).toBe("old.txt");
  });

  it("returns undefined when nothing is known", () => {
    expect(nameAtCommit("x", [])).toBeUndefined();
    expect(nameAtCommit("x", history)).toBeUndefined();
  });
});
