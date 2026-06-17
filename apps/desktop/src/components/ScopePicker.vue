<script setup lang="ts">
/**
 * ScopePicker — monorepo scope selector (v2.21.0).
 *
 * A small dropdown for the repo sidebar header. Lists detected workspace
 * packages (from `detect_monorepo`), plus a "Whole repo" reset entry and a
 * "Custom folder…" entry that opens the native folder picker.
 *
 * Thin component: all state lives in `useWorkspaceScope`; this only renders
 * options and orchestrates the picker. Logic (persistence, validation) stays
 * in the composable.
 */
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { detectMonorepo, pickFolder, type MonorepoInfo } from "../utils/backend";
import { useWorkspaceScope } from "../composables/useWorkspaceScope";
import { useI18n } from "../composables/useI18n";

const props = defineProps<{
  /** Absolute repo path — data source for detection + custom-folder relativization. */
  cwd: string;
}>();

const { t } = useI18n();
const { activeScope, setScope, clearScope } = useWorkspaceScope();

const info = ref<MonorepoInfo | null>(null);
const loading = ref(false);
const open = ref(false);

async function loadMonorepo() {
  if (!props.cwd) {
    info.value = null;
    return;
  }
  loading.value = true;
  try {
    info.value = await detectMonorepo(props.cwd);
  } catch {
    info.value = null;
  } finally {
    loading.value = false;
  }
}

watch(() => props.cwd, loadMonorepo);
onMounted(loadMonorepo);

/** Label shown on the trigger button: the active scope, or "Whole repo". */
const triggerLabel = computed(() =>
  activeScope.value ? activeScope.value : t("scope.wholeRepo"),
);

const isMonorepo = computed(() => !!info.value?.isMonorepo);

const packages = computed(() => info.value?.packages ?? []);

function selectPackage(path: string) {
  void setScope(path);
  open.value = false;
}

function selectWholeRepo() {
  void clearScope();
  open.value = false;
}

/**
 * Open the native/browser folder picker and scope to the chosen folder,
 * relativized against the repo root. A folder outside the repo is ignored.
 */
async function selectCustomFolder() {
  open.value = false;
  const abs = await pickFolder(props.cwd);
  if (!abs) return;
  const rel = toRepoRelative(props.cwd, abs);
  if (rel === null) return; // outside repo — ignore
  if (rel === "") {
    void clearScope(); // picked the repo root → whole repo
  } else {
    void setScope(rel);
  }
}

/**
 * Convert an absolute path to a repo-relative path (forward slashes).
 * Returns "" when `abs` is the repo root, or null when `abs` is outside `cwd`.
 */
function toRepoRelative(cwd: string, abs: string): string | null {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const root = norm(cwd);
  const target = norm(abs);
  if (target === root) return "";
  if (target.startsWith(root + "/")) {
    return target.slice(root.length + 1);
  }
  return null;
}

// ─── Close on outside click ────────────────────────────────
function onDocClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (!target.closest(".scope-picker")) open.value = false;
}
onMounted(() => document.addEventListener("click", onDocClick));
onUnmounted(() => document.removeEventListener("click", onDocClick));
</script>

<template>
  <div v-if="isMonorepo" class="scope-picker-row">
    <div class="scope-picker">
      <button
        class="scope-picker-trigger"
        :class="{ 'scope-picker-trigger--active': activeScope }"
        :title="t('scope.picker')"
        @click.stop="open = !open"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
        <span class="scope-picker-label">{{ triggerLabel }}</span>
        <svg class="scope-picker-caret" width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
          <path d="M1.5 3L4 5.5L6.5 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>

      <ul v-if="open" class="scope-picker-menu" role="listbox">
        <li
          class="scope-picker-item"
          :class="{ 'scope-picker-item--selected': !activeScope }"
          role="option"
          :aria-selected="!activeScope"
          @click="selectWholeRepo"
        >
          {{ t('scope.wholeRepo') }}
        </li>

        <li v-if="packages.length > 0" class="scope-picker-sep" role="separator" aria-hidden="true" />

        <li
          v-for="pkg in packages"
          :key="pkg.path"
          class="scope-picker-item"
          :class="{ 'scope-picker-item--selected': activeScope === pkg.path }"
          role="option"
          :aria-selected="activeScope === pkg.path"
          @click="selectPackage(pkg.path)"
        >
          <span class="scope-picker-pkg-name">{{ pkg.name }}</span>
          <span class="scope-picker-pkg-path">{{ pkg.path }}</span>
        </li>

        <li class="scope-picker-sep" role="separator" aria-hidden="true" />

        <li
          class="scope-picker-item scope-picker-item--custom"
          role="option"
          @click="selectCustomFolder"
        >
          {{ t('scope.custom') }}
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.scope-picker-row {
  display: flex;
  align-items: center;
  padding: var(--space-2);
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.scope-picker {
  position: relative;
  display: block;
  width: 100%;
}

.scope-picker-trigger {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: 3px var(--space-3);
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  color: var(--color-text);
  font-size: var(--font-size-sm);
  font-weight: 500;
  cursor: pointer;
  transition: background var(--transition-hover), color var(--transition-hover);
}

.scope-picker-trigger:hover {
  background: var(--color-bg-elevated);
  color: var(--color-text);
}

.scope-picker-trigger--active {
  border-color: var(--color-accent);
  color: var(--color-accent);
}

.scope-picker-label {
  flex: 1;
  min-width: 0;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.scope-picker-caret {
  flex-shrink: 0;
  opacity: 0.7;
}

.scope-picker-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 200;
  max-height: 320px;
  overflow-y: auto;
  margin: 0;
  padding: var(--space-1);
  list-style: none;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-md);
}

.scope-picker-item {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: var(--font-size-sm);
  transition: background var(--transition-hover);
}

.scope-picker-item:hover {
  background: var(--color-bg-tertiary);
}

.scope-picker-item--selected {
  background: var(--color-accent-soft);
}

.scope-picker-item--custom {
  color: var(--color-text-muted);
}

.scope-picker-pkg-name {
  font-weight: var(--font-weight-semibold);
  color: var(--color-text);
}

.scope-picker-pkg-path {
  color: var(--color-text-muted);
  font-family: "JetBrains Mono", "Fira Code", monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.scope-picker-sep {
  height: 1px;
  margin: var(--space-1) 0;
  background: var(--color-border);
}
</style>
