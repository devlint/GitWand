/**
 * useAutoFastForward — opt-in "fast-forward the current branch after fetch".
 *
 * The 30 s background fetch (useRepoPoller → onFetchTick) may move the
 * checked-out branch forward, but only when it is *purely behind* its
 * upstream. It never merges, never rebases, never stashes: the v3.6.0
 * "Update branch" path (`--ff-only`) minus the stash. Anything else is left
 * alone and the toolbar tooltip names the single condition holding it back.
 *
 * Three layers:
 *   - `evaluateAutoFastForward` — pure verdict over a facts snapshot. The
 *     blocking order lives here and nowhere else.
 *   - `factsFromStatus` — the same facts derived from state the app already
 *     holds (git status + operation state). Drives the tooltip on every status
 *     change without spawning a single process (the 2 s polling tick must stay
 *     spawn-free).
 *   - `checkAutoFastForward` / `runAutoFastForward` — read the facts from the
 *     repository (never from cached UI state: it can be stale by the time a
 *     fetch ends) and, only when ready, run `git merge --ff-only @{upstream}`.
 *     Only reached after a fetch, and only when the status already says
 *     "ready"; the Rust command re-checks again under the repo lock.
 *
 * `useAutoFastForward` wires them: a reactive tooltip block, and a serialized
 * `requestRun` that never drops a request and never runs two fast-forwards
 * concurrently.
 *
 * Untracked files never block on their own; if the fast-forward would
 * overwrite one, git refuses and that refusal is reported as `gitRefused`.
 */

import { computed, ref, type ComputedRef } from "vue";
import {
  gitExec,
  gitFastForwardToUpstream,
  gitRepoState,
  type GitStatus,
  type RepoOperationState,
} from "../utils/backend";

// ─── Verdict ────────────────────────────────────────────────

/**
 * Why a purely-behind branch is not fast-forwarded. The declaration order is
 * the evaluation order: the FIRST failing condition is the one reported.
 * `gitRefused` is not evaluated up front, it is what git itself answers.
 */
export type AutoFfBlockReason =
  | "operation"
  | "detached"
  | "noUpstream"
  | "busy"
  | "conflicts"
  | "localCommits"
  | "trackedEdits"
  | "gitRefused";

const BLOCK_REASONS = [
  "operation",
  "detached",
  "noUpstream",
  "busy",
  "conflicts",
  "localCommits",
  "trackedEdits",
  "gitRefused",
] as const satisfies readonly AutoFfBlockReason[];

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
  // An operation comes first: a rebase detaches HEAD, and the running rebase
  // is the cause worth naming, not the "detached" it produces.
  if (f.operation) return { kind: "blocked", reason: "operation" };
  if (f.detached) return { kind: "blocked", reason: "detached" };
  if (!f.hasUpstream) return { kind: "blocked", reason: "noUpstream" };
  if (f.behind <= 0) return { kind: "idle" };
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
  if (repoState?.hasConflict) conflicts = true;
  if (!operation && bisect.exitCode === 0) operation = "bisect";

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

/** Branch names git status reports for a detached HEAD (libgit2 / CLI v2). */
const DETACHED_BRANCH_NAMES = new Set(["HEAD", "(detached)", "(detached HEAD)", "unknown", ""]);

/**
 * Facts from already-loaded state — no process is spawned. Advisory only:
 * a bisect is invisible here, and the status may lag the disk by one poll.
 * The git-backed check (`readAutoFfFacts`) and the Rust command catch both.
 */
export function factsFromStatus(
  status: GitStatus,
  operation: Pick<RepoOperationState, "state" | "hasConflict"> | null,
  ctx: AutoFfContext,
): AutoFfFacts {
  const op = operation && operation.state !== "clean" ? operation.state : null;
  return {
    detached: DETACHED_BRANCH_NAMES.has(status.branch),
    hasUpstream: !!status.remote,
    ahead: status.ahead,
    behind: status.behind,
    operation: op,
    busy: ctx.busy,
    conflicts: status.conflicted.length > 0 || !!operation?.hasConflict,
    trackedEdits: status.staged.length > 0 || status.unstaged.length > 0,
  };
}

