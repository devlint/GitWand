// v3.14.0 — Dev-server mirror of the Rust stacked-branches service.
//
// MUST stay in lock-step with `src-tauri/src/stack/` (and the command bodies
// of `src-tauri/src/commands/stack.rs`). One section per Rust file, in the
// same order, with the same function names in camelCase, so a change on one
// side can be ported side by side: meta.rs, guard.rs, detect.rs, restack.rs,
// then commands/stack.rs. Same rules, same error strings, same wire format
// (snake_case, as serde emits it). `tests/parity/stack.test.mjs` compares
// the two.
//
// git runs through argument arrays, never a shell string. Errors are thrown
// as `Error` whose message is the Rust `Err` string; the routes answer it as
// `{ error }`. Every function is synchronous, so one route runs to its end
// before the next starts — the dev-server's stand-in for `repo_lock::write`.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { resolveBin } from "./dev-bin.mjs";

/** The git dev-server.mjs spawns (`resolveBin`), not whatever is first on PATH. */
const GIT = resolveBin("git");

/** `git_cmd().args(args).current_dir(repo).output()`: `{ status, stdout,
 *  stderr }`, or throws `git <first arg>: <spawn error>`. `status` is null
 *  when git died on a signal (Rust: `code()` is `None`). */
function run(repo, args, env) {
  const r = spawnSync(GIT, args, {
    cwd: repo,
    encoding: "utf-8",
    maxBuffer: Infinity,
    ...(env ? { env } : {}),
  });
  if (r.error) throw new Error(`git ${args[0] ?? ""}: ${r.error.message}`);
  return { status: r.status, signal: r.signal, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const ok = (out) => out.status === 0;
const trimmed = (s) => s.trim();
/** Rust `str::lines()`: split on `\n`, drop one trailing empty line, strip `\r`. */
const lines = (s) => {
  const parts = s.split("\n");
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
};
/** Rust `String` ordering (bytes), for every `BTreeMap` / `sort`. */
const byteCmp = (a, b) => Buffer.compare(Buffer.from(a, "utf-8"), Buffer.from(b, "utf-8"));
const sortedMap = (map) => new Map([...map.entries()].sort(([a], [b]) => byteCmp(a, b)));
const fail = (message) => {
  throw new Error(message);
};
/** Rust `ExitStatus` as `Display` prints it. */
const exitStatus = (out) => (out.status === null ? `signal: ${out.signal}` : `exit status: ${out.status}`);

// ── meta.rs ─────────────────────────────────────────────────────────────────

const PARENT = "gitwandParent";
const BASE = "gitwandStackBase";
const RESTACK = "gitwandRestack";

/** `run_ok`: trimmed stdout, or Err the trimmed stderr. */
function metaRunOk(repo, args) {
  const out = run(repo, args);
  if (ok(out)) return trimmed(out.stdout);
  fail(trimmed(out.stderr));
}

const key = (branch, v) => `branch.${branch}.${v}`;

/** Refuses an empty name, a leading `-` (option injection), `@{…}` and
 *  anything `git check-ref-format --branch` rejects. */
export function devValidateBranchName(name) {
  const invalid = () => fail(`invalid branch name: ${name}`);
  if (typeof name !== "string" || name === "" || name.startsWith("-") || name.startsWith("@{")) invalid();
  // No GIT_DIR / GIT_WORK_TREE: `--branch` must not expand against a repo
  // the environment points at.
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  const r = spawnSync(GIT, ["check-ref-format", "--branch", name], { cwd: tmpdir(), encoding: "utf-8", env });
  if (r.error || r.status !== 0) invalid();
}

const isSha = (s) => typeof s === "string" && (s.length === 40 || s.length === 64) && /^[0-9a-fA-F]+$/.test(s);

/** `PendingRestack::to_config`. */
function pendingToConfig(p) {
  return [
    p.moment,
    p.onto,
    p.old_base,
    p.bottom,
    p.new_parent ?? "-",
    p.original,
    p.top_sha,
    p.merged_parent ?? "-",
    p.worktree,
  ].join(" ");
}

/** A worktree id in the record: non-empty, even-length, lowercase hex. */
const isWorktreeHex = (s) => s.length > 0 && s.length % 2 === 0 && /^[0-9a-f]+$/.test(s);

/** `PendingRestack::parse`: the 9-field record, or null. */
function pendingParse(s) {
  const parts = s.split(" ");
  if (parts.length !== 9) return null;
  const [moment, onto, oldBase, bottom, newParent, original, topSha, mergedParent, worktree] = parts;
  if (worktree !== "-" && !isWorktreeHex(worktree)) return null;
  if (moment !== "parent_moved" && moment !== "parent_merged") return null;
  if (!isSha(onto) || !isSha(oldBase) || !isSha(topSha) || bottom === "" || original === "" || mergedParent === "") {
    return null;
  }
  return {
    moment,
    onto,
    old_base: oldBase,
    bottom,
    new_parent: newParent !== "-" ? newParent : null,
    original,
    top_sha: topSha,
    merged_parent: mergedParent !== "-" ? mergedParent : null,
    worktree,
  };
}

/** Every declared layer, by branch name (sorted as a `BTreeMap`). */
function readAll(repo) {
  const out = run(repo, ["config", "--local", "--get-regexp", "^branch\\..*\\.gitwand(parent|stackbase|restack)$"]);
  // exit 1 = no match
  if (!ok(out) && out.status !== 1) fail(trimmed(out.stderr));
  const parents = new Map();
  const bases = new Map();
  const pendings = new Map();
  for (const line of lines(out.stdout)) {
    const sp = line.indexOf(" ");
    const k = sp >= 0 ? line.slice(0, sp) : line;
    const value = sp >= 0 ? line.slice(sp + 1) : "";
    if (!k.startsWith("branch.")) continue;
    const rest = k.slice("branch.".length);
    // Branch names may contain dots: the variable is after the last one.
    const dot = rest.lastIndexOf(".");
    if (dot < 0) continue;
    const name = rest.slice(0, dot);
    const v = rest.slice(dot + 1);
    if (v === "gitwandparent") parents.set(name, value);
    else if (v === "gitwandstackbase") bases.set(name, value);
    else if (v === "gitwandrestack") {
      const p = pendingParse(value);
      if (p) pendings.set(name, p);
    }
  }
  const all = new Map();
  for (const [branch, parent] of sortedMap(parents)) {
    if (parent === "") continue;
    all.set(branch, { branch, parent, base: bases.get(branch) ?? null, pending: pendings.get(branch) ?? null });
  }
  return all;
}

function localBranchExists(repo, name) {
  try {
    return ok(run(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}^{commit}`]));
  } catch {
    return false;
  }
}

/** `resolve_default_branch_strict` (git/cmd.rs): never the current branch. */
function resolveDefaultBranchStrict(repo, configured) {
  const verify = (name) => {
    const r = spawnSync(GIT, ["rev-parse", "--verify", name], { cwd: repo, encoding: "utf-8" });
    return !r.error && r.status === 0;
  };
  if (typeof configured === "string") {
    const name = configured.trim();
    if (name !== "" && verify(name)) return name;
  }
  const head = spawnSync(GIT, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: repo, encoding: "utf-8" });
  if (!head.error && head.status === 0) {
    // e.g. "origin/main" -> "main"
    const short = (head.stdout ?? "").trim();
    const slash = short.indexOf("/");
    if (slash >= 0) {
      const name = short.slice(slash + 1);
      if (name !== "" && verify(name)) return name;
    }
  }
  return ["main", "master", "origin/main", "origin/master"].find(verify) ?? null;
}

/** The configured trunk, or the repo's detected one; null when there is none
 *  (never the current branch). A leading `origin/` is stripped. */
function trunk(repo, configured) {
  const name = resolveDefaultBranchStrict(repo, configured);
  if (name === null) return null;
  return name.startsWith("origin/") ? name.slice("origin/".length) : name;
}

/** Declares `parent` as the layer below `layer` and records the merge-base. */
function setParent(repo, trunkName, layer, parent) {
  devValidateBranchName(layer);
  devValidateBranchName(parent);
  if (layer === parent) fail("A branch cannot be stacked on itself.");
  if (trunkName !== null) {
    if (layer === trunkName) fail(`${layer} is the trunk and cannot be stacked.`);
    if (parent === trunkName) fail(`${parent} is the trunk: stacking on it is not a stack. Use Unstack instead.`);
  }
  for (const b of [layer, parent]) {
    if (!localBranchExists(repo, b)) fail(`Unknown local branch: ${b}`);
  }
  const all = readAll(repo);
  const child = [...all.values()].find((m) => m.parent === parent && m.branch !== layer);
  if (child) {
    fail(
      `${parent} already has a stacked branch (${child.branch}). Stacks are linear for now: stack on ${child.branch} instead.`,
    );
  }
  let cur = parent;
  for (let i = 0; i < 64; i++) {
    const m = all.get(cur);
    if (!m) break;
    if (m.parent === layer) fail(`Stacking ${layer} on ${parent} would create a cycle.`);
    cur = m.parent;
  }
  const mb = run(repo, ["merge-base", `refs/heads/${layer}`, `refs/heads/${parent}`]);
  let base;
  if (ok(mb)) base = trimmed(mb.stdout) || null;
  else if (mb.status === 1) base = null; // no common ancestor
  else fail(trimmed(mb.stderr));

  // Base first, parent last: a layer without a parent is not declared, and if
  // the parent write fails the previous base is put back.
  const previousBase = all.get(layer)?.base ?? null;
  if (base !== null) setBase(repo, layer, base);
  else unsetKey(repo, key(layer, BASE));
  try {
    metaRunOk(repo, ["config", "--local", key(layer, PARENT), parent]);
  } catch (e) {
    let rollback = null;
    try {
      if (previousBase !== null) setBase(repo, layer, previousBase);
      else unsetKey(repo, key(layer, BASE));
    } catch (re) {
      rollback = re.message;
    }
    fail(withRollback(e.message, rollback));
  }
  const pending = readAll(repo).get(layer)?.pending ?? null;
  return { branch: layer, parent, base, pending };
}

/** `with_rollback`: the write error, plus the rollback's own when it failed. */
function withRollback(error, rollbackError) {
  return rollbackError === null ? error : `${error} (the previous base could not be restored: ${rollbackError})`;
}

function unsetKey(repo, k) {
  const out = run(repo, ["config", "--local", "--unset", k]);
  // exit 5: the key was not set
  if (ok(out) || out.status === 5) return;
  fail(trimmed(out.stderr));
}

/** Removes the three stack keys of `layer`; absent keys are fine. */
function unset(repo, layer) {
  devValidateBranchName(layer);
  for (const v of [PARENT, BASE, RESTACK]) unsetKey(repo, key(layer, v));
}

function setBase(repo, layer, sha) {
  devValidateBranchName(layer);
  metaRunOk(repo, ["config", "--local", key(layer, BASE), sha]);
}

/** Points `layer` at `parent` without the checks of `setParent` (moment 2). */
function writeParent(repo, layer, parent) {
  devValidateBranchName(layer);
  devValidateBranchName(parent);
  metaRunOk(repo, ["config", "--local", key(layer, PARENT), parent]);
}

/** Removes every pending record that does not parse (D4). */
function clearMalformedPending(repo) {
  const out = run(repo, ["config", "--local", "--get-regexp", "^branch\\..*\\.gitwandrestack$"]);
  // exit 1 = no match
  if (!ok(out) && out.status !== 1) fail(trimmed(out.stderr));
  for (const line of lines(out.stdout)) {
    const sp = line.indexOf(" ");
    const k = sp >= 0 ? line.slice(0, sp) : line;
    const value = sp >= 0 ? line.slice(sp + 1) : "";
    // `k` as git listed it; it always starts with `branch.`, never an option.
    if (k.startsWith("branch.") && pendingParse(value) === null) unsetKey(repo, k);
  }
}

function setPending(repo, top, p) {
  devValidateBranchName(top);
  metaRunOk(repo, ["config", "--local", key(top, RESTACK), pendingToConfig(p)]);
}

function clearPending(repo, top) {
  devValidateBranchName(top);
  unsetKey(repo, key(top, RESTACK));
}

// ── guard.rs ────────────────────────────────────────────────────────────────

const U32 = /^\+?\d+$/;

/** `git version 2.39.3 (Apple Git-146)` → `[2, 39]`, else null. */
function parseGitVersion(s) {
  const t = s.trim();
  if (!t.startsWith("git version ")) return null;
  const nums = t.slice("git version ".length).split(".");
  if (nums.length < 2 || !U32.test(nums[0]) || !U32.test(nums[1])) return null;
  const major = Number(nums[0]);
  const minor = Number(nums[1]);
  if (major > 0xffffffff || minor > 0xffffffff) return null;
  return [major, minor];
}

function gitVersion() {
  const r = spawnSync(GIT, ["--version"], { encoding: "utf-8" });
  if (r.error || r.status !== 0) return null;
  return parseGitVersion(r.stdout ?? "");
}

/** `--update-refs` landed in git 2.38. */
function supportsUpdateRefs(v) {
  return v !== null && (v[0] > 2 || (v[0] === 2 && v[1] >= 38));
}

/** `list_worktrees` (commands/ops.rs), the fields the guard reads. */
function listWorktrees(cwd) {
  const r = spawnSync(GIT, ["worktree", "list", "--porcelain"], { cwd, encoding: "utf-8", maxBuffer: Infinity });
  if (r.error) fail(`Failed to list worktrees: ${r.error.message}`);
  if (r.status !== 0) fail(`git worktree list failed: ${r.stderr ?? ""}`);
  const entries = [];
  let cur = null;
  for (const line of lines(r.stdout ?? "")) {
    if (line.startsWith("worktree ")) {
      if (cur) entries.push(cur);
      cur = { path: line.slice("worktree ".length), branch: "", is_bare: false, is_prunable: false };
    } else if (cur) {
      if (line.startsWith("branch ")) {
        const full = line.slice("branch ".length);
        cur.branch = full.startsWith("refs/heads/") ? full.slice("refs/heads/".length) : full;
      } else if (line === "bare") cur.is_bare = true;
      else if (line.startsWith("prunable")) cur.is_prunable = true;
      else if (line === "detached") cur.branch = "(detached HEAD)";
    }
  }
  if (cur) entries.push(cur);
  return entries;
}

/** `/var` vs `/private/var` (macOS) and symlinked checkouts compare equal. */
function canonical(p) {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

function gitOut(dir, args) {
  const out = run(dir, args);
  if (ok(out)) return trimmed(out.stdout);
  fail(trimmed(out.stderr));
}

/** Branches held by a worktree: checked out there, or being rebased there.
 *  `{ branch, worktree, rebasing, current }`. Fails closed. */
function branchHolders(repo) {
  const top = canonical(gitOut(repo, ["rev-parse", "--show-toplevel"]));
  const holders = [];
  for (const wt of listWorktrees(repo)) {
    if (wt.is_bare || wt.is_prunable) continue;
    const worktree = wt.path;
    const current = canonical(worktree) === top;
    // (a) The branch the worktree has checked out.
    if (wt.branch !== "" && wt.branch !== "(detached HEAD)") {
      holders.push({ branch: wt.branch, worktree, rebasing: false, current });
    }
    // (b) The branch it is rebasing: HEAD is detached, the branch survives
    // only in the rebase state's `head-name`.
    let gitDir;
    try {
      gitDir = gitOut(worktree, ["rev-parse", "--absolute-git-dir"]);
    } catch (e) {
      fail(`cannot inspect worktree ${worktree}: ${e.message}`);
    }
    for (const state of ["rebase-merge", "rebase-apply"]) {
      const headName = join(gitDir, state, "head-name");
      const branch = interpretHeadName(headName);
      if (branch !== null) {
        holders.push({ branch, worktree, rebasing: true, current });
        break;
      }
    }
  }
  return holders;
}

/** What a rebase state's `head-name` says. Only a missing file means "no
 *  rebase here"; anything else unexpected is an error (fail closed). */
function interpretHeadName(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    fail(`cannot read ${path}: ${e.message}`);
  }
  const name = raw.trim();
  // A rebase started from a detached HEAD holds no branch.
  if (name === "detached HEAD") return null;
  if (name.startsWith("refs/heads/") && name.length > "refs/heads/".length) return name.slice("refs/heads/".length);
  fail(`unexpected content in ${path}: ${JSON.stringify(name)}`);
}

// ── detect.rs ───────────────────────────────────────────────────────────────

/** The sha `rev` resolves to as a commit, or null. */
function resolveCommit(repo, rev) {
  const out = run(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`]);
  return ok(out) ? trimmed(out.stdout) : null;
}

/** `merge-base --is-ancestor`: exit 0 yes, 1 no, anything else an error. */
function isAncestor(repo, a, b) {
  const out = run(repo, ["merge-base", "--is-ancestor", a, b]);
  if (out.status === 0) return true;
  if (out.status === 1) return false;
  fail(`git merge-base --is-ancestor ${a} ${b}: ${exitStatus(out)}: ${trimmed(out.stderr)}`);
}

/** Every declared layer and its report, bottom→top per chain (spec §5.3). */
function status(repo, configuredTrunk, hints) {
  return statusInner(repo, configuredTrunk, hints, true).report;
}

/** `status`, plus the layers blocked by an unsettled pending record (with the
 *  text `plan` errs with). Only `status` settles; `plan` never finalizes. */
function statusInner(repo, configuredTrunk, hints, settle) {
  // I-3: without a layer there is nothing to settle, classify or guard; the
  // trunk is still resolved (bridge offers, branch menu).
  if (readAll(repo).size === 0) {
    return {
      report: {
        trunk: trunk(repo, configuredTrunk),
        remote_trunk: null,
        layers: [],
        rebase_in_progress: false,
        finalized: null,
        // Not evaluated without a layer to restack.
        git_supports_restack: false,
        pending_errors: [],
      },
      blocked: new Map(),
    };
  }
  const settled = settle ? settlePending(repo, hints) : unsettled(repo);
  const all = readAll(repo);
  // Fail closed: a worktree we cannot inspect may hide a running rebase.
  const holders = branchHolders(repo);
  const rebaseInProgress = settled.waiting || holders.some((h) => h.rebasing && all.has(h.branch));
  const gitSupportsRestack = supportsUpdateRefs(gitVersion());
  const errors = sortedMap(settled.errors);
  // One entry per stuck record, by top (sorted, as Rust's BTreeMap).
  const pendingErrors = [...errors].map(([top, error]) => ({ top, error }));

  const trunkName = trunk(repo, configuredTrunk);
  if (trunkName === null) {
    return {
      report: {
        trunk: null,
        remote_trunk: null,
        layers: [],
        rebase_in_progress: rebaseInProgress,
        finalized: settled.finalized,
        git_supports_restack: gitSupportsRestack,
        pending_errors: pendingErrors,
      },
      blocked: new Map(),
    };
  }
  const remoteRef = `refs/remotes/origin/${trunkName}`;
  const hasRemoteTrunk = resolveCommit(repo, remoteRef) !== null;

  const layers = [];
  const blocked = new Map();
  for (const chain of chains(all)) {
    // A stack carrying an unsettled record: no self-heal, no action.
    let hold = null;
    for (const b of chain) {
      const e = settled.errors.get(b);
      const h = e !== undefined ? unsettledMessage(b, e) : settled.deferred.has(b) ? deferredMessage(b) : null;
      if (h !== null) {
        hold = h;
        break;
      }
    }
    // A layer whose local branch is gone is left out; the layer above
    // reports `parent_missing`.
    const present = chain.filter((b) => resolveCommit(repo, `refs/heads/${b}`) !== null);
    const top = present.length ? present[present.length - 1] : "";
    const classified = present.map((b) => {
      const l = classify(
        repo,
        all.get(b),
        hints,
        hasRemoteTrunk ? remoteRef : null,
        rebaseInProgress || hold !== null,
      );
      l.top = top;
      return l;
    });
    const flow = propagate(classified);
    classified.forEach((l, i) => {
      const f = flow[i];
      l.inherited = f.blocker !== null;
      l.actionable =
        needsRestack(l.state) && f.blocker === null && f.dropped_for === null && !rebaseInProgress && hold === null;
      if (hold !== null) blocked.set(l.branch, hold);
      layers.push(l);
    });
  }

  return {
    report: {
      trunk: trunkName,
      remote_trunk: hasRemoteTrunk ? `origin/${trunkName}` : null,
      layers,
      rebase_in_progress: rebaseInProgress,
      finalized: settled.finalized,
      git_supports_restack: gitSupportsRestack,
      pending_errors: pendingErrors,
    },
    blocked,
  };
}

function unsettledMessage(top, error) {
  return `The restack of ${top} could not be finalized: ${error}`;
}

function deferredMessage(top) {
  return `A previous restack of ${top} is still being finalized. Refresh and try again.`;
}

const newSettled = () => ({ waiting: false, finalized: null, errors: new Map(), deferred: new Set() });

/** Every pending record left as it is, its top deferred to the next refresh. */
function unsettled(repo) {
  const s = newSettled();
  for (const m of readAll(repo).values()) if (m.pending) s.deferred.add(m.branch);
  return s;
}

/** The pending step (D4, D5): clear malformed records; per record by top
 *  name, wait while its top is being rebased, finalize ONE completed record
 *  (defer the others), clear an aborted one. An error is kept per record. */
function settlePending(repo, hints) {
  clearMalformedPending(repo);
  const all = readAll(repo);
  const s = newSettled();
  if ([...all.values()].every((m) => m.pending === null)) return s;
  const holders = branchHolders(repo);
  let here = null;
  try {
    here = worktreeId(repo);
  } catch {
    here = null;
  }
  for (const m of all.values()) {
    const p = m.pending;
    if (!p) continue;
    const top = m.branch;
    // Any worktree settles a record (review pass 3); only the worktree it
    // ran in may touch a detached HEAD.
    let mine = here === null || here === p.worktree;
    if (!mine) {
      try {
        mine = !worktreeExists(repo, p.worktree);
      } catch {
        mine = false;
      }
    }
    if (holders.some((h) => h.rebasing && h.branch === top)) {
      s.waiting = true;
      continue;
    }
    try {
      if (!completed(repo, top, p)) {
        clearPending(repo, top);
        unwindAbort(repo, top, p, mine);
      } else if (s.finalized !== null) s.deferred.add(top);
      else s.finalized = finalize(repo, top, p, hints);
    } catch (e) {
      s.errors.set(top, e.message);
    }
  }
  return s;
}

/** An aborted restack leaves HEAD on `top`, which git checked out to rebase
 *  it: back to the branch the user was on, best effort. Only when `top` did
 *  not move: that is the abort, not a later checkout. */
function unwindAbort(repo, top, p, mine) {
  try {
    if (resolveCommit(repo, `refs/heads/${top}`) === p.top_sha) switchBack(repo, top, p.original);
  } catch {
    // best effort: the user stays on `top`, unharmed
  }
  if (mine) reattach(repo, p.original);
}

/** D4: the restack recorded on `top` has run to its end. */
function completed(repo, top, p) {
  const topRef = `refs/heads/${top}`;
  const tip = resolveCommit(repo, topRef);
  if (tip === null) return false;
  if (tip === p.top_sha || !isAncestor(repo, p.onto, topRef)) return false;
  const bottomRef = `refs/heads/${p.bottom}`;
  const bottomTip = resolveCommit(repo, bottomRef);
  if (bottomTip === null) return false;
  return bottomTip === p.old_base || isAncestor(repo, p.onto, bottomRef);
}

function needsRestack(state) {
  return state === "out_of_date" || state === "parent_merged";
}

/** How "needs a restack" flows up one chain (bottom to top): `blocker` is
 *  the lowest layer below needing a restack first, `dropped_for` the layer
 *  above whose merged parent this layer is. Shared by status and plan. */
function propagate(chain) {
  const droppedFor = chain.map((l, i) => {
    const up = chain[i + 1];
    return up && up.state === "parent_merged" && up.parent === l.branch ? i + 1 : null;
  });
  let blocker = null;
  return chain.map((l, i) => {
    const out = { blocker, dropped_for: droppedFor[i] };
    if (blocker === null && needsRestack(l.state) && droppedFor[i] === null) blocker = i;
    return out;
  });
}

/** One layer's own state; self-heals the base unless a rebase is running. */
function classify(repo, meta, hints, remoteTrunk, rebaseInProgress) {
  const parent = meta.parent;
  const parentTip = resolveCommit(repo, `refs/heads/${parent}`);
  // A base that is not a sha naming an existing commit counts as absent.
  const base = isSha(meta.base) && resolveCommit(repo, meta.base) !== null ? meta.base : null;
  const l = {
    branch: meta.branch,
    parent: meta.parent,
    base: meta.base,
    parent_tip: parentTip,
    state: "up_to_date",
    inherited: false,
    actionable: false,
    merge_signal: null,
    merged_pr: null,
    parent_behind_upstream: 0,
    top: "",
  };

  // 1. The forge says the parent's PR is merged.
  let hint = hints.find((h) => h.branch === parent) ?? null;
  if (hint && hintIsStale(repo, hint, parentTip)) hint = null;
  if (hint) {
    l.state = "parent_merged";
    l.merge_signal = "forge";
    l.merged_pr = hint.number;
    return l;
  }
  // 2. git fallback against the remote trunk (D7). Every commit of the parent
  //    must be merged (I-1): when the parent grew from the base, probe its tip.
  const probe = mergedProbe(repo, base, parentTip);
  if (remoteTrunk !== null && probe !== null) {
    const sig = mergedSignal(repo, remoteTrunk, probe);
    if (sig !== null) {
      l.state = "parent_merged";
      l.merge_signal = sig;
      return l;
    }
  }
  // 3. The parent is gone locally.
  if (parentTip === null) {
    l.state = "parent_missing";
    return l;
  }
  const layerRef = `refs/heads/${meta.branch}`;
  // 4. Up to date; a manual rebase may have left the base behind.
  if (isAncestor(repo, parentTip, layerRef)) {
    if (base !== parentTip && !rebaseInProgress) {
      setBase(repo, meta.branch, parentTip);
      l.base = parentTip;
    }
    return l;
  }
  // 5. The parent moved under a layer that still sits on its base.
  if (base !== null && isAncestor(repo, base, layerRef)) {
    l.state = "out_of_date";
    l.parent_behind_upstream = behindUpstream(repo, parent);
    return l;
  }
  // 6. Neither the parent tip nor the base is below the layer (D17).
  l.state = "base_lost";
  return l;
}

/** `merged_probe`: the parent's tip when the recorded base is below it, else
 *  the base, else the tip. */
function mergedProbe(repo, base, parentTip) {
  if (base !== null && parentTip !== null && isAncestor(repo, base, parentTip)) return parentTip;
  return base ?? parentTip;
}

/** A merged-PR hint is stale when the parent's local tip has commits the
 *  merged head never had. Honoured when it cannot be judged. */
function hintIsStale(repo, h, parentTip) {
  const oid = h.head_ref_oid ?? null;
  if (oid === null || parentTip === null) return false;
  if (!isSha(oid) || resolveCommit(repo, oid) === null) return false;
  return !isAncestor(repo, parentTip, oid);
}

/** D7: has `base` landed on `remoteTrunk`? `cherry` (every commit there by
 *  patch-id) or `merge_commit` (an ancestor, off the first-parent line).
 *  Any git error reads as "not merged". */
function mergedSignal(repo, remoteTrunk, base) {
  if (remoteTrunk.startsWith("-") || base.startsWith("-")) return null;
  try {
    // (a) cherry
    const out = run(repo, ["cherry", remoteTrunk, base]);
    if (ok(out)) {
      const ls = lines(trimmed(out.stdout)).filter((l) => l !== "");
      if (ls.length && ls.every((l) => l.startsWith("-"))) return "cherry";
    }
    // (b) merge commit: the oldest commit of the trunk's first-parent walk
    // down to `base`; its first parent is `base` only when base is on the line.
    if (!isAncestor(repo, base, remoteTrunk)) return null;
    const baseSha = resolveCommit(repo, base);
    if (baseSha === null) return null;
    const walk = run(repo, ["rev-list", "--first-parent", `${baseSha}..${remoteTrunk}`]);
    if (!ok(walk)) return null;
    const oldest = lines(trimmed(walk.stdout))
      .map((l) => l.trim())
      .filter((l) => l !== "")
      .pop();
    if (oldest === undefined) return null;
    const firstParent = resolveCommit(repo, `${oldest}^1`);
    if (firstParent === null) return null;
    return firstParent !== baseSha ? "merge_commit" : null;
  } catch {
    return null;
  }
}

/** Bottom→top lists of layers; layers no walk reaches (a second child, a
 *  cycle) come after, one chain each, in name order. */
function chains(all) {
  const children = new Map();
  for (const m of all.values()) {
    if (!children.has(m.parent)) children.set(m.parent, []);
    children.get(m.parent).push(m.branch);
  }
  const out = [];
  for (const m of [...all.values()].filter((m) => !all.has(m.parent))) {
    const chain = [m.branch];
    const seen = new Set([m.branch]);
    let cur = m.branch;
    for (;;) {
      const next = children.get(cur)?.[0];
      if (next === undefined || seen.has(next)) break;
      seen.add(next);
      chain.push(next);
      cur = next;
    }
    out.push(chain);
  }
  const reached = new Set(out.flat());
  for (const b of all.keys()) if (!reached.has(b)) out.push([b]);
  return out;
}

/** Commits on `branch`'s upstream that `branch` lacks; 0 without one or when
 *  its tracking ref is gone. Any other failure is an error (fails closed). */
function behindUpstream(repo, branch) {
  devValidateBranchName(branch);
  const local = `refs/heads/${branch}`;
  const out = run(repo, ["for-each-ref", "--format=%(upstream)", local]);
  if (!ok(out)) fail(`git for-each-ref ${local}: ${trimmed(out.stderr)}`);
  const upstream = trimmed(out.stdout);
  if (upstream === "" || resolveCommit(repo, upstream) === null) return 0;
  const range = `${local}..${upstream}`;
  const count = run(repo, ["rev-list", "--count", range, "--"]);
  const text = trimmed(count.stdout);
  if (ok(count) && U32.test(text) && Number(text) <= 0xffffffff) return Number(text);
  fail(`git rev-list --count ${range}: ${trimmed(count.stderr)}`);
}

// ── restack.rs ──────────────────────────────────────────────────────────────

/** restack.rs `run_ok`: trimmed stdout, or Err `git <cmd>: <stderr>`. */
function runOk(repo, args) {
  const out = run(repo, args);
  if (ok(out)) return trimmed(out.stdout);
  fail(`git ${args[0] ?? ""}: ${trimmed(out.stderr)}`);
}

/** The restack of `layer`'s chain from `layer` up (spec §5.4). Err only for
 *  a branch that is not a restackable layer, or an unreadable repo; every
 *  refusable condition goes in `refusal`, first one wins. Never settles. */
function plan(repo, configuredTrunk, layer, hints, version) {
  devValidateBranchName(layer);
  const { report, blocked } = statusInner(repo, configuredTrunk, hints, false);
  const l = report.layers.find((x) => x.branch === layer) ?? fail(`not a stacked branch: ${layer}`);
  if (blocked.has(layer)) fail(blocked.get(layer));
  const trunkName = report.trunk ?? "";
  let target;
  switch (l.state) {
    case "parent_missing":
      fail(`cannot restack ${layer}: its parent ${l.parent} is missing`);
      break;
    case "base_lost":
      fail(`cannot restack ${layer}: neither ${l.parent} nor its recorded base is below it`);
      break;
    case "up_to_date":
    case "out_of_date":
      target = parentMoved(l);
      break;
    default:
      target = parentMerged(repo, l, hints, trunkName);
  }
  const holders = branchHolders(repo);
  const rebaseInProgress =
    report.rebase_in_progress || holders.some((h) => h.current && h.rebasing) || rebasingHere(repo);
  // The layers of `layer`'s chain, bottom to top.
  const chain = report.layers.filter((x) => x.top === l.top);
  const pos = chain.findIndex((x) => x.branch === layer);
  if (pos < 0) fail(`not a stacked branch: ${layer}`);
  // Only the lowest layer needing a restack can be restacked; a merged parent
  // being dropped by the layer above neither blocks nor restacks.
  if (!rebaseInProgress) {
    const flow = propagate(chain)[pos];
    if (flow.blocker !== null) fail(`restack ${chain[flow.blocker].branch} first`);
    if (flow.dropped_for !== null) fail(`${layer} is merged: restack ${chain[flow.dropped_for].branch} instead`);
  }
  // The restack's top: the highest layer reached through a contiguous run
  // where each layer contains the one below.
  const runLayers = [l.branch];
  for (const next of chain.slice(pos + 1)) {
    const below = `refs/heads/${runLayers[runLayers.length - 1]}`;
    if (!isAncestor(repo, below, `refs/heads/${next.branch}`)) break;
    runLayers.push(next.branch);
  }
  const top = runLayers[runLayers.length - 1];
  const topSha = resolveCommit(repo, `refs/heads/${top}`) ?? fail(`unknown branch: ${top}`);
  const stack = chain.map((x) => x.branch);
  const moving = [];
  const up = target.upstream_sha;
  if (up !== null) {
    // Layers still sitting at `upstream` (no commit of their own) are outside
    // `upstream..top` and `--update-refs` does not move them: `finalize` does.
    for (const b of runLayers) {
      if (resolveCommit(repo, `refs/heads/${b}`) === up) moving.push(movingRef(repo, b, true));
    }
    moving.push(...movingRefs(repo, up, top, stack));
  }
  const refusal = firstRefusal({
    repo,
    l,
    target,
    trunk: trunkName,
    moving,
    holders,
    rebaseInProgress,
    version,
  });
  if (refusal === null) checkLayersMoving(runLayers, moving);
  return {
    moment: target.moment,
    bottom: l.branch,
    parent: l.parent,
    onto_ref: target.onto_ref,
    onto_sha: target.onto_sha ?? "",
    upstream_sha: target.upstream_sha ?? "",
    top,
    top_sha: topSha,
    moving,
    new_parent: target.new_parent,
    refusal,
  };
}

/** Moment 1: replay `base..top` onto the parent's new tip. */
function parentMoved(l) {
  const tip = l.parent_tip ?? fail(`unknown branch: ${l.parent}`);
  return {
    moment: "parent_moved",
    onto_ref: l.parent,
    onto_sha: tip,
    upstream_sha: l.state === "out_of_date" ? l.base : tip,
    new_parent: null,
    onto_behind: l.parent_behind_upstream,
    merged_work_missing: false,
    parent_commits_unknown: false,
  };
}

/** Moment 2: replay `old-P-tip..top` onto P's own parent (a non-trunk local
 *  branch, D8) or `origin/<trunk>`. The old tip is the recorded base, else
 *  the honoured hint's head (D20), and must be an ancestor of the layer. */
function parentMerged(repo, l, hints, trunkName) {
  const all = readAll(repo);
  const g = all.get(l.parent)?.parent;
  const grand = g !== undefined && g !== trunkName ? g : null;
  let ontoRef, ontoSha, newParent, ontoBehind;
  if (grand !== null) {
    ontoSha = resolveCommit(repo, `refs/heads/${grand}`) ?? fail(`unknown branch: ${grand}`);
    ontoBehind = behindUpstream(repo, grand);
    ontoRef = grand;
    newParent = grand;
  } else {
    ontoSha = resolveCommit(repo, `refs/remotes/origin/${trunkName}`);
    ontoRef = `origin/${trunkName}`;
    newParent = null;
    ontoBehind = 0;
  }
  const honoured = hints.find((h) => h.branch === l.parent && l.merged_pr === h.number);
  // I-2, waves 2-3: the target must contain the merged work — the forge's
  // merge commit when there is one (whatever P' tracks); without one, git must
  // find the parent's commits below `onto` or merged into it, onto a stacked
  // P' and onto origin/<trunk> for a forge hint (a fallback detection already
  // probed origin/<trunk>). Parent commits that cannot be named → no_old_base.
  // The merged PR's head, when it is known and below the layer (D20).
  const layerRef = `refs/heads/${l.branch}`;
  const h = honoured?.head_ref_oid ?? null;
  const verifiedHead = h !== null && commitExists(repo, h) && isAncestor(repo, h, layerRef) ? h : null;
  // The old parent tip: the recorded base when below the layer, else that head.
  const upstream =
    l.base !== null && commitExists(repo, l.base) && isAncestor(repo, l.base, layerRef) ? l.base : verifiedHead;
  let mergedWorkMissing = false;
  let parentCommitsUnknown = false;
  if (ontoSha !== null) {
    const oid = honoured?.merge_commit_oid ?? null;
    if (oid !== null) {
      mergedWorkMissing = !(commitExists(repo, oid) && isAncestor(repo, oid, ontoSha));
    } else if (newParent !== null || honoured) {
      const base = l.base !== null && commitExists(repo, l.base) ? l.base : null;
      // Wave 4 M1, wave 5: base (or the parent's tip), then the verified head.
      const probe = mergedProbe(repo, base, l.parent_tip) ?? verifiedHead;
      if (probe === null) parentCommitsUnknown = true;
      else mergedWorkMissing = !(isAncestor(repo, probe, ontoSha) || mergedSignal(repo, ontoSha, probe) !== null);
    }
  }
  return {
    moment: "parent_merged",
    onto_ref: ontoRef,
    onto_sha: ontoSha,
    upstream_sha: upstream,
    new_parent: newParent,
    onto_behind: ontoBehind,
    merged_work_missing: mergedWorkMissing,
    parent_commits_unknown: parentCommitsUnknown,
  };
}

/** `git cat-file -e <sha>^{commit}` (D20). A non-sha is never a commit. */
function commitExists(repo, sha) {
  if (!isSha(sha)) return false;
  return ok(run(repo, ["cat-file", "-e", `${sha}^{commit}`]));
}

/** A rebase halted in this worktree, whatever it rebases. */
function rebasingHere(repo) {
  for (const state of ["rebase-merge", "rebase-apply"]) {
    const p = runOk(repo, ["rev-parse", "--git-path", state]);
    if (existsSync(isAbsolute(p) ? p : join(repo, p))) return true;
  }
  return false;
}

const refusalOf = (code, message) => ({ code, message, branch: null, path: null, detail: null });

/** The first refusal, in the order `rebase_in_progress`, `up_to_date`,
 *  `git_too_old`, `detached`, `dirty`, `occupied` / `occupied_rebasing`,
 *  `parent_behind`, `no_remote_trunk`, `merged_work_missing`, `no_old_base`. */
function firstRefusal(c) {
  if (c.rebaseInProgress) return refusalOf("rebase_in_progress", "A rebase is in progress. Finish or abort it first.");
  if (c.l.state === "up_to_date") {
    return refusalOf("up_to_date", `${c.l.branch} is already up to date with ${c.l.parent}.`);
  }
  if (!supportsUpdateRefs(c.version)) {
    const found = c.version !== null ? `${c.version[0]}.${c.version[1]}` : "unknown";
    return { ...refusalOf("git_too_old", `Restacking needs git 2.38 or later (found ${found}).`), detail: found };
  }
  // D16: `symbolic-ref -q` exits 1 on a detached HEAD.
  const head = run(c.repo, ["symbolic-ref", "-q", "HEAD"]);
  if (head.status === 1) return refusalOf("detached", "HEAD is detached. Check out a branch first.");
  if (head.status !== 0) fail(`git symbolic-ref HEAD: ${trimmed(head.stderr)}`);
  // D15: tracked changes only, git rebase's own rule.
  if (runOk(c.repo, ["status", "--porcelain", "--untracked-files=no"]) !== "") {
    return refusalOf("dirty", "You have uncommitted changes to tracked files. Commit or stash them first.");
  }
  // D21: `--update-refs` skips a ref held by another worktree.
  for (const m of c.moving) {
    const h = c.holders.find((h) => h.branch === m.branch && !h.current);
    if (h) {
      const [code, how] = h.rebasing ? ["occupied_rebasing", "being rebased"] : ["occupied", "checked out"];
      return {
        code,
        message: `${m.branch} is ${how} in another worktree (${h.worktree}).`,
        branch: m.branch,
        path: h.worktree,
        detail: null,
      };
    }
  }
  const t = c.target;
  if (t.onto_behind > 0) {
    return {
      ...refusalOf("parent_behind", `${t.onto_ref} is ${t.onto_behind} commit(s) behind its upstream. Pull it first.`),
      branch: t.onto_ref,
      detail: String(t.onto_behind),
    };
  }
  if (t.onto_sha === null) {
    return refusalOf("no_remote_trunk", `There is no origin/${c.trunk} to restack onto. Fetch from origin first.`);
  }
  if (t.merged_work_missing) {
    const pr = c.l.merged_pr !== null ? ` (PR #${c.l.merged_pr})` : "";
    return {
      code: "merged_work_missing",
      // Wave 4 M2: onto the remote trunk, the work was most likely merged elsewhere.
      message:
        t.new_parent === null
          ? `GitWand cannot find the merged work of ${c.l.parent}${pr} in ${t.onto_ref}. If the pull request was squash-merged elsewhere, unstack ${c.l.parent}'s child and restack it by hand.`
          : `The merged work of ${c.l.parent}${pr} is not in ${t.onto_ref} yet: update ${t.onto_ref} first.`,
      branch: t.onto_ref,
      path: null,
      detail: null,
    };
  }
  if (t.upstream_sha === null || t.parent_commits_unknown) {
    return refusalOf(
      "no_old_base",
      `The commit ${c.l.parent} pointed to before its merge is not available locally.`,
    );
  }
  return null;
}

/** D21: every local branch whose tip is in `upstream..top` (top included) —
 *  what `git rebase --update-refs` moves. Bottom to top, then by name. */
function movingRefs(repo, upstream, top, stack) {
  if (upstream.startsWith("-")) fail(`invalid ref: ${upstream}`);
  devValidateBranchName(top);
  const commits = runOk(repo, ["rev-list", "--reverse", `${upstream}..refs/heads/${top}`, "--"]);
  const position = new Map();
  lines(commits)
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .forEach((sha, i) => position.set(sha, i));
  const refs = runOk(repo, [
    "for-each-ref",
    "--format=%(objectname) %(refname) %(upstream) %(upstream:short)",
    "refs/heads/",
  ]);
  const out = [];
  for (const line of lines(refs)) {
    const f = line.split(" ");
    if (f.length < 2) continue;
    const [sha, refname] = f;
    if (!position.has(sha)) continue;
    if (!refname.startsWith("refs/heads/")) continue;
    const branch = refname.slice("refs/heads/".length);
    out.push([position.get(sha), tracked(repo, branch, stack.includes(branch), f[2] ?? "", f[3] ?? "")]);
  }
  out.sort((a, b) => a[0] - b[0] || byteCmp(a[1].branch, b[1].branch));
  return out.map(([, m]) => m);
}

/** One branch as a moving ref, with its upstream read from git. */
function movingRef(repo, branch, inStack) {
  const line = runOk(repo, ["for-each-ref", "--format=%(upstream) %(upstream:short)", `refs/heads/${branch}`]);
  const f = line.split(" ");
  return tracked(repo, branch, inStack, f[0] ?? "", f[1] ?? "");
}

function tracked(repo, branch, inStack, upstreamRef, upstreamShort) {
  const block =
    upstreamRef === ""
      ? null
      : devPushBlock(branch, branchConfig(repo, branch, "remote") ?? "", branchConfig(repo, branch, "merge") ?? "");
  return {
    branch,
    in_stack: inStack,
    upstream: upstreamShort !== "" ? upstreamShort : null,
    remote_sha: upstreamRef === "" || block !== null ? null : resolveCommit(repo, upstreamRef),
    push_block: block,
  };
}

/** `branch.<b>.<var>`; null when unset. Any other failure is an error. */
function branchConfig(repo, branch, v) {
  const k = key(branch, v);
  const out = run(repo, ["config", "--get", k]);
  if (out.status === 0) return trimmed(out.stdout) || null;
  if (out.status === 1) return null;
  fail(`git config ${k}: ${trimmed(out.stderr)}`);
}

/** C-1, `push_block` (restack.rs): why `branch` must not be force-pushed to
 *  the upstream its config names (a local branch, or another name), or null.
 *  Shared by `/api/git-push-branch` and the plan's push leases. */
export function devPushBlock(branch, remote, merge) {
  if (remote === ".") return `${branch} tracks a local branch, not a remote: push it yourself`;
  const other = merge.startsWith("refs/heads/") ? merge.slice("refs/heads/".length) : merge;
  return other !== branch ? `${branch} tracks ${remote}/${other}, not ${remote}/${branch}: push it yourself` : null;
}

/** Invariant of a restack that will run: every layer bottom..top moves. */
function checkLayersMoving(runLayers, moving) {
  const b = runLayers.find((b) => !moving.some((m) => m.branch === b));
  if (b !== undefined) fail(`internal error: restack would leave ${b} behind`);
}

const STALE_PREVIEW = "stale preview: the stack changed since the preview. Preview again.";

/** The current branch, null on a detached HEAD. */
function currentBranch(repo) {
  const out = run(repo, ["symbolic-ref", "-q", "HEAD"]);
  if (out.status === 0) {
    const full = trimmed(out.stdout);
    if (full.startsWith("refs/heads/") && full.length > "refs/heads/".length) return full.slice("refs/heads/".length);
    fail(`unexpected HEAD: ${full}`);
  }
  if (out.status === 1) return null;
  fail(`git symbolic-ref HEAD: ${trimmed(out.stderr)}`);
}

/** Runs the previewed restack (spec §5.4, D5): re-plans and refuses as `plan`
 *  does, or on a stale preview; writes the pending record once every check
 *  passed; one `git rebase --update-refs`. Never finalizes. */
function runRestack(repo, configuredTrunk, layer, hints, previewed, version) {
  const p = plan(repo, configuredTrunk, layer, hints, version);
  if (p.refusal) fail(p.refusal.message);
  const moving = p.moving.map((m) => m.branch);
  if (
    p.onto_sha !== previewed.onto_sha ||
    p.upstream_sha !== previewed.upstream_sha ||
    p.top_sha !== previewed.top_sha ||
    moving.length !== previewed.moving.length ||
    moving.some((b, i) => b !== previewed.moving[i])
  ) {
    fail(STALE_PREVIEW);
  }
  devValidateBranchName(p.top);
  if (!isSha(p.onto_sha) || !isSha(p.upstream_sha)) {
    fail(`internal error: restack of ${layer} has no commit to rebase onto`);
  }
  const original = currentBranch(repo) ?? fail("HEAD is detached. Check out a branch first.");
  // The top's tip just before the rebase: the record's proof it ran (D4).
  const topSha = resolveCommit(repo, `refs/heads/${p.top}`) ?? fail(`unknown branch: ${p.top}`);
  if (topSha !== p.top_sha) fail(STALE_PREVIEW);
  const merged = p.moment === "parent_merged";
  setPending(repo, p.top, {
    moment: p.moment,
    onto: p.onto_sha,
    old_base: p.upstream_sha,
    bottom: p.bottom,
    new_parent: merged ? p.new_parent : null,
    original,
    top_sha: topSha,
    merged_parent: merged ? p.parent : null,
    worktree: worktreeId(repo),
  });

  // `--update-refs` never moves the branch checked out in the worktree it
  // runs in (git 2.54, verified): a user on a lower layer would see the
  // layers above move without it. From a detached HEAD at the same commit,
  // the rebase moves every ref; finalize switches back to `original`.
  const back = original !== p.top && moving.includes(original) ? original : null;
  if (back !== null) {
    let msg = null;
    try {
      const d = run(repo, ["switch", "--detach", "--quiet"]);
      if (!ok(d)) msg = trimmed(d.stderr);
    } catch (e) {
      msg = e.message;
    }
    if (msg !== null) fail(rebaseFailed(repo, p.top, null, msg));
  }

  const r = spawnSync(GIT, ["rebase", "--update-refs", "--onto", p.onto_sha, p.upstream_sha, p.top], {
    cwd: repo,
    encoding: "utf-8",
    maxBuffer: Infinity,
    env: {
      ...process.env,
      GIT_EDITOR: "true",
      EDITOR: "true",
      GIT_TERMINAL_PROMPT: "0",
      // The conflict check below matches git's own words.
      LC_ALL: "C",
      LANGUAGE: "",
    },
  });
  if (r.error) fail(rebaseFailed(repo, p.top, back, r.error.message));
  if (r.status === 0) return { conflict: false };
  const stderr = (r.stderr ?? "").trim();
  const stdout = (r.stdout ?? "").trim();
  if ([stderr, stdout].some((s) => s.includes("CONFLICT") || s.includes("could not apply"))) {
    return { conflict: true };
  }
  // Halted without those words (an untracked file a pick would overwrite):
  // a pick is still to do, which the rebase banner takes over. A rebase
  // left with nothing to pick (a ref git could not update) is a failure
  // whose words must reach the user, with what to do about the open rebase.
  if (haltedOnAPick(repo)) return { conflict: true };
  let msg = stderr === "" ? stdout : stderr;
  let open = false;
  try {
    open = rebasingHere(repo);
  } catch {
    open = false;
  }
  if (open) msg += STILL_OPEN;
  fail(rebaseFailed(repo, p.top, back, msg));
}

/** `STILL_OPEN`: appended to a failed run that leaves a rebase open with nothing to pick. */
const STILL_OPEN =
  " (the rebase is still open: abort it to put every branch back, fix the cause, then restack again)";

/** `halted_on_a_pick`: a rebase in progress here with a command still to do. */
function haltedOnAPick(repo) {
  try {
    const p = runOk(repo, ["rev-parse", "--git-path", "rebase-merge/git-rebase-todo"]);
    const todo = readFileSync(isAbsolute(p) ? p : join(repo, p), "utf-8");
    return todo.split("\n").some((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("#");
    });
  } catch {
    return false;
  }
}

/** `worktree_id`: `-` for the main worktree, else its id in lowercase hex. */
function worktreeId(repo) {
  const [dir, common] = lines(runOk(repo, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]));
  // A git older than 2.31 echoes `--path-format=absolute` back: anything but
  // two absolute paths, the git dir under the common one, is unknown.
  if (
    dir === undefined ||
    common === undefined ||
    !isAbsolute(dir) ||
    !isAbsolute(common) ||
    !(dir === common || dir.startsWith(common.endsWith("/") ? common : `${common}/`))
  ) {
    fail("unexpected rev-parse output");
  }
  if (dir === common) return "-";
  const id = dir.split("/").filter(Boolean).pop() ?? fail(`unexpected git dir: ${dir}`);
  return Buffer.from(id, "utf-8").toString("hex");
}

/** `worktree_exists`: the worktree a record names still exists. */
function worktreeExists(repo, id) {
  if (id === "-") return true;
  const name = Buffer.from(id, "hex").toString("utf-8");
  const common = runOk(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return existsSync(join(common, "worktrees", name));
}

/** A HEAD left detached at `original`'s tip (a run that could not switch
 *  back) goes back on `original`. Best effort, nothing else is touched. */
function reattach(repo, original) {
  try {
    devValidateBranchName(original);
    if (currentBranch(repo) !== null) return;
    const head = resolveCommit(repo, "HEAD");
    const tip = resolveCommit(repo, `refs/heads/${original}`);
    if (head !== null && head === tip) run(repo, ["switch", "--no-guess", "--quiet", original]);
  } catch {
    // best effort
  }
}

/** A rebase that failed without halting: the record goes, unless a rebase is
 *  now in progress here (or that cannot be told). `back`: the branch the run
 *  detached HEAD from, checked out again (nothing moved). */
function rebaseFailed(repo, top, back, detail) {
  let msg = `git rebase failed: ${detail}`;
  let here;
  try {
    here = rebasingHere(repo);
  } catch {
    return msg;
  }
  if (here) return msg;
  if (back !== null) {
    const out = run(repo, ["switch", "--no-guess", "--quiet", back]);
    if (!ok(out)) msg = `${msg} (HEAD is left detached: ${trimmed(out.stderr)})`;
  }
  try {
    clearPending(repo, top);
    return msg;
  } catch (e) {
    return `${msg} (the restack record could not be cleared: ${e.message})`;
  }
}

/** The layers `bottom` to `top`, following each layer's child. */
function restackedLayers(all, bottom, top) {
  const out = [bottom];
  while (out[out.length - 1] !== top) {
    const cur = out[out.length - 1];
    const next = [...all.values()].find((m) => m.parent === cur);
    if (next && out.length <= all.size) out.push(next.branch);
    else fail(`cannot finalize the restack: ${top} is no longer stacked above ${bottom}`);
  }
  return out;
}

/** Completes a restack whose rebase has ended (D5): moves empty layers by
 *  CAS (after a holders guard), records the new bases, re-parents a moment-2
 *  bottom and drops the merged parent, clears the record, switches back.
 *  Idempotent; an Err leaves the record in place. */
function finalize(repo, top, p, hints) {
  devValidateBranchName(top);
  devValidateBranchName(p.bottom);
  const all = readAll(repo);
  const layers = restackedLayers(all, p.bottom, top);

  // 1. Empty layers (sitting exactly at the upstream): compare-and-swap onto
  //    `onto`, never a branch a worktree holds, before any metadata.
  const empty = layers.filter((b) => resolveCommit(repo, `refs/heads/${b}`) === p.old_base);
  if (empty.length) {
    const holders = branchHolders(repo);
    for (const b of empty) {
      const h = holders.find((h) => h.branch === b);
      if (h) {
        const how = h.rebasing ? "being rebased" : "checked out";
        fail(
          `${b} is ${how} in a worktree (${h.worktree}), so it cannot be moved onto the restacked stack. Free it, then refresh.`,
        );
      }
    }
    for (const b of empty) {
      const out = run(repo, ["update-ref", `refs/heads/${b}`, p.onto, p.old_base]);
      if (!ok(out)) fail(`could not move ${b} onto the restacked stack: ${trimmed(out.stderr)}`);
    }
  }

  // 2. Metadata. Each layer above the bottom sits on its merge-base with its
  //    parent; the bottom sits on `onto`.
  for (const b of layers.slice(1)) {
    const m = all.get(b);
    if (!m) continue;
    const mb = runOk(repo, ["merge-base", `refs/heads/${m.parent}`, `refs/heads/${b}`]);
    if (m.base !== mb) setBase(repo, b, mb);
  }
  const bottom = all.get(p.bottom) ?? null;
  const onOnto = (m) => m.base === p.onto;
  let mergedParent = null;
  let newParent = null;
  if (p.moment === "parent_moved") {
    if (bottom && !onOnto(bottom)) setBase(repo, bottom.branch, p.onto);
  } else {
    // The merged parent leaves the stack, before the bottom (see Rust).
    if (p.merged_parent !== null && all.has(p.merged_parent)) unset(repo, p.merged_parent);
    if (p.new_parent !== null) {
      if (bottom) {
        if (bottom.parent !== p.new_parent) writeParent(repo, bottom.branch, p.new_parent);
        if (!onOnto(bottom)) setBase(repo, bottom.branch, p.onto);
      }
      newParent = p.new_parent;
    } else if (bottom) {
      unset(repo, p.bottom);
    }
    mergedParent = p.merged_parent;
  }
  const moved = layers.filter((b) => isAncestor(repo, p.onto, `refs/heads/${b}`));
  // The last write: nothing after it may fail the finalize.
  clearPending(repo, top);

  // 3. Back to the branch the user was on when the restack started.
  const [switchedBackTo, switchError] = switchBack(repo, top, p.original);
  // After the switch back, which may check the merged parent out.
  const offer = mergedParent !== null ? deleteOffer(repo, mergedParent, p.old_base, hints) : null;
  return {
    moment: p.moment,
    bottom: p.bottom,
    merged_parent: mergedParent,
    new_parent: newParent,
    moved,
    switched_back_to: switchedBackTo,
    switch_error: switchError,
    delete_offer: offer,
  };
}

/** I-1 (b), M-1: the merged parent may be force-deleted only when it still
 *  points at `oldBase` or the merged PR's head, and no worktree holds it.
 *  Never throws: anything it cannot check means no offer. */
function deleteOffer(repo, merged, oldBase, hints) {
  try {
    devValidateBranchName(merged);
    const tip = resolveCommit(repo, `refs/heads/${merged}`);
    if (tip === null) return null;
    const head = hints.find((h) => h.branch === merged)?.head_ref_oid ?? null;
    if (tip !== oldBase && head !== tip) return null;
    return branchHolders(repo).some((h) => h.branch === merged) ? null : { branch: merged, tip };
  } catch {
    return null;
  }
}

/** Switches back to `original` when HEAD is still on `top`. Never fails. */
function switchBack(repo, top, original) {
  try {
    return trySwitchBack(repo, top, original);
  } catch (e) {
    return [null, { branch: original, reason: e.message }];
  }
}

function trySwitchBack(repo, top, original) {
  if (original === top || currentBranch(repo) !== top) return [null, null];
  let valid = true;
  try {
    devValidateBranchName(original);
  } catch {
    valid = false;
  }
  if (!valid || resolveCommit(repo, `refs/heads/${original}`) === null) {
    return [null, { branch: original, reason: "the branch no longer exists" }];
  }
  if (runOk(repo, ["status", "--porcelain", "--untracked-files=no"]) !== "") {
    return [null, { branch: original, reason: `uncommitted changes on ${top}` }];
  }
  const out = run(repo, ["switch", "--no-guess", original]);
  if (ok(out)) return [original, null];
  return [null, { branch: original, reason: trimmed(out.stderr) }];
}

/** Wave 2, item 1, `delete_merged_parent`: deletes `branch` only if it still
 *  points at `tip` (compare-and-swap), never one a worktree holds; then its
 *  config section, as `git branch -D` does. */
function deleteMergedParent(repo, branch, tip) {
  devValidateBranchName(branch);
  if (!isSha(tip)) fail(`invalid ref: ${tip}`);
  const h = branchHolders(repo).find((x) => x.branch === branch);
  if (h) {
    const how = h.rebasing ? "being rebased" : "checked out";
    fail(`${branch} is ${how} in a worktree (${h.worktree}): not deleted.`);
  }
  const out = run(repo, ["update-ref", "--no-deref", "-d", `refs/heads/${branch}`, tip]);
  if (!ok(out)) fail(`${branch} changed since the restack: not deleted (${trimmed(out.stderr)})`);
  run(repo, ["config", "--local", "--remove-section", `branch.${branch}`]);
}

// ── commands/stack.rs ───────────────────────────────────────────────────────
// The route bodies: wire arguments in, `crate::stack` out. `mergedParents`
// carries `MergedParentHint` and `previewed` carries `PreviewedRestack`, both
// in serde's snake_case, as Tauri deserializes them. Both are required, as
// Tauri requires every non-`Option` argument: a missing one is refused with
// Tauri's words (the probe's `command_parity` alone defaults it to `[]`).

const optString = (v) => (typeof v === "string" ? v : null);

/** Tauri's own refusal of a bad top-level argument (`InvalidArgs`). */
function invalidArgs(name, command, why) {
  fail(`invalid args \`${name}\` for command \`${command}\`: ${why}`);
}

/** serde's "invalid type" for a JSON value where `expected` was wanted. */
function invalidType(v, expected) {
  const what =
    v === null ? "null"
    : Array.isArray(v) ? "sequence"
    : typeof v === "string" ? `string ${JSON.stringify(v)}`
    : typeof v === "object" ? "map"
    : typeof v === "boolean" ? `boolean \`${v}\``
    : `${Number.isInteger(v) ? "integer" : "floating point"} \`${v}\``;
  return `invalid type: ${what}, expected ${expected}`;
}

/** `Vec<MergedParentHint>` (`{ branch, number, head_ref_oid?, merge_commit_oid? }`), required
 *  like any non-`Option` argument of a Tauri command: missing is refused. */
function mergedParentHints(v, command) {
  const name = "mergedParents";
  if (v === undefined) invalidArgs(name, command, `command ${command} missing required key ${name}`);
  if (!Array.isArray(v)) invalidArgs(name, command, invalidType(v, "a sequence"));
  return v.map((h) => {
    if (!h || typeof h !== "object" || Array.isArray(h)) invalidArgs(name, command, invalidType(h, "struct MergedParentHint"));
    if (typeof h.branch !== "string") invalidArgs(name, command, "missing field `branch`");
    if (!Number.isSafeInteger(h.number)) invalidArgs(name, command, "missing field `number`");
    const oid = h.head_ref_oid ?? null;
    if (oid !== null && typeof oid !== "string") invalidArgs(name, command, invalidType(oid, "a string"));
    const merge = h.merge_commit_oid ?? null;
    if (merge !== null && typeof merge !== "string") invalidArgs(name, command, invalidType(merge, "a string"));
    return { branch: h.branch, number: h.number, head_ref_oid: oid, merge_commit_oid: merge };
  });
}

/** `PreviewedRestack`: `{ onto_sha, upstream_sha, top_sha, moving }`, required. */
function previewedRestack(v, command) {
  const name = "previewed";
  if (v === undefined) invalidArgs(name, command, `command ${command} missing required key ${name}`);
  if (!v || typeof v !== "object" || Array.isArray(v)) invalidArgs(name, command, invalidType(v, "struct PreviewedRestack"));
  for (const k of ["onto_sha", "upstream_sha", "top_sha", "moving"]) {
    if (v[k] === undefined) invalidArgs(name, command, `missing field \`${k}\``);
  }
  for (const k of ["onto_sha", "upstream_sha", "top_sha"]) {
    if (typeof v[k] !== "string") invalidArgs(name, command, invalidType(v[k], "a string"));
  }
  if (!Array.isArray(v.moving) || v.moving.some((b) => typeof b !== "string")) {
    invalidArgs(name, command, invalidType(v.moving, "a sequence of strings"));
  }
  return { onto_sha: v.onto_sha, upstream_sha: v.upstream_sha, top_sha: v.top_sha, moving: v.moving };
}

export function devStackStatus(cwd, configuredTrunk, mergedParents) {
  return status(cwd, optString(configuredTrunk), mergedParentHints(mergedParents, "stack_status"));
}

export function devStackSetParent(cwd, branch, parent, configuredTrunk) {
  return setParent(cwd, trunk(cwd, optString(configuredTrunk)), branch, parent);
}

export function devStackUnset(cwd, branch) {
  unset(cwd, branch);
  return null;
}

export function devStackRestackPlan(cwd, branch, configuredTrunk, mergedParents) {
  return plan(cwd, optString(configuredTrunk), branch, mergedParentHints(mergedParents, "stack_restack_plan"), gitVersion());
}

export function devGitRestack(cwd, branch, configuredTrunk, mergedParents, previewed) {
  return runRestack(
    cwd,
    optString(configuredTrunk),
    branch,
    mergedParentHints(mergedParents, "git_restack"),
    previewedRestack(previewed, "git_restack"),
    gitVersion(),
  );
}

export function devStackDeleteMergedParent(cwd, branch, tip) {
  deleteMergedParent(cwd, branch, tip);
  return null;
}
