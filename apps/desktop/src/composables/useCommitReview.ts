/**
 * useCommitReview.ts
 *
 * Task 1a (v3.7.0) — staged-diff AI review orchestrator ("Commit Review",
 * roadmap bullet 1). Opt-in, off by default: with `commitReviewEnabled`
 * false this composable performs zero IPC and zero LLM calls.
 *
 * Reuses the exact same engine as the v3.6.0 PR pre-review pass
 * (`usePrPreReview.analyzeFile`, `scope: "commit"` — Task 0), the same
 * sequential/abortable/visibility-gated queue (`usePrReviewQueue`), and the
 * same confidence-threshold + top-N cap + dismissal filter
 * (`usePrFindingFilter`) — see AGENTS.md/plan decision D3: no new
 * commit-specific threshold/cap settings, the existing `reviewAi*` knobs
 * are reused.
 *
 * The staged diff is fetched via the existing `gitExec(["diff", "--cached",
 * "--no-color"])` primitive (precedent: `useCommitMessage.ts`) — no new
 * Tauri command.
 */
import { ref, shallowRef, computed, type ComputedRef, type Ref } from "vue";
import { gitExec } from "../utils/backend";
import { indexDiffFiles, parseFileDiff } from "../utils/unifiedDiff";
import { usePrPreReview, type ReviewFinding } from "./usePrPreReview";
import { usePrReviewQueue } from "./usePrReviewQueue";
import { filterFindings, normalizeFindingClass } from "./usePrFindingFilter";
import { useSettings } from "./useSettings";
import { useAIProvider } from "./useAIProvider";
import { useI18n } from "./useI18n";
import {
  recordReview,
  coverageFor,
  getState as getCommitReviewState,
  clear as clearCommitReviewState,
} from "./commitReviewState";

/**
 * Hard cap on the number of staged files sent through the review pass — a
 * huge staged tree (e.g. a vendored dependency bump) must not fan out
 * hundreds of LLM calls. Plan decision D12 flags this number as a guess
 * worth validating against a real large staged change before merge.
 */
export const COMMIT_REVIEW_MAX_FILES = 40;

/**
 * Hard cap on the total staged-diff bytes sent through the review pass,
 * applied in file-slice order (earlier files in the diff win). Same D12
 * caveat as `COMMIT_REVIEW_MAX_FILES`.
 */
export const COMMIT_REVIEW_MAX_BYTES = 400_000;

export interface UseCommitReviewOptions {
  /**
   * Debounce (ms) applied to `onStagedSetChanged`'s one-shot re-review arm
   * (Task 3) — mirrors `useSecretsScanner`'s `debounceMs`, coalescing rapid
   * repeated staged-set events (stage → fix → restage in quick succession)
   * into a single re-review instead of one per event. `run()` itself is
   * still invoked directly by an explicit user click and is never debounced.
   * Default 400.
   */
  debounceMs?: number;
}

