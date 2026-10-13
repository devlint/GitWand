/**
 * useAutoFastForward — opt-in "fast-forward the current branch after fetch".
 *
 * The 30 s background fetch (useRepoPoller → onFetchTick) may move the
 * checked-out branch forward, but only when it is *purely behind* its
 * upstream. It never merges, never rebases, never stashes: the v3.6.0
 * "Update branch" path (`--ff-only`) minus the stash. Anything else is left
 * alone and the toolbar tooltip names the single condition holding it back.
 *
 * Two layers:
 *   - `evaluateAutoFastForward` — pure verdict over a facts snapshot. The
 *     blocking order lives here and nowhere else.
 *   - `checkAutoFastForward` / `runAutoFastForward` — read the facts from the
 *     repository (never from cached UI state: it can be stale by the time a
 *     fetch ends) and, only when ready, run `git merge --ff-only @{upstream}`.
 *
 * Untracked files never block on their own; if the fast-forward would
 * overwrite one, git refuses and that refusal is reported as `gitRefused`.
 */

import { gitExec, gitRepoState } from "../utils/backend";

// ─── Verdict ────────────────────────────────────────────────

/**
 * Why a purely-behind branch is not fast-forwarded. The declaration order is
 * the evaluation order: the FIRST failing condition is the one reported.
 * `gitRefused` is not evaluated up front, it is what git itself answers.
 */
export type AutoFfBlockReason =
  | "detached"
  | "noUpstream"
  | "operation"
  | "busy"
  | "conflicts"
  | "localCommits"
  | "trackedEdits"
  | "gitRefused";

export interface AutoFfFacts {
  detached: boolean;
  hasUpstream: boolean;
  ahead: number;
  behind: number;
  /** A merge / rebase / cherry-pick / revert / bisect in progress, or null. */
  operation: string | null;
  /** The app itself is in the middle of a user-initiated git operation. */
  busy: boolean;
  conflicts: boolean;
  /** Staged or unstaged changes to tracked files (untracked files excluded). */
  trackedEdits: boolean;
}

export type AutoFfVerdict =
  | { kind: "idle" }
  | { kind: "ready" }
  | { kind: "blocked"; reason: Exclude<AutoFfBlockReason, "gitRefused"> };

export function evaluateAutoFastForward(f: AutoFfFacts): AutoFfVerdict {
  // A detached HEAD or a missing upstream has no meaningful "behind", so those
  // two are reported before the up-to-date check. The UI only surfaces a
  // reason when the branch is actually behind, so they stay silent there.
  if (f.detached) return { kind: "blocked", reason: "detached" };
  if (!f.hasUpstream) return { kind: "blocked", reason: "noUpstream" };
  if (f.behind <= 0) return { kind: "idle" };
  if (f.operation) return { kind: "blocked", reason: "operation" };
  if (f.busy) return { kind: "blocked", reason: "busy" };
  if (f.conflicts) return { kind: "blocked", reason: "conflicts" };
  if (f.ahead > 0) return { kind: "blocked", reason: "localCommits" };
  if (f.trackedEdits) return { kind: "blocked", reason: "trackedEdits" };
  return { kind: "ready" };
}

// ─── Facts ──────────────────────────────────────────────────

export interface AutoFfContext {
  /** True while the app runs its own git operation (push, pull, commit…). */
  busy: boolean;
}

/** Porcelain v1 XY codes that mean "unmerged". */
const UNMERGED = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

export async function readAutoFfFacts(cwd: string, ctx: AutoFfContext): Promise<AutoFfFacts> {
  const [head, upstream, counts, status, repoState, bisect] = await Promise.all([
    gitExec(cwd, ["symbolic-ref", "-q", "HEAD"]),
    gitExec(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
    gitExec(cwd, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]),
    gitExec(cwd, ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=no"]),
    gitRepoState(cwd).catch(() => null),
    // Exits non-zero ("We are not bisecting") when no bisect is running.
    gitExec(cwd, ["bisect", "log"]),
  ]);

  const hasUpstream = upstream.exitCode === 0 && upstream.stdout.trim() !== "";
  let ahead = 0;
  let behind = 0;
  if (hasUpstream && counts.exitCode === 0) {
    const [a, b] = counts.stdout.trim().split(/\s+/).map((n) => parseInt(n, 10));
    ahead = Number.isFinite(a) ? a : 0;
    behind = Number.isFinite(b) ? b : 0;
  }

  let conflicts = false;
  let trackedEdits = false;
  for (const line of (status.stdout ?? "").split("\n")) {
    if (line.length < 3) continue;
    trackedEdits = true;
    if (UNMERGED.has(line.slice(0, 2))) conflicts = true;
  }
  // An unreadable status must not be read as "clean".
  if (status.exitCode !== 0) trackedEdits = true;

  let operation: string | null = null;
  if (repoState && repoState.state !== "clean") operation = repoState.state;
  else if (repoState?.hasConflict) conflicts = true;
  else if (bisect.exitCode === 0) operation = "bisect";

  return {
    detached: head.exitCode !== 0,
    hasUpstream,
    ahead,
    behind,
    operation,
    busy: ctx.busy,
    conflicts,
    trackedEdits,
  };
}

/** Read-only: facts + verdict, nothing is modified. Drives the tooltip. */
export async function checkAutoFastForward(
  cwd: string,
  ctx: AutoFfContext,
): Promise<{ verdict: AutoFfVerdict; facts: AutoFfFacts }> {
  const facts = await readAutoFfFacts(cwd, ctx);
  return { verdict: evaluateAutoFastForward(facts), facts };
}

// ─── Run ────────────────────────────────────────────────────

export type AutoFfOutcome =
  | { kind: "idle" }
  | { kind: "blocked"; reason: AutoFfBlockReason; detail?: string }
  | { kind: "fastForwarded"; count: number; branch: string };

/**
 * Re-read every condition, then fast-forward if and only if the branch is
 * purely behind. `merge --ff-only` is the sole write: it cannot create a merge
 * commit, rebase, or touch the stash, and git refuses on its own when the
 * state moved between the check and the call (reported as `gitRefused`).
 * Never throws: a background action must not surface an error modal.
 */
export async function runAutoFastForward(cwd: string, ctx: AutoFfContext): Promise<AutoFfOutcome> {
  try {
    const { verdict, facts } = await checkAutoFastForward(cwd, ctx);
    if (verdict.kind === "idle") return { kind: "idle" };
    if (verdict.kind === "blocked") return { kind: "blocked", reason: verdict.reason };

    const branchRes = await gitExec(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
    const branch = branchRes.stdout.trim();
    const res = await gitExec(cwd, ["merge", "--ff-only", "--no-stat", "@{upstream}"]);
    if (res.exitCode !== 0) {
      return { kind: "blocked", reason: "gitRefused", detail: firstLine(res.stderr || res.stdout) };
    }
    return { kind: "fastForwarded", count: facts.behind, branch };
  } catch (err: any) {
    return { kind: "blocked", reason: "gitRefused", detail: firstLine(`${err?.message ?? err}`) };
  }
}

function firstLine(text: string): string {
  return (text ?? "").trim().split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
}
