/**
 * Parity: the Rust command and the dev-server route must REFUSE identically.
 *
 * Following the read-file precedent (this suite's structure copies
 * read-file.test.mjs): no test arms an auto-merge on a live PR; what is
 * checkable, and what has historically drifted, is whether the two backends
 * agree on failure. A repository with no forge remote is the cheapest way to
 * make both refuse for the same reason.
 *
 * The two sides phrase the failure differently on purpose: Rust prefixes its
 * error ("gh pr merge --auto failed: ..."), the dev-server returns the bare
 * stderr, exactly like the two existing merge paths already do. What must
 * agree is the CLASS of failure, not the string, so the comparison below
 * normalises both sides before comparing.
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { startDevServer } from "./dev-server-runner.mjs";
import { runProbe } from "./probe.mjs";
import { mkTempRepo } from "./fixtures.mjs";

/** POST /api/gh-enable-auto-merge, returning the same {ok, error} shape as runProbe. */
async function nodeEnableAutoMerge(dev, cwd, number, method) {
  const res = await dev.fetch("/api/gh-enable-auto-merge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, number, method }),
  });
  const data = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, value: data } : { ok: false, error: data.error };
}

/** POST /api/gl-enable-auto-merge, returning the same {ok, error} shape as runProbe. */
async function nodeEnableAutoMergeGl(dev, cwd, iid, method) {
  const res = await dev.fetch("/api/gl-enable-auto-merge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, iid, method }),
  });
  const data = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, value: data } : { ok: false, error: data.error };
}

/**
 * Collapse the parts that legitimately differ between the two backends down
 * to a single class.
 *
 * The dev-server route always shells out to the forge CLI; the Rust command
 * goes through the GraphQL/REST path whenever a GitHub token is configured
 * locally (see `gh_enable_auto_merge_inner`), so the two phrasings for "this
 * repo has no forge remote" are NOT the same string even with no network:
 *   - `gh` CLI:        "no git remotes found"
 *   - Rust token path: "No 'origin' remote found in this repo."
 *
 * Which refusal you actually get depends on what the machine has, and that is
 * the whole reason this returns a class rather than a boolean. A developer
 * laptop has a keychain token or an authenticated `gh`, so the refusal really
 * is about the missing remote. A CI runner has neither: `gh` is preinstalled
 * but unauthenticated and refuses on the missing credential BEFORE it ever
 * looks at remotes, and `glab` is not installed at all, so the spawn itself
 * fails. Both are legitimate refusals of an operation that cannot proceed,
 * and neither reaches the no-remote path.
 *
 * So: three recognised refusal classes, and `other` for everything else. The
 * `other` bucket is what keeps this test honest, since an unrelated failure
 * (a real network error, a changed CLI contract) must not pass as agreement.
 */
function classifyForgeError(msg) {
  const lower = String(msg).toLowerCase();
  // Order matters: a missing binary's io error can mention a path containing
  // almost anything, so the spawn failure is recognised before the others.
  if (
    lower.includes("no such file or directory") ||
    lower.includes("os error 2") ||
    lower.includes("executable file not found") ||
    lower.includes("program not found") ||
    // Node's phrasing for the same thing: `spawnSync glab ENOENT`.
    lower.includes("enoent")
  ) {
    return "no-cli";
  }
  if (
    lower.includes("auth login") ||
    lower.includes("gh_token") ||
    lower.includes("glab_token") ||
    lower.includes("not authenticated")
  ) {
    return "no-auth";
  }
  if (lower.includes("remote")) return "no-remote";
  return "other";
}

/** The refusals that mean "this operation could not proceed", as opposed to
 *  an unrelated failure that must not pass as cross-side agreement. */
const KNOWN_REFUSALS = ["no-remote", "no-auth", "no-cli"];

/**
 * Both backends must refuse, for a recognised reason, and for the SAME
 * reason. The raw messages travel into the assertion text on purpose: when
 * this last failed, the classes alone ("expected 'other' to be 'no-remote'")
 * said nothing about what either side printed, and recovering that took a
 * local reproduction of both CLIs.
 */
function expectSameRefusal(rust, node) {
  expect(rust.ok, `rust unexpectedly accepted: ${rust.error}`).toBe(false);
  expect(node.ok, `node unexpectedly accepted: ${node.error}`).toBe(false);
  const rustClass = classifyForgeError(rust.error);
  const nodeClass = classifyForgeError(node.error);
  expect(
    KNOWN_REFUSALS,
    `rust refused for an unrecognised reason: ${rust.error}`,
  ).toContain(rustClass);
  expect(
    nodeClass,
    `the two backends refused for different reasons.\n  rust (${rustClass}): ${rust.error}\n  node (${nodeClass}): ${node.error}`,
  ).toBe(rustClass);
}


/**
 * Detect `runProbe`'s timeout shape (`probe.mjs`'s `spawnSync(..., { timeout:
 * 10_000 })`) rather than let it masquerade as an ordinary class mismatch.
 *
 * The probe reads the macOS keychain through `settings_github_token()`, and
 * it is an unsigned binary, so the FIRST keychain access after any rebuild
 * (`cargo build --example parity-probe`) blocks on an OS authorization
 * decision. That takes minutes; `runProbe` kills the child at 10s via Node's
 * `spawnSync` timeout, which surfaces as `result.error.code === "ETIMEDOUT"`
 * (message `"spawnSync <bin> ETIMEDOUT"`) and `exitCode: -1`. Left
 * unrecognised, this looks exactly like `classifyForgeError` bucketing an
 * ordinary mismatch as `"other"`: a phantom bug report, not a real one.
 */
