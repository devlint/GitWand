<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useI18n } from "../composables/useI18n";
import {
  useInteractiveRebase,
  type RebaseTodoEntry,
  type RebaseAction,
} from "../composables/useInteractiveRebase";
import { getGitBranches, type GitBranch } from "../utils/backend";

const props = defineProps<{
  cwd: string;
  currentBranch: string;
  branches: GitBranch[];
}>();

// ─── Local branches (fetched on mount for freshness) ─────────
const localBranches = ref<GitBranch[]>([]);
const branchesLoading = ref(false);

async function fetchBranches() {
  branchesLoading.value = true;
  try {
    localBranches.value = await getGitBranches(props.cwd);
  } catch { /* ignore */ }
  finally { branchesLoading.value = false; }
}

const emit = defineEmits<{
  close: [];
  done: [];
}>();

const { t, locale } = useI18n();
const rebase = useInteractiveRebase();

// ─── Base selection ──────────────────────────────────────────
const baseInput = ref("");
const baseFilter = ref("");
const showBasePicker = ref(true);

const baseCandidates = computed(() => {
  const filter = baseFilter.value.toLowerCase();
  return localBranches.value
    .filter(
      (b) =>
        !b.isCurrent &&
        !b.isRemote &&
        b.name.toLowerCase().includes(filter),
    )
    .map((b) => b.name);
});

async function selectBase(name: string) {
  baseInput.value = name;
  showBasePicker.value = false;
  await rebase.listCommits(props.cwd, name);
}

// ─── Drag & drop ─────────────────────────────────────────────
const dragIndex = ref<number | null>(null);
const dragOverIndex = ref<number | null>(null);

function onDragStart(index: number, e: DragEvent) {
  dragIndex.value = index;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(index));
  }
}

function onDragOver(index: number, e: DragEvent) {
  e.preventDefault();
  dragOverIndex.value = index;
}

function onDragLeave() {
  dragOverIndex.value = null;
}

function onDrop(toIndex: number, e: DragEvent) {
  e.preventDefault();
  if (dragIndex.value !== null && dragIndex.value !== toIndex) {
    rebase.moveEntry(dragIndex.value, toIndex);
  }
  dragIndex.value = null;
  dragOverIndex.value = null;
}

function onDragEnd() {
  dragIndex.value = null;
  dragOverIndex.value = null;
}

// ─── Actions ─────────────────────────────────────────────────
const actions: RebaseAction[] = ["pick", "reword", "squash", "fixup", "edit", "drop"];

const actionDescriptions: Record<RebaseAction, { fr: string; en: string }> = {
  pick:    { fr: "Garder tel quel",               en: "Keep as is" },
  reword:  { fr: "Modifier le message",           en: "Edit message" },
  squash:  { fr: "Fusionner (garder les messages)", en: "Merge (keep messages)" },
  fixup:   { fr: "Fusionner (ignorer le message)", en: "Merge (discard message)" },
  edit:    { fr: "S\u2019arr\u00eater pour modifier", en: "Pause to edit" },
  drop:    { fr: "Supprimer le commit",            en: "Remove commit" },
};

/** Index of the todo item whose action dropdown is open, or null. */
const actionMenuIndex = ref<number | null>(null);

function toggleActionMenu(index: number) {
  actionMenuIndex.value = actionMenuIndex.value === index ? null : index;
}

function pickAction(index: number, action: RebaseAction) {
  rebase.setAction(index, action);
  actionMenuIndex.value = null;
  if (action === "reword") startReword(index);
}

// ─── Reword inline edit ──────────────────────────────────────
const editingIndex = ref<number | null>(null);
const editMessage = ref("");

function startReword(index: number) {
  rebase.setAction(index, "reword");
  editingIndex.value = index;
  editMessage.value = rebase.todoEntries.value[index].newMessage || rebase.todoEntries.value[index].message;
}