export interface CommitReviewResult {
  /** Filtered (threshold + cap + session-dismissed) — what the UI renders. */
  findings: Ref<ReviewFinding[]>;
  /** Raw findings from the last completed/in-flight run, unfiltered. */
  rawFindings: Ref<ReviewFinding[]>;
  running: ComputedRef<boolean>;
  progress: ComputedRef<{ done: number; total: number }>;
  lastError: Ref<string | null>;
  /** Per-file finding count for the staged list (Task 2's sidebar chips). */
  findingsByFile: ComputedRef<Record<string, number>>;
  /** Deterministic i18n one-liner composed from the findings (decision D2 —
   *  no second LLM call for the summary). */
  summary: ComputedRef<string>;
  /** True once the staged diff was truncated by the file-count or byte cap. */
  truncated: Ref<boolean>;
  /**
   * Runs the review pass. Resolves to `true` once a full attempt actually
   * happened (even if it errored, or the staged diff was empty) — `false`
   * when the call never really tried: the feature is disabled, the AI
   * provider is unavailable, `cwd` is empty, or this run was superseded by
   * a newer one before it got anywhere. Callers use this to distinguish
   * "ran with zero findings" from "did not run" (verifier issue #5).
   */
  run: (cwd: string, locale: string) => Promise<boolean>;
  /**
   * Abort any in-flight run and clear all state (repo switch, post-commit,
   * or a staged-set change invalidating a stale review). Passing `cwd`
   * (Task 4) also refreshes `iterations` from that repo's persisted state
   * instead of leaving a stale count from whatever repo was active before.
   */
  reset: (cwd?: string) => void;
  /** Session-only, class-normalized dismissal — mirrors the PR pre-review
   *  dismissal contract. */
  dismiss: (id: string) => void;
  /** Wake the queue after `document.hidden` flips back. Call this from the
   *  host's existing `visibilitychange` handler — never add a second
   *  listener. Always resumes whichever run is currently active. */
  resume: () => void;
  /**
   * Task 3 — arms exactly one automatic re-review, consumed by the NEXT
   * `onStagedSetChanged` call (whether or not that call ends up running
   * anything). A no-op when `commitReviewAutoReReview` is off — the arm
   * itself never gets set, so a later staged-set change can't accidentally
   * fire a review the user opted out of.
   */
  armReReview: () => void;
  /**
   * The real trigger behind "re-review triggers on the next staging change"
   * (roadmap bullet 3) — call this from the host's staged-set watcher on
   * EVERY staged-set change (mirrors the existing invalidate-only behavior,
   * D5), not just after a "Fix with agent" handoff. Bundles `reset()` with
   * the one-shot arm consumption so the exact sequencing is defined once,
   * here, and is unit-testable without mounting the host component.
   */
  onStagedSetChanged: (cwd: string, locale: string, stagedCount: number) => void;
  /**
   * Task 4 — review passes completed against the current repo's cycle
   * (persisted; survives repo switches and app restarts, reset to 0 by a
   * successful commit via `clearReviewState`).
   */
  iterations: Ref<number>;
  /**
   * Task 4 — share (0-100) of the CURRENT staged diff's added lines already
   * covered by a past review snapshot. Recomputed every time `run()` parses
   * a staged diff (both right after parsing — reflecting whatever was
   * reviewed BEFORE this run — and again after a non-aborted completion),
   * so staging a brand-new unreviewed line visibly drops this number even
   * before the next review pass finishes.
   */
  coverage: Ref<number>;
  /**
   * Task 4/5 — drops the persisted iteration/coverage history for `cwd` and
   * resets the in-memory refs. Call after a successful commit: a new commit
   * starts a new review cycle.
   */
  clearReviewState: (cwd: string) => void;
}

