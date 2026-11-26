// Guided bisect — dev-server mirror of src-tauri/src/commands/bisect.rs.
// Same git calls, same refusals, same result shape (`BisectStatus`, camelCase;
// `terms` as [bad, good]). Kept in its own module so tests import it directly.
// Everything is read from git's machine state, never from its messages.
// GitWand's own refusals start with the same stable codes (`bisect:<code>: …`).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { resolveBin } from "./dev-bin.mjs";

/** The git dev-server.mjs spawns (`resolveBin`), not whatever is first on PATH. */
const GIT = resolveBin("git");

function run(cwd, args) {
  const r = spawnSync(GIT, args, { cwd, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
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

const isBisecting = (dir) => existsSync(join(dir, "BISECT_LOG"));

function terms(dir) {
  try {
    const lines = readFileSync(join(dir, "BISECT_TERMS"), "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length >= 2) return [lines[0], lines[1]];
  } catch {
    // no custom terms
  }
  return ["bad", "good"];
}

function headHash(cwd, ref = "HEAD") {
  const r = run(cwd, ["rev-parse", "--verify", "-q", ref]);
  return r.status === 0 ? r.stdout.trim() : null;
}

/** The words of a `BISECT_NAMES` file, which git writes shell-quoted (`'--' 'a.txt' 'it'\\''s'`). */
export function parseSqQuoted(text) {
  const words = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;
    let word = "";
    while (i < text.length && !/\s/.test(text[i])) {
      const c = text[i++];
      if (c === "'") {
        while (i < text.length && text[i] !== "'") word += text[i++];
        i++;
      } else if (c === "\\") {
        if (i < text.length) word += text[i++];
      } else word += c;
    }
    words.push(word);
  }
  return words;
}

/** As in the Rust command: `--first-parent` and the paths the bisect was limited to. */
function scope(dir) {
  let paths = [];
  try {
    paths = parseSqQuoted(readFileSync(join(dir, "BISECT_NAMES"), "utf-8"));
  } catch {
    // no names
  }
  if (paths[0] === "--") paths = paths.slice(1);
  return { firstParent: existsSync(join(dir, "BISECT_FIRST_PARENT")), paths };
}

function revList(cwd, sc, extra, bad, good) {
  return runOk(cwd, [
    "rev-list",
    ...extra,
    ...(sc.firstParent ? ["--first-parent"] : []),
    bad,
    "--not",
    ...good,
    ...(sc.paths.length ? ["--", ...sc.paths] : []),
  ]);
}

/**
 * The bisect part of `/api/git-repo-state`: its state object, or null. `dir`
 * is the git dir the route already resolved: nothing is spawned when no
 * bisect is running. `step` counts the marks, as in the Rust command.
 */
export function devBisectRepoState(cwd, dir = gitDir(cwd)) {
  let log;
  try {
    log = readFileSync(join(dir, "BISECT_LOG"), "utf-8");
  } catch {
    return null;
  }
  // `--no-checkout` bisects move BISECT_HEAD, not HEAD.
  const head = headHash(cwd, existsSync(join(dir, "BISECT_HEAD")) ? "BISECT_HEAD" : "HEAD");
  return { state: "bisect", hasConflict: false, operationHead: head, targetBranch: null, step: bisectMarks(log), total: 0 };
}

/** The marks a BISECT_LOG records: its `git bisect <term> <hash>` lines (not `start`). */
export function bisectMarks(log) {
  return log.split("\n").filter((l) => l.startsWith("git bisect ") && !l.startsWith("git bisect start")).length;
}

/** The commit under test: HEAD, or BISECT_HEAD for `--no-checkout`. */
function underTest(cwd, dir) {
  return headHash(cwd, existsSync(join(dir, "BISECT_HEAD")) ? "BISECT_HEAD" : "HEAD");
}

export function devBisectStatus(cwd) {
  const dir = gitDir(cwd);
  const [badTerm, goodTerm] = terms(dir);
  // As in the Rust command: ended while a reload was on its way.
  if (!isBisecting(dir)) {
    return {
      active: false,
      current: null,
      start: null,
      bad: null,
      good: [],
      skipped: [],
      remaining: null,
      steps: null,
      candidates: [],
      terms: [badTerm, goodTerm],
      commits: [],
      pendingCheckout: false,
    };
  }
  let start = null;
  try {
    start = readFileSync(join(dir, "BISECT_START"), "utf-8").trim() || null;
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
    const sc = scope(dir);
    // As in the Rust command: `--bisect-vars` on an empty range exits 1 with
    // no output, which is no step left, not an error.
    let vars = null;
    try {
      vars = revList(cwd, sc, ["--bisect-vars"], bad, good);
    } catch (err) {
      if (revList(cwd, sc, ["--count"], bad, good).trim() !== "0") throw err;
    }
    const v = (k) => {
      const line = vars.split("\n").find((l) => l.startsWith(`${k}=`));
      const n = line ? Number(line.slice(k.length + 1).trim().replace(/'/g, "")) : NaN;
      return Number.isFinite(n) ? n : null;
    };
    steps = vars === null ? 0 : v("bisect_steps");
    // As in the Rust command: the range as git walks it, minus `bad` and the
    // skipped commits still inside it; listed only when there are skips.
    // `bad` is in it exactly when it tops a topo-ordered walk.
    const badInRange = revList(cwd, sc, ["--topo-order", "-n", "1"], bad, good).trim() === bad;
    let skippedInRange = [];
    let untested;
    if (skipped.length === 0) {
      const count = Number(revList(cwd, sc, ["--count"], bad, good).trim()) || 0;
      untested = Math.max(0, count - (badInRange ? 1 : 0));
    } else {
      const skips = new Set(skipped);
      const range = revList(cwd, sc, [], bad, good).split("\n").filter(Boolean);
      skippedInRange = range.filter((h) => h !== bad && skips.has(h));
      untested = range.length - skippedInRange.length - (badInRange ? 1 : 0);
    }
    remaining = untested;
    // An empty range with no skip is no result: nothing is named.
    if (untested === 0 && (badInRange || skippedInRange.length > 0)) candidates = [bad, ...skippedInRange];
  }
  // `--no-checkout` bisects move BISECT_HEAD, not HEAD.
  const current = underTest(cwd, dir);
  const marked = (h) => h === bad || good.includes(h) || skipped.includes(h);
  const pendingCheckout = candidates.length === 0 && remaining !== null && remaining > 0 && !!current && marked(current);
  const toDescribe = [...(current ? [current] : []), ...candidates.filter((c) => c !== current)];
  return {
    active: true,
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

/** A full object id: git reads it as an object, never as a hex-named ref. */
const isHash = (s) => typeof s === "string" && /^([0-9a-f]{40}|[0-9a-f]{64})$/i.test(s);

/** A rebase, merge, cherry-pick or revert in progress (what `git_repo_state` reports before bisect). */
function otherOperation(d) {
  return ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"].some((f) =>
    existsSync(join(d, f)),
  );
}

/** As in the Rust command; `keepOrder` ("Bisect from here") never swaps the ends. */
export function devBisectStart(cwd, bad, good, keepOrder = false) {
  if (!isHash(bad) || !isHash(good)) throw new Error("bisect:notHashes: A bisect starts from two full commit hashes.");
  // git prints object ids in lowercase: compare them as such.
  [bad, good] = [bad.toLowerCase(), good.toLowerCase()];
  const dir = gitDir(cwd);
  if (otherOperation(dir) || isBisecting(dir)) {
    throw new Error("bisect:busy: Another operation is in progress; finish it before starting a bisect.");
  }
  if (runOk(cwd, ["status", "--porcelain", "--untracked-files=no"]).trim()) {
    throw new Error("bisect:dirty: Commit or stash your uncommitted changes before starting a bisect.");
  }
  // The ancestor is the good end, whichever way they are passed. Exit 1 is
  // "no"; anything else (an unknown or ambiguous hash) is git's error.
  const isAncestor = (a, b) => {
    const r = run(cwd, ["merge-base", "--is-ancestor", a, b]);
    if (r.status === 0) return true;
    if (r.status === 1) return false;
    throw new Error((r.stderr || "").trim() || `git could not compare ${a} and ${b}`);
  };
  // As in the Rust command: "Bisect from here" names HEAD as the bad end.
  if (keepOrder && headHash(cwd) !== bad) {
    throw new Error("bisect:headMoved: HEAD has moved since the Git Tree was loaded.");
  }
  if (!isAncestor(good, bad)) {
    if (keepOrder) throw new Error("bisect:notInHead: The good commit is not in the history of the bad one.");
    if (!isAncestor(bad, good)) {
      throw new Error(
        "bisect:unrelated: One of the two commits must be an ancestor of the other: they are on separate branches.",
      );
    }
    [bad, good] = [good, bad];
  }
  runOk(cwd, ["bisect", "start", bad, good]);
  return devBisectStatus(cwd);
}

/** As in the Rust command; `expected` is the commit the user answered for. */
export function devBisectMark(cwd, verdict, expected = null) {
  const dir = gitDir(cwd);
  const [badTerm, goodTerm] = terms(dir);
  const term = verdict === "good" ? goodTerm : verdict === "bad" ? badTerm : verdict === "skip" || verdict === "next" ? verdict : null;
  if (!term) throw new Error(`bisect:verdict: Unknown bisect verdict: ${verdict}`);
  if (!isBisecting(dir)) throw new Error("bisect:notBisecting: No bisect is in progress.");
  // As in the Rust command: any string is checked (an empty one too), only
  // null or absent skips the check.
  if (expected != null && verdict !== "next" && underTest(cwd, dir) !== String(expected).toLowerCase()) {
    throw new Error("bisect:moved: The commit under test has changed since it was shown.");
  }
  try {
    runOk(cwd, ["bisect", term]);
  } catch (err) {
    // As in the Rust command: only skipped commits left is a result, and a
    // status that cannot be read does not hide git's own error.
    let st;
    try {
      st = devBisectStatus(cwd);
    } catch {
      throw err;
    }
    if (st.candidates.length === 0) throw err;
    return st;
  }
  return devBisectStatus(cwd);
}

/** As in the Rust command; `stay` ends it on the current commit. */
export function devBisectReset(cwd, stay = false) {
  runOk(cwd, stay ? ["bisect", "reset", "HEAD"] : ["bisect", "reset"]);
  if (isBisecting(gitDir(cwd))) throw new Error("bisect:resetFailed: git could not end the bisect.");
}
