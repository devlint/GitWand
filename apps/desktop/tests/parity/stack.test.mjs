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
import { writeFileSync } from "node:fs";
import { join } from "node:path";
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
  for (const b of git(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]).split("\n")) {
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

/** `v` with the fixture's own paths (`<cwd>`, `<cwd>-wt`, `<cwd>-origin.git`)
 *  spelled `<cwd>`, so two fixtures compare equal. */
const own = (v, cwd) => JSON.parse(JSON.stringify(v ?? null).replaceAll(cwd, "<cwd>"));

/** A `{ ok, value, error }` with its fixture paths spelled `<cwd>`. */
const ownResult = (r, cwd) => ({ ...r, value: own(r.value, cwd), error: r.error?.replaceAll(cwd, "<cwd>") });

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
async function restackBoth(dev, kind, branch, mergedParents = [], prep = () => {}) {
  const { rustCwd, nodeCwd } = twoFixtures(kind, prep);
  const rp = plan.rust(rustCwd, branch, mergedParents);
  const np = await plan.node(dev, nodeCwd, branch, mergedParents);
  expectSame(rp, np, "plan");
  const before = { rust: stateOf(rustCwd), node: stateOf(nodeCwd) };
  const rr = rust("git_restack", {
    cwd: rustCwd, branch, trunk: "main", mergedParents, previewed: previewedOf(rp.value),
  });
  const nr = await node(dev, "/api/git-restack", {
    cwd: nodeCwd, branch, configuredTrunk: "main", mergedParents, previewed: previewedOf(np.value),
  });
  expectSame(rr, nr, "git_restack");
  return { rustCwd, nodeCwd, rr, before, plan: rp.value };
}

/** Status on both sides: same answer (paths spelled `<cwd>`), same state. */
async function statusBoth(dev, rustCwd, nodeCwd, label, mergedParents = []) {
  const r = ownResult(status.rust(rustCwd, mergedParents), rustCwd);
  const n = ownResult(await status.node(dev, nodeCwd, mergedParents), nodeCwd);
  expectSame(r, n, label);
  expect(stateOf(nodeCwd), `${label}: state`).toEqual(stateOf(rustCwd));
  return r.value;
}

/** Plan on both sides: same plan or same Err (paths spelled `<cwd>`). */
async function planBoth(dev, rustCwd, nodeCwd, branch, label, mergedParents = []) {
  const r = ownResult(plan.rust(rustCwd, branch, mergedParents), rustCwd);
  const n = ownResult(await plan.node(dev, nodeCwd, branch, mergedParents), nodeCwd);
  if (r.ok) expectSame(r, n, label);
  else expectSameError(r, n, label);
  expect(stateOf(nodeCwd), `${label}: state`).toEqual(stateOf(rustCwd));
  return r;
}

/** A fresh fixture per side, after `prep(cwd)` ran on each. */
function twoFixtures(kind, prep = () => {}) {
  const rustCwd = fixtureStack(kind);
  const nodeCwd = fixtureStack(kind);
  prep(rustCwd);
  prep(nodeCwd);
  return { rustCwd, nodeCwd };
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
    const rs = status.rust(rustCwd);
    expectSame(rs, await status.node(dev, nodeCwd), "finalizing status");
    expect(rs.value.finalized).toMatchObject({
      moment: "parent_merged", bottom: "step-2", merged_parent: "step-1", new_parent: null,
    });
    expect(stateOf(nodeCwd)).toEqual(stateOf(rustCwd));
    // The bottom sat on the trunk now: it leaves the stack, on both sides.
    for (const cwd of [rustCwd, nodeCwd]) {
      expect(stateOf(cwd).keys).not.toMatch(/branch\.step-2\./);
      expect(stateOf(cwd).keys).toMatch(/branch\.step-3\.gitwandparent step-2/);
    }
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

describe("parity: stacked branches, the paths that rewrite branches", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;

  beforeAll(async () => {
    dev = await startDevServer();
  }, 20_000);

  afterAll(async () => {
    await dev?.stop();
  });

  it("an empty layer is moved by compare-and-swap when the restack is finalized", async () => {
    const { rustCwd, nodeCwd, plan: p } = await restackBoth(dev, "empty", "step-2");
    expect(p.moving.map((m) => m.branch)).toEqual(["step-2", "step-3"]);
    // `--update-refs` left step-2 at the old base: only finalize moves it.
    expect(git(rustCwd, ["rev-parse", "step-2"])).toBe(p.upstream_sha);
    const s = await statusBoth(dev, rustCwd, nodeCwd, "finalizing status");
    expect(s.finalized.moved).toEqual(["step-2", "step-3"]);
    for (const cwd of [rustCwd, nodeCwd]) {
      expect(git(cwd, ["rev-parse", "step-2"])).toBe(git(cwd, ["rev-parse", "step-1"]));
    }
  }, 60_000);

  it("an empty layer checked out elsewhere keeps the record, then moves once freed", async () => {
    const { rustCwd, nodeCwd } = await restackBoth(dev, "empty", "step-2");
    for (const cwd of [rustCwd, nodeCwd]) git(cwd, ["worktree", "add", "--quiet", `${cwd}-wt`, "step-2"]);
    const s = await statusBoth(dev, rustCwd, nodeCwd, "held status");
    expect(s.finalized).toBe(null);
    expect(s.pending_errors).toEqual([
      {
        top: "step-3",
        error:
          "step-2 is checked out in a worktree (<cwd>-wt), " +
          "so it cannot be moved onto the restacked stack. Free it, then refresh.",
      },
    ]);
    expect(s.layers.every((l) => !l.actionable)).toBe(true);
    await planBoth(dev, rustCwd, nodeCwd, "step-2", "plan while held");
    for (const cwd of [rustCwd, nodeCwd]) git(cwd, ["worktree", "remove", `${cwd}-wt`]);
    const freed = await statusBoth(dev, rustCwd, nodeCwd, "freed status");
    expect(freed.finalized.moved).toEqual(["step-2", "step-3"]);
  }, 60_000);

  it("plan never finalizes: right after a restack it errs, state untouched", async () => {
    const { rustCwd, nodeCwd } = await restackBoth(dev, "moved", "step-2");
    const before = stateOf(rustCwd);
    const r = await planBoth(dev, rustCwd, nodeCwd, "step-2", "plan after restack");
    expect(r.error).toBe("A previous restack of step-3 is still being finalized. Refresh and try again.");
    expect(stateOf(rustCwd)).toEqual(before);
    expect(before.keys).toContain("gitwandrestack");
  }, 60_000);

  it("moment 2 under a stacked grandparent re-parents onto it and drops the merged parent", async () => {
    const hint = [{ branch: "step-2", number: 812, head_ref_oid: null }];
    const { rustCwd, nodeCwd, plan: p } = await restackBoth(dev, "four", "step-3", hint);
    expect([p.moment, p.onto_ref, p.new_parent]).toEqual(["parent_merged", "step-1", "step-1"]);
    const s = await statusBoth(dev, rustCwd, nodeCwd, "finalizing status", hint);
    expect(s.finalized).toMatchObject({ merged_parent: "step-2", new_parent: "step-1", moved: ["step-3", "step-4"] });
    const keys = stateOf(rustCwd).keys;
    expect(keys).toMatch(/branch\.step-3\.gitwandparent step-1/);
    expect(keys).not.toMatch(/branch\.step-2\./);
    expect(stateOf(rustCwd).log["step-4"].split("\n")).toEqual(["s4", "s3", "s1", "initial commit"]);
  }, 60_000);

  it("a merged parent being dropped is refused, the layer above is planned", async () => {
    const hint = [{ branch: "step-2", number: 812, head_ref_oid: null }];
    const { rustCwd, nodeCwd } = twoFixtures("dropped");
    const s = await statusBoth(dev, rustCwd, nodeCwd, "status", hint);
    expect(s.layers.map((l) => [l.branch, l.state, l.actionable])).toEqual([
      ["step-2", "out_of_date", false],
      ["step-3", "parent_merged", true],
    ]);
    const r = await planBoth(dev, rustCwd, nodeCwd, "step-2", "plan dropped", hint);
    expect(r.error).toBe("step-2 is merged: restack step-3 instead");
    const up = await planBoth(dev, rustCwd, nodeCwd, "step-3", "plan above", hint);
    expect(up.value.onto_ref).toBe("step-1");
  }, 60_000);

  it("the restack stops at the first layer that no longer contains the one below", async () => {
    const { rustCwd, nodeCwd, plan: p } = await restackBoth(dev, "broken", "step-2");
    expect(p.top).toBe("step-3");
    expect(p.moving.map((m) => m.branch)).toEqual(["step-2", "step-3"]);
    const s = await statusBoth(dev, rustCwd, nodeCwd, "finalizing status");
    expect(s.finalized.moved).toEqual(["step-2", "step-3"]);
    const after = await statusBoth(dev, rustCwd, nodeCwd, "next status");
    expect(after.layers.find((l) => l.branch === "step-4")).toMatchObject({ state: "out_of_date", actionable: true });
  }, 60_000);

  it("a parent behind its upstream is refused", async () => {
    const { rustCwd, nodeCwd } = twoFixtures("behind");
    const s = await statusBoth(dev, rustCwd, nodeCwd, "status");
    expect(s.layers[0].parent_behind_upstream).toBe(1);
    const r = await planBoth(dev, rustCwd, nodeCwd, "step-2", "plan");
    expect(r.value.refusal).toEqual({
      code: "parent_behind",
      message: "step-1 is 1 commit(s) behind its upstream. Pull it first.",
      branch: null,
      path: null,
    });
  }, 60_000);

  it("a hint's head sha is honoured, and a stale one is ignored", async () => {
    // Stale: step-1 moved past the merged head, so the name was reused.
    const stale = twoFixtures("moved");
    const oldTip = git(stale.rustCwd, ["rev-parse", "step-1~1"]);
    const staleHint = [{ branch: "step-1", number: 812, head_ref_oid: oldTip }];
    const s = await statusBoth(dev, stale.rustCwd, stale.nodeCwd, "stale hint", staleHint);
    expect([s.layers[0].state, s.layers[0].merge_signal]).toEqual(["out_of_date", null]);

    // Honoured, and used as the old base when none is recorded (D20).
    const unset = (cwd) => git(cwd, ["config", "--unset", "branch.step-2.gitwandStackBase"]);
    const kept = twoFixtures("squashed", unset);
    const tip = git(kept.rustCwd, ["rev-parse", "step-1"]);
    const hint = [{ branch: "step-1", number: 812, head_ref_oid: tip }];
    const h = await statusBoth(dev, kept.rustCwd, kept.nodeCwd, "honoured hint", hint);
    expect([h.layers[0].merge_signal, h.layers[0].merged_pr]).toEqual(["forge", 812]);
    const r = await planBoth(dev, kept.rustCwd, kept.nodeCwd, "step-2", "plan from the hint", hint);
    expect([r.value.upstream_sha, r.value.refusal]).toEqual([tip, null]);
  }, 60_000);

  it("a malformed record is cleared, an unsettled one is reported in pending_errors", async () => {
    const bad = (cwd) => git(cwd, ["config", "branch.step-3.gitwandRestack", "parent_moved garbage"]);
    const m = twoFixtures("moved", bad);
    const s = await statusBoth(dev, m.rustCwd, m.nodeCwd, "malformed");
    expect([s.pending_errors, s.finalized]).toEqual([[], null]);
    expect(stateOf(m.rustCwd).keys).not.toContain("gitwandrestack");

    // A completed record on step-2 whose bottom (step-3) is not below it:
    // finalize cannot walk the stack, the record stays and blocks it.
    const stuck = (cwd) => {
      const mainSha = git(cwd, ["rev-parse", "main"]);
      const record = ["parent_moved", mainSha, mainSha, "step-3", "-", "step-3", "0".repeat(40), "-"].join(" ");
      git(cwd, ["config", "branch.step-2.gitwandRestack", record]);
    };
    const e = twoFixtures("moved", stuck);
    const p = await statusBoth(dev, e.rustCwd, e.nodeCwd, "pending_errors");
    expect(p.pending_errors).toEqual([
      { top: "step-2", error: "cannot finalize the restack: step-2 is no longer stacked above step-3" },
    ]);
    expect(p.layers.every((l) => !l.actionable)).toBe(true);
    // plan never settles: every record blocks its stack as "still being finalized".
    const r = await planBoth(dev, e.rustCwd, e.nodeCwd, "step-2", "plan held by the record");
    expect(r.error).toBe("A previous restack of step-2 is still being finalized. Refresh and try again.");
    expect(stateOf(e.rustCwd).keys).toContain("gitwandrestack");
  }, 60_000);

  it("a failed switch back is reported as { branch, reason }", async () => {
    const onStep1 = (cwd) => git(cwd, ["checkout", "--quiet", "step-1"]);
    const { rustCwd, nodeCwd } = await restackBoth(dev, "moved", "step-2", [], onStep1);
    for (const cwd of [rustCwd, nodeCwd]) writeFileSync(join(cwd, "c.txt"), "edited\n");
    const s = await statusBoth(dev, rustCwd, nodeCwd, "finalize, dirty top");
    expect([s.finalized.switched_back_to, s.finalized.switch_error]).toEqual([
      null,
      { branch: "step-1", reason: "uncommitted changes on step-3" },
    ]);
  }, 60_000);

  it("two stacks, one stuck record: the entry names its own top", async () => {
    // A second stack (other-1 <- other-2) next to the fixture's, and a stuck
    // record on step-2 (its bottom step-3 is not below it).
    const prep = (cwd) => {
      git(cwd, ["branch", "other-1", "main"]);
      git(cwd, ["branch", "other-2", "other-1"]);
      git(cwd, ["config", "branch.other-2.gitwandParent", "other-1"]);
      git(cwd, ["config", "branch.other-2.gitwandStackBase", git(cwd, ["rev-parse", "main"])]);
      const mainSha = git(cwd, ["rev-parse", "main"]);
      const record = ["parent_moved", mainSha, mainSha, "step-3", "-", "step-3", "0".repeat(40), "-"].join(" ");
      git(cwd, ["config", "branch.step-2.gitwandRestack", record]);
    };
    const e = twoFixtures("moved", prep);
    const p = await statusBoth(dev, e.rustCwd, e.nodeCwd, "two stacks");
    expect(p.pending_errors.map((x) => x.top)).toEqual(["step-2"]);
  }, 60_000);

  it("detached and dirty refusals are identical", async () => {
    const detached = twoFixtures("moved", (cwd) => git(cwd, ["checkout", "--quiet", "--detach"]));
    const d = await planBoth(dev, detached.rustCwd, detached.nodeCwd, "step-2", "detached");
    expect(d.value.refusal.code).toBe("detached");
    const dirty = twoFixtures("moved", (cwd) => writeFileSync(join(cwd, "c.txt"), "edited\n"));
    const t = await planBoth(dev, dirty.rustCwd, dirty.nodeCwd, "step-2", "dirty");
    expect(t.value.refusal.code).toBe("dirty");
  }, 60_000);

  it("a missing mergedParents is refused as Tauri refuses it", async () => {
    const cwd = fixtureStack("moved");
    const n = await node(dev, "/api/stack-status", { cwd, configuredTrunk: "main" });
    expect(n.error).toBe(
      "invalid args `mergedParents` for command `stack_status`: command stack_status missing required key mergedParents",
    );
    const p = await node(dev, "/api/git-restack", { cwd, branch: "step-2", mergedParents: [] });
    expect(p.error).toBe(
      "invalid args `previewed` for command `git_restack`: command git_restack missing required key previewed",
    );
  }, 30_000);
});

describe("parity: git-push-branch", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;
  const lease = "0".repeat(40);

  beforeAll(async () => {
    dev = await startDevServer();
  }, 20_000);

  afterAll(async () => {
    await dev?.stop();
  });

  const pushBoth = async (rustCwd, nodeCwd, branch, leaseSha) => {
    const r = ownResult(rust("git_push_branch", { cwd: rustCwd, branch, leaseSha }), rustCwd);
    const n = ownResult(await node(dev, "/api/git-push-branch", { cwd: nodeCwd, branch, leaseSha }), nodeCwd);
    return { r, n };
  };

  it("refuses what Rust refuses, with the same words", async () => {
    const setups = [
      ["-x", () => {}, "invalid branch name: -x"],
      ["step-2", () => {}, "step-2 has no upstream"],
      ["step-2", (cwd) => {
        git(cwd, ["config", "branch.step-2.remote", "-origin"]);
        git(cwd, ["config", "branch.step-2.merge", "refs/heads/step-2"]);
      }, "invalid remote: -origin"],
      ["step-2", (cwd) => {
        git(cwd, ["config", "branch.step-2.remote", "origin"]);
        git(cwd, ["config", "branch.step-2.merge", "refs/tags/v1"]);
      }, "step-2 has no upstream branch under refs/heads/"],
    ];
    for (const [branch, prep, msg] of setups) {
      const { rustCwd, nodeCwd } = twoFixtures("squashed", prep);
      const { r, n } = await pushBoth(rustCwd, nodeCwd, branch, lease);
      expectSameError(r, n, msg);
      expect(r.error).toBe(msg);
    }
    const { rustCwd, nodeCwd } = twoFixtures("squashed", (cwd) => {
      git(cwd, ["config", "branch.step-2.remote", "origin"]);
      git(cwd, ["config", "branch.step-2.merge", "refs/heads/step-2"]);
    });
    const { r, n } = await pushBoth(rustCwd, nodeCwd, "step-2", "nope");
    expectSameError(r, n, "bad lease");
    expect(r.error).toBe("invalid lease sha");
  }, 60_000);

  it("force-pushes one branch under its lease, identically", async () => {
    const prep = (cwd) => {
      git(cwd, ["push", "--quiet", "-u", "origin", "step-2"]);
      git(cwd, ["branch", "-f", "step-2", "step-1"]);
    };
    const { rustCwd, nodeCwd } = twoFixtures("squashed", prep);
    const stale = await pushBoth(rustCwd, nodeCwd, "step-2", lease);
    expectSame(stale.r, stale.n, "stale lease");
    expect(stale.r.value.success).toBe(false);
    const remote = git(rustCwd, ["rev-parse", "origin/step-2"]);
    const ok = await pushBoth(rustCwd, nodeCwd, "step-2", remote);
    expectSame(ok.r, ok.n, "good lease");
    expect(ok.r.value.success, ok.r.value.message).toBe(true);
    for (const cwd of [rustCwd, nodeCwd]) {
      git(cwd, ["fetch", "--quiet", "origin"]);
      expect(git(cwd, ["rev-parse", "origin/step-2"])).toBe(git(cwd, ["rev-parse", "step-1"]));
      expect(git(cwd, ["branch", "--show-current"])).toBe("step-3");
    }
  }, 60_000);

  it("/api/git-push uses the same lease check (no second copy)", async () => {
    const cwd = fixtureStack("squashed");
    const push = (leaseBranch) =>
      node(dev, "/api/git-push", { cwd, force: true, leaseBranch, leaseSha: lease });
    // U+00A0 is whitespace to Rust's `char::is_whitespace`.
    expect((await push("a b")).value).toEqual({ success: false, message: "invalid lease branch" });
    expect((await push("a\u0085b")).value).toEqual({ success: false, message: "invalid lease branch" });
  }, 30_000);
});

/**
 * The gh routes have no probe arm (they would need gh and the network):
 * their argument checks are pinned to the Rust command's own words
 * (`check_branch_pr_args`, `check_pr_number`, `check_pr_base` in
 * commands/gh.rs); each refusal happens before any gh call. The parsing
 * is unit-tested in src/__tests__/ghBranchPr.devserver.test.ts.
 */
describe("dev-server wire contract: gh stack routes", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;

  beforeAll(async () => {
    dev = await startDevServer();
  }, 20_000);

  afterAll(async () => {
    await dev?.stop();
  });

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
