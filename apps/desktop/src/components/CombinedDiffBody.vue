<script setup lang="ts">
/**
 * Presentational body of the combined diff (spec §5.5): header chips (one per
 * commit, replay order), counts, fallback notes, the AI summary block, an own
 * file list, and `CommitDiffViewer` with line attribution. It fetches
 * nothing: `CombinedDiffView` loads the diff and the summary and passes them
 * in, so this renders from props alone.
 */
import { computed, nextTick, ref } from "vue";
import CommitDiffViewer from "./CommitDiffViewer.vue";
import { useI18n } from "../composables/useI18n";
import type { CombinedRequest } from "../composables/useCombinedDiff";
import { formatBytes } from "../composables/useFilePreview";
import { buildCombinedEntries } from "../utils/combinedAttribution";
import { commitColor } from "../utils/commitColors";
import { COMBINED_CANCELLED, combinedErrorMessage } from "../utils/combinedError";
import "../assets/combined-palette.css";
import type { CombinedDiff } from "../utils/backend";
import type { DiffMode } from "../utils/diffMode";

const { t } = useI18n();

const props = defineProps<{
  request: CombinedRequest;
  diffMode: DiffMode;
  data: CombinedDiff | null;
  loading: boolean;
  /** The backend's raw error, localized here. */
  error: string | null;
  /** AI summary: provider available, result, in flight, failed. */
  aiAvailable: boolean;
  summary: string | null;
  summarizing: boolean;
  summaryError: boolean;
}>();

const emit = defineEmits<{
  close: [];
  "select-commit": [hash: string];
  "update:diffMode": [mode: DiffMode];
  retry: [];
  summarize: [];
}>();

const entries = computed(() => (props.data ? buildCombinedEntries(props.data) : []));

const commits = computed(() => props.data?.commits ?? []);
const diffs = computed(() => entries.value.map((e) => e.diff));
const attribution = computed(() => entries.value.map((e) => e.attribution));

function shortOf(hash: string): string {
  return commits.value.find((c) => c.hash === hash)?.shortHash ?? hash.slice(0, 7);
}

/** The banner of a fallback file (null = not a fallback entry). */
function fallbackNote(path: string, fb: { blockers: string[]; conflicted: boolean }): string {
  if (!fb.conflicted) return t("combined.fallbackCompanion", path);
  if (fb.blockers.length === 0) return t("combined.fallbackBetween", path);
  return t("combined.fallbackBlocked", path, fb.blockers.map(shortOf).join(", "));
}

/**
 * One note per entry: the fallback banner on a file's first section, and/or
 * the size notice — "too large (size)" for the 5 MB per-file cap, a neutral
 * "omitted" for an entry the payload budget cut (its byte count is an
 * estimated weight, not the file's size).
 */
const fileNotes = computed<(string | null)[]>(() => {
  const seen = new Set<string>();
  // Keyed by entry: a path's net entry and each of its per-commit sections
  // are cut (or not) on their own.
  const key = (path: string, commit: string | null) => `${commit ?? ""}\0${path}`;
  const omitted = new Set((props.data?.budgetOmitted ?? []).map((o) => key(o.path, o.commit)));
  return entries.value.map((e) => {
    const first = !seen.has(e.diff.path);
    seen.add(e.diff.path);
    const banner = e.fallback && first ? fallbackNote(e.diff.path, e.fallback) : null;
    const big =
      e.diff.truncatedFromBytes === undefined
        ? null
        : omitted.has(key(e.diff.path, e.fallback?.commit ?? null))
          ? t("combined.omittedForSize")
          : t("combined.tooLarge", formatBytes(e.diff.truncatedFromBytes));
    return banner && big ? `${banner} ${big}` : (banner ?? big);
  });
});

const fileCount = computed(() => new Set(entries.value.map((e) => e.diff.path)).size);
const limitedTo = computed(() => props.request.paths?.join(", ") ?? "");

/** `n file(s)`: the number's place is the locale's (`{0}`). */
const filesLabel = (n: number) => t(n === 1 ? "combined.filesSingular" : "combined.filesPlural", n);

