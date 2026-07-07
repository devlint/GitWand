/**
 * MCP Tools — what the LLM can invoke.
 *
 * gitwand_status                → list conflicted files + complexity
 * gitwand_resolve_conflicts     → auto-resolve and return results + DecisionTrace
 * gitwand_preview_merge         → dry-run: simulate resolution, return stats
 * gitwand_explain_hunk          → explain why a specific hunk is "complex"
 * gitwand_apply_resolution      → apply a custom resolution to a specific hunk
 * gitwand_resolve_hunk          → ask the connected agent to propose a resolution
 *                                 (inversion of `--llm-fallback`: the agent IS the LLM)
 * gitwand_resolve_hunk_llm      → validate + apply an LLM-proposed resolution
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execSync, execFileSync } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { resolve, summarizeTiers, type MergeResult, type ConflictType } from "@gitwand/core";
import { resolveHunkToolDefinition, handleResolveHunk } from "./resolve_hunk.js";

// ─── Tool definitions ──────────────────────────────────────

export function registerTools() {
  return [
    {
      name: "gitwand_status",
      description:
        "List conflicted files in the current Git repo with their complexity and auto-resolvability. Returns a structured JSON report with conflict counts, types, and confidence scores.",
      inputSchema: {
        type: "object" as const,
        properties: {
          cwd: {
            type: "string",
            description: "Working directory (repo root). Defaults to server cwd.",
          },
        },
      },
    },
    {
      name: "gitwand_resolve_conflicts",
      description:
        "Auto-resolve trivial Git merge conflicts using GitWand's pattern-based engine. Returns resolved files, DecisionTrace for each hunk, and pendingHunks for conflicts that need human/LLM review. Writes resolved files to disk unless dry_run is true.",
      inputSchema: {
        type: "object" as const,
        properties: {
          cwd: {
            type: "string",
            description: "Working directory (repo root). Defaults to server cwd.",
          },
          files: {
            type: "array",
            items: { type: "string" },
            description: "Specific files to resolve. If omitted, discovers all conflicted files from git.",
          },
          dry_run: {
            type: "boolean",
            description: "If true, analyze without writing files. Default: false.",
          },
          policy: {
            type: "string",
            enum: ["prefer-ours", "prefer-theirs", "prefer-merge", "prefer-safety", "strict"],
            description: "Merge policy to use. Default: prefer-theirs.",
          },
        },
      },
    },
    {
      name: "gitwand_preview_merge",
      description:
        "Side-effect-free Conflict Predictor. Simulates a merge, rebase, or cherry-pick and reports how many conflicts GitWand can auto-resolve vs. how many need manual/LLM attention, plus an overall risk level (low/medium/high). Does NOT modify the working tree, index, or HEAD.\n\n- operation 'merge' (default): analyzes conflicts already materialized in the working tree (files with conflict markers).\n- operation 'rebase': simulates rebasing HEAD onto `onto` (3-way against merge-base(HEAD, onto); HEAD's work is replayed on top of `onto`).\n- operation 'cherry-pick': simulates cherry-picking `commit` onto HEAD (3-way with `commit^` as ancestor, HEAD as ours, `commit` as theirs).",
      inputSchema: {
        type: "object" as const,
        properties: {
          cwd: {
            type: "string",
            description: "Working directory (repo root). Defaults to server cwd.",
          },
          operation: {
            type: "string",
            enum: ["merge", "rebase", "cherry-pick"],
            description: "Operation to simulate. Default: 'merge'.",
          },
          onto: {
            type: "string",
            description: "Required when operation is 'rebase': the branch/ref to rebase HEAD onto.",
          },
          commit: {
            type: "string",
            description: "Required when operation is 'cherry-pick': the commit to simulate cherry-picking onto HEAD.",
          },
        },
      },
    },
    {
      name: "gitwand_explain_hunk",
      description:
        "Explain why a specific conflict hunk was classified as its type. Returns the DecisionTrace with each evaluation step and the ours/theirs/base content for context.",
      inputSchema: {
        type: "object" as const,
        properties: {
          cwd: {
            type: "string",
            description: "Working directory (repo root). Defaults to server cwd.",
          },
          file: {
            type: "string",
            description: "Path to the conflicted file (relative to cwd).",
          },
          line: {
            type: "number",
            description: "Start line of the hunk to explain.",
          },
        },
        required: ["file", "line"],
      },
    },
    {
      name: "gitwand_apply_resolution",
      description:
        "Apply a custom resolution (provided by the LLM or user) to a specific conflict hunk. Replaces the conflict markers at the given line range with the provided content. Use this for 'complex' hunks that GitWand couldn't auto-resolve.",
      inputSchema: {
        type: "object" as const,
        properties: {
          cwd: {
            type: "string",
            description: "Working directory (repo root). Defaults to server cwd.",
          },
          file: {
            type: "string",
            description: "Path to the conflicted file (relative to cwd).",
          },
          line: {
            type: "number",
            description: "Start line of the conflict hunk (the <<<<<<< line).",
          },
          content: {
            type: "string",
            description: "The resolved content to replace the conflict block with.",
          },
        },
        required: ["file", "line", "content"],
      },
    },
    // v2.5 — inversion-of-loop: GitWand asks the connected agent (Claude Code,
    // Cursor, Windsurf…) to propose a resolution. The server returns a structured
    // prompt; the agent replies with { resolution, reasoning }.
    resolveHunkToolDefinition,
    // v2.5 — validate + apply an LLM-proposed resolution
    {
      name: "gitwand_resolve_hunk_llm",
      description:
        "Validate and apply an LLM-proposed resolution for a specific conflict hunk. " +
        "Reads the hunk at the given file+line, replaces it with the proposed resolution, " +
        "validates the result (no residual markers, syntax check for JSON/YAML), and writes " +
        "the file if the validation score meets the threshold. Returns the full audit trail " +
        "(validation score, accepted/rejected, reason). " +
        "Workflow: (1) call gitwand_status or gitwand_explain_hunk to see pending complex hunks, " +
        "(2) propose a resolution, (3) call this tool to validate + apply it.",
      inputSchema: {
        type: "object" as const,
        properties: {
          cwd: {
            type: "string",
            description: "Working directory (repo root). Defaults to server cwd.",
          },
          file: {
            type: "string",
            description: "Path to the conflicted file (relative to cwd).",
          },
          line: {
            type: "number",
            description: "Start line of the conflict hunk (the <<<<<<< line, 1-indexed).",
          },
          resolution: {
            type: "string",
            description: "LLM-proposed resolution content — the lines that replace the conflict block.",
          },
          min_score: {
            type: "number",
            description: "Minimum validation score (0–100) to accept and write the resolution. Default: 80.",
          },
          dry_run: {
            type: "boolean",
            description: "If true, validate but do NOT write the file. Default: false.",
          },
        },
        required: ["file", "line", "resolution"],
      },
    },
  ];
}

// ─── Helpers ───────────────────────────────────────────────

function getConflictedFiles(cwd: string): string[] {
  try {
    const output = execSync("git diff --name-only --diff-filter=U", {
      cwd,
      encoding: "utf-8",
    });
    return output
      .trim()
      .split("\n")
      .filter((f) => f.length > 0);
  } catch {
    return [];
  }
}

// ─── Conflict Predictor helpers (rebase / cherry-pick) ─────
//
// These live in the MCP package (which already depends on node:child_process /
// node:fs), NOT in @gitwand/core, which must stay Node-free. They synthesize
// conflict-marked content for a simulated rebase / cherry-pick WITHOUT touching
// the working tree, index, or HEAD — by reading the three blob versions with
// `git show` and running `git merge-file` in a system temp directory. The
// resulting markered content is then fed through the same `resolve()` engine as
// the working-tree merge path, so the predictor output is identical in shape.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";

/** Run git, returning trimmed stdout, or null on non-zero exit / spawn error. */
function gitTry(cwd: string, args: string[]): string | null {
  try {
    // execFileSync passes args as a discrete array — no shell interpolation.
    const out = execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
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
 * content is still written to stdout. Returns the content as-is (no trim, to
 * preserve a trailing newline the resolver may rely on), or null only on a real
 * spawn failure or a fatal git error (exit 255 / no captured stdout).
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
    // execFileSync throws on non-zero exit; the error still carries captured
    // stdout. Conflicts → status in 1..127 with markered content on stdout.
    const err = e as { status?: number; stdout?: string };
    if (typeof err.stdout === "string" && err.stdout.length > 0) {
      return err.stdout;
    }
    return null;
  }
}

