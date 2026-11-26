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
import { computed, ref, watch } from "vue";
import {
  gitBisectMark,
  gitBisectReset,
  gitBisectStatus,
  type BisectStatus,
  type BisectVerdict,
} from "../utils/backend";
import { t } from "../composables/useI18n";

const props = defineProps<{
  cwd: string;
  /** Any value that changes when the bisect may have moved (repo state, refs). */
  refreshKey: unknown;
  /** Tracked files are modified: they follow to the next commit. */
  hasTrackedChanges: boolean;
  /** A commit's subject when the parent knows it (the loaded log). */
  describeCommit?: (hash: string) => string | null;
}>();

const emit = defineEmits<{
  /** The bisect moved (marked, ended): the parent reloads repo state and log. */
  (e: "changed"): void;
  (e: "open-commit", hash: string): void;
}>();

const status = ref<BisectStatus | null>(null);
const busy = ref(false);
const error = ref("");

async function load() {
  try {
    status.value = await gitBisectStatus(props.cwd);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

watch(() => [props.cwd, props.refreshKey], load, { immediate: true });

const short = (hash: string | null | undefined) => (hash ? hash.slice(0, 7) : "");
const subject = (hash: string | null | undefined) =>
  (hash && props.describeCommit?.(hash)) || "";

const culprit = computed(() =>
  status.value && status.value.candidates.length === 1 ? status.value.candidates[0] : null,
);
const candidates = computed(() =>
  status.value && status.value.candidates.length > 1 ? status.value.candidates : [],
);
const narrowing = computed(() => !culprit.value && candidates.value.length === 0);

async function act(run: () => Promise<BisectStatus | void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const next = await run();
    if (next) status.value = next;
    emit("changed");
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

const mark = (verdict: BisectVerdict) => act(() => gitBisectMark(props.cwd, verdict));
const end = () => act(() => gitBisectReset(props.cwd));
</script>

<template>
  <div v-if="status" class="bisect-banner" role="status">
    <div class="bisect-icon" aria-hidden="true">
      <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
        <path d="M8 1v14M3 4h10M3 12h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
      </svg>
    </div>

    <div class="bisect-text">
      <template v-if="culprit">
        <span class="bisect-title">{{ t('bisect.culprit', short(culprit)) }}</span>
        <span v-if="subject(culprit)" class="bisect-subject">{{ subject(culprit) }}</span>
      </template>
      <template v-else-if="candidates.length">
        <span class="bisect-title">{{ t('bisect.candidates', candidates.length) }}</span>
        <button v-for="c in candidates" :key="c" class="btn btn--ghost btn--xs bisect-candidate"
          @click="emit('open-commit', c)">
          <code>{{ short(c) }}</code>
          <span v-if="subject(c)">{{ subject(c) }}</span>
        </button>
      </template>
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
      <span v-if="hasTrackedChanges && narrowing" class="bisect-note">{{ t('bisect.dirty') }}</span>
      <span v-if="error" class="bisect-error" role="alert">{{ error }}</span>
    </div>

    <div class="bisect-actions">
      <template v-if="narrowing">
        <button class="btn btn--sm btn--success" :disabled="busy" @click="mark('good')">{{ t('bisect.good') }}</button>
        <button class="btn btn--sm btn--danger" :disabled="busy" @click="mark('bad')">{{ t('bisect.bad') }}</button>
        <button class="btn btn--sm btn--secondary" :disabled="busy" @click="mark('skip')">{{ t('bisect.skip') }}</button>
      </template>
      <button v-if="culprit" class="btn btn--sm btn--primary" :disabled="busy"
        @click="emit('open-commit', culprit)">{{ t('bisect.open') }}</button>
      <button class="btn btn--sm btn--ghost" :disabled="busy"
        :title="t('bisect.endHint', status.start ?? '')" @click="end">{{ t('bisect.end') }}</button>
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
