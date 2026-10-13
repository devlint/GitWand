/**
 * Parity tests — `git_tracked_ignored` / `git_untrack_paths` (Rust) vs
 * `/api/git-tracked-ignored` / `/api/git-untrack-paths` (Node dev-server).
 *
 * Both sides run the same git invocations on real temp repos. Detection is
 * compared payload to payload; untracking is compared on its observable effect
 * (the staged removals and the files left on disk), run once per backend on two
 * identically built repos.
 *
 * Run: `pnpm --filter @gitwand/desktop test:parity`
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startDevServer } from "./dev-server-runner.mjs";
import { assertParity } from "./harness.mjs";
import { runProbe } from "./probe.mjs";
import { mkTempRepo, commitFile } from "./fixtures.mjs";

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
}

const TRACKED = [
  "keep.txt",
  "build/out.js",
  "dossier é/mon fichier.log",
  "日本語/ログ.log",
  "[x]-star.log",
];

/** Everything committed, then a `.gitignore` that now matches most of it. */
function fixtureTrackedIgnored() {
  const cwd = mkTempRepo("gw-parity-tracked-ignored-");
  TRACKED.forEach((p, i) => commitFile(cwd, p, `${p}\n`, `add ${p}`, i));
  writeFileSync(join(cwd, ".gitignore"), "build/\n*.log\n");
  return cwd;
}

describe("parity: git-tracked-ignored", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;

  beforeAll(async () => {
    dev = await startDevServer();
  }, 15_000);

  afterAll(async () => {
    await dev?.stop();
  });

  it("lists tracked paths matching an ignore rule, identically", async () => {
    const cwd = fixtureTrackedIgnored();
    const { rust, node } = await assertParity(dev, {
      command: "command-parity",
      args: { command: "git_tracked_ignored", args: { cwd } },
      httpPath: `/api/git-tracked-ignored?cwd=${encodeURIComponent(cwd)}`,
    });
    expect(node.total).toBe(4);
    expect(node.truncated).toBe(false);
    expect([...node.paths].sort()).toEqual(
      ["[x]-star.log", "build/out.js", "dossier é/mon fichier.log", "日本語/ログ.log"].sort(),
    );
    expect(rust).toEqual(node);
  });

  it("reports nothing for a repo with no tracked ignored file", async () => {
    const cwd = mkTempRepo("gw-parity-tracked-ignored-clean-");
    commitFile(cwd, "a.txt", "a\n", "add a", 0);
    const { node } = await assertParity(dev, {
      command: "command-parity",
      args: { command: "git_tracked_ignored", args: { cwd } },
      httpPath: `/api/git-tracked-ignored?cwd=${encodeURIComponent(cwd)}`,
    });
    expect(node).toEqual({ paths: [], total: 0, truncated: false });
  });

  it("untracks the same files on both backends and keeps them on disk", async () => {
    const selection = ["dossier é/mon fichier.log", "[x]-star.log"];

    const rustRepo = fixtureTrackedIgnored();
    const r = runProbe("command-parity", {
      command: "git_untrack_paths",
      args: { cwd: rustRepo, paths: selection },
    });
    expect(r.ok, String(r.error)).toBe(true);

    const nodeRepo = fixtureTrackedIgnored();
    const res = await dev.fetch("/api/git-untrack-paths", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: nodeRepo, paths: selection }),
    });
    expect(res.ok).toBe(true);

    const staged = (cwd) => git(cwd, ["diff", "--cached", "--name-status", "-z"]);
    expect(staged(rustRepo)).toBe(staged(nodeRepo));
    expect(staged(nodeRepo)).toContain("D\0[x]-star.log\0");
    for (const cwd of [rustRepo, nodeRepo]) {
      for (const p of selection) expect(existsSync(join(cwd, p))).toBe(true);
    }
  });

  it("refuses a path that escapes the repo on both backends", async () => {
    const cwd = fixtureTrackedIgnored();
    const r = runProbe("command-parity", {
      command: "git_untrack_paths",
      args: { cwd, paths: ["../outside.txt"] },
    });
    expect(r.ok).toBe(false);
    const res = await dev.fetch("/api/git-untrack-paths", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, paths: ["../outside.txt"] }),
    });
    expect(res.ok).toBe(false);
  });
});
