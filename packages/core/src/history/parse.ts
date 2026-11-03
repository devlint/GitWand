/**
 * v3.11.1 — Parsing of `git log` output produced with `LOG_FORMAT`.
 *
 * Each record starts with RS (0x1e); its fields are separated by US (0x1f).
 * With `-L`, git prints the range-limited patch after the last US, so the
 * trailing field of a record is the patch (empty for a plain `log -- path`).
 */

import type { HistoryCommit } from "./types.js";
import { classifyHunkLine, hunkBodyFromHeader, noHunkBody, type HunkBody } from "../hunk-body.js";

export const LOG_FORMAT = "%x1e%H%x1f%an%x1f%as%x1f%s%x1f%b%x1f";

const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export function parseLog(stdout: string): HistoryCommit[] {
  const commits: HistoryCommit[] = [];
  for (const record of stdout.split("\x1e").slice(1)) {
    const [sha = "", author = "", date = "", subject = "", body = "", ...rest] = record.split("\x1f");
    const cleanSha = sha.trim();
    if (!SHA_RE.test(cleanSha)) continue;
    commits.push({
      sha: cleanSha,
      author,
      date,
      subject,
      body: body.trim(),
      rangeDiff: rest.join("\x1f").trim(),
    });
  }
  return commits;
}

/**
 * True when a range patch removes and adds exactly the same lines (ignoring
 * surrounding whitespace): a move or a re-indent, with no semantic change.
 *
 * Only lines inside a hunk body count, bounded by the `@@` counts: a removed
 * `-- a/x` is the diff line `--- a/x`, which is a change, not a file header.
 */
export function isPureMove(rangeDiff: string): boolean {
  const removed: string[] = [];
  const added: string[] = [];
  let body: HunkBody = noHunkBody();
  for (const line of rangeDiff.split("\n")) {
    const kind = classifyHunkLine(body, line);
    if (kind === "delete") removed.push(line.slice(1).trim());
    else if (kind === "add") added.push(line.slice(1).trim());
    else if (kind === null) {
      if (line.startsWith("diff ")) body = noHunkBody();
      else if (line.startsWith("@@")) body = hunkBodyFromHeader(line);
    }
  }
  if (removed.length === 0 || removed.length !== added.length) return false;
  const a = [...removed].sort();
  const b = [...added].sort();
  return a.every((l, i) => l === b[i]);
}
