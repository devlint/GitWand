/**
 * Non-blocking "a newer version is available" notice.
 *
 * `@gitwand/cli` is commonly installed globally (`npm install -g`), which
 * never auto-updates — unlike `npx @gitwand/cli`, which always resolves the
 * latest version, or the desktop app, which has its own updater. This is
 * the CLI's equivalent: check the npm registry at most once per 24h (cached
 * locally), and print a one-line notice when a newer version exists.
 *
 * Only runs when stdout is a TTY, so it never touches `--ci`/`--json`
 * output. Any failure (offline, registry down, unwritable home dir,
 * malformed cache) is silent — a missed update notice is not worth
 * breaking or slowing a command for.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { c } from "./ui.js";

const PACKAGE_NAME = "@gitwand/cli";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1200;

interface UpdateCache {
  lastChecked: number;
  latestVersion: string;
}

/** Resolved lazily (not at module load) so tests can override `$HOME`. */
function cacheDir(): string {
  return join(homedir(), ".gitwand");
}
function cacheFile(): string {
  return join(cacheDir(), "update-check.json");
}

/** Exported for direct unit testing — pure, no I/O. */
export function isNewer(latest: string, current: string): boolean {
  const l = latest.split(".").map(Number);
  const cur = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const a = l[i] ?? 0;
    const b = cur[i] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

async function readCache(): Promise<UpdateCache | null> {
  try {
    const parsed = JSON.parse(await readFile(cacheFile(), "utf-8"));
    if (typeof parsed.lastChecked === "number" && typeof parsed.latestVersion === "string") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeCache(cache: UpdateCache): Promise<void> {
  try {
    await mkdir(cacheDir(), { recursive: true });
    await writeFile(cacheFile(), JSON.stringify(cache), "utf-8");
  } catch {
    // Read-only home dir, no disk space, etc. — the next run just checks again.
  }
}

async function fetchLatestVersion(): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { version?: unknown };
    return typeof json.version === "string" ? json.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Checks for a newer published `@gitwand/cli` version and prints a
 * one-line notice to stderr if one exists. `currentVersion` comes from the
 * running package's own `package.json`.
 */
export async function checkForUpdate(currentVersion: string): Promise<void> {
  if (!process.stdout.isTTY) return;

  const cache = await readCache();
  const stale = !cache || Date.now() - cache.lastChecked > CACHE_TTL_MS;

  let latestVersion = cache?.latestVersion;
  if (stale) {
    const fetched = await fetchLatestVersion();
    if (fetched) {
      latestVersion = fetched;
      await writeCache({ lastChecked: Date.now(), latestVersion: fetched });
    }
  }

  if (latestVersion && isNewer(latestVersion, currentVersion)) {
    console.error(
      `\n${c.dim}Update available:${c.reset} ${c.yellow}${currentVersion}${c.reset}${c.dim} →${c.reset} ${c.green}${latestVersion}${c.reset}   ${c.dim}Run${c.reset} npm install -g ${PACKAGE_NAME} ${c.dim}to update.${c.reset}`,
    );
  }
}