function confirmReword() {
  if (editingIndex.value !== null) {
    rebase.setNewMessage(editingIndex.value, editMessage.value);
    editingIndex.value = null;
  }
}

function cancelReword() {
  editingIndex.value = null;
}

// ─── Start / In-progress actions ─────────────────────────────

async function startRebase() {
  const result = await rebase.startRebase(
    props.cwd,
    baseInput.value,
    rebase.todoEntries.value,
  );
  if (result.success && !result.conflict) {
    emit("done");
  }
  // If conflict, the progress state will be detected and UI adapts
}

async function doContinue() {
  const result = await rebase.rebaseContinue(props.cwd);
  if (result.success && !result.conflict) {
    emit("done");
  }
}

async function doAbort() {
  await rebase.rebaseAbort(props.cwd);
  emit("done");
}

async function doSkip() {
  const result = await rebase.rebaseSkip(props.cwd);
  if (result.success && !result.conflict) {
    emit("done");
  }
}

// ─── Init on open ────────────────────────────────────────────
onMounted(async () => {
  await Promise.all([
    fetchBranches(),
    rebase.detectRebaseState(props.cwd),
  ]);
});

// Action badge colors
function actionClass(action: RebaseAction): string {
  const map: Record<RebaseAction, string> = {
    pick: "rb-action--pick",
    reword: "rb-action--reword",
    squash: "rb-action--squash",
    fixup: "rb-action--fixup",
    edit: "rb-action--edit",
    drop: "rb-action--drop",
  };
  return map[action];
}

// Close action menu on outside click
function onPanelClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (!target.closest(".rb-action-dropdown")) {
    actionMenuIndex.value = null;
  }
}

