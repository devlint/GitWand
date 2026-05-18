#!/usr/bin/env node
/**
 * GitWand bench runner (P6.1).
 *
 * Génère un fixture git temporaire, exécute le probe parité contre
 * chaque commande critique N fois, calcule median/p95/stddev, dump JSON.
 *
 * Usage :
 *   node perf/bench.mjs [--check-against <path>] [--write-baseline <path>]
 */

import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const PROBE = process.env.PARITY_PROBE
  || resolve(REPO_ROOT, "apps/desktop/src-tauri/target/release/examples/parity-probe");

const SAMPLES = 50;
const WARMUP = 5;
const REGRESSION_THRESHOLD = 0.15; // 15%

if (!existsSync(PROBE)) {
  console.error(`Probe binary not found: ${PROBE}`);
  console.error("Build it first: cd apps/desktop && cargo build --example parity-probe --release");
  process.exit(2);
}

// ─── Fixture generation ──────────────────────────────────────────────────────
// A deterministic repo with realistic shape: ~200 commits across 3 branches,
// 50 tracked files, 5 staged, 3 unstaged, 2 untracked. Numbers tuned to
// stress the hot paths without being absurd.

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "gitwand-bench-"));
  git(dir, "init", "--initial-branch=main", "--quiet");
  git(dir, "config", "user.name", "Bench Bot");
  git(dir, "config", "user.email", "bench@gitwand.local");
  git(dir, "config", "gc.auto", "0");
  git(dir, "config", "gc.autoDetach", "false");

  // 50 tracked files, 200 commits
  for (let i = 0; i < 200; i++) {
    const file = `file_${i % 50}.txt`;
    writeFileSync(join(dir, file), `line ${i}\nmore lines\n`);
    git(dir, "add", file);
    git(dir, "commit", "-m", `commit ${i}`, "--quiet");
  }

  // Branch off
  git(dir, "checkout", "-b", "feature/x", "--quiet");
  writeFileSync(join(dir, "feature.txt"), "feature work\n");
  git(dir, "add", "feature.txt");
  git(dir, "commit", "-m", "feature work", "--quiet");
  git(dir, "checkout", "main", "--quiet");

  // 5 staged + 3 unstaged + 2 untracked, on main
  for (let i = 0; i < 5; i++) {
    writeFileSync(join(dir, `file_${i}.txt`), `staged change ${i}\n`);
    git(dir, "add", `file_${i}.txt`);
  }
  for (let i = 5; i < 8; i++) {
    writeFileSync(join(dir, `file_${i}.txt`), `unstaged change ${i}\n`);
  }
  writeFileSync(join(dir, "untracked_a.txt"), "untracked\n");
  writeFileSync(join(dir, "untracked_b.txt"), "untracked\n");

  return dir;
}

// ─── Probe runner ────────────────────────────────────────────────────────────

function runProbe(command, input) {
  const start = process.hrtime.bigint();
  const child = spawnSync(PROBE, [command], {
    input: JSON.stringify(input),
    encoding: "utf8",
  });
  const end = process.hrtime.bigint();
  if (child.status !== 0) {
    throw new Error(`probe ${command} failed (exit ${child.status}): ${child.stderr}`);
  }
  return Number(end - start) / 1_000_000; // ms
}

// ─── Stats ───────────────────────────────────────────────────────────────────

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const variance = samples.reduce((acc, v) => acc + (v - mean) ** 2, 0) / samples.length;
  const stddev = Math.sqrt(variance);
  return {
    samples: samples.length,
    median_ms: round(median),
    p95_ms: round(p95),
    stddev_ms: round(stddev),
    min_ms: round(min),
    max_ms: round(max),
  };
}

const round = (n) => Math.round(n * 100) / 100;

// ─── Bench commands ──────────────────────────────────────────────────────────

function bench(name, command, input) {
  // Warmup
  for (let i = 0; i < WARMUP; i++) runProbe(command, input);

  const times = [];
  for (let i = 0; i < SAMPLES; i++) {
    times.push(runProbe(command, input));
  }
  return [name, stats(times)];
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const checkAgainst = argValue(args, "--check-against");
  const writeBaseline = argValue(args, "--write-baseline");

  console.log("Generating fixture...");
  const cwd = makeFixture();
  console.log(`  → ${cwd}`);

  console.log(`Running benches (${SAMPLES} samples each, ${WARMUP} warmup)...`);
  const results = Object.fromEntries([
    // CLI vs libgit2 comparison on the same fixture (P3.3b validation).
    // The first measures the parity-test path, the second the user-facing
    // path that the Tauri command actually runs.
    bench("git_status", "git-status", { cwd }),
    bench("git_status_fast", "git-status-fast", { cwd }),
    bench("git_log_50", "git-log", { cwd, count: 50 }),
    bench("git_log_500", "git-log", { cwd, count: 500 }),
    bench("git_branches", "git-branches", { cwd }),
  ]);

  const out = {
    timestamp: new Date().toISOString(),
    commit: gitHead(),
    machine: {
      platform: process.platform,
      arch: process.arch,
      cpus: cpus().length,
      node: process.version,
    },
    results,
  };

  // Print summary table. For paired benches (e.g. git_status / git_status_fast),
  // the second row gets a ↓ delta% column showing the gain over the first.
  const PAIRS = { git_status_fast: "git_status" };
  console.log("\nResults:");
  console.log("Bench                  median    p95       stddev   vs CLI");
  for (const [name, s] of Object.entries(results)) {
    const baseName = PAIRS[name];
    let vsTag = "";
    if (baseName) {
      const base = results[baseName];
      if (base) {
        const delta = (s.median_ms - base.median_ms) / base.median_ms;
        const arrow = delta < 0 ? "↓" : "↑";
        vsTag = `   ${arrow} ${(Math.abs(delta) * 100).toFixed(0)}%`;
      }
    }
    console.log(
      `${name.padEnd(22)} ${String(s.median_ms).padStart(6)}ms  ${String(s.p95_ms).padStart(6)}ms  ${String(s.stddev_ms).padStart(6)}ms${vsTag}`
    );
  }

  if (checkAgainst) {
    const baseline = JSON.parse(readFileSync(checkAgainst, "utf8"));
    let regressed = false;
    console.log(`\nChecking against baseline: ${checkAgainst}`);
    for (const [name, current] of Object.entries(results)) {
      const base = baseline.results?.[name];
      if (!base) {
        console.log(`  ${name}: no baseline entry, skipping`);
        continue;
      }
      const delta = (current.median_ms - base.median_ms) / base.median_ms;
      const tag = delta > REGRESSION_THRESHOLD ? "REGRESSION" : delta < -0.05 ? "improved" : "ok";
      console.log(`  ${name}: ${base.median_ms}ms → ${current.median_ms}ms (${(delta * 100).toFixed(1)}%) ${tag}`);
      if (delta > REGRESSION_THRESHOLD) regressed = true;
    }
    if (regressed) {
      console.error(`\nFAIL: at least one bench regressed by more than ${REGRESSION_THRESHOLD * 100}%`);
      process.exit(1);
    }
  }

  if (writeBaseline) {
    writeFileSync(writeBaseline, JSON.stringify(out, null, 2));
    console.log(`\nBaseline written: ${writeBaseline}`);
  } else {
    const dest = join(__dirname, "last-run.json");
    writeFileSync(dest, JSON.stringify(out, null, 2));
    console.log(`\nResults written: ${dest}`);
  }
}

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

function gitHead() {
  try {
    const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" });
    return r.stdout.trim();
  } catch {
    return "unknown";
  }
}

main();
