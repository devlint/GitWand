/**
 * Commande `gitwand preview` — Conflict Predictor étendu (v2.20).
 *
 * Simule un merge, rebase ou cherry-pick SANS toucher le working tree,
 * l'index ou HEAD. Utilise `git merge-file` sur des blobs temporaires
 * pour produire un contenu balisé conflit, puis passe chaque fichier
 * par le moteur `resolve()` de `@gitwand/core` pour évaluer ce que
 * GitWand peut auto-résoudre vs. ce qui nécessite une intervention.
 *
 * Options :
 *   --onto <ref>    Rebase preview : rebaser HEAD sur <ref>
 *   --commit <sha>  Cherry-pick preview : cherry-picker <sha> sur HEAD
 *   --branch <name> Merge preview : merger <name> dans HEAD
 *   --json          Output machine-readable JSON
 *   --ci            Identique à --json (pour CI/CD pipelines)
 *
 * Exit codes :
 *   0 — aucun conflit prédit (ou aucune modification qui se chevauche)
 *   1 — au moins un conflit prédit
 *   2 — erreur (ref invalide, hors repo git, etc.)
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execSync, execFileSync, type SpawnSyncReturns } from "node:child_process";
import { resolve as resolvePath, join as joinPath } from "node:path";
import { tmpdir } from "node:os";
import { resolve, type MergeResult } from "@gitwand/core";

import { c, printBanner } from "../ui.js";

// ─── Git helpers ───────────────────────────────────────────

/** Run git with args as a discrete array — no shell interpolation. */
function gitTry(cwd: string, args: string[]): string | null {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim();
  } catch {
    return null;
  }
}

/**
 * Run `git merge-file` and return the merged content INCLUDING conflict markers.
 *
 * Unlike gitTry, this must NOT discard output on a non-zero exit: `git merge-file`
 * exits with a code equal to the number of conflicts (>0 means there ARE
 * conflicts — exactly the case the predictor cares about), and the conflict-marked
 * content is still written to stdout. Returns the content as-is, or null only on a
 * real spawn failure or a fatal git error (exit 255 / no captured stdout).
 */
function gitMergeFile(cwd: string, args: string[]): string | null {
  try {
    const out = execFileSync("git", ["merge-file", ...args], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out; // clean merge, exit 0
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string };
    if (typeof err.stdout === "string" && err.stdout.length > 0) {
      return err.stdout;
    }
    return null;
  }
}

