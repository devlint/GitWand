#!/usr/bin/env node
/**
 * replay-conflicts.mjs — measure the real-world hit-rate of resolution patterns.
 *
 * Replays a repo's historical merges with `git merge-tree --write-tree`
 * (conflictstyle=diff3), feeds every conflicted file through @gitwand/core's
 * resolve(), and aggregates stats.byType + summarizeTiers() across all hunks.
 *
 * Purpose (PR #117): decide token_level_merge's fate on data — does it capture
 * a measurable share of the residual on real conflicts, or is it dead weight?
 *
 * Usage:
 *   node scripts/replay-conflicts.mjs <repo-path> [--max-merges N] [--refactoring] [--json]
 *
 * Notes:
 * - Requires git >= 2.38 (merge-tree --write-tree).
 * - diff3 is forced: this measures pattern *potential*, matching the desktop
 *   flow where base recovery enriches 2-way conflicts before classification.
 * - merge-tree writes unreferenced tree/blob objects into the repo's odb;
 *   they're garbage-collectable, no ref is created.
 */

import { execFileSync } from "node:child_process";
import { resolve as gwResolve, summarizeTiers } from "../packages/core/dist/index.js";

// ─── args ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const repo = args.find((a) => !a.startsWith("--"));
if (!repo) {
  console.error("usage: node scripts/replay-conflicts.mjs <repo-path> [--max-merges N] [--refactoring] [--json]");
  process.exit(2);
}
const maxMergesIdx = args.indexOf("--max-merges");
const MAX_MERGES = maxMergesIdx !== -1 ? Number(args[maxMergesIdx + 1]) : 500;
const WITH_REFACTORING = args.includes("--refactoring");
const AS_JSON = args.includes("--json");

const MAX_FILE_BYTES = 1_000_000; // skip huge files
const SKIP_EXT = new Set(["png", "jpg", "jpeg", "gif", "ico", "woff", "woff2", "ttf", "eot", "pdf", "zip", "gz", "jar", "min.js", "min.css"]);

// ─── git helpers ─────────────────────────────────────────────────────────────