// Keyboard shortcut: Escape to close
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    if (actionMenuIndex.value !== null) {
      actionMenuIndex.value = null;
    } else if (editingIndex.value !== null) {
      cancelReword();
    } else {
      emit("close");
    }
  }
}
onMounted(() => window.addEventListener("keydown", onKeydown));
onUnmounted(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div class="rb-overlay" @click.self="emit('close')">
    <div class="rb-panel" role="dialog" :aria-label="t('rebase.title')" @click="onPanelClick">

      <!-- Header -->
      <div class="rb-header">
        <h2 class="rb-title">{{ t('rebase.title') }}</h2>
        <button class="rb-close" @click="emit('close')" :aria-label="t('common.close')">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
          </svg>
        </button>
      </div>

      <!-- In-progress rebase banner -->
      <div v-if="rebase.progress.value?.inProgress" class="rb-progress-banner">
        <div class="rb-progress-icon">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M8 1v6l4 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            <circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5" fill="none"/>
          </svg>
        </div>
        <div class="rb-progress-text">
          <strong>{{ t('rebase.inProgress') }}</strong>
          <span v-if="rebase.progress.value.headName"> — {{ rebase.progress.value.headName }}</span>
          <span v-if="rebase.progress.value.step"> ({{ rebase.progress.value.step }}/{{ rebase.progress.value.total }})</span>
        </div>
        <div v-if="rebase.progress.value.hasConflict" class="rb-conflict-badge">
          {{ t('rebase.conflict') }}
        </div>
      </div>

      <!-- In-progress actions -->
      <div v-if="rebase.progress.value?.inProgress" class="rb-progress-actions">
        <button class="rb-btn rb-btn--primary" @click="doContinue" :disabled="rebase.isRunning.value">
          {{ t('rebase.continue') }}
        </button>
        <button class="rb-btn rb-btn--secondary" @click="doSkip" :disabled="rebase.isRunning.value">
          {{ t('rebase.skip') }}
        </button>
        <button class="rb-btn rb-btn--danger" @click="doAbort" :disabled="rebase.isRunning.value">
          {{ t('rebase.abort') }}
        </button>
      </div>

      <!-- Base selection -->
      <template v-if="showBasePicker && !rebase.progress.value?.inProgress">
        <div class="rb-section">
          <label class="rb-label">{{ t('rebase.baseLabel') }}</label>
          <p class="rb-hint">{{ t('rebase.baseHint') }}</p>
          <input
            class="rb-base-input mono"
            v-model="baseFilter"
            :placeholder="t('rebase.basePlaceholder')"
            autofocus
          />
          <ul class="rb-base-list" v-if="baseCandidates.length > 0">
            <li
              v-for="name in baseCandidates"
              :key="name"
              class="rb-base-item"
              @click="selectBase(name)"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="5" cy="4" r="2" stroke="currentColor" stroke-width="1.3"/>
                <circle cx="5" cy="12" r="2" stroke="currentColor" stroke-width="1.3"/>
                <path d="M5 6v4" stroke="currentColor" stroke-width="1.3"/>
              </svg>
              <span class="mono">{{ name }}</span>
            </li>
          </ul>
        </div>
      </template>

      <!-- Commit list (todo editor) -->
      <template v-if="rebase.todoEntries.value.length > 0 && !rebase.progress.value?.inProgress">
        <div class="rb-section">
          <div class="rb-section-header">
            <label class="rb-label">
              {{ t('rebase.commitsLabel') }}
              <span class="rb-count">({{ rebase.todoEntries.value.length }})</span>
            </label>
            <button class="rb-back-btn" @click="showBasePicker = true; rebase.reset()">
              {{ t('rebase.changeBase') }}
            </button>
          </div>
          <p class="rb-hint">{{ t('rebase.commitsHint') }}</p>
        </div>

        <div class="rb-todo-list">
          <div
            v-for="(entry, index) in rebase.todoEntries.value"
            :key="entry.fullHash"
            class="rb-todo-item"
            :class="{
              'rb-todo-item--dragging': dragIndex === index,
              'rb-todo-item--drag-over': dragOverIndex === index,
              'rb-todo-item--drop': entry.action === 'drop',
            }"
            draggable="true"
            @dragstart="onDragStart(index, $event)"
            @dragover="onDragOver(index, $event)"
            @dragleave="onDragLeave"
            @drop="onDrop(index, $event)"
            @dragend="onDragEnd"
          >
            <!-- Drag handle -->
            <div class="rb-drag-handle" :title="t('rebase.dragHint')">
              <svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor" opacity="0.4">
                <circle cx="2" cy="2" r="1.2"/><circle cx="6" cy="2" r="1.2"/>
                <circle cx="2" cy="7" r="1.2"/><circle cx="6" cy="7" r="1.2"/>
                <circle cx="2" cy="12" r="1.2"/><circle cx="6" cy="12" r="1.2"/>
              </svg>
            </div>

            <!-- Action badge (click to open dropdown) -->
            <div class="rb-action-dropdown">
              <button
                class="rb-action-badge"
                :class="actionClass(entry.action)"
                @click.stop="toggleActionMenu(index)"
              >
                {{ entry.action }}
                <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
                  <path d="M1.5 3L4 5.5L6.5 3" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
              <ul v-if="actionMenuIndex === index" class="rb-action-menu">
                <li
                  v-for="a in actions"
                  :key="a"
                  class="rb-action-menu-item"
                  :class="[actionClass(a), { 'rb-action-menu-item--active': entry.action === a }]"
                  @click.stop="pickAction(index, a)"
                >
                  <span class="rb-action-menu-dot" :class="actionClass(a)"></span>
                  <span class="rb-action-menu-name">{{ a }}</span>
                  <span class="rb-action-menu-desc">{{ locale.startsWith('fr') ? actionDescriptions[a].fr : actionDescriptions[a].en }}</span>
                </li>
              </ul>
            </div>

            <!-- Commit info -->
            <span class="rb-hash mono">{{ entry.hash }}</span>

            <!-- Message (inline edit when reword) -->
            <template v-if="editingIndex === index">
              <input
                class="rb-reword-input mono"
                v-model="editMessage"
                @keydown.enter="confirmReword"
                @keydown.escape="cancelReword"
                autofocus
              />
              <button class="rb-reword-ok" @click="confirmReword" :title="t('common.confirm')">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2.5 6.5L5 9l4.5-6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
            </template>
            <template v-else>
              <span
                class="rb-message"
                :class="{ 'rb-message--reword': entry.action === 'reword' && entry.newMessage }"
                @dblclick="startReword(index)"
              >
                {{ entry.action === 'reword' && entry.newMessage ? entry.newMessage : entry.message }}
              </span>
            </template>

            <span class="rb-meta muted">{{ entry.author }} · {{ entry.date }}</span>

            <!-- Quick action buttons -->
            <div class="rb-item-actions">
              <button
                v-if="entry.action !== 'reword'"
                class="rb-item-btn"
                @click="startReword(index)"
                :title="t('rebase.reword')"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M7.5 2l2.5 2.5-6 6H1.5V8l6-6z" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
              <button
                class="rb-item-btn rb-item-btn--drop"
                @click="rebase.setAction(index, entry.action === 'drop' ? 'pick' : 'drop')"
                :title="entry.action === 'drop' ? t('rebase.restore') : t('rebase.drop')"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
              </button>
            </div>
          </div>
        </div>

        <!-- Legend -->
        <div class="rb-legend">
          <div v-for="a in actions" :key="a" class="rb-legend-item">
            <span class="rb-legend-dot" :class="actionClass(a)"></span>
            <span class="rb-legend-name">{{ a }}</span>
            <span class="rb-legend-desc">{{ locale.startsWith('fr') ? actionDescriptions[a].fr : actionDescriptions[a].en }}</span>
          </div>
        </div>

        <!-- Action bar -->
        <div class="rb-action-bar">
          <span v-if="rebase.error.value" class="rb-error">{{ rebase.error.value }}</span>
          <div class="rb-action-bar-right">
            <button class="rb-btn rb-btn--secondary" @click="emit('close')">
              {{ t('common.cancel') }}
            </button>
            <button
              class="rb-btn rb-btn--primary"
              @click="startRebase"
              :disabled="rebase.isRunning.value"
            >
              <template v-if="rebase.isRunning.value">{{ t('rebase.running') }}</template>
              <template v-else>{{ t('rebase.start') }}</template>
            </button>
          </div>
        </div>
      </template>

      <!-- Loading -->
      <div v-if="rebase.isLoading.value" class="rb-loading">
        <div class="rb-spinner"></div>
        {{ t('common.loading') }}
      </div>

      <!-- Error -->
      <div v-if="rebase.error.value && !rebase.todoEntries.value.length && !rebase.progress.value?.inProgress" class="rb-error-box">
        {{ rebase.error.value }}
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ─── Overlay ──────────────────────────────────────────────── */
.rb-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}

