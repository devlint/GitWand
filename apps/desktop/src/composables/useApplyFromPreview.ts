/**
 * v3.11.0 — apply from preview.
 *
 * Design: docs/superpowers/specs/2026-09-12-v3.11.0-preview-to-apply-design.md §3.1-3.3
 *
 * The Conflict Predictor simulates: `git show` the three sides into scratch
 * files and `git merge-file` them. Nothing touches the index or the worktree.
 * So applying cannot mean writing the simulation out. That output has no stage
 * 1/2/3 entries, leaves no MERGE_HEAD, is wrong for renames, submodules,
 * binaries and `.gitattributes` merge drivers, and makes `--continue`
 * impossible. Applying means running the *real* operation and re-running the
 * engine against what git actually produced.
 *
 * This composable is therefore orchestration over primitives that already
 * exist, not a new backend capability. It takes its dependencies explicitly
 * rather than reaching for `useGitWand()`: App.vue owns the single instance,
 * and explicit deps are what make the failure paths testable with fakes.
 *
 * ── What this must never do ──
 *
 * **Never auto-abort.** An abort throws away conflict resolution the user may
 * already have done by hand, and the snapshot only covers the worktree, not
 * their memory of which hunks they had reviewed. Abort is offered as a button,
 * never taken.
 *
 * **Never auto-continue past a residual.** Stopping with the operation in
 * progress is precisely how control is handed back.
 *
 * **Never trust `stageFiles`.** `useGitRepo.stageFiles` catches into a ref and
 * never throws, so the absence of an exception proves nothing. Success is
 * verified by re-reading the conflicted set.
 */

import { ref } from "vue";
import type { PreviewOperation } from "./useMergePreview";
import type { ApplyPredicate } from "./useGitWand";

/** The minimum this module needs from a conflict file. */
interface ApplyFile {
  path: string;
  content: string;
  result: {
    resolutions: Array<{ autoResolved: boolean; resolvedLines: string[] | null }>;
    stats: { remaining?: number; totalConflicts: number; autoResolved: number };
  };
}

export interface ApplyDeps {
  cwd: () => string;
  /** Repo state, to refuse before mutating anything if an op is in progress. */
  repoState: () => Promise<{ state: string }>;
  snapshot: (cwd: string, kind: "resolution", label: string) => Promise<{ id: string } | null>;
  runMerge: (ref: string) => Promise<void>;
  runCherryPick: (sha: string) => Promise<void>;
  runRebaseOnto: (onto: string) => Promise<{ conflict: boolean }>;
  refresh: () => Promise<void>;
  /** Paths git currently reports as conflicted. The source of truth. */
  conflictedPaths: () => string[];
  openConflicts: (cwd: string) => Promise<void>;
  resolveAll: (opts: { shouldApply?: (path: string) => ApplyPredicate | undefined }) => Promise<void>;
  saveAll: () => Promise<void>;
  stage: (paths: string[]) => Promise<void>;
  files: () => ApplyFile[];
  /** `merge --continue` / `cherry-pick --continue` / `rebase --continue`. */
  finalize: (operation: PreviewOperation) => Promise<void>;
  applyPredicateFor: (path: string) => ApplyPredicate | undefined;
}

export type ApplyStoppedReason =
  | "clean"
  | "residual"
  | "op-failed"
  | "resolve-failed"
  | "loop-bound";

export interface ApplyOutcome {
  operation: PreviewOperation;
  ref: string;
  /** What the preview predicted. An estimate, deliberately, see below. */
  estimatedHunks: number;
  /** Null on a repo with no HEAD: the escape hatch is absent, so say so. */
  snapshotId: string | null;
  operationError: string | null;
  /** What the real run actually applied. */
  appliedHunks: number;
  filesResolved: string[];
  residualFiles: string[];
  residualHunks: number;
  finalized: boolean;
  stoppedReason: ApplyStoppedReason;
  /**
   * True when the estimate and the actual disagree.
   *
   * They can, by construction, and the UI has to say so rather than quietly
   * differ: the preview resolves a `merge-file --diff3` of three blobs while
   * git merges with `ort` and a virtual merge base on criss-cross histories;
   * `git_changed_files` has no `-M`, so a rename reads as add+delete; and
   * `.gitattributes` merge drivers, `merge=union`, binaries and submodules are
   * invisible to the simulation entirely.
   */
  estimateDrifted: boolean;
}

