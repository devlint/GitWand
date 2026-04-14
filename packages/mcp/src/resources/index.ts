/**
 * MCP Resources — context the LLM can read.
 *
 * gitwand://repo/conflicts    → current conflict state
 * gitwand://repo/policy       → .gitwandrc contents
 * gitwand://hunk/{file}/{line} → raw hunk content for a specific conflict
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve as resolvePath, join } from "node:path";
import { resolve } from "@gitwand/core";

// ─── Resource definitions ──────────────────────────────────

export function registerResources() {
  return [
    {
      uri: "gitwand://repo/conflicts",
      name: "Current Conflicts",
      description:
        "Lists all conflicted files in the repo with conflict counts, types, and auto-resolvability. Use this to understand the current merge state before taking action.",
      mimeType: "application/json",
    },
    {
      uri: "gitwand://repo/policy",
      name: "Merge Policy (.gitwandrc)",
      description:
        "The .gitwandrc configuration file that controls GitWand's resolution behavior: merge policies, confidence thresholds, and per-path overrides.",
      mimeType: "application/json",
    },
  ];
}

// ─── Resource handlers ─────────────────────────────────────

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

export async function handleResourceRead(uri: string, cwd: string) {
  // gitwand://repo/conflicts
  if (uri === "gitwand://repo/conflicts") {
    return readConflictsResource(cwd);
  }

  // gitwand://repo/policy
  if (uri === "gitwand://repo/policy") {
    return readPolicyResource(cwd);
  }

  // gitwand://hunk/{file}/{line}
  const hunkMatch = uri.match(/^gitwand:\/\/hunk\/(.+)\/(\d+)$/);
  if (hunkMatch) {
    const [, file, lineStr] = hunkMatch;
    return readHunkResource(cwd, file, parseInt(lineStr, 10));
  }

  return {
    contents: [{
      uri,
      mimeType: "text/plain",
      text: `Unknown resource: ${uri}`,
    }],
  };
}

async function readConflictsResource(cwd: string) {
  const files = getConflictedFiles(cwd);

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
        byType: Object.entries(result.stats.byType)
          .filter(([, count]) => (count as number) > 0)
          .reduce((acc: Record<string, number>, [type, count]) => ({ ...acc, [type]: count as number }), {}),
      };
    } catch {
      return { path: file, error: "Could not read file" };
    }
  });

  return {
    contents: [{
      uri: "gitwand://repo/conflicts",
      mimeType: "application/json",
      text: JSON.stringify({ files: files.length, conflicts }, null, 2),
    }],
  };
}

async function readPolicyResource(cwd: string) {
  const rcPath = join(cwd, ".gitwandrc");
  let content: string;
  try {
    content = readFileSync(rcPath, "utf-8");
  } catch {
    content = JSON.stringify(
      {
        message: "No .gitwandrc found. Using default policy (prefer-theirs).",
        defaults: {
          policy: "prefer-theirs",
          minConfidence: "high",
          resolveWhitespace: true,
          resolveNonOverlapping: true,
        },
      },
      null,
      2,
    );
  }

  return {
    contents: [{
      uri: "gitwand://repo/policy",
      mimeType: "application/json",
      text: content,
    }],
  };
}

async function readHunkResource(cwd: string, file: string, targetLine: number) {
  const filePath = resolvePath(cwd, file);
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return {
      contents: [{
        uri: `gitwand://hunk/${file}/${targetLine}`,
        mimeType: "application/json",
        text: JSON.stringify({ error: `File not found: ${file}` }),
      }],
    };
  }

  const result = resolve(content, file, { explainOnly: true });
  const hunk = result.resolutions.find((r) => r.hunk.startLine === targetLine);

  if (!hunk) {
    return {
      contents: [{
        uri: `gitwand://hunk/${file}/${targetLine}`,
        mimeType: "application/json",
        text: JSON.stringify({
          error: `No hunk at line ${targetLine}`,
          availableLines: result.resolutions.map((r) => r.hunk.startLine),
        }),
      }],
    };
  }

  return {
    contents: [{
      uri: `gitwand://hunk/${file}/${targetLine}`,
      mimeType: "application/json",
      text: JSON.stringify({
        file,
        line: hunk.hunk.startLine,
        type: hunk.hunk.type,
        explanation: hunk.hunk.explanation,
        confidence: hunk.hunk.confidence,
        trace: hunk.hunk.trace,
        ours: hunk.hunk.oursLines.join("\n"),
        theirs: hunk.hunk.theirsLines.join("\n"),
        base: hunk.hunk.baseLines.join("\n"),
      }, null, 2),
    }],
  };
}