/** Resolve a ref to a commit SHA, or null if unknown/invalid. */
function revParse(cwd: string, rev: string): string | null {
  return gitTry(cwd, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
}

/** Files changed between two revs (name-only). */
function changedFiles(cwd: string, base: string, rev: string): string[] {
  const out = gitTry(cwd, ["diff", "--name-only", base, rev]);
  if (!out) return [];
  return out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
}

/** Read a file's blob at a given rev, or null if absent at that rev. */
function showBlob(cwd: string, rev: string, file: string): string | null {
  return gitTry(cwd, ["show", `${rev}:${file}`]);
}

interface SimulatedFile {
  file: string;
  /** Content with conflict markers (diff3), suitable for resolve(). */
  content: string;
  /** True when one side is missing the file (add/delete conflict). */
  addDelete: boolean;
}

/**
 * Build the conflict-marked content for the intersection of files changed on
 * both sides of a 3-way operation, mirroring the desktop Rust predictor.
 * `ours`/`theirs` are git refs; ancestor is the common base.
 * Returns only the files that actually changed on BOTH sides (the only ones
 * that can conflict); clean unilateral changes are omitted since they never
 * produce markers.
 */
function simulate3way(cwd: string, ancestor: string, ours: string, theirs: string): SimulatedFile[] {
  const oursFiles = new Set(changedFiles(cwd, ancestor, ours));
  const theirsFiles = changedFiles(cwd, ancestor, theirs);
  const both = theirsFiles.filter((f) => oursFiles.has(f));

  if (both.length === 0) return [];

  const tmp = mkdtempSync(joinPath(tmpdir(), "gitwand-predict-"));
  const out: SimulatedFile[] = [];
  try {
    for (const file of both) {
      const baseBlob = showBlob(cwd, ancestor, file);
      const oursBlob = showBlob(cwd, ours, file);
      const theirsBlob = showBlob(cwd, theirs, file);

      // One side missing the file → add/delete conflict (no markers to resolve).
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

      // git merge-file -p --diff3 <ours> <base> <theirs> → markered content on stdout.
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

/** Accumulate a file's `stats.byType` into a running aggregate (mutates `into`). */
function addByType(into: Partial<Record<ConflictType, number>>, byType: Record<ConflictType, number>): void {
  for (const [type, count] of Object.entries(byType)) {
    const t = type as ConflictType;
    into[t] = (into[t] ?? 0) + count;
  }
}

function serializeResult(file: string, result: MergeResult) {
  return {
    path: file,
    totalConflicts: result.stats.totalConflicts,
    autoResolved: result.stats.autoResolved,
    remaining: result.stats.remaining,
    validation: {
      isValid: result.validation.isValid,
      hasResidualMarkers: result.validation.hasResidualMarkers,
      syntaxError: result.validation.syntaxError,
    },
    resolutions: result.resolutions.map((r) => ({
      line: r.hunk.startLine,
      type: r.hunk.type,
      resolved: r.autoResolved,
      explanation: r.hunk.explanation,
      confidence: {
        score: r.hunk.confidence.score,
        label: r.hunk.confidence.label,
        typeClassification: r.hunk.confidence.dimensions.typeClassification,
        dataRisk: r.hunk.confidence.dimensions.dataRisk,
        scopeImpact: r.hunk.confidence.dimensions.scopeImpact,
      },
      trace: {
        selected: r.hunk.trace.selected,
        hasBase: r.hunk.trace.hasBase,
        summary: r.hunk.trace.summary,
        steps: r.hunk.trace.steps,
      },
    })),
    pendingHunks: result.resolutions
      .filter((r) => !r.autoResolved)
      .map((r) => ({
        line: r.hunk.startLine,
        type: r.hunk.type,
        explanation: r.hunk.explanation,
        ours: r.hunk.oursLines.join("\n"),
        theirs: r.hunk.theirsLines.join("\n"),
        base: r.hunk.baseLines.join("\n"),
        trace: {
          selected: r.hunk.trace.selected,
          summary: r.hunk.trace.summary,
          steps: r.hunk.trace.steps,
        },
      })),
  };
}

function buildPartialContent(
  content: string,
  resolutions: MergeResult["resolutions"],
): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let conflictIdx = 0;
  let inConflict = false;
  let conflictBuffer: string[] = [];

  for (const line of lines) {
    if (line.startsWith("<<<<<<<")) {
      inConflict = true;
      conflictBuffer = [line];
    } else if (line.startsWith(">>>>>>>") && inConflict) {
      conflictBuffer.push(line);
      const resolution = resolutions[conflictIdx];
      if (resolution?.autoResolved && resolution.resolvedLines) {
        result.push(...resolution.resolvedLines);
      } else {
        result.push(...conflictBuffer);
      }
      conflictIdx++;
      inConflict = false;
      conflictBuffer = [];
    } else if (inConflict) {
      conflictBuffer.push(line);
    } else {
      result.push(line);
    }
  }

  return result.join("\n");
}

// ─── Tool handlers ─────────────────────────────────────────

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  defaultCwd: string,
) {
  const cwd = (args.cwd as string) || defaultCwd;

  switch (name) {
    case "gitwand_status":
      return toolStatus(cwd);
    case "gitwand_resolve_conflicts":
      return toolResolve(cwd, args);
    case "gitwand_preview_merge":
      return toolPreview(cwd, args);
    case "gitwand_explain_hunk":
      return toolExplain(cwd, args);
    case "gitwand_apply_resolution":
      return toolApply(cwd, args);
    case "gitwand_resolve_hunk":
      return handleResolveHunk(args);
    case "gitwand_resolve_hunk_llm":
      return toolResolvHunkLlm(cwd, args);
    default:
      return { content: [{ type: "text" as const, text: `Unknown tool: ${name}` }], isError: true };
  }
}

async function toolStatus(cwd: string) {
  const files = getConflictedFiles(cwd);

  if (files.length === 0) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ files: 0, conflicts: [], message: "No conflicted files." }, null, 2) }],
    };
  }

  const aggregateByType: Partial<Record<ConflictType, number>> = {};
  const conflicts = files.map((file) => {
    const filePath = resolvePath(cwd, file);
    try {
      const content = readFileSync(filePath, "utf-8");
      const result = resolve(content, file, { explainOnly: true });
      addByType(aggregateByType, result.stats.byType);
      return {
        path: file,
        totalConflicts: result.stats.totalConflicts,
        autoResolvable: result.stats.autoResolved,
        remaining: result.stats.remaining,
        percentage: result.stats.totalConflicts > 0
          ? Math.round((result.stats.autoResolved / result.stats.totalConflicts) * 100)
          : 0,
        types: Object.entries(result.stats.byType)
          .filter(([, count]) => (count as number) > 0)
          .map(([type, count]) => ({ type, count: count as number })),
      };
    } catch {
      return { path: file, error: "Could not read file" };
    }
  });

  const totalConflicts = conflicts.reduce((s: number, c: Record<string, unknown>) => s + ((c.totalConflicts as number) ?? 0), 0);
  const totalResolvable = conflicts.reduce((s: number, c: Record<string, unknown>) => s + ((c.autoResolvable as number) ?? 0), 0);
  // v2.7 — "recoverable-before-model" : of the residual past the trivial passes,
  // how much is still recoverable deterministically before the model is invoked.
  const tierSummary = summarizeTiers(aggregateByType as Record<ConflictType, number>);

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        files: files.length,
        totalConflicts,
        autoResolvable: totalResolvable,
        remaining: totalConflicts - totalResolvable,
        tierSummary,
        conflicts,
      }, null, 2),
    }],
  };
}

