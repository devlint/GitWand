/**
 * @file reportGuard.ts
 *
 * The secrets scan of a "bad resolution" report's body (#301). On the way to
 * GitWand's public repository a known secret pattern (severity high or
 * medium) blocks the report; entropy alone (severity low: lockfile integrity
 * hashes, minified code) only warns. On the user's own repository nothing
 * blocks. The scan is always on, whatever the repository's config, and
 * ignores no path: the built-in ignore list would skip lockfiles.
 *
 * The implementation lives in `@gitwand/core` (secrets/report.ts), shared with
 * the MCP `gitwand_create_issue` tool.
 */
export { scanReportBody, type ReportScan } from "@gitwand/core";
