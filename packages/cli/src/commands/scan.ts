/**
 * Commande `gitwand scan` — scanner de secrets sur les lignes ajoutées en staging (v3.5.0).
 *
 * Extrait `git diff --cached --unified=0` avec la MÊME state machine que le backend Rust
 * (`apps/desktop/src-tauri/src/commands/secrets.rs` `extract_staged_added_lines`) et la route
 * `dev-server.mjs` `/api/scan-secrets` — les trois doivent rester en synchronisation (gotcha
 * diff-parsing AGENTS.md : une ligne ajoutée commence par un simple `+`, jamais confondre avec
 * le header `+++ `). Résout `.gitwandrc` `secrets` via `@gitwand/core`, puis délègue le matching
 * au même moteur pur `scanSecrets()` que le backend Rust et le dev-server.
 *
 * Non-blocking par défaut (exit 0) — c'est le CLI qui alimente le hook pre-commit optionnel
 * (Task 13), lequel passe `--strict` pour effectivement bloquer le commit sur un finding.
 *
 * Ne JAMAIS imprimer la valeur brute d'un secret — uniquement `redactedExcerpt` (déjà masqué).
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseGitwandrc,
  scanSecrets,
  type ScanFileInput,
  type SecretFinding,
  type SecretsScanConfig,
} from "@gitwand/core";

import { c } from "../ui.js";
import { findGitRoot } from "../llm-config.js";

/** Matches the desktop default (useSettings.ts `secretsEntropyThreshold`). */
const DEFAULT_ENTROPY_THRESHOLD = 4.0;

/**
 * Runs `git diff --cached --unified=0 --no-color`, tolerant on failure (returns "" if git is
 * unavailable or we're not in a repo — same tolerant style as `getConflictedFiles()`).
 */
function getStagedDiff(cwd: string): string {
  try {
    return execSync("git diff --cached --unified=0 --no-color", {
      encoding: "utf-8",
      cwd,
      maxBuffer: 1024 * 1024 * 32,
    });
  } catch {
    return "";
  }
}

/**
 * Parses `git diff --cached --unified=0` output into `ScanFileInput[]`, keeping only
 * `+`-prefixed content lines (never the `+++` header, never context/removed lines).
 */
export function extractStagedAddedLines(diffText: string): ScanFileInput[] {
  const files: ScanFileInput[] = [];
  let currentPath: string | null = null;
  let currentLines: Array<{ line: number; text: string }> = [];
  let newLineNo = 0;

  function flush(): void {
    if (currentPath !== null && currentLines.length > 0) {
      files.push({ path: currentPath, addedLines: currentLines });
    }
    currentPath = null;
    currentLines = [];
  }

  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
    } else if (line.startsWith("+++ ")) {
      // "+++ b/<path>" for a file with new-side content, "+++ /dev/null" for a deletion.
      const rest = line.slice(4);
      currentPath = rest === "/dev/null" ? null : rest.replace(/^b\//, "");
    } else if (line.startsWith("@@")) {
      const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      newLineNo = match ? parseInt(match[1], 10) : 0;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      if (currentPath !== null) {
        currentLines.push({ line: newLineNo, text: line.slice(1) });
      }
      newLineNo++;
    }
    // `-`-prefixed removed lines are irrelevant for the added-lines-only scan surface.
  }
  flush();

  return files;
}

/** Resolves the effective `SecretsScanConfig` from `.gitwandrc` (or its `.json` sibling). */
function loadSecretsConfig(repoRoot: string | null): SecretsScanConfig {
  const fallback: SecretsScanConfig = {
    enabled: true,
    extraPatterns: [],
    ignore: [],
    entropyThreshold: DEFAULT_ENTROPY_THRESHOLD,
  };
  if (!repoRoot) return fallback;

  for (const filename of [".gitwandrc", ".gitwandrc.json"]) {
    let content: string;
    try {
      content = readFileSync(join(repoRoot, filename), "utf-8");
    } catch {
      continue;
    }
    const parsed = parseGitwandrc(content);
    if (parsed === null) continue;
    return {
      enabled: parsed.secrets?.enabled ?? true,
      extraPatterns: parsed.secrets?.patterns ?? [],
      ignore: parsed.secrets?.ignore ?? [],
      entropyThreshold: parsed.secrets?.entropyThreshold ?? DEFAULT_ENTROPY_THRESHOLD,
    };
  }
  return fallback;
}

function severityColor(severity: SecretFinding["severity"]): string {
  if (severity === "high") return c.red;
  if (severity === "medium") return c.yellow;
  return c.cyan;
}

/**
 * `gitwand scan [--staged] [--json] [--strict]`
 *
 * `--staged` is the (only, default) mode today — accepted for forward compatibility /
 * self-documentation, since a pre-commit hook always scans the index, not the working tree.
 * `--json` prints a machine-readable `{ findings: SecretFinding[] }` payload (used by the
 * pre-commit hook and CI). `--strict` sets exit code 1 when findings exist — omit it for the
 * default non-blocking UX (mirrors the desktop app: informational, never a hard stop on its own).
 */
export async function cmdScan(flags: Record<string, boolean | string>): Promise<void> {
  const isJson = !!flags.json;
  const strict = !!flags.strict;

  const repoRoot = findGitRoot();
  const cwd = repoRoot ?? process.cwd();
  const diffText = getStagedDiff(cwd);
  const files = extractStagedAddedLines(diffText);
  const config = loadSecretsConfig(repoRoot);

  const findings = config.enabled ? scanSecrets(files, config) : [];

  if (isJson) {
    console.log(JSON.stringify({ findings }, null, 2));
  } else if (findings.length === 0) {
    console.log(`${c.green}No secrets detected in staged changes.${c.reset}`);
  } else {
    console.log(`${c.yellow}${findings.length} potential secret(s) found in staged changes:${c.reset}\n`);
    for (const f of findings) {
      const color = severityColor(f.severity);
      console.log(
        `  ${color}${f.severity.toUpperCase()}${c.reset} ${f.file}:${f.line} [${f.patternId}] ${f.redactedExcerpt}`,
      );
    }
    console.log();
  }

  if (findings.length > 0 && strict) {
    process.exitCode = 1;
  }
}