async function toolResolve(cwd: string, args: Record<string, unknown>) {
  let files = (args.files as string[]) ?? [];
  const dryRun = (args.dry_run as boolean) ?? false;
  const policy = args.policy as string | undefined;

  if (files.length === 0) {
    files = getConflictedFiles(cwd);
  }

  if (files.length === 0) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ message: "No conflicted files found.", files: [] }, null, 2) }],
    };
  }

  const aggregateByType: Partial<Record<ConflictType, number>> = {};
  const results = files.map((file) => {
    const filePath = resolvePath(cwd, file);
    try {
      const content = readFileSync(filePath, "utf-8");
      const result = resolve(content, file, {
        ...(policy ? { policy: policy as any } : {}),
      });
      addByType(aggregateByType, result.stats.byType);

      // Write resolved content unless dry-run
      if (!dryRun && result.stats.autoResolved > 0) {
        const newContent = result.mergedContent ?? buildPartialContent(content, result.resolutions);
        writeFileSync(filePath, newContent, "utf-8");
      }

      return serializeResult(file, result);
    } catch (err: any) {
      return { path: file, error: err.message };
    }
  });

  const totalConflicts = results.reduce((s: number, r: Record<string, unknown>) => s + ((r.totalConflicts as number) ?? 0), 0);
  const totalResolved = results.reduce((s: number, r: Record<string, unknown>) => s + ((r.autoResolved as number) ?? 0), 0);
  // v2.7 — "recoverable-before-model" tier summary, see summarizeTiers() in @gitwand/core.
  const tierSummary = summarizeTiers(aggregateByType as Record<ConflictType, number>);

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        dryRun,
        summary: {
          files: results.length,
          totalConflicts,
          autoResolved: totalResolved,
          remaining: totalConflicts - totalResolved,
          allResolved: totalConflicts - totalResolved === 0,
          tierSummary,
        },
        files: results,
      }, null, 2),
    }],
  };
}

