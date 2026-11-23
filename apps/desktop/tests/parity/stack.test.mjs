/**
 * Parity tests: stacked branches (v3.14.0). The Rust stack commands, reached
 * through the probe's `command-parity` dispatch, against the dev-server
 * routes backed by `dev-stack-service.mjs`.
 *
 * Run: `pnpm --filter @gitwand/desktop test:parity`
 * Prerequisite: `cargo build --example parity-probe`
 *
 * `stack_status` may write (it self-heals bases and finalizes a pending
 * restack) and `git_restack` rewrites history, so — as in
 * `git-rebase-onto.test.mjs` — each side runs on its own fresh fixture, and
 * parity covers the state left behind as well as the answer.
 *
 * Fixture commits have fixed dates, so their shas match across the two
 * fixtures; a restack's rewritten commits do not (their committer date is
 * the time of the run). Payloads are compared with every sha replaced by the
 * index of its first appearance, which keeps "this base is that parent tip"
 * while ignoring what the sha is.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { startDevServer } from "./dev-server-runner.mjs";
import { runProbe } from "./probe.mjs";
import { fixtureStack } from "./fixtures.mjs";

const SHA = /\b[0-9a-f]{40}\b/g;

/** Every sha, in strings too, replaced by `<sha#N>` in order of first
 *  appearance. Object keys are walked sorted, so the field order of the
 *  two serializers does not change the numbering. */
