/**
 * combinedPathsFor — the names a file-history combined diff hands git: the
 * selected versions' own names (resolved from the full --follow log when an
 * entry carries none), every name between the oldest and newest selected
 * versions, and the name just before the oldest (rename pairing).
 */
import { describe, it, expect } from "vitest";
import { combinedPathsFor } from "../combinedPaths";
import type { FileLogEntry } from "../backend";

const H = (c: string) => c.repeat(40);
const entry = (c: string, path?: string): FileLogEntry => ({
  ...(path ? { path } : {}),
  hashFull: H(c), hash: c.repeat(7), author: "Dev", date: "2026-08-01T00:00:00Z", message: `msg ${c}`, body: "",
});
/** Range results and merges carry no `path`. */
const strip = (x: FileLogEntry): FileLogEntry => ({ hashFull: x.hashFull, hash: x.hash, author: x.author, date: x.date, message: x.message, body: "" });
const sorted = (a: string[]) => [...a].sort();

// c is the newest; b and a predate a rename old.txt -> new.txt
const LOG = [entry("c", "new.txt"), entry("b", "old.txt"), entry("a", "old.txt")];

describe("combinedPathsFor", () => {
  it("the union of the selected versions' names (rename)", () => {
    expect(sorted(combinedPathsFor([LOG[0], LOG[1]], LOG, "new.txt"))).toEqual(["new.txt", "old.txt"]);
  });

  it("pre-rename entries without a path resolve their name through the full log", () => {
    expect(sorted(combinedPathsFor([strip(LOG[1]), strip(LOG[2])], LOG, "new.txt"))).toEqual(["new.txt", "old.txt"]);
  });

  it("a rename commit plus a later one carries the pre-rename name too", () => {
    const log = [entry("d", "new.txt"), entry("c", "new.txt"), entry("b", "old.txt")];
    expect(sorted(combinedPathsFor([log[0], log[1]], log, "new.txt"))).toEqual(["new.txt", "old.txt"]);
  });

  it("every name between the oldest and newest selected versions", () => {
    const log = [entry("d", "c.txt"), entry("c", "b.txt"), entry("b", "a.txt"), entry("a", "a.txt")];
    expect(sorted(combinedPathsFor([log[0], log[2]], log, "c.txt"))).toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  it("an entry unnamed and unknown to the full log gets the whole lineage", () => {
    expect(sorted(combinedPathsFor([LOG[0], strip(entry("z"))], LOG, "new.txt"))).toEqual(["new.txt", "old.txt"]);
  });

  it("always includes the viewed file's own name", () => {
    expect(combinedPathsFor([], [], "f.txt")).toEqual(["f.txt"]);
  });

  it("names a file without renames once", () => {
    const log = [entry("b", "f.txt"), entry("a", "f.txt")];
    expect(combinedPathsFor(log, log, "f.txt")).toEqual(["f.txt"]);
  });
});
