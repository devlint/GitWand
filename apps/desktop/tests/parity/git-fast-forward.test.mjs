/**
 * Parity tests: `git_fast_forward_to_upstream` (Rust) vs
 * `/api/git-fast-forward-to-upstream` (dev-server).
 *
 * Run: `pnpm --filter @gitwand/desktop test:parity`
 * Prerequisite: `cargo build --example parity-probe`
 *
 * Destructive (the fast-forward moves HEAD), so each side gets its own freshly
 * built clone. Parity is asserted on the result AND on what is left behind:
 * commit subjects (SHAs differ between independently built repos) and status.
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDevServer } from "./dev-server-runner.mjs";
import { runProbe } from "./probe.mjs";

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Parity",
  GIT_AUTHOR_EMAIL: "parity@gitwand.test",
  GIT_COMMITTER_NAME: "Parity",
  GIT_COMMITTER_EMAIL: "parity@gitwand.test",
  GIT_EDITOR: "true",
};

const git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: ENV }).trim();

const dirs = [];

/** A clone that is `behind` commits behind origin/main, already fetched. */
function behindClone(behind = 2) {
  const root = mkdtempSync(join(tmpdir(), "gitwand-parity-ff-"));
  dirs.push(root);
  const remote = join(root, "remote.git");
  const teammate = join(root, "teammate");
  const me = join(root, "me");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote], { env: ENV });
  execFileSync("git", ["clone", "-q", remote, teammate], { env: ENV });
  writeFileSync(join(teammate, "f"), "base\n");
  git(teammate, ["add", "."]);
  git(teammate, ["commit", "-q", "-m", "base"]);
  git(teammate, ["push", "-q", "origin", "main"]);
  execFileSync("git", ["clone", "-q", remote, me], { env: ENV });
  for (let i = 0; i < behind; i++) {
    writeFileSync(join(teammate, `t${i}`), "x\n");
    git(teammate, ["add", "."]);
    git(teammate, ["commit", "-q", "-m", `t${i}`]);
  }
  git(teammate, ["push", "-q", "origin", "main"]);
  git(me, ["fetch", "-q"]);
  return me;
}

async function nodeRun(dev, cwd) {
  const res = await dev.fetch("/api/git-fast-forward-to-upstream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
  return res.json();
}

function rustRun(cwd) {
  const r = runProbe("command-parity", { command: "git_fast_forward_to_upstream", args: { cwd } });
  if (/command-parity does not know/.test(String(r.error))) {
    throw new Error("the probe has no arm for 'git_fast_forward_to_upstream'. Rebuild it: cargo build --example parity-probe");
  }
  expect(r.ok, `rust failed: ${r.error}`).toBe(true);
  return r.value;
}

const shape = (cwd) => ({
  status: git(cwd, ["status", "--porcelain"]),
  subjects: git(cwd, ["log", "--format=%s"]),
});

/** The fields that are part of the contract (stderr wording is git's). */
const contract = (r) => ({
  fastForwarded: r.fastForwarded,
  reason: r.reason ?? null,
  behind: r.behind,
});

let dev;
beforeAll(async () => {
  dev = await startDevServer();
});
afterAll(async () => {
  await dev?.stop();
  while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe("git_fast_forward_to_upstream parity", () => {
  it("fast-forwards a purely-behind branch identically", async () => {
    const rustDir = behindClone(2);
    const nodeDir = behindClone(2);
    const rust = rustRun(rustDir);
    const node = await nodeRun(dev, nodeDir);
    expect(rust.fastForwarded).toBe(true);
    expect(contract(node)).toEqual(contract(rust));
    expect(node.branch).toBe(rust.branch);
    expect(shape(nodeDir)).toEqual(shape(rustDir));
  });

  it("is a no-op when up to date", async () => {
    const rustDir = behindClone(0);
    const nodeDir = behindClone(0);
    const rust = rustRun(rustDir);
    const node = await nodeRun(dev, nodeDir);
    expect(rust.reason).toBe("upToDate");
    expect(contract(node)).toEqual(contract(rust));
  });

  it("refuses a tracked edit identically and leaves the repo untouched", async () => {
    const rustDir = behindClone(1);
    const nodeDir = behindClone(1);
    for (const d of [rustDir, nodeDir]) writeFileSync(join(d, "f"), "edited\n");
    const before = shape(rustDir);
    const rust = rustRun(rustDir);
    const node = await nodeRun(dev, nodeDir);
    expect(rust.reason).toBe("trackedEdits");
    expect(contract(node)).toEqual(contract(rust));
    expect(shape(rustDir)).toEqual(before);
    expect(shape(nodeDir)).toEqual(before);
  });

  it("refuses local commits identically (never merges)", async () => {
    const rustDir = behindClone(1);
    const nodeDir = behindClone(1);
    for (const d of [rustDir, nodeDir]) {
      writeFileSync(join(d, "mine"), "m\n");
      git(d, ["add", "."]);
      git(d, ["commit", "-q", "-m", "mine"]);
    }
    const rust = rustRun(rustDir);
    const node = await nodeRun(dev, nodeDir);
    expect(rust.reason).toBe("localCommits");
    expect(contract(node)).toEqual(contract(rust));
    expect(shape(nodeDir)).toEqual(shape(rustDir));
  });

  it("refuses a detached HEAD identically", async () => {
    const rustDir = behindClone(1);
    const nodeDir = behindClone(1);
    for (const d of [rustDir, nodeDir]) git(d, ["checkout", "-q", "--detach"]);
    const rust = rustRun(rustDir);
    const node = await nodeRun(dev, nodeDir);
    expect(rust.reason).toBe("detached");
    expect(contract(node)).toEqual(contract(rust));
  });
});
