/**
 * v3.11.1 — `GitRunner` for `@gitwand/core`'s history-aware LLM fallback.
 *
 * Discrete args via `execFile` (no shell). The child gets the parent's
 * environment minus anything that looks like a secret: the CLI holds LLM API
 * keys in env, and git has no use for them (AGENTS.md — never pass secrets to
 * spawned processes).
 */

import { execFile } from "node:child_process";
import type { GitRunner } from "@gitwand/core";

const SECRET_RE = /(API_KEY|TOKEN|SECRET|PASSWORD)$/i;

export function gitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!SECRET_RE.test(k)) out[k] = v;
  return out;
}

export function makeCliGitRunner(cwd: string = process.cwd()): GitRunner {
  const env = gitEnv();
  return (args) =>
    new Promise((resolve) => {
      execFile("git", args, { cwd, env, encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        // A numeric code is git's own exit status. Anything else (ENOENT for a
        // missing cwd or git binary, ERR_CHILD_PROCESS_STDIO_MAXBUFFER, …) is a
        // spawn failure: report -1, never 1, which core reads as "no merge base".
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : -1) : 0;
        resolve({ stdout: stdout ?? "", exitCode: code });
      });
    });
}