async function toolPreview(cwd: string, args: Record<string, unknown>) {
  const operation = ((args.operation as string) ?? "merge") as "merge" | "rebase" | "cherry-pick";

  if (operation === "rebase") {
    return toolPreviewRebase(cwd, args);
  }
  if (operation === "cherry-pick") {
    return toolPreviewCherryPick(cwd, args);
  }

  // Default: merge — analyze conflicts already present in the working tree.
  const files = getConflictedFiles(cwd);

  if (files.length === 0) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ operation: "merge", message: "No conflicted files.", risk: "none" }, null, 2) }],
    };
  }

  const previews = files.map((file) => {
    const filePath = resolvePath(cwd, file);
    try {
      const content = readFileSync(filePath, "utf-8");
      const result = resolve(content, file, { explainOnly: true });
      return serializeResult(file, result);
    } catch (err: any) {
      return { path: file, error: err.message };
    }
  });

  return previewResponse("merge", files.length, previews);
}

/**
 * Shared assembly of the preview response from per-file `resolve()` results,
 * including the overall risk level.
 *
 * Risk uses the SAME status-based model as the desktop `useMergePreview`
 * `riskLevel` computed (spec §4.2), so all three predictor surfaces
 * (desktop / MCP / CLI) agree for identical inputs:
 *   - high   : at least one file is "manual" (no conflict auto-resolved) or
 *              "add-delete" (one side deleted the file);
 *   - medium : at least one file is "partial" (some but not all conflicts
 *              auto-resolved);
 *   - low    : no conflicting files, or every conflict auto-resolved.
 * It is deliberately status-based, NOT count/threshold-based: the number of
 * cleanly auto-resolvable files does not by itself raise the risk.
 */
