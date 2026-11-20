/**
 * The repository bits several MCP tools read: git queries that never throw,
 * and the repository's `.gitwandrc` (or `.gitwandrc.json`).
 */

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { parseGitwandrc, type GitWandrcConfig } from "@gitwand/core";
import { run } from "./spawn.js";
import { childEnv } from "./child-env.js";

/**
 * The environment git runs with (AGENTS.md: only what the child needs): the
 * shared base list, git's user config dir, and git's own `GIT_*` variables
 * (`GIT_DIR`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_KEY_n`…) except any that names
 * a secret — no forge or AI token reaches it.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  return childEnv(["XDG_CONFIG_HOME"], { prefix: "GIT_", refuse: /TOKEN|PASSWORD|SECRET|API_KEY/i });
}

/** Room for a large diff or log: execFileSync's default (1 MiB) would fail as "no output". */
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

/**
 * `git args…` in `cwd` (array args, no shell): trimmed stdout — possibly
 * empty — or null on failure.
 */
export function gitOutput(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, env: gitEnv(), encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, maxBuffer: MAX_GIT_OUTPUT }).trim();
  } catch {
    return null;
  }
}

/** `gitOutput`, with no output counted as none: a value or null. */
export function gitTry(cwd: string, args: string[]): string | null {
  return gitOutput(cwd, args) || null;
}

/**
 * `gitTry` without blocking the event loop, bounded like every other process
 * the tools wait on (`run`): null after `timeoutMs` too.
 */
export async function gitTryAsync(cwd: string, args: string[], timeoutMs = 30_000): Promise<string | null> {
  const r = await run("git", args, { cwd, env: gitEnv(), timeoutMs });
  return r.code === 0 && !r.timedOut && !r.capped ? r.stdout.trim() || null : null;
}

/** A file's content at `rev`, byte for byte (an empty file is ""), or null when absent. */
export function gitBlob(cwd: string, rev: string, file: string): string | null {
  try {
    return execFileSync("git", ["show", `${rev}:${file}`], {
      cwd,
      env: gitEnv(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      maxBuffer: MAX_GIT_OUTPUT,
    });
  } catch {
    return null;
  }
}

const GITWANDRC_FILES = [".gitwandrc", ".gitwandrc.json"];

/** The first content that parses (`null` = that file could not be read). */
function firstValid(contents: Array<string | null>): GitWandrcConfig | null {
  for (const content of contents) {
    if (content === null) continue;
    const parsed = parseGitwandrc(content);
    if (parsed !== null) return parsed;
  }
  return null;
}

/**
 * The first readable, valid `.gitwandrc` / `.gitwandrc.json` at the
 * repository root `root`, or null — the lookup the CLI does too.
 */
export function readGitwandrc(root: string): GitWandrcConfig | null {
  return firstValid(
    GITWANDRC_FILES.map((f) => {
      try {
        return readFileSync(join(root, f), "utf-8");
      } catch {
        return null;
      }
    }),
  );
}

/** `readGitwandrc` without blocking the event loop. */
export async function readGitwandrcAsync(root: string): Promise<GitWandrcConfig | null> {
  return firstValid(await Promise.all(GITWANDRC_FILES.map((f) => readFile(join(root, f), "utf-8").catch(() => null))));
}
