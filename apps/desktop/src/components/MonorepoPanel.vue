<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import { detectMonorepo, type MonorepoInfo, type MonorepoPackage } from "../utils/backend";

const props = defineProps<{
  cwd: string;
}>();

const emit = defineEmits<{
  (e: "select-package", pkg: MonorepoPackage): void;
}>();

const info = ref<MonorepoInfo | null>(null);
const loading = ref(false);
const filter = ref("");

const filteredPackages = ref<MonorepoPackage[]>([]);

function applyFilter() {
  if (!info.value) {
    filteredPackages.value = [];
    return;
  }
  const q = filter.value.toLowerCase();
  filteredPackages.value = q
    ? info.value.packages.filter(
        (p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
      )
    : info.value.packages;
}

async function loadMonorepo() {
  if (!props.cwd) return;
  loading.value = true;
  try {
    info.value = await detectMonorepo(props.cwd);
    applyFilter();
  } catch {
    info.value = null;
  } finally {
    loading.value = false;
  }
}

watch(() => props.cwd, loadMonorepo);
watch(filter, applyFilter);
onMounted(loadMonorepo);

function managerIcon(manager: string): string {
  switch (manager) {
    case "pnpm": return "⚡";
    case "yarn": return "🧶";
    case "npm": return "📦";
    default: return "📁";
  }
}
</script>

<template>
  <div v-if="info?.isMonorepo" class="monorepo-panel">
    <div class="monorepo-header">
      <span class="monorepo-title">
        {{ managerIcon(info.manager) }} {{ info.manager }} workspace
        <span class="monorepo-count">({{ info.packages.length }})</span>
      </span>
    </div>

    <input
      v-if="info.packages.length > 5"
      v-model="filter"
      class="monorepo-filter"
      type="text"
      placeholder="Filter packages…"
      spellcheck="false"
    />

    <div class="monorepo-list">
      <div
        v-for="pkg in filteredPackages"
        :key="pkg.path"
        class="monorepo-item"
        @click="$emit('select-package', pkg)"
      >
        <span class="monorepo-pkg-name">{{ pkg.name }}</span>
        <span class="monorepo-pkg-path">{{ pkg.path }}</span>
        <span class="monorepo-pkg-version">v{{ pkg.version }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.monorepo-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-2);
  background: var(--color-bg-secondary);
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
}

.monorepo-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.monorepo-title {
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
}

.monorepo-count {
  color: var(--color-text-muted);
  font-weight: 400;
}

.monorepo-filter {
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  padding: var(--space-1) var(--space-2);
  font-size: var(--font-size-xs);
  color: inherit;
  outline: none;
}

.monorepo-filter:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-soft);
}

.monorepo-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 200px;
  overflow-y: auto;
}

.monorepo-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--transition-base);
  font-size: var(--font-size-xs);
}

.monorepo-item:hover {
  background: var(--color-bg-hover);
}

.monorepo-pkg-name {
  font-weight: var(--font-weight-semibold);
  color: var(--color-accent);
  white-space: nowrap;
}

.monorepo-pkg-path {
  flex: 1;
  color: var(--color-text-muted);
  font-family: "JetBrains Mono", "Fira Code", monospace;
  font-size: var(--font-size-xs);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.monorepo-pkg-version {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  flex-shrink: 0;
}
</style>