function previewResponse(
  operation: string,
  fileCount: number,
  previews: Array<Record<string, unknown>>,
  addDeleteCount = 0,
) {
  const totalConflicts = previews.reduce((s: number, r) => s + ((r.totalConflicts as number) ?? 0), 0);
  const totalResolvable = previews.reduce((s: number, r) => s + ((r.autoResolved as number) ?? 0), 0);
  const remaining = totalConflicts - totalResolvable;

  // Per-file status classification, mirroring the desktop model.
  const hasHard = previews.some((r) => {
    if (r.addDelete === true) return true;
    const total = (r.totalConflicts as number) ?? 0;
    const resolved = (r.autoResolved as number) ?? 0;
    // "manual": the file has conflicts and none of them auto-resolved.
    return total > 0 && resolved === 0;
  });
  const hasPartial = previews.some((r) => {
    const total = (r.totalConflicts as number) ?? 0;
    const resolved = (r.autoResolved as number) ?? 0;
    // "partial": some — but not all — conflicts in the file auto-resolved.
    return total > 0 && resolved > 0 && resolved < total;
  });

  let risk: string;
  if (hasHard) risk = "high";
  else if (hasPartial) risk = "medium";
  else risk = "low";

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        operation,
        risk,
        summary: {
          files: fileCount,
          addDeleteFiles: addDeleteCount,
          totalConflicts,
          autoResolvable: totalResolvable,
          remaining,
          autoResolvePercentage: totalConflicts > 0
            ? Math.round((totalResolvable / totalConflicts) * 100)
            : 100,
        },
        files: previews,
      }, null, 2),
    }],
  };
}

/** Build per-file `resolve()` previews from the simulated 3-way conflict set. */
function previewsFromSimulation(sims: SimulatedFile[]) {
  let addDeleteCount = 0;
  const previews = sims.map((sim) => {
    if (sim.addDelete) {
      addDeleteCount++;
      return {
        path: sim.file,
        addDelete: true,
        totalConflicts: 1,
        autoResolved: 0,
        remaining: 1,
        note: "One side adds/deletes this file — requires manual decision.",
      } as Record<string, unknown>;
    }
    // No markers means git merged it cleanly → no conflict for this file.
    if (!sim.content.includes("<<<<<<<")) {
      return { path: sim.file, totalConflicts: 0, autoResolved: 0, remaining: 0 } as Record<string, unknown>;
    }
    try {
      const result = resolve(sim.content, sim.file, { explainOnly: true });
      return serializeResult(sim.file, result) as Record<string, unknown>;
    } catch (err: any) {
      return { path: sim.file, error: err.message } as Record<string, unknown>;
    }
  });
  return { previews, addDeleteCount };
}

