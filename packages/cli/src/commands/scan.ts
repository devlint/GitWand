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

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyHunkLine,
  diffFileLineName,
  hunkBodyFromHeader,
  noHunkBody,
  parseGitwandrc,
  DEFAULT_ENTROPY_THRESHOLD,
  parseHunkHeader,
  scanSecrets,
  type HunkBody,
  type ScanFileInput,
  type SecretFinding,
  type SecretsScanConfig,
} from "@gitwand/core";

import { c } from "../ui.js";
import { findGitRoot } from "../llm-config.js";

/**
 * The git to run without a shell. On Windows, `where git` can list a
 * `git.cmd` wrapper before `git.exe`: the first `.exe` is taken, so a shim
 * earlier on PATH does not stop the scan when the real executable is there.
 */
function gitExecutable(): string {
  if (process.platform !== "win32") return "git";
  try {
    const found = execFileSync("where", ["git"], { encoding: "utf-8" })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => /\.exe$/i.test(l));
    return found ?? "git";
  } catch {
    return "git";
  }
}

/**
 * The staged bytes as a patch, tolerant on failure (returns "" when we're not in a repo —
 * same tolerant style as `getConflictedFiles()`), but `null` when the output was not seen
 * (git not runnable, output over the buffer): a scan that saw nothing must not pass as clean. The user's patch
 * config is pinned away as in the desktop backend (`PATCH_CONFIG` / `PATCH_FLAGS` in
 * apps/desktop/src-tauri/src/git/cmd.rs): an external diff tool or colour codes would
 * hide every added line, other prefixes would misname files, and textconv would scan a
 * rendering instead of the staged content.
 */
function getStagedDiff(cwd: string): string | null {
  try {
    return execFileSync(
      gitExecutable(),
      [
        "-c", "core.quotePath=false",
        "-c", "diff.noprefix=false",
        "-c", "diff.mnemonicPrefix=false",
        "-c", "diff.srcPrefix=a/",
        "-c", "diff.dstPrefix=b/",
        "-c", "diff.submodule=short",
        "diff", "--cached", "--unified=0", "--no-textconv", "--no-color", "--no-ext-diff",
      ],
      { encoding: "utf-8", cwd, maxBuffer: 1024 * 1024 * 32 },
    );
  } catch (err) {
    // git ran and exited non-zero (not a repository): nothing staged to scan.
    // Anything else (git not found, output over maxBuffer, killed) means the
    // staged changes were not seen at all.
    const e = err as NodeJS.ErrnoException & { status?: number | null };
    if (typeof e?.code !== "string" && typeof e?.status === "number" && e.status !== 0) return "";
    return null;
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

  // Remaining body of the current hunk, from its `@@` counts: inside it an added `++ token`
  // is the line `+++ token`, a hunk line — neither dropped nor read as a `+++ b/<path>` header.
  let body: HunkBody = noHunkBody();

  for (const line of diffText.split("\n")) {
    const kind = classifyHunkLine(body, line);
    if (kind) {
      if (kind === "add") {
        if (currentPath !== null) {
          currentLines.push({ line: newLineNo, text: line.slice(1) });
        }
        newLineNo++;
      }
      // `-`-prefixed removed lines are irrelevant for the added-lines-only scan surface.
    } else if (line.startsWith("diff --git ")) {
      body = noHunkBody();
      flush();
    } else if (line.startsWith("+++ ")) {
      // "+++ b/<path>" for a file with new-side content, "+++ /dev/null" for a deletion;
      // a name holding a space ends with a tab, an unusual one is C-quoted.
      // One it cannot read still names the file as printed: scanned, never skipped.
      const rest = line.slice(4);
      const raw = rest.endsWith("\t") ? rest.slice(0, -1) : rest;
      currentPath = diffFileLineName(rest, "b/") ?? (raw === "/dev/null" ? null : raw);
    } else if (line.startsWith("@@")) {
      const range = parseHunkHeader(line);
      newLineNo = range ? range.newStart : 0;
      body = hunkBodyFromHeader(line);
    }
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
  if (diffText === null) {
    // On Windows a `git.cmd` / `git.bat` wrapper is not an executable git can
    // be run as without a shell (and a shell would break the argv rule).
    const message =
      "git could not be run, or its output was too large: the staged changes could not be scanned " +
      "(on Windows, put git.exe itself on PATH: a git.cmd wrapper is not run).";
    if (isJson) console.log(JSON.stringify({ error: message, findings: [] }, null, 2));
    else console.error(`${c.red}${message}${c.reset}`);
    process.exitCode = 2;
    return;
  }
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