function looksLikeProbeTimeout(result) {
  return result.exitCode === -1 && /ETIMEDOUT/.test(String(result.error));
}

describe("parity: auto-merge refusal", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;

  beforeAll(async () => {
    dev = await startDevServer();
  }, 15_000);

  afterAll(async () => {
    await dev?.stop();
  });

  it("both backends refuse enabling auto-merge on a repo with no forge remote", async () => {
    const cwd = mkTempRepo("gw-auto-merge-refusal-");
    const rust = runProbe("gh-enable-auto-merge", { cwd, number: 1, method: "squash" });
    const node = await nodeEnableAutoMerge(dev, cwd, 1, "squash");

    if (looksLikeProbeTimeout(rust)) {
      throw new Error(
        "parity-probe timed out. This is almost certainly the first keychain " +
          "access by a freshly built probe binary, not a bug in the command. " +
          "Re-running the suite will NOT fix this: the suite's own 10 second " +
          "timeout kills the probe before the OS authorization decision " +
          "completes, so it is never remembered. Run the probe once directly " +
          "with no timeout and let it finish (it can take several minutes), " +
          "then run the suite again, for example: " +
          "echo '{\"cwd\":\"/tmp/anyrepo\",\"number\":1,\"method\":\"squash\"}' " +
          "| src-tauri/target/debug/examples/parity-probe gh-enable-auto-merge",
      );
    }

    expectSameRefusal(rust, node);
  });

  it("both backends refuse disabling auto-merge on a repo with no forge remote", async () => {
    const cwd = mkTempRepo("gw-auto-merge-refusal-");
    const rust = runProbe("gh-disable-auto-merge", { cwd, number: 1 });
    const res = await dev.fetch("/api/gh-disable-auto-merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, number: 1 }),
    });
    const nodeData = await res.json().catch(() => ({}));
    const node = res.ok ? { ok: true } : { ok: false, error: nodeData.error };

    if (looksLikeProbeTimeout(rust)) {
      throw new Error(
        "parity-probe timed out. This is almost certainly the first keychain " +
          "access by a freshly built probe binary, not a bug in the command. " +
          "Re-running the suite will NOT fix this: the suite's own 10 second " +
          "timeout kills the probe before the OS authorization decision " +
          "completes, so it is never remembered. Run the probe once directly " +
          "with no timeout and let it finish (it can take several minutes), " +
          "then run the suite again, for example: " +
          "echo '{\"cwd\":\"/tmp/anyrepo\",\"number\":1,\"method\":\"squash\"}' " +
          "| src-tauri/target/debug/examples/parity-probe gh-enable-auto-merge",
      );
    }

    expectSameRefusal(rust, node);
  });

  it("both backends refuse enabling auto-merge on a GitLab MR with no forge remote", async () => {
    const cwd = mkTempRepo("gw-auto-merge-refusal-");
    const rust = runProbe("gl-enable-auto-merge", { cwd, iid: 1, method: "merge" });
    const node = await nodeEnableAutoMergeGl(dev, cwd, 1, "merge");

    if (looksLikeProbeTimeout(rust)) {
      throw new Error(
        "parity-probe timed out. This is almost certainly the first keychain " +
          "access by a freshly built probe binary, not a bug in the command. " +
          "Re-running the suite will NOT fix this: the suite's own 10 second " +
          "timeout kills the probe before the OS authorization decision " +
          "completes, so it is never remembered. Run the probe once directly " +
          "with no timeout and let it finish (it can take several minutes), " +
          "then run the suite again, for example: " +
          "echo '{\"cwd\":\"/tmp/anyrepo\",\"number\":1,\"method\":\"squash\"}' " +
          "| src-tauri/target/debug/examples/parity-probe gh-enable-auto-merge",
      );
    }

    expectSameRefusal(rust, node);
  });

  it("both backends refuse disabling auto-merge on a GitLab MR with no forge remote", async () => {
    const cwd = mkTempRepo("gw-auto-merge-refusal-");
    const rust = runProbe("gl-disable-auto-merge", { cwd, iid: 1 });
    const res = await dev.fetch("/api/gl-disable-auto-merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, iid: 1 }),
    });
    const nodeData = await res.json().catch(() => ({}));
    const node = res.ok ? { ok: true } : { ok: false, error: nodeData.error };

    if (looksLikeProbeTimeout(rust)) {
      throw new Error(
        "parity-probe timed out. This is almost certainly the first keychain " +
          "access by a freshly built probe binary, not a bug in the command. " +
          "Re-running the suite will NOT fix this: the suite's own 10 second " +
          "timeout kills the probe before the OS authorization decision " +
          "completes, so it is never remembered. Run the probe once directly " +
          "with no timeout and let it finish (it can take several minutes), " +
          "then run the suite again, for example: " +
          "echo '{\"cwd\":\"/tmp/anyrepo\",\"number\":1,\"method\":\"squash\"}' " +
          "| src-tauri/target/debug/examples/parity-probe gh-enable-auto-merge",
      );
    }

    expectSameRefusal(rust, node);
  });

  // Azure is intentionally absent from this suite. Every other az* command
  // in backend-pr.ts is desktop-only by design (`if (isTauri()) ...` else
  // throw AZURE_WEB_ONLY): Azure auth is an Entra device flow held in the
  // OS keychain, which dev-server.mjs (a plain Node process) cannot reach.
  // There is deliberately no second, dev-server-side implementation of the
  // Azure auto-complete calls to compare against, so there is nothing for a
  // parity test to pin here. Azure's coverage is the Rust-side unit tests
  // (`az_auto_complete_body_tests` in azure.rs) plus manual verification in
  // the packaged app, the only place this feature has ever run.
});