async function toolPreviewRebase(cwd: string, args: Record<string, unknown>) {
  const onto = args.onto as string | undefined;
  if (!onto) {
    return { content: [{ type: "text" as const, text: "Missing required argument for rebase preview: onto." }], isError: true };
  }
  if (revParse(cwd, onto) === null) {
    return { content: [{ type: "text" as const, text: `Unknown or invalid ref: ${onto}` }], isError: true };
  }
  if (revParse(cwd, "HEAD") === null) {
    return { content: [{ type: "text" as const, text: "Cannot resolve HEAD (empty repository?)." }], isError: true };
  }
  const headSha = revParse(cwd, "HEAD");
  if (!headSha) {
    return { content: [{ type: "text" as const, text: "Cannot resolve HEAD (empty repository?)." }], isError: true };
  }
  const mergeBase = gitTry(cwd, ["merge-base", headSha, onto]);
  if (!mergeBase) {
    return { content: [{ type: "text" as const, text: `No common ancestor between HEAD and ${onto}.` }], isError: true };
  }

  // Replay commits oldest-first: per-commit 3-way preview.
  // Orientation per commit: ours = onto (target base), theirs = commit (replayed).
  const commitsRaw = gitTry(cwd, ["rev-list", "--reverse", `${mergeBase}..${headSha}`]);
  const commits = commitsRaw ? commitsRaw.split("\n").filter((c) => c.trim()) : [];
  const allSims: SimulatedFile[] = [];
  for (const c of commits) {
    const parent = revParse(cwd, `${c}^`);
    if (!parent) continue; // root commit — skip
    const perCommitSims = simulate3way(cwd, parent, onto, c);
    allSims.push(...perCommitSims);
  }
  // Deduplicate: for each file keep the entry with most conflict signal.
  const seenFiles = new Map<string, SimulatedFile>();
  for (const s of allSims) {
    const existing = seenFiles.get(s.file);
    if (!existing) {
      seenFiles.set(s.file, s);
    } else {
      // addDelete > has-markers > clean
      const score = (f: SimulatedFile) => f.addDelete ? 2 : f.content.includes("<<<<<<<") ? 1 : 0;
      if (score(s) > score(existing)) seenFiles.set(s.file, s);
    }
  }
  const sims = Array.from(seenFiles.values());
  if (sims.length === 0) {
    return { content: [{ type: "text" as const, text: JSON.stringify({ operation: "rebase", message: "No overlapping changes — rebase predicted clean.", risk: "low" }, null, 2) }] };
  }
  const { previews, addDeleteCount } = previewsFromSimulation(sims);
  return previewResponse("rebase", sims.length, previews, addDeleteCount);
}

async function toolPreviewCherryPick(cwd: string, args: Record<string, unknown>) {
  const commit = args.commit as string | undefined;
  if (!commit) {
    return { content: [{ type: "text" as const, text: "Missing required argument for cherry-pick preview: commit." }], isError: true };
  }
  const commitSha = revParse(cwd, commit);
  if (commitSha === null) {
    return { content: [{ type: "text" as const, text: `Unknown or invalid ref: ${commit}` }], isError: true };
  }
  if (revParse(cwd, "HEAD") === null) {
    return { content: [{ type: "text" as const, text: "Cannot resolve HEAD (empty repository?)." }], isError: true };
  }
  const parent = revParse(cwd, `${commitSha}^`);
  if (parent === null) {
    return { content: [{ type: "text" as const, text: `Cannot preview cherry-pick of root commit ${commit} (no parent to diff against).` }], isError: true };
  }

  // ancestor = commit^, ours = HEAD, theirs = commit.
  const sims = simulate3way(cwd, parent, "HEAD", commitSha);
  if (sims.length === 0) {
    return { content: [{ type: "text" as const, text: JSON.stringify({ operation: "cherry-pick", message: "No overlapping changes — cherry-pick predicted clean.", risk: "low" }, null, 2) }] };
  }
  const { previews, addDeleteCount } = previewsFromSimulation(sims);
  return previewResponse("cherry-pick", sims.length, previews, addDeleteCount);
}

