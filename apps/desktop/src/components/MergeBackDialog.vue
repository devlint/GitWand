<script setup lang="ts">
/**
 * MergeBackDialog — v3.13: bring a task's work back (spec §6.1). Renders
 * the phases of `useWorktreeMergeBack`; the preview is the v3.11
 * `MergePreviewPanel`, run in the checkout the mode operates on.
 *
 * While the user resolves what the engine left, the dialog is minimized
 * (App.vue keeps it mounted) and reopened with "Resume merge-back".
 */
import { computed, onMounted, watch } from "vue";
import { useI18n } from "../composables/useI18n";
import { useWorktreeMergeBack, type MergeBackMode } from "../composables/useWorktreeMergeBack";
import { useMergePreview } from "../composables/useMergePreview";
import { useSettings } from "../composables/useSettings";
import BaseModal from "./BaseModal.vue";
import MergePreviewPanel from "./MergePreviewPanel.vue";

const props = defineProps<{
  /** Any checkout of the repo. */
  cwd: string;
  /** The task worktree. */
  path: string;
  /** Local branch names, for the target. */
  branches: string[];
  /** Hidden while the user resolves; the flow's state is kept. */
  minimized?: boolean;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  /** Hide while the user resolves; App shows a "Resume merge-back" button. */
  (e: "minimize"): void;
  /** "Remove the worktree": App opens the removal dialog. */
  (e: "cleanup", payload: { deleteBranch: boolean }): void;
  (e: "open-residual", path: string): void;
}>();

const { t } = useI18n();
const { settings } = useSettings();
const flow = useWorktreeMergeBack();
const st = flow.state;

const preview = useMergePreview(() => flow.previewSpec.value?.cwd ?? props.cwd);

const MODES: MergeBackMode[] = ["merge", "rebase", "squash"];
const busy = computed(() => ["checking", "preparing", "applying", "finishing"].includes(st.value.phase));
const refusal = computed(() => st.value.check?.refusal ?? null);

onMounted(() => flow.open({ cwd: props.cwd, path: props.path }));

// Run the predictor once the task is prepared, in the right checkout.
watch(
  () => st.value.phase,
  async (phase) => {
    const spec = flow.previewSpec.value;
    if (phase !== "preview" || !spec) return;
    preview.threshold.value = settings.value.resolution.minConfidenceScore;
    await preview.computePreview(spec.ref, spec.operation);
  },
);

async function onTargetChange(e: Event) {
  await flow.setTarget((e.target as HTMLInputElement).value);
}

function close() {
  if (busy.value) return;
  emit("close");
}

function refusalText(): string {
  const r = refusal.value;
  if (!r) return "";
  return t(`mergeBack.refusal.${r.code}` as const, st.value.check?.target ?? "", st.value.check?.main_branch ?? "");
}
</script>

