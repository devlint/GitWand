<script setup lang="ts">
/**
 * BisectBanner — a bisect in progress (design:
 * docs/superpowers/specs/2026-11-26-guided-bisect-design.md).
 *
 * Shown in place of RebaseProgressBanner when `git_repo_state` reports
 * `bisect`, whether GitWand or a terminal started it. Reads the bisect with
 * `gitBisectStatus` (on mount and whenever `refreshKey` changes) and drives
 * it with Good / Bad / Skip and End bisect. Once git cannot narrow further,
 * it names the first bad commit (or the candidates skips left) and offers to
 * open it.
 */
import { toRef } from "vue";
import { useBisectStatus } from "../composables/useBisectStatus";
import { t, useI18n } from "../composables/useI18n";

const props = defineProps<{
  cwd: string;
  /** Any value that changes when the bisect may have moved (repo state, refs). */
  refreshKey: unknown;
  /** Tracked files are modified: they follow to the next commit. */
  hasTrackedChanges: boolean;
}>();

const emit = defineEmits<{
  /** The bisect moved (marked, ended): the parent reloads repo state and log. */
  (e: "changed"): void;
  (e: "open-commit", hash: string): void;
}>();

const cwd = toRef(props, "cwd");
const { status, busy, error, culprit, candidates, narrowing, pending, noResult, customTerms, info, mark, end, endFailed, endHere } =
  useBisectStatus({
    cwd: () => cwd.value,
    refreshKey: () => props.refreshKey,
    onChanged: () => emit("changed"),
  });

const { locale } = useI18n();
const short = (hash: string | null | undefined) => (hash ? hash.slice(0, 7) : "");
const subject = (hash: string | null | undefined) => info(hash)?.subject ?? "";
/** "Jane, 20 Nov 2026" for the result line. */
const byline = (hash: string | null | undefined) => {
  const c = info(hash);
  if (!c) return "";
  const d = new Date(c.date);
  // In the app's language, not the OS's.
  return isNaN(d.getTime()) ? c.author : `${c.author}, ${d.toLocaleDateString(locale.value)}`;
};
/** A bisect with its own terms names them on the buttons. */
const label = (verdict: "good" | "bad") => {
  const base = t(verdict === "good" ? "bisect.good" : "bisect.bad");
  const terms = customTerms.value;
  return terms ? `${base} (${verdict === "good" ? terms[1] : terms[0]})` : base;
};
</script>

<template>
  <!-- Shown on a failed first read too: the error, and End bisect as a way out. -->
  <div v-if="status || error" class="bisect-banner" role="status">
    <div class="bisect-icon" aria-hidden="true">
      <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
        <path d="M8 1v14M3 4h10M3 12h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
      </svg>
    </div>

    <div class="bisect-text">
      <template v-if="culprit">
        <span class="bisect-title">{{ t('bisect.culprit', short(culprit)) }}</span>
        <span v-if="subject(culprit)" class="bisect-subject">{{ subject(culprit) }}</span>
        <span v-if="byline(culprit)" class="bisect-meta">{{ byline(culprit) }}</span>
      </template>
      <template v-else-if="candidates.length">
        <span class="bisect-title">{{ t('bisect.candidates', candidates.length) }}</span>
        <button v-for="c in candidates" :key="c" class="btn btn--ghost btn--xs bisect-candidate"
          @click="emit('open-commit', c)">
          <code>{{ short(c) }}</code>
          <span v-if="subject(c)">{{ subject(c) }}</span>
        </button>
      </template>
      <span v-else-if="!status" class="bisect-title">{{ t('bisect.title') }}</span>
      <template v-else>
        <span class="bisect-title">{{ t('bisect.title') }}</span>
        <span v-if="status.current" class="bisect-meta">
          {{ t('bisect.testing', short(status.current)) }}
          <span v-if="subject(status.current)" class="bisect-subject">{{ subject(status.current) }}</span>
        </span>
        <span class="bisect-meta">
          {{ status.remaining !== null && status.steps !== null
            ? t('bisect.left', status.remaining, status.steps)
            : t('bisect.needEnds') }}
        </span>
        <span class="bisect-meta bisect-counts">
          {{ t('bisect.counts', status.good.length, status.bad ? 1 : 0, status.skipped.length) }}
        </span>
      </template>
      <span v-if="pending" class="bisect-note">{{ t('bisect.pending') }}</span>
      <span v-else-if="noResult" class="bisect-note">{{ t('bisect.noTestable') }}</span>
      <span v-else-if="hasTrackedChanges && narrowing && status" class="bisect-note">{{ t('bisect.dirty') }}</span>
      <span v-if="error" class="bisect-error" role="alert">{{ error }}</span>
    </div>

    <div class="bisect-actions">
      <template v-if="status">
        <button v-if="pending" class="btn btn--sm btn--primary" :disabled="busy" @click="mark('next')">{{ t('bisect.continue') }}</button>
        <template v-else-if="narrowing && !noResult">
          <button class="btn btn--sm btn--success" :disabled="busy" @click="mark('good')">{{ label('good') }}</button>
          <button class="btn btn--sm btn--danger" :disabled="busy" @click="mark('bad')">{{ label('bad') }}</button>
          <button class="btn btn--sm btn--secondary" :disabled="busy" @click="mark('skip')">{{ t('bisect.skip') }}</button>
        </template>
      </template>
      <button v-if="culprit" class="btn btn--sm btn--primary" :disabled="busy"
        @click="emit('open-commit', culprit)">{{ t('bisect.open') }}</button>
      <button class="btn btn--sm btn--ghost" :disabled="busy"
        :title="t('bisect.endHint', status?.start ?? '')" @click="end">{{ t('bisect.end') }}</button>
      <button v-if="endFailed" class="btn btn--sm btn--secondary" :disabled="busy"
        :title="t('bisect.endHereHint')" @click="endHere">{{ t('bisect.endHere') }}</button>
    </div>
  </div>
</template>

<style scoped>
.bisect-banner {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-6);
  background: var(--color-warning-bg);
  border-left: 3px solid var(--color-warning);
  flex-shrink: 0;
}

.bisect-icon {
  flex-shrink: 0;
  line-height: 0;
  color: var(--color-warning);
}

.bisect-text {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  flex: 1;
  min-width: 0;
}

.bisect-title {
  font-size: var(--font-size-md);
  font-weight: 600;
  color: var(--color-text);
}

.bisect-meta,
.bisect-subject {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}

.bisect-subject {
  font-style: italic;
}

.bisect-counts {
  font-variant-numeric: tabular-nums;
}

.bisect-candidate {
  display: inline-flex;
  gap: var(--space-2);
}

.bisect-note {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}

.bisect-error {
  font-size: var(--font-size-sm);
  color: var(--color-danger);
}

.bisect-actions {
  display: flex;
  gap: var(--space-2);
  flex-shrink: 0;
}
</style>
