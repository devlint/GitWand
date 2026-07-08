/**
 * Parity tests — `scan_secrets` (Rust `regex` crate) vs `/api/scan-secrets` (Node dev-server,
 * backed by the `@gitwand/core` TS engine).
 *
 * Run : `pnpm --filter @gitwand/desktop test:parity`
 *
 * This is the drift lock for the dual-scanner architecture (v3.5.0) — if Rust and the TS
 * engine ever disagree on a fixture, fix the engine that is wrong, never weaken the fixture.
 *
 * Portée :
 *  - multi-pattern file  → AWS key + GitHub token on separate staged added lines
 *  - ignore-glob case    → a `fixtures/**` path is entirely suppressed
 *  - entropy case        → a high-entropy blob is flagged once the threshold is enabled
 *  - no staged changes   → both engines return an empty array
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { startDevServer } from "./dev-server-runner.mjs";
import { assertParity } from "./harness.mjs";
import { mkTempRepo } from "./fixtures.mjs";

/** Writes + `git add`s a file inside an already-initialized temp repo (no commit — staged only). */
function stageFile(cwd, relPath, content) {
  const abs = join(cwd, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf-8");
  execFileSync("git", ["-C", cwd, "add", "--", relPath]);
}

const BASE_CONFIG = {
  enabled: true,
  extraPatterns: [],
  ignore: [],
  entropyThreshold: 0,
};

describe("parity: scan-secrets", () => {
  /** @type {Awaited<ReturnType<typeof startDevServer>>} */
  let dev;

  beforeAll(async () => {
    dev = await startDevServer();
  }, 15_000);

  afterAll(async () => {
    await dev?.stop();
  });

  it("multi-pattern file: AWS key + GitHub token on separate added lines", async () => {
    const cwd = mkTempRepo("gw-secrets-multi-");
    stageFile(
      cwd,
      "src/config.ts",
      [
        'const key = "AKIAABCDEFGHIJKLMNOP";',
        'const token = "ghp_ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEF";',
      ].join("\n") + "\n",
    );

    await assertParity(dev, {
      command: "scan-secrets",
      args: { cwd, config: BASE_CONFIG },
      httpPath: "/api/scan-secrets",
      method: "POST",
      body: { cwd, config: BASE_CONFIG },
    });
  });

  it("ignore-glob case: a fixtures/** path is entirely suppressed", async () => {
    const cwd = mkTempRepo("gw-secrets-ignore-");
    stageFile(cwd, "fixtures/sample.ts", 'const key = "AKIAABCDEFGHIJKLMNOP";\n');
    const config = { ...BASE_CONFIG, ignore: ["fixtures/**"] };

    await assertParity(dev, {
      command: "scan-secrets",
      args: { cwd, config },
      httpPath: "/api/scan-secrets",
      method: "POST",
      body: { cwd, config },
    });
  });

  it("entropy case: a high-entropy blob is flagged once the threshold is enabled", async () => {
    const cwd = mkTempRepo("gw-secrets-entropy-");
    stageFile(cwd, "src/blob.ts", 'const token = "aZ3xQ9mK2pL7vN5wR8tY1cB4fH6jD0sE2gU9iO3k";\n');
    const config = { ...BASE_CONFIG, entropyThreshold: 4.0 };

    await assertParity(dev, {
      command: "scan-secrets",
      args: { cwd, config },
      httpPath: "/api/scan-secrets",
      method: "POST",
      body: { cwd, config },
    });
  });

  it("no staged changes → both engines return an empty array", async () => {
    const cwd = mkTempRepo("gw-secrets-empty-");
    // Nothing staged — repo has no commits and no index entries.

    await assertParity(dev, {
      command: "scan-secrets",
      args: { cwd, config: BASE_CONFIG },
      httpPath: "/api/scan-secrets",
      method: "POST",
      body: { cwd, config: BASE_CONFIG },
    });
  });
});
