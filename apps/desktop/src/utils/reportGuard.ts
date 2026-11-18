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
  const files = [{ path: "issue-body.md", addedLines: body.split("\n").map((text, i) => ({ line: i + 1, text })) }];
  const config = { enabled: true, extraPatterns: opts.extraPatterns, ignore: [] };
  // Two passes: the scanner keeps its first 500 findings in line order, so a
  // lockfile's hundreds of entropy hits would push a real secret past the
  // cut. The pattern pass (no entropy) carries everything that can block.
  const patterns = scanSecrets(files, { ...config, entropyThreshold: 0 });
  const entropy =
    opts.entropyThreshold > 0
      ? scanSecrets(files, { ...config, entropyThreshold: opts.entropyThreshold }).filter((f) => f.patternId === "high_entropy")
      : [];
  const blocks = (f: SecretFinding) => opts.blockAt === "medium" && f.severity !== "low";
  return {
    blocking: patterns.filter(blocks),
    warnings: [...patterns.filter((f) => !blocks(f)), ...entropy].sort((a, b) => a.line - b.line),
  };
}
