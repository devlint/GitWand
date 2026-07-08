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
const WITH_ECHO = args.includes("--echo");
const WITH_LISTS = args.includes("--lists");
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

// ─── cherry-pick-echo opportunity signals (--echo) ───────────────────────────
//
// Sizing pass for a future deterministic `cherry_pick_echo` recoverer: how much
// of the `complex` residual involves a change that ALREADY EXISTS on the other
// side's history?
//
// Signal 1 (merge-level): `git cherry` patch-id equivalence between the two
// parents' exclusive commits — commits cherry-picked (or rebased) across both
// sides. We record which conflicted files those echo commits touched.
//
// Signal 2 (hunk-level): a complex hunk whose ours-block appears VERBATIM
// somewhere in the other parent's version of the file (or theirs-block in
// ours' version) — the "conflicting" content is already present on the other
// side (moved, duplicated, or cherry-picked then shifted).

const ECHO_MAX_EXCLUSIVE = 500; // skip echo analysis on merges with huge exclusive sets
const ECHO_MIN_BLOCK_CHARS = 20;

/** Shas of commits on `tip`'s exclusive side that are patch-id-equivalent to one on `other`. */
function echoShas(tip, other) {
  const count = Number(git(["rev-list", "--count", "--no-merges", tip, `^${other}`]).trim());
  if (count === 0 || count > ECHO_MAX_EXCLUSIVE) return { shas: [], skipped: count > ECHO_MAX_EXCLUSIVE };
  const out = git(["cherry", other, tip]);
  const shas = out.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim());
  return { shas, skipped: false };
}

/** Files touched by a commit. */
function commitFiles(sha) {
  try {
    return git(["diff-tree", "--no-commit-id", "--name-only", "-r", sha]).split("\n").filter(Boolean);
  } catch { return []; }
}

/** Set of conflicted files touched by at least one patch-id-echoed commit on either side. */
function echoTouchedFiles(p1, p2, conflictedFiles) {
  const a = echoShas(p1, p2);
  const b = echoShas(p2, p1);
  const result = { files: new Set(), echoPairs: a.shas.length + b.shas.length, skipped: a.skipped || b.skipped };
  if (result.echoPairs === 0) return result;
  const conflictSet = new Set(conflictedFiles);
  for (const sha of [...a.shas, ...b.shas].slice(0, 50)) {
    for (const f of commitFiles(sha)) {
      if (conflictSet.has(f)) result.files.add(f);
    }
  }
  return result;
}

/** Does `block` (joined lines) appear verbatim in parent's version of the file? */
function blockPresentIn(parent, path, blockLines) {
  const block = blockLines.join("\n").trim();
  if (block.length < ECHO_MIN_BLOCK_CHARS || blockLines.filter((l) => l.trim()).length < 2) return false;
  try {
    const content = git(["show", `${parent}:${path}`], { stdio: ["ignore", "pipe", "ignore"] });
    return content.includes(block);
  } catch { return false; }
}

// ─── commutative-list opportunity heuristic (--lists) ────────────────────────
//
// Sizing pass for a grammar-driven commutative-list merge (Mergiraf-style):
// among `complex` hunks, how many are "list-shaped" — every non-blank line on
// both sides looks like an element of an order-insensitive collection (array
// items, object/map entries, import/use statements, enum variants)? Those are
// the hunks a commutative set-merge could take deterministically where line-
// based LCS fails (same insertion point, trailing-comma drift, reorder+add).

