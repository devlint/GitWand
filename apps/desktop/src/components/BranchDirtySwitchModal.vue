<script setup lang="ts">
import BaseModal from "./BaseModal.vue";
import { useI18n } from "../composables/useI18n";
import type { DirtyFile, DirtyFileKind } from "../utils/branchSwitchDecision";

defineProps<{
  targetBranch: string;
  isCreate: boolean;
  files: DirtyFile[];
}>();

const emit = defineEmits<{
  (e: "carry"): void;
  (e: "commit-first"): void;
  (e: "close"): void;
}>();

const { t } = useI18n();

// Distinct, git-conventional glyphs per area so the badge is self-describing
// without relying on colour alone (staged / modified-unstaged / untracked).
const KIND_BADGE: Record<DirtyFileKind, string> = {
  staged: "S",
  unstaged: "M",
  untracked: "?",
};
</script>

<template>
  <BaseModal
    :title="t('branches.dirtySwitchTitle')"
    size="sm"
    role="alertdialog"
    @close="emit('close')"
  >
    <p class="dsm-hint">
      {{ isCreate
        ? t('branches.dirtySwitchCreateHint', targetBranch)
        : t('branches.dirtySwitchSwitchHint', targetBranch) }}
    </p>

    <div v-if="files.length" class="dsm-files">
      <div class="dsm-files__label">{{ t('branches.dirtySwitchFilesLabel') }} ({{ files.length }})</div>
      <ul class="dsm-files__list">
        <li v-for="f in files" :key="f.kind + ':' + f.path" class="dsm-files__item">
          <span class="dsm-files__badge" :class="`dsm-files__badge--${f.kind}`">{{ KIND_BADGE[f.kind] }}</span>
          <span class="dsm-files__path">{{ f.path }}</span>
        </li>
      </ul>
    </div>

    <template #footer>
      <button type="button" class="bm-btn bm-btn--ghost" @click="emit('close')">
        {{ t('branches.dirtySwitchCancel') }}
      </button>
      <button type="button" class="bm-btn" @click="emit('commit-first')">
        {{ t('branches.dirtySwitchCommitFirst') }}
      </button>
      <button type="button" class="bm-btn bm-btn--primary" @click="emit('carry')">
        {{ t('branches.dirtySwitchCarry') }}
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.dsm-hint {
  margin: 0 0 var(--space-3);
  color: var(--text-secondary);
  line-height: 1.5;
}
.dsm-files__label {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: var(--space-2);
}
.dsm-files__list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 200px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.dsm-files__item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-family: var(--font-mono, monospace);
  font-size: 0.8rem;
}
.dsm-files__badge {
  flex: none;
  width: 1.1rem;
  height: 1.1rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
  font-size: 0.65rem;
  font-weight: 700;
  color: #fff;
}
.dsm-files__badge--staged { background: var(--accent, #2ea043); }
.dsm-files__badge--unstaged { background: var(--warning, #d29922); }
.dsm-files__badge--untracked { background: var(--text-muted, #6e7681); }
.dsm-files__path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
