<script setup lang="ts">
/**
 * v2.5 — LlmTracePanel
 *
 * Renders the audit trail (`LlmTrace`) for a hunk that was resolved by the
 * LLM fallback (`decision.type === "llm_proposed"`). Mounted above the
 * standard 3-way diff in `MergeEditor.vue` so the user can see:
 *
 *   - which model produced the resolution
 *   - how confident the post-merge validation was (score 0-100)
 *   - the timing and a content-addressable hash of the prompt
 *   - the truncated raw response (audit / debugging)
 *
 * Two outbound events:
 *   - `accept` — confirm the LLM's proposed resolution (UX-only "lock in")
 *   - `reject` — downgrade the hunk to `complex`, opening the manual editor
 *
 * The `LlmTrace` shape comes from `@gitwand/core` (`packages/core/src/types.ts`).
 * Fields used here: `model`, `validationScore`, `calledAt`, `latencyMs`,
 * `promptHash`, `rawResponseTruncated`. The `accepted` flag is ignored at
 * this layer — the panel surfaces the data, the parent decides the action.
 */
import { computed, ref } from "vue";
import type { LlmTrace } from "@gitwand/core";
import { useI18n } from "../composables/useI18n";

const { t } = useI18n();

const props = defineProps<{
  /** The audit trace emitted by the LLM fallback resolver. */
  trace: LlmTrace;
  /** File path the hunk belongs to (informational — passed back in events). */
  filePath: string;
  /**
   * Stable hunk identifier — `hunkIndex` (number) is fine, the parent
   * passes whatever it uses internally. We keep it opaque from the
   * panel's perspective.
   */
  hunkId: string | number;
}>();

const emit = defineEmits<{
  /** User accepted the LLM resolution as-is. */
  accept: [hunkId: string | number];
  /** User wants to redo this hunk manually — parent downgrades to `complex`. */
  reject: [hunkId: string | number];
}>();

// ─── Derived values ────────────────────────────────────

/** 0–100 score, clamped defensively in case the core ever emits an outlier. */
const score = computed(() => {
  const raw = props.trace.validationScore;
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(100, Math.round(raw)));
});

/**
 * Bar fill colour bucket.
 *   - red  : < 60   (would be rejected by any sensible `minPostMergeScore`)
 *   - amber: 60–79  (passes a loose threshold, still worth a human look)
 *   - green: ≥ 80   (default `minPostMergeScore` accepts at 80)
 */
const scoreBucket = computed<"low" | "mid" | "high">(() => {
  const s = score.value;
  if (s < 60) return "low";
  if (s < 80) return "mid";
  return "high";
});

/**
 * Format the ISO timestamp into the user's locale.
 * Falls back to the raw string if `Date` parsing fails (defensive — should
 * never happen with a `calledAt` produced by `new Date().toISOString()`).
 */
const callTimeLabel = computed(() => {
  const iso = props.trace.calledAt;
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
});

/** First 8 characters of the hash — enough to spot collisions in audit logs. */
const shortHash = computed(() => {
  const h = props.trace.promptHash ?? "";
  return h.length > 8 ? h.slice(0, 8) : h;
});

/**
 * 2 KB hard cap on the displayed raw response. The core already truncates
 * to 500 chars in `rawResponseTruncated`, but we apply our own ceiling
 * defensively so a future schema change (or a custom endpoint that
 * over-shares) can't accidentally dump a megabyte into the DOM.
 */
const MAX_RAW_BYTES = 2048;

const rawResponseDisplay = computed(() => {
  const raw = props.trace.rawResponseTruncated ?? "";
  if (raw.length <= MAX_RAW_BYTES) return raw;
  return raw.slice(0, MAX_RAW_BYTES) + "\n…";
});

const wasTruncatedByPanel = computed(
  () => (props.trace.rawResponseTruncated ?? "").length > MAX_RAW_BYTES,
);

// ─── Copy hash to clipboard ────────────────────────────

const copyState = ref<"idle" | "ok" | "err">("idle");

async function copyHash() {
  const full = props.trace.promptHash ?? "";
  if (!full) return;
  try {
    // `navigator.clipboard` is gated behind a secure context — Tauri's
    // tauri://localhost qualifies, and Vite dev runs on http://localhost
    // which Chromium treats as secure too. If it ever fails (older
    // webview, no permission), we surface a visual "err" without
    // throwing — the hash is still visible on screen so the user can
    // copy it by selection.
    await navigator.clipboard.writeText(full);
    copyState.value = "ok";
  } catch {
    copyState.value = "err";
  } finally {
    setTimeout(() => {
      copyState.value = "idle";
    }, 1500);
  }
}

// ─── Actions ───────────────────────────────────────────

function onAccept() {
  emit("accept", props.hunkId);
}

function onReject() {
  emit("reject", props.hunkId);
}
</script>

