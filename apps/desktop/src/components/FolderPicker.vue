<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from "vue";
import { listDir as backendListDir, type DirEntry } from "../utils/backend";
import { useFolderHistory } from "../composables/useFolderHistory";
import { useI18n } from "../composables/useI18n";

const { history, togglePin, removeFromHistory } = useFolderHistory();
const { t } = useI18n();

const emit = defineEmits<{
  (e: "select", path: string): void;
  (e: "cancel"): void;
}>();

const currentPath = ref("");
const parentPath = ref<string | null>(null);
const dirs = ref<DirEntry[]>([]);
const pathInput = ref("");
const loadingDir = ref(false);
const errorMsg = ref<string | null>(null);
const inputEl = ref<HTMLInputElement | null>(null);

async function fetchDir(dirPath?: string) {
  loadingDir.value = true;
  errorMsg.value = null;
  try {
    const data = await backendListDir(dirPath);
    currentPath.value = data.current;
    parentPath.value = data.parent;
    pathInput.value = data.current;
    dirs.value = data.dirs;
  } catch (err: any) {
    errorMsg.value = err.message;
  } finally {
    loadingDir.value = false;
  }
}

function navigateTo(path: string) {
  fetchDir(path);
}

function goUp() {
  if (parentPath.value) fetchDir(parentPath.value);
}

function goHome() {
  fetchDir(); // No path = home dir
}

function onInputEnter() {
  const val = pathInput.value.trim();
  if (val) fetchDir(val);
}

function selectCurrent() {
  emit("select", currentPath.value);
}

function selectEntry(entry: DirEntry) {
  // Double-click selects a git repo, single click navigates
  navigateTo(entry.path);
}

function confirmEntry(entry: DirEntry) {
  emit("select", entry.path);
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape") emit("cancel");
}

onMounted(() => {
  fetchDir();
  window.addEventListener("keydown", onKeyDown);
  nextTick(() => inputEl.value?.focus());
});

// Cleanup
import { onUnmounted } from "vue";
onUnmounted(() => {
  window.removeEventListener("keydown", onKeyDown);
});
</script>