/** `+N −M` of the net diff only: a fallback file's per-commit sections are
 *  not net, and a line two commits change would count twice. A header-only
 *  entry (`truncatedFromBytes`) has no lines to count: when one is present
 *  the counts are a lower bound, shown `≥`. */
const stats = computed(() => {
  let adds = 0;
  let dels = 0;
  let uncounted = false;
  for (const d of props.data?.diffs ?? []) {
    if (d.truncatedFromBytes !== undefined) {
      uncounted = true;
      continue;
    }
    for (const h of d.hunks) {
      for (const l of h.lines) {
        if (l.type === "add") adds++;
        else if (l.type === "delete") dels++;
      }
    }
  }
  return { adds, dels, atLeast: uncounted ? "≥" : "" };
});

const fallbackCount = computed(() => props.data?.fallback.length ?? 0);

/** One line under the header when files fell back (spec §5.5). */
const fallbackSummary = computed(() => {
  const fb = props.data?.fallback ?? [];
  if (fb.length === 0) return null;
  const files = filesLabel(fb.length);
  const blockers = [...new Set(fb.flatMap((f) => (f.conflicted ? f.blockers : [])))].map(shortOf);
  if (blockers.length > 0) {
    const shown = blockers.length > 3 ? [...blockers.slice(0, 3), "…"] : blockers;
    return t("combined.fallbackSummary", files, shown.join(", "));
  }
  if (fb.some((f) => f.conflicted)) return t("combined.fallbackSummaryBetween", files);
  return t("combined.fallbackSummaryOther", files);
});

// ─── Own file list ────────────────────────────────────────
const scrollIdx = ref<number | null>(null);
const activeIdx = ref(0);
function openFile(idx: number) {
  activeIdx.value = idx;
  scrollIdx.value = idx;
  nextTick(() => { scrollIdx.value = null; });
}

/** The backend's message in the user's language (unknown ones as is). */
const errorText = computed(() => (props.error ? combinedErrorMessage(props.error, t) : ""));
const cancelled = computed(() => props.error === COMBINED_CANCELLED);
</script>