function normalizeShas(value) {
  const seen = new Map();
  const sub = (s) =>
    s.replace(SHA, (sha) => {
      if (!seen.has(sha)) seen.set(sha, seen.size);
      return `<sha#${seen.get(sha)}>`;
    });
  const walk = (v) => {
    if (typeof v === "string") return sub(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  return walk(value);
}

/** The Rust command through the probe: `{ ok, value, error }`. */
function rust(command, args) {
  return runProbe("command-parity", { command, args });
}

/** The dev-server route: `{ ok, value, error }`. */
async function node(dev, path, body) {
  const res = await dev.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, value: data } : { ok: false, error: data.error, status: res.status };
}

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();

function isRebasing(cwd) {
  return spawnSync("git", ["-C", cwd, "rev-parse", "--verify", "--quiet", "REBASE_HEAD"]).status === 0;
}

/** What a restack leaves behind: per-branch subjects, the stack keys, the
 *  current branch, a halted rebase. */
function stateOf(cwd) {
  const log = {};
  for (const b of ["main", "step-1", "step-2", "step-3"]) {
    log[b] = git(cwd, ["log", "--format=%s", b]);
  }
  const keys = spawnSync(
    "git",
    ["-C", cwd, "config", "--local", "--get-regexp", "^branch\\..*\\.gitwand"],
    { encoding: "utf-8" },
  ).stdout.trim();
  return normalizeShas({
    log,
    keys,
    current: spawnSync("git", ["-C", cwd, "branch", "--show-current"], { encoding: "utf-8" }).stdout.trim(),
    rebasing: isRebasing(cwd),
  });
}

/** Both sides succeeded and agree once shas are normalized. */
function expectSame(r, n, label) {
  expect(r.ok, `${label}: rust failed: ${r.error}`).toBe(true);
  expect(n.ok, `${label}: node failed: ${n.error}`).toBe(true);
  expect(normalizeShas(n.value), label).toEqual(normalizeShas(r.value));
}

/** Both sides refused with the same words. */
function expectSameError(r, n, label) {
  expect(r.ok, `${label}: rust accepted`).toBe(false);
  expect(n.ok, `${label}: node accepted`).toBe(false);
  expect(n.status, `${label}: node status`).toBe(400);
  expect(n.error, label).toBe(r.error);
}

const status = {
  rust: (cwd, mergedParents = []) => rust("stack_status", { cwd, trunk: "main", mergedParents }),
  node: (dev, cwd, mergedParents = []) =>
    node(dev, "/api/stack-status", { cwd, configuredTrunk: "main", mergedParents }),
};
const plan = {
  rust: (cwd, branch, mergedParents = []) =>
    rust("stack_restack_plan", { cwd, branch, trunk: "main", mergedParents }),
  node: (dev, cwd, branch, mergedParents = []) =>
    node(dev, "/api/stack-restack-plan", { cwd, branch, configuredTrunk: "main", mergedParents }),
};

const previewedOf = (p) => ({
  onto_sha: p.onto_sha,
  upstream_sha: p.upstream_sha,
  top_sha: p.top_sha,
  moving: p.moving.map((m) => m.branch),
});

/** Plans then restacks `branch` on each side's own fixture. */
async function restackBoth(dev, kind, branch) {
  const rustCwd = fixtureStack(kind);
  const nodeCwd = fixtureStack(kind);
  const rp = plan.rust(rustCwd, branch);
  const np = await plan.node(dev, nodeCwd, branch);
  expectSame(rp, np, "plan");
  const before = { rust: stateOf(rustCwd), node: stateOf(nodeCwd) };
  const rr = rust("git_restack", {
    cwd: rustCwd, branch, trunk: "main", mergedParents: [], previewed: previewedOf(rp.value),
  });
  const nr = await node(dev, "/api/git-restack", {
    cwd: nodeCwd, branch, configuredTrunk: "main", mergedParents: [], previewed: previewedOf(np.value),
  });
  expectSame(rr, nr, "git_restack");
  return { rustCwd, nodeCwd, rr, before };
}

describe("parity: stacked branches", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;

  beforeAll(async () => {
    dev = await startDevServer();
  }, 20_000);

  afterAll(async () => {
    await dev?.stop();
  });

  it("stack-status is identical for every fixture state", async () => {
    for (const kind of ["moved", "squashed", "merge-commit", "occupied"]) {
      const rustCwd = fixtureStack(kind);
      const nodeCwd = fixtureStack(kind);
      const r = status.rust(rustCwd);
      const n = await status.node(dev, nodeCwd);
      expectSame(r, n, `status ${kind}`);
      expect(stateOf(nodeCwd), `state after status ${kind}`).toEqual(stateOf(rustCwd));
    }
    // The states really differ: moment 1, then moment 2 by each signal.
    const states = {};
    for (const kind of ["moved", "squashed", "merge-commit"]) {
      const l2 = status.rust(fixtureStack(kind)).value.layers.find((l) => l.branch === "step-2");
      states[kind] = [l2.state, l2.merge_signal, l2.actionable];
    }
    expect(states).toEqual({
      moved: ["out_of_date", null, true],
      squashed: ["parent_merged", "cherry", true],
      "merge-commit": ["parent_merged", "merge_commit", true],
    });
  }, 60_000);

  it("stack-status honours a merged-parent hint identically", async () => {
    const hint = [{ branch: "step-1", number: 812, head_ref_oid: null }];
    const rustCwd = fixtureStack("moved");
    const nodeCwd = fixtureStack("moved");
    const r = status.rust(rustCwd, hint);
    const n = await status.node(dev, nodeCwd, hint);
    expectSame(r, n, "status with hint");
    expect(r.value.layers[0].merge_signal).toBe("forge");
    expect(r.value.layers[0].merged_pr).toBe(812);
  }, 30_000);

  it("set-parent refusals have the same wording", async () => {
    const cases = [
      ["step-3", "step-1"], // a second child
      ["step-2", "step-3"], // a cycle
      ["step-2", "step-2"], // itself
      ["main", "step-1"], // the trunk as a layer
      ["step-2", "main"], // the trunk as a parent
      ["-x", "step-1"], // an option
      ["step-2", "nope"], // unknown
    ];
    const rustCwd = fixtureStack("moved");
    const nodeCwd = fixtureStack("moved");
    for (const [branch, parent] of cases) {
      const r = rust("stack_set_parent", { cwd: rustCwd, branch, parent, trunk: "main" });
      const n = await node(dev, "/api/stack-set-parent", { cwd: nodeCwd, branch, parent, configuredTrunk: "main" });
      expectSameError(r, n, `set-parent ${branch} on ${parent}`);
    }
    const r = rust("stack_set_parent", { cwd: rustCwd, branch: "step-3", parent: "step-1", trunk: "main" });
    expect(r.error).toBe(
      "step-1 already has a stacked branch (step-2). Stacks are linear for now: stack on step-2 instead.",
    );
    expect(stateOf(nodeCwd)).toEqual(stateOf(rustCwd));
  }, 30_000);

  it("set-parent and unset write the same metadata", async () => {
    const rustCwd = fixtureStack("moved");
    const nodeCwd = fixtureStack("moved");
    for (const cwd of [rustCwd, nodeCwd]) git(cwd, ["branch", "step-4", "step-3"]);
    const r = rust("stack_set_parent", { cwd: rustCwd, branch: "step-4", parent: "step-3", trunk: "main" });
    const n = await node(dev, "/api/stack-set-parent", {
      cwd: nodeCwd, branch: "step-4", parent: "step-3", configuredTrunk: "main",
    });
    expectSame(r, n, "set-parent");
    expect(stateOf(nodeCwd)).toEqual(stateOf(rustCwd));
    const ru = rust("stack_unset", { cwd: rustCwd, branch: "step-3" });
    const nu = await node(dev, "/api/stack-unset", { cwd: nodeCwd, branch: "step-3" });
    expect(ru.ok, ru.error).toBe(true);
    expect(nu.ok, nu.error).toBe(true);
    expect(stateOf(nodeCwd)).toEqual(stateOf(rustCwd));
    const rx = rust("stack_unset", { cwd: rustCwd, branch: "-x" });
    const nx = await node(dev, "/api/stack-unset", { cwd: nodeCwd, branch: "-x" });
    expectSameError(rx, nx, "unset -x");
  }, 30_000);

  it("restack plans are identical, refusals included", async () => {
    const hint = (oid) => [{ branch: "step-1", number: 812, head_ref_oid: oid }];
    const cases = [
      ["moved", "step-2", []],
      ["squashed", "step-2", []],
      ["squashed", "step-2", hint(null)],
      ["merge-commit", "step-2", []],
      ["occupied", "step-2", []],
      ["moved", "step-3", []], // Err: restack step-2 first
      ["moved", "step-1", []], // Err: not a stacked branch
      ["moved", "-x", []], // Err: invalid branch name
    ];
    for (const [kind, branch, hints] of cases) {
      const rustCwd = fixtureStack(kind);
      const nodeCwd = fixtureStack(kind);
      const r = plan.rust(rustCwd, branch, hints);
      const n = await plan.node(dev, nodeCwd, branch, hints);
      const label = `plan ${kind} ${branch} ${JSON.stringify(hints)}`;
      if (!r.ok) {
        expectSameError(r, n, label);
        continue;
      }
      // An occupied refusal names each fixture's own worktree path.
      const own = (v, cwd) => JSON.parse(JSON.stringify(v).replaceAll(`${cwd}-wt`, "<wt>"));
      expectSame({ ok: true, value: own(r.value, rustCwd) }, { ok: true, value: own(n.value, nodeCwd) }, label);
    }
    expect(plan.rust(fixtureStack("occupied"), "step-2").value.refusal.code).toBe("occupied");
    expect(plan.rust(fixtureStack("moved"), "step-3").error).toBe("restack step-2 first");

    // No recorded base and no head sha in the hint: no_old_base.
    const rustCwd = fixtureStack("squashed");
    const nodeCwd = fixtureStack("squashed");
    for (const cwd of [rustCwd, nodeCwd]) git(cwd, ["config", "--unset", "branch.step-2.gitwandStackBase"]);
    const r = plan.rust(rustCwd, "step-2", hint(null));
    const n = await plan.node(dev, nodeCwd, "step-2", hint(null));
    expectSame(r, n, "plan no_old_base");
    expect(r.value.refusal.code).toBe("no_old_base");
  }, 90_000);

  it("preview-restack is byte-identical", async () => {
    const cwd = fixtureStack("squashed");
    const upstream = git(cwd, ["rev-parse", "step-1"]);
    const args = { cwd, onto: "origin/main", upstream, branch: "step-3" };
    const r = rust("preview_restack", args);
    const n = await node(dev, "/api/preview-restack", args);
    expect(r.ok, r.error).toBe(true);
    expect(n.ok, n.error).toBe(true);
    expect(n.value).toEqual(r.value);
    expect(r.value.map((p) => p.file_path)).toEqual(["b.txt", "c.txt"]);

    for (const bad of [{ ...args, onto: "-x" }, { ...args, upstream: "-y" }, { ...args, branch: "nope" }]) {
      expectSameError(rust("preview_restack", bad), await node(dev, "/api/preview-restack", bad), JSON.stringify(bad));
    }
  }, 30_000);

  it("a clean restack leaves the same state, finalized by the next status", async () => {
    const { rustCwd, nodeCwd, rr } = await restackBoth(dev, "moved", "step-2");
    expect(rr.value).toEqual({ conflict: false });
    // The record is pending until a status settles it.
    expect(stateOf(nodeCwd)).toEqual(stateOf(rustCwd));
    expect(stateOf(rustCwd).keys).toContain("gitwandrestack");

    const r = status.rust(rustCwd);
    const n = await status.node(dev, nodeCwd);
    expectSame(r, n, "finalizing status");
    expect(r.value.finalized).toMatchObject({ moment: "parent_moved", bottom: "step-2", moved: ["step-2", "step-3"] });
    expect(stateOf(nodeCwd)).toEqual(stateOf(rustCwd));
    expect(stateOf(rustCwd).keys).not.toContain("gitwandrestack");
    expect(stateOf(rustCwd).log["step-3"].split("\n")).toEqual(["s3", "s2", "s1 more", "s1", "initial commit"]);

    // A second refresh has nothing left to finalize.
    expectSame(status.rust(rustCwd), await status.node(dev, nodeCwd), "settled status");
  }, 60_000);

  it("a moment-2 restack re-parents identically", async () => {
    const rustCwd = fixtureStack("squashed");
    const nodeCwd = fixtureStack("squashed");
    const rp = plan.rust(rustCwd, "step-2");
    const np = await plan.node(dev, nodeCwd, "step-2");
    expectSame(rp, np, "plan");
    const rr = rust("git_restack", {
      cwd: rustCwd, branch: "step-2", trunk: "main", mergedParents: [], previewed: previewedOf(rp.value),
    });
    const nr = await node(dev, "/api/git-restack", {
      cwd: nodeCwd, branch: "step-2", configuredTrunk: "main", mergedParents: [], previewed: previewedOf(np.value),
    });
    expectSame(rr, nr, "git_restack");
    expectSame(status.rust(rustCwd), await status.node(dev, nodeCwd), "finalizing status");
    expect(stateOf(nodeCwd)).toEqual(stateOf(rustCwd));
  }, 60_000);

  it("a stale preview is refused with the same words", async () => {
    const rustCwd = fixtureStack("moved");
    const nodeCwd = fixtureStack("moved");
    const rp = plan.rust(rustCwd, "step-2");
    const np = await plan.node(dev, nodeCwd, "step-2");
    const stale = (p) => ({ ...previewedOf(p), moving: ["step-2"] });
    const r = rust("git_restack", {
      cwd: rustCwd, branch: "step-2", trunk: "main", mergedParents: [], previewed: stale(rp.value),
    });
    const n = await node(dev, "/api/git-restack", {
      cwd: nodeCwd, branch: "step-2", configuredTrunk: "main", mergedParents: [], previewed: stale(np.value),
    });
    expectSameError(r, n, "stale preview");
    expect(stateOf(nodeCwd)).toEqual(stateOf(rustCwd));
  }, 30_000);

  it("a conflicting restack halts identically", async () => {
    const { rustCwd, nodeCwd, rr } = await restackBoth(dev, "conflict", "step-2");
    expect(rr.value).toEqual({ conflict: true });
    expect(stateOf(nodeCwd)).toEqual(stateOf(rustCwd));
    expect(stateOf(rustCwd).rebasing).toBe(true);
    const r = status.rust(rustCwd);
    const n = await status.node(dev, nodeCwd);
    expectSame(r, n, "status mid-rebase");
    expect(r.value.rebase_in_progress).toBe(true);
    expect(r.value.finalized).toBe(null);
  }, 60_000);

  it("an abort leaves the state unchanged", async () => {
    const { rustCwd, nodeCwd, before } = await restackBoth(dev, "conflict", "step-2");
    for (const cwd of [rustCwd, nodeCwd]) git(cwd, ["rebase", "--abort"]);
    const r = status.rust(rustCwd);
    const n = await status.node(dev, nodeCwd);
    expectSame(r, n, "status after abort");
    expect(r.value.finalized).toBe(null);
    expect(stateOf(rustCwd)).toEqual(before.rust);
    expect(stateOf(nodeCwd)).toEqual(before.node);
    expect(stateOf(nodeCwd)).toEqual(stateOf(rustCwd));
  }, 60_000);
});

