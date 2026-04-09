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
  gap: 6px;
  padding: 8px 10px;
  background: var(--bg-secondary, #1e1e2e);
  border-radius: 6px;
  border: 1px solid var(--border-color, #313244);
}

.monorepo-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.monorepo-title {
  font-size: 12px;
  font-weight: 600;
}

.monorepo-count {
  color: var(--text-muted, #6c7086);
  font-weight: 400;
}

.monorepo-filter {
  background: var(--bg-tertiary, #11111b);
  border: 1px solid var(--border-color, #313244);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
  color: inherit;
  outline: none;
}

.monorepo-filter:focus {
  border-color: var(--color-accent, #cba6f7);
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
  gap: 8px;
  padding: 5px 8px;
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.15s;
  font-size: 12px;
}

.monorepo-item:hover {
  background: var(--bg-hover, rgba(255, 255, 255, 0.05));
}

.monorepo-pkg-name {
  font-weight: 600;
  color: var(--color-accent, #cba6f7);
  white-space: nowrap;
}

.monorepo-pkg-path {
  flex: 1;
  color: var(--text-muted, #6c7086);
  font-family: "JetBrains Mono", "Fira Code", monospace;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.monorepo-pkg-version {
  color: var(--text-muted, #6c7086);
  font-size: 11px;
  flex-shrink: 0;
}
</style>