.rb-panel {
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  width: min(640px, 90vw);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
}

/* ─── Header ───────────────────────────────────────────────── */
.rb-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--color-border);
}

.rb-title {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
}

.rb-close {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--color-text-muted);
  padding: 4px;
  border-radius: var(--radius-sm);
}
.rb-close:hover {
  color: var(--color-text);
  background: var(--color-bg-secondary);
}

/* ─── Sections ─────────────────────────────────────────────── */
.rb-section {
  padding: 12px 20px;
}

.rb-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.rb-label {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--color-text-muted);
}

.rb-count {
  font-weight: 400;
  opacity: 0.7;
}

.rb-hint {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  margin: 4px 0 8px;
}

.rb-back-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: var(--font-size-sm);
  color: var(--color-accent);
  padding: 2px 6px;
  border-radius: var(--radius-sm);
}
.rb-back-btn:hover {
  background: var(--color-bg-secondary);
}

/* ─── Base picker ──────────────────────────────────────────── */
.rb-base-input {
  width: 100%;
  padding: 8px 10px;
  font-size: var(--font-size-sm);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  color: var(--color-text);
  outline: none;
}
.rb-base-input:focus {
  border-color: var(--color-accent);
}

.rb-base-list {
  list-style: none;
  padding: 0;
  margin: 6px 0 0;
  max-height: 200px;
  overflow-y: auto;
}