const RE_LIST_LINE = [
  /,\s*$/,                                    // trailing comma (array/object item)
  /^\s*(?:import|use|from|export)\b/,         // import-like statement
  /^\s*['"@\w$-]+\s*:\s*.+[,;]?\s*$/,         // key: value entry
  /^\s*['"][^'"]*['"],?\s*$/,                 // bare string item
  /^\s*[\w$.]+\s*(?:::\w+)?,?\s*$/,           // bare identifier / enum variant
];

function isListShaped(lines) {
  const content = lines.filter((l) => l.trim() !== "");
  if (content.length === 0) return false;
  return content.every((l) => RE_LIST_LINE.some((re) => re.test(l)));
}

/** Multiset difference a ∖ b on trimmed lines. */
function multisetDiff(a, b) {
  const count = new Map();
  for (const l of b) { const t = l.trim(); count.set(t, (count.get(t) ?? 0) + 1); }
  const out = [];
  for (const l of a) {
    const t = l.trim();
    const n = count.get(t) ?? 0;
    if (n > 0) count.set(t, n - 1);
    else out.push(t);
  }
  return out;
}

/**
 * List-shaped hunk provably mergeable at LINE granularity: no base line was
 * removed/modified by BOTH sides (a modified item = removed base line + added
 * variant, so a shared removal means both sides touched the same item — that
 * needs key-aware logic or stays a conflict).
 */
function isLineMergeable(base, ours, theirs) {
  if (base.length === 0) return false;
  const oursRemoved = multisetDiff(base, ours);
  const theirsRemoved = multisetDiff(base, theirs);
  const theirsRemovedSet = new Set(theirsRemoved);
  return !oursRemoved.some((l) => theirsRemovedSet.has(l));
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

// --lists accumulators
let listComplexHunks = 0;
let listLineMergeable = 0;
let listTotalComplex = 0;
const listExamples = [];

// --echo accumulators
let complexHunks = 0;
let complexInEchoFiles = 0;
let complexContentOnOtherSide = 0;
let complexEitherSignal = 0;
let mergesWithEchoPairs = 0;
let echoSkippedMerges = 0;
const echoExamples = [];

for (const m of merges) {
  const parents = git(["rev-list", "--parents", "-n", "1", m]).trim().split(" ").slice(1);
  if (parents.length !== 2) continue; // skip octopus

  const conflict = mergeTree(parents[0], parents[1]);
  if (!conflict) continue;
  mergesWithConflicts++;

  let echoInfo = null;
  if (WITH_ECHO) {
    echoInfo = echoTouchedFiles(parents[0], parents[1], conflict.files);
    if (echoInfo.echoPairs > 0) mergesWithEchoPairs++;
    if (echoInfo.skipped) echoSkippedMerges++;
  }

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
      if (WITH_LISTS && hunk.type === "complex") {
        listTotalComplex++;
        if (isListShaped(hunk.oursLines) && isListShaped(hunk.theirsLines)) {
          listComplexHunks++;
          const mergeable = isLineMergeable(hunk.baseLines, hunk.oursLines, hunk.theirsLines);
          if (mergeable) listLineMergeable++;
          if (listExamples.length < 20) listExamples.push({ merge: m.slice(0, 10), path, line: hunk.startLine, mergeable });
        }
      }
      if (WITH_ECHO && hunk.type === "complex") {
        complexHunks++;
        const inEchoFile = echoInfo !== null && echoInfo.files.has(path);
        // ours block present in theirs' parent version, or theirs block in ours'
        const contentEcho =
          blockPresentIn(parents[1], path, hunk.oursLines) ||
          blockPresentIn(parents[0], path, hunk.theirsLines);
        if (inEchoFile) complexInEchoFiles++;
        if (contentEcho) complexContentOnOtherSide++;
        if (inEchoFile || contentEcho) {
          complexEitherSignal++;
          if (echoExamples.length < 20) {
            echoExamples.push({ merge: m.slice(0, 10), path, line: hunk.startLine, signals: `${inEchoFile ? "patch-id " : ""}${contentEcho ? "content" : ""}`.trim() });
          }
        }
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
  ...(WITH_ECHO ? {
    echo: {
      complexHunks,
      complexInEchoFiles,
      complexContentOnOtherSide,
      complexEitherSignal,
      mergesWithEchoPairs,
      echoSkippedMerges,
      examples: echoExamples,
    },
  } : {}),
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
  if (WITH_LISTS) {
    const lpct = (n) => listTotalComplex ? ((n / listTotalComplex) * 100).toFixed(1) : "0.0";
    console.log(`\n─── commutative-list opportunity ───`);
    console.log(`complex hunks list-shaped:       ${listComplexHunks}/${listTotalComplex}  (${lpct(listComplexHunks)}%)`);
    console.log(`  ├─ line-mergeable (disjoint):  ${listLineMergeable}  (${lpct(listLineMergeable)}%)`);
    console.log(`  └─ same-item touched (key-aware needed): ${listComplexHunks - listLineMergeable}`);
    if (listExamples.length) {
      for (const ex of listExamples) console.log(`  ${ex.merge}  ${ex.path}:${ex.line}  ${ex.mergeable ? "[mergeable]" : "[same-item]"}`);
    }
  }
  if (WITH_ECHO) {
    const pct = (n) => complexHunks ? ((n / complexHunks) * 100).toFixed(1) : "0.0";
    console.log(`\n─── cherry-pick-echo opportunity (complex hunks: ${complexHunks}) ───`);
    console.log(`merges w/ patch-id echo pairs:   ${mergesWithEchoPairs}/${report.mergesWithConflicts}${echoSkippedMerges ? ` (${echoSkippedMerges} skipped, exclusive set > ${ECHO_MAX_EXCLUSIVE})` : ""}`);
    console.log(`complex in echo-touched files:   ${complexInEchoFiles}  (${pct(complexInEchoFiles)}%)`);
    console.log(`complex content on other side:   ${complexContentOnOtherSide}  (${pct(complexContentOnOtherSide)}%)`);
    console.log(`complex w/ either signal:        ${complexEitherSignal}  (${pct(complexEitherSignal)}%)`);
    if (echoExamples.length) {
      console.log(`examples:`);
      for (const ex of echoExamples) console.log(`  ${ex.merge}  ${ex.path}:${ex.line}  [${ex.signals}]`);
    }
  }
}
