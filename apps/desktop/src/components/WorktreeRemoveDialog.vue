<script setup lang="ts">
/**
 * WorktreeRemoveDialog — v3.13: every worktree removal goes through this
 * dialog (worktree manager, AI-task close, Git Tree, merge-back cleanup).
 * It renders the phases of `useWorktreeRemoval`; the sequence and the
 * guards live there and in the backend.
 */
import { computed, onMounted, ref } from "vue";
import { useI18n } from "../composables/useI18n";
import { useWorktreeRemoval } from "../composables/useWorktreeRemoval";
import type { RemoveOutcome } from "../utils/backend";
import BaseModal from "./BaseModal.vue";

const props = withDefaults(
  defineProps<{
    /** Any checkout of the repo, outside the worktree. */
    cwd: string;
    /** The repo key the teardown tab is listed under. */
    repoPath: string;
    path: string;
    /** "Also delete branch", pre-ticked. */
    deleteBranch?: boolean;
    /** Skip the confirmation for a worktree GitWand owns (merge-back cleanup). */
    autoStart?: boolean;
  }>(),
  { deleteBranch: false, autoStart: false },
);

const emit = defineEmits<{
  (e: "close"): void;
  (e: "done", outcome: RemoveOutcome): void;
  (e: "open-log", payload: { repoPath: string; tabId: number }): void;
}>();

const { t } = useI18n();
const flow = useWorktreeRemoval();
const st = flow.state;

const name = computed(() => props.path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? props.path);
const alsoDeleteBranch = ref(props.deleteBranch);
const notOwnedAck = ref(false);
const anywayAsked = ref(false);

const busy = computed(() => ["checking", "stopping", "teardown", "removing"].includes(st.value.phase));
const canRemove = computed(() => st.value.guard?.owned || notOwnedAck.value);

onMounted(async () => {
  await flow.check({
    repoPath: props.repoPath,
    cwd: props.cwd,
    path: props.path,
    name: name.value,
    deleteBranch: props.deleteBranch,
  });
  if (props.autoStart && st.value.phase === "confirm" && st.value.guard?.owned) await remove();
  else finishIfDone();
});

async function remove() {
  await flow.confirm({ confirmNotOwned: notOwnedAck.value, deleteBranch: alsoDeleteBranch.value });
  finishIfDone();
}

async function run(action: () => Promise<void>) {
  await action();
  finishIfDone();
}

/** Close on success, unless there is something to say first. */
function finishIfDone() {
  const s = st.value;
  if (s.phase !== "done" || !s.outcome) return;
  if (!s.skippedHooks && s.outcome.warnings.length === 0) emit("done", s.outcome);
}

function close() {
  if (busy.value) return;
  if (st.value.phase === "done" && st.value.outcome) emit("done", st.value.outcome);
  else emit("close");
}

function openLog() {
  if (st.value.tabId != null) emit("open-log", { repoPath: props.repoPath, tabId: st.value.tabId });
}

function reasonText(r: string): string {
  if (r === "locked") return t("worktree.reasonLocked");
  if (r === "keep-file") return t("worktree.reasonKeepFile");
  return t("worktree.reasonOtherTool");
}
</script>

