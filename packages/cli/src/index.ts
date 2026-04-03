#!/usr/bin/env node

/**
 * GitWand CLI
 *
 * Usage:
 *   gitwand resolve [files...]       Auto-resolve trivial conflicts
 *   gitwand status                   Show conflict status for the repo
 *   gitwand --help                   Show help
 *
 * CI mode:
 *   gitwand resolve --ci             JSON output + exit code 1 if conflicts remain
 *
 * @example
 *   npx gitwand resolve
 *   npx gitwand resolve src/app.ts src/config.ts
 *   npx gitwand resolve --ci --dry-run
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { resolve, type MergeResult } from "@gitwand/core";

// ─── ANSI Colors ────────────────────────────────────────────────
const isCI = process.env.CI === "true" || process.env.CI === "1";
const noColor = isCI || process.env.NO_COLOR !== undefined;

const c = noColor
  ? { reset: "", bold: "", dim: "", green: "", yellow: "", red: "", cyan: "", magenta: "" }
  : {
      reset: "\x1b[0m",
      bold: "\x1b[1m",
      dim: "\x1b[2m",
      green: "\x1b[32m",
      yellow: "\x1b[33m",
      red: "\x1b[31m",
      cyan: "\x1b[36m",
      magenta: "\x1b[35m",
    };

const WAND = noColor ? "*" : "\u2728";

function printBanner() {
  console.log(
    `\n${c.magenta}${c.bold}  ${WAND} GitWand${c.reset} ${c.dim}— Git's magic wand${c.reset}\n`,
  );
}

function printHelp() {
  printBanner();
  console.log(`${c.bold}Usage:${c.reset}`);
  console.log(`  gitwand resolve [files...]      Auto-resolve trivial conflicts`);
  console.log(`  gitwand status                  Show conflict status`);
  console.log(`  gitwand --help                  Show this help`);
  console.log();
  console.log(`${c.bold}Options:${c.reset}`);
  console.log(`  --dry-run       Analyze without writing files`);
  console.log(`  --verbose       Show details for each resolution`);
  console.log(`  --no-whitespace Don't resolve whitespace-only conflicts`);
  console.log(`  --ci            CI mode: JSON output + exit code 1 if unresolved`);
  console.log(`  --json          Output results as JSON (implies --ci behavior)`);
  console.log();
}

/**
 * Get the list of conflicted files in the current Git repo.
 */
function getConflictedFiles(): string[] {
  try {
    const output = execSync("git diff --name-only --diff-filter=U", {
      encoding: "utf-8",
    });
    return output
      .trim()
      .split("\n")
      .filter((f: string) => f.length > 0);
  } catch {
    return [];
  }
}

/** JSON report for CI mode */
interface CIReport {
  version: string;
  timestamp: string;
  summary: {
    files: number;
    totalConflicts: number;
    autoResolved: number;
    remaining: number;
    allResolved: boolean;
  };
  files: Array<{
    path: string;
    totalConflicts: number;
    autoResolved: number;
    remaining: number;
    resolutions: Array<{
      line: number;
      type: string;
      resolved: boolean;
      explanation: string;
    }>;
  }>;
}

/**
 * Build a CI-friendly JSON report from results.
 */
function buildCIReport(
  results: Array<{ file: string; result: MergeResult }>,
): CIReport {
  let totalConflicts = 0;
  let totalResolved = 0;

  const files = results.map(({ file, result }) => {
    totalConflicts += result.stats.totalConflicts;
    totalResolved += result.stats.autoResolved;

    return {
      path: file,
      totalConflicts: result.stats.totalConflicts,
      autoResolved: result.stats.autoResolved,
      remaining: result.stats.remaining,
      resolutions: result.resolutions.map((r) => ({
        line: r.hunk.startLine,
        type: r.hunk.type,
        resolved: r.autoResolved,
        explanation: r.hunk.explanation,
      })),
    };
  });

  return {
    version: "0.0.1",
    timestamp: new Date().toISOString(),
    summary: {
      files: results.length,
      totalConflicts,
      autoResolved: totalResolved,
      remaining: totalConflicts - totalResolved,
      allResolved: totalConflicts - totalResolved === 0,
    },
    files,
  };
}

/**
 * Main command: resolve
 */
