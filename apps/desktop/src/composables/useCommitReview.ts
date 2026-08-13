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
import { ref, computed, type ComputedRef, type Ref } from "vue";
import { gitExec } from "../utils/backend";
import { indexDiffFiles, parseFileDiff } from "../utils/unifiedDiff";
import { usePrPreReview, type ReviewFinding } from "./usePrPreReview";
import { usePrReviewQueue } from "./usePrReviewQueue";
import { filterFindings, normalizeFindingClass } from "./usePrFindingFilter";
import { useSettings } from "./useSettings";
import { useAIProvider } from "./useAIProvider";
import { useI18n } from "./useI18n";

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
   * Reserved for parity with `useSecretsScanner`'s `debounceMs` — that
   * composable's `scan()` is debounced because it's driven by a staged-set
   * *watcher*. `run()` here is invoked directly by an explicit user click
   * (Task 1b's "Review staged changes" button); Task 3's one-shot
   * re-review-after-fix is the only future watcher-driven call site, and
   * that phase is out of scope for this PR. Not applied within this PR.
   * Default 400.
   */
  debounceMs?: number;
}

export interface CommitReviewResult {
  /** Filtered (threshold + cap + session-dismissed) — what the UI renders. */
  findings: Ref<ReviewFinding[]>;
  /** Raw findings from the last completed/in-flight run, unfiltered. */
  rawFindings: Ref<ReviewFinding[]>;
  running: Ref<boolean>;
  progress: ComputedRef<{ done: number; total: number }>;
  lastError: Ref<string | null>;
  /** Per-file finding count for the staged list (Task 2's sidebar chips). */
  findingsByFile: ComputedRef<Record<string, number>>;
  /** Deterministic i18n one-liner composed from the findings (decision D2 —
   *  no second LLM call for the summary). */
  summary: ComputedRef<string>;
  /** True once the staged diff was truncated by the file-count or byte cap. */
  truncated: Ref<boolean>;
  run: (cwd: string, locale: string) => Promise<void>;
  /** Abort any in-flight run and clear all state (repo switch, post-commit,
   *  or a staged-set change invalidating a stale review). */
  reset: () => void;
  /** Session-only, class-normalized dismissal — mirrors the PR pre-review
   *  dismissal contract. */
  dismiss: (id: string) => void;
  /** Wake the queue after `document.hidden` flips back. The queue itself
   *  owns the pause/resume state; call this from the host's existing
   *  `visibilitychange` handler — never add a second listener. */
  resume: () => void;
}

export function useCommitReview(_opts: UseCommitReviewOptions = {}): CommitReviewResult {
  const { settings } = useSettings();
  const { t } = useI18n();
  const ai = useAIProvider();
  const { analyzeFile } = usePrPreReview();
  const queue = usePrReviewQueue();

  const rawFindings = ref<ReviewFinding[]>([]);
  const lastError = ref<string | null>(null);
  const dismissedClasses = ref<Set<string>>(new Set());
  const truncated = ref(false);

  let abortController: AbortController | null = null;

  const findings = computed<ReviewFinding[]>(() =>
    filterFindings(rawFindings.value, {
      threshold: settings.value.reviewAiConfidenceThreshold,
      cap: settings.value.reviewAiMaxFindings,
      dismissed: dismissedClasses.value,
    }),
  );

  const progress = computed(() => ({ done: queue.done.value, total: queue.total.value }));
  const running = queue.running;

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

  function reset() {
    stop();
    rawFindings.value = [];
    lastError.value = null;
    truncated.value = false;
  }

  async function run(cwd: string, locale: string): Promise<void> {
    // A new run always supersedes whatever is in flight — abort first so a
    // stale in-flight run can never paint findings after this one starts.
    stop();
    rawFindings.value = [];
    lastError.value = null;
    truncated.value = false;

    // Opt-in feature: zero IPC, zero LLM call when disabled/unavailable.
    if (!settings.value.commitReviewEnabled || !ai.isAvailable.value || !cwd) return;

    const controller = new AbortController();
    abortController = controller;

    try {
      const res = await gitExec(cwd, ["diff", "--cached", "--no-color"]);
      if (controller.signal.aborted) return;

      if (res.exitCode !== 0) {
        lastError.value = (res.stderr ?? "").trim() || t("errors.commitReviewFailed");
        return;
      }
      // A clean index is not an error — no findings, no toast.
      if (!res.stdout.trim()) return;

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
      if (!files.length) return;

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
    } catch (err) {
      if (!controller.signal.aborted) {
        lastError.value = err instanceof Error ? err.message : String(err);
      }
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
    resume: queue.resume,
  };
}
