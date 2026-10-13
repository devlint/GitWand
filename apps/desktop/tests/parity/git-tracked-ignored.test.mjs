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
import { existsSync, lstatSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

  it.each([["../outside.txt"], ["sub/../../outside.txt"], ["/etc/passwd"]])(
    "refuses %s on both backends",
    async (bad) => {
      const cwd = fixtureTrackedIgnored();
      // Rides with a valid path: the batch is refused as a whole.
      const paths = ["[x]-star.log", bad];
      const r = runProbe("command-parity", {
        command: "git_untrack_paths",
        args: { cwd, paths },
      });
      expect(r.ok).toBe(false);
      const res = await dev.fetch("/api/git-untrack-paths", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, paths }),
      });
      expect(res.ok).toBe(false);
      expect(git(cwd, ["diff", "--cached", "--name-only"])).toBe("");
    },
  );

  it.skipIf(process.platform === "win32")(
    "untracks a tracked symlink pointing outside the repo on both backends",
    async () => {
      const outside = mkdtempSync(join(tmpdir(), "gw-parity-outside-"));
      writeFileSync(join(outside, "target.txt"), "t\n");
      const build = () => {
        const cwd = mkTempRepo("gw-parity-tracked-ignored-link-");
        commitFile(cwd, "keep.txt", "k\n", "add keep", 0);
        symlinkSync(join(outside, "target.txt"), join(cwd, "link.log"));
        git(cwd, ["add", "link.log"]);
        git(cwd, ["commit", "-qm", "add link"]);
        writeFileSync(join(cwd, ".gitignore"), "*.log\n");
        return cwd;
      };
      const rustRepo = build();
      const r = runProbe("command-parity", {
        command: "git_untrack_paths",
        args: { cwd: rustRepo, paths: ["link.log"] },
      });
      expect(r.ok, String(r.error)).toBe(true);
      const nodeRepo = build();
      const res = await dev.fetch("/api/git-untrack-paths", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: nodeRepo, paths: ["link.log"] }),
      });
      expect(res.ok).toBe(true);
      const staged = (cwd) => git(cwd, ["diff", "--cached", "--name-status", "-z"]);
      expect(staged(rustRepo)).toBe("D\0link.log\0");
      expect(staged(nodeRepo)).toBe(staged(rustRepo));
      for (const cwd of [rustRepo, nodeRepo]) {
        expect(lstatSync(join(cwd, "link.log")).isSymbolicLink()).toBe(true);
      }
    },
  );
});
