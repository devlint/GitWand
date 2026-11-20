/**
 * The repository bits several MCP tools read: a git query that never throws,
 * and the repository's `.gitwandrc` (or `.gitwandrc.json`).
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { parseGitwandrc, type GitWandrcConfig } from "@gitwand/core";

/** `git args…` in `cwd`: trimmed stdout, or null on failure or no output. */
export function gitTry(cwd: string, args: string[]): string | null {
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * The first readable, valid `.gitwandrc` / `.gitwandrc.json` at the
 * repository root `root`, or null — the lookup the CLI does too.
 */
export function readGitwandrc(root: string): GitWandrcConfig | null {
  for (const filename of [".gitwandrc", ".gitwandrc.json"]) {
    let content: string;
    try {
      content = readFileSync(join(root, filename), "utf-8");
    } catch {
      continue;
    }
    const parsed = parseGitwandrc(content);
    if (parsed !== null) return parsed;
  }
  return null;
}
