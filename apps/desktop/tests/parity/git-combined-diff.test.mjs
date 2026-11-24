/**
 * Parity tests: `git_combined_diff` (Rust, `src-tauri/src/combined/`) vs
 * `POST /api/git-combined-diff` (Node dev-server).
 *
 * Run: `pnpm --filter @gitwand/desktop test:parity -- git-combined-diff`
 *
 * Prerequisite: the Rust probe must be built after any change to the engine
 *   cargo build --example parity-probe
 * (see README.md in this folder).
 *
 * The scenarios mirror the Rust unit tests of `combined/replay.rs`: a
 * contiguous range (fast path only), a non-contiguous clean replay (a real
 * `merge-tree` step), an overlap that falls back (conflicted file with its
 * blocker, plus a companion), a `merge=union` attribute (also inside a filter
 * whose step conflicts outside it), a rename that carries a fallback path, a
 * root commit, the `paths` filter, a repository opened from a subdirectory,
 * blockers through a merge (hex-only names), and the error strings of
 * invalid input.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startDevServer } from "./dev-server-runner.mjs";
import { assertParity } from "./harness.mjs";
import { runProbe } from "./probe.mjs";
import { mkTempRepo } from "./fixtures.mjs";

const COMMAND = "git-combined-diff";
const HTTP_PATH = "/api/git-combined-diff";

/** Fixed identity and dates: reproducible hashes, no user config. */
function commitEnv(index) {
  const iso = new Date(Date.UTC(2024, 0, 1, 0, 0, index)).toISOString();
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "GitWand Parity",
    GIT_AUTHOR_EMAIL: "parity@gitwand.test",
    GIT_AUTHOR_DATE: iso,
    GIT_COMMITTER_NAME: "GitWand Parity",
    GIT_COMMITTER_EMAIL: "parity@gitwand.test",
    GIT_COMMITTER_DATE: iso,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
}

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();

/** One commit from `{ path: content | null }` (null removes); returns its hash. */
function commitFiles(cwd, files, message, index) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(cwd, rel);
    if (content === null) rmSync(abs, { recursive: true, force: true });
    else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf-8");
    }
  }
  execFileSync("git", ["-C", cwd, "add", "-A"]);
  execFileSync("git", ["-C", cwd, "commit", "-q", "-m", message], { env: commitEnv(index) });
  return git(cwd, ["rev-parse", "HEAD"]);
}

const ten = (prefix) => Array.from({ length: 10 }, (_, i) => `${prefix}${i + 1}\n`).join("");

