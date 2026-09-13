<script setup lang="ts">
/**
 * v3.11.0 — what apply-from-preview actually did.
 *
 * Extracted rather than inlined: MergePreviewPanel is already 600+ lines, and
 * this is the one surface that has to be scrupulously honest. The preview's
 * number is an estimate by construction (the simulation and the real merge use
 * different algorithms and see a different file set), so when the two disagree
 * this says so instead of quietly showing a different number than the button
 * promised.
 */
import { computed } from "vue";
import { useI18n } from "@/composables/useI18n";
import type { ApplyOutcome } from "@/composables/useApplyFromPreview";

const props = defineProps<{ outcome: ApplyOutcome }>();
const emit = defineEmits<{
  dismiss: [];
  /** Jump into the resolver on the first file that still needs a human. */
  "open-residual": [path: string];
}>();

const { t } = useI18n();

const failed = computed(
  () => props.outcome.stoppedReason === "op-failed" || props.outcome.stoppedReason === "resolve-failed",
);
</script>

<template>
  <div class="mar" :class="failed ? 'mar--error' : 'mar--ok'" role="status">
    <div class="mar__head">
      <span class="mar__title">
        <template v-if="props.outcome.stoppedReason === 'clean'">
          {{ t('mergePreview.applyDone') }}
        </template>
        <template v-else-if="props.outcome.stoppedReason === 'residual'">
          {{ t('mergePreview.applyStopped') }}
        </template>
        <template v-else-if="props.outcome.stoppedReason === 'loop-bound'">
          {{ t('mergePreview.applyLoopBound') }}
        </template>
        <template v-else>{{ t('mergePreview.applyFailed') }}</template>
      </span>
      <button type="button" class="mar__close" :aria-label="t('common.close')" @click="emit('dismiss')">×</button>
    </div>

    <p v-if="props.outcome.operationError" class="mar__error">{{ props.outcome.operationError }}</p>

    <p class="mar__counts">
      {{ t('mergePreview.applyCounts',
            String(props.outcome.appliedHunks),
            String(props.outcome.residualHunks)) }}
    </p>

    <!-- The estimate and the actual can differ by construction. Saying so is
         the difference between a number that was wrong and a number that was
         explained. -->
    <p v-if="props.outcome.estimateDrifted" class="mar__drift">
      {{ t('mergePreview.applyDrift', String(props.outcome.estimatedHunks)) }}
    </p>

    <ul v-if="props.outcome.residualFiles.length > 0" class="mar__files">
      <li v-for="path in props.outcome.residualFiles" :key="path">
        <button type="button" class="mar__file" @click="emit('open-residual', path)">{{ path }}</button>
      </li>
    </ul>

    <!-- No snapshot means no one-click way back. Better said than discovered. -->
    <p v-if="!props.outcome.snapshotId" class="mar__nosnap">{{ t('mergePreview.applyNoSnapshot') }}</p>
  </div>
</template>

<style scoped>
.mar {
  border-top: 1px solid var(--color-border);
  padding: 10px 12px;
}
.mar--error { background: color-mix(in srgb, var(--color-danger) 8%, transparent); }
.mar__head { display: flex; align-items: center; gap: 8px; }
.mar__title { font-weight: 600; font-size: 13px; }
.mar__close {
  margin-left: auto;
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  color: var(--color-text-secondary);
}
.mar__error { margin: 6px 0 0; font-size: 12px; color: var(--color-danger); }
.mar__counts { margin: 6px 0 0; font-size: 12px; color: var(--color-text-secondary); }
.mar__drift { margin: 4px 0 0; font-size: 11px; color: var(--color-warning); }
.mar__nosnap { margin: 4px 0 0; font-size: 11px; color: var(--color-text-secondary); }
.mar__files { margin: 6px 0 0; padding-left: 16px; font-size: 12px; }
.mar__file {
  border: none;
  background: transparent;
  padding: 0;
  cursor: pointer;
  color: var(--color-accent);
  font-family: var(--font-mono);
  font-size: 12px;
}
</style>