.rb-base-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  font-size: var(--font-size-sm);
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: background 0.1s;
}
.rb-base-item:hover {
  background: var(--color-bg-secondary);
}

/* ─── Todo list ────────────────────────────────────────────── */
.rb-todo-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 12px;
}

.rb-todo-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  transition: background 0.1s, opacity 0.15s;
  cursor: default;
}
.rb-todo-item:hover {
  background: var(--color-bg-secondary);
}
.rb-todo-item--dragging {
  opacity: 0.4;
}
.rb-todo-item--drag-over {
  border-top: 2px solid var(--color-accent);
}
.rb-todo-item--drop {
  opacity: 0.45;
  text-decoration: line-through;
}

/* ─── Drag handle ──────────────────────────────────────────── */
.rb-drag-handle {
  cursor: grab;
  padding: 2px 4px;
  flex-shrink: 0;
}
.rb-drag-handle:active {
  cursor: grabbing;
}

/* ─── Action badge ─────────────────────────────────────────── */
.rb-action-badge {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  padding: 2px 6px;
  border-radius: 3px;
  border: none;
  cursor: pointer;
  min-width: 48px;
  text-align: center;
  flex-shrink: 0;
  transition: all 0.1s;
}

.rb-action--pick {
  background: var(--color-success-bg, rgba(46, 160, 67, 0.15));
  color: var(--color-success, #2ea043);
}
.rb-action--reword {
  background: rgba(130, 80, 223, 0.15);
  color: #8250df;
}
.rb-action--squash {
  background: rgba(218, 130, 25, 0.15);
  color: #da821a;
}
.rb-action--fixup {
  background: rgba(130, 130, 130, 0.15);
  color: var(--color-text-muted);
}
.rb-action--edit {
  background: rgba(56, 132, 255, 0.15);
  color: #3884ff;
}
.rb-action--drop {
  background: rgba(218, 54, 51, 0.15);
  color: var(--color-danger, #da3633);
}

/* ─── Action dropdown ──────────────────────────────────────── */
.rb-action-dropdown {
  position: relative;
  flex-shrink: 0;
}

.rb-action-badge svg {
  margin-left: 2px;
  opacity: 0.6;
}

.rb-action-menu {
  position: absolute;
  top: 100%;
  left: 0;
  margin-top: 4px;
  min-width: 220px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
  list-style: none;
  padding: 4px 0;
  z-index: 10;
}

.rb-action-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: background 0.1s;
  background: none !important;
  color: var(--color-text) !important;
}
.rb-action-menu-item:hover {
  background: var(--color-bg-secondary) !important;
}
.rb-action-menu-item--active {
  font-weight: 600;
}

.rb-action-menu-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.rb-action-menu-dot.rb-action--pick { background: var(--color-success, #2ea043); }
.rb-action-menu-dot.rb-action--reword { background: #8250df; }
.rb-action-menu-dot.rb-action--squash { background: #da821a; }
.rb-action-menu-dot.rb-action--fixup { background: #828282; }
.rb-action-menu-dot.rb-action--edit { background: #3884ff; }
.rb-action-menu-dot.rb-action--drop { background: var(--color-danger, #da3633); }

.rb-action-menu-name {
  font-weight: 600;
  min-width: 48px;
}

.rb-action-menu-desc {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

/* ─── Commit info ──────────────────────────────────────────── */
.rb-hash {
  font-size: var(--font-size-xs);
  color: var(--color-accent);
  flex-shrink: 0;
}

.rb-message {
  font-size: var(--font-size-sm);
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: text;
}
.rb-message--reword {
  color: #8250df;
  font-style: italic;
}

.rb-meta {
  font-size: var(--font-size-xs);
  flex-shrink: 0;
  white-space: nowrap;
}

/* ─── Reword inline edit ───────────────────────────────────── */
.rb-reword-input {
  flex: 1;
  font-size: var(--font-size-sm);
  padding: 2px 6px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-sm);
  color: var(--color-text);
  outline: none;
}

.rb-reword-ok {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--color-success);
  padding: 2px;
}

/* ─── Item quick actions ───────────────────────────────────── */
.rb-item-actions {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.1s;
  flex-shrink: 0;
}
.rb-todo-item:hover .rb-item-actions {
  opacity: 1;
}

.rb-item-btn {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--color-text-muted);
  padding: 3px;
  border-radius: var(--radius-sm);
}
.rb-item-btn:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}
.rb-item-btn--drop:hover {
  color: var(--color-danger);
}

/* ─── Legend ────────────────────────────────────────────────── */
.rb-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  padding: 8px 20px;
  border-top: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
}

.rb-legend-item {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
}

.rb-legend-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.rb-legend-dot.rb-action--pick { background: var(--color-success, #2ea043); }
.rb-legend-dot.rb-action--reword { background: #8250df; }
.rb-legend-dot.rb-action--squash { background: #da821a; }
.rb-legend-dot.rb-action--fixup { background: #828282; }
.rb-legend-dot.rb-action--edit { background: #3884ff; }
.rb-legend-dot.rb-action--drop { background: var(--color-danger, #da3633); }

.rb-legend-name {
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.rb-legend-desc {
  color: var(--color-text-muted);
}

/* ─── Action bar ───────────────────────────────────────────── */
.rb-action-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  border-top: 1px solid var(--color-border);
  gap: 12px;
}

.rb-action-bar-right {
  display: flex;
  gap: 8px;
  margin-left: auto;
}

.rb-btn {
  padding: 6px 14px;
  font-size: var(--font-size-sm);
  font-weight: 500;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  cursor: pointer;
  transition: all 0.15s;
}
.rb-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.rb-btn--primary {
  background: var(--color-accent);
  color: #fff;
  border-color: var(--color-accent);
}
.rb-btn--primary:hover:not(:disabled) {
  filter: brightness(1.1);
}

.rb-btn--secondary {
  background: var(--color-bg-secondary);
  color: var(--color-text);
}
.rb-btn--secondary:hover:not(:disabled) {
  background: var(--color-bg-tertiary);
}

.rb-btn--danger {
  background: none;
  color: var(--color-danger);
  border-color: var(--color-danger);
}
.rb-btn--danger:hover:not(:disabled) {
  background: rgba(218, 54, 51, 0.1);
}

/* ─── Progress banner ──────────────────────────────────────── */
.rb-progress-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 20px;
  background: rgba(218, 130, 25, 0.1);
  border-bottom: 1px solid var(--color-border);
}

.rb-progress-icon {
  color: #da821a;
}

.rb-progress-text {
  font-size: var(--font-size-sm);
  flex: 1;
}

.rb-conflict-badge {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  padding: 2px 8px;
  border-radius: 3px;
  background: rgba(218, 54, 51, 0.15);
  color: var(--color-danger);
}

.rb-progress-actions {
  display: flex;
  gap: 8px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--color-border);
}

/* ─── Loading / Error ──────────────────────────────────────── */
.rb-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 20px;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}

.rb-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--color-border);
  border-top-color: var(--color-accent);
  border-radius: 50%;
  animation: rb-spin 0.6s linear infinite;
}

@keyframes rb-spin {
  to { transform: rotate(360deg); }
}

.rb-error {
  font-size: var(--font-size-sm);
  color: var(--color-danger);
}

.rb-error-box {
  padding: 16px 20px;
  color: var(--color-danger);
  font-size: var(--font-size-sm);
}
</style>
