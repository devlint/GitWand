/**
 * @file reportGuard.ts
 *
 * The secrets scan of a "bad resolution" report's body (#301). On the way to
 * GitWand's public repository a known secret pattern (severity high or
 * medium) blocks the report; entropy alone (severity low: lockfile integrity
 * hashes, minified code) only warns. On the user's own repository nothing
 * blocks. The scan is always on, whatever the repository's config, and
 * ignores no path: the built-in ignore list would skip lockfiles.
 */
import { scanSecrets, type SecretFinding, type SecretPattern } from "@gitwand/core";

/** The core scanner's finding cap (`MAX_FINDINGS` in secrets/scanner.ts). */
const SCAN_CAP = 500;
/** Lines per scan: a line rarely holds more than a few tokens, so a slice
 *  stays far under SCAN_CAP. */
const SLICE_LINES = 50;

export interface ReportScan {
  /** Findings that keep the report from being sent. */
  blocking: SecretFinding[];
  /** Findings shown as a warning only. */
  warnings: SecretFinding[];
}

export function scanReportBody(
  body: string,
  opts: { extraPatterns: SecretPattern[]; entropyThreshold: number; blockAt: "medium" | "never" },
): ReportScan {
  // The scanner keeps its first SCAN_CAP findings: a lockfile's hundreds of
  // entropy hits would hide a real secret, or the true count, past the cut.
  // Scanned in slices small enough never to reach it (one finding per token).
  const lines = body.split("\n");
  const config = { enabled: true, extraPatterns: opts.extraPatterns, ignore: [], entropyThreshold: opts.entropyThreshold };
  const all: SecretFinding[] = [];
  for (let start = 0; start < lines.length; start += SLICE_LINES) {
    const addedLines = lines.slice(start, start + SLICE_LINES).map((text, i) => ({ line: start + i + 1, text }));
    const found = scanSecrets([{ path: "issue-body.md", addedLines }], config);
    if (found.length < SCAN_CAP) {
      all.push(...found);
      continue;
    }
    // One line alone filled the cap (minified code): the slice line by line,
    // its patterns found without entropy so none is cut.
    for (const l of addedLines) {
      all.push(...scanSecrets([{ path: "issue-body.md", addedLines: [l] }], { ...config, entropyThreshold: 0 }));
      all.push(
        ...scanSecrets([{ path: "issue-body.md", addedLines: [l] }], config).filter((f) => f.patternId === "high_entropy"),
      );
    }
  }
  const patterns = all.filter((f) => f.patternId !== "high_entropy");
  const entropy = all.filter((f) => f.patternId === "high_entropy");
  const blocks = (f: SecretFinding) => opts.blockAt === "medium" && f.severity !== "low";
  return {
    blocking: patterns.filter(blocks),
    warnings: [...patterns.filter((f) => !blocks(f)), ...entropy].sort((a, b) => a.line - b.line),
  };
}