describe("parity: git-combined-diff", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;
  const repos = [];
  const repo = (label) => {
    const cwd = mkTempRepo(`gw-parity-combined-${label}-`);
    repos.push(cwd);
    return cwd;
  };

  beforeAll(async () => {
    dev = await startDevServer();
  }, 15_000);

  afterAll(async () => {
    await dev?.stop();
    for (const cwd of repos) rmSync(cwd, { recursive: true, force: true });
  });

  const parity = (cwd, hashes, paths) => {
    const args = paths === undefined ? { cwd, hashes } : { cwd, hashes, paths };
    return assertParity(dev, { command: COMMAND, args, httpPath: HTTP_PATH, method: "POST", body: args });
  };

  it("contiguous selection equals the range diff (fast path only)", async () => {
    const cwd = repo("contig");
    commitFiles(cwd, { "base.txt": "base\n" }, "base", 0);
    const a = commitFiles(cwd, { f: "1\n", g: "g\n" }, "A", 1);
    const b = commitFiles(cwd, { f: "2\n", h: "h\n" }, "B", 2);
    const { rust } = await parity(cwd, [b, a]);
    expect(rust.commits.map((c) => c.hash)).toEqual([a, b]);
    expect(rust.diffs.map((d) => d.path)).toEqual(["f", "g", "h"]);
    expect(rust.fallback).toEqual([]);
    expect(rust.steps).toHaveLength(2);
  });

  it("non-contiguous clean selection goes through merge-tree", async () => {
    const cwd = repo("noncontig");
    commitFiles(cwd, { f: ten("l"), g: "g\n" }, "base", 0);
    const f1 = ten("l").replace("l1\n", "A1\n");
    const a = commitFiles(cwd, { f: f1 }, "A", 1);
    commitFiles(cwd, { g: "g2\n" }, "B", 2);
    const c = commitFiles(cwd, { f: f1.replace("l10\n", "C10\n") }, "C", 3);
    const { rust } = await parity(cwd, [a, c]);
    expect(rust.diffs.map((d) => d.path)).toEqual(["f"]);
    expect(rust.fallback).toEqual([]);
    expect(rust.steps[1].map((d) => d.path)).toEqual(["f"]);
  });

  it("an overlap falls back with its blocker; a companion is not conflicted", async () => {
    const cwd = repo("overlap");
    commitFiles(cwd, { f: "a\nx=1\nc\n" }, "base", 0);
    const a = commitFiles(cwd, { f: "a\nx=2\nc\n" }, "A", 1);
    const b = commitFiles(cwd, { f: "a\nx=3\nc\n" }, "B", 2);
    const c = commitFiles(cwd, { f: "a\nx=4\nc\ne\n", g: "g\n" }, "C", 3);
    const { rust } = await parity(cwd, [a, c]);
    expect(rust.diffs).toEqual([]);
    const byPath = Object.fromEntries(rust.fallback.map((x) => [x.path, x]));
    expect(Object.keys(byPath)).toEqual(["f", "g"]);
    expect(byPath.f.conflicted).toBe(true);
    expect(byPath.f.blockers).toEqual([b]);
    expect(byPath.f.perCommit.map((p) => p.hash)).toEqual([a, c]);
    expect(byPath.g.conflicted).toBe(false);
    expect(byPath.g.blockers).toEqual([]);
    expect(rust.steps.flat()).toEqual([]);
  });

  // replay.rs `blocker_behind_an_earlier_selected_commit_is_named`: B1 sits
  // behind C2 but its change is not in the replayed tree.
  it("a blocker behind an earlier selected commit is still named", async () => {
    const cwd = repo("earlierblocker");
    commitFiles(cwd, { p: "a\nx=1\nc\n" }, "base", 0);
    const c1 = commitFiles(cwd, { p: "a\nx=2\nc\n" }, "C1", 1);
    const b1 = commitFiles(cwd, { p: "a\nx=3\nc\n" }, "B1", 2);
    const c2 = commitFiles(cwd, { q: "q\n" }, "C2", 3);
    commitFiles(cwd, { o: "o\n" }, "B2", 4);
    const c3 = commitFiles(cwd, { p: "a\nx=4\nc\ne\n" }, "C3", 5);
    const { rust } = await parity(cwd, [c1, c2, c3]);
    const p = rust.fallback.find((f) => f.path === "p");
    expect(p.conflicted).toBe(true);
    expect(p.blockers).toEqual([b1]);
  });

  // replay.rs `blocker_already_in_the_replay_base_is_named`: selected commits
  // on two branches; U (unselected) is in the replay base (Y^) but not under
  // X^, and X's conflict on `f` comes from it.
  it("a blocker already in the replay base is named", async () => {
    const cwd = repo("baseblocker");
    commitFiles(cwd, { f: "x=1\n" }, "M", 0);
    git(cwd, ["checkout", "-q", "-b", "b2"]);
    const u = commitFiles(cwd, { f: "x=2\n" }, "U", 1);
    const y = commitFiles(cwd, { g: "g\n" }, "Y", 2);
    git(cwd, ["checkout", "-q", "main"]);
    git(cwd, ["checkout", "-q", "-b", "b1"]);
    const x = commitFiles(cwd, { f: "x=3\n" }, "X", 3);
    const { rust } = await parity(cwd, [x, y]);
    expect(rust.base).toBe(u);
    const f = rust.fallback.find((e) => e.path === "f");
    expect(f.conflicted).toBe(true);
    expect(f.blockers).toEqual([u]);
  });

  it("a merge=union attribute sends the file to the fallback as a companion", async () => {
    const cwd = repo("union");
    commitFiles(cwd, { ".gitattributes": "f merge=union\n", f: "a\nx=1\nc\n", g: "g\n" }, "base", 0);
    const a = commitFiles(cwd, { g: "g2\n" }, "A", 1);
    commitFiles(cwd, { f: "a\nx=2\nc\n" }, "B", 2);
    const c = commitFiles(cwd, { f: "a\nx=3\nc\n" }, "C", 3);
    const { rust } = await parity(cwd, [a, c]);
    expect(rust.diffs.map((d) => d.path)).toEqual(["g"]);
    expect(rust.fallback.map((x) => [x.path, x.conflicted])).toEqual([["f", false]]);
  });

  // replay.rs `subdirectory_cwd_reads_from_the_toplevel`: opened from `sub/`,
  // every command runs from the toplevel; `/sub/x.txt merge=union` applies and
  // root-relative `paths` match.
  it("a repository opened from a subdirectory replays from its toplevel", async () => {
    const cwd = repo("subdir");
    commitFiles(cwd, { ".gitattributes": "/sub/x.txt merge=union\n", "sub/x.txt": "a\nx=1\nc\n", "sub/g": "g\n" }, "base", 0);
    const a = commitFiles(cwd, { "sub/g": "g2\n" }, "A", 1);
    commitFiles(cwd, { "sub/x.txt": "a\nx=2\nc\n" }, "B", 2);
    const c = commitFiles(cwd, { "sub/x.txt": "a\nx=3\nc\n" }, "C", 3);
    const sub = join(cwd, "sub");
    const fromRoot = await parity(cwd, [a, c]);
    const { rust } = await parity(sub, [a, c]);
    expect(rust).toEqual(fromRoot.rust);
    expect(rust.diffs.map((d) => d.path)).toEqual(["sub/g"]);
    expect(rust.fallback.map((x) => x.path)).toEqual(["sub/x.txt"]);
    const filtered = await parity(sub, [a, c], ["sub/x.txt"]);
    expect(filtered.rust.fallback.map((x) => x.path)).toEqual(["sub/x.txt"]);
  });

  // replay.rs `union_in_filter_falls_back_when_the_step_conflicts_outside_it`:
  // the step conflicts only outside the filter (`other`), yet the in-filter
  // `merge=union` file still goes through the merge-driver check.
  it("a merge=union file in the filter falls back when the step conflicts outside it", async () => {
    const cwd = repo("unionfilter");
    commitFiles(cwd, { ".gitattributes": "x.txt merge=union\n", "x.txt": "a\nx=1\nc\n", other: "a\nx=1\nc\n" }, "base", 0);
    const a = commitFiles(cwd, { other: "a\nx=2\nc\n" }, "A", 1);
    commitFiles(cwd, { "x.txt": "a\nx=2\nc\n", other: "a\nx=3\nc\n" }, "B", 2);
    const c = commitFiles(cwd, { "x.txt": "a\nx=3\nc\n", other: "a\nx=4\nc\n" }, "C", 3);
    const { rust } = await parity(cwd, [a, c], ["x.txt"]);
    expect(rust.diffs).toEqual([]);
    expect(rust.fallback.map((x) => [x.path, x.conflicted])).toEqual([["x.txt", false]]);
  });

  // replay.rs `blockers_through_a_merge_in_the_range`: a merge record has no
  // `\n` before its names; names of hex digits only are never read as hashes.
  it("blockers through a merge in the range, hex-only names included", async () => {
    const cwd = repo("mergeblockers");
    const names = ["notes.txt", "cafe", "f"];
    const all = (content) => Object.fromEntries(names.map((n) => [n, content]));
    commitFiles(cwd, all("a\nx=1\nc\n"), "base", 0);
    const a = commitFiles(cwd, all("a\nx=2\nc\n"), "A", 1);
    git(cwd, ["checkout", "-q", "-b", "side"]);
    commitFiles(cwd, all("a\nx=3\nc\n"), "S", 2);
    git(cwd, ["checkout", "-q", "main"]);
    commitFiles(cwd, { g: "g\n" }, "M1", 3);
    try {
      execFileSync("git", ["-C", cwd, "merge", "-q", "--no-ff", "--no-commit", "side"], { env: commitEnv(4), stdio: "ignore" });
    } catch {
      // conflicted: resolved below
    }
    commitFiles(cwd, all("a\nx=7\nc\n"), "M", 4);
    const c = commitFiles(cwd, all("a\nx=8\nc\ne\n"), "C", 5);
    const { rust } = await parity(cwd, [a, c]);
    const perPath = (path) =>
      git(cwd, ["rev-list", "--full-history", "--max-count", "5", `${c}^`, "--not", `${a}^`, a, "--", path]).split("\n");
    for (const n of names) {
      const f = rust.fallback.find((x) => x.path === n);
      expect(f.conflicted).toBe(true);
      expect(f.blockers).toHaveLength(2);
      expect(f.blockers).toEqual(perPath(n));
    }
  });

  it("a merge=text attribute is the built-in text merge: the file stays net", async () => {
    const cwd = repo("textattr");
    commitFiles(cwd, { ".gitattributes": "f merge=text\n", f: ten("l"), g: "g\n" }, "base", 0);
    const f1 = ten("l").replace("l1\n", "A1\n");
    const a = commitFiles(cwd, { f: f1 }, "A", 1);
    commitFiles(cwd, { g: "g2\n" }, "B", 2);
    const c = commitFiles(cwd, { f: f1.replace("l10\n", "C10\n") }, "C", 3);
    const { rust } = await parity(cwd, [a, c]);
    expect(rust.diffs.map((d) => d.path)).toEqual(["f"]);
    expect(rust.fallback).toEqual([]);
  });

  it("a clean rename of a fallback path keeps both names in the fallback", async () => {
    const cwd = repo("rename");
    commitFiles(cwd, { keep: "k\n" }, "base", 0);
    const a = commitFiles(cwd, { p: ten("l") }, "A", 1);
    commitFiles(cwd, { p: ten("l").replace("l5\n", "B5\n") }, "B", 2);
    const c = commitFiles(cwd, { p: ten("l").replace("l5\n", "C5\n") }, "C", 3);
    git(cwd, ["mv", "p", "p2"]);
    execFileSync("git", ["-C", cwd, "commit", "-q", "-m", "D"], { env: commitEnv(4) });
    const d = git(cwd, ["rev-parse", "HEAD"]);
    const { rust } = await parity(cwd, [a, c, d]);
    expect(rust.diffs.map((x) => x.path)).toEqual([]);
    expect(rust.fallback.map((x) => x.path)).toEqual(["p", "p2"]);
  });

  it("a root commit replays onto the empty tree, and the paths filter applies", async () => {
    const cwd = repo("root");
    const r = commitFiles(cwd, { f: "1\n", g: "1\n" }, "root", 0);
    commitFiles(cwd, { f: "2\n" }, "mid", 1);
    const c = commitFiles(cwd, { g: "2\n", h: "h\n" }, "C", 2);
    const { rust } = await parity(cwd, [r, c]);
    expect(rust.base).toBeNull();
    expect(rust.diffs.map((x) => x.path)).toEqual(["f", "g", "h"]);
    const filtered = await parity(cwd, [r, c], ["g"]);
    expect(filtered.rust.diffs.map((x) => x.path)).toEqual(["g"]);
  });

  // replay.rs `out_of_filter_conflict_leaves_in_filter_files_net`: a conflict
  // on README, outside the filter, leaves the clean in-filter X net.
  it("a conflict outside the paths filter leaves in-filter files net", async () => {
    const cwd = repo("filterconflict");
    commitFiles(cwd, { X: ten("l"), README: "a\nx=1\nc\n" }, "base", 0);
    const x1 = ten("l").replace("l1\n", "A1\n");
    const a = commitFiles(cwd, { X: x1, README: "a\nx=2\nc\n" }, "A", 1);
    commitFiles(cwd, { README: "a\nx=3\nc\n" }, "B", 2);
    const c = commitFiles(cwd, { X: x1.replace("l10\n", "C10\n"), README: "a\nx=4\nc\n" }, "C", 3);
    const { rust } = await parity(cwd, [a, c], ["X"]);
    expect(rust.diffs.map((d) => d.path)).toEqual(["X"]);
    expect(rust.fallback).toEqual([]);
    const all = await parity(cwd, [a, c]);
    expect(all.rust.fallback.map((f) => f.path)).toEqual(["README", "X"]);
  });

  // replay.rs `a_repeat_conflict_still_brings_companions`.
  it("a step that conflicts again on a fallback path still brings its companions", async () => {
    const cwd = repo("repeat");
    const f = (x, y) => `a\nx=${x}\nb\nc\nd\ne\ny=${y}\nz\n`;
    commitFiles(cwd, { f: f(1, 1) }, "base", 0);
    const a = commitFiles(cwd, { f: f(2, 1) }, "A", 1);
    commitFiles(cwd, { f: f(3, 1) }, "B", 2);
    const c = commitFiles(cwd, { f: f(4, 1) }, "C", 3);
    commitFiles(cwd, { f: f(4, 2) }, "D", 4);
    const e = commitFiles(cwd, { f: f(4, 3), g: "g\n" }, "E", 5);
    const { rust } = await parity(cwd, [a, c, e]);
    expect(rust.fallback.map((x) => x.path)).toEqual(["f", "g"]);
    expect(rust.diffs).toEqual([]);
  });

  // replay.rs `out_of_filter_conflict_renamed_into_the_filter_falls_back`.
  it("an out-of-filter conflict renamed into the filter falls back there", async () => {
    const cwd = repo("filterrename");
    commitFiles(cwd, { README: ten("l"), g: "g\n" }, "base", 0);
    const a = commitFiles(cwd, { README: ten("l").replace("l5\n", "A\n") }, "A", 1);
    const b = commitFiles(cwd, { README: ten("l").replace("l5\n", "B\n") }, "B", 2);
    const c = commitFiles(cwd, { README: ten("l").replace("l5\n", "C\n") }, "C", 3);
    git(cwd, ["mv", "README", "X"]);
    execFileSync("git", ["-C", cwd, "commit", "-q", "-m", "D"], { env: commitEnv(4) });
    const d = git(cwd, ["rev-parse", "HEAD"]);
    const { rust } = await parity(cwd, [a, c, d], ["X"]);
    expect(rust.diffs).toEqual([]);
    expect(rust.fallback.map((f) => [f.path, f.conflicted, f.blockers])).toEqual([["X", true, [b]]]);
  });

  // replay.rs `batched_blockers_match_the_per_path_query` and
  // `blockers_of_many_conflicts_span_batches`: one walk per batch, the newest
  // five per path, every path of several batches answered.
  it("blockers come from batched walks, newest five per path", async () => {
    const cwd = repo("blockers");
    const v = (n) => `a\nx=${n}\nc\n`;
    const long = Array.from({ length: 40 }, (_, i) => `dir/${String(i).padStart(3, "0")}${"n".repeat(250)}`);
    const all = (content) => Object.fromEntries(long.map((n) => [n, content]));
    commitFiles(cwd, { p: v(1), q: v(1), ...all(v(1)) }, "base", 0);
    const a = commitFiles(cwd, { p: v(2), q: v(2), ...all(v(2)) }, "A", 1);
    commitFiles(cwd, { p: v(3), ...all(v(3)) }, "U1", 2);
    commitFiles(cwd, { q: v(3) }, "U2", 3);
    commitFiles(cwd, { p: v(4), q: v(4) }, "U3", 4);
    for (let n = 5; n < 10; n++) commitFiles(cwd, { p: v(n) }, `U${n}`, n);
    const c = commitFiles(cwd, { p: "a\nx=10\nc\ne\n", q: "a\nx=10\nc\ne\n", ...all(v(10)) }, "C", 10);
    const { rust } = await parity(cwd, [a, c]);
    const perPath = (path) =>
      git(cwd, ["rev-list", "--max-count", "5", `${c}^`, "--not", `${a}^`, a, "--", path]).split("\n");
    const byPath = Object.fromEntries(rust.fallback.map((f) => [f.path, f.blockers]));
    expect(byPath.p).toEqual(perPath("p"));
    expect(byPath.p).toHaveLength(5);
    expect(byPath.q).toEqual(perPath("q"));
    for (const n of long) expect(byPath[n]).toEqual(perPath(n));
  }, 60_000);

  it("a file over 5 MB is truncated and leaves every step", async () => {
    const cwd = repo("big");
    commitFiles(cwd, { keep: "k\n" }, "base", 0);
    const big = Array.from({ length: 700_000 }, (_, i) => `line ${i}\n`).join("");
    const a = commitFiles(cwd, { "big.txt": big }, "A", 1);
    const c = commitFiles(cwd, { "big.txt": big.replace("line 5\n", "five\n") }, "C", 2);
    const d = commitFiles(cwd, { "t.txt": "t\n" }, "D", 3);
    const { rust } = await parity(cwd, [a, c, d]);
    const entry = rust.diffs.find((x) => x.path === "big.txt");
    expect(entry.truncatedFromBytes).toBeGreaterThan(5 * 1024 * 1024);
    expect(entry.hunks).toEqual([]);
    expect(rust.budgetOmitted).toEqual([]);
    expect(rust.steps.flat().map((x) => x.path)).toEqual(["t.txt"]);
  }, 60_000);

  // replay.rs `binary_step_drops_every_step_of_that_file`: text → binary →
  // text; the binary entries carry no hunk, so `f` loses every step. A pure
  // rename and a mode change (same blob) keep theirs.
  it("a binary step drops every step of that file", async () => {
    const cwd = repo("binarystep");
    commitFiles(cwd, { f: ten("l"), g: "g\n", m: "m\n" }, "base", 0);
    const a = commitFiles(cwd, { f: "bin\0ary\n" }, "A", 1);
    const b = commitFiles(cwd, { f: ten("l").replace("l3\n", "B3\n") }, "B", 2);
    const c = commitFiles(cwd, { g: "g2\n" }, "C", 3);
    git(cwd, ["mv", "g", "g2"]);
    git(cwd, ["update-index", "--chmod=+x", "m"]);
    execFileSync("git", ["-C", cwd, "commit", "-q", "-m", "D"], { env: commitEnv(4) });
    const d = git(cwd, ["rev-parse", "HEAD"]);
    const { rust } = await parity(cwd, [a, b, c, d]);
    expect(rust.diffs.find((x) => x.path === "f").hunks.length).toBeGreaterThan(0);
    expect(rust.steps.map((s) => s.map((x) => x.path).sort())).toEqual([[], [], ["g"], ["g2", "m"]]);
  });

  // A truncated step under an earlier name (`p`) drops the steps of every
  // name the file takes later (`q`), through the renames of the steps and
  // of the net diff: C and D each stay under the cap, the net is small.
  it("a truncated step drops every name of a renamed file", async () => {
    const cwd = repo("bigrename");
    const head = Array.from({ length: 20 }, (_, i) => `keep ${i}\n`).join("");
    const half1 = Array.from({ length: 175_000 }, (_, i) => `block one ${i}\n`).join("");
    const half2 = Array.from({ length: 175_000 }, (_, i) => `block two ${i}\n`).join("");
    commitFiles(cwd, { p: head, g: "g\n" }, "base", 0);
    const a = commitFiles(cwd, { p: head + half1 + half2 }, "A", 1);
    const b = commitFiles(cwd, { p: null, q: head + half1 + half2 }, "B", 2);
    const c = commitFiles(cwd, { q: head + half2 }, "C", 3);
    const d = commitFiles(cwd, { q: `${head}end\n` }, "D", 4);
    const { rust } = await parity(cwd, [a, b, c, d]);
    const net = rust.diffs.find((x) => x.path === "q");
    expect(net.oldPath).toBe("p");
    expect(net.truncatedFromBytes).toBeUndefined();
    expect(rust.steps.flat().map((x) => x.path)).toEqual([]);
  }, 60_000);

  // Names a split on ` b/` misreads and names git C-quotes: A `1→2`, B
  // `2→3` (unselected), C deletes. Each falls back under its real name with
  // its blocker; none reaches the net view.
  const ODD = ["plan b/f.txt", 'we"ird.txt', "ta\tb.txt", "back\\slash.txt", "é.txt"];
  const oddSet = (content) => Object.fromEntries(ODD.map((n) => [n, content]));

  it.skipIf(process.platform === "win32")("odd file names fall back under their real name", async () => {
    const cwd = repo("oddnames");
    commitFiles(cwd, oddSet("1\n"), "base", 0);
    const a = commitFiles(cwd, oddSet("2\n"), "A", 1);
    const b = commitFiles(cwd, oddSet("3\n"), "B", 2);
    const c = commitFiles(cwd, oddSet(null), "C", 3);
    const { rust } = await parity(cwd, [a, c]);
    expect(rust.diffs).toEqual([]);
    expect(rust.fallback.map((f) => f.path).sort()).toEqual([...ODD].sort());
    for (const f of rust.fallback) {
      expect(f.conflicted).toBe(true);
      expect(f.blockers).toEqual([b]);
      expect(f.perCommit.map((p) => [p.hash, p.diff.path])).toEqual([[a, f.path], [c, f.path]]);
    }
  });

  it.skipIf(process.platform === "win32")("odd file names replay cleanly under their real name", async () => {
    const cwd = repo("oddclean");
    const f1 = ten("l").replace("l1\n", "A1\n");
    commitFiles(cwd, oddSet(ten("l")), "base", 0);
    const a = commitFiles(cwd, oddSet(f1), "A", 1);
    commitFiles(cwd, { other: "o\n" }, "B", 2);
    const c = commitFiles(cwd, oddSet(f1.replace("l10\n", "C10\n")), "C", 3);
    const { rust } = await parity(cwd, [a, c]);
    expect(rust.diffs.map((d) => d.path).sort()).toEqual([...ODD].sort());
    expect(rust.fallback).toEqual([]);
    expect(rust.steps[1].map((d) => d.path).sort()).toEqual([...ODD].sort());
  });

  // A conflicting commit that also adds 60 long paths (~800 bytes each): they
  // all fall back as companions, ~48 KB of names — more than a Windows argv
  // (32 KB) and several 7 KB pathspec batches. The per-commit diffs list them
  // in the same batches on both sides. Kept small: a few seconds per backend.
  it("many long fallback paths are diffed in argv-sized batches", async () => {
    const cwd = repo("argv");
    const dir = ["d".repeat(200), "e".repeat(200), "f".repeat(200)].join("/");
    const names = Array.from({ length: 60 }, (_, i) => `${dir}/${String(i).padStart(5, "0")}${"n".repeat(190)}`);
    // replay.rs `PATHSPEC_BATCH_BYTES`: name + NUL per path, 7 KB per batch.
    const bytes = names.reduce((n, p) => n + Buffer.byteLength(p) + 1, 0);
    expect(bytes).toBeGreaterThan(32 * 1024);
    expect(Math.floor(bytes / (7 * 1024))).toBeGreaterThan(2);
    commitFiles(cwd, { "c.txt": "1\n" }, "base", 0);
    const a = commitFiles(cwd, { "c.txt": "2\n" }, "A", 1);
    commitFiles(cwd, { "c.txt": "3\n" }, "B", 2);
    const c = commitFiles(cwd, { ...Object.fromEntries(names.map((n) => [n, "x\n"])), "c.txt": "4\n" }, "C", 3);
    const { rust } = await parity(cwd, [a, c]);
    expect(rust.fallback).toHaveLength(names.length + 1);
    expect(rust.fallback.every((f) => f.perCommit.length > 0)).toBe(true);
  }, 30_000);

  // replay.rs `fallback_diffs_go_in_pathspec_batches`: 120 names of ~250
  // bytes plus a rename span several 7 KB batches; the rename keeps its pair.
  it("a rename among many fallback paths keeps its pair across batches", async () => {
    const cwd = repo("batches");
    const names = Array.from({ length: 120 }, (_, i) => `dir/${String(i).padStart(5, "0")}${"n".repeat(240)}`);
    commitFiles(cwd, { "c.txt": "1\n", "old.txt": ten("o") }, "base", 0);
    const a = commitFiles(cwd, { "c.txt": "2\n" }, "A", 1);
    commitFiles(cwd, { "c.txt": "3\n" }, "B", 2);
    git(cwd, ["mv", "old.txt", "new.txt"]);
    const c = commitFiles(cwd, { ...Object.fromEntries(names.map((n) => [n, "x\n"])), "c.txt": "4\n" }, "C", 3);
    const { rust } = await parity(cwd, [a, c]);
    expect(rust.fallback).toHaveLength(names.length + 2);
    expect(rust.fallback.find((f) => f.path === "new.txt").perCommit[0].diff.oldPath).toBe("old.txt");
  }, 60_000);

  // The 16 MB total budget, shrunk through the test hook read by both the
  // probe and the dev server: same files lose their steps, same entries go
  // header-only, same `truncated` flag.
  it("the payload budget cuts the same steps and entries on both sides", async () => {
    const cwd = repo("budget");
    commitFiles(cwd, { keep: "k\n" }, "base", 0);
    const a = commitFiles(cwd, { "small.txt": "s\n", "old.txt": ten("o") }, "A", 1);
    commitFiles(cwd, { keep: "k2\n" }, "B", 2);
    git(cwd, ["mv", "old.txt", "new.txt"]);
    const c = commitFiles(cwd, { "large.txt": ten("large line "), "new.txt": ten("o").replace("o3\n", "C3\n") }, "C", 3);
    // Weights count 256 bytes per entry and 64 per line on top of content:
    // 4 699 in all. At 3 000: the old.txt→new.txt file (1 305, one file
    // through the rename) then large.txt (1 017) lose their steps → 2 377,
    // under. At 0: every step goes, then every entry turns header-only.
    for (const budget of ["3000", "0"]) {
      const env = { GITWAND_COMBINED_BUDGET_BYTES: budget };
      const small = await startDevServer({ env });
      try {
        const args = { cwd, hashes: [a, c] };
        const { rust } = await assertParity(small, {
          command: COMMAND, args, httpPath: HTTP_PATH, method: "POST", body: args, probeEnv: env,
        });
        expect(rust.truncated).toBe(true);
        if (budget === "0") {
          expect(rust.steps.flat()).toEqual([]);
          expect(rust.diffs.every((d) => d.hunks.length === 0 && d.truncatedFromBytes > 0)).toBe(true);
          expect(rust.budgetOmitted).toEqual(rust.diffs.map((d) => ({ path: d.path, commit: null })).sort((x, y) => (x.path < y.path ? -1 : 1)));
          expect(rust.budgetOmitted.length).toBeGreaterThan(0);
        } else {
          expect(rust.steps.flat().map((d) => d.path)).toEqual(["small.txt"]);
          expect(rust.budgetOmitted).toEqual([]);
        }
      } finally {
        await small.stop();
      }
    }
    const { rust } = await parity(cwd, [a, c]);
    expect(rust.truncated).toBe(false);
    expect(rust.budgetOmitted).toEqual([]);
  }, 30_000);

  // budget.rs `many_short_lines_trigger_the_budget`: 3 000 one-byte lines are
  // 6 KB of content but ~200 KB of payload; a 100 KB budget cuts them.
  it("many short lines count their per-line overhead on both sides", async () => {
    const cwd = repo("shortlines");
    commitFiles(cwd, { keep: "k\n" }, "base", 0);
    const a = commitFiles(cwd, { "many.txt": "x\n".repeat(3000) }, "A", 1);
    commitFiles(cwd, { keep: "k2\n" }, "B", 2);
    const c = commitFiles(cwd, { "t.txt": "t\n" }, "C", 3);
    const env = { GITWAND_COMBINED_BUDGET_BYTES: "100000" };
    const small = await startDevServer({ env });
    try {
      const args = { cwd, hashes: [a, c] };
      const { rust } = await assertParity(small, {
        command: COMMAND, args, httpPath: HTTP_PATH, method: "POST", body: args, probeEnv: env,
      });
      expect(rust.truncated).toBe(true);
      const many = rust.diffs.find((d) => d.path === "many.txt");
      expect(many.hunks).toEqual([]);
      expect(many.truncatedFromBytes).toBe(3000 * 65);
      expect(rust.budgetOmitted).toEqual([{ path: "many.txt", commit: null }]);
    } finally {
      await small.stop();
    }
  }, 30_000);

  // budget.rs `omitted_entries_name_the_per_commit_section`: a cut fallback
  // section is listed by its commit, a net entry with a null commit.
  it("budget-omitted entries name their per-commit section on both sides", async () => {
    const cwd = repo("budgetsections");
    commitFiles(cwd, { f: "a\nx=1\nc\n", g: "g\n" }, "base", 0);
    const a = commitFiles(cwd, { f: "a\nx=2\nc\n", g: "g2\n" }, "A", 1);
    commitFiles(cwd, { f: "a\nx=3\nc\n" }, "B", 2);
    const c = commitFiles(cwd, { f: "a\nx=4\nc\ne\n" }, "C", 3);
    const env = { GITWAND_COMBINED_BUDGET_BYTES: "0" };
    const small = await startDevServer({ env });
    try {
      const args = { cwd, hashes: [a, c] };
      const { rust } = await assertParity(small, {
        command: COMMAND, args, httpPath: HTTP_PATH, method: "POST", body: args, probeEnv: env,
      });
      expect(rust.budgetOmitted).toEqual([
        { path: "f", commit: a < c ? a : c },
        { path: "f", commit: a < c ? c : a },
        { path: "g", commit: null },
      ]);
    } finally {
      await small.stop();
    }
  }, 30_000);

  /** One commit built in the index only, names as bytes (`update-index -z --index-info`). */
  function commitIndex(cwd, files, message, index) {
    const parts = [];
    for (const [name, content] of files) {
      const blob = execFileSync("git", ["-C", cwd, "hash-object", "-w", "--stdin"], { input: content }).toString().trim();
      parts.push(Buffer.from(`100644 ${blob}\t`), name, Buffer.from([0]));
    }
    execFileSync("git", ["-C", cwd, "update-index", "-z", "--index-info"], { input: Buffer.concat(parts) });
    execFileSync("git", ["-C", cwd, "commit", "-q", "-m", message], { env: commitEnv(index) });
    return git(cwd, ["rev-parse", "HEAD"]);
  }

  // replay.rs `non_utf8_*`: a name that is not UTF-8 is refused with the same
  // escaped message, whether it first shows up in a tree diff or in
  // `merge-tree`'s conflicted list. Built in the index: no filesystem has to
  // accept the name.
  it("a file name that is not UTF-8 is refused the same way on both sides", async () => {
    const expectError = async (cwd, hashes, message) => {
      const probe = runProbe(COMMAND, { cwd, hashes });
      expect(probe.ok).toBe(false);
      expect(probe.error).toBe(message);
      const res = await dev.fetch(HTTP_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd, hashes }),
      });
      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe(message);
    };
    // A truncated 3-byte sequence, a lone continuation byte, an overlong
    // encoding and a surrogate, around valid text.
    const odd = Buffer.from([0x61, 0xe2, 0x82, 0x62, 0x80, 0x63, 0xc0, 0xaf, 0xc3, 0xa9, 0xed, 0xa0, 0x80]);
    const clean = repo("nonutf8clean");
    const f1 = ten("l").replace("l1\n", "A1\n");
    commitIndex(clean, [[odd, ten("l")], [Buffer.from("g"), "g\n"]], "base", 0);
    const a = commitIndex(clean, [[odd, f1]], "A", 1);
    commitIndex(clean, [[Buffer.from("g"), "g2\n"]], "B", 2);
    const c = commitIndex(clean, [[odd, f1.replace("l10\n", "C10\n")]], "C", 3);
    await expectError(clean, [a, c], "Combined diffs do not support the file name: a\\xe2\\x82b\\x80c\\xc0\\xafé\\xed\\xa0\\x80");

    const latin1 = Buffer.from("caf\xe9.txt", "latin1");
    const conflict = repo("nonutf8conflict");
    commitIndex(conflict, [[latin1, "x=1\n"], [Buffer.from("f"), "1\n"]], "base", 0);
    const a2 = commitIndex(conflict, [[Buffer.from("f"), "2\n"]], "A", 1);
    commitIndex(conflict, [[latin1, "x=2\n"]], "B", 2);
    const c2 = commitIndex(conflict, [[latin1, "x=3\n"]], "C", 3);
    await expectError(conflict, [a2, c2], "Combined diffs do not support the file name: caf\\xe9.txt");
  });

  // replay.rs `paths_outside_the_repository_are_refused` and the symlink
  // cases: refused input (400 on the dev-server), accepted historical names.
  it.skipIf(process.platform === "win32")("paths are validated the same way on both sides", async () => {
    const cwd = repo("paths");
    const outside = mkdtempSync(join(tmpdir(), "gw-parity-combined-outside-"));
    repos.push(outside);
    symlinkSync(outside, join(cwd, "out"));
    const a = commitFiles(cwd, { "old/f": "1\n" }, "A", 0);
    git(cwd, ["mv", "old", "new"]);
    execFileSync("git", ["-C", cwd, "commit", "-q", "-m", "rename"], { env: commitEnv(1) });
    const b = commitFiles(cwd, { "new/f": "2\n" }, "B", 2);
    const top = realpathSync.native(cwd);
    const cases = [
      [["f", "../x"], "path must not contain `..` (got: ../x)"],
      [["/etc/passwd"], "path must be relative to the repo (got: /etc/passwd)"],
      [[" "], "path must not be empty"],
      [["./new/f"], "path must not have an empty or `.` component (got: ./new/f)"],
      [["new//f"], "path must not have an empty or `.` component (got: new//f)"],
      [["new/./f"], "path must not have an empty or `.` component (got: new/./f)"],
      [["new/"], "path must not have an empty or `.` component (got: new/)"],
      [["out/secret"], `path escapes cwd (resolved: ${realpathSync.native(outside)}, cwd: ${top})`],
    ];
    for (const [paths, message] of cases) {
      const probe = runProbe(COMMAND, { cwd, hashes: [a, b], paths });
      expect(probe.ok).toBe(false);
      expect(probe.error).toBe(message);
      const res = await dev.fetch(HTTP_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd, hashes: [a, b], paths }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(message);
    }
    // `old/f` no longer exists on disk: still a valid path.
    const { rust } = await parity(cwd, [a, b], ["old/f", "new/f"]);
    expect(rust.diffs.length + rust.fallback.length).toBeGreaterThan(0);
  });

  // replay.rs `a_running_replay_is_cancelled_by_a_new_request`, on the dev
  // server (the probe runs one request per process): a later request of the
  // same repository cancels the replay in flight.
  it("a new request cancels the replay in flight on the dev server", async () => {
    const cwd = repo("cancel");
    commitFiles(cwd, { f: ten("l") }, "base", 0);
    const selected = [];
    for (let i = 0; i < 50; i++) {
      selected.push(commitFiles(cwd, { [`s${i}`]: "s\n" }, "S", 2 * i + 1));
      commitFiles(cwd, { [`u${i}`]: "u\n" }, "U", 2 * i + 2);
    }
    const post = (hashes) =>
      dev.fetch(HTTP_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd, hashes }),
      });
    const first = post(selected);
    await new Promise((r) => setTimeout(r, 300));
    const second = await post(selected.slice(0, 2));
    expect(second.status).toBe(200);
    expect((await second.json()).diffs.map((d) => d.path)).toEqual(["s0", "s1"]);
    const res = await first;
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Combined diff cancelled.");
  }, 60_000);

  it("invalid input fails with the same message on both sides", async () => {
    const cwd = repo("errors");
    const a = commitFiles(cwd, { f: "1\n" }, "A", 0);
    const cases = [
      [[a, "--output=x"], `Invalid commit hash: --output=x`, 400],
      [[a], "Select at least 2 commits.", 400],
      [[a, a.slice(0, 8)], "Select at least 2 commits.", 400],
      [[a, "deadbeefdeadbeef"], "Unknown commit: deadbeefdeadbeef", 400],
    ];
    for (const [hashes, message, status] of cases) {
      const probe = runProbe(COMMAND, { cwd, hashes });
      expect(probe.ok).toBe(false);
      expect(probe.error).toBe(message);
      const res = await dev.fetch(HTTP_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd, hashes }),
      });
      expect(res.status).toBe(status);
      expect((await res.json()).error).toBe(message);
    }
  });
});
