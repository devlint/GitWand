/**
 * accuracy lot D (task 3) — MCP-local, REPORTING-ONLY regeneration helper.
 *
 * Scope ruling (task-3-brief.md § 4): no MCP tool ever executes regeneration.
 * None of the 3 MCP tools that call `resolve()` (`gitwand_status`,
 * `gitwand_resolve_conflicts`, `gitwand_preview_merge`) spawns a process or
 * creates a git worktree, ever — that machinery (`regenerate-runner.ts`)
 * lives ONLY in `@gitwand/cli`, which MCP must not depend on
 * (`packages/mcp/CLAUDE.md`: thin wrapper around `@gitwand/core` only).
 *
 * This module re-derives an accurate `RegenerationPlan` — via the same pure
 * core exports the CLI itself uses (`findEcosystem`/`buildRegenerationPlan`)
 * — from the file states a tool call already knows about, so a caller passing
 * `regenerate: true` gets a correct `runnable`/ecosystem verdict in the JSON
 * response instead of the always-`runnable: false` plan pass 1 attaches
 * on its own (regenerationContext is unknown to core at that point — see
 * `resolver/index.ts`). It mirrors the CLI's pass 2 sibling-state logic
 * (`commands/resolve.ts`) closely enough to be accurate, without any of the
 * CLI's execution machinery.
 *
 * `loadPersistedConventions`/`loadGitwandrcResolveGeneratedFiles` below are
 * intentionally duplicated from `@gitwand/cli` (`commands/conventions.ts` /
 * `llm-config.ts`) rather than imported — same reason as `merge-context.ts`'s
 * header comment: MCP must not depend on the CLI package. Both read from an
 * arbitrary `cwd`, mirroring the `detectMergeContext(cwd)` pattern already
 * used elsewhere in this package (MCP has no implicit `process.cwd()`).
 */

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  findEcosystem,
  buildRegenerationPlan,
  parseGitwandrc,
  type MergeResult,
  type RegenerationContext,
  type RegenerationPlan,
  type RepoConventions,
} from "@gitwand/core";

function gitTry(cwd: string, args: string[]): string | null {
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * `.git/gitwand/conventions.json` for the repo at `cwd`, tolerant — never
 * throws. Absent/unreadable/invalid all mean "no conventions", exactly the
 * `null` core expects on `options.conventions` by default.
 */
export function loadPersistedConventions(cwd: string): RepoConventions | null {
  const gitDir = gitTry(cwd, ["rev-parse", "--absolute-git-dir"]);
  if (!gitDir) return null;
  const path = join(gitDir, "gitwand", "conventions.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as RepoConventions;
  } catch {
    return null;
  }
}

/**
 * `.gitwandrc`/`.gitwandrc.json` `resolveGeneratedFiles` for the repo at
 * `cwd`. Returns `undefined` (never a concrete `false`) when unset, outside a
 * repo, or the file is missing/invalid — the same "no explicit opinion"
 * signal the CLI's `loadGitwandrcResolveGeneratedFiles` returns, letting a
 * measured `generatedFiles` convention take over exactly as it does there.
 */
export function loadGitwandrcResolveGeneratedFiles(cwd: string): boolean | undefined {
  const root = gitTry(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return undefined;

  for (const filename of [".gitwandrc", ".gitwandrc.json"]) {
    let content: string;
    try {
      content = readFileSync(join(root, filename), "utf-8");
    } catch {
      continue;
    }
    const parsed = parseGitwandrc(content);
    if (parsed === null) continue;
    return parsed.resolveGeneratedFiles;
  }
  return undefined;
}

export interface RegenerationReportEntry {
  file: string;
  ecosystem: RegenerationPlan["ecosystem"];
  runnable: boolean;
  sources: RegenerationPlan["sources"];
}

/**
 * Re-derives an accurate `RegenerationPlan` for every declined
 * `generated_file` resolution across `results` — each `{ file, result }` this
 * SAME tool call already computed. Pure reporting: reads nothing beyond what
 * `results` already carries, spawns nothing.
 *
 * A source-of-truth path never seen in conflict by THIS call is treated as
 * "clean" — the exact same convention the CLI's pass 2 uses for the common
 * case of a lockfile conflicting alone while its source merged cleanly (see
 * `resolve.ts`'s siblingFiles pre-seed comment). This is a best-effort
 * simplification appropriate for a reporting-only surface: `regenerate: true`
 * documents plan AVAILABILITY, never a guarantee — actually applying it
 * always goes through `gitwand resolve --regenerate` (the CLI), which
 * verifies the real working tree before running anything.
 */
export function buildRegenerationReport(
  results: Array<{ file: string; result: MergeResult }>,
): RegenerationReportEntry[] {
  const siblingFiles: RegenerationContext["siblingFiles"] = {};
  for (const { file, result } of results) {
    siblingFiles[file] = {
      state:
        result.stats.totalConflicts === 0
          ? "clean"
          : result.stats.remaining === 0
            ? "resolved"
            : "conflicted",
    };
  }

  const report: RegenerationReportEntry[] = [];
  const seen = new Set<string>();
  for (const { file, result } of results) {
    if (seen.has(file)) continue;
    const hasRegenCandidate = result.resolutions.some((r) => r.regenerationPlan !== undefined);
    if (!hasRegenCandidate) continue;
    seen.add(file);

    const ecosystem = findEcosystem(file);
    if (!ecosystem) continue; // should not happen — pass 1 already implied a match

    for (const source of ecosystem.sourcesOfTruth) {
      if (!(source in siblingFiles)) siblingFiles[source] = { state: "clean" };
    }

    const plan = buildRegenerationPlan(file, ecosystem, { siblingFiles });
    report.push({ file, ecosystem: plan.ecosystem, runnable: plan.runnable, sources: plan.sources });
  }
  return report;
}