export function useCommitReview(opts: UseCommitReviewOptions = {}): CommitReviewResult {
  const debounceMs = opts.debounceMs ?? 400;
  const { settings } = useSettings();
  const { t } = useI18n();
  const ai = useAIProvider();
  const { analyzeFile } = usePrPreReview();

  // Verifier issue #6: each run() gets its own `usePrReviewQueue()` instance
  // rather than sharing one across every call. `usePrReviewQueue.run()` has
  // a `try { ... } finally { running.value = false }` — if run A is aborted
  // while its in-flight `analyzeOne` is still resolving, and run B has
  // already started, A's stale `finally` can fire *after* B, incorrectly
  // flipping shared running/done/total state back to A's. Giving every run
  // its own queue instance means a stale run's cleanup only ever touches
  // refs nothing else reads anymore — `activeQueue` always points at the
  // most recent one, so a stale queue's `finally` becomes a no-op as far as
  // the exposed `running`/`progress` are concerned.
  //
  // `shallowRef` (not `ref`): the queue object holds `done`/`total`/`running`
  // as nested Refs. A plain `ref()` would make this container reactive,
  // and Vue auto-unwraps nested refs read off a reactive object — turning
  // `activeQueue.value.done` into an already-unwrapped number instead of
  // the Ref itself, silently breaking every `.value` access below.
  const activeQueue = shallowRef(usePrReviewQueue());

  const rawFindings = ref<ReviewFinding[]>([]);
  const lastError = ref<string | null>(null);
  const dismissedClasses = ref<Set<string>>(new Set());
  const truncated = ref(false);

  // Task 4 — iteration/coverage tracking. Plain refs (not computed off the
  // persisted store) updated imperatively at the points `run()`/`reset()`
  // actually know the current repo/diff — see the doc comments on the
  // exposed `iterations`/`coverage` refs above for exactly when each updates.
  const iterations = ref(0);
  const coverage = ref(100);

  // Task 3 — one-shot auto re-review arm + its debounce timer. `reReviewArmed`
  // is intentionally NOT reset by `stop()`/`reset()` below — it must survive
  // a staged-set invalidation so it's still there for `onStagedSetChanged`
  // to consume.
  const reReviewArmed = ref(false);
  let reReviewTimer: ReturnType<typeof setTimeout> | null = null;

  let abortController: AbortController | null = null;

  const findings = computed<ReviewFinding[]>(() =>
    filterFindings(rawFindings.value, {
      threshold: settings.value.reviewAiConfidenceThreshold,
      cap: settings.value.reviewAiMaxFindings,
      dismissed: dismissedClasses.value,
    }),
  );

  const progress = computed(() => ({ done: activeQueue.value.done.value, total: activeQueue.value.total.value }));
  const running = computed(() => activeQueue.value.running.value);

  const findingsByFile = computed<Record<string, number>>(() => {
    const counts: Record<string, number> = {};
    for (const f of findings.value) counts[f.path] = (counts[f.path] ?? 0) + 1;
    return counts;
  });

  const summary = computed<string>(() => {
    const list = findings.value;
    if (list.length === 0) return t("commitReview.summaryClean");
    const risk = list.filter((f) => f.severity === "risk").length;
    const suggestion = list.filter((f) => f.severity === "suggestion").length;
    const nit = list.filter((f) => f.severity === "nit").length;
    const files = new Set(list.map((f) => f.path)).size;
    return t("commitReview.summaryCounts", risk, suggestion, nit, files);
  });

  function stop() {
    abortController?.abort();
    abortController = null;
  }

  /**
   * `cwd` is optional so every existing call site (repo close, generic
   * invalidation) keeps working unchanged; passing it (Task 4) refreshes
   * `iterations` from whatever is persisted for THAT repo, so switching
   * repos never keeps showing a stale count from the previous one.
   * `coverage` always resets to the neutral "nothing outstanding known yet"
   * value here — it's only truly known once `run()` parses that repo's
   * actual current staged diff.
   */
  function reset(cwd?: string) {
    stop();
    rawFindings.value = [];
    lastError.value = null;
    truncated.value = false;
    iterations.value = cwd ? getCommitReviewState(cwd).iterations : 0;
    coverage.value = 100;
  }

  function clearReviewState(cwd: string): void {
    if (cwd) clearCommitReviewState(cwd);
    iterations.value = 0;
    coverage.value = 100;
  }

  async function run(cwd: string, locale: string): Promise<boolean> {
    // A new run always supersedes whatever is in flight — abort first so a
    // stale in-flight run can never paint findings after this one starts.
    stop();
    rawFindings.value = [];
    lastError.value = null;
    truncated.value = false;

    // Opt-in feature: zero IPC, zero LLM call when disabled/unavailable.
    // Never even attempted — callers must not treat this as "ran clean".
    if (!settings.value.commitReviewEnabled || !ai.isAvailable.value || !cwd) return false;

    const controller = new AbortController();
    abortController = controller;
    // Fresh queue instance for this run (verifier issue #6) — see the
    // `activeQueue` declaration above for why.
    const queue = usePrReviewQueue();
    activeQueue.value = queue;

    try {
      const res = await gitExec(cwd, ["diff", "--cached", "--no-color"]);
      if (controller.signal.aborted) return false;

      if (res.exitCode !== 0) {
        lastError.value = (res.stderr ?? "").trim() || t("errors.commitReviewFailed");
        return true; // a full attempt happened, it just failed
      }
      // A clean index is not an error — no findings, no toast.
      if (!res.stdout.trim()) return true;

      let slices = indexDiffFiles(res.stdout);
      if (slices.length > COMMIT_REVIEW_MAX_FILES) {
        slices = slices.slice(0, COMMIT_REVIEW_MAX_FILES);
        truncated.value = true;
      }

      let budget = COMMIT_REVIEW_MAX_BYTES;
      const bounded: typeof slices = [];
      for (const slice of slices) {
        if (budget <= 0) {
          truncated.value = true;
          break;
        }
        bounded.push(slice);
        budget -= slice.raw.length;
      }

      const files = bounded.map((s) => parseFileDiff(s.raw)).filter((f) => f.hunks.length > 0);
      if (!files.length) return true;

      // Task 4 — recompute coverage against THIS parse of the current staged
      // diff, using whatever was reviewed by past completed runs. This runs
      // before the LLM calls even start, so a newly staged, not-yet-reviewed
      // line is reflected immediately — even if this very run later aborts.
      coverage.value = coverageFor(cwd, files);

      await queue.run(
        files,
        (file) => analyzeFile(file, { cwd, locale, otherDiffFiles: files, scope: "commit" }),
        {
          onFinding: (finding) => {
            if (controller.signal.aborted) return;
            rawFindings.value = [...rawFindings.value, finding];
          },
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted) return false;

      // A full, non-aborted run just reviewed `files` — record it as a new
      // iteration. Guarded by the abort check above so a stale run's
      // eventual completion (verifier issue #6's race) never double-counts
      // an iteration that a newer run has already superseded.
      recordReview(cwd, files);
      iterations.value = getCommitReviewState(cwd).iterations;
      coverage.value = coverageFor(cwd, files);
      return true;
    } catch (err) {
      if (controller.signal.aborted) return false;
      lastError.value = err instanceof Error ? err.message : String(err);
      return true;
    } finally {
      if (abortController === controller) abortController = null;
    }
  }

  function dismiss(id: string) {
    const finding = rawFindings.value.find((f) => f.id === id);
    if (!finding) return;
    const cls = normalizeFindingClass(finding);
    dismissedClasses.value = new Set([...dismissedClasses.value, cls]);
  }

  function armReReview() {
    // A no-op when the setting is off — the arm never gets set, so a later
    // staged-set change can never fire a review the user opted out of, even
    // if the setting flips back on before that later change lands.
    if (!settings.value.commitReviewAutoReReview) return;
    reReviewArmed.value = true;
  }

  function onStagedSetChanged(cwd: string, locale: string, stagedCount: number): void {
    // Immediate, synchronous invalidation — a staged-set change means
    // whatever findings are on screen no longer match the index (D5). This
    // must never be debounced: the UI should clear stale findings right away.
    // Passing `cwd` (Task 4) also refreshes `iterations` from persisted
    // state for whatever repo is now active.
    reset(cwd);

    if (!reReviewArmed.value) return;

    // Debounced consumption: rapid repeated staged-set changes (stage → fix
    // → restage in quick succession) collapse into a single re-review
    // instead of firing once per event. Each call restarts the timer; only
    // the LAST staged-set change in a burst actually triggers the run.
    if (reReviewTimer) clearTimeout(reReviewTimer);
    reReviewTimer = setTimeout(() => {
      reReviewTimer = null;
      if (!reReviewArmed.value) return; // defensive — nothing else clears this flag
      reReviewArmed.value = false;
      if (cwd && settings.value.commitReviewEnabled && stagedCount > 0) {
        void run(cwd, locale);
      }
    }, debounceMs);
  }

  return {
    findings,
    rawFindings,
    running,
    progress,
    lastError,
    findingsByFile,
    summary,
    truncated,
    run,
    reset,
    dismiss,
    // Always resumes whichever queue instance is currently active — see
    // `activeQueue` above.
    resume: () => activeQueue.value.resume(),
    armReReview,
    onStagedSetChanged,
    iterations,
    coverage,
    clearReviewState,
  };
}
