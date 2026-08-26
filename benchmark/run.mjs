#!/usr/bin/env node
/**
 * benchmark/run.mjs — reproducible hit-rate measurement across a pinned corpus.
 *
 * Prepares each repository from corpus.json as a bare, blobless clone pinned to
 * an exact SHA, replays its historical merges through scripts/replay-conflicts.mjs,
 * and aggregates the per-repo reports into one result file.
 *
 * Why bare + blobless + pinned:
 *  - bare: replay-conflicts only ever reads the object graph (rev-list, merge-tree,
 *    show, diff-tree). No worktree is needed, so no checkout cost.
 *  - --filter=blob:none: the full commit graph arrives immediately, blobs are
 *    fetched lazily and only for the files that actually conflict.
 *  - pinned SHA: HEAD is moved to the corpus SHA, so `rev-list --merges HEAD`
 *    walks the same merges on every run, forever. A corpus pinned to a branch
 *    would silently drift and make two results incomparable.
 *
 * Usage:
 *   node benchmark/run.mjs                      # whole corpus
 *   node benchmark/run.mjs --repo vuejs/core    # one repo (repeatable)
 *   node benchmark/run.mjs --refactoring        # include opt-in refactoring pass
 *   node benchmark/run.mjs --out results/x.json
 *
 * First run clones several large repositories into benchmark/.cache — expect a
 * few GB and a long wait. Subsequent runs only fetch what moved (nothing, since
 * the SHAs are pinned).
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const CACHE = resolve(HERE, ".cache");
const REPLAY = resolve(ROOT, "scripts/replay-conflicts.mjs");
const CORE_DIST = resolve(ROOT, "packages/core/dist/index.js");

const args = process.argv.slice(2);
const only = args.reduce((acc, a, i) => (a === "--repo" ? [...acc, args[i + 1]] : acc), []);
const WITH_REFACTORING = args.includes("--refactoring");
const outIdx = args.indexOf("--out");

// ── preflight ────────────────────────────────────────────────────────────────

if (!existsSync(CORE_DIST)) {
  console.error(`✗ ${CORE_DIST} is missing.\n  The replay imports the built engine, not the sources. Run:\n    pnpm --filter @gitwand/core build`);
  process.exit(2);
}

// Fail here rather than inside the first repo's replay: a missing runtime
// dependency of @gitwand/core (yaml, smol-toml) surfaces as ERR_MODULE_NOT_FOUND
// deep in a subprocess, after the slow clone has already run.
try {
  await import(CORE_DIST);
} catch (err) {
  console.error(`✗ could not load ${CORE_DIST}:\n  ${err.message}\n  If this is a missing package, run \`pnpm install\` at the monorepo root.`);
  process.exit(2);
}

function gitVersionOk() {
  const out = execFileSync("git", ["--version"], { encoding: "utf-8" });
  const [, maj, min] = out.match(/(\d+)\.(\d+)/).map(Number);
  return maj > 2 || (maj === 2 && min >= 38);
}
if (!gitVersionOk()) {
  console.error("✗ git >= 2.38 is required (merge-tree --write-tree).");
  process.exit(2);
}

const corpus = JSON.parse(readFileSync(resolve(HERE, "corpus.json"), "utf-8"));
const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));
const repos = only.length ? corpus.repos.filter((r) => only.includes(r.name)) : corpus.repos;

if (!repos.length) {
  console.error(`✗ no repository matched ${only.join(", ")}. Known: ${corpus.repos.map((r) => r.name).join(", ")}`);
  process.exit(2);
}

mkdirSync(CACHE, { recursive: true });

// ── prepare ──────────────────────────────────────────────────────────────────

const slug = (name) => name.replace("/", "__") + ".git";

function prepare(repo) {
  const path = resolve(CACHE, slug(repo.name));
  const git = (cmd, opts = {}) =>
    execFileSync("git", ["-C", path, ...cmd], { encoding: "utf-8", stdio: ["ignore", "pipe", "inherit"], ...opts });

  if (!existsSync(path)) {
    console.error(`  cloning ${repo.name} (bare, blobless — this is the slow part)…`);
    execFileSync("git", ["clone", "--bare", "--filter=blob:none", repo.url, path], { stdio: ["ignore", "inherit", "inherit"] });
  }

  // The pinned SHA may not be reachable from the default branch (it can sit on a
  // branch that has since moved), so fetch it explicitly if the object is absent.
  try {
    git(["cat-file", "-e", `${repo.sha}^{commit}`]);
  } catch {
    console.error(`  fetching pinned commit ${repo.sha.slice(0, 10)}…`);
    git(["fetch", "--filter=blob:none", "origin", repo.sha]);
  }

  // Point HEAD at the pin. This is what makes `rev-list --merges HEAD` deterministic.
  git(["update-ref", "HEAD", repo.sha]);
  return path;
}

// ── run ──────────────────────────────────────────────────────────────────────

const reports = [];

for (const repo of repos) {
  console.error(`\n▸ ${repo.name}  (${repo.language}, ${repo.maxMerges} merges, pinned ${repo.sha.slice(0, 10)})`);
  let path;
  try {
    path = prepare(repo);
  } catch (err) {
    console.error(`  ✗ could not prepare ${repo.name}: ${err.message}`);
    reports.push({ repo: repo.name, error: String(err.message) });
    continue;
  }

  const replayArgs = [REPLAY, path, "--max-merges", String(repo.maxMerges), "--json"];
  if (WITH_REFACTORING) replayArgs.push("--refactoring");

  try {
    const out = execFileSync("node", replayArgs, {
      encoding: "utf-8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    });
    const report = JSON.parse(out);
    report.repo = repo.name;
    report.pinnedSha = repo.sha;
    report.language = repo.language;
    report.maxMergesRequested = repo.maxMerges;
    reports.push(report);
    console.error(`  ${report.totalHunks} hunks over ${report.mergesWithConflicts} conflicted merges`);
    // Projects that squash-merge every PR have very few merge commits to replay,
    // however long their history. Say so loudly: a repo contributing 20 merges is
    // a rounding error in the aggregate but looks like full participation in the
    // corpus list.
    if (report.mergesScanned < repo.maxMerges / 2) {
      console.error(`  ⚠ only ${report.mergesScanned} merges reachable (asked for ${repo.maxMerges}) — likely a squash-merge project; thin contribution to the corpus`);
    }
  } catch (err) {
    console.error(`  ✗ replay failed for ${repo.name}: ${err.message}`);
    reports.push({ repo: repo.name, error: String(err.message) });
  }
}

// ── aggregate ────────────────────────────────────────────────────────────────

const ok = reports.filter((r) => !r.error);

const totals = ok.reduce(
  (acc, r) => {
    acc.mergesScanned += r.mergesScanned;
    acc.mergesWithConflicts += r.mergesWithConflicts;
    acc.conflictedFiles += r.conflictedFiles;
    acc.skippedFiles += r.skippedFiles;
    acc.resolveErrors += r.resolveErrors;
    acc.mergeTreeErrors += r.mergeTreeErrors;
    acc.totalHunks += r.totalHunks;
    for (const [type, n] of Object.entries(r.byType)) acc.byType[type] = (acc.byType[type] ?? 0) + n;
    for (const [tier, n] of Object.entries(r.tiers.byTier)) acc.byTier[tier] = (acc.byTier[tier] ?? 0) + n;
    if (r.agreement) {
      acc.agreement.filesFullyResolved += r.agreement.filesFullyResolved;
      acc.agreement.comparable += r.agreement.comparable;
      acc.agreement.agreeExact += r.agreement.agreeExact;
      acc.agreement.agreeNormalized += r.agreement.agreeNormalized;
      acc.agreement.unavailable += r.agreement.unavailable;
    }
    return acc;
  },
  {
    mergesScanned: 0, mergesWithConflicts: 0, conflictedFiles: 0, skippedFiles: 0,
    resolveErrors: 0, mergeTreeErrors: 0, totalHunks: 0, byType: {}, byTier: {},
    agreement: { filesFullyResolved: 0, comparable: 0, agreeExact: 0, agreeNormalized: 0, unavailable: 0 },
  },
);

// Hunk-weighted, not repo-averaged: a repo contributing 4000 hunks should not
// count the same as one contributing 40. Averaging per-repo percentages is the
// classic way to make a benchmark say what you want.
const autoResolved = (totals.byTier.trivial ?? 0) + (totals.byTier.advancedDeterministic ?? 0);
const share = (n) => (totals.totalHunks ? Number(((n / totals.totalHunks) * 100).toFixed(2)) : 0);

const result = {
  gitwandVersion: pkg.version,
  corpusPinnedAt: corpus.pinnedAt,
  refactoringAwareEnabled: WITH_REFACTORING,
  reposRun: ok.length,
  reposFailed: reports.length - ok.length,
  totals: {
    ...totals,
    byType: Object.fromEntries(Object.entries(totals.byType).sort((a, b) => b[1] - a[1])),
  },
  headline: {
    // Coverage — how much the engine takes off your plate. Varies hugely by repo.
    autoResolvedHunks: autoResolved,
    autoResolvedShare: share(autoResolved),
    residualHunks: totals.totalHunks - autoResolved,
    residualShare: share(totals.totalHunks - autoResolved),
    // Precision — of the files it resolved end to end, how many match what the
    // team actually merged. This is the number that says whether to trust it.
    agreementExactShare: totals.agreement.comparable
      ? Number(((totals.agreement.agreeExact / totals.agreement.comparable) * 100).toFixed(2))
      : null,
    agreementComparableFiles: totals.agreement.comparable,
  },
  perRepo: reports.map((r) =>
    r.error
      ? { repo: r.repo, error: r.error }
      : {
          repo: r.repo, language: r.language, pinnedSha: r.pinnedSha,
          mergesScanned: r.mergesScanned, maxMergesRequested: r.maxMergesRequested,
          mergesWithConflicts: r.mergesWithConflicts,
          totalHunks: r.totalHunks, byTier: r.tiers.byTier,
          autoResolvedShare: r.totalHunks
            ? Number((((r.tiers.byTier.trivial + r.tiers.byTier.advancedDeterministic) / r.totalHunks) * 100).toFixed(2))
            : 0,
        },
  ),
};

const outPath = outIdx !== -1
  ? resolve(process.cwd(), args[outIdx + 1])
  : resolve(HERE, "results", `v${pkg.version}${WITH_REFACTORING ? "-refactoring" : ""}.json`);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");

console.error(`\n═══ corpus totals (GitWand ${pkg.version}) ═══`);
console.error(`repos:                 ${result.reposRun} run, ${result.reposFailed} failed`);
console.error(`merges scanned:        ${totals.mergesScanned}${totals.mergeTreeErrors ? `  ⚠ ${totals.mergeTreeErrors} merge-tree errors — results undercount` : ""}`);
console.error(`merges w/ conflicts:   ${totals.mergesWithConflicts}`);
console.error(`hunks:                 ${totals.totalHunks}`);
console.error(`auto-resolved:         ${autoResolved}  (${result.headline.autoResolvedShare}%)`);
console.error(`residual:              ${result.headline.residualHunks}  (${result.headline.residualShare}%)`);
if (result.headline.agreementExactShare !== null) {
  console.error(`agreement w/ humans:   ${totals.agreement.agreeExact}/${totals.agreement.comparable} files byte-identical  (${result.headline.agreementExactShare}%)`);
}
const shares = result.perRepo.filter((r) => !r.error).map((r) => r.autoResolvedShare);
if (shares.length > 1) {
  console.error(`per-repo spread:       ${Math.min(...shares)}% … ${Math.max(...shares)}%  ← read this before the aggregate`);
}
console.error(`\nwritten → ${outPath}`);
