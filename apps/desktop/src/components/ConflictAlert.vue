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
  padding: 10px 12px;
  border-radius: 6px;
  border: 1px solid var(--color-warning, #f9e2af);
  background: rgba(249, 226, 175, 0.08);
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.conflict-alert.warn {
  border-color: var(--color-warning, #fab387);
  background: rgba(250, 179, 135, 0.1);
}

.conflict-alert.danger {
  border-color: var(--color-error, #f38ba8);
  background: rgba(243, 139, 168, 0.1);
}

.conflict-alert-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 500;
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
  font-size: 12px;
  font-family: "JetBrains Mono", "Fira Code", monospace;
  color: var(--text-secondary, #a6adc8);
}

.conflict-file::before {
  content: "·";
  margin-right: 6px;
  color: var(--text-muted, #6c7086);
}

.conflict-stats {
  font-size: 11px;
  color: var(--text-muted, #6c7086);
  padding-left: 28px;
}
</style>