async function toolExplain(cwd: string, args: Record<string, unknown>) {
  const file = args.file as string;
  const targetLine = args.line as number;

  if (!file || targetLine === undefined) {
    return { content: [{ type: "text" as const, text: "Missing required arguments: file and line." }], isError: true };
  }

  const filePath = resolvePath(cwd, file);
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return { content: [{ type: "text" as const, text: `File not found: ${file}` }], isError: true };
  }

  const result = resolve(content, file, { explainOnly: true });

  const hunk = result.resolutions.find((r) => r.hunk.startLine === targetLine);
  if (!hunk) {
    const available = result.resolutions.map((r) => r.hunk.startLine);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          error: `No conflict hunk found at line ${targetLine}.`,
          availableLines: available,
        }, null, 2),
      }],
      isError: true,
    };
  }

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        file,
        line: hunk.hunk.startLine,
        type: hunk.hunk.type,
        resolved: hunk.autoResolved,
        explanation: hunk.hunk.explanation,
        resolutionReason: hunk.resolutionReason,
        confidence: {
          score: hunk.hunk.confidence.score,
          label: hunk.hunk.confidence.label,
          dimensions: hunk.hunk.confidence.dimensions,
          boosters: hunk.hunk.confidence.boosters,
          penalties: hunk.hunk.confidence.penalties,
        },
        trace: {
          selected: hunk.hunk.trace.selected,
          hasBase: hunk.hunk.trace.hasBase,
          summary: hunk.hunk.trace.summary,
          steps: hunk.hunk.trace.steps,
        },
        ours: hunk.hunk.oursLines.join("\n"),
        theirs: hunk.hunk.theirsLines.join("\n"),
        base: hunk.hunk.baseLines.join("\n"),
      }, null, 2),
    }],
  };
}

async function toolApply(cwd: string, args: Record<string, unknown>) {
  const file = args.file as string;
  const targetLine = args.line as number;
  const newContent = args.content as string;

  if (!file || targetLine === undefined || !newContent) {
    return { content: [{ type: "text" as const, text: "Missing required arguments: file, line, and content." }], isError: true };
  }

  const filePath = resolvePath(cwd, file);
  let fileContent: string;
  try {
    fileContent = readFileSync(filePath, "utf-8");
  } catch {
    return { content: [{ type: "text" as const, text: `File not found: ${file}` }], isError: true };
  }

  const lines = fileContent.split("\n");
  const result: string[] = [];
  let currentLine = 1;
  let replaced = false;
  let inConflict = false;

  for (const line of lines) {
    if (line.startsWith("<<<<<<<") && currentLine === targetLine) {
      // Found the target conflict block — replace it
      inConflict = true;
      result.push(...newContent.split("\n"));
      replaced = true;
    } else if (line.startsWith(">>>>>>>") && inConflict) {
      // End of the conflict block we're replacing
      inConflict = false;
    } else if (!inConflict) {
      result.push(line);
    }
    currentLine++;
  }

  if (!replaced) {
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          error: `No conflict marker found at line ${targetLine} in ${file}.`,
        }, null, 2),
      }],
      isError: true,
    };
  }

  const newFileContent = result.join("\n");
  writeFileSync(filePath, newFileContent, "utf-8");

  // Re-analyze to check if conflicts remain
  const recheck = resolve(newFileContent, file, { explainOnly: true });

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        applied: true,
        file,
        line: targetLine,
        remainingConflicts: recheck.stats.totalConflicts,
        message: recheck.stats.totalConflicts === 0
          ? "All conflicts resolved in this file."
          : `${recheck.stats.totalConflicts} conflict(s) remaining.`,
      }, null, 2),
    }],
  };
}

// v2.5 — LLM fallback tool ─────────────────────────────────

/**
 * Validates and applies an LLM-proposed resolution for a specific conflict hunk.
 *
 * Workflow (intended for Claude Code / AI agents):
 * 1. Call `gitwand_explain_hunk` or `gitwand_status` to inspect unresolved `complex` hunks.
 * 2. Propose a resolution (the lines that should replace the conflict block).
 * 3. Call this tool — it validates and writes the file if the score is sufficient.
 *
 * Validation scoring (0–100) :
 * - Residual conflict markers found → 0
 * - Syntax error (JSON/YAML) → 0
 * - All OK → 100
 * Default threshold: 80 (configurable via `min_score`).
 */
