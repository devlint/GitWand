<script setup lang="ts">
import { ref, onMounted } from "vue";
import {
  gitSubmoduleList,
  gitSubmoduleUpdate,
  gitSubmoduleUpdateOne,
  gitSubmoduleAdd,
  type SubmoduleEntry,
} from "../utils/backend";
import { useI18n } from "../composables/useI18n";
import BaseModal from "./BaseModal.vue";

const props = defineProps<{
  cwd: string;
  /** path → number of new commits on the tracked branch. Owned by the parent. */
  updates: Record<string, number>;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "open-tab", path: string): void;
  /** Ask the parent to re-run the (network-bound) submodule update check. */
  (e: "refresh-updates"): void;
}>();

const { t } = useI18n();

const submodules = ref<SubmoduleEntry[]>([]);
const loading = ref(false);
const updating = ref(false);
const error = ref<string | null>(null);
/** path of the submodule currently being updated on its own, if any. */
const updatingPath = ref<string | null>(null);

// Add form
const showForm = ref(false);
const formUrl = ref("");
const formPath = ref("");
const adding = ref(false);

async function loadSubmodules() {
  loading.value = true;
  error.value = null;
  try {
    submodules.value = await gitSubmoduleList(props.cwd);
  } catch (err: any) {
    error.value = t("submodule.errorList").replace("{0}", String(err?.message ?? err));
  } finally {
    loading.value = false;
  }
}

async function initUpdateAll() {
  updating.value = true;
  error.value = null;
  try {
    await gitSubmoduleUpdate(props.cwd, true, true);
    await loadSubmodules();
    emit("refresh-updates");
  } catch (err: any) {
    error.value = t("submodule.errorUpdate").replace("{0}", String(err?.message ?? err));
  } finally {
    updating.value = false;
  }
}

async function updateOne(sub: SubmoduleEntry) {
  updatingPath.value = sub.path;
  error.value = null;
  try {
    await gitSubmoduleUpdateOne(props.cwd, sub.path);
    await loadSubmodules();
    emit("refresh-updates");
  } catch (err: any) {
    error.value = t("submodule.errorUpdate").replace("{0}", String(err?.message ?? err));
  } finally {
    updatingPath.value = null;
  }
}

async function addSubmodule() {
  if (!formUrl.value.trim() || !formPath.value.trim()) return;
  adding.value = true;
  error.value = null;
  try {
    await gitSubmoduleAdd(props.cwd, formUrl.value.trim(), formPath.value.trim());
    formUrl.value = "";
    formPath.value = "";
    showForm.value = false;
    await loadSubmodules();
  } catch (err: any) {
    error.value = t("submodule.errorAdd").replace("{0}", String(err?.message ?? err));
  } finally {
    adding.value = false;
  }
}

function openInTab(sub: SubmoduleEntry) {
  const fullPath = props.cwd.replace(/\\/g, "/").replace(/\/$/, "") + "/" + sub.path;
  emit("open-tab", fullPath);
}

function statusLabel(status: SubmoduleEntry["status"]): string {
  if (status === "modified") return t("submodule.statusModified");
  if (status === "uninitialized") return t("submodule.statusUninitialized");
  return t("submodule.statusClean");
}

const uninitCount = () => submodules.value.filter(s => s.status === "uninitialized").length;

onMounted(() => {
  void loadSubmodules();
  // Refresh the update check on open so badges reflect the current remote state.
  emit("refresh-updates");
});
</script>