function cmdResolve(files: string[], flags: Record<string, boolean>) {
  const isCIMode = flags.ci || flags.json;

  if (!isCIMode) {
    printBanner();
  }

  // If no files specified, discover from git
  if (files.length === 0) {
    files = getConflictedFiles();
    if (files.length === 0) {
      if (isCIMode) {
        console.log(JSON.stringify({ version: "0.0.1", summary: { files: 0, totalConflicts: 0, autoResolved: 0, remaining: 0, allResolved: true }, files: [] }, null, 2));
        process.exit(0);
      }
      console.log(`${c.green}No conflicted files detected.${c.reset}`);
      return;
    }
    if (!isCIMode) {
      console.log(
        `${c.cyan}${files.length} conflicted file(s) detected${c.reset}\n`,
      );
    }
  }

  const results: Array<{ file: string; result: MergeResult }> = [];

  let totalResolved = 0;
  let totalRemaining = 0;
  let totalConflicts = 0;

  for (const file of files) {
    const filePath = resolvePath(file);
    let content: string;

    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      if (!isCIMode) {
        console.log(`${c.red}  \u2717 ${file} — file not found${c.reset}`);
      }
      continue;
    }

    const result = resolve(content, file, {
      verbose: !isCIMode && (flags.verbose ?? false),
      resolveWhitespace: !(flags["no-whitespace"] ?? false),
    });

    results.push({ file, result });

    totalConflicts += result.stats.totalConflicts;
    totalResolved += result.stats.autoResolved;
    totalRemaining += result.stats.remaining;

    if (!isCIMode) {
      if (result.stats.totalConflicts === 0) {
        console.log(`${c.dim}  \u25CB ${file} — no conflicts${c.reset}`);
      } else {
        const icon = result.stats.remaining === 0 ? "\u2713" : "\u25D0";
        const color = result.stats.remaining === 0 ? c.green : c.yellow;

        console.log(
          `${color}  ${icon} ${file} — ${result.stats.autoResolved}/${result.stats.totalConflicts} resolved${c.reset}`,
        );

        // Show details in verbose mode
        if (flags.verbose) {
          for (const res of result.resolutions) {
            const status = res.autoResolved
              ? `${c.green}auto${c.reset}`
              : `${c.red}manual${c.reset}`;
            console.log(
              `${c.dim}    L${res.hunk.startLine} [${res.hunk.type}] ${status} — ${res.hunk.explanation}${c.reset}`,
            );
          }
        }
      }
    }

    // Write resolved file (unless dry-run)
    if (!flags["dry-run"] && result.stats.autoResolved > 0) {
      // Use mergedContent if all resolved, otherwise rebuild with partial resolutions
      const newContent = result.mergedContent ?? content;
      writeFileSync(filePath, newContent, "utf-8");
    }
  }

  // CI mode: JSON output
  if (isCIMode) {
    const report = buildCIReport(results);
    console.log(JSON.stringify(report, null, 2));

    if (report.summary.remaining > 0) {
      process.exit(1);
    }
    process.exit(0);
  }

  // Human-readable summary
  console.log(`\n${c.bold}\u2500\u2500\u2500 Summary \u2500\u2500\u2500${c.reset}`);
  console.log(
    `${c.bold}${WAND} ${totalResolved}${c.reset} conflict(s) auto-resolved out of ${c.bold}${totalConflicts}${c.reset}`,
  );

  if (totalRemaining > 0) {
    console.log(
      `${c.yellow}${totalRemaining} conflict(s) remaining — manual resolution needed${c.reset}`,
    );
  } else if (totalConflicts > 0) {
    console.log(
      `${c.green}${c.bold}All conflicts resolved! ${WAND}${c.reset}`,
    );
  }

  if (flags["dry-run"]) {
    console.log(`\n${c.dim}(dry-run — no files modified)${c.reset}`);
  }

  console.log();
}

/**
 * Command: status
 */
function cmdStatus(flags: Record<string, boolean>) {
  const isCIMode = flags.ci || flags.json;

  if (!isCIMode) {
    printBanner();
  }

  const files = getConflictedFiles();

  if (files.length === 0) {
    if (isCIMode) {
      console.log(JSON.stringify({ files: 0, conflicts: [] }, null, 2));
      return;
    }
    console.log(`${c.green}No conflicted files.${c.reset}\n`);
    return;
  }

  if (!isCIMode) {
    console.log(`${c.cyan}${files.length} conflicted file(s):${c.reset}\n`);
  }

  const statusEntries: Array<{
    path: string;
    total: number;
    resolvable: number;
    percentage: number;
  }> = [];

  for (const file of files) {
    const filePath = resolvePath(file);
    try {
      const content = readFileSync(filePath, "utf-8");
      const result = resolve(content, file);

      const resolvable = result.stats.autoResolved;
      const total = result.stats.totalConflicts;
      const pct = total > 0 ? Math.round((resolvable / total) * 100) : 0;

      statusEntries.push({ path: file, total, resolvable, percentage: pct });

      if (!isCIMode) {
        const color = pct === 100 ? c.green : pct > 0 ? c.yellow : c.red;
        console.log(
          `  ${color}${file}${c.reset} — ${resolvable}/${total} resolvable (${pct}%)`,
        );
      }
    } catch {
      if (!isCIMode) {
        console.log(`  ${c.red}${file}${c.reset} — read error`);
      }
    }
  }

  if (isCIMode) {
    console.log(JSON.stringify({ files: files.length, conflicts: statusEntries }, null, 2));
  } else {
    console.log();
  }
}

// ─── Main ───────────────────────────────────────────────────────
const args = process.argv.slice(2);
const command = args[0];

const flags: Record<string, boolean> = {};
const positional: string[] = [];

for (const arg of args.slice(1)) {
  if (arg.startsWith("--")) {
    flags[arg.slice(2)] = true;
  } else {
    positional.push(arg);
  }
}

if (!command || command === "--help" || command === "-h") {
  printHelp();
} else if (command === "resolve") {
  cmdResolve(positional, flags);
} else if (command === "status") {
  cmdStatus(flags);
} else {
  console.error(`${c.red}Unknown command: ${command}${c.reset}`);
  printHelp();
  process.exit(1);
}
