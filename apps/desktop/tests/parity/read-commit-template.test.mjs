/**
 * Parity tests: `read_commit_template` (Rust) vs `/api/read-commit-template`
 * (Node dev-server).
 *
 * Run: `pnpm --filter @gitwand/desktop test:parity`
 *
 * The path comes from `git config commit.template` on both sides, never from
 * the caller, and only a small regular file is read. Every case sets the key
 * in the fixture repo itself, so a template in the host's global config never
 * leaks in (an empty value is how git config says "unset" over a global one).
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startDevServer } from "./dev-server-runner.mjs";
import { runProbe } from "./probe.mjs";
import { mkTempRepo } from "./fixtures.mjs";

/** POST /api/read-commit-template, in the same {ok, value, error} shape as runProbe. */
async function nodeReadTemplate(dev, cwd) {
  const res = await dev.fetch("/api/read-commit-template", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
  const data = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, value: data } : { ok: false, error: data.error };
}

/** Repos made by this file, removed in `afterAll`. */
const repos = [];

/** A repo whose local `commit.template` is `value`. */
function repoWithTemplate(value) {
  const cwd = mkTempRepo("gw-commit-template-");
  repos.push(cwd);
  execFileSync("git", ["-C", cwd, "config", "commit.template", value]);
  return cwd;
}

describe("parity: read-commit-template", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;

  beforeAll(async () => {
    dev = await startDevServer();
  }, 15_000);

  afterAll(async () => {
    await dev?.stop();
    for (const cwd of repos.splice(0)) rmSync(cwd, { recursive: true, force: true });
  });

  it("an empty commit.template answers null on both sides", async () => {
    const cwd = repoWithTemplate("");
    const rust = runProbe("read-commit-template", { cwd });
    const node = await nodeReadTemplate(dev, cwd);
    expect(rust.ok, rust.error).toBe(true);
    expect(node).toEqual({ ok: true, value: { content: null } });
    expect(rust.value).toEqual(node.value);
  });

  it("a configured template returns identical content", async () => {
    const cwd = repoWithTemplate("");
    const path = join(cwd, ".gitmessage");
    writeFileSync(path, "Subject\n\n# Why:\n# Refs: #\n", "utf-8");
    execFileSync("git", ["-C", cwd, "config", "commit.template", path]);
    const rust = runProbe("read-commit-template", { cwd });
    const node = await nodeReadTemplate(dev, cwd);
    expect(node).toEqual({ ok: true, value: { content: "Subject\n\n# Why:\n# Refs: #\n" } });
    expect(rust).toMatchObject({ ok: true, value: node.value });
  });

  it("a directory is refused with the same message", async () => {
    const cwd = repoWithTemplate("");
    const dir = join(cwd, "template-dir");
    mkdirSync(dir);
    execFileSync("git", ["-C", cwd, "config", "commit.template", dir]);
    const rust = runProbe("read-commit-template", { cwd });
    const node = await nodeReadTemplate(dev, cwd);
    expect(node.ok).toBe(false);
    expect(rust.ok).toBe(false);
    expect(rust.error).toBe(`Commit template is not a small regular file: ${dir}`);
    expect(node.error).toBe(rust.error);
  });

  it("a template over 64 KiB is refused with the same message", async () => {
    const cwd = repoWithTemplate("");
    const path = join(cwd, "huge.txt");
    writeFileSync(path, "x".repeat(64 * 1024 + 1), "utf-8");
    execFileSync("git", ["-C", cwd, "config", "commit.template", path]);
    const rust = runProbe("read-commit-template", { cwd });
    const node = await nodeReadTemplate(dev, cwd);
    expect(node.ok).toBe(false);
    expect(rust.ok).toBe(false);
    expect(rust.error).toBe(`Commit template is not a small regular file: ${path}`);
    expect(node.error).toBe(rust.error);
  });

  it("a missing template is refused on both sides, naming the path", async () => {
    const cwd = repoWithTemplate("");
    const path = join(cwd, "missing.txt");
    execFileSync("git", ["-C", cwd, "config", "commit.template", path]);
    const rust = runProbe("read-commit-template", { cwd });
    const node = await nodeReadTemplate(dev, cwd);
    // The OS error text differs between Rust and Node; the prefix is shared.
    const prefix = `Failed to read commit template ${path}: `;
    expect(rust.ok).toBe(false);
    expect(node.ok).toBe(false);
    expect(rust.error.startsWith(prefix), rust.error).toBe(true);
    expect(node.error.startsWith(prefix), node.error).toBe(true);
  });
});