/**
 * `/api/git-push-branch` and the gh routes have no probe arm: their
 * refusals are checked against the Rust command's own words (see
 * `git_push_branch` in commands/ops.rs and `check_branch_pr_args` /
 * `check_pr_number` / `check_pr_base` in commands/gh.rs). Each refusal
 * happens before any git push or gh call.
 */
describe("dev-server wire contract: push-branch and gh stack routes", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;
  const lease = "0".repeat(40);

  beforeAll(async () => {
    dev = await startDevServer();
  }, 20_000);

  afterAll(async () => {
    await dev?.stop();
  });

  it("git-push-branch refuses what Rust refuses", async () => {
    const cwd = fixtureStack("squashed");
    const push = (branch, leaseSha = lease) => node(dev, "/api/git-push-branch", { cwd, branch, leaseSha });
    expect((await push("-x")).error).toBe("invalid branch name: -x");
    expect((await push("step-2")).error).toBe("step-2 has no upstream");
    git(cwd, ["config", "branch.step-2.remote", "-origin"]);
    git(cwd, ["config", "branch.step-2.merge", "refs/heads/step-2"]);
    expect((await push("step-2")).error).toBe("invalid remote: -origin");
    git(cwd, ["config", "branch.step-2.remote", "origin"]);
    git(cwd, ["config", "branch.step-2.merge", "refs/tags/v1"]);
    expect((await push("step-2")).error).toBe("step-2 has no upstream branch under refs/heads/");
    git(cwd, ["config", "branch.step-2.merge", "refs/heads/step-2"]);
    expect((await push("step-2", "nope")).error).toBe("invalid lease sha");
  }, 30_000);

  it("git-push-branch force-pushes one branch under its lease", async () => {
    const cwd = fixtureStack("squashed");
    git(cwd, ["push", "--quiet", "-u", "origin", "step-2"]);
    git(cwd, ["checkout", "--quiet", "step-3"]);
    const remote = git(cwd, ["rev-parse", "origin/step-2"]);
    git(cwd, ["branch", "-f", "step-2", "step-1"]);
    const stale = await node(dev, "/api/git-push-branch", { cwd, branch: "step-2", leaseSha: lease });
    expect(stale.ok).toBe(true);
    expect(stale.value.success).toBe(false);
    const ok = await node(dev, "/api/git-push-branch", { cwd, branch: "step-2", leaseSha: remote });
    expect(ok.value.success, ok.value.message).toBe(true);
    git(cwd, ["fetch", "--quiet", "origin"]);
    expect(git(cwd, ["rev-parse", "origin/step-2"])).toBe(git(cwd, ["rev-parse", "step-1"]));
    expect(git(cwd, ["branch", "--show-current"])).toBe("step-3");
  }, 30_000);

  it("gh-branch-pr and gh-pr-set-base validate their arguments as Rust does", async () => {
    const cwd = fixtureStack("moved");
    expect((await node(dev, "/api/gh-branch-pr", { cwd, branch: "-x", state: "open" })).error)
      .toBe("invalid branch name: -x");
    expect((await node(dev, "/api/gh-branch-pr", { cwd, branch: "step-1", state: "all" })).error)
      .toBe("invalid PR state: all");
    expect((await node(dev, "/api/gh-pr-set-base", { cwd, number: 0, base: "main" })).error)
      .toBe("invalid PR number: 0");
    expect((await node(dev, "/api/gh-pr-set-base", { cwd, number: 3, base: "" })).error)
      .toBe("base must not be empty");
    expect((await node(dev, "/api/gh-pr-set-base", { cwd, number: 3, base: "-main" })).error)
      .toBe("invalid branch name: -main");
  }, 30_000);
});
