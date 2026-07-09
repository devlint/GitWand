/**
 * useReviewIntelligence.ts
 *
 * Unified AI + static Intelligence orchestrator (E2, v3.6.0) — composes the
 * pre-review engine (C1/C3), the confidence/cap/dismissal filter (C2), the
 * PR summary (D1), and the static heuristic flags (previously computed
 * inline in `PrIntelligencePanel.vue`) behind one reactive surface and one
 * merged `LineAnnotation` stream per file (E1).
 *
 * `usePrPanel.ts` **composes** this — it calls it once and re-exports its
 * surface, it does not own this state itself ("compose, don't absorb").
 */
import { ref, computed, watch, type Ref } from "vue";
import type { GitDiff, PullRequest, PullRequestDetail, CIAnnotation } from "../utils/backend";
import type { LocaleKey } from "../locales";
import { usePrCache, detailKey } from "./usePrCache";
import { useSettings } from "./useSettings";
import { useI18n } from "./useI18n";
import { useAIProvider } from "./useAIProvider";
import { usePrPreReview, type ReviewFinding } from "./usePrPreReview";
import { usePrReviewQueue } from "./usePrReviewQueue";
import { usePrSummary } from "./usePrSummary";
import { filterFindings, normalizeFindingClass } from "./usePrFindingFilter";
import { fromCIAnnotation, fromFinding, type LineAnnotation } from "./prAnnotations";
import { parseFileDiff } from "./usePrPanel";

export interface UseReviewIntelligenceOptions {
  cwd: Ref<string>;
  selectedPr: Ref<PullRequest | null>;
  prDetail: Ref<PullRequestDetail | null>;
  detailTab: Ref<string>;
  /** Ensures `diffIndex` is populated (A1's per-file index — cheap; the
   *  engine parses hunks itself from the raw slices, bypassing the UI's
   *  lazy per-file parse without touching it). */
  loadDiff: () => Promise<void>;
  diffIndex: Ref<{ path: string; raw: string }[]>;
  /** CI check-run annotations per file (v2.18), merged in as `source: "ci"`. */
  annotationsByFile: Ref<Record<string, CIAnnotation[]>>;
}

// ─── Static heuristic flags (ported from PrIntelligencePanel.vue) ─────────

/** Same detection thresholds as the pre-E2 inline `aiFlags` computed —
 *  ported verbatim, just re-expressed as line-anchored `LineAnnotation`s
 *  (`source: "static"`) instead of a bespoke `{file, reason, severity}`
 *  shape, so they merge into the same overlay stream as CI/AI. */
export function computeStaticFlags(
  diffFiles: GitDiff[],
  t: (key: LocaleKey, ...args: Array<string | number>) => string,
): LineAnnotation[] {
  const flags: LineAnnotation[] = [];
  for (const diff of diffFiles) {
    const firstLine = diff.hunks[0]?.lines.find((l) => l.type !== "delete")?.newLineNo
      ?? diff.hunks[0]?.lines[0]?.oldLineNo
      ?? 1;

    const totalAdded = diff.hunks.reduce((sum, h) => sum + h.lines.filter((l) => l.type === "add").length, 0);
    const totalDeleted = diff.hunks.reduce((sum, h) => sum + h.lines.filter((l) => l.type === "delete").length, 0);
    if (totalAdded + totalDeleted > 200) {
      flags.push({
        source: "static", path: diff.path, line: firstLine, side: "RIGHT",
        severity: "warning", title: t("pr.intel.flagBigFile", totalAdded + totalDeleted),
      });
    }

    // Detect potential breaking changes: removed exports, deleted function
    // signatures. Anchored to the specific deleted line (old side) when one
    // matches, since unlike the other flags this one has a real anchor.
    for (const hunk of diff.hunks) {
      for (const line of hunk.lines) {
        if (line.type !== "delete") continue;
        if (/^\s*(export\s+(default|const|function|class)|module\.exports|def |pub fn |public )/.test(line.content)) {
          flags.push({
            source: "static", path: diff.path, line: line.oldLineNo ?? firstLine, side: "LEFT",
            severity: "failure", title: t("pr.intel.flagExportRemoved"),
          });
        }
      }
    }

    if (/\.(env|config|yaml|yml|toml|json|lock)$/.test(diff.path)) {
      flags.push({
        source: "static", path: diff.path, line: firstLine, side: "RIGHT",
        severity: "notice", title: t("pr.intel.flagConfigChange"),
      });
    }

    if (/migrat|schema\.sql|\.sql$/.test(diff.path.toLowerCase())) {
      flags.push({
        source: "static", path: diff.path, line: firstLine, side: "RIGHT",
        severity: "warning", title: t("pr.intel.flagDbMigration"),
      });
    }

    for (const hunk of diff.hunks) {
      if (hunk.lines.length > 100) {
        const anchor = hunk.lines.find((l) => l.type !== "delete")?.newLineNo ?? firstLine;
        flags.push({
          source: "static", path: diff.path, line: anchor, side: "RIGHT",
          severity: "notice", title: t("pr.intel.flagBigHunk", hunk.lines.length),
        });
        break; // Only once per file, matching the pre-E2 behavior.
      }
    }
  }
  return flags;
}