/**
 * Honest runners for the two operations whose UI wrappers swallow failure.
 *
 * `useGitRepo.mergeBranch` and `cherryPick` catch everything into `error.value`
 * and never throw, and they also swallow a `{ success: false }` result the same
 * way. Wiring the orchestrator to them meant a merge git refused (dirty tree,
 * unrelated histories, bad ref) came back looking like success: no conflicts,
 * the loop breaks immediately, and the report claims `finalized: true` and
 * "0 applied, 0 left" for an operation that never ran.
 *
 * That is the same hazard this file's header already calls out for
 * `stageFiles`; it was caught there and missed here. These call the backend
 * directly and throw, so the `op-failed` branch is actually reachable.
 */
export function assertOperationSucceeded(
  result: { success?: boolean; conflicts?: boolean; message?: string } | undefined,
  what: string,
): void {
  if (!result) throw new Error(`${what} returned no result`);
  // A conflict IS a success for our purposes: git did the work and stopped
  // where it should. Only a refusal is a failure.
  if (result.conflicts) return;
  if (result.success === false) {
    throw new Error(result.message?.trim() || `${what} failed`);
  }
}

/** Bounded so a pathological rebase reports instead of spinning forever. */
const MAX_REBASE_STEPS = 100;

export function useApplyFromPreview(deps: ApplyDeps) {
  const running = ref(false);
  const outcome = ref<ApplyOutcome | null>(null);

  /** Hunks still conflicted, across every conflicted file. */
  function residualOf(paths: string[]): { files: string[]; hunks: number } {
    const files: string[] = [];
    let hunks = 0;
    for (const f of deps.files()) {
      if (!paths.includes(f.path)) continue;
      const remaining = f.result.stats.remaining ?? f.result.stats.totalConflicts;
      if (remaining > 0) {
        files.push(f.path);
        hunks += remaining;
      }
    }
    return { files, hunks };
  }

  /** Files whose conflicts are all gone, ready to stage. */
  function fullyResolved(paths: string[]): string[] {
    return deps
      .files()
      .filter((f) => paths.includes(f.path))
      .filter((f) => (f.result.stats.remaining ?? f.result.stats.totalConflicts) === 0)
      .map((f) => f.path);
  }

  /**
   * How many resolutions this pass is about to write.
   *
   * Counted from the state `openConflicts` produced, BEFORE `resolveAll` runs.
   * Afterwards the applied hunks are gone from the file and the engine has
   * re-resolved what remains, so counting then reports zero for a file that
   * was fully resolved: the evidence has been consumed. Still the real run's
   * numbers, not the preview's estimate, since these resolutions come from
   * what git actually produced.
   *
   * Honours the same predicate the apply will, or the count would promise
   * hunks the user has ticked off.
   */
  function pendingIn(paths: string[]): number {
    let n = 0;
    for (const f of deps.files()) {
      if (!paths.includes(f.path)) continue;
      const predicate = deps.applyPredicateFor(f.path);
      n += f.result.resolutions.filter(
        (r, i) =>
          r.autoResolved &&
          r.resolvedLines !== null &&
          (!predicate || predicate(i, r as never)),
      ).length;
    }
    return n;
  }

  async function apply(
    operation: PreviewOperation,
    ref_: string,
    estimatedHunks: number,
  ): Promise<ApplyOutcome> {
    const cwd = deps.cwd();
    const base: ApplyOutcome = {
      operation,
      ref: ref_,
      estimatedHunks,
      snapshotId: null,
      operationError: null,
      appliedHunks: 0,
      filesResolved: [],
      residualFiles: [],
      residualHunks: 0,
      finalized: false,
      stoppedReason: "clean",
      estimateDrifted: false,
    };
    const finish = (o: ApplyOutcome): ApplyOutcome => {
      o.estimateDrifted =
        o.stoppedReason !== "op-failed" &&
        o.estimatedHunks !== o.appliedHunks + o.residualHunks;
      outcome.value = o;
      running.value = false;
      return o;
    };

    running.value = true;

    // 0. Pre-flight. Refuse before the snapshot, so a refusal changes nothing.
    try {
      const st = await deps.repoState();
      if (st.state && st.state !== "clean") {
        return finish({
          ...base,
          stoppedReason: "op-failed",
          operationError: `A ${st.state} is already in progress. Finish or abort it first.`,
        });
      }
    } catch (e) {
      return finish({ ...base, stoppedReason: "op-failed", operationError: msg(e) });
    }

    // 1. Snapshot before any mutation. `saveAllFiles` takes its own later, but
    //    that one comes after the operation and would not cover "the merge
    //    itself went somewhere I did not want".
    const snap = await deps.snapshot(cwd, "resolution", `Apply from preview: ${operation} ${ref_}`);
    base.snapshotId = snap?.id ?? null;

    // 2. Run the real operation.
    try {
      if (operation === "merge") await deps.runMerge(ref_);
      else if (operation === "cherry-pick") await deps.runCherryPick(ref_);
      else await deps.runRebaseOnto(ref_);
    } catch (e) {
      return finish({ ...base, stoppedReason: "op-failed", operationError: msg(e) });
    }

    await deps.refresh();

    // 3. Resolve what git actually produced, one pass for merge and
    //    cherry-pick, one per halted step for a rebase (which replays each
    //    commit separately and can stop more than once).
    const maxPasses = operation === "rebase" ? MAX_REBASE_STEPS : 1;
    let applied = 0;
    const resolvedFiles: string[] = [];

    for (let pass = 0; pass < maxPasses; pass++) {
      const conflicted = deps.conflictedPaths();
      if (conflicted.length === 0) break;

      try {
        await deps.openConflicts(cwd);
        // Count before resolving: afterwards these hunks no longer exist.
        const pending = pendingIn(conflicted);
        await deps.resolveAll({ shouldApply: deps.applyPredicateFor });
        applied += pending;
        await deps.saveAll();
      } catch (e) {
        // The operation stays in progress on purpose. Aborting here would
        // discard whatever the user had already resolved by hand.
        const residual = residualOf(deps.conflictedPaths());
        return finish({
          ...base,
          stoppedReason: "resolve-failed",
          operationError: msg(e),
          appliedHunks: applied,
          filesResolved: resolvedFiles,
          residualFiles: residual.files,
          residualHunks: residual.hunks,
        });
      }

      const ready = fullyResolved(conflicted);
      if (ready.length > 0) {
        await deps.stage(ready);
        resolvedFiles.push(...ready.filter((p) => !resolvedFiles.includes(p)));
      }
      await deps.refresh();

      // `stage` swallows its errors, so the conflicted set is the only honest
      // signal that it worked.
      const stillConflicted = deps.conflictedPaths();
      if (stillConflicted.length > 0) {
        const residual = residualOf(stillConflicted);
        return finish({
          ...base,
          stoppedReason: "residual",
          appliedHunks: applied,
          filesResolved: resolvedFiles,
          residualFiles: residual.files.length > 0 ? residual.files : stillConflicted,
          residualHunks: residual.hunks,
        });
      }

      if (operation !== "rebase") break;

      // A rebase step is clear: advance it, then look again.
      try {
        await deps.finalize("rebase");
      } catch (e) {
        return finish({
          ...base,
          stoppedReason: "resolve-failed",
          operationError: msg(e),
          appliedHunks: applied,
          filesResolved: resolvedFiles,
        });
      }
      await deps.refresh();

      if (pass === maxPasses - 1 && deps.conflictedPaths().length > 0) {
        return finish({
          ...base,
          stoppedReason: "loop-bound",
          appliedHunks: applied,
          filesResolved: resolvedFiles,
        });
      }
    }

    if (operation === "rebase" && deps.conflictedPaths().length > 0) {
      const residual = residualOf(deps.conflictedPaths());
      return finish({
        ...base,
        stoppedReason: "loop-bound",
        appliedHunks: applied,
        filesResolved: resolvedFiles,
        residualFiles: residual.files,
        residualHunks: residual.hunks,
      });
    }

    // 4. Nothing left in conflict: finish the operation.
    //    A merge or cherry-pick that never conflicted has nothing to continue.
    let finalized = false;
    if (applied > 0 || resolvedFiles.length > 0) {
      if (operation !== "rebase") {
        try {
          await deps.finalize(operation);
        } catch (e) {
          return finish({
            ...base,
            stoppedReason: "resolve-failed",
            operationError: msg(e),
            appliedHunks: applied,
            filesResolved: resolvedFiles,
          });
        }
      }
      finalized = true;
    } else {
      finalized = true;
    }
    await deps.refresh();

    return finish({
      ...base,
      stoppedReason: "clean",
      appliedHunks: applied,
      filesResolved: resolvedFiles,
      finalized,
    });
  }

  return { apply, running, outcome };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
