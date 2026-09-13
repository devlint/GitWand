/**
 * Parity tests: `git_rebase_onto` (Rust) vs `/api/git-rebase-onto`.
 *
 * Run: `pnpm --filter @gitwand/desktop test:parity`
 * Prerequisite: `cargo build --example parity-probe`
 *
 * This command is **destructive**, which changes the harness shape. Every
 * other parity test runs the probe and the HTTP route against the same cwd and
 * compares two reads. Here the first run rewrites history, so the second would
 * be comparing against a repository the first one already changed. Each side
 * therefore gets its own freshly-built clone, and parity is asserted on the
 * result *and* on the state the operation left behind: the same `{conflict}`,
 * the same resulting log, the same porcelain status.
 *
 * Asserting only on `{conflict}` would be too weak. Two implementations can
 * agree that a rebase conflicted while leaving the working tree in different
 * states, and the state is what the caller acts on next.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { startDevServer } from "./dev-server-runner.mjs";
import { runProbe } from "./probe.mjs";
import { fixtureRebaseOnto } from "./fixtures.mjs";

async function nodeRebaseOnto(dev, cwd, onto) {
  const res = await dev.fetch("/api/git-rebase-onto", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, onto }),
  });
  const data = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, value: data } : { ok: false, error: data.error };
}

const git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();

/** Is a rebase currently halted in this repo? */
function isRebasing(cwd) {
  try {
    execFileSync("git", ["-C", cwd, "rev-parse", "--verify", "REBASE_HEAD"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * The state a rebase left behind, normalized for comparison.
 *
 * Commit subjects, not shas: each side rebases its own clone, so the rewritten
 * commits have different shas by construction and comparing them would fail
 * for a reason that has nothing to do with parity.
 */
function stateOf(cwd) {
  return {
    log: git(cwd, ["log", "--format=%s"]),
    status: git(cwd, ["status", "--porcelain"]),
    rebasing: isRebasing(cwd),
  };
}

describe("parity: git-rebase-onto", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;

  beforeAll(async () => {
    dev = await startDevServer();
  }, 20_000);

  afterAll(async () => {
    await dev?.stop();
  });

  it("a clean rebase reports no conflict and leaves the same state on both sides", async () => {
    const rustCwd = fixtureRebaseOnto(false);
    const nodeCwd = fixtureRebaseOnto(false);

    const rust = runProbe("git-rebase-onto", { cwd: rustCwd, onto: "main" });
    const node = await nodeRebaseOnto(dev, nodeCwd, "main");

    expect(rust.ok, `rust failed: ${rust.error}`).toBe(true);
    expect(node.ok, `node failed: ${node.error}`).toBe(true);
    expect(rust.value.conflict).toBe(false);
    expect(node.value.conflict).toBe(rust.value.conflict);

    expect(stateOf(nodeCwd)).toEqual(stateOf(rustCwd));
  }, 30_000);

  it("a conflicting rebase halts, and halts the same way on both sides", async () => {
    const rustCwd = fixtureRebaseOnto(true);
    const nodeCwd = fixtureRebaseOnto(true);

    const rust = runProbe("git-rebase-onto", { cwd: rustCwd, onto: "main" });
    const node = await nodeRebaseOnto(dev, nodeCwd, "main");

    expect(rust.ok, `rust failed: ${rust.error}`).toBe(true);
    expect(node.ok, `node failed: ${node.error}`).toBe(true);
    expect(rust.value.conflict, "the rebase really does conflict").toBe(true);
    expect(node.value.conflict).toBe(rust.value.conflict);

    // Both must leave a halted rebase with the same conflicted file, so the
    // caller's next step (resolve, then --continue) is identical.
    expect(stateOf(nodeCwd)).toEqual(stateOf(rustCwd));
    expect(stateOf(rustCwd).status).toContain("shared.txt");
  }, 30_000);

  it("an unknown ref is refused by both sides", async () => {
    const rustCwd = fixtureRebaseOnto(false);
    const nodeCwd = fixtureRebaseOnto(false);

    const rust = runProbe("git-rebase-onto", { cwd: rustCwd, onto: "no-such-ref" });
    const node = await nodeRebaseOnto(dev, nodeCwd, "no-such-ref");

    expect(rust.ok, "rust accepted an unknown ref").toBe(false);
    expect(node.ok, "node accepted an unknown ref").toBe(false);
    // Nothing may have been rewritten on either side.
    expect(stateOf(nodeCwd)).toEqual(stateOf(rustCwd));
  }, 30_000);

  it("a ref that looks like an option is refused, identically, before git runs", async () => {
    // `--exec` and friends would otherwise be read by git as flags.
    const rustCwd = fixtureRebaseOnto(false);
    const nodeCwd = fixtureRebaseOnto(false);

    const rust = runProbe("git-rebase-onto", { cwd: rustCwd, onto: "--exec=touch pwned" });
    const node = await nodeRebaseOnto(dev, nodeCwd, "--exec=touch pwned");

    expect(rust.ok).toBe(false);
    expect(node.ok).toBe(false);
    expect(rust.error).toContain("invalid rebase target");
    expect(node.error).toBe(rust.error);
  }, 30_000);
});
