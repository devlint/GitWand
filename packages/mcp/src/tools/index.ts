/**
 * MCP Tools — what the LLM can invoke.
 *
 * gitwand_status              → list conflicted files + complexity
 * gitwand_resolve_conflicts   → auto-resolve and return results + DecisionTrace
 * gitwand_preview_merge       → dry-run: simulate resolution, return stats
 * gitwand_explain_hunk        → explain why a specific hunk is "complex"
 * gitwand_apply_resolution    → apply a custom resolution to a specific hunk
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { resolve, type MergeResult } from "@gitwand/core";

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
        "Dry-run conflict resolution on all conflicted files. Shows how many conflicts GitWand can auto-resolve vs. how many need manual/LLM attention. Does NOT modify any files.",
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
      return toolPreview(cwd);
    case "gitwand_explain_hunk":
      return toolExplain(cwd, args);
    case "gitwand_apply_resolution":
      return toolApply(cwd, args);
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

  const conflicts = files.map((file) => {
    const filePath = resolvePath(cwd, file);
    try {
      const content = readFileSync(filePath, "utf-8");
      const result = resolve(content, file, { explainOnly: true });
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

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        files: files.length,
        totalConflicts,
        autoResolvable: totalResolvable,
        remaining: totalConflicts - totalResolvable,
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

  const results = files.map((file) => {
    const filePath = resolvePath(cwd, file);
    try {
      const content = readFileSync(filePath, "utf-8");
      const result = resolve(content, file, {
        ...(policy ? { policy: policy as any } : {}),
      });

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
        },
        files: results,
      }, null, 2),
    }],
  };
}

async function toolPreview(cwd: string) {
  const files = getConflictedFiles(cwd);

  if (files.length === 0) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ message: "No conflicted files.", risk: "none" }, null, 2) }],
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

  const totalConflicts = previews.reduce((s: number, r: Record<string, unknown>) => s + ((r.totalConflicts as number) ?? 0), 0);
  const totalResolvable = previews.reduce((s: number, r: Record<string, unknown>) => s + ((r.autoResolved as number) ?? 0), 0);
  const remaining = totalConflicts - totalResolvable;

  // Risk assessment
  let risk: string;
  if (remaining === 0) risk = "low";
  else if (remaining <= 2 && files.length <= 3) risk = "medium";
  else risk = "high";

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        risk,
        summary: {
          files: files.length,
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
