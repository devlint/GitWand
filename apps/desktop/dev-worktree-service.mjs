// v3.13 — Dev-server mirror of the Rust worktree service
// (`src-tauri/src/worktree/`): slug, settings, base resolution, include,
// the record, creation and hooks. Same rules and error strings; git and the
// hooks run through argument arrays, never an interpolated shell string
// built by GitWand. Kept in its own module so tests import it directly.

import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { devAssertTrusted, devHooksFromRcText, mainWorktreeRoot, readRcText } from "./dev-worktree-trust.mjs";

export const FETCH_TIMEOUT_MS = 20_000;
export const URL_TIMEOUT_MS = 10_000;

// No output cap, like the Rust service: on a large repo, status or ls-files
// output runs past Node's 1 MB default and fails with ENOBUFS.
const git = (cwd, args, opts = {}) =>
  execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: Infinity, ...opts }).trim();
const gitOk = (cwd, args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", maxBuffer: Infinity });
  return r.status === 0 ? r.stdout.trim() : null;
};
const nowSecs = () => Math.floor(Date.now() / 1000);
const real = (p) => {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
};

/** `[a-z0-9][a-z0-9-]{0,62}` or null, as `slug::slugify`. */
export function devSlugify(name) {
  let slug = "";
  for (const ch of String(name ?? "")) {
    if (/^[A-Za-z0-9]$/.test(ch)) slug += ch.toLowerCase();
    else if (slug && !slug.endsWith("-")) slug += "-";
  }
  slug = slug.slice(0, 63).replace(/-+$/, "");
  return slug || null;
}

// ── Settings ────────────────────────────────────────────────────────────────

const nonBlank = (v) => (typeof v === "string" && v.trim() !== "" ? v : null);