<template>
  <BaseModal :title="t('worktree.removeTitle', name)" size="md" role="alertdialog" :closable="!busy" @close="close">
    <div class="wrd">
      <p class="wrd-path">{{ path }}</p>

      <p v-if="st.phase === 'checking'" class="wrd-muted">{{ t("worktree.removeChecking") }}</p>

      <template v-else-if="st.phase === 'refused' && st.guard">
        <p class="wrd-warn">{{ t("worktree.removeRefused") }}</p>
        <ul class="wrd-list">
          <li v-for="r in st.guard.reasons" :key="r">
            {{ reasonText(r) }}
            <span v-if="r === 'locked' && st.guard.lock_reason" class="wrd-muted">— {{ st.guard.lock_reason }}</span>
          </li>
        </ul>
      </template>

      <template v-else-if="st.phase === 'confirm' && st.guard">
        <p>{{ t("worktree.removeBody") }}</p>
        <p class="wrd-muted">{{ t("worktree.removeNotKept") }}</p>
        <p v-if="st.guard.teardown_required" class="wrd-muted">{{ t("worktree.removeTeardownWillRun") }}</p>
        <div v-if="!st.guard.owned" class="wrd-warn">
          <p>{{ t("worktree.removeNotOwned") }}</p>
          <label class="wrd-check">
            <input v-model="notOwnedAck" type="checkbox" />
            <span>{{ t("worktree.removeNotOwnedConfirm") }}</span>
          </label>
        </div>
        <label v-if="st.guard.branch" class="wrd-check">
          <input v-model="alsoDeleteBranch" type="checkbox" />
          <span>{{ t("worktree.removeDeleteBranch", st.guard.branch) }}</span>
        </label>
      </template>

      <p v-else-if="st.phase === 'stopping'" class="wrd-muted">{{ t("worktree.removeStopping") }}</p>

      <template v-else-if="st.phase === 'processes'">
        <p class="wrd-warn">{{ t("worktree.processesTitle") }}</p>
        <ul class="wrd-list wrd-mono">
          <li v-for="p in st.survivors" :key="p.pid">{{ p.name }} ({{ p.pid }})</li>
        </ul>
      </template>

      <p v-else-if="st.phase === 'teardown'" class="wrd-muted">{{ t("worktree.teardownRunning") }}</p>

      <template v-else-if="st.phase === 'teardown-failed'">
        <p class="wrd-warn">
          {{ st.teardownCode === null ? t("worktree.teardownStoppedKept") : t("worktree.teardownFailedKept", st.teardownCode) }}
        </p>
        <p v-if="anywayAsked" class="wrd-warn">{{ t("worktree.removeAnywayConfirm") }}</p>
      </template>

      <p v-else-if="st.phase === 'removing'" class="wrd-muted">{{ t("worktree.removing") }}</p>

      <template v-else-if="st.phase === 'done'">
        <p>{{ t("worktree.removeDone") }}</p>
        <p v-if="st.skippedHooks" class="wrd-warn">{{ t("worktree.removeSkippedHooks") }}</p>
        <ul v-if="st.outcome?.warnings.length" class="wrd-list wrd-muted">
          <li v-for="w in st.outcome.warnings" :key="w">{{ w }}</li>
        </ul>
      </template>

      <p v-else-if="st.phase === 'error'" class="wrd-error">{{ t("worktree.errorRemove", st.error ?? "") }}</p>
    </div>

    <template #footer>
      <template v-if="st.phase === 'refused'">
        <button class="bm-btn bm-btn--ghost" @click="close">{{ t("common.close") }}</button>
        <button v-if="st.guard?.reasons.includes('locked')" class="bm-btn bm-btn--primary" @click="run(flow.unlock)">
          {{ t("worktree.unlock") }}
        </button>
      </template>

      <template v-else-if="st.phase === 'confirm'">
        <button class="bm-btn bm-btn--ghost" @click="close">{{ t("common.cancel") }}</button>
        <button class="bm-btn bm-btn--danger" :disabled="!canRemove" @click="remove">{{ t("worktree.remove") }}</button>
      </template>

      <template v-else-if="st.phase === 'processes'">
        <button class="bm-btn bm-btn--ghost" @click="close">{{ t("common.cancel") }}</button>
        <button class="bm-btn bm-btn--danger" @click="run(flow.stopAll)">{{ t("worktree.processesStopAll") }}</button>
        <button class="bm-btn bm-btn--primary" @click="run(flow.retry)">{{ t("worktree.processesRetry") }}</button>
      </template>

      <template v-else-if="st.phase === 'teardown'">
        <button class="bm-btn bm-btn--ghost" :disabled="st.tabId == null" @click="openLog">{{ t("worktree.openLog") }}</button>
      </template>

      <template v-else-if="st.phase === 'teardown-failed'">
        <button class="bm-btn bm-btn--ghost" @click="close">{{ t("common.cancel") }}</button>
        <button class="bm-btn bm-btn--ghost" :disabled="st.tabId == null" @click="openLog">{{ t("worktree.openLog") }}</button>
        <button v-if="!anywayAsked" class="bm-btn bm-btn--danger" @click="anywayAsked = true">{{ t("worktree.removeAnyway") }}</button>
        <button v-else class="bm-btn bm-btn--danger" @click="run(flow.removeAnyway)">{{ t("worktree.removeAnywayConfirmAction") }}</button>
        <button class="bm-btn bm-btn--primary" @click="anywayAsked = false; run(flow.retryTeardown)">{{ t("worktree.retryTeardown") }}</button>
      </template>

      <template v-else-if="st.phase === 'done' || st.phase === 'error'">
        <button class="bm-btn bm-btn--primary" @click="close">{{ t("common.close") }}</button>
      </template>
    </template>
  </BaseModal>
</template>

<style scoped>
.wrd {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  font-size: var(--font-size-sm);
  line-height: 1.5;
}
.wrd p {
  margin: 0;
}
.wrd-path {
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  word-break: break-all;
}
.wrd-muted {
  color: var(--color-text-muted);
}
.wrd-warn {
  color: var(--color-warning, var(--color-text));
}
.wrd-error {
  color: var(--color-danger);
}
.wrd-list {
  margin: 0;
  padding-left: var(--space-4);
}
.wrd-mono {
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
}
.wrd-check {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  cursor: pointer;
}
</style>