<template>
  <div class="folder-picker-overlay" @click.self="$emit('cancel')">
    <div class="folder-picker" role="dialog" :aria-label="t('folderPicker.title')">
      <!-- Header -->
      <div class="fp-header">
        <h2 class="fp-title">{{ t('folderPicker.title') }}</h2>
        <button class="fp-close" @click="$emit('cancel')" :aria-label="t('common.close')">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
          </svg>
        </button>
      </div>

      <!-- Path bar -->
      <div class="fp-pathbar">
        <button
          class="fp-nav-btn"
          :disabled="!parentPath"
          @click="goUp"
          :title="t('folderPicker.parentDir')"
          :aria-label="t('folderPicker.parentDir')"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 4l-5 5h3v4h4V9h3L8 4z"/>
          </svg>
        </button>
        <button
          class="fp-nav-btn"
          @click="goHome"
          title="Dossier personnel"
          aria-label="Dossier personnel"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 2L1 8h2v5h4V10h2v3h4V8h2L8 2z"/>
          </svg>
        </button>
        <input
          ref="inputEl"
          class="fp-path-input"
          v-model="pathInput"
          @keydown.enter="onInputEnter"
          :placeholder="t('folderPicker.pathPlaceholder')"
          spellcheck="false"
        />
      </div>

      <!-- Recent folders / Favorites -->
      <div v-if="history.length > 0" class="fp-history">
        <div class="fp-history-header">
          <span class="fp-history-title">{{ t('folderPicker.recentTitle') }}</span>
        </div>
        <ul class="fp-history-list">
          <li
            v-for="entry in history"
            :key="entry.path"
            class="fp-history-entry"
            :class="{ 'fp-history-entry--pinned': entry.pinned }"
          >
            <button
              class="fp-history-pin"
              :class="{ 'fp-history-pin--active': entry.pinned }"
              @click.stop="togglePin(entry.path)"
              :title="entry.pinned ? t('folderPicker.unpin') : t('folderPicker.pin')"
              :aria-label="entry.pinned ? t('folderPicker.unpin') : t('folderPicker.pin')"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path
                  d="M6 1l1.5 3 3.5.5-2.5 2.5.5 3.5L6 9l-3 1.5.5-3.5L1 4.5 4.5 4 6 1z"
                  :fill="entry.pinned ? 'currentColor' : 'none'"
                  stroke="currentColor"
                  stroke-width="1"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
            <button
              class="fp-history-select"
              @click="$emit('select', entry.path)"
              :title="entry.path"
            >
              <span class="fp-history-name">{{ entry.name }}</span>
              <span class="fp-history-path">{{ entry.path }}</span>
            </button>
            <button
              class="fp-history-remove"
              @click.stop="removeFromHistory(entry.path)"
              :title="t('folderPicker.remove')"
              :aria-label="t('common.delete')"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                <path d="M2.146 2.146a.5.5 0 01.708 0L5 4.293l2.146-2.147a.5.5 0 01.708.708L5.707 5l2.147 2.146a.5.5 0 01-.708.708L5 5.707 2.854 7.854a.5.5 0 01-.708-.708L4.293 5 2.146 2.854a.5.5 0 010-.708z"/>
              </svg>
            </button>
          </li>
        </ul>
      </div>

      <!-- Directory listing -->
      <div class="fp-list-container">
        <div v-if="loadingDir" class="fp-loading">{{ t('common.loading') }}</div>
        <div v-else-if="errorMsg" class="fp-error">{{ errorMsg }}</div>
        <div v-else-if="dirs.length === 0" class="fp-empty">Aucun sous-dossier</div>
        <ul v-else class="fp-list" role="listbox">
          <li
            v-for="entry in dirs"
            :key="entry.path"
            class="fp-entry"
            :class="{ 'fp-entry--git': entry.isGitRepo }"
            role="option"
            tabindex="0"
            @click="selectEntry(entry)"
            @dblclick="confirmEntry(entry)"
            @keydown.enter="confirmEntry(entry)"
            @keydown.space.prevent="selectEntry(entry)"
          >
            <span class="fp-entry-icon">
              <!-- Git repo icon -->
              <svg v-if="entry.isGitRepo" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" class="icon-git">
                <path d="M15.698 7.287L8.712.302a1.03 1.03 0 00-1.457 0l-1.45 1.45 1.84 1.84a1.223 1.223 0 011.55 1.56l1.773 1.774a1.224 1.224 0 11-.733.682L8.533 5.907v4.18a1.224 1.224 0 11-1.007-.02V5.836a1.224 1.224 0 01-.664-1.606L5.046 2.415.302 7.16a1.03 1.03 0 000 1.457l6.986 6.986a1.03 1.03 0 001.457 0l6.953-6.953a1.03 1.03 0 000-1.457"/>
              </svg>
              <!-- Regular folder icon -->
              <svg v-else width="16" height="16" viewBox="0 0 16 16" fill="currentColor" class="icon-folder">
                <path d="M1 3.5A1.5 1.5 0 012.5 2h2.764c.58 0 1.13.237 1.53.659l.74.815A1.5 1.5 0 008.58 4H13.5A1.5 1.5 0 0115 5.5v7a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z"/>
              </svg>
            </span>
            <span class="fp-entry-name">{{ entry.name }}</span>
            <span v-if="entry.isGitRepo" class="fp-entry-badge">git</span>
          </li>
        </ul>
      </div>

      <!-- Footer -->
      <div class="fp-footer">
        <span class="fp-current-path" :title="currentPath">{{ currentPath }}</span>
        <div class="fp-actions">
          <button class="fp-btn fp-btn--cancel" @click="$emit('cancel')">{{ t('common.cancel') }}</button>
          <button class="fp-btn fp-btn--select" @click="selectCurrent">
            Sélectionner ce dossier
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.folder-picker-overlay {
  position: fixed;
  inset: 0;
  background: var(--color-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  backdrop-filter: blur(4px);
}

.folder-picker {
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-2xl);
  width: min(600px, 90vw);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-xl);
  animation: fpSlideIn var(--transition-slow);
  overflow: hidden;
}

@keyframes fpSlideIn {
  from { opacity: 0; transform: translateY(-10px) scale(0.98); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}

.fp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-6) var(--space-7) var(--space-5);
  border-bottom: 1px solid var(--color-border);
}

.fp-title {
  font-size: var(--font-size-xl);
  font-weight: var(--font-weight-semibold);
  letter-spacing: -0.01em;
  margin: 0;
  color: var(--color-text);
}

.fp-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--color-text-muted);
  transition: background var(--transition-fast), color var(--transition-fast);
}
.fp-close:hover { color: var(--color-text); background: var(--color-bg-tertiary); }

/* Path bar */
.fp-pathbar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--color-border);
}