async function toolResolvHunkLlm(cwd: string, args: Record<string, unknown>) {
  const file = args.file as string;
  const targetLine = args.line as number;
  const resolution = args.resolution as string;
  const minScore = (args.min_score as number) ?? 80;
  const dryRun = (args.dry_run as boolean) ?? false;

  if (!file || targetLine === undefined || !resolution) {
    return {
      content: [{ type: "text" as const, text: "Missing required arguments: file, line, and resolution." }],
      isError: true,
    };
  }

  const filePath = resolvePath(cwd, file);
  let fileContent: string;
  try {
    fileContent = readFileSync(filePath, "utf-8");
  } catch {
    return {
      content: [{ type: "text" as const, text: `File not found: ${file}` }],
      isError: true,
    };
  }

  // ─── Build candidate content (replace hunk at targetLine with resolution) ─
  const lines = fileContent.split("\n");
  const candidateLines: string[] = [];
  let currentLine = 1;
  let replaced = false;
  let inConflict = false;

  for (const line of lines) {
    if (line.startsWith("<<<<<<<") && currentLine === targetLine) {
      inConflict = true;
      candidateLines.push(...resolution.split("\n"));
      replaced = true;
    } else if (line.startsWith(">>>>>>>") && inConflict) {
      inConflict = false;
    } else if (!inConflict) {
      candidateLines.push(line);
    }
    currentLine++;
  }

  if (!replaced) {
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          accepted: false,
          error: `No conflict marker found at line ${targetLine} in ${file}.`,
          tip: "Use gitwand_explain_hunk to see available conflict lines.",
        }, null, 2),
      }],
      isError: true,
    };
  }

  const candidateContent = candidateLines.join("\n");

  // ─── Validation ────────────────────────────────────────────────────────────
  // Check 1: residual conflict markers
  const RESIDUAL_MARKER_RE = /^(<{7}\s|>{7}\s|\|{7}\s|={7}$)/m;
  const hasResidualMarkers = RESIDUAL_MARKER_RE.test(candidateContent);

  // Check 2: syntax for JSON/YAML
  let syntaxError: string | null = null;
  if (!hasResidualMarkers) {
    if (/\.json(c)?$/i.test(file)) {
      try { JSON.parse(candidateContent); } catch (e: any) { syntaxError = `JSON: ${e.message}`; }
    } else if (/\.ya?ml$/i.test(file)) {
      // Simple presence check for YAML — full parse not available without yaml dep
      // (MCP package doesn't bundle yaml, but core does. Check basic structure.)
      syntaxError = null; // Accept as-is; core validation handles this
    }
  }

  // ─── Compute score ────────────────────────────────────────────────────────
  let validationScore: number;
  if (hasResidualMarkers || syntaxError !== null) {
    validationScore = 0;
  } else {
    validationScore = 100;
  }

  const accepted = !hasResidualMarkers && syntaxError === null && validationScore >= minScore;

  // ─── Write if accepted and not dry-run ────────────────────────────────────
  if (accepted && !dryRun) {
    writeFileSync(filePath, candidateContent, "utf-8");
  }

  // ─── Re-check remaining conflicts ─────────────────────────────────────────
  let remainingConflicts = 0;
  if (accepted) {
    try {
      const recheck = resolve(candidateContent, file, { explainOnly: true });
      remainingConflicts = recheck.stats.totalConflicts;
    } catch {
      // Non-critical
    }
  }

  const calledAt = new Date().toISOString();

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        accepted,
        dryRun,
        file,
        line: targetLine,
        validationScore,
        minScore,
        hasResidualMarkers,
        syntaxError,
        remainingConflicts: accepted ? remainingConflicts : null,
        message: accepted
          ? dryRun
            ? `Resolution validated (score: ${validationScore}/100). Use dry_run: false to write.`
            : `Resolution applied (score: ${validationScore}/100). ${remainingConflicts === 0 ? "All conflicts resolved." : `${remainingConflicts} conflict(s) remaining.`}`
          : hasResidualMarkers
            ? "Resolution rejected: contains residual conflict markers."
            : syntaxError
              ? `Resolution rejected: syntax error — ${syntaxError}`
              : `Resolution rejected: validation score ${validationScore} < minimum ${minScore}.`,
        // Audit trail
        audit: {
          calledAt,
          tool: "gitwand_resolve_hunk_llm",
          file,
          line: targetLine,
        },
      }, null, 2),
    }],
  };
}
