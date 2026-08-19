<script setup lang="ts">
/**
 * CommitReviewDecisionModal.vue
 *
 * Task 5 (v3.7.0) — the Review / Vouch / Skip decision, shown before a
 * commit goes through when Commit Review is on. Same non-blocking UX
 * contract as the v3.5.0 secrets scanner: this never hard-stops a commit.
 *
 * "Review now" runs the pass and keeps the commit pending (App.vue re-opens
 * CommitReviewModal so the user can look at findings, then commits again
 * when satisfied). "Vouch"/"Skip" record an explicit decision and let the
 * commit proceed immediately. Cancelling (Escape/backdrop/Cancel button, all
 * routed through BaseModal's `close`) cancels the commit outright — it never
 * silently records "skipped" (decision D8: skipping must be a deliberate,
 * explicit click, or the trailer would lie about intent).
 *
 * No custom keyboard shortcuts are added here — `BaseModal` already maps
 * Escape/backdrop-click to `close`, which is exactly the "cancel" behavior
 * this modal wants, so there's nothing else to wire (and nothing else that
 * could get a modifier-key guard wrong).
 */
import { computed } from "vue";
import { useI18n } from "../composables/useI18n";
import BaseModal from "./BaseModal.vue";

const props = withDefaults(
  defineProps<{
    /** Active (filtered) findings count on the staged diff, for context. */
    findingsCount?: number;
    /** Review passes already completed this cycle. */
    iterations?: number;
    /** Share (0-100) of the current staged diff already reviewed. */
    coverage?: number;
    /**
     * Live, undismissed risk-severity finding count (v3.7.0 review-round fix
     * #2/#5). When > 0, shown as a distinct warning line above the actions.
     */
    riskCount?: number;
  }>(),
  { findingsCount: 0, iterations: 0, coverage: 0, riskCount: 0 },
);

const emit = defineEmits<{
  "review-now": [];
  vouch: [];
  skip: [];
  close: [];
}>();

const { t } = useI18n();

/**
 * Three mutually exclusive context strings, driven by iterations/findingsCount
 * (v3.7.0 review-round fix #5): the plain "{0} finding(s)" string used to
 * render identically whether a review ran and found nothing, or no review
 * ever ran at all.
 */
const contextLabel = computed(() => {
  if (props.iterations === 0) return t("commitReview.decisionNotReviewed");
  if (props.findingsCount === 0) return t("commitReview.decisionReviewedClean");
  return t("commitReview.modalSubtitle", props.findingsCount);
});
</script>

<template>
  <BaseModal
    :title="t('commitReview.decisionTitle')"
    size="md"
    role="alertdialog"
    @close="emit('close')"
  >
    <p class="crdm-message">{{ t('commitReview.decisionMessage') }}</p>
    <div class="crdm-context">
      <span>{{ contextLabel }}</span>
      <template v-if="iterations > 0">
        <span class="crdm-context__sep">·</span>
        <span>{{ t('commitReview.iterations', iterations) }}</span>
        <span class="crdm-context__sep">·</span>
        <span>{{ t('commitReview.coverage', coverage) }}</span>
      </template>
    </div>
    <p v-if="riskCount > 0" class="crdm-risk">{{ t('commitReview.decisionRiskWarning', riskCount) }}</p>
    <p class="crdm-hint">{{ t('commitReview.trailerHint') }}</p>

    <template #footer>
      <button type="button" class="bm-btn bm-btn--ghost crdm-cancel" @click="emit('close')">
        {{ t('commitReview.decisionCancel') }}
      </button>
      <button
        type="button"
        class="bm-btn bm-btn--ghost crdm-skip"
        :title="t('commitReview.skipHint')"
        @click="emit('skip')"
      >
        {{ t('commitReview.decisionSkip') }}
      </button>
      <button
        type="button"
        class="bm-btn bm-btn--ghost crdm-vouch"
        :title="t('commitReview.vouchHint')"
        @click="emit('vouch')"
      >
        {{ t('commitReview.decisionVouch') }}
      </button>
      <button type="button" class="bm-btn bm-btn--primary crdm-review-now" @click="emit('review-now')">
        {{ t('commitReview.decisionReviewNow') }}
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.crdm-message {
  color: var(--color-text);
  margin: 0 0 var(--space-3);
}

.crdm-context {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  margin-bottom: var(--space-3);
}

.crdm-hint {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  margin: 0;
}

.crdm-risk {
  color: var(--color-danger);
  font-size: var(--font-size-sm);
  margin: 0 0 var(--space-3);
}

/* Flat, single-class modifiers — never prefix `.bm-btn` with an ancestor
   selector (AGENTS.md modal-CSS rule). */
</style>
