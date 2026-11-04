<script setup lang="ts">
/**
 * WorktreeHookTrustModal — v3.13. Shows a repository's worktree commands
 * verbatim and asks whether to run them. Pure presentational: the state and
 * the trust store live in `useWorktreeHookTrust` and the backend.
 */
import { computed } from "vue";
import { useI18n } from "../composables/useI18n";
import BaseModal from "./BaseModal.vue";
import type { HookTrustStatus } from "../utils/backend";

const props = defineProps<{
  status: HookTrustStatus;
  error?: string | null;
}>();

const emit = defineEmits<{
  (e: "answer", choice: "trust" | "skip" | "cancel"): void;
}>();

const { t } = useI18n();

const rows = computed(() =>
  (
    [
      ["setup", t("worktreeHooks.setup")],
      ["teardown", t("worktreeHooks.teardown")],
      ["url", t("worktreeHooks.url")],
    ] as const
  )
    .map(([key, label]) => ({ key, label, command: props.status.hooks[key] }))
    .filter((r): r is { key: typeof r.key; label: string; command: string } => r.command !== null),
);
</script>

<template>
  <BaseModal :title="t('worktreeHooks.title')" size="md" role="alertdialog" @close="emit('answer', 'cancel')">
    <p class="wht-intro">{{ t("worktreeHooks.intro") }}</p>
    <p class="wht-repo">{{ status.repoRoot }}</p>

    <div v-for="row in rows" :key="row.key" class="wht-hook">
      <span class="wht-label">{{ row.label }}</span>
      <pre class="wht-command">{{ row.command }}</pre>
    </div>

    <p class="wht-note">{{ t("worktreeHooks.changedNote") }}</p>
    <p v-if="error" class="wht-error" role="alert">{{ error }}</p>

    <template #footer>
      <button class="bm-btn bm-btn--ghost" @click="emit('answer', 'cancel')">
        {{ t("worktreeHooks.cancel") }}
      </button>
      <button class="bm-btn bm-btn--ghost" @click="emit('answer', 'skip')">
        {{ t("worktreeHooks.skip") }}
      </button>
      <button class="bm-btn bm-btn--primary" @click="emit('answer', 'trust')">
        {{ t("worktreeHooks.trust") }}
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.wht-intro {
  margin: 0 0 var(--space-2);
  font-size: var(--font-size-sm);
  color: var(--color-text);
  line-height: 1.5;
}
.wht-repo {
  margin: 0 0 var(--space-3);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  word-break: break-all;
}
.wht-hook {
  margin-bottom: var(--space-3);
}
.wht-label {
  display: block;
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-muted);
  margin-bottom: 4px;
}
.wht-command {
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 160px;
  overflow: auto;
}
.wht-note {
  margin: var(--space-3) 0 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}
.wht-error {
  margin: var(--space-2) 0 0;
  font-size: var(--font-size-xs);
  color: var(--color-danger);
}
</style>
