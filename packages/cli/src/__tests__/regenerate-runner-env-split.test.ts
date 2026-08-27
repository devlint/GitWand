/**
 * Final review Finding 4 — the env allowlist's `GIT_*` prefix must reach the
 * two git plumbing spawns (`git worktree add`/`remove`/`prune`) but NOT the
 * spawned ecosystem installer (npm/pnpm/yarn/composer/cargo).
 *
 * CI systems commonly inject credentials via `GIT_CONFIG_COUNT`/
 * `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` (e.g.
 * `http.extraheader=Authorization: Basic <token>`) or
 * `GIT_ASKPASS`/`GIT_SSH_COMMAND`. None of the 5 registry installers need
 * any of these — this test proves they never reach the installer's spawned
 * environment, while confirming git worktree plumbing still gets `GIT_*`
 * (a real regression, fixed in an earlier round of this same lot, would
 * otherwise break `git worktree add` itself).
 *
 * Uses a real `cargo generate-lockfile` spawn (offline-capable, no network
 * dependency, skipped when `cargo` isn't on PATH) rather than mocking the
 * installer — only the environment actually delivered to each spawned
 * process is observed, via a real passthrough wrapper around
 * `node:child_process`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync as realExecFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REGEN_ECOSYSTEMS, type RegenEcosystem } from "@gitwand/core";

const { spawnCalls } = vi.hoisted(() => ({
  spawnCalls: [] as Array<{ bin: string; env: NodeJS.ProcessEnv }>,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (
      bin: string,
      args: string[],
      options: Record<string, unknown>,
      callback: (...cbArgs: unknown[]) => void,
    ) => {
      spawnCalls.push({ bin, env: (options?.env as NodeJS.ProcessEnv) ?? {} });
      return actual.execFile(bin, args, options as any, callback as any);
    },
  };
});

const { runRegeneration, isToolchainAvailable } = await import("../regenerate-runner.js");

function ecosystemFor(id: RegenEcosystem["id"]): RegenEcosystem {
  const eco = REGEN_ECOSYSTEMS.find((e) => e.id === id);
  if (!eco) throw new Error(`registre : écosystème "${id}" introuvable`);
  return eco;
}

const IT_TIMEOUT = { timeout: 30_000 };
const SUSPECT_KEYS = [
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "GIT_ASKPASS",
  "GIT_SSH_COMMAND",
];

describe.skipIf(!isToolchainAvailable("cargo"))(
  "regenerate-runner — env allowlist split (Finding 4, final review)",
  () => {
    let repo: string;
    let prevEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
      repo = mkdtempSync(join(tmpdir(), "gw-regen-env-split-"));
      realExecFileSync("git", ["init", "-b", "main"], { cwd: repo });
      realExecFileSync("git", ["config", "user.email", "t@t.t"], { cwd: repo });
      realExecFileSync("git", ["config", "user.name", "t"], { cwd: repo });
      realExecFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repo });

      prevEnv = { ...process.env };
      Object.assign(process.env, {
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_EDITOR: "true",
        GIT_SEQUENCE_EDITOR: "true",
        GIT_PAGER: "cat",
        // Simulated CI-injected credential-carrying vars — must never reach
        // the installer spawn's environment.
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraheader",
        GIT_CONFIG_VALUE_0: "Authorization: Basic super-secret-token",
        GIT_ASKPASS: "/bin/false-askpass",
        GIT_SSH_COMMAND: "ssh -o SomethingSecret=1",
      });
      spawnCalls.length = 0;
    });

    afterEach(() => {
      process.env = prevEnv;
      rmSync(repo, { recursive: true, force: true });
    });

    it(
      "strips GIT_CONFIG_*/GIT_ASKPASS/GIT_SSH_COMMAND from the cargo spawn but keeps them for git worktree plumbing",
      IT_TIMEOUT,
      async () => {
        const cargoToml = '[package]\nname = "t"\nversion = "0.1.0"\nedition = "2021"\n';
        mkdirSync(join(repo, "src"), { recursive: true });
        writeFileSync(join(repo, "Cargo.toml"), cargoToml, "utf-8");
        writeFileSync(join(repo, "src/main.rs"), "fn main() {}\n", "utf-8");
        realExecFileSync("git", ["add", "-A"], { cwd: repo });
        realExecFileSync("git", ["commit", "-m", "init"], { cwd: repo });

        const outcome = await runRegeneration({
          repoRoot: repo,
          file: "Cargo.lock",
          ecosystem: ecosystemFor("cargo"),
          resolvedSources: [{ path: "Cargo.toml", content: cargoToml }],
        });

        expect(outcome.kind).toBe("success");

        const gitCalls = spawnCalls.filter((c) => c.bin === "git");
        const cargoCalls = spawnCalls.filter((c) => c.bin === "cargo");
        expect(gitCalls.length).toBeGreaterThan(0);
        expect(cargoCalls.length).toBeGreaterThan(0);

        // Git plumbing keeps GIT_* — this is the property fixed earlier in
        // this lot (regression: `git worktree add` fails without it).
        for (const call of gitCalls) {
          expect(call.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
        }

        // The installer spawn must not carry ANY of the credential-shaped
        // GIT_* vars, even though it's still allowed ordinary PATH/HOME.
        for (const call of cargoCalls) {
          for (const key of SUSPECT_KEYS) {
            expect(call.env[key]).toBeUndefined();
          }
          expect(call.env.PATH).toBeDefined();
        }
      },
    );
  },
);
