<script setup lang="ts">
/**
 * CommitReviewModal.vue
 *
 * Task 1b (v3.7.0) — summary + severity-sorted finding list for the
 * staged-diff Commit Review pass. Modelled on `SecretsFindingsModal.vue`.
 * "Fix with agent" (Task 3) and the iteration/coverage slot (Task 4) are
 * out of scope for this PR and land as plain follow-ups on this component.
 */
import { computed } from "vue";
import BaseModal from "./BaseModal.vue";
import { useI18n } from "../composables/useI18n";
import type { ReviewFinding } from "../composables/usePrPreReview";
import { sortFindingsForReview } from "../composables/useCommitReviewNav";

const props = withDefaults(
  defineProps<{
    findings: ReviewFinding[];
    /** Deterministic i18n one-liner (decision D2 — no second LLM call). */
    summary?: string;
    /** True when the staged diff was truncated by the file/byte cap. */
    truncated?: boolean;
  }>(),
  { summary: "", truncated: false },
);

const emit = defineEmits<{
  jump: [id: string];
  dismiss: [id: string];
  close: [];
}>();

const { t } = useI18n();

const SEVERITY_LABEL_KEY: Record<ReviewFinding["severity"], "commitReview.severityRisk" | "commitReview.severitySuggestion" | "commitReview.severityNit"> = {
  risk: "commitReview.severityRisk",
  suggestion: "commitReview.severitySuggestion",
  nit: "commitReview.severityNit",
};

function severityLabel(s: ReviewFinding["severity"]): string {
  return t(SEVERITY_LABEL_KEY[s]);
}

/** Severity-sorted (risk > suggestion > nit), then confidence descending —
 *  shared with `useCommitReviewNav`'s `N`/`P` cycling order (Task 2) so the
 *  modal's list and the keyboard cursor always agree. */
const sortedFindings = computed(() => sortFindingsForReview(props.findings));
</script>

<template>
  <BaseModal
    :title="t('commitReview.modalTitle')"
    :subtitle="t('commitReview.modalSubtitle', props.findings.length)"
    size="lg"
    role="dialog"
    @close="emit('close')"
  >
    <div v-if="props.summary" class="crm-summary">{{ props.summary }}</div>
    <div v-if="props.truncated" class="crm-truncated">{{ t('commitReview.truncatedNotice') }}</div>

    <div v-if="sortedFindings.length === 0" class="crm-empty">{{ t('commitReview.empty') }}</div>
    <ul v-else class="crm-list">
      <li v-for="f in sortedFindings" :key="f.id" class="crm-item">
        <div class="crm-item__main">
          <span class="crm-item__chip" :class="`crm-item__chip--${f.severity}`">{{ severityLabel(f.severity) }}</span>
          <span class="crm-item__confidence mono">{{ t('commitReview.confidence', f.confidence) }}</span>
          <span class="crm-item__location mono">{{ f.path }}:{{ f.line }}</span>
        </div>
        <div class="crm-item__title">{{ f.title }}</div>
        <div class="crm-item__detail">{{ f.detail }}</div>
        <div class="crm-item__actions">
          <button type="button" class="bm-btn bm-btn--ghost crm-btn-compact crm-item__jump" @click="emit('jump', f.id)">
            {{ t('commitReview.jumpTo') }}
          </button>
          <button type="button" class="bm-btn bm-btn--ghost crm-btn-compact crm-item__dismiss" @click="emit('dismiss', f.id)">
            {{ t('commitReview.dismiss') }}
          </button>
        </div>
      </li>
    </ul>

    <template #footer>
      <button type="button" class="bm-btn bm-btn--ghost crm-footer-close" @click="emit('close')">
        {{ t('commitReview.close') }}
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.crm-summary {
  color: var(--color-text);
  margin-bottom: var(--space-4);
}

.crm-truncated {
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  margin-bottom: var(--space-4);
}

.crm-empty {
  color: var(--color-text-muted);
  text-align: center;
  padding: var(--space-6) 0;
}

.crm-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.crm-item {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg);
}

.crm-item__main {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.crm-item__chip {
  flex-shrink: 0;
  padding: 2px var(--space-2);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  border-radius: var(--radius-sm);
  color: #fff;
}
.crm-item__chip--risk { background: var(--color-danger, #dc2626); }
.crm-item__chip--suggestion { background: var(--color-warning, #d97706); }
.crm-item__chip--nit { background: var(--color-text-muted, #6e7681); }

.crm-item__confidence {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}

.crm-item__location {
  font-size: var(--font-size-sm);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.crm-item__title {
  font-weight: var(--font-weight-semibold);
  color: var(--color-text);
}

.crm-item__detail {
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}

.crm-item__actions {
  display: flex;
  gap: var(--space-2);
}

/* Flat, single-class modifier — never prefix `.bm-btn` with an ancestor selector
   (AGENTS.md modal-CSS rule): that raises specificity above `.bm-btn--ghost`
   and can make it silently lose. */
.crm-btn-compact {
  padding: var(--space-2) var(--space-4);
  font-size: var(--font-size-sm);
}
</style>