function git(cmd, opts = {}) {
  return execFileSync("git", ["-C", repo, ...cmd], {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
}

let mergeTreeErrors = 0;

/** merge-tree exits 1 on conflict — capture that case without throwing. */
function mergeTree(p1, p2) {
  try {
    git(["-c", "merge.conflictstyle=diff3", "merge-tree", "--write-tree", "--name-only", p1, p2], { stdio: ["ignore", "pipe", "ignore"] });
    return null; // exit 0 → clean merge
  } catch (err) {
    if (err.status === 1 && typeof err.stdout === "string") {
      // <tree-oid>\n<conflicted files…>\n\n<informational messages>
      const [head] = err.stdout.split("\n\n");
      const lines = head.split("\n").filter(Boolean);
      return { treeOid: lines[0], files: lines.slice(1) };
    }
    // Anything else (sandbox denial, missing objects, usage error) is NOT a
    // clean merge — count it so a systematic failure can't masquerade as
    // "zero conflicts in this repo".
    mergeTreeErrors++;
    if (mergeTreeErrors <= 3) {
      console.error(`[warn] merge-tree failed (exit ${err.status}) for ${p1.slice(0, 8)}..${p2.slice(0, 8)}`);
    }
    return null;
  }
}

// ─── replay ──────────────────────────────────────────────────────────────────

const merges = git(["rev-list", "--merges", `--max-count=${MAX_MERGES}`, "HEAD"])
  .split("\n").filter(Boolean);

const byType = {};
const tokenLevelExamples = [];
const refactoringExamples = [];
let mergesWithConflicts = 0;
let conflictedFiles = 0;
let skippedFiles = 0;
let resolveErrors = 0;
let totalHunks = 0;

const resolveOptions = WITH_REFACTORING ? { refactoringAware: { enabled: true } } : {};

for (const m of merges) {
  const parents = git(["rev-list", "--parents", "-n", "1", m]).trim().split(" ").slice(1);
  if (parents.length !== 2) continue; // skip octopus

  const conflict = mergeTree(parents[0], parents[1]);
  if (!conflict) continue;
  mergesWithConflicts++;

  for (const path of new Set(conflict.files)) {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    if (SKIP_EXT.has(ext)) { skippedFiles++; continue; }

    let content;
    try {
      content = git(["show", `${conflict.treeOid}:${path}`]);
    } catch { skippedFiles++; continue; } // deleted/rename conflict → no blob at path

    if (content.length > MAX_FILE_BYTES || content.includes("\0")) { skippedFiles++; continue; }
    if (!content.includes("<<<<<<<")) { skippedFiles++; continue; } // modify/delete etc.

    conflictedFiles++;
    let result;
    try {
      result = gwResolve(content, path, resolveOptions);
    } catch { resolveErrors++; continue; }

    totalHunks += result.stats.totalConflicts;
    for (const [type, count] of Object.entries(result.stats.byType)) {
      byType[type] = (byType[type] ?? 0) + count;
    }
    for (const hunk of result.hunks) {
      if (hunk.type === "token_level_merge" && tokenLevelExamples.length < 25) {
        tokenLevelExamples.push({ merge: m.slice(0, 10), path, line: hunk.startLine });
      }
      if (hunk.type === "refactoring_aware_merge" && refactoringExamples.length < 25) {
        refactoringExamples.push({ merge: m.slice(0, 10), path, line: hunk.startLine });
      }
    }
  }
}

// ─── report ──────────────────────────────────────────────────────────────────

const tiers = summarizeTiers(byType);
const report = {
  repo,
  mergesScanned: merges.length,
  mergeTreeErrors,
  mergesWithConflicts,
  conflictedFiles,
  skippedFiles,
  resolveErrors,
  totalHunks,
  byType: Object.fromEntries(Object.entries(byType).sort((a, b) => b[1] - a[1])),
  tiers,
  refactoringAwareEnabled: WITH_REFACTORING,
  tokenLevelExamples,
  ...(WITH_REFACTORING ? { refactoringExamples } : {}),
};

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`\n═══ ${repo} ═══`);
  console.log(`merges scanned:        ${report.mergesScanned}${mergeTreeErrors ? `  (⚠ ${mergeTreeErrors} merge-tree errors — results may undercount)` : ""}`);
  console.log(`merges w/ conflicts:   ${report.mergesWithConflicts}`);
  console.log(`conflicted files:      ${report.conflictedFiles} (skipped: ${report.skippedFiles}, resolve errors: ${report.resolveErrors})`);
  console.log(`total hunks:           ${report.totalHunks}`);
  console.log(`\nbyType:`);
  for (const [type, count] of Object.entries(report.byType)) {
    const pct = totalHunks ? ((count / totalHunks) * 100).toFixed(1) : "0.0";
    console.log(`  ${type.padEnd(26)} ${String(count).padStart(6)}  (${pct}%)`);
  }
  console.log(`\ntiers: trivial=${tiers.byTier.trivial} advancedDeterministic=${tiers.byTier.advancedDeterministic} model=${tiers.byTier.model} unresolved=${tiers.byTier.unresolved}`);
  console.log(`residual=${tiers.residual} aiReachable=${tiers.aiReachable} recoverable-before-model=${(tiers.recoverableBeforeModel * 100).toFixed(1)}%`);
  if (tokenLevelExamples.length) {
    console.log(`\ntoken_level_merge examples (${tokenLevelExamples.length} shown):`);
    for (const ex of tokenLevelExamples) console.log(`  ${ex.merge}  ${ex.path}:${ex.line}`);
  } else {
    console.log(`\ntoken_level_merge: ZERO hits on this corpus.`);
  }
}