/** Resolve a ref to a commit SHA, null if unknown. */
function revParse(cwd: string, rev: string): string | null {
  return gitTry(cwd, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
}

/** Files changed between two revs (--name-only). */
function changedFiles(cwd: string, base: string, rev: string): string[] {
  const out = gitTry(cwd, ["diff", "--name-only", base, rev]);
  if (!out) return [];
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Read a file's blob at a given rev, null if absent. */
function showBlob(cwd: string, rev: string, file: string): string | null {
  return gitTry(cwd, ["show", `${rev}:${file}`]);
}

interface SimulatedFile {
  file: string;
  content: string;
  addDelete: boolean;
}

/**
 * Build conflict-marked content for files changed on BOTH sides of a 3-way
 * operation. Uses `git merge-file` in a system temp dir — never writes to the
 * repo. Same algorithm as the MCP `gitwand_preview_merge` tool.
 */
function simulate3way(
  cwd: string,
  ancestor: string,
  ours: string,
  theirs: string,
): SimulatedFile[] {
  const oursFiles = new Set(changedFiles(cwd, ancestor, ours));
  const theirsFiles = changedFiles(cwd, ancestor, theirs);
  const both = theirsFiles.filter((f) => oursFiles.has(f));

  if (both.length === 0) return [];

  const tmp = mkdtempSync(joinPath(tmpdir(), "gitwand-preview-"));
  const out: SimulatedFile[] = [];
  try {
    for (const file of both) {
      const baseBlob = showBlob(cwd, ancestor, file);
      const oursBlob = showBlob(cwd, ours, file);
      const theirsBlob = showBlob(cwd, theirs, file);

      if (oursBlob === null || theirsBlob === null) {
        out.push({ file, content: "", addDelete: true });
        continue;
      }

      const safe = file.replace(/[\\/.]/g, "_");
      const pBase = joinPath(tmp, `${safe}.base`);
      const pOurs = joinPath(tmp, `${safe}.ours`);
      const pTheirs = joinPath(tmp, `${safe}.theirs`);
      writeFileSync(pBase, baseBlob ?? "", "utf-8");
      writeFileSync(pOurs, oursBlob, "utf-8");
      writeFileSync(pTheirs, theirsBlob, "utf-8");

      // Must use gitMergeFile, not gitTry: merge-file exits non-zero on conflict
      // (the very case we want), and gitTry would discard the conflict content.
      const merged = gitMergeFile(cwd, ["-p", "--diff3", pOurs, pBase, pTheirs]);
      out.push({ file, content: merged ?? "", addDelete: false });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return out;
}

// ─── Output helpers ────────────────────────────────────────

function riskColor(risk: string): string {
  if (risk === "low") return c.green;
  if (risk === "medium") return c.yellow;
  return c.red;
}

/**
 * Overall risk level, using the SAME status-based model as the desktop
 * `useMergePreview` `riskLevel` computed and the MCP `previewResponse` (spec
 * §4.2), so all three predictor surfaces agree for identical inputs:
 *   - high   : at least one file is "manual" (conflicts, none auto-resolved) or
 *              an add/delete conflict;
 *   - medium : at least one file is "partial" (some but not all auto-resolved);
 *   - low    : no conflicting files, or every conflict auto-resolved.
 * Deliberately status-based, NOT count/threshold-based.
 */
function computeRisk(
  previews: Array<{ totalConflicts: number; autoResolved: number }>,
  addDeleteCount: number,
): "low" | "medium" | "high" {
  if (addDeleteCount > 0) return "high";
  const hasManual = previews.some((p) => p.totalConflicts > 0 && p.autoResolved === 0);
  if (hasManual) return "high";
  const hasPartial = previews.some(
    (p) => p.totalConflicts > 0 && p.autoResolved > 0 && p.autoResolved < p.totalConflicts,
  );
  return hasPartial ? "medium" : "low";
}

function printPreviewTable(
  operation: string,
  ref: string,
  sims: SimulatedFile[],
  previews: Array<ReturnType<typeof buildFilePreview>>,
  addDeleteCount: number,
): void {
  const totalConflicts = previews.reduce((s, p) => s + p.totalConflicts, 0);
  const totalResolved = previews.reduce((s, p) => s + p.autoResolved, 0);
  const risk = computeRisk(previews, addDeleteCount);

  const opLabel = operation === "rebase" ? "Rebase onto" : operation === "cherry-pick" ? "Cherry-pick" : "Merge";
  console.log(`\n${c.bold}${opLabel}:${c.reset} ${c.cyan}${ref}${c.reset}`);
  console.log(`${riskColor(risk)}${c.bold}Risk: ${risk.toUpperCase()}${c.reset}`);
  console.log();

  // Only claim "clean" when there are genuinely no overlapping changes — i.e.
  // no resolvable sims AND no add/delete conflicts. `sims` here is the
  // add/delete-filtered list, so guarding on its length alone would print
  // "predicted clean" immediately above an add/delete conflict line.
  if (sims.length === 0 && addDeleteCount === 0) {
    console.log(`${c.green}No overlapping changes — operation predicted clean.${c.reset}\n`);
    return;
  }

  for (let i = 0; i < previews.length; i++) {
    const p = previews[i];
    const s = sims[i];
    if (!s) continue;

    const pct = p.totalConflicts > 0 ? Math.round((p.autoResolved / p.totalConflicts) * 100) : 100;
    const color = pct === 100 ? c.green : pct > 0 ? c.yellow : c.red;
    console.log(`  ${color}${s.file}${c.reset} — ${p.autoResolved}/${p.totalConflicts} auto-resolvable (${pct}%)`);
  }

  if (addDeleteCount > 0) {
    console.log(`  ${c.red}+${addDeleteCount} add/delete conflict(s) (require manual resolution)${c.reset}`);
  }

  console.log();
  console.log(`  Total: ${totalResolved}/${totalConflicts + addDeleteCount} conflicts auto-resolvable`);
  console.log();
}

function buildFilePreview(content: string, file: string): {
  file: string;
  totalConflicts: number;
  autoResolved: number;
  remaining: number;
  percentage: number;
} {
  // NOT `explainOnly`: that flag short-circuits `resolveHunk` before the format-aware
  // dispatch and the confidence gate, so every hunk comes back unresolved and
  // `stats.autoResolved` is always 0 — the predictor would report 0% resolvable and
  // HIGH risk on every conflict. This runs on a temp-dir merge, nothing is written.
  const result = resolve(content, file);
  const pct =
    result.stats.totalConflicts > 0
      ? Math.round((result.stats.autoResolved / result.stats.totalConflicts) * 100)
      : 100;
  return {
    file,
    totalConflicts: result.stats.totalConflicts,
    autoResolved: result.stats.autoResolved,
    remaining: result.stats.remaining,
    percentage: pct,
  };
}

// ─── Command entry point ────────────────────────────────────

export async function cmdPreview(flags: Record<string, boolean | string>): Promise<void> {
  const isCIMode = flags.ci || flags.json;
  const onto = flags.onto as string | undefined;
  const commit = flags.commit as string | undefined;
  const branch = flags.branch as string | undefined;
  const cwd = process.cwd();

  if (!isCIMode) printBanner();

  // Determine operation
  let operation: "rebase" | "cherry-pick" | "merge";
  let ref: string;
  if (onto) {
    operation = "rebase";
    ref = onto;
  } else if (commit) {
    operation = "cherry-pick";
    ref = commit;
  } else if (branch) {
    operation = "merge";
    ref = branch;
  } else {
    console.error(
      `${c.red}Error: specify --onto <ref>, --commit <sha>, or --branch <name>.${c.reset}\n`,
    );
    process.exit(2);
  }

  // Resolve refs
  const headSha = revParse(cwd, "HEAD");
  if (!headSha) {
    console.error(`${c.red}Error: not in a git repository or HEAD is unborn.${c.reset}\n`);
    process.exit(2);
  }

  const refSha = revParse(cwd, ref);
  if (!refSha) {
    console.error(`${c.red}Error: cannot resolve ref '${ref}'. Does it exist?${c.reset}\n`);
    process.exit(2);
  }

  // Build 3-way parameters
  let ancestor: string;
  let ours: string;
  let theirs: string;

  if (operation === "rebase") {
    const mb = gitTry(cwd, ["merge-base", headSha, refSha]);
    if (!mb) {
      console.error(`${c.red}Error: no common ancestor between HEAD and '${ref}'.${c.reset}\n`);
      process.exit(2);
    }
    ancestor = mb;
    // Orientation per commit: ours = onto (target base), theirs = commit (replayed).
    ours = refSha;
    theirs = headSha; // used below only for cherry-pick / merge; rebase uses per-commit loop
  } else if (operation === "cherry-pick") {
    const parentSha = revParse(cwd, `${refSha}^`);
    if (!parentSha) {
      console.error(
        `${c.red}Error: cannot preview cherry-pick of root commit '${ref}' (no parent).${c.reset}\n`,
      );
      process.exit(2);
    }
    ancestor = parentSha;
    ours = headSha;
    theirs = refSha;
  } else {
    const mb = gitTry(cwd, ["merge-base", headSha, refSha]);
    if (!mb) {
      console.error(`${c.red}Error: no common ancestor between HEAD and '${ref}'.${c.reset}\n`);
      process.exit(2);
    }
    ancestor = mb;
    ours = headSha;
    theirs = refSha;
  }

  // Simulate
  let sims: SimulatedFile[];
  try {
    if (operation === "rebase") {
      // Per-commit replay (oldest-first) for accurate multi-commit stack detection.
      // ancestor = merge-base, ours = onto, theirs = individual commit being replayed.
      const commitsRaw = gitTry(cwd, ["rev-list", "--reverse", `${ancestor}..${headSha}`]);
      const commits = commitsRaw ? commitsRaw.split("\n").filter((l) => l.trim()) : [];
      const allSims: SimulatedFile[] = [];
      for (const commitSha of commits) {
        const parentSha = revParse(cwd, `${commitSha}^`);
        if (!parentSha) continue; // root commit — skip
        const perCommitSims = simulate3way(cwd, parentSha, ours, commitSha);
        allSims.push(...perCommitSims);
      }
      // Deduplicate: keep the entry with the most conflict signal per file.
      const seenFiles = new Map<string, SimulatedFile>();
      for (const s of allSims) {
        const existing = seenFiles.get(s.file);
        if (!existing) {
          seenFiles.set(s.file, s);
        } else {
          const score = (f: SimulatedFile) => f.addDelete ? 2 : f.content.includes("<<<<<<<") ? 1 : 0;
          if (score(s) > score(existing)) seenFiles.set(s.file, s);
        }
      }
      sims = Array.from(seenFiles.values());
    } else {
      sims = simulate3way(cwd, ancestor, ours, theirs);
    }
  } catch (err: unknown) {
    console.error(
      `${c.red}Error during conflict simulation: ${err instanceof Error ? err.message : String(err)}${c.reset}\n`,
    );
    process.exit(2);
  }

  const addDeleteCount = sims.filter((s) => s.addDelete).length;
  const resolvableSims = sims.filter((s) => !s.addDelete);
  const previews = resolvableSims.map((s) => buildFilePreview(s.content, s.file));

  const totalConflicts = previews.reduce((sum, p) => sum + p.totalConflicts, 0);
  const totalResolved = previews.reduce((sum, p) => sum + p.autoResolved, 0);
  const remaining = totalConflicts - totalResolved;
  const risk = computeRisk(previews, addDeleteCount);

  if (isCIMode) {
    console.log(
      JSON.stringify(
        {
          operation,
          ref,
          risk,
          summary: {
            filesWithOverlap: sims.length,
            totalConflicts: totalConflicts + addDeleteCount,
            autoResolvable: totalResolved,
            remaining: remaining + addDeleteCount,
            autoResolvePercentage:
              totalConflicts + addDeleteCount > 0
                ? Math.round(
                    (totalResolved / (totalConflicts + addDeleteCount)) * 100,
                  )
                : 100,
          },
          files: [
            ...previews.map((p) => ({ ...p, addDelete: false })),
            ...sims
              .filter((s) => s.addDelete)
              .map((s) => ({
                file: s.file,
                totalConflicts: 1,
                autoResolved: 0,
                remaining: 1,
                percentage: 0,
                addDelete: true,
              })),
          ],
        },
        null,
        2,
      ),
    );
  } else {
    printPreviewTable(operation, ref, resolvableSims, previews, addDeleteCount);
  }

  // Exit 1 if any predicted conflict remains
  if (remaining > 0 || addDeleteCount > 0) {
    process.exit(1);
  }
}