<template>
  <BaseModal
    :title="t('submodule.title')"
    size="lg"
    scroll-own
    body-flush
    @close="emit('close')"
  >
    <!-- Title icon -->
    <template #title-icon>
      <div class="sm-modal-icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M10 3H3v7h7V3z" />
          <path d="M21 3h-7v7h7V3z" />
          <path d="M21 14h-7v7h7v-7z" />
          <path d="M10 14H3v7h7v-7z" />
        </svg>
      </div>
    </template>

    <!-- Header action buttons -->
    <template #header-actions>
      <button
        type="button"
        class="bm-btn bm-btn--ghost"
        :title="t('submodule.initUpdateTooltip')"
        :disabled="updating"
        @click="initUpdateAll"
      >
        {{ updating ? t("submodule.updating") : t("submodule.initUpdateAll") }}
      </button>
      <button
        type="button"
        class="bm-btn bm-btn--primary"
        @click="showForm = !showForm"
      >
        + {{ t("submodule.addSubmodule") }}
      </button>
    </template>

    <!-- Body -->
    <div class="sm-body">
      <!-- Uninitialized warning -->
      <div
        v-if="!loading && uninitCount() > 0"
        class="sm-warning"
        @click="initUpdateAll"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M8 1L1 14h14L8 1z" />
          <path d="M8 6v4M8 11.5v.5" />
        </svg>
        {{ t("submodule.warningUninitialized").replace("{0}", String(uninitCount())) }}
      </div>

      <!-- Add form -->
      <div v-if="showForm" class="sm-form">
        <div class="sm-form-row">
          <label class="sm-label" for="sub-form-url">{{ t("submodule.formUrl") }}</label>
          <input
            id="sub-form-url"
            v-model="formUrl"
            class="sm-input"
            :placeholder="t('submodule.formUrlPlaceholder')"
          />
        </div>
        <div class="sm-form-row">
          <label class="sm-label" for="sub-form-path">{{ t("submodule.formPath") }}</label>
          <input
            id="sub-form-path"
            v-model="formPath"
            class="sm-input"
            :placeholder="t('submodule.formPathPlaceholder')"
            @keydown.enter="addSubmodule"
          />
        </div>
        <div class="sm-form-actions">
          <button
            class="bm-btn bm-btn--primary"
            :disabled="adding || !formUrl.trim() || !formPath.trim()"
            @click="addSubmodule"
          >
            {{ adding ? t("submodule.adding") : t("submodule.add") }}
          </button>
          <button class="bm-btn bm-btn--ghost" @click="showForm = false">
            {{ t("common.cancel") }}
          </button>
        </div>
      </div>

      <!-- Error -->
      <div v-if="error" class="sm-error">{{ error }}</div>

      <!-- Loading -->
      <div v-if="loading" class="sm-state">{{ t("common.loading") }}</div>

      <!-- Empty -->
      <div v-else-if="!loading && submodules.length === 0" class="sm-state">
        {{ t("submodule.empty") }}
      </div>

      <!-- List -->
      <div v-else class="sm-list">
        <div v-for="sub in submodules" :key="sub.path" class="sm-item">
          <div class="sm-item-info">
            <div class="sm-item-top">
              <span class="sm-item-path">{{ sub.path }}</span>
              <span
                v-if="!(sub.status === 'clean' && updates[sub.path])"
                class="sm-status-badge"
                :class="`status-${sub.status}`"
              >{{ statusLabel(sub.status) }}</span>
              <span
                v-if="updates[sub.path]"
                class="sm-status-badge status-outdated"
                :title="t('submodule.updateAvailableTooltip').replace('{0}', String(updates[sub.path]))"
              >{{ t("submodule.updateAvailable") }}</span>
            </div>
            <div class="sm-item-url" :title="sub.url">{{ sub.url }}</div>
            <div class="sm-item-meta">
              <span v-if="sub.sha" class="sm-sha">{{ sub.sha.slice(0, 7) }}</span>
              <span v-if="sub.branch" class="sm-branch">
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
                  <circle cx="5" cy="3" r="1.5" /><circle cx="5" cy="13" r="1.5" /><circle cx="11" cy="6" r="1.5" />
                  <path d="M5 4.5v7M5 4.5C5 7 11 7.5 11 6" />
                </svg>
                {{ sub.branch }}
              </span>
            </div>
          </div>
          <div class="sm-item-actions">
            <button
              v-if="updates[sub.path]"
              class="bm-btn bm-btn--primary"
              :disabled="updatingPath === sub.path"
              :title="t('submodule.updateOneTooltip')"
              @click="updateOne(sub)"
            >
              {{ updatingPath === sub.path ? t("submodule.updating") : t("submodule.update") }}
            </button>
            <button
              class="bm-btn bm-btn--ghost"
              :disabled="sub.status === 'uninitialized'"
              @click="openInTab(sub)"
            >
              {{ t("submodule.openInTab") }}
            </button>
            <button
              v-if="sub.status === 'uninitialized'"
              class="bm-btn bm-btn--primary"
              :disabled="updating"
              @click="initUpdateAll"
            >
              {{ t("submodule.initUpdate") }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </BaseModal>
</template>

<style scoped>
/* ── Modal icon ─────────────────────────────────────────── */
.sm-modal-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-md);
  background: var(--color-accent-soft);
  color: var(--color-accent);
  flex-shrink: 0;
}

