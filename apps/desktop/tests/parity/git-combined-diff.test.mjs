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
 * blocker, plus a companion), a `merge=union` attribute, a rename that
 * carries a fallback path, a root commit, the `paths` filter, and the error
 * strings of invalid input.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
    expect(rust.steps.flat().map((x) => x.path)).toEqual(["t.txt"]);
  }, 60_000);

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

  // A conflicting commit that also adds 1 400 long paths: they all fall back
  // as companions, ~1.1 MB of names — more than an argv holds on macOS
  // (1 MB) and Windows (32 KB). The per-commit diffs list them in pathspec
  // batches of a few KB, the same batches on both sides.
  it("thousands of long fallback paths are diffed in argv-sized batches", async () => {
    const cwd = repo("argv");
    const dir = ["d".repeat(200), "e".repeat(200), "f".repeat(200)].join("/");
    const names = Array.from({ length: 1400 }, (_, i) => `${dir}/${String(i).padStart(5, "0")}${"n".repeat(190)}`);
    commitFiles(cwd, { "c.txt": "1\n" }, "base", 0);
    const a = commitFiles(cwd, { "c.txt": "2\n" }, "A", 1);
    commitFiles(cwd, { "c.txt": "3\n" }, "B", 2);
    const c = commitFiles(cwd, { ...Object.fromEntries(names.map((n) => [n, "x\n"])), "c.txt": "4\n" }, "C", 3);
    const { rust } = await parity(cwd, [a, c]);
    expect(rust.fallback).toHaveLength(names.length + 1);
    expect(rust.fallback.every((f) => f.perCommit.length > 0)).toBe(true);
  }, 120_000);

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
    // 290 bytes in all. At 150: large.txt (121) then the old.txt→new.txt
    // file (25, one file through the rename) lose their steps → 144, under.
    // At 0: every step goes, then every entry turns header-only.
    for (const budget of ["150", "0"]) {
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
        } else {
          expect(rust.steps.flat().map((d) => d.path)).toEqual(["small.txt"]);
        }
      } finally {
        await small.stop();
      }
    }
    const { rust } = await parity(cwd, [a, c]);
    expect(rust.truncated).toBe(false);
  }, 30_000);

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
