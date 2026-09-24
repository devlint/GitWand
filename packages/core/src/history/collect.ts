/**
 * v3.11.1 — Collect the history of one conflict hunk.
 *
 * Pure orchestration over an injected `GitRunner`: this module decides which
 * git commands to run and parses their output, but never spawns anything.
 * Never rejects: every failure becomes an `unavailable` side with a reason.
 *
 * Budget: `timeoutMs` (default 2000) per call, i.e. per hunk. The per-file
 * queries (merge-base, the two staged sides) are cached and count against
 * the budget of the first hunk that triggers them.
 */

import type { GitRunner, HistoryRefs, HistoryUnavailableReason, HunkHistory, SideHistory } from "./types.js";
import { LOG_FORMAT, isPureMove, parseLog } from "./parse.js";
import { locateBlock } from "./locate.js";

export class HistoryTimeout extends Error {
  constructor() {
    super("git history collection timed out");
    this.name = "HistoryTimeout";
  }
}

interface FileState {
  mergeBase: string | null;
  /** Lines of `:2:path`, or null when that stage does not exist. */
  ours: string[] | null;
  /** Lines of `:3:path`, or null when that stage does not exist. */
  theirs: string[] | null;
}

export interface HistoryCache {
  files: Map<string, Promise<FileState>>;
}

export function createHistoryCache(): HistoryCache {
  return { files: new Map() };
}

export interface CollectInput {
  filePath: string;
  hunk: { oursLines: string[]; theirsLines: string[]; startLine: number };
  refs: HistoryRefs;
  cache?: HistoryCache;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2000;

const unavailable = (reason: HistoryUnavailableReason): SideHistory => ({ status: "unavailable", reason, commits: [] });

const both = (reason: HistoryUnavailableReason, mergeBase: string | null = null): HunkHistory => ({
  mergeBase,
  ours: unavailable(reason),
  theirs: unavailable(reason),
});

type Run = (args: string[]) => Promise<{ stdout: string; exitCode: number }>;

function bounded(runGit: GitRunner, deadline: number): Run {
  return async (args) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new HistoryTimeout();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        runGit(args),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new HistoryTimeout()), remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
}

const reasonFor = (err: unknown): HistoryUnavailableReason => (err instanceof HistoryTimeout ? "timeout" : "git-error");

async function loadFileState(run: Run, filePath: string, oursSha: string, theirsSha: string): Promise<FileState> {
  const mb = await run(["merge-base", oursSha, theirsSha]);
  // Exit 1 with empty output is git's "no common ancestor", not an error.
  if (mb.exitCode !== 0 && mb.exitCode !== 1) throw new Error(`merge-base exited ${mb.exitCode}`);
  const mergeBase = mb.exitCode === 0 ? mb.stdout.trim() || null : null;
  const [o, t] = await Promise.all([run(["show", `:2:${filePath}`]), run(["show", `:3:${filePath}`])]);
  return {
    mergeBase,
    ours: o.exitCode === 0 ? o.stdout.split("\n") : null,
    theirs: t.exitCode === 0 ? t.stdout.split("\n") : null,
  };
}

async function sideHistory(
  run: Run,
  filePath: string,
  range: string,
  sideFile: string[] | null,
  block: string[],
  nearLine: number,
): Promise<SideHistory> {
  try {
    if (sideFile === null || block.length === 0) {
      const r = await run(["log", "--no-color", range, "--no-merges", "-n", "3", `--format=${LOG_FORMAT}`, "--", filePath]);
      if (r.exitCode !== 0) return unavailable("git-error");
      const commits = parseLog(r.stdout).map((c) => ({ ...c, rangeDiff: "" }));
      return { status: commits.length > 0 ? "ok" : "unavailable", reason: "side-deleted", commits };
    }
    const loc = locateBlock(sideFile, block, nearLine);
    if (!loc) return unavailable("locate-failed");
    const r = await run([
      "log", "--no-color", "-L", `${loc.start},${loc.end}:${filePath}`, range,
      "--no-merges", "-n", "5", `--format=${LOG_FORMAT}`,
    ]);
    if (r.exitCode !== 0) return unavailable("git-error");
    const commits = parseLog(r.stdout).filter((c) => !isPureMove(c.rangeDiff));
    return commits.length > 0 ? { status: "ok", commits } : unavailable("no-commits");
  } catch (err) {
    return unavailable(reasonFor(err));
  }
}

export async function collectHunkHistory(runGit: GitRunner, input: CollectInput): Promise<HunkHistory> {
  const { oursSha, theirsSha, operation } = input.refs;
  if (!oursSha || !theirsSha) return both("no-sha");

  const run = bounded(runGit, Date.now() + (input.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const cache = input.cache ?? createHistoryCache();
  const key = `${input.filePath}\0${oursSha}\0${theirsSha}`;

  let file: FileState;
  try {
    let pending = cache.files.get(key);
    if (!pending) {
      pending = loadFileState(run, input.filePath, oursSha, theirsSha);
      cache.files.set(key, pending);
      // A failed load must not poison the next hunk: let it retry.
      pending.catch(() => cache.files.delete(key));
    }
    file = await pending;
  } catch (err) {
    return both(reasonFor(err));
  }

  if (!file.mergeBase) return both("no-merge-base");
  // Both stages missing means the file is no longer unmerged in the index
  // (e.g. already `git add`ed), not that both sides deleted it.
  if (file.ours === null && file.theirs === null) return both("locate-failed", file.mergeBase);

  // cherry-pick / revert merge against the parent of the applied commit, so
  // theirs is exactly that one commit rather than its whole branch.
  const theirsRange =
    operation === "cherry-pick" || operation === "revert" ? `${theirsSha}~1..${theirsSha}` : `${file.mergeBase}..${theirsSha}`;
  const oursRange = `${file.mergeBase}..${oursSha}`;

  const [ours, theirs] = await Promise.all([
    sideHistory(run, input.filePath, oursRange, file.ours, input.hunk.oursLines, input.hunk.startLine),
    sideHistory(run, input.filePath, theirsRange, file.theirs, input.hunk.theirsLines, input.hunk.startLine),
  ]);
  return { mergeBase: file.mergeBase, ours, theirs };
}
