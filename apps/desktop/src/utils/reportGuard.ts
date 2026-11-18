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
  const all = scanSecrets(files, { ...config, entropyThreshold: opts.entropyThreshold });
  // The scanner keeps its first findings in line order (SCAN_CAP): a
  // lockfile's hundreds of entropy hits could push a real secret past the
  // cut. Only then, a second pass without entropy finds every pattern hit.
  const capped = all.length >= SCAN_CAP;
  const patterns = capped
    ? scanSecrets(files, { ...config, entropyThreshold: 0 })
    : all.filter((f) => f.patternId !== "high_entropy");
  const entropy = all.filter((f) => f.patternId === "high_entropy");
  const blocks = (f: SecretFinding) => opts.blockAt === "medium" && f.severity !== "low";
  return {
    blocking: patterns.filter(blocks),
    warnings: [...patterns.filter((f) => !blocks(f)), ...entropy].sort((a, b) => a.line - b.line),
  };
}