<template>
  <BaseModal v-if="!minimized" :title="t('mergeBack.title', st.check?.name ?? '')" size="lg" :closable="!busy" @close="close">
    <div class="mbd">
      <p v-if="st.phase === 'checking' || st.phase === 'idle'" class="mbd-muted">{{ t("mergeBack.checking") }}</p>

      <template v-else-if="st.phase === 'choose' && st.check">
        <p class="mbd-muted mono">{{ st.check.task_branch }} · {{ t("mergeBack.commits", st.check.task_commits) }}</p>
        <label class="mbd-field">
          <span>{{ t("mergeBack.target") }}</span>
          <input class="mbd-input mono" list="mbd-branches" :value="st.check.target" @change="onTargetChange" />
          <datalist id="mbd-branches">
            <option v-for="b in branches" :key="b" :value="b" />
          </datalist>
        </label>
        <fieldset class="mbd-modes">
          <legend>{{ t("mergeBack.mode") }}</legend>
          <label v-for="m in MODES" :key="m" class="mbd-mode">
            <input type="radio" name="mbd-mode" :value="m" :checked="st.mode === m" @change="flow.setMode(m)" />
            <span>
              <strong>{{ t(`mergeBack.modes.${m}`) }}</strong>
              <span class="mbd-muted">{{ t(`mergeBack.modesHint.${m}`) }}</span>
            </span>
          </label>
        </fieldset>
        <p v-if="st.check.task_dirty" class="mbd-muted">{{ t("mergeBack.wipNote", st.check.name) }}</p>
        <p class="mbd-muted">{{ t("mergeBack.snapshotNote") }}</p>
        <div v-if="refusal" class="mbd-warn" role="alert">
          <p>{{ refusalText() }}</p>
          <ul v-if="refusal.paths.length" class="mbd-list mono">
            <li v-for="p in refusal.paths" :key="p">{{ p }}</li>
          </ul>
        </div>
      </template>

      <p v-else-if="st.phase === 'preparing'" class="mbd-muted">{{ t("mergeBack.preparing") }}</p>

      <template v-else-if="st.phase === 'processes'">
        <p class="mbd-warn">{{ t("worktree.processesTitle") }}</p>
        <ul class="mbd-list mono">
          <li v-for="p in st.survivors" :key="p.pid">{{ p.name }} ({{ p.pid }})</li>
        </ul>
      </template>

      <template v-else-if="st.phase === 'preview' || st.phase === 'applying'">
        <p class="mbd-muted">
          {{ t(`mergeBack.previewIntro.${st.mode}`, st.check?.task_branch ?? "", st.check?.target ?? "") }}
        </p>
        <p v-if="st.committedWip" class="mbd-muted">{{ t("mergeBack.wipCommitted") }}</p>
        <MergePreviewPanel
          embedded
          :loading="preview.loading.value"
          :error="preview.error.value"
          :summary="preview.summary.value"
          :conflicting-files="preview.conflictingFiles.value"
          :risk-level="preview.riskLevel.value"
          :operation="flow.previewSpec.value?.operation"
          :target-branch="st.check?.target"
          :threshold="preview.threshold.value"
          :estimated-auto-resolutions="preview.estimatedAutoResolutions.value"
          :held-by-threshold="preview.heldByThreshold.value"
          :manual-hunks="preview.manualHunks.value"
          :applying="st.phase === 'applying'"
          :apply-outcome="st.outcome"
          @update:threshold="preview.threshold.value = $event"
          @apply="flow.apply(preview.estimatedAutoResolutions.value)"
          @open-residual="(p) => emit('open-residual', p)"
        />
      </template>

      <template v-else-if="st.phase === 'residual'">
        <p class="mbd-warn">{{ t(st.mode === "rebase" ? "mergeBack.residualRebase" : "mergeBack.residualMerge") }}</p>
        <ul v-if="st.outcome?.residualFiles.length" class="mbd-list mono">
          <li v-for="f in st.outcome.residualFiles" :key="f">
            <a href="#" @click.prevent="emit('open-residual', f); emit('minimize')">{{ f }}</a>
          </li>
        </ul>
        <p v-if="st.error" class="mbd-error">{{ st.error === "abandoned" ? t("mergeBack.abandoned") : st.error }}</p>
      </template>

      <p v-else-if="st.phase === 'finishing'" class="mbd-muted">{{ t("mergeBack.finishing", st.check?.target ?? "") }}</p>

      <template v-else-if="st.phase === 'done'">
        <p>{{ t(`mergeBack.done.${st.mode}`, st.check?.target ?? "") }}</p>
        <p class="mbd-muted">
          {{ st.mode === "squash" ? t("mergeBack.cleanupSquash", st.check?.task_branch ?? "") : t("mergeBack.cleanupMerged") }}
        </p>
      </template>

      <p v-else-if="st.phase === 'error'" class="mbd-error">{{ t("mergeBack.failed", st.error ?? "") }}</p>
    </div>

    <template #footer>
      <template v-if="st.phase === 'choose'">
        <button class="bm-btn bm-btn--ghost" @click="close">{{ t("common.cancel") }}</button>
        <button v-if="flow.canSwitch.value" class="bm-btn bm-btn--ghost" @click="flow.switchMain()">
          {{ t("mergeBack.switchMain", st.check?.target ?? "") }}
        </button>
        <button class="bm-btn bm-btn--primary" :disabled="!!refusal" @click="flow.start()">{{ t("mergeBack.continue") }}</button>
      </template>
      <template v-else-if="st.phase === 'processes'">
        <button class="bm-btn bm-btn--ghost" @click="close">{{ t("common.cancel") }}</button>
        <button class="bm-btn bm-btn--primary" @click="flow.start()">{{ t("worktree.processesRetry") }}</button>
      </template>
      <template v-else-if="st.phase === 'preview'">
        <button class="bm-btn bm-btn--ghost" @click="close">{{ t("common.cancel") }}</button>
      </template>
      <template v-else-if="st.phase === 'residual'">
        <button class="bm-btn bm-btn--ghost" @click="emit('minimize')">{{ t("mergeBack.resolveNow") }}</button>
        <button class="bm-btn bm-btn--primary" @click="flow.resume()">{{ t("mergeBack.resume") }}</button>
      </template>
      <template v-else-if="st.phase === 'done'">
        <button class="bm-btn bm-btn--ghost" @click="close">{{ t("common.close") }}</button>
        <button class="bm-btn bm-btn--danger" @click="emit('cleanup', flow.cleanup.value ?? { deleteBranch: false })">
          {{ t("mergeBack.removeWorktree") }}
        </button>
      </template>
      <template v-else-if="st.phase === 'error'">
        <button class="bm-btn bm-btn--primary" @click="close">{{ t("common.close") }}</button>
      </template>
    </template>
  </BaseModal>
</template>

<style scoped>
.mbd {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  font-size: var(--font-size-sm);
  line-height: 1.5;
}
.mbd p {
  margin: 0;
}
.mono {
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
}
.mbd-muted {
  color: var(--color-text-muted);
}
.mbd-warn {
  color: var(--color-warning, var(--color-text));
}
.mbd-error {
  color: var(--color-danger);
}
.mbd-list {
  margin: 0;
  padding-left: var(--space-4);
}
.mbd-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.mbd-input {
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-secondary);
  color: var(--color-text);
}
.mbd-modes {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  border: none;
}
.mbd-modes legend {
  margin-bottom: var(--space-1);
}
.mbd-mode {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  cursor: pointer;
}
.mbd-mode > span {
  display: flex;
  flex-direction: column;
}
</style>
