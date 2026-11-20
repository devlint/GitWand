/**
 * The repository bits several MCP tools read: git queries that never throw,
 * and the repository's `.gitwandrc` (or `.gitwandrc.json`).
 */

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { execFile, execFileSync } from "node:child_process";
import { join } from "node:path";
import { parseGitwandrc, type GitWandrcConfig } from "@gitwand/core";

/**
 * `git args…` in `cwd` (array args, no shell): trimmed stdout — possibly
 * empty — or null on failure.
 */
export function gitOutput(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
  } catch {
    return null;
  }
}

/** `gitOutput`, with no output counted as none: a value or null. */
export function gitTry(cwd: string, args: string[]): string | null {
  return gitOutput(cwd, args) || null;
}

/** `gitTry` without blocking the event loop (for tools that wait on the network too). */
export function gitTryAsync(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, encoding: "utf-8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout.trim() || null);
    });
  });
}

/** A file's content at `rev`, byte for byte (an empty file is ""), or null when absent. */
export function gitBlob(cwd: string, rev: string, file: string): string | null {
  try {
    return execFileSync("git", ["show", `${rev}:${file}`], {
      cwd,
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
