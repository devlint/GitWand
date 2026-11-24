<script setup lang="ts">
/**
 * RestackDialog — v3.14 stacked branches (spec §6). Renders the restack
 * flow of `useStacks()`: fetching → planning → refused | preview → applying →
 * residual | done | error. The preview is the v3.11 `MergePreviewPanel`, fed
 * by its own `useMergePreview` through `computeRestackPreview`, with the
 * branches the rebase will move. Mounted lazily by App.vue while the flow is
 * not idle.
 */
import { computed, watch } from "vue";
import { useI18n } from "../composables/useI18n";
import { useStacks } from "../composables/useStacks";
import { useMergePreview } from "../composables/useMergePreview";
import { useSettings } from "../composables/useSettings";
import BaseModal from "./BaseModal.vue";
import MergePreviewPanel from "./MergePreviewPanel.vue";
import { restackRefusalText } from "../utils/restackRefusal";

const { t } = useI18n();
const { settings } = useSettings();
const stacks = useStacks();
const flow = stacks.flow;

const preview = useMergePreview(() => flow.value.cwd ?? "");

const plan = computed(() => flow.value.plan);
const busy = computed(() => flow.value.phase === "applying");
const title = computed(() => t("stacks.dialog.title", plan.value?.bottom ?? flow.value.branch ?? ""));

/** `refs/heads/x` / `refs/remotes/origin/x` → the name a user reads. */
const shortRef = (ref: string) => ref.replace(/^refs\/(heads|remotes)\//, "");

const intro = computed(() => {
  const p = plan.value;
  if (!p) return "";
  return p.moment === "parent_merged"
    ? t("stacks.dialog.intro.parent_merged", p.bottom, p.new_parent ?? shortRef(p.onto_ref), p.parent)
    : t("stacks.dialog.intro.parent_moved", p.bottom, p.parent);
});

const refusalText = computed(() => {
  const r = flow.value.refusal;
  if (!r) return "";
  const { key, args } = restackRefusalText(r, plan.value);
  return t(key, ...args);
});

const movingRefs = computed(() => (plan.value?.moving ?? []).map((m) => ({ branch: m.branch, inStack: m.in_stack })));

// Run the predictor once the plan is ready.
watch(
  () => flow.value.phase,
  async (phase) => {
    const p = plan.value;
    if (phase !== "preview" || !p) return;
    preview.threshold.value = settings.value.resolution.minConfidenceScore;
    await preview.computeRestackPreview({
      onto: p.onto_sha,
      upstream: p.upstream_sha,
      branch: p.top,
      // The preview chip reads "← <label>": what the stack is replayed onto.
      label: p.onto_ref,
    });
  },
  { immediate: true },
);

function close() {
  if (busy.value) return;
  stacks.closeRestack();
}
</script>

<template>
  <!-- While applying, nothing closes it: no ✕, no Escape, no backdrop, no footer button. -->
  <BaseModal :title="title" size="lg" :closable="!busy" :hide-close="busy" @close="close">
    <div class="rsd">
      <p v-if="flow.phase === 'fetching'" class="rsd-muted">{{ t("stacks.dialog.fetching") }}</p>
      <p v-else-if="flow.phase === 'planning'" class="rsd-muted">{{ t("stacks.dialog.planning") }}</p>

      <p v-else-if="flow.phase === 'refused'" class="rsd-warn" role="alert">{{ refusalText }}</p>

      <template v-else-if="(flow.phase === 'preview' || flow.phase === 'applying') && plan">
        <p class="rsd-muted">{{ intro }}</p>
        <p v-if="flow.fetchWarning" class="rsd-warn">{{ t("stacks.dialog.fetchFailed", flow.fetchWarning, plan.parent) }}</p>
        <MergePreviewPanel
          embedded
          :loading="preview.loading.value"
          :error="preview.error.value"
          :summary="preview.summary.value"
          :conflicting-files="preview.conflictingFiles.value"
          :moving-refs="movingRefs"
          :risk-level="preview.riskLevel.value"
          operation="rebase"
          :target-branch="plan.new_parent ?? shortRef(plan.onto_ref)"
          :threshold="preview.threshold.value"
          :estimated-auto-resolutions="preview.estimatedAutoResolutions.value"
          :held-by-threshold="preview.heldByThreshold.value"
          :manual-hunks="preview.manualHunks.value"
          :applying="flow.phase === 'applying'"
          :apply-outcome="flow.outcome"
          @update:threshold="preview.threshold.value = $event"
          @apply="stacks.applyRestack(preview.estimatedAutoResolutions.value)"
        />
      </template>

      <p v-else-if="flow.phase === 'residual'" class="rsd-warn">{{ t("stacks.dialog.residual") }}</p>
      <p v-else-if="flow.phase === 'done'">{{ t("stacks.dialog.done") }}</p>
      <p v-else-if="flow.phase === 'error'" class="rsd-error" role="alert">{{ flow.error }}</p>
    </div>

    <template #footer>
      <button v-if="flow.phase === 'preview' || flow.phase === 'fetching' || flow.phase === 'planning'" class="bm-btn bm-btn--ghost" @click="close">
        {{ t("common.cancel") }}
      </button>
      <button
        v-else-if="flow.phase !== 'applying'"
        class="bm-btn bm-btn--primary"
        @click="close"
      >{{ t("common.close") }}</button>
    </template>
  </BaseModal>
</template>

<style scoped>
.rsd {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  font-size: var(--font-size-sm);
  line-height: 1.5;
}
.rsd p {
  margin: 0;
}
/* The preview card is capped for the branch-selector popover; in this modal it fills the width. */
.rsd :deep(.preview-panel) {
  max-width: none;
}
.rsd-muted {
  color: var(--color-text-muted);
}
.rsd-warn {
  color: var(--color-warning, var(--color-text));
}
.rsd-error {
  color: var(--color-danger);
}
</style>
