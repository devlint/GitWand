#!/usr/bin/env node
/**
 * replay-regenerate.mjs — measure whether REAL regeneration (accuracy lot D,
 * task 4) reproduces the lockfile a team actually committed, on historical
 * merges from a real, already-cloned corpus repo.
 *
 * Why this is a separate script from scripts/replay-conflicts.mjs /
 * benchmark/run.mjs: those replay merges purely with `git merge-tree
 * --write-tree`, which never touches a working tree — there is no way to
 * measure "does `npm install --package-lock-only` reproduce this lockfile"
 * without an actual checkout and an actual install. See the task-4 brief
 * (.superpowers/sdd/2026-08-26-regenerate-tier/task-4-brief.md), § "Measurement".
 *
 * Two-stage approach (same shape as replay-conflicts.mjs's mergeTree() reuse):
 *   1. CHEAP — `git merge-tree --write-tree` (diff3) over up to --max-merges
 *      historical merges, to find CANDIDATES: merges whose conflict set
 *      includes a v1-registry lockfile (packages/core/src/regenerate/registry.ts).
 *      No checkout, no network beyond having the repo already cloned.
 *   2. EXPENSIVE — for up to --max-real candidates PER ECOSYSTEM (the plan's
 *      own "≤20 merges per ecosystem" ceiling — default here matches it):
 *        a. resolve the ecosystem's sourcesOfTruth (package.json/composer.json)
 *           from the merge-tree result — either it merged clean, or
 *           @gitwand/core's resolve() settles it; a still-conflicted source
 *           makes the plan non-runnable (buildRegenerationPlan), same as the
 *           real CLI decides in commands/resolve.ts.
 *        b. build a `RegenerationPlan` and, if runnable, run the EXACT same
 *           executor the CLI uses in production — `runRegeneration` from
 *           packages/cli/dist/regenerate-runner.js (disposable git worktree,
 *           script-suppression flags baked into the registry command, wall-clock
 *           timeout, env allowlist). Reused rather than reimplemented so this
 *           measurement reflects the real execution path, not a stand-in.
 *        c. compare the regenerated lockfile against the ACTUAL committed one
 *           (`git show <merge-sha>:<lockfile-path>`) via structuralMatch()
 *           (scripts/lib/regenerate-compare.mjs).
 *
 * Bounded, network-required (real `npm install`/`composer update` calls) →
 * this script does NOT run in CI, same as replay-conflicts.mjs/benchmark/run.mjs
 * — it is an operator-run tool. See benchmark/README.md for the method write-up
 * and results.
 *
 * Design choice on WORKTREE SOURCE: `runRegeneration` always worktrees from
 * `repoRoot`'s current HEAD (that is correct for the real CLI, where HEAD
 * *is* the in-progress merge's target branch). To reproduce a specific
 * historical merge here, this script points `repoRoot`'s HEAD at that merge's
 * first parent (the "ours"/target side — matching the v3.10 merge-context
 * convention used throughout the benchmark, see replay-conflicts.mjs) right
 * before invoking it, and restores the original HEAD when done.
 *
 * Final review Finding 5 — `<repo-path>` MUST be a bare repository. An
 * earlier revision of this comment claimed "can be bare or non-bare", which
 * was wrong: `git update-ref HEAD <sha>` follows the symref — on a non-bare
 * repo with a branch checked out, it silently rewrites THAT branch's ref,
 * not just a detached state. This script refuses to run against a non-bare
 * repo (`git rev-parse --is-bare-repository`) before it ever moves HEAD.
 * It also restores the operator's original HEAD from a `SIGINT`/`SIGTERM`
 * handler, not just the happy-path tail of the script — a Ctrl-C mid-sweep
 * (the natural way an operator aborts a real multi-minute install run)
 * would otherwise leave HEAD reset to a historical commit while the
 * index/worktree still hold newer state, an easy silent-loss trap for
 * whatever the operator commits there next.
 *
 * Usage:
 *   node scripts/replay-regenerate.mjs <repo-path> [--max-merges N] \
 *     [--max-real N] [--ecosystem npm,composer] [--timeout-ms N] [--json]
 *
 * <repo-path> must already be a local clone with the corpus commit reachable
 * (bare+blobless, pinned to the corpus SHA, is the recommended shape — see
 * benchmark/run.mjs's prepare() for the exact recipe; this script does not
 * clone for you, same separation of concerns as replay-conflicts.mjs).
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import {
  resolve as gwResolve,
  findEcosystem,
  buildRegenerationPlan,
} from "../packages/core/dist/index.js";
import { runRegeneration } from "../packages/cli/dist/regenerate-runner.js";
import { structuralMatch } from "./lib/regenerate-compare.mjs";
import { seedScratchIndex } from "./lib/seed-index.mjs";

// ─── args ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const repo = args.find((a) => !a.startsWith("--"));
if (!repo) {
  console.error(
    "usage: node scripts/replay-regenerate.mjs <repo-path> [--max-merges N] [--max-real N] [--ecosystem npm,composer] [--timeout-ms N] [--json]",
  );
  process.exit(2);
}
const flagValue = (name) => {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
};
const MAX_MERGES = Number(flagValue("--max-merges") ?? 500);
// The plan's own bound (task-4 brief checklist): "≤ 20 merges per ecosystem".
const MAX_REAL_PER_ECOSYSTEM = Number(flagValue("--max-real") ?? 20);
const ECOSYSTEM_FILTER = flagValue("--ecosystem") ? new Set(flagValue("--ecosystem").split(",")) : null;
const TIMEOUT_MS_OVERRIDE = flagValue("--timeout-ms") ? Number(flagValue("--timeout-ms")) : undefined;
const AS_JSON = args.includes("--json");
const MAX_EXAMPLES = 15;

// ─── git helpers (mirrors replay-conflicts.mjs) ─────────────────────────────

function git(cmd, opts = {}) {
  return execFileSync("git", ["-C", repo, ...cmd], {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
}

// ─── Finding 5 (final review) — bare-repo guard, before ANYTHING moves HEAD ─
//
// `git update-ref HEAD <sha>` follows the symref: on a non-bare repo with a
// branch checked out, it silently rewrites that branch's ref, not merely a
// detached-HEAD state. Refuse outright rather than risk a real branch.
function isBareRepo() {
  try {
    return git(["rev-parse", "--is-bare-repository"]).trim() === "true";
  } catch {
    return false;
  }
}

if (!isBareRepo()) {
  console.error(
    `refusing to run: "${repo}" is not a bare repository.\n` +
      `This script moves HEAD (git update-ref HEAD <historical-sha>) to replay each\n` +
      `candidate merge. On a non-bare repo with a branch checked out, that silently\n` +
      `rewrites the checked-out branch's ref, not just a detached state — this could\n` +
      `reset a real branch to a historical commit.\n` +
      `Re-clone as bare (+blobless, pinned to the corpus SHA — see benchmark/run.mjs's\n` +
      `prepare() for the exact recipe) and re-run against that clone instead.`,
  );
  process.exit(2);
}

// ─── Finding 5 (final review) — restore the operator's HEAD on Ctrl-C too ───
//
// Captured immediately (before stage 1/2 do any work) so a SIGINT/SIGTERM at
// ANY point — including mid-sweep, the natural way an operator aborts a real
// multi-minute install run — can always restore it, not just the happy-path
// tail of the script.
const originalHead = git(["rev-parse", "HEAD"]).trim();
let exitingViaSignal = false;

function restoreHeadAndExit(signal) {
  if (exitingViaSignal) return; // a second signal while we're already cleaning up
  exitingViaSignal = true;
  try {
    git(["update-ref", "HEAD", originalHead]);
    console.error(`\n[replay-regenerate] ${signal} received — restored HEAD to ${originalHead.slice(0, 10)} before exiting.`);
  } catch (err) {
    console.error(
      `\n[replay-regenerate] ${signal} received — FAILED to restore HEAD to ${originalHead.slice(0, 10)}: ` +
        `${err instanceof Error ? err.message : String(err)}. Fix "${repo}"'s HEAD manually before reusing this clone.`,
    );
  }
  process.exit(130);
}
process.on("SIGINT", () => restoreHeadAndExit("SIGINT"));
process.on("SIGTERM", () => restoreHeadAndExit("SIGTERM"));

let mergeTreeErrors = 0;

/** merge-tree exits 1 on conflict — capture that case without throwing. Same
 * pattern as replay-conflicts.mjs's mergeTree(): DO NOT throw on conflict. */