export function useReviewIntelligence(opts: UseReviewIntelligenceOptions) {
  const cache = usePrCache();
  const { settings } = useSettings();
  const { locale, t } = useI18n();
  const ai = useAIProvider();
  const preReview = usePrPreReview();
  const reviewQueue = usePrReviewQueue();
  const prSummaryEngine = usePrSummary();

  // ─── AI pre-review pass (C1/C3) ──────────────────────────
  const rawPreReviewFindings = ref<ReviewFinding[]>([]);
  const dismissedFindingClasses = ref<Set<string>>(new Set());
  const preReviewFindings = computed<ReviewFinding[]>(() =>
    filterFindings(rawPreReviewFindings.value, {
      threshold: settings.value.reviewAiConfidenceThreshold,
      cap: settings.value.reviewAiMaxFindings,
      dismissed: dismissedFindingClasses.value,
    }),
  );
  const preReviewProgress = computed(() => ({ done: reviewQueue.done.value, total: reviewQueue.total.value }));
  const preReviewRunning = reviewQueue.running;
  let preReviewAbort: AbortController | null = null;

  function stopPreReview() {
    preReviewAbort?.abort();
    preReviewAbort = null;
  }

  async function maybeRunPreReview() {
    if (!settings.value.reviewAiPreReview || !ai.isAvailable.value) return;
    const pr = opts.selectedPr.value;
    const headSha = opts.prDetail.value?.headSha;
    if (!pr || !headSha) return;

    const key = `${detailKey(opts.cwd.value, pr.number)}@${headSha}`;
    const cached = cache.getFindings(key);
    if (cached) {
      rawPreReviewFindings.value = cached;
      return;
    }

    if (!opts.diffIndex.value.length) await opts.loadDiff();
    const filesForReview = opts.diffIndex.value
      .map((f) => parseFileDiff(f.raw))
      .filter((f) => f.hunks.length > 0);
    if (!filesForReview.length) return;

    dismissedFindingClasses.value = cache.getDismissed(opts.cwd.value);
    rawPreReviewFindings.value = [];
    stopPreReview();
    const controller = new AbortController();
    preReviewAbort = controller;

    await reviewQueue.run(
      filesForReview,
      (file) => preReview.analyzeFile(file, {
        cwd: opts.cwd.value,
        locale: locale.value,
        otherDiffFiles: filesForReview,
      }),
      {
        onFinding: (finding) => {
          rawPreReviewFindings.value = [...rawPreReviewFindings.value, finding];
        },
        signal: controller.signal,
      },
    );

    if (!controller.signal.aborted && opts.selectedPr.value?.number === pr.number) {
      cache.setFindings(key, rawPreReviewFindings.value);
    }
  }

  function dismissFinding(id: string) {
    const finding = rawPreReviewFindings.value.find((f) => f.id === id);
    if (!finding) return;
    const cls = normalizeFindingClass(finding);
    cache.addDismissed(opts.cwd.value, cls);
    dismissedFindingClasses.value = new Set([...dismissedFindingClasses.value, cls]);
  }

  // ─── AI PR summary (D1) ───────────────────────────────────
  const prSummary = ref<string>("");
  const prSummaryLoading = ref(false);

  async function loadSummary(force = false) {
    if (!settings.value.reviewAiSummary || !ai.isAvailable.value) return;
    const pr = opts.selectedPr.value;
    const headSha = opts.prDetail.value?.headSha;
    if (!pr || !headSha) return;
    const key = `${detailKey(opts.cwd.value, pr.number)}@${headSha}`;
    if (!force) {
      const cached = cache.getSummary(key);
      if (cached) {
        prSummary.value = cached;
        return;
      }
    }
    if (!opts.diffIndex.value.length) await opts.loadDiff();
    if (!opts.diffIndex.value.length) return;
    prSummaryLoading.value = true;
    try {
      const text = await prSummaryEngine.generate({
        cwd: opts.cwd.value,
        base: opts.prDetail.value?.base ?? "",
        head: opts.prDetail.value?.branch ?? "",
        files: opts.diffIndex.value,
        locale: locale.value,
      });
      if (opts.selectedPr.value?.number !== pr.number) return;
      prSummary.value = text;
      if (text) cache.setSummary(key, text);
    } finally {
      prSummaryLoading.value = false;
    }
  }

  function regenerateSummary() {
    return loadSummary(true);
  }

  // Trigger both passes whenever the selected PR's head SHA becomes known —
  // a cache hit paints instantly, a miss starts the relevant engine. Firing
  // on `headSha` (not `selectedPr`) means a re-push while the detail stays
  // open re-triggers correctly too.
  watch(() => opts.prDetail.value?.headSha, () => {
    void maybeRunPreReview();
    // The Info tab is the default on PR open — its own tab-change trigger
    // (wired by the host) only fires on a *change*, so also cover the
    // common case where the user never leaves Info.
    if (opts.detailTab.value === "info") void loadSummary();
  });

  /** Called by the host on PR switch / detail close / cwd change. */
  function reset() {
    stopPreReview();
    rawPreReviewFindings.value = [];
    prSummary.value = "";
  }

  // ─── Merged LineAnnotation stream (E1/C4/E2) ─────────────
  const lineAnnotationsByFile = computed<Record<string, LineAnnotation[]>>(() => {
    const map: Record<string, LineAnnotation[]> = {};
    for (const [path, anns] of Object.entries(opts.annotationsByFile.value)) {
      map[path] = anns.map(fromCIAnnotation);
    }
    return map;
  });

  const staticFlags = computed<LineAnnotation[]>(() => {
    // `diffIndex` slices carry raw text only — static flags need parsed
    // hunks, same as the pre-review engine. Cheap (regex-based), fine to
    // recompute per render; this composable doesn't touch the UI's lazy
    // A1 shells.
    const files = opts.diffIndex.value.map((f) => parseFileDiff(f.raw));
    return computeStaticFlags(files, t);
  });

  /** The single stream `PrInlineDiff` renders per file: CI + AI findings +
   *  static flags, merged. */
  const mergedAnnotationsByFile = computed<Record<string, LineAnnotation[]>>(() => {
    const map: Record<string, LineAnnotation[]> = {};
    for (const [path, anns] of Object.entries(lineAnnotationsByFile.value)) {
      map[path] = [...anns];
    }
    for (const finding of preReviewFindings.value) {
      (map[finding.path] ??= []).push(fromFinding(finding));
    }
    for (const flag of staticFlags.value) {
      (map[flag.path] ??= []).push(flag);
    }
    return map;
  });

  return {
    preReviewFindings, preReviewProgress, preReviewRunning, dismissFinding,
    prSummary, prSummaryLoading, loadSummary, regenerateSummary,
    lineAnnotationsByFile, staticFlags, mergedAnnotationsByFile,
    maybeRunPreReview, reset,
    /** Resume the pre-review queue after a hidden→visible transition — the
     *  host calls this from its existing `visibilitychange` handler rather
     *  than this composable adding a second listener. */
    resumePreReviewQueue: reviewQueue.resume,
  };
}