<template>
  <div class="cmb combined-palette">
    <header class="cmb-header">
      <div class="cmb-chips">
        <button
          v-for="(c, i) in commits"
          :key="c.hash"
          class="cmb-chip"
          :title="t('combined.jumpToCommit', c.shortHash)"
          @click="emit('select-commit', c.hash)"
        >
          <span class="cmb-chip-dot" :style="{ background: commitColor(i) }" aria-hidden="true" />
          <span class="cmb-chip-hash mono">{{ c.shortHash }}</span>
          <span class="cmb-chip-subject">{{ c.subject }}</span>
        </button>
      </div>
      <div class="cmb-meta">
        <span v-if="request.paths?.length" class="cmb-limited mono">{{ t("combined.limitedTo", limitedTo) }}</span>
        <span v-if="data" class="cmb-counts">
          {{ filesLabel(fileCount) }}
          <span class="cmb-add" v-if="stats.adds > 0">{{ stats.atLeast }}+{{ stats.adds }}</span>
          <span class="cmb-del" v-if="stats.dels > 0">{{ stats.atLeast }}&minus;{{ stats.dels }}</span>
          <span v-if="fallbackCount > 0" class="cmb-percommit">{{
            t(fallbackCount === 1 ? "combined.perCommitFilesSingular" : "combined.perCommitFilesPlural", fallbackCount)
          }}</span>
        </span>
        <button
          v-if="aiAvailable && data && commits.length > 0"
          class="cmb-summarize"
          :disabled="summarizing"
          :aria-busy="summarizing"
          @click="emit('summarize')"
        >{{ t("combined.summarize", commits.length) }}</button>
        <button
          class="cmb-mode"
          :class="{ 'cmb-mode--active': diffMode === 'inline' }"
          :title="t('diff.modeInline')"
          :aria-label="t('diff.modeInline')"
          @click="emit('update:diffMode', 'inline')"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><rect x="1" y="2" width="12" height="2" rx="0.5" fill="currentColor" opacity="0.6"/><rect x="1" y="6" width="12" height="2" rx="0.5" fill="currentColor"/><rect x="1" y="10" width="12" height="2" rx="0.5" fill="currentColor" opacity="0.6"/></svg>
        </button>
        <button
          class="cmb-mode"
          :class="{ 'cmb-mode--active': diffMode === 'side-by-side' }"
          :title="t('diff.modeSideBySide')"
          :aria-label="t('diff.modeSideBySide')"
          @click="emit('update:diffMode', 'side-by-side')"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><rect x="1" y="1" width="5" height="12" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/><rect x="8" y="1" width="5" height="12" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>
        </button>
        <button class="cmb-close" :title="t('common.close')" :aria-label="t('common.close')" @click="emit('close')">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          </svg>
        </button>
      </div>
    </header>

    <div v-if="fallbackSummary && !loading" class="cmb-fallback" role="note">{{ fallbackSummary }}</div>
    <div v-if="data?.truncated && !loading" class="cmb-fallback cmb-truncated" role="note">{{ t("combined.payloadTruncated") }}</div>
    <!-- 8 colours (`commitColors.ts`): past 8 commits they repeat; markers and chips carry the short hash. -->
    <div v-if="commits.length > 8 && !loading" class="cmb-fallback cmb-colors-repeat" role="note">{{ t("combined.colorsRepeat") }}</div>

    <div v-if="summary || summaryError" class="cmb-summary" :class="{ 'cmb-summary--error': summaryError }" :role="summaryError ? 'alert' : 'status'">
      <template v-if="summaryError">{{ t("combined.summaryError") }}</template>
      <template v-else>{{ summary }}</template>
    </div>

    <div v-if="loading" class="cmb-state cmb-loading">{{ t("combined.loading", request.hashes.length) }}</div>
    <!-- A replay another caller's request cancelled is no failure: a neutral note. -->
    <div
      v-else-if="error"
      class="cmb-state cmb-error"
      :class="{ 'cmb-error--neutral': cancelled }"
      :role="cancelled ? 'status' : 'alert'"
    >
      <span class="cmb-error-text">{{ errorText }}</span>
      <button class="cmb-retry" @click="emit('retry')">{{ t("combined.retry") }}</button>
    </div>
    <div v-else-if="data && entries.length === 0" class="cmb-state cmb-empty">{{ t("combined.empty") }}</div>
    <div v-else-if="data" class="cmb-body">
      <nav class="cmb-files" :aria-label="t('header.files')">
        <button
          v-for="(e, i) in entries"
          :key="i"
          class="cmb-file"
          :class="{ 'cmb-file--active': i === activeIdx }"
          :title="e.diff.path"
          @click="openFile(i)"
        >
          <span
            v-if="e.attribution.sectionCommit !== undefined"
            class="cmb-chip-dot"
            :style="{ background: commitColor(e.attribution.sectionCommit) }"
            aria-hidden="true"
          />
          <!-- rtl box: the ellipsis cuts the start of a long path; the inner
               ltr bdi keeps its leading/trailing punctuation in place. -->
          <span class="cmb-file-path mono"><bdi dir="ltr">{{ e.diff.path }}</bdi></span>
        </button>
      </nav>
      <CommitDiffViewer
        class="cmb-diff"
        :diffs="diffs"
        :commit-hash="null"
        :commit-info="null"
        :diff-mode="diffMode"
        :scroll-to-file-idx="scrollIdx"
        :attribution="attribution"
        :attribution-commits="commits"
        :file-notes="fileNotes"
        @update:diff-mode="emit('update:diffMode', $event)"
        @update:visible-file-idx="activeIdx = $event"
        @jump-to-commit="emit('select-commit', $event)"
      />
    </div>
  </div>
</template>

