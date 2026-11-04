// v3.13 — Dev-server mirror of `src-tauri/src/commands/worktree_trust.rs`.
//
// Same rules as the Rust backend: hooks are read from the MAIN worktree's
// config, hashed as the canonical JSON {setup, teardown, url}, and trusted
// per canonical repo root in the same store file. Kept in its own module so
// tests can import it without starting the dev-server.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const STALE_HOOKS = "The worktree hooks changed since you reviewed them. Review them again.";

const nonBlank = (v) => (typeof v === "string" && v.trim() !== "" ? v : null);

/** Hooks from a `.gitwandrc` text; invalid JSON yields no hooks. */
export function devHooksFromRcText(text) {
  let wt;
  try {
    wt = JSON.parse(text)?.worktree;
  } catch {
    wt = undefined;
  }
  return {
    setup: nonBlank(wt?.setup),
    teardown: nonBlank(wt?.teardown),
    url: nonBlank(wt?.url),
  };
}

/** Lowercase hex SHA-256 of the canonical JSON, or null when nothing runs. */
export function devHooksHash(h) {
  if (h.setup == null && h.teardown == null && h.url == null) return null;
  const canonical = JSON.stringify({ setup: h.setup ?? null, teardown: h.teardown ?? null, url: h.url ?? null });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Same location as Rust's `dirs::data_local_dir()/gitwand/hook-trust.json`. */
export function devTrustStorePath() {
  let base;
  if (process.platform === "darwin") base = join(homedir(), "Library", "Application Support");
  else if (process.platform === "win32") base = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  else base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "gitwand", "hook-trust.json");
}

function loadStore(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveStore(path, store) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, path);
}

/** First entry of `git worktree list --porcelain` is the main worktree. */
export function mainWorktreeRoot(cwd) {
  const out = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd, encoding: "utf-8" });
  const first = out.split("\n\n")[0].split("\n");
  if (first.includes("bare")) throw new Error("This repository is bare: it has no main worktree.");
  const line = first.find((l) => l.startsWith("worktree "));
  if (!line) throw new Error("git worktree list returned no worktree");
  return realpathSync(line.slice("worktree ".length));
}

/** `.gitwandrc` → `.gitwandrc.json` → package.json#gitwand, as `/api/read-gitwandrc`. */
export function readRcText(dir) {
  for (const name of [".gitwandrc", ".gitwandrc.json"]) {
    const p = join(dir, name);
    if (existsSync(p)) {
      try {
        return readFileSync(p, "utf-8");
      } catch {
        /* fall through */
      }
    }
  }
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    if (pkg.gitwand) return JSON.stringify(pkg.gitwand);
  } catch {
    /* none */
  }
  return "";
}

export function devTrustStatus(cwd, storePath = devTrustStorePath()) {
  const repoRoot = mainWorktreeRoot(cwd);
  const hooks = devHooksFromRcText(readRcText(repoRoot));
  const hash = devHooksHash(hooks);
  const trusted = hash === null || loadStore(storePath)[repoRoot] === hash;
  return { hooks, hash, trusted, repoRoot };
}

/** Throws `STALE_HOOKS` (and stores nothing) when the hooks changed. */
export function devTrustSet(cwd, hash, storePath = devTrustStorePath()) {
  const repoRoot = mainWorktreeRoot(cwd);
  const current = devHooksHash(devHooksFromRcText(readRcText(repoRoot)));
  if (current === null || current !== hash) {
    const err = new Error(STALE_HOOKS);
    err.stale = true;
    throw err;
  }
  const store = loadStore(storePath);
  store[repoRoot] = hash;
  saveStore(storePath, store);
}

/**
 * Mirror of Rust's `assert_hooks_trusted_at`: the hooks, re-read now, only if
 * they still hash to `hash` and that hash is trusted for the repo.
 */
export function devAssertTrusted(cwd, hash, storePath = devTrustStorePath()) {
  const repoRoot = mainWorktreeRoot(cwd);
  const hooks = devHooksFromRcText(readRcText(repoRoot));
  if (devHooksHash(hooks) !== hash) throw new Error(STALE_HOOKS);
  if (loadStore(storePath)[repoRoot] !== hash) {
    throw new Error("These worktree hooks are not trusted for this repository.");
  }
  return hooks;
}
