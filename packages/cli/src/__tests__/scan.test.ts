import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdScan } from "../commands/scan.js";

function initRepo(): string {
  const raw = mkdtempSync(join(tmpdir(), "gw-cli-scan-"));
  const cwd = realpathSync(raw);
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "GitWand Test"]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "test@gitwand.dev"]);
  return cwd;
}

function stageFile(cwd: string, relPath: string, content: string): void {
  const abs = join(cwd, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf-8");
  execFileSync("git", ["-C", cwd, "add", "--", relPath]);
}

// Every test here goes through `initRepo()`, which runs `git init` plus two
// `git config` calls, and `stageFile()` adds a `git add` per file. Per
// AGENTS.md the git layer is deliberately not mocked, so these are
// subprocess-bound and slow down sharply when the whole monorepo runs at once,
// which is how `pnpm test` and CI run them. The hooks carry the timeout too:
// they are outside the `describe`, so its option does not reach them.
//
// 60s is deliberately generous, and matches the other git-backed suites. A
// timeout here exists to catch a hang, not to enforce a performance budget,
// and it costs nothing on a passing run. Tuning it down to "just above
// observed" is what produced the flake in issue #172.
const GIT_IO_TIMEOUT_MS = 60_000

let repoDir: string;
let originalCwd: string;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  originalCwd = process.cwd();
  repoDir = initRepo();
  process.chdir(repoDir);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  process.exitCode = 0;
}, GIT_IO_TIMEOUT_MS);

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(repoDir, { recursive: true, force: true });
  logSpy.mockRestore();
  process.exitCode = 0;
}, GIT_IO_TIMEOUT_MS);

describe("gitwand scan", { timeout: GIT_IO_TIMEOUT_MS }, () => {
  it("reports a finding for a secret on a staged added line", async () => {
    stageFile(repoDir, "src/config.ts", 'const key = "AKIAABCDEFGHIJKLMNOP";\n');

    await cmdScan({});

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("aws_access_key_id");
    expect(output).toContain("src/config.ts");
  });

  it("--json prints a machine-readable { findings } shape", async () => {
    stageFile(repoDir, "src/config.ts", 'const key = "AKIAABCDEFGHIJKLMNOP";\n');

    await cmdScan({ json: true });

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed.findings)).toBe(true);
    expect(parsed.findings.length).toBe(1);
    expect(parsed.findings[0].patternId).toBe("aws_access_key_id");
    expect(parsed.findings[0].file).toBe("src/config.ts");
  });

  it("stdout never contains the raw planted secret verbatim", async () => {
    const secret = "AKIAABCDEFGHIJKLMNOP";
    stageFile(repoDir, "src/config.ts", `const key = "${secret}";\n`);

    await cmdScan({ json: true });

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).not.toContain(secret);
  });

  it("exit code stays 0 by default even when findings exist (non-blocking UX)", async () => {
    stageFile(repoDir, "src/config.ts", 'const key = "AKIAABCDEFGHIJKLMNOP";\n');

    await cmdScan({});

    expect(process.exitCode).toBe(0);
  });

  it("--strict sets exit code 1 when findings exist", async () => {
    stageFile(repoDir, "src/config.ts", 'const key = "AKIAABCDEFGHIJKLMNOP";\n');

    await cmdScan({ strict: true });

    expect(process.exitCode).toBe(1);
  });

  it("--strict with no findings leaves exit code 0", async () => {
    stageFile(repoDir, "src/benign.ts", "export const x = 1;\n");

    await cmdScan({ strict: true });

    expect(process.exitCode).toBe(0);
  });

  it("nothing staged reports no findings", async () => {
    await cmdScan({ json: true });

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    const parsed = JSON.parse(output);
    expect(parsed.findings).toEqual([]);
  });

  it("does not flag a pnpm-lock.yaml integrity hash by default (D5)", async () => {
    stageFile(
      repoDir,
      "pnpm-lock.yaml",
      "  integrity: sha512-aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5zA7bC9dE1fG3hI5jK7lM9nO1pQ3rS5tU7vW9xY1zA3bC5dE7fG9==\n",
    );

    await cmdScan({ json: true });

    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    const parsed = JSON.parse(output);
    expect(parsed.findings).toEqual([]);
  });
});