function mergeTree(p1, p2) {
  try {
    git(["-c", "merge.conflictstyle=diff3", "merge-tree", "--write-tree", "--name-only", p1, p2], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    return null; // exit 0 → clean merge, no lockfile conflict possible
  } catch (err) {
    if (err.status === 1 && typeof err.stdout === "string") {
      const [head] = err.stdout.split("\n\n");
      const lines = head.split("\n").filter(Boolean);
      return { treeOid: lines[0], files: lines.slice(1) };
    }
    mergeTreeErrors++;
    return null;
  }
}

/** Repo-tree-relative file read via `git show <tree>:<path>`; null if absent. */
function readTreePath(treeOid, path) {
  try {
    return git(["show", `${treeOid}:${path}`], { stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

// v3.10 convention (replay-conflicts.mjs) — the first parent of a replayed
// merge commit IS the target branch; version-identity scalars stay "ours".
const MERGE_CONTEXT = { operation: "merge", targetSide: "ours" };
const resolveOptions = { mergeContext: MERGE_CONTEXT };

/**
 * Settle one sourceOfTruth path's state from the merge-tree result — exactly
 * the three states `RegenerationPlan.sources[].state` models:
 *   - "clean": no conflict markers in the merge-tree result for this path.
 *   - "resolved": conflicted, but @gitwand/core's resolve() fully settles it
 *     (mirrors commands/resolve.ts's `stats.remaining === 0` bar exactly).
 *   - "conflicted": still has unresolved conflicts, or the path is absent
 *     from the merge-tree result (renamed/deleted) — unknown state is unsafe.
 */
function resolveSource(treeOid, path) {
  const content = readTreePath(treeOid, path);
  if (content === null) return { state: "conflicted", content: null };
  if (!content.includes("<<<<<<<")) return { state: "clean", content };
  let result;
  try {
    result = gwResolve(content, path, resolveOptions);
  } catch {
    return { state: "conflicted", content: null };
  }
  if (result.mergedContent !== null && result.stats.remaining === 0) {
    return { state: "resolved", content: result.mergedContent };
  }
  return { state: "conflicted", content: null };
}

// ─── stage 1: cheap candidate discovery ─────────────────────────────────────

const merges = git(["rev-list", "--merges", `--max-count=${MAX_MERGES}`, "HEAD"]).split("\n").filter(Boolean);

/** @type {Map<string, Array<{sha:string, parents:string[], lockfilePath:string, treeOid:string, ecosystem:object}>>} */
const candidatesByEcosystem = new Map();
let mergesScanned = 0;

for (const m of merges) {
  mergesScanned++;
  let parents;
  try {
    parents = git(["rev-list", "--parents", "-n", "1", m]).trim().split(" ").slice(1);
  } catch {
    continue;
  }
  if (parents.length !== 2) continue; // skip octopus merges

  const conflict = mergeTree(parents[0], parents[1]);
  if (!conflict) continue;

  for (const path of new Set(conflict.files)) {
    const ecosystem = findEcosystem(path);
    if (!ecosystem) continue;
    if (ECOSYSTEM_FILTER && !ECOSYSTEM_FILTER.has(ecosystem.id)) continue;
    if (!candidatesByEcosystem.has(ecosystem.id)) candidatesByEcosystem.set(ecosystem.id, []);
    candidatesByEcosystem.get(ecosystem.id).push({
      sha: m,
      parents,
      lockfilePath: path,
      treeOid: conflict.treeOid,
      ecosystem,
    });
  }
}

// ─── stage 2: expensive real regeneration, bounded per ecosystem ───────────
// (`originalHead` was already captured above, before stage 1, so the
// SIGINT/SIGTERM handler can restore it even if interrupted during stage 1.)

const perEcosystem = {};

for (const [ecosystemId, allCandidates] of candidatesByEcosystem) {
  const candidates = allCandidates.slice(0, MAX_REAL_PER_ECOSYSTEM);
  const report = {
    ecosystem: ecosystemId,
    candidatesFound: allCandidates.length,
    attempted: candidates.length,
    outcomes: {}, // kind -> count
    runnablePlans: 0,
    ran: 0, // regeneration command actually exited 0
    comparable: 0, // both regenerated + actual committed content available
    matched: 0,
    examples: [],
  };
  perEcosystem[ecosystemId] = report;

  const bump = (kind) => {
    report.outcomes[kind] = (report.outcomes[kind] ?? 0) + 1;
  };

  for (const candidate of candidates) {
    try {
      const siblingFiles = {};
      const resolvedContents = {};
      for (const path of candidate.ecosystem.sourcesOfTruth) {
        const r = resolveSource(candidate.treeOid, path);
        siblingFiles[path] = { state: r.state };
        if (r.content !== null) resolvedContents[path] = r.content;
      }
      const plan = buildRegenerationPlan(candidate.lockfilePath, candidate.ecosystem, { siblingFiles });

      if (!plan.runnable) {
        bump("not-runnable");
        continue;
      }
      report.runnablePlans++;

      const resolvedSources = plan.sources.map((s) => ({ path: s.path, content: resolvedContents[s.path] }));

      // Point the corpus repo's HEAD at this merge's target side (first
      // parent) so `runRegeneration`'s `git worktree add --detach <dir> HEAD`
      // reproduces the right commit — see module doc.
      git(["update-ref", "HEAD", candidate.parents[0]]);

      // Follow-up plan ("merge-index seeding"): seed the disposable worktree
      // from the ACTUAL 3-way merge result — the tree `merge-tree
      // --write-tree` already computed during candidate discovery
      // (`candidate.treeOid`) — not just `candidate.parents[0]`'s bare HEAD.
      // A scratch index is a throwaway file; it never touches this corpus
      // repo's own index.
      const seedIndexFile = join(tmpdir(), `gitwand-replay-index-${randomUUID()}`);
      seedScratchIndex(repo, candidate.treeOid, seedIndexFile);

      let regenOutcome;
      try {
        regenOutcome = await runRegeneration({
          repoRoot: repo,
          file: candidate.lockfilePath,
          ecosystem: candidate.ecosystem,
          resolvedSources,
          timeoutMs: TIMEOUT_MS_OVERRIDE,
          seedIndexFile,
        });
      } finally {
        await rm(seedIndexFile, { force: true });
      }

      bump(regenOutcome.kind);

      if (regenOutcome.kind !== "success" || regenOutcome.content === null) {
        if (report.examples.length < MAX_EXAMPLES) {
          report.examples.push({
            merge: candidate.sha.slice(0, 10),
            path: candidate.lockfilePath,
            outcome: regenOutcome.kind,
            reason: regenOutcome.reason,
          });
        }
        continue;
      }
      report.ran++;

      let actual;
      try {
        actual = git(["show", `${candidate.sha}:${candidate.lockfilePath}`], {
          stdio: ["ignore", "pipe", "ignore"],
        });
      } catch {
        bump("actual-unavailable");
        continue;
      }

      report.comparable++;
      const cmp = structuralMatch(ecosystemId, actual, regenOutcome.content);
      if (cmp.match) report.matched++;
      if (report.examples.length < MAX_EXAMPLES) {
        report.examples.push({
          merge: candidate.sha.slice(0, 10),
          path: candidate.lockfilePath,
          outcome: regenOutcome.kind,
          match: cmp.match,
          method: cmp.method,
          durationMs: regenOutcome.trace.durationMs,
        });
      }
    } catch (err) {
      // Offline/partial-clone/worktree failures must not crash the whole
      // run — skip this one candidate and keep going (task-4 brief: "Offline
      // is a first-class path").
      bump("error");
      if (report.examples.length < MAX_EXAMPLES) {
        report.examples.push({
          merge: candidate.sha.slice(0, 10),
          path: candidate.lockfilePath,
          outcome: "error",
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  report.agreementRate = report.comparable ? Number(((report.matched / report.comparable) * 100).toFixed(1)) : null;
}

// Restore HEAD exactly as found — this script mutates a shared ref on the
// caller-supplied clone (like benchmark/run.mjs's prepare() does at the start
// of a run); leave it pointed where the caller expects afterwards.
try {
  git(["update-ref", "HEAD", originalHead]);
} catch {
  // best-effort
}

// ─── report ──────────────────────────────────────────────────────────────────

const report = {
  repo,
  mergesScanned,
  mergeTreeErrors,
  maxMerges: MAX_MERGES,
  maxRealPerEcosystem: MAX_REAL_PER_ECOSYSTEM,
  perEcosystem,
};

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`\n═══ ${repo} — regenerate-tier replay ═══`);
  console.log(`merges scanned (cheap stage): ${mergesScanned}${mergeTreeErrors ? `  (⚠ ${mergeTreeErrors} merge-tree errors)` : ""}`);
  for (const eco of Object.values(perEcosystem)) {
    console.log(`\n─── ${eco.ecosystem} ───`);
    console.log(`candidates found:      ${eco.candidatesFound}  (attempted: ${eco.attempted}, cap ${MAX_REAL_PER_ECOSYSTEM}/ecosystem)`);
    console.log(`runnable plans:        ${eco.runnablePlans}`);
    console.log(`ran successfully:      ${eco.ran}`);
    console.log(`comparable:            ${eco.comparable}`);
    console.log(`structural match:      ${eco.matched}  (${eco.agreementRate === null ? "n/a" : eco.agreementRate + "%"})`);
    console.log(`outcomes:              ${JSON.stringify(eco.outcomes)}`);
    if (eco.examples.length) {
      console.log(`examples:`);
      for (const ex of eco.examples) {
        console.log(`  ${ex.merge}  ${ex.path}  ${ex.outcome}${"match" in ex ? `  match=${ex.match}` : ""}${ex.reason ? `  — ${ex.reason}` : ""}`);
      }
    }
  }
}