<style scoped>
.cmb { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; background: var(--color-bg); }
.cmb-header {
  display: flex; align-items: flex-start; gap: var(--space-3, 8px);
  padding: var(--space-3, 8px); border-bottom: 1px solid var(--color-border);
}
.cmb-chips { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; gap: 6px; max-height: 96px; overflow-y: auto; }
.cmb-chip {
  display: inline-flex; align-items: center; gap: 6px; max-width: 320px;
  padding: 3px 8px; border: 1px solid var(--color-border); border-radius: var(--radius-sm, 6px);
  background: var(--color-bg-secondary); color: var(--color-text); font-size: var(--font-size-sm, 12px); cursor: pointer;
}
.cmb-chip:hover { background: var(--color-bg-hover, rgba(127, 127, 127, 0.12)); }
.cmb-chip:focus-visible, .cmb-file:focus-visible, .cmb-close:focus-visible, .cmb-mode:focus-visible, .cmb-retry:focus-visible {
  outline: 2px solid var(--color-accent); outline-offset: 2px;
}
.cmb-chip-dot { flex: none; width: 8px; height: 8px; border-radius: 2px; }
.cmb-chip-hash { color: var(--color-text-muted); }
.cmb-chip-subject { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cmb-meta { flex: none; display: flex; align-items: center; gap: 6px; font-size: var(--font-size-sm, 12px); color: var(--color-text-muted); }
.cmb-limited { padding: 2px 6px; border: 1px solid var(--color-border); border-radius: var(--radius-sm, 6px); }
.cmb-add { color: var(--color-success, #3fb950); margin-left: 4px; }
.cmb-del { color: var(--color-danger, #f85149); margin-left: 4px; }
.cmb-percommit { margin-left: 6px; }
.cmb-fallback {
  padding: 6px var(--space-4, 12px); border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-secondary); color: var(--color-text-muted); font-size: var(--font-size-sm, 12px);
}
.cmb-mode, .cmb-close {
  display: flex; align-items: center; justify-content: center; width: 28px; height: 28px;
  border: 1px solid var(--color-border); border-radius: var(--radius-sm, 6px);
  background: var(--color-bg-secondary); color: var(--color-text-muted); cursor: pointer;
}
.cmb-mode:hover, .cmb-close:hover { background: var(--color-bg-hover, rgba(127, 127, 127, 0.12)); color: var(--color-text); }
.cmb-summarize {
  padding: 4px 10px; border: 1px solid var(--color-border); border-radius: var(--radius-sm, 6px);
  background: var(--color-bg-secondary); color: var(--color-text); font-size: var(--font-size-sm, 12px); cursor: pointer;
}
.cmb-summarize:hover:not(:disabled) { background: var(--color-bg-hover, rgba(127, 127, 127, 0.12)); }
.cmb-summarize:disabled { opacity: 0.6; cursor: progress; }
.cmb-summarize:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
.cmb-summary {
  padding: var(--space-3, 8px) var(--space-4, 12px); border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-secondary); color: var(--color-text); font-size: var(--font-size-sm, 12px);
  white-space: pre-wrap; max-height: 160px; overflow-y: auto;
}
.cmb-summary--error { color: var(--color-danger, #f85149); }
.cmb-mode--active { color: var(--color-accent); border-color: var(--color-accent); }
.cmb-state { padding: var(--space-5, 16px); color: var(--color-text-muted); display: flex; align-items: center; gap: 10px; }
.cmb-error { color: var(--color-danger, #f85149); }
.cmb-error--neutral { color: var(--color-text-muted); }
.cmb-retry {
  padding: 3px 10px; border: 1px solid var(--color-border); border-radius: var(--radius-sm, 6px);
  background: var(--color-bg-secondary); color: var(--color-text); cursor: pointer;
}
.cmb-body { flex: 1; min-height: 0; display: flex; }
.cmb-files { flex: none; width: 220px; overflow-y: auto; border-right: 1px solid var(--color-border); padding: 4px; display: flex; flex-direction: column; gap: 1px; }
.cmb-file {
  display: flex; align-items: center; gap: 6px; padding: 3px 6px; border: 0; border-radius: var(--radius-sm, 6px);
  background: transparent; color: var(--color-text); font-size: var(--font-size-sm, 12px); text-align: left; cursor: pointer;
}
.cmb-file:hover { background: var(--color-bg-hover, rgba(127, 127, 127, 0.12)); }
.cmb-file--active { background: var(--color-bg-secondary); color: var(--color-accent); }
.cmb-file-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.cmb-diff { flex: 1; min-width: 0; min-height: 0; overflow: hidden; }
</style>