/* ── Body container ─────────────────────────────────────── */
.sm-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* ── Warning banner ─────────────────────────────────────── */
.sm-warning {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-7);
  font-size: var(--font-size-sm);
  background: var(--color-warning-soft, rgba(234, 179, 8, 0.12));
  color: var(--color-warning, #ca8a04);
  border-bottom: 1px solid var(--color-warning-border, rgba(234, 179, 8, 0.3));
  cursor: pointer;
  transition: background var(--transition-fast);
  flex-shrink: 0;
}

.sm-warning:hover {
  background: var(--color-warning-soft-hover, rgba(234, 179, 8, 0.2));
}

/* ── Form ───────────────────────────────────────────────── */
.sm-form {
  padding: var(--space-5) var(--space-7);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-tertiary);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  flex-shrink: 0;
}

.sm-form-row {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.sm-label {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-muted);
}

.sm-input {
  height: 34px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  color: var(--color-text);
  font-size: var(--font-size-md);
  padding: 0 var(--space-4);
  outline: none;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}

.sm-input:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-soft);
}

.sm-form-actions {
  display: flex;
  gap: var(--space-3);
}

/* ── Error ──────────────────────────────────────────────── */
.sm-error {
  margin: var(--space-4) var(--space-7) 0;
  padding: var(--space-3) var(--space-4);
  color: var(--color-danger);
  font-size: var(--font-size-sm);
  background: var(--color-danger-soft);
  border: 1px solid var(--color-danger);
  border-radius: var(--radius-sm);
  flex-shrink: 0;
}

/* ── States ─────────────────────────────────────────────── */
.sm-state {
  padding: var(--space-10) var(--space-7);
  font-size: var(--font-size-md);
  color: var(--color-text-muted);
  text-align: center;
}

/* ── List ───────────────────────────────────────────────── */
.sm-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-5) var(--space-7) var(--space-6);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.sm-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-5);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg);
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}

.sm-item:hover {
  border-color: var(--color-accent);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
}

.sm-item-info {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.sm-item-top {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.sm-item-path {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text);
  font-family: var(--font-mono);
}

.sm-status-badge {
  font-size: 10px;
  font-weight: var(--font-weight-semibold);
  padding: 2px var(--space-3);
  border-radius: var(--radius-pill);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  flex-shrink: 0;
}

.status-clean        { background: var(--color-success-soft, rgba(34,197,94,0.12)); color: var(--color-success, #16a34a); }
.status-modified     { background: var(--color-warning-soft, rgba(234,179,8,0.12)); color: var(--color-warning, #ca8a04); }
.status-uninitialized { background: var(--color-danger-soft); color: var(--color-danger); }
.status-outdated     { background: var(--color-accent-soft); color: var(--color-accent); }

.sm-item-url {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sm-item-meta {
  display: flex;
  gap: var(--space-4);
  align-items: center;
}

.sm-sha,
.sm-branch {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  font-family: var(--font-mono);
}

.sm-item-actions {
  display: flex;
  gap: var(--space-3);
  flex-shrink: 0;
}
</style>
