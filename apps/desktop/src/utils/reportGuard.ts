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
  const addedLines = body.split("\n").map((text, i) => ({ line: i + 1, text }));
  const findings = scanSecrets([{ path: "issue-body.md", addedLines }], {
    enabled: true,
    extraPatterns: opts.extraPatterns,
    ignore: [],
    entropyThreshold: opts.entropyThreshold,
  });
  const blocks = (f: SecretFinding) => opts.blockAt === "medium" && f.severity !== "low";
  return { blocking: findings.filter(blocks), warnings: findings.filter((f) => !blocks(f)) };
}