/** Read-only: facts + verdict, nothing is modified. */
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

    // The backend re-checks every repo-side condition under the repo write
    // lock, then runs `merge --ff-only`. The read above only avoids taking the
    // lock when the answer is already "no" (and supplies the tooltip reason).
    const res = await gitFastForwardToUpstream(cwd);
    if (res.fastForwarded) {
      return { kind: "fastForwarded", count: res.behind || facts.behind, branch: res.branch ?? "" };
    }
    if (res.reason === "upToDate") return { kind: "idle" };
    const reason = (BLOCK_REASONS as readonly string[]).includes(res.reason ?? "")
      ? (res.reason as AutoFfBlockReason)
      : "gitRefused";
    return {
      kind: "blocked",
      reason,
      detail: reason === "gitRefused" ? firstLine(res.stderr ?? "") : undefined,
    };
  } catch (err: any) {
    return { kind: "blocked", reason: "gitRefused", detail: firstLine(`${err?.message ?? err}`) };
  }
}

function firstLine(text: string): string {
  return (text ?? "").trim().split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
}

// ─── Composable ─────────────────────────────────────────────

export interface AutoFfBlock {
  reason: AutoFfBlockReason;
  detail?: string;
}

export interface UseAutoFastForwardOptions {
  enabled: () => boolean;
  cwd: () => string | null | undefined;
  status: () => GitStatus | null | undefined;
  operation: () => Pick<RepoOperationState, "state" | "hasConflict"> | null | undefined;
  /** The app runs its own git operation (push, pull, merge, commit, switch…). */
  busy: () => boolean;
  /** A fetch is streaming; only blocks an actual run, not the tooltip. */
  fetching?: () => boolean;
  /** Called after a successful fast-forward (refresh the view, toast…). */
  onFastForwarded?: (outcome: { count: number; branch: string }) => Promise<void> | void;
  /** Injection point for tests. */
  run?: typeof runAutoFastForward;
}

export interface UseAutoFastForward {
  /** Why a behind branch is held back, for the sync-button tooltip; or null. */
  autoFfBlock: ComputedRef<AutoFfBlock | null>;
  /** Status-derived verdict (no process spawned), null when off / no status. */
  statusVerdict: ComputedRef<AutoFfVerdict | null>;
  /**
   * Fast-forward if the branch is purely behind. Call after a fetch. A request
   * made while a pass is in flight is not dropped: one more pass runs right
   * after the current one ends. Two passes never overlap.
   */
  requestRun: () => Promise<void>;
}

export function useAutoFastForward(opts: UseAutoFastForwardOptions): UseAutoFastForward {
  const run = opts.run ?? runAutoFastForward;
  /** What the last git-backed pass reported, for what status cannot see. */
  const lastRun = ref<{ cwd: string; block: AutoFfBlock } | null>(null);

  const statusVerdict = computed<AutoFfVerdict | null>(() => {
    if (!opts.enabled()) return null;
    const status = opts.status();
    if (!status) return null;
    return evaluateAutoFastForward(factsFromStatus(status, opts.operation() ?? null, { busy: opts.busy() }));
  });

  const autoFfBlock = computed<AutoFfBlock | null>(() => {
    const v = statusVerdict.value;
    if (!v || v.kind === "idle") return null;
    if (v.kind === "blocked") return { reason: v.reason };
    // Status says "ready": surface what only git could see (a refusal, a
    // bisect…). "busy" is transient app state, already re-read live above.
    const last = lastRun.value;
    if (last && last.cwd === opts.cwd() && last.block.reason !== "busy") return last.block;
    return null;
  });

  let running = false;
  let pending = false;

  async function passOnce(): Promise<void> {
    const cwd = opts.cwd();
    if (!opts.enabled() || !cwd) return;
    // Cheap gate from already-loaded state: only spawn git when the status
    // (freshly reloaded by the fetch) says there is something to do.
    if (statusVerdict.value?.kind !== "ready") {
      if (lastRun.value?.cwd !== cwd || statusVerdict.value?.kind === "idle") lastRun.value = null;
      return;
    }
    const outcome = await run(cwd, { busy: opts.busy() || !!opts.fetching?.() });
    if (cwd !== opts.cwd()) return; // tab switched meanwhile
    if (outcome.kind === "fastForwarded") {
      lastRun.value = null;
      await opts.onFastForwarded?.({ count: outcome.count, branch: outcome.branch });
    } else if (outcome.kind === "blocked") {
      lastRun.value = { cwd, block: { reason: outcome.reason, detail: outcome.detail } };
    } else {
      lastRun.value = null;
    }
  }

  async function requestRun(): Promise<void> {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      do {
        pending = false;
        try {
          await passOnce();
        } catch (err) {
          console.warn("[GitWand] auto fast-forward pass failed:", err);
        }
      } while (pending);
    } finally {
      running = false;
    }
  }

  return { autoFfBlock, statusVerdict, requestRun };
}
