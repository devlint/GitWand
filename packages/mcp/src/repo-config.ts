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

/** What git may see of this process's environment, beyond its own `GIT_*` settings. */
const GIT_ENV_ALLOW = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "SystemRoot",
  "windir",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "XDG_CONFIG_HOME",
];

/**
 * The environment git runs with (AGENTS.md: only what the child needs): the
 * allow-list above and git's own `GIT_*` variables (`GIT_DIR`,
 * `GIT_CONFIG_GLOBAL`…), but none that names a secret — no forge or AI token
 * reaches it.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    // `GIT_CONFIG_COUNT` / `_KEY_n` / `_VALUE_n` are git's own config: kept.
    const gits = k.startsWith("GIT_") && !/TOKEN|PASSWORD|SECRET|API_KEY/i.test(k);
    if (GIT_ENV_ALLOW.includes(k) || gits) env[k] = v;
  }
  return env;
}

/**
 * `git args…` in `cwd` (array args, no shell): trimmed stdout — possibly
 * empty — or null on failure.
 */
export function gitOutput(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, env: gitEnv(), encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
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
      maxBuffer: 64 * 1024 * 1024,
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