/** `{ dir, include }` from the main worktree, as `settings::read_settings`. */
export function devReadSettings(mainRoot) {
  let wt;
  try {
    wt = JSON.parse(readRcText(mainRoot))?.worktree;
  } catch {
    wt = undefined;
  }
  const include = [];
  for (const e of Array.isArray(wt?.include) ? wt.include : []) {
    if (nonBlank(e)) include.push({ path: e, mode: "copy" });
    else if (e && typeof e === "object" && !Array.isArray(e) && nonBlank(e.path)) {
      const mode = e.mode === undefined ? "copy" : e.mode;
      if (mode === "copy" || mode === "symlink") include.push({ path: e.path, mode });
    }
  }
  try {
    for (const raw of readFileSync(join(mainRoot, ".worktreeinclude"), "utf-8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      if (!include.some((x) => x.path === line)) include.push({ path: line, mode: "copy" });
    }
  } catch {
    /* no file */
  }
  return { dir: nonBlank(wt?.dir), include };
}

export function devWorktreesDir(mainRoot, settings) {
  if (settings.dir && isAbsolute(settings.dir)) return settings.dir;
  if (settings.dir) return join(mainRoot, settings.dir);
  return join(dirname(mainRoot), `${basename(mainRoot)}.worktrees`);
}

// ── Base ────────────────────────────────────────────────────────────────────

const commitOf = (root, rev) => gitOk(root, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);

function localHead(root, reason, detail = null) {
  const commit = commitOf(root, "HEAD");
  if (!commit) throw new Error("This repository has no commit yet.");
  const branch = gitOk(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
  return { base_ref: branch || "HEAD", commit, fetched_at: null, fallback_reason: reason, fallback_detail: detail };
}

export function devResolveBase(mainRoot, { fetchTimeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const remotes = (gitOk(mainRoot, ["remote"]) ?? "").split("\n").filter(Boolean);
  const cur = gitOk(mainRoot, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const configured = cur ? gitOk(mainRoot, ["config", "--get", `branch.${cur}.remote`]) : null;
  const remote = configured && remotes.includes(configured) ? configured : remotes.includes("origin") ? "origin" : null;
  if (!remote) return localHead(mainRoot, "no-remote");
  let branch = null;
  const head = gitOk(mainRoot, ["symbolic-ref", "-q", `refs/remotes/${remote}/HEAD`]);
  const prefix = `refs/remotes/${remote}/`;
  if (head?.startsWith(prefix)) branch = head.slice(prefix.length);
  if (!branch) {
    branch = ["main", "master"].find(
      (b) => gitOk(mainRoot, ["show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${b}`]) !== null,
    ) ?? null;
  }
  if (!branch) return localHead(mainRoot, "no-default-branch");
  const tracking = `${remote}/${branch}`;
  const r = spawnSync("git", ["fetch", "--quiet", "--no-tags", remote, branch], {
    cwd: mainRoot,
    encoding: "utf-8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "ignore", "pipe"],
    timeout: fetchTimeoutMs,
  });
  const commit = commitOf(mainRoot, `refs/remotes/${tracking}`);
  if (r.status === 0) {
    if (!commit) return localHead(mainRoot, "no-default-branch");
    return { base_ref: tracking, commit, fetched_at: nowSecs(), fallback_reason: null, fallback_detail: null };
  }
  const detail = r.error?.code === "ETIMEDOUT"
    ? `git fetch timed out after ${Math.round(fetchTimeoutMs / 1000)} s`
    : (r.stderr ?? "").trim();
  if (commit) return { base_ref: tracking, commit, fetched_at: null, fallback_reason: "fetch-failed", fallback_detail: detail };
  return localHead(mainRoot, "fetch-failed", detail);
}

export function devResolveExplicitBase(root, base) {
  const b = String(base ?? "").trim();
  if (!b || b.startsWith("-")) throw new Error(`Not a valid base: ${b}`);
  const commit = commitOf(root, b);
  if (!commit) throw new Error(`Not a valid base: ${b}`);
  return { base_ref: b, commit, fetched_at: null, fallback_reason: null, fallback_detail: null };
}

// ── Include ─────────────────────────────────────────────────────────────────

const escapes = (rel) => isAbsolute(rel) || rel.split(/[\\/]/).includes("..");

/** Links are recreated, never followed; one that cannot be is skipped. */
function copyTree(src, dst, skipped) {
  const st = lstatSync(src);
  if (st.isSymbolicLink()) {
    try {
      symlinkSync(readlinkSync(src), dst);
    } catch {
      skipped.push(src);
    }
  } else if (st.isDirectory()) {
    mkdirSync(dst, { recursive: true });
    for (const name of readdirSync(src)) copyTree(join(src, name), join(dst, name), skipped);
  } else {
    copyFileSync(src, dst);
  }
}

export function devApplyInclude(mainRoot, worktree, entries) {
  const warnings = [];
  const warn = (path, reason, detail = null) => warnings.push({ path, reason, detail });
  const main = real(mainRoot);
  for (const entry of entries) {
    if (escapes(entry.path)) {
      warn(entry.path, "outside");
      continue;
    }
    const rels = /[*?[]/.test(entry.path)
      ? (gitOk(main, ["ls-files", "-z", "--others", "--ignored", `--exclude=${entry.path}`]) ?? "")
          .split("\0")
          .filter(Boolean)
      : [entry.path.replace(/\/+$/, "")];
    for (const rel of rels) {
      if (escapes(rel)) {
        warn(rel, "outside");
        continue;
      }
      const src = join(main, rel);
      try {
        lstatSync(src);
      } catch {
        continue; // missing: silent
      }
      let target;
      try {
        target = realpathSync.native(src);
      } catch {
        warn(rel, "outside");
        continue;
      }
      if (target !== main && !target.startsWith(main + sep)) {
        warn(rel, "outside");
        continue;
      }
      const isDir = lstatSync(target).isDirectory();
      const ignored = spawnSync("git", ["check-ignore", "-q", "--", rel], { cwd: main }).status === 0
        || (isDir && spawnSync("git", ["check-ignore", "-q", "--", `${rel}/`], { cwd: main }).status === 0);
      if (!ignored) {
        const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", rel], { cwd: main }).status === 0;
        warn(rel, tracked ? "tracked" : "not-ignored");
        continue;
      }
      const dst = join(worktree, rel);
      if (existsSync(dst)) {
        warn(rel, "exists");
        continue;
      }
      const skipped = [];
      try {
        mkdirSync(dirname(dst), { recursive: true });
        if (entry.mode === "symlink") {
          try {
            symlinkSync(target, dst, isDir ? "dir" : "file");
          } catch (e) {
            warn(rel, "symlink-fallback", String(e.message ?? e));
            copyTree(src, dst, skipped);
          }
        } else {
          copyTree(src, dst, skipped);
        }
      } catch (e) {
        warn(rel, "error", String(e.message ?? e));
      }
      for (const link of skipped) warn(link.startsWith(main + sep) ? link.slice(main.length + 1) : link, "link-skipped");
    }
  }
  return warnings;
}

// ── Record ──────────────────────────────────────────────────────────────────

export function devCommonDir(cwd) {
  return git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
}

const recordFile = (common) => join(common, "gitwand", "worktrees.json");

export function devLoadRecords(common) {
  try {
    const v = JSON.parse(readFileSync(recordFile(common), "utf-8"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function saveRecords(common, records) {
  const file = recordFile(common);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(records, null, 2));
  renameSync(tmp, file);
}

export function devUpsertRecord(common, rec) {
  const path = real(rec.path);
  const all = devLoadRecords(common).filter((r) => real(r.path) !== path);
  all.push({ ...rec, path });
  saveRecords(common, all);
}

export function devFindRecord(common, path) {
  const key = real(path);
  return devLoadRecords(common).find((r) => real(r.path) === key) ?? null;
}

// ── Create ──────────────────────────────────────────────────────────────────

const branchExists = (root, b) => gitOk(root, ["show-ref", "--verify", "--quiet", `refs/heads/${b}`]) !== null;

function usablePath(p) {
  const path = String(p).trim();
  if (!isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
    throw new Error(`The worktree path must be absolute, without \`..\`: ${p}`);
  }
  if (existsSync(path)) {
    let empty = false;
    try {
      empty = lstatSync(path).isDirectory() && readdirSync(path).length === 0;
    } catch {
      /* not readable */
    }
    if (!empty) throw new Error(`${path} already exists.`);
  }
  return path;
}

/** Mirror of `create::create_worktree`. `req.kind` is `"task"` or `"manual"`. */
export function devCreateWorktree(cwd, req, { fetchTimeoutMs = FETCH_TIMEOUT_MS } = {}) {
  if (req.kind !== "task" && req.kind !== "manual") throw new Error(`Unknown worktree kind: ${req.kind}`);
  const main = mainWorktreeRoot(cwd);
  const slug = devSlugify(req.name);
  if (!slug) throw new Error("The name needs at least one letter or digit.");
  const settings = devReadSettings(main);
  const givenBranch = nonBlank(req.branch)?.trim() ?? null;
  const defaultBranch = givenBranch === null;
  let branch = givenBranch ?? `task/${slug}`;
  if (branch.startsWith("-") || gitOk(main, ["check-ref-format", "--branch", branch]) === null) {
    throw new Error(`Not a valid branch name: ${branch}`);
  }
  const explicitBase = nonBlank(req.base)?.trim() ?? null;
  const checkout = !defaultBranch && branchExists(main, branch);
  if (checkout && explicitBase) throw new Error(`Branch ${branch} already exists.`);
  const base = checkout
    ? { base_ref: branch, commit: git(main, ["rev-parse", "--verify", `refs/heads/${branch}`]), fetched_at: null, fallback_reason: null, fallback_detail: null }
    : explicitBase
      ? devResolveExplicitBase(main, explicitBase)
      : devResolveBase(main, { fetchTimeoutMs });

  const defaultPath = nonBlank(req.path) === null;
  const dir = devWorktreesDir(main, settings);
  let path = defaultPath ? join(dir, slug) : usablePath(req.path);
  for (let n = 2; (defaultPath && existsSync(path)) || (defaultBranch && branchExists(main, branch)); n++) {
    // Room for the suffix within the 63-char cap: `{name}` must stay unique.
    const suffix = `-${n}`;
    const name = `${slug.slice(0, 63 - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (defaultPath) path = join(dir, name);
    if (defaultBranch) branch = `task/${name}`;
  }
  mkdirSync(dirname(path), { recursive: true });
  try {
    if (checkout) git(main, ["worktree", "add", path, "--", branch]);
    else git(main, ["worktree", "add", "-b", branch, path, "--", base.commit]);
  } catch (e) {
    throw new Error(`git worktree add failed: ${(e.stderr ?? e.message).toString().trim()}`);
  }
  path = real(path);
  const createdAt = nowSecs();
  try {
    const common = devCommonDir(main);
    devUpsertRecord(common, {
      path,
      branch,
      base_ref: base.base_ref,
      base_commit: base.commit,
      created_at: createdAt,
      kind: req.kind,
      source_branch: gitOk(main, ["symbolic-ref", "--short", "-q", "HEAD"]) || null,
    });
    if (req.kind === "task" && !checkout) {
      git(main, ["config", `branch.${branch}.gitwandBase`, base.commit]);
      git(main, ["config", `branch.${branch}.gitwandSource`, base.base_ref]);
    }
  } catch (e) {
    try { git(main, ["worktree", "remove", "--force", path]); } catch { /* best effort */ }
    try { git(main, ["worktree", "prune"]); } catch { /* best effort */ }
    if (!checkout) try { git(main, ["branch", "-D", branch]); } catch { /* best effort */ }
    throw e;
  }
  const warnings = devApplyInclude(main, path, settings.include);
  return {
    path,
    branch,
    name: devSlugify(basename(path)) ?? slug,
    kind: req.kind,
    base,
    warnings,
    created_at: createdAt,
  };
}

// ── Hooks ───────────────────────────────────────────────────────────────────

export function devShellQuote(s) {
  return process.platform === "win32" ? `"${s.replaceAll('"', '""')}"` : `'${s.replaceAll("'", "'\\''")}'`;
}

/** `%NAME%` → value when known; anything else stays as written (cmd's rule). */
export function devExpandPercentVars(command, lookup) {
  return command.replace(/%([^%]+)%/g, (whole, name) => lookup(name) ?? whole);
}

export function devExpandHook(command, v) {
  if (process.platform === "win32") {
    // cmd never rescans %GITWAND_HOOK_COMMAND%: expand the hook's own %VAR%s
    // here (as Rust's `expand`), before the placeholder values go in.
    const hookEnv = devHookEnv(v);
    command = devExpandPercentVars(command, (name) => hookEnv[name.toUpperCase()] ?? process.env[name] ?? null);
  }
  return command.replace(/\{([^{}]*)\}/g, (whole, key) => {
    if (key === "name") return v.name;
    if (key === "path") return devShellQuote(v.path);
    if (key === "branch") return devShellQuote(v.branch);
    if (key === "base") return devShellQuote(v.base);
    return whole;
  });
}

export function devHookEnv(v) {
  return {
    GITWAND_WORKTREE_NAME: v.name,
    GITWAND_WORKTREE_PATH: v.path,
    GITWAND_WORKTREE_BRANCH: v.branch,
    GITWAND_WORKTREE_BASE: v.base,
    GITWAND_REPO_ROOT: v.repoRoot,
  };
}

/**
 * `$SHELL [-l] -c <command>` on Unix. On Windows the command travels in
 * `GITWAND_HOOK_COMMAND` and cmd gets `/D /C %GITWAND_HOOK_COMMAND%`, as in
 * Rust's `cmd_invocation`: a quoted argument would reach cmd as `\"`.
 */
export function devShellInvocation(command, shell = process.env.SHELL || "/bin/sh") {
  if (process.platform === "win32") {
    return { program: "cmd", args: ["/D", "/C", "%GITWAND_HOOK_COMMAND%"], env: { GITWAND_HOOK_COMMAND: command } };
  }
  const name = basename(shell).replace(/\.exe$/, "").toLowerCase();
  const login = ["bash", "zsh", "sh", "dash", "ksh", "fish", "tcsh", "csh"].includes(name);
  return { program: shell, args: [...(login ? ["-l"] : []), "-c", command], env: {} };
}

/** Values for a linked worktree of the repo at `cwd`, as `hooks::vars_for`. */
export function devHookVars(cwd, path) {
  const refuse = () => new Error(`Not a linked worktree of this repository: ${path}`);
  let wt;
  try {
    wt = realpathSync.native(path);
  } catch {
    throw refuse();
  }
  const blocks = git(cwd, ["worktree", "list", "--porcelain"]).split("\n\n").slice(1);
  const linked = blocks
    .map((b) => b.split("\n").find((l) => l.startsWith("worktree "))?.slice("worktree ".length))
    .filter(Boolean)
    .some((p) => real(p) === wt);
  if (!linked) throw refuse();
  const main = mainWorktreeRoot(cwd);
  const name = devSlugify(basename(wt));
  if (!name) throw new Error(`Cannot derive a worktree name from ${wt}`);
  return {
    name,
    path: wt,
    branch: gitOk(wt, ["symbolic-ref", "--short", "-q", "HEAD"]) ?? "",
    base: devFindRecord(devCommonDir(main), wt)?.base_ref ?? "",
    repoRoot: main,
  };
}

/** What `/api/worktree-run-hook` spawns: `{ program, args, cwd, env }`. */
export function devSetupSpawn(cwd, path, hook, hash, { storePath, shell } = {}) {
  if (hook !== "setup" && hook !== "teardown") throw new Error(`Unknown worktree hook: ${hook}`);
  const hooks = devAssertTrusted(cwd, hash, storePath);
  if (!hooks[hook]) throw new Error(`This repository defines no ${hook} hook.`);
  const vars = devHookVars(cwd, path);
  const { program, args, env } = devShellInvocation(devExpandHook(hooks[hook], vars), shell);
  return { program, args, cwd: vars.path, env: { ...devHookEnv(vars), ...env } };
}

/** Mirror of `hooks::url_for`: first non-empty line, or null without `url`. */
export function devWorktreeUrl(cwd, path, hash, { storePath, shell, timeoutMs = URL_TIMEOUT_MS, baseEnv = process.env } = {}) {
  const hooks = devAssertTrusted(cwd, hash, storePath);
  if (!hooks.url) return null;
  const vars = devHookVars(cwd, path);
  const { program, args, env } = devShellInvocation(devExpandHook(hooks.url, vars), shell);
  const r = spawnSync(program, args, {
    cwd: vars.path,
    encoding: "utf-8",
    env: { ...baseEnv, ...devHookEnv(vars), ...env },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  if (r.error?.code === "ETIMEDOUT") throw new Error(`The url hook timed out after ${Math.round(timeoutMs / 1000)} s.`);
  if (r.status !== 0) {
    const tail = (r.stderr ?? "").trim().split("\n").slice(-5).join("\n");
    throw new Error(`The url hook failed (exit status: ${r.status}): ${tail}`);
  }
  return (r.stdout ?? "").split("\n").map((l) => l.trim()).find((l) => l) ?? null;
}

// ── Removal (mirror of `worktree::guard` / `worktree::remove`) ───────────────

/** Mirror of `guard::OTHER_TOOL_DIRS`. */
export const OTHER_TOOL_DIRS = [[".claude", "worktrees"], ["conductor", "workspaces"], [".superset", "worktrees"]];
export const KEEP_FILE = ".worktree-keep";

/** Mirror of `guard::listed`: the linked worktree's porcelain entry, or throws. */
export function devListedWorktree(repo, worktree) {
  const refuse = () => new Error(`Not a linked worktree of this repository: ${worktree}`);
  const exists = existsSync(worktree);
  const wanted = exists ? real(worktree) : worktree;
  const text = git(repo, ["worktree", "list", "--porcelain"]);
  for (const block of text.split("\n\n").slice(1)) {
    let path = null;
    let branch = null;
    let locked = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) {
        const p = line.slice("worktree ".length);
        path = exists ? real(p) : p;
      } else if (line.startsWith("branch ")) {
        const b = line.slice("branch ".length);
        branch = b.startsWith("refs/heads/") ? b.slice("refs/heads/".length) : b;
      } else if (line === "locked") locked = "";
      else if (line.startsWith("locked ")) locked = line.slice("locked ".length);
    }
    if (path === wanted) return { path: wanted, branch, locked };
  }
  throw refuse();
}

function inOtherToolDir(path) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return OTHER_TOOL_DIRS.some((dir) =>
    parts.some((_, i) => dir.every((d, j) => parts[i + j] === d)),
  );
}

function legacyOwned(repo, path, branch) {
  if (basename(path).startsWith("gitwand-scratch-")) return true;
  return branch !== null && gitOk(repo, ["config", "--get", `branch.${branch}.gitwandBase`]) !== null;
}

/** Mirror of `guard::guard`. */
export function devWorktreeGuard(repo, worktree) {
  const entry = devListedWorktree(repo, worktree);
  const recorded = devFindRecord(devCommonDir(repo), entry.path) !== null;
  const owned = recorded || legacyOwned(repo, entry.path, entry.branch);
  const reasons = [];
  if (entry.locked !== null) reasons.push("locked");
  // Ignored on a recorded worktree, like guard.rs: the file comes from setup.
  if (!recorded && existsSync(join(entry.path, KEEP_FILE))) reasons.push("keep-file");
  if (!recorded && inOtherToolDir(entry.path)) reasons.push("other-tool");
  const teardownRequired = recorded && !!devHooksFromRcText(readRcText(mainWorktreeRoot(repo))).teardown;
  return {
    untouchable: reasons.length > 0,
    reasons,
    owned,
    recorded,
    teardown_required: teardownRequired,
    branch: entry.branch,
    lock_reason: entry.locked ? entry.locked : null,
  };
}

function refuseUntouchable(report, path) {
  if (report.untouchable) {
    throw new Error(`untouchable: ${path} (${report.reasons.join(", ")}) — GitWand will not remove or modify it.`);
  }
}

/**
 * Mirror of `remove::prepare_removal`. `stop(path)` stops the worktree's
 * processes and resolves with the survivors (the dev-server passes
 * `devStopProcessesIn`, a best-effort mirror of the Rust sweep).
 */
export async function devRemovePrepare(repo, worktree, { createSnapshot, stop = async () => [] }) {
  refuseUntouchable(devWorktreeGuard(repo, worktree), worktree);
  const entry = devListedWorktree(repo, worktree);
  const survivors = await stop(entry.path);
  if (survivors.length > 0) return { survivors, snapshot: null };
  const name = basename(entry.path);
  const rec = devFindRecord(devCommonDir(repo), entry.path);
  const base = rec ? { baseRef: rec.base_ref, baseCommit: rec.base_commit } : null;
  const snapshot = createSnapshot(entry.path, "removal", `Remove worktree ${name}`, {
    path: entry.path,
    branch: entry.branch,
    name,
  }, base);
  return { survivors: [], snapshot };
}

/** Mirror of `remove::remove_worktree`, minus the last process check. */
export function devRemoveWorktree(repo, worktree, opts = {}) {
  const report = devWorktreeGuard(repo, worktree);
  refuseUntouchable(report, worktree);
  const entry = devListedWorktree(repo, worktree);
  const path = entry.path;
  if (!report.owned && !opts.confirmNotOwned) {
    throw new Error(`not-owned: ${path} was not created by GitWand; confirm to remove it.`);
  }
  const teardownDone = !!opts.teardownSkipped || opts.teardownCode === 0 || !!opts.removeAnyway;
  if (report.teardown_required && !teardownDone) {
    throw new Error(
      typeof opts.teardownCode === "number"
        ? `teardown: it exited with code ${opts.teardownCode}; the worktree is kept.`
        : "teardown: it has not run; the worktree is kept.",
    );
  }
  const common = devCommonDir(repo);
  const rec = devFindRecord(common, path);
  const main = mainWorktreeRoot(repo);
  if (existsSync(path)) {
    const id = opts.snapshotId;
    const force =
      typeof id === "string" &&
      /^[0-9a-f-]+$/i.test(id) &&
      gitOk(main, ["rev-parse", "--verify", "--quiet", `refs/gitwand/snapshots/${id}`]) !== null;
    const r = spawnSync("git", ["worktree", "remove", ...(force ? ["--force"] : []), path], { cwd: main, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`git worktree remove failed: ${(r.stderr ?? "").trim()}`);
  }
  gitOk(main, ["worktree", "prune"]);
  const outcome = { branch_deleted: null, warnings: [] };
  if (entry.branch) {
    const target = rec?.source_branch ? `refs/heads/${rec.source_branch}` : "HEAD";
    const mergedTask =
      rec?.kind === "task" &&
      spawnSync("git", ["merge-base", "--is-ancestor", `refs/heads/${entry.branch}`, target], { cwd: main }).status === 0;
    if (opts.deleteBranch || mergedTask) {
      const r = spawnSync("git", ["branch", "-D", entry.branch], { cwd: main, encoding: "utf-8" });
      if (r.status === 0) outcome.branch_deleted = entry.branch;
      else outcome.warnings.push(`branch ${entry.branch} kept: ${(r.stderr ?? "").trim()}`);
    }
  }
  if (rec) {
    try {
      saveRecords(common, devLoadRecords(common).filter((r) => real(r.path) !== real(path)));
    } catch (e) {
      outcome.warnings.push(`record kept: ${e.message}`);
    }
  }
  return outcome;
}

/** Mirror of `worktree_unlock`. */
export function devUnlockWorktree(repo, worktree) {
  const entry = devListedWorktree(repo, worktree);
  git(repo, ["worktree", "unlock", entry.path]);
}

// ── Merge-back (mirror of `worktree::merge_back`) ────────────────────────────

const gitRaw = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: Infinity });

function changedPaths(dir) {
  const raw = gitRaw(dir, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  const out = new Set();
  const tokens = raw.split("\0").filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.length < 4) continue;
    const code = t.slice(0, 2);
    out.add(t.slice(3));
    if ((code[0] === "R" || code[0] === "C") && i + 1 < tokens.length) out.add(tokens[++i]);
  }
  return out;
}

const localBranchExists = (dir, b) => !!b && gitOk(dir, ["show-ref", "--verify", "--quiet", `refs/heads/${b}`]) !== null;

/** Mirror of `scratch::operation_in_progress`. */
function opInProgress(dir) {
  const states = [
    ["rebase-merge", "a rebase"],
    ["rebase-apply", "a rebase or `git am`"],
    ["MERGE_HEAD", "a merge"],
    ["CHERRY_PICK_HEAD", "a cherry-pick"],
    ["REVERT_HEAD", "a revert"],
    ["BISECT_LOG", "a bisect (`git bisect reset` ends it)"],
  ];
  for (const [name, op] of states) {
    const p = git(dir, ["rev-parse", "--git-path", name]);
    if (existsSync(isAbsolute(p) ? p : join(dir, p))) return op;
  }
  return null;
}

const CONFLICT_CODES = new Set(["UU", "AA", "DD", "AU", "UA", "DU", "UD"]);
const hasUnmerged = (dir) =>
  gitRaw(dir, ["status", "--porcelain"]).split("\n").some((l) => l.length >= 2 && CONFLICT_CODES.has(l.slice(0, 2)));

function devDefaultTarget(main, taskBranch, rec, mainBranch) {
  if (rec?.source_branch && localBranchExists(main, rec.source_branch)) return rec.source_branch;
  const src = gitOk(main, ["config", "--get", `branch.${taskBranch}.gitwandSource`]);
  if (src && localBranchExists(main, src)) return src;
  if (rec?.base_ref) {
    const base = rec.base_ref;
    const i = base.indexOf("/");
    const local = i >= 0 ? base.slice(i + 1) : base;
    for (const c of [base, local]) if (c !== taskBranch && localBranchExists(main, c)) return c;
  }
  return mainBranch ?? "";
}

const refusal = (code, message, paths = []) => ({ code, message, paths });

/** Mirror of `merge_back::check`. */
export function devMergeBackCheck(repo, worktree, target = null) {
  const report = devWorktreeGuard(repo, worktree);
  const entry = devListedWorktree(repo, worktree);
  const taskPath = entry.path;
  const main = mainWorktreeRoot(repo);
  const mainBranch = gitOk(main, ["symbolic-ref", "--quiet", "--short", "HEAD"]) || null;
  const taskBranch = entry.branch ?? "";
  const rec = devFindRecord(devCommonDir(repo), taskPath);
  const defaultTarget = devDefaultTarget(main, taskBranch, rec, mainBranch);
  const t = typeof target === "string" && target.trim() ? target.trim() : defaultTarget;
  const mainChanges = changedPaths(main);
  const taskChanges = changedPaths(taskPath);
  const out = {
    task_branch: taskBranch,
    task_path: taskPath,
    name: basename(taskPath),
    target: t,
    default_target: defaultTarget,
    main_path: main,
    main_branch: mainBranch,
    main_clean: mainChanges.size === 0,
    task_commits: 0,
    task_dirty: taskChanges.size > 0,
    task_merged: false,
    main_staged: spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: main }).status !== 0,
    refusal: null,
  };
  if (report.untouchable) return { ...out, refusal: refusal("untouchable", `This worktree is protected (${report.reasons.join(", ")}).`) };
  if (!report.owned) return { ...out, refusal: refusal("not-owned", "GitWand did not create this worktree.") };
  if (!taskBranch) return { ...out, refusal: refusal("detached", "The task worktree is not on a branch.") };
  if (t === taskBranch || !localBranchExists(main, t)) {
    return { ...out, refusal: refusal("unknown-target", `${t} is not a local branch to merge into.`) };
  }
  out.task_merged =
    spawnSync("git", ["merge-base", "--is-ancestor", `refs/heads/${taskBranch}`, `refs/heads/${t}`], { cwd: main }).status === 0;
  out.task_commits = parseInt(git(main, ["rev-list", "--count", `refs/heads/${t}..refs/heads/${taskBranch}`]), 10) || 0;
  if (mainBranch !== t) {
    return { ...out, refusal: refusal("wrong-branch", `The main checkout is on ${mainBranch ?? "a detached HEAD"}, not ${t}.`) };
  }
  const op = opInProgress(main);
  if (op) return { ...out, refusal: refusal("main-in-progress", `The main checkout is in the middle of ${op}.`) };
  if (hasUnmerged(main)) return { ...out, refusal: refusal("main-in-progress", "The main checkout has unresolved conflicts.") };
  if (opInProgress(taskPath) || hasUnmerged(taskPath)) {
    return { ...out, refusal: refusal("task-in-progress", "The task worktree is in the middle of a git operation.") };
  }
  if (out.task_commits === 0 && !out.task_dirty) {
    return { ...out, refusal: refusal("nothing", `${taskBranch} has nothing that ${t} lacks.`) };
  }
  const base = git(main, ["merge-base", `refs/heads/${t}`, `refs/heads/${taskBranch}`]);
  const taskFiles = new Set([
    ...gitRaw(main, ["diff", "--no-renames", "--name-only", "-z", base, `refs/heads/${taskBranch}`]).split("\0").filter(Boolean),
    ...taskChanges,
  ]);
  const ignored = gitRaw(main, ["ls-files", "-o", "-i", "--exclude-standard", "--directory", "-z"]).split("\0").filter(Boolean);
  const overlapSet = new Set([...mainChanges].filter((p) => taskFiles.has(p)));
  for (const f of taskFiles) {
    if (ignored.some((i) => i === f || (i.endsWith("/") && f.startsWith(i)))) overlapSet.add(f);
  }
  const overlap = [...overlapSet].sort();
  if (overlap.length > 0) {
    out.refusal = refusal("overlap", "The main checkout has changes to files the task also changes.", overlap);
  }
  return out;
}

function refuseCheck(c) {
  if (c.refusal) throw new Error(`${c.refusal.code}: ${c.refusal.message}`);
}

/** Mirror of `merge_back::prepare`. */
export async function devMergeBackPrepare(repo, worktree, target, { createSnapshot, stop = async () => [] }) {
  const c = devMergeBackCheck(repo, worktree, target);
  refuseCheck(c);
  const survivors = await stop(c.task_path);
  if (survivors.length > 0) {
    return { check: c, survivors, task_snapshot: null, main_snapshot: null, committed_wip: false };
  }
  git(c.task_path, ["add", "-A"]);
  const committedWip = changedPaths(c.task_path).size > 0;
  if (committedWip) {
    git(c.task_path, [
      "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null",
      "commit", "--no-verify", "-q", "-m", `wip(${c.name}): uncommitted work at merge-back`,
    ]);
  }
  const rec = devFindRecord(devCommonDir(repo), c.task_path);
  const base = rec ? { baseRef: rec.base_ref, baseCommit: rec.base_commit } : null;
  const taskSnapshot = createSnapshot(c.task_path, "merge-back-task", `Merge back ${c.name} (task)`, {
    path: c.task_path,
    branch: c.task_branch,
    name: c.name,
  }, base);
  const mainSnapshot = createSnapshot(c.main_path, "merge-back", `Merge back ${c.name} into ${c.target}`);
  return {
    check: devMergeBackCheck(repo, worktree, target),
    survivors: [],
    task_snapshot: taskSnapshot,
    main_snapshot: mainSnapshot,
    committed_wip: committedWip,
  };
}

function mainOn(repo, target) {
  const main = mainWorktreeRoot(repo);
  if ((gitOk(main, ["symbolic-ref", "--quiet", "--short", "HEAD"]) ?? "") !== target) {
    throw new Error(`wrong-branch: the main checkout is no longer on ${target}.`);
  }
  return main;
}

/** Mirror of `merge_back::squash`. */
export function devMergeBackSquash(repo, worktree, target) {
  const entry = devListedWorktree(repo, worktree);
  if (!entry.branch) throw new Error("detached: the task worktree is not on a branch.");
  const main = mainOn(repo, target);
  const r = spawnSync("git", ["merge", "--squash", "--no-autostash", "--no-verify-signatures", `refs/heads/${entry.branch}`], { cwd: main, encoding: "utf-8" });
  if (r.status === 0) return { conflicts: false };
  if (hasUnmerged(main)) return { conflicts: true };
  throw new Error(`git refused the squash: ${(r.stderr ?? "").trim()}`);
}

/** Mirror of `merge_back::fast_forward`. */
export function devMergeBackFastForward(repo, worktree, target) {
  const entry = devListedWorktree(repo, worktree);
  if (!entry.branch) throw new Error("detached: the task worktree is not on a branch (is its rebase still running?).");
  if (opInProgress(entry.path)) throw new Error("task-in-progress: finish the rebase in the task worktree first.");
  const main = mainOn(repo, target);
  const r = spawnSync("git", ["merge", "--ff-only", "--no-autostash", `refs/heads/${entry.branch}`], { cwd: main, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git refused to fast-forward ${target}: ${(r.stderr ?? "").trim()}`);
  return { conflicts: false };
}

// ── Restore as worktree (mirror of `worktree::restore`) ──────────────────────

export const RESTORABLE_KINDS = ["removal", "merge-back-task"];

/**
 * Mirror of `restore::restore_as_worktree`. The dev-server hands in its own
 * snapshot primitives (`listSnapshots`, `applySnapshotState`).
 */
export function devRestoreAsWorktree(repo, id, name, { listSnapshots, applySnapshotState }) {
  const main = mainWorktreeRoot(repo);
  const snap = listSnapshots(main).find((s) => s.id === id);
  if (!snap) throw new Error(`Snapshot ${id} not found.`);
  if (!snap.worktree || !RESTORABLE_KINDS.includes(snap.kind)) {
    throw new Error("This snapshot was not taken from a worktree GitWand removed.");
  }
  const wanted = typeof name === "string" && name.trim() ? name.trim() : snap.worktree.name;
  const slug = devSlugify(wanted);
  if (!slug) throw new Error("The name needs at least one letter or digit.");
  let branch = `restore/${slug}`;
  for (let n = 2; branchExists(main, branch); n++) branch = `restore/${slug}-${n}`;
  const created = devCreateWorktree(main, { name: `${slug}-restored`, base: snap.headSha, branch, kind: "task" });
  const common = devCommonDir(main);
  // Mirror of the base fallback in `restore::restore_as_worktree`.
  let baseRef;
  let baseCommit;
  if (snap.worktreeBase) {
    ({ baseRef, baseCommit } = snap.worktreeBase);
  } else {
    const on = gitOk(main, ["symbolic-ref", "--quiet", "--short", "HEAD"]) ?? "";
    baseCommit = gitOk(main, ["merge-base", "HEAD", snap.headSha]) ?? snap.headSha;
    baseRef = on || baseCommit;
  }
  try {
    applySnapshotState(created.path, snap);
    const rec = devFindRecord(common, created.path);
    if (rec) devUpsertRecord(common, { ...rec, base_ref: baseRef, base_commit: baseCommit });
    git(main, ["config", `branch.${branch}.gitwandBase`, baseCommit]);
    git(main, ["config", `branch.${branch}.gitwandSource`, baseRef]);
  } catch (e) {
    gitOk(main, ["worktree", "remove", "--force", created.path]);
    gitOk(main, ["worktree", "prune"]);
    gitOk(main, ["branch", "-D", branch]);
    saveRecords(common, devLoadRecords(common).filter((r) => real(r.path) !== real(created.path)));
    throw new Error(`The snapshot could not be restored: ${e.message}`);
  }
  return { ...created, base: { base_ref: baseRef, commit: baseCommit, fetched_at: null, fallback_reason: null, fallback_detail: null } };
}
