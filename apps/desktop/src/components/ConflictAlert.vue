<script setup lang="ts">
import { ref, watch } from "vue";
import { gitConflictCheck, type ConflictRisk } from "../utils/backend";

const props = defineProps<{
  cwd: string;
  targetBranch: string | null;
}>();

const risk = ref<ConflictRisk | null>(null);
const loading = ref(false);

async function checkConflicts() {
  if (!props.cwd || !props.targetBranch) {
    risk.value = null;
    return;
  }
  loading.value = true;
  try {
    risk.value = await gitConflictCheck(props.cwd, props.targetBranch);
  } catch {
    risk.value = null;
  } finally {
    loading.value = false;
  }
}

watch(() => props.targetBranch, checkConflicts, { immediate: true });
</script>

<template>
  <div
    v-if="risk && risk.overlappingFiles.length > 0"
    class="conflict-alert"
    :class="{ warn: risk.overlappingFiles.length > 3, danger: risk.overlappingFiles.length > 8 }"
  >
    <div class="conflict-alert-header">
      <span class="conflict-icon">⚠️</span>
      <span>
        <strong>{{ risk.overlappingFiles.length }}</strong> fichier{{ risk.overlappingFiles.length > 1 ? 's' : '' }}
        modifié{{ risk.overlappingFiles.length > 1 ? 's' : '' }} sur les deux branches
      </span>
    </div>
    <ul class="conflict-files">
      <li v-for="file in risk.overlappingFiles" :key="file" class="conflict-file">
        {{ file }}
      </li>
    </ul>
    <div class="conflict-stats">
      Branche courante : {{ risk.currentChanged }} fichier{{ risk.currentChanged > 1 ? 's' : '' }} modifié{{ risk.currentChanged > 1 ? 's' : '' }}
      · {{ risk.branch }} : {{ risk.targetChanged }} fichier{{ risk.targetChanged > 1 ? 's' : '' }} modifié{{ risk.targetChanged > 1 ? 's' : '' }}
    </div>
  </div>
</template>

<style scoped>
.conflict-alert {
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-danger);
  background: var(--color-danger-soft);
  font-size: var(--font-size-md);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.conflict-alert.warn {
  border-color: var(--color-warning);
  background: var(--color-warning-soft);
}

.conflict-alert.danger {
  border-color: var(--color-danger);
  background: var(--color-danger-soft);
}

.conflict-alert-header {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  font-weight: var(--font-weight-medium);
}

.conflict-icon {
  font-size: 16px;
}

.conflict-files {
  margin: 0;
  padding-left: 28px;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.conflict-file {
  font-size: var(--font-size-xs);
  font-family: "JetBrains Mono", "Fira Code", monospace;
  color: var(--color-text-secondary);
}

.conflict-file::before {
  content: "·";
  margin-right: var(--space-1);
  color: var(--color-text-muted);
}

.conflict-stats {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  padding-left: 28px;
}
</style>
