// Guided bisect — dev-server mirror of src-tauri/src/commands/bisect.rs.
// Same git calls, same refusals, same result shape (`BisectStatus`, camelCase;
// `terms` as [bad, good]). Kept in its own module so tests import it directly.
// Everything is read from git's machine state, never from its messages.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

function run(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw r.error;
  return r;
}

function runOk(cwd, args) {
  const r = run(cwd, args);
  if (r.status !== 0) {
    const err = (r.stderr || "").trim();
    throw new Error(err || `git ${args.join(" ")} failed`);
  }
  return r.stdout;
}

function gitDir(cwd) {
  const d = runOk(cwd, ["rev-parse", "--git-dir"]).trim();
  return isAbsolute(d) ? d : join(cwd, d);
}

const isBisecting = (cwd) => existsSync(join(gitDir(cwd), "BISECT_LOG"));

function terms(cwd) {
  try {
    const lines = readFileSync(join(gitDir(cwd), "BISECT_TERMS"), "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length >= 2) return [lines[0], lines[1]];
  } catch {
    // no custom terms
  }
  return ["bad", "good"];
}

function headHash(cwd) {
  const r = run(cwd, ["rev-parse", "--verify", "-q", "HEAD"]);
  return r.status === 0 ? r.stdout.trim() : null;
}

/** The bisect part of `/api/git-repo-state`: its state object, or null. */
export function devBisectRepoState(cwd) {
  if (!isBisecting(cwd)) return null;
  return { state: "bisect", hasConflict: false, operationHead: headHash(cwd), targetBranch: null, step: 0, total: 0 };
}

export function devBisectStatus(cwd) {
  const [badTerm, goodTerm] = terms(cwd);
  let start = null;
  try {
    start = readFileSync(join(gitDir(cwd), "BISECT_START"), "utf-8").trim() || null;
  } catch {
    // not started from GitWand's point of view
  }
  let bad = null;
  const good = [];
  const skipped = [];
  const refs = runOk(cwd, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/bisect/"]);
  for (const line of refs.split("\n")) {
    const sp = line.indexOf(" ");
    if (sp < 0) continue;
    const name = line.slice(0, sp);
    const hash = line.slice(sp + 1).trim();
    if (name === `refs/bisect/${badTerm}`) bad = hash;
    else if (name.startsWith(`refs/bisect/${goodTerm}-`)) good.push(hash);
    else if (name.startsWith("refs/bisect/skip-")) skipped.push(hash);
  }
  let remaining = null;
  let steps = null;
  let candidates = [];
  if (bad && good.length > 0) {
    const vars = runOk(cwd, ["rev-list", "--bisect-vars", bad, "--not", ...good]);
    const v = (k) => {
      const line = vars.split("\n").find((l) => l.startsWith(`${k}=`));
      const n = line ? Number(line.slice(k.length + 1).trim().replace(/'/g, "")) : NaN;
      return Number.isFinite(n) ? n : null;
    };
    steps = v("bisect_steps");
    // As in the Rust command: `bisect_nr` ignores skips, this leaves them out.
    const rangeLen = Number(runOk(cwd, ["rev-list", "--count", bad, "--not", ...good]).trim()) || 0;
    remaining = Math.max(0, rangeLen - 1 - skipped.length);
    if (rangeLen <= skipped.length + 1) {
      const range = runOk(cwd, ["rev-list", bad, "--not", ...good]).split("\n").filter(Boolean);
      const untested = range.filter((h) => !skipped.includes(h));
      if (untested.length === 1 && untested[0] === bad) candidates = range;
    }
  }
  const current = headHash(cwd);
  const marked = (h) => h === bad || good.includes(h) || skipped.includes(h);
  const pendingCheckout = candidates.length === 0 && remaining !== null && remaining > 0 && !!current && marked(current);
  const toDescribe = [...(current ? [current] : []), ...candidates.filter((c) => c !== current)];
  return {
    current,
    start,
    bad,
    good,
    skipped,
    remaining,
    steps,
    candidates,
    terms: [badTerm, goodTerm],
    commits: describe(cwd, toDescribe),
    pendingCheckout,
  };
}

/** Subject, author and date of each hash, in one `git log`. */
function describe(cwd, hashes) {
  if (hashes.length === 0) return [];
  const r = run(cwd, ["log", "--no-walk=unsorted", "--format=%H%x1f%s%x1f%an%x1f%aI", ...hashes]);
  if (r.status !== 0) return [];
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [hash, subject, author, date] = l.split("\x1f");
      return { hash, subject, author, date };
    });
}

const isHash = (s) => typeof s === "string" && /^[0-9a-f]{7,64}$/i.test(s);

/** A rebase, merge, cherry-pick or revert in progress (what `git_repo_state` reports before bisect). */
function otherOperation(cwd) {
  const d = gitDir(cwd);
  return ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"].some((f) =>
    existsSync(join(d, f)),
  );
}

export function devBisectStart(cwd, bad, good) {
  if (!isHash(bad) || !isHash(good)) throw new Error("A bisect starts from two commit hashes.");
  if (otherOperation(cwd) || isBisecting(cwd)) {
    throw new Error("Another operation is in progress; finish it before starting a bisect.");
  }
  if (runOk(cwd, ["status", "--porcelain", "--untracked-files=no"]).trim()) {
    throw new Error("Commit or stash your uncommitted changes before starting a bisect.");
  }
  // The ancestor is the good end, whichever way they are passed.
  const isAncestor = (a, b) => run(cwd, ["merge-base", "--is-ancestor", a, b]).status === 0;
  if (!isAncestor(good, bad)) {
    if (!isAncestor(bad, good)) {
      throw new Error("One of the two commits must be an ancestor of the other: they are on separate branches.");
    }
    [bad, good] = [good, bad];
  }
  runOk(cwd, ["bisect", "start", bad, good]);
  return devBisectStatus(cwd);
}

export function devBisectMark(cwd, verdict) {
  const [badTerm, goodTerm] = terms(cwd);
  const term = verdict === "good" ? goodTerm : verdict === "bad" ? badTerm : verdict === "skip" || verdict === "next" ? verdict : null;
  if (!term) throw new Error(`Unknown bisect verdict: ${verdict}`);
  if (!isBisecting(cwd)) throw new Error("No bisect is in progress.");
  try {
    runOk(cwd, ["bisect", term]);
  } catch (err) {
    // As in the Rust command: only skipped commits left is a result.
    const st = devBisectStatus(cwd);
    if (st.candidates.length === 0) throw err;
    return st;
  }
  return devBisectStatus(cwd);
}

export function devBisectReset(cwd) {
  runOk(cwd, ["bisect", "reset"]);
  if (isBisecting(cwd)) throw new Error("git could not end the bisect.");
}
