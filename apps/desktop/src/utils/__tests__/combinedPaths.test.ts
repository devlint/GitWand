/**
 * combinedPathsFor — the names a file-history combined diff hands git: the
 * selected versions' own names (resolved from the full --follow log when an
 * entry carries none), every name between the oldest and newest selected
 * versions, and the name just before the oldest (rename pairing).
 */
import { describe, it, expect } from "vitest";
import { combinedPathsFor } from "../combinedPaths";
import type { FileLineageEntry, FileLogEntry } from "../backend";

const H = (c: string) => c.repeat(40);
const entry = (c: string, path?: string): FileLogEntry => ({
  ...(path ? { path } : {}),
  hashFull: H(c), hash: c.repeat(7), author: "Dev", date: "2026-08-01T00:00:00Z", message: `msg ${c}`, body: "",
});
/** Range results and merges carry no `path`. */
const strip = (x: FileLogEntry): FileLogEntry => ({ hashFull: x.hashFull, hash: x.hash, author: x.author, date: x.date, message: x.message, body: "" });
const sorted = (a: string[]) => [...a].sort();
/** The full lineage (`getGitFileLineage`) of a log. */
const lin = (log: FileLogEntry[]): FileLineageEntry[] =>
  log.map((x) => ({ hash: x.hashFull, ...(x.path ? { path: x.path } : {}) }));
const paths = (sel: FileLogEntry[], log: FileLogEntry[], file: string) => combinedPathsFor(sel, lin(log), file);

// c is the newest; b and a predate a rename old.txt -> new.txt
const LOG = [entry("c", "new.txt"), entry("b", "old.txt"), entry("a", "old.txt")];

describe("combinedPathsFor", () => {
  it("the union of the selected versions' names (rename)", () => {
    expect(sorted(paths([LOG[0], LOG[1]], LOG, "new.txt"))).toEqual(["new.txt", "old.txt"]);
  });

  it("pre-rename entries without a path resolve their name through the full log", () => {
    expect(sorted(paths([strip(LOG[1]), strip(LOG[2])], LOG, "new.txt"))).toEqual(["new.txt", "old.txt"]);
  });

  it("a rename commit plus a later one carries the pre-rename name too", () => {
    const log = [entry("d", "new.txt"), entry("c", "new.txt"), entry("b", "old.txt")];
    expect(sorted(paths([log[0], log[1]], log, "new.txt"))).toEqual(["new.txt", "old.txt"]);
  });

  it("every name between the oldest and newest selected versions", () => {
    const log = [entry("d", "c.txt"), entry("c", "b.txt"), entry("b", "a.txt"), entry("a", "a.txt")];
    expect(sorted(paths([log[0], log[2]], log, "c.txt"))).toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  it("an entry unnamed and unknown to the full log gets the whole lineage", () => {
    expect(sorted(paths([LOG[0], strip(entry("z"))], LOG, "new.txt"))).toEqual(["new.txt", "old.txt"]);
  });

  it("always includes the viewed file's own name", () => {
    expect(paths([], [], "f.txt")).toEqual(["f.txt"]);
  });

  it("names a file without renames once", () => {
    const log = [entry("b", "f.txt"), entry("a", "f.txt")];
    expect(paths(log, log, "f.txt")).toEqual(["f.txt"]);
  });
  // The viewer loads 50 entries; the lineage is computed from the complete
  // history (fetched at open time), so these must hold past that depth.
  const deep = (n: number, renameAt: number) =>
    Array.from({ length: n }, (_, i) =>
      entry(String.fromCharCode(0x4e00 + i), i <= renameAt ? "new.txt" : "old.txt"),
    );

  it("a rename beyond the first 50 entries is found in the full log", () => {
    const log = deep(80, 69); // entry 69 is the rename commit, 70+ predate it
    const picked = [strip(log[65]), strip(log[75])]; // range results: no path
    expect(sorted(paths(picked, log, "new.txt"))).toEqual(["new.txt", "old.txt"]);
    // With only the first page, that name is out of reach.
    expect(paths(picked, log.slice(0, 50), "new.txt")).toEqual(["new.txt"]);
  });

  it("a rename commit as the 50th entry still pairs with the name before it", () => {
    const log = deep(60, 49);
    expect(sorted(paths([log[0], log[49]], log, "new.txt"))).toEqual(["new.txt", "old.txt"]);
    expect(paths([log[0], log[49]], log.slice(0, 50), "new.txt")).toEqual(["new.txt"]);
  });

  it("a merge (no path) right before the oldest selected one: the name past it pairs the rename", () => {
    // C newest, R renames old.txt -> new.txt, M is a merge, O predates the rename
    const log = [entry("c", "new.txt"), entry("r", "new.txt"), strip(entry("m")), entry("o", "old.txt")];
    expect(sorted(paths([log[0], log[1]], log, "new.txt"))).toEqual(["new.txt", "old.txt"]);
  });

  it("only unnamed entries before the oldest: every lineage name", () => {
    // z.txt is a later name; nothing past R names the file
    const log = [entry("z", "z.txt"), entry("c", "new.txt"), entry("r", "new.txt"), strip(entry("m"))];
    expect(sorted(paths([log[1], log[2]], log, "new.txt"))).toEqual(["new.txt", "z.txt"]);
  });

  it("the oldest selected entry is the first one: nothing before it to add", () => {
    const log = [entry("z", "z.txt"), entry("c", "new.txt"), entry("r", "new.txt")];
    expect(paths([log[1], log[2]], log, "new.txt")).toEqual(["new.txt"]);
  });
});
