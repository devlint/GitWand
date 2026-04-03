<script setup lang="ts">
import { ref, onMounted, watch, nextTick } from "vue";

interface DirEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
}

interface ListDirResponse {
  current: string;
  parent: string | null;
  home: string;
  dirs: DirEntry[];
}

const emit = defineEmits<{
  (e: "select", path: string): void;
  (e: "cancel"): void;
}>();

const DEV_SERVER = "http://localhost:3001";

const currentPath = ref("");
const parentPath = ref<string | null>(null);
const dirs = ref<DirEntry[]>([]);
const pathInput = ref("");
const loadingDir = ref(false);
const errorMsg = ref<string | null>(null);
const inputEl = ref<HTMLInputElement | null>(null);

async function listDir(dirPath?: string) {
  loadingDir.value = true;
  errorMsg.value = null;
  try {
    const qs = dirPath ? `?path=${encodeURIComponent(dirPath)}` : "";
    const res = await fetch(`${DEV_SERVER}/api/list-dir${qs}`);
    if (!res.ok) throw new Error(`Erreur ${res.status}`);
    const data: ListDirResponse = await res.json();
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
  listDir(path);
}

function goUp() {
  if (parentPath.value) listDir(parentPath.value);
}

function goHome() {
  listDir(); // No path = home dir
}

function onInputEnter() {
  const val = pathInput.value.trim();
  if (val) listDir(val);
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
  listDir();
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
    <div class="folder-picker" role="dialog" aria-label="Sélection de dossier">
      <!-- Header -->
      <div class="fp-header">
        <h2 class="fp-title">Ouvrir un dossier Git</h2>
        <button class="fp-close" @click="$emit('cancel')" aria-label="Fermer">
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
          title="Dossier parent"
          aria-label="Dossier parent"
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
          placeholder="/chemin/vers/repo"
          spellcheck="false"
        />
      </div>

      <!-- Directory listing -->
      <div class="fp-list-container">
        <div v-if="loadingDir" class="fp-loading">Chargement...</div>
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
          <button class="fp-btn fp-btn--cancel" @click="$emit('cancel')">Annuler</button>
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
  background: var(--color-bg-secondary, #1e1e2e);
  border: 1px solid var(--color-border, #333);
  border-radius: 12px;
  width: min(600px, 90vw);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  animation: fpSlideIn 0.2s ease-out;
}

@keyframes fpSlideIn {
  from { opacity: 0; transform: translateY(-10px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

.fp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--color-border, #333);
}

.fp-title {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
  color: var(--color-text, #e0e0e0);
}

.fp-close {
  background: none;
  border: none;
  color: var(--color-text-muted, #888);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
}
.fp-close:hover { color: var(--color-text, #e0e0e0); background: rgba(255,255,255,0.06); }

/* Path bar */
.fp-pathbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--color-border, #333);
}

.fp-nav-btn {
  flex-shrink: 0;
  background: none;
  border: 1px solid transparent;
  color: var(--color-text-muted, #888);
  cursor: pointer;
  padding: 6px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  transition: all 0.15s;
}
.fp-nav-btn:hover:not(:disabled) {
  color: var(--color-text, #e0e0e0);
  background: rgba(255,255,255,0.06);
  border-color: var(--color-border, #444);
}
.fp-nav-btn:disabled { opacity: 0.3; cursor: default; }

.fp-path-input {
  flex: 1;
  background: var(--color-bg, #0f0f14);
  border: 1px solid var(--color-border, #333);
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 13px;
  font-family: "SF Mono", "Fira Code", monospace;
  color: var(--color-text, #e0e0e0);
  outline: none;
  transition: border-color 0.15s;
}
.fp-path-input:focus {
  border-color: var(--color-accent, #6366f1);
}

/* Directory listing */
.fp-list-container {
  flex: 1;
  overflow-y: auto;
  min-height: 200px;
  max-height: 400px;
}

.fp-loading, .fp-error, .fp-empty {
  padding: 40px 20px;
  text-align: center;
  font-size: 13px;
  color: var(--color-text-muted, #888);
}
.fp-error { color: var(--color-danger, #ef4444); }

.fp-list {
  list-style: none;
  margin: 0;
  padding: 4px;
}

.fp-entry {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  color: var(--color-text, #e0e0e0);
  transition: background 0.12s;
  user-select: none;
}
.fp-entry:hover {
  background: rgba(255, 255, 255, 0.05);
}
.fp-entry:focus-visible {
  outline: 2px solid var(--color-accent, #6366f1);
  outline-offset: -2px;
}

.fp-entry--git {
  background: rgba(99, 102, 241, 0.06);
}
.fp-entry--git:hover {
  background: rgba(99, 102, 241, 0.12);
}

.fp-entry-icon {
  flex-shrink: 0;
  display: flex;
  align-items: center;
}
.icon-folder { color: var(--color-text-muted, #888); }
.icon-git { color: #f97316; }

.fp-entry-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fp-entry-badge {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(249, 115, 22, 0.15);
  color: #f97316;
}

/* Footer */
.fp-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-top: 1px solid var(--color-border, #333);
}

.fp-current-path {
  font-size: 11px;
  font-family: "SF Mono", "Fira Code", monospace;
  color: var(--color-text-muted, #888);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.fp-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.fp-btn {
  padding: 7px 16px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid transparent;
  transition: all 0.15s;
}

.fp-btn--cancel {
  background: none;
  color: var(--color-text-muted, #888);
  border-color: var(--color-border, #444);
}
.fp-btn--cancel:hover {
  color: var(--color-text, #e0e0e0);
  background: rgba(255,255,255,0.04);
}

.fp-btn--select {
  background: var(--color-accent, #6366f1);
  color: white;
  border-color: var(--color-accent, #6366f1);
}
.fp-btn--select:hover {
  background: #5855eb;
  border-color: #5855eb;
}
</style>