<template>
  <section class="llm-trace" :aria-label="t('mergeEditor.llmResolution.title')">
    <!-- Header: sparkle icon + title + model chip -->
    <header class="llm-trace__header">
      <span class="llm-trace__icon" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 1L9.5 5.5L14 7L9.5 8.5L8 13L6.5 8.5L2 7L6.5 5.5L8 1Z"/>
        </svg>
      </span>
      <h3 class="llm-trace__title">{{ t('mergeEditor.llmResolution.title') }}</h3>
      <span class="llm-trace__model mono" :title="trace.model">{{ trace.model }}</span>
    </header>

    <!-- Validation score bar -->
    <div class="llm-trace__score">
      <div class="llm-trace__score-label">
        <span>Validation score</span>
        <span class="mono">{{ score }}/100</span>
      </div>
      <div class="llm-trace__bar" role="progressbar" :aria-valuenow="score" aria-valuemin="0" aria-valuemax="100">
        <div
          class="llm-trace__bar-fill"
          :class="['llm-trace__bar-fill--' + scoreBucket]"
          :style="{ width: score + '%' }"
        ></div>
      </div>
    </div>

    <!-- Audit grid: time, latency, hash -->
    <dl class="llm-trace__audit">
      <div class="llm-trace__audit-item">
        <dt>Called at</dt>
        <dd class="mono">{{ callTimeLabel }}</dd>
      </div>
      <div class="llm-trace__audit-item">
        <dt>Latency</dt>
        <dd class="mono">{{ trace.latencyMs }} ms</dd>
      </div>
      <div class="llm-trace__audit-item llm-trace__audit-item--hash">
        <dt>Prompt hash</dt>
        <dd class="mono">
          <span :title="trace.promptHash">{{ shortHash || '—' }}</span>
          <button
            v-if="shortHash"
            type="button"
            class="llm-trace__copy"
            :class="{ 'llm-trace__copy--ok': copyState === 'ok', 'llm-trace__copy--err': copyState === 'err' }"
            :aria-label="'Copy ' + trace.promptHash"
            @click="copyHash"
          >
            {{ copyState === 'ok' ? '✓' : copyState === 'err' ? '!' : 'Copy' }}
          </button>
        </dd>
      </div>
    </dl>

    <!-- Raw response (collapsible) -->
    <details v-if="rawResponseDisplay" class="llm-trace__details">
      <summary>{{ t('mergeEditor.llmResolution.details') }}</summary>
      <pre class="llm-trace__raw mono">{{ rawResponseDisplay }}</pre>
      <p v-if="wasTruncatedByPanel" class="llm-trace__truncation-note">
        (truncated to {{ MAX_RAW_BYTES }} bytes for display)
      </p>
    </details>

    <!-- Actions -->
    <div class="llm-trace__actions">
      <button
        type="button"
        class="llm-trace__btn llm-trace__btn--primary"
        :data-hunk-id="String(hunkId)"
        :data-file-path="filePath"
        @click="onAccept"
      >
        {{ t('mergeEditor.llmResolution.accept') }}
      </button>
      <button
        type="button"
        class="llm-trace__btn llm-trace__btn--secondary"
        :data-hunk-id="String(hunkId)"
        @click="onReject"
      >
        {{ t('mergeEditor.llmResolution.reject') }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.llm-trace {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  padding: var(--space-5) var(--space-6);
  margin: var(--space-4) 0;
  background: var(--color-accent-soft);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text);
}

.llm-trace__header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.llm-trace__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--color-accent);
}

.llm-trace__title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.01em;
}

.llm-trace__model {
  margin-left: auto;
  padding: var(--space-1) var(--space-3);
  font-size: 11px;
  background: var(--color-surface, rgba(0, 0, 0, 0.06));
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  white-space: nowrap;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ─── Score bar ─── */
.llm-trace__score {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.llm-trace__score-label {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  opacity: 0.8;
}

.llm-trace__bar {
  position: relative;
  width: 100%;
  height: 6px;
  border-radius: var(--radius-pill);
  background: var(--color-border);
  overflow: hidden;
}

.llm-trace__bar-fill {
  height: 100%;
  border-radius: var(--radius-pill);
  transition: width 200ms ease-out;
}

.llm-trace__bar-fill--low  { background: var(--color-danger); }
.llm-trace__bar-fill--mid  { background: var(--color-warning); }
.llm-trace__bar-fill--high { background: var(--color-success); }

/* ─── Audit grid ─── */
.llm-trace__audit {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: var(--space-4);
  margin: 0;
}

.llm-trace__audit-item {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.llm-trace__audit-item dt {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.6;
}

.llm-trace__audit-item dd {
  margin: 0;
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.llm-trace__copy {
  appearance: none;
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text);
  font-size: 10px;
  padding: 1px var(--space-2);
  border-radius: var(--radius-xs);
  cursor: pointer;
  opacity: 0.7;
}

.llm-trace__copy:hover { opacity: 1; }
.llm-trace__copy--ok  { color: var(--color-success); border-color: var(--color-success); opacity: 1; }
.llm-trace__copy--err { color: var(--color-danger);  border-color: var(--color-danger);  opacity: 1; }

/* ─── Details / raw response ─── */
.llm-trace__details {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface, rgba(0, 0, 0, 0.04));
}

.llm-trace__details summary {
  padding: var(--space-3) var(--space-4);
  cursor: pointer;
  font-size: 12px;
  user-select: none;
}

.llm-trace__details summary::-webkit-details-marker {
  color: var(--color-accent);
}

.llm-trace__raw {
  max-height: 240px;
  overflow: auto;
  margin: 0;
  padding: var(--space-3) var(--space-4);
  font-size: 11px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
  border-top: 1px solid var(--color-border);
}

.llm-trace__truncation-note {
  margin: 0;
  padding: var(--space-2) var(--space-4) var(--space-3);
  font-size: 10px;
  opacity: 0.6;
  border-top: 1px solid var(--color-border);
}

/* ─── Actions ─── */
.llm-trace__actions {
  display: flex;
  gap: var(--space-3);
  justify-content: flex-end;
}

.llm-trace__btn {
  appearance: none;
  font-size: 12px;
  padding: var(--space-3) var(--space-5);
  border-radius: var(--radius-sm);
  cursor: pointer;
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text);
  transition: background 120ms ease-out, border-color 120ms ease-out;
}

.llm-trace__btn--primary {
  background: var(--color-accent);
  border-color: var(--color-accent);
  color: var(--color-accent-text);
}

.llm-trace__btn--primary:hover {
  background: var(--color-accent-hover);
  border-color: var(--color-accent-hover);
}

.llm-trace__btn--secondary:hover {
  border-color: var(--color-text);
}
</style>