.fp-nav-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--color-text-muted);
  transition: background var(--transition-fast), color var(--transition-fast);
}
.fp-nav-btn:hover:not(:disabled) {
  color: var(--color-text);
  background: var(--color-bg-tertiary);
}
.fp-nav-btn:disabled { opacity: 0.3; cursor: default; }

.fp-path-input {
  flex: 1;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  padding: var(--space-3) var(--space-5);
  font-size: var(--font-size-md);
  font-family: var(--font-mono);
  color: var(--color-text);
  outline: none;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}
.fp-path-input:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-soft);
}

/* ─── History / Favorites ─────────────────────────────── */

.fp-history {
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg);
}

.fp-history-header { padding: var(--space-4) var(--space-6) var(--space-2); }

.fp-history-title {
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
}

.fp-history-list {
  list-style: none;
  margin: 0;
  padding: 0 var(--space-3) var(--space-3);
}

.fp-history-entry {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  border-radius: var(--radius-md);
  transition: background var(--transition-fast);
}

.fp-history-entry:hover { background: var(--color-bg-tertiary); }
.fp-history-entry--pinned { background: var(--color-warning-soft); }

.fp-history-pin {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-pill);
  color: var(--color-text-muted);
  opacity: 0.4;
  transition: opacity var(--transition-fast), color var(--transition-fast);
}

.fp-history-pin:hover,
.fp-history-pin--active { opacity: 1; }
.fp-history-pin--active { color: var(--color-warning); }

.fp-history-select {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: var(--space-3) var(--space-2);
  text-align: left;
  color: var(--color-text);
}

.fp-history-name {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fp-history-path {
  font-size: var(--font-size-sm);
  font-family: var(--font-mono);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fp-history-remove {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--radius-pill);
  color: var(--color-text-muted);
  opacity: 0;
  transition: opacity var(--transition-fast), color var(--transition-fast), background var(--transition-fast);
}

.fp-history-entry:hover .fp-history-remove { opacity: 0.5; }

.fp-history-remove:hover {
  opacity: 1 !important;
  color: var(--color-danger);
  background: var(--color-danger-soft);
}

/* Directory listing */
.fp-list-container {
  flex: 1;
  overflow-y: auto;
  min-height: 200px;
  max-height: 400px;
}

.fp-loading, .fp-error, .fp-empty {
  padding: var(--space-10) var(--space-7);
  text-align: center;
  font-size: var(--font-size-md);
  color: var(--color-text-muted);
}
.fp-error { color: var(--color-danger); }

.fp-list {
  list-style: none;
  margin: 0;
  padding: var(--space-2);
}

.fp-entry {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-5);
  border-radius: var(--radius-md);
  cursor: pointer;
  font-size: var(--font-size-md);
  color: var(--color-text);
  transition: background var(--transition-fast);
  user-select: none;
}
.fp-entry:hover { background: var(--color-bg-tertiary); }
.fp-entry:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: -2px;
}

.fp-entry--git {
  background: var(--color-accent-soft);
}
.fp-entry--git:hover {
  background: var(--color-accent-soft);
  filter: brightness(1.1);
}

.fp-entry-icon {
  flex-shrink: 0;
  display: flex;
  align-items: center;
}
.icon-folder { color: var(--color-text-muted); }
.icon-git    { color: var(--color-accent); }

.fp-entry-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fp-entry-badge {
  flex-shrink: 0;
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-pill);
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

/* Footer */
.fp-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-5);
  padding: var(--space-5) var(--space-6);
  border-top: 1px solid var(--color-border);
  background: var(--color-bg);
}

.fp-current-path {
  font-size: var(--font-size-sm);
  font-family: var(--font-mono);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.fp-actions {
  display: flex;
  gap: var(--space-3);
  flex-shrink: 0;
}

.fp-btn {
  padding: var(--space-3) var(--space-6);
  border-radius: var(--radius-pill);
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  border: 1px solid transparent;
  transition: background var(--transition-base), color var(--transition-base), border-color var(--transition-base);
}

.fp-btn--cancel {
  background: transparent;
  color: var(--color-text-muted);
  border-color: var(--color-border);
}
.fp-btn--cancel:hover {
  color: var(--color-text);
  background: var(--color-bg-tertiary);
}

.fp-btn--select {
  background: var(--color-accent);
  color: var(--color-accent-text);
  border-color: var(--color-accent);
}
.fp-btn--select:hover {
  background: var(--color-accent-hover);
  border-color: var(--color-accent-hover);
}
</style>
