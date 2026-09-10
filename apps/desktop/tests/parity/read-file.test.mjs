/**
 * Parity tests: `read_file` (Rust) vs `/api/read-file` (Node dev-server).
 *
 * Run: `pnpm --filter @gitwand/desktop test:parity`
 *
 * Prerequisite: the Rust probe must be built at least once
 *   cargo build --example parity-probe
 * (see README.md in this folder).
 *
 * Why this file exists, and why it asserts on failure:
 *
 * Every other parity test compares two successes. This command's drift was the
 * opposite shape. Rust's `read_file` is `std::fs::read_to_string`, which
 * rejects a file that is not valid UTF-8; the dev-server called
 * `readFileSync(path, "utf-8")`, which substitutes U+FFFD and succeeds. Both
 * "worked", so nothing caught it.
 *
 * The cost was real: a non-UTF-8 file among a repository's conflicts made
 * *every* conflict unresolvable in the packaged app, while the same repository
 * loaded fine under `pnpm dev:web`. Manual QA on that exact path came back
 * green (issue #188, bug fixed in #187).
 *
 * So: agreeing on success is not enough. These cases pin that both backends
 * refuse the same input, for the same stated reason.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { startDevServer } from "./dev-server-runner.mjs";
import { runProbe } from "./probe.mjs";
import { fixtureReadFile } from "./fixtures.mjs";

/** POST /api/read-file, returning the same {ok, value, error} shape as runProbe. */
async function nodeReadFile(dev, cwd, path) {
  const res = await dev.fetch("/api/read-file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, path }),
  });
  const data = await res.json().catch(() => ({}));
  return res.ok
    ? { ok: true, value: data.content }
    : { ok: false, error: data.error };
}

describe("parity: read-file", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;

  beforeAll(async () => {
    dev = await startDevServer();
  }, 15_000);

  afterAll(async () => {
    await dev?.stop();
  });

  it("a UTF-8 file returns identical content on both sides", async () => {
    const cwd = fixtureReadFile();
    const rust = runProbe("read-file", { cwd, path: "ok.txt" });
    const node = await nodeReadFile(dev, cwd, "ok.txt");

    expect(rust.ok, `rust failed: ${rust.error}`).toBe(true);
    expect(node.ok, `node failed: ${node.error}`).toBe(true);
    expect(node.value).toBe(rust.value);
    // Non-ASCII must survive the round trip, not arrive mangled.
    expect(rust.value).toContain("héllo wörld");
  });

  it("a non-UTF-8 file is REFUSED by both sides", async () => {
    const cwd = fixtureReadFile();
    const rust = runProbe("read-file", { cwd, path: "bad.bin" });
    const node = await nodeReadFile(dev, cwd, "bad.bin");

    // The whole point: this used to succeed on Node and fail on Rust.
    expect(rust.ok, "rust unexpectedly accepted a non-UTF-8 file").toBe(false);
    expect(node.ok, "node unexpectedly accepted a non-UTF-8 file").toBe(false);
  });

  it("both sides give the same reason for refusing it", async () => {
    const cwd = fixtureReadFile();
    const rust = runProbe("read-file", { cwd, path: "bad.bin" });
    const node = await nodeReadFile(dev, cwd, "bad.bin");

    // Callers surface this string, so it is part of the contract.
    expect(rust.error).toMatch(/stream did not contain valid UTF-8/);
    expect(node.error).toBe(rust.error);
  });

  it("a missing file is refused by both sides", async () => {
    const cwd = fixtureReadFile();
    const rust = runProbe("read-file", { cwd, path: "nope.txt" });
    const node = await nodeReadFile(dev, cwd, "nope.txt");

    expect(rust.ok).toBe(false);
    expect(node.ok).toBe(false);
    // Wording of the OS error differs; agreeing that it failed, and naming the
    // path, is the contract worth pinning.
    expect(rust.error).toContain("nope.txt");
    expect(node.error).toContain("nope.txt");
  });

  it("a path escaping the repo is refused by both sides", async () => {
    const cwd = fixtureReadFile();
    const rust = runProbe("read-file", { cwd, path: "../../../etc/passwd" });
    const node = await nodeReadFile(dev, cwd, "../../../etc/passwd");

    expect(rust.ok, "rust must not read outside the repo").toBe(false);
    expect(node.ok, "node must not read outside the repo").toBe(false);
  });
});
