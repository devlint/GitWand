<script setup lang="ts">
import { ref, onMounted } from "vue";
import {
  workspaceRead,
  workspaceWrite,
  workspaceStatusAll,
  workspaceFetchAll,
  workspacePullAll,
  type WorkspaceConfig,
  type WorkspaceRepo,
  type WorkspaceRepoStatus,
} from "../utils/backend";
import { useI18n } from "../composables/useI18n";
import { pickFolder } from "../utils/backend";
import BaseModal from "./BaseModal.vue";

const emit = defineEmits<{
  (e: "open-tab", path: string): void;
  (e: "close"): void;
}>();

const { t } = useI18n();

// ─── State ───────────────────────────────────────────────

const workspaceDir = ref<string | null>(null);
const workspace = ref<WorkspaceConfig | null>(null);
const statuses = ref<WorkspaceRepoStatus[]>([]);
const loading = ref(false);
const actionLoading = ref<"fetch" | "pull" | "status" | null>(null);
const error = ref<string | null>(null);

// Create workspace form
const showCreateForm = ref(false);
const createName = ref("");
const createDir = ref("");
const creating = ref(false);

// Add repo form
const showAddRepo = ref(false);
const addRepoPath = ref("");
const addRepoName = ref("");

// ─── Persistence ─────────────────────────────────────────

async function loadWorkspace(dir: string) {
  loading.value = true;
  error.value = null;
  try {
    const cfg = await workspaceRead(dir);
    workspace.value = cfg;
    workspaceDir.value = dir;
    // Load statuses in background
    statuses.value = await workspaceStatusAll(cfg.repos);
  } catch (err: any) {
    error.value = t("workspace.errorRead").replace("{0}", String(err?.message ?? err));
  } finally {
    loading.value = false;
  }
}

async function saveWorkspace() {
  if (!workspaceDir.value || !workspace.value) return;
  try {
    await workspaceWrite(workspaceDir.value, workspace.value);
  } catch (err: any) {
    error.value = t("workspace.errorWrite").replace("{0}", String(err?.message ?? err));
  }
}

// ─── Create workspace ─────────────────────────────────────

async function pickCreateDir() {
  const picked = await pickFolder();
  if (picked) createDir.value = picked;
}

async function createWorkspace() {
  if (!createName.value.trim() || !createDir.value.trim()) return;
  creating.value = true;
  error.value = null;
  try {
    const cfg: WorkspaceConfig = { name: createName.value.trim(), repos: [] };
    await workspaceWrite(createDir.value.trim(), cfg);
    workspace.value = cfg;
    workspaceDir.value = createDir.value.trim();
    statuses.value = [];
    showCreateForm.value = false;
    createName.value = "";
    createDir.value = "";
  } catch (err: any) {
    error.value = t("workspace.errorWrite").replace("{0}", String(err?.message ?? err));
  } finally {
    creating.value = false;
  }
}

// ─── Open workspace ───────────────────────────────────────

async function openWorkspace() {
  const picked = await pickFolder();
  if (picked) {
    await loadWorkspace(picked);
  }
}

// ─── Repo management ──────────────────────────────────────

async function pickAddRepoPath() {
  const picked = await pickFolder();
  if (picked) {
    addRepoPath.value = picked;
    if (!addRepoName.value) {
      addRepoName.value = picked.split("/").pop() ?? picked.split("\\").pop() ?? picked;
    }
  }
}

async function addRepo() {
  if (!addRepoPath.value.trim() || !workspace.value) return;
  const name = addRepoName.value.trim() || addRepoPath.value.split("/").pop() || addRepoPath.value;
  const repo: WorkspaceRepo = { path: addRepoPath.value.trim(), name };
  workspace.value.repos.push(repo);
  await saveWorkspace();
  showAddRepo.value = false;
  addRepoPath.value = "";
  addRepoName.value = "";
  // Refresh statuses
  statuses.value = await workspaceStatusAll(workspace.value.repos);
}

async function removeRepo(idx: number) {
  if (!workspace.value) return;
  workspace.value.repos.splice(idx, 1);
  await saveWorkspace();
  statuses.value = statuses.value.filter((_, i) => i !== idx);
}

// ─── Group actions ────────────────────────────────────────

async function fetchAll() {
  if (!workspace.value) return;
  actionLoading.value = "fetch";
  error.value = null;
  try {
    statuses.value = await workspaceFetchAll(workspace.value.repos);
  } catch (err: any) {
    error.value = t("workspace.errorStatus").replace("{0}", String(err?.message ?? err));
  } finally {
    actionLoading.value = null;
  }
}

async function pullAll() {
  if (!workspace.value) return;
  actionLoading.value = "pull";
  error.value = null;
  try {
    statuses.value = await workspacePullAll(workspace.value.repos);
  } catch (err: any) {
    error.value = t("workspace.errorStatus").replace("{0}", String(err?.message ?? err));
  } finally {
    actionLoading.value = null;
  }
}

async function refreshStatus() {
  if (!workspace.value) return;
  actionLoading.value = "status";
  try {
    statuses.value = await workspaceStatusAll(workspace.value.repos);
  } catch (err: any) {
    error.value = t("workspace.errorStatus").replace("{0}", String(err?.message ?? err));
  } finally {
    actionLoading.value = null;
  }
}

function openAll() {
  if (!workspace.value) return;
  for (const repo of workspace.value.repos) {
    emit("open-tab", repo.path);
  }
}

function statusFor(path: string): WorkspaceRepoStatus | undefined {
  return statuses.value.find(s => s.path === path);
}

onMounted(() => {
  // Try to load from localStorage (remember last workspace)
  const saved = localStorage.getItem("gitwand-workspace-dir");
  if (saved) loadWorkspace(saved).catch(() => {});
});

// Persist workspace dir
function persistDir(dir: string) {
  localStorage.setItem("gitwand-workspace-dir", dir);
}

// Watch workspace dir changes
import { watch } from "vue";
watch(workspaceDir, (dir) => { if (dir) persistDir(dir); });
</script>

<template>
  <BaseModal
    :title="t('workspace.panelTitle')"
    size="lg"
    @close="emit('close')"
  >
    <template #title-icon>
      <span class="bm-title-icon" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 5a2 2 0 0 1 2-2h3l2 2h5a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5z"/>
        </svg>
      </span>
    </template>
  <div class="wp-panel">

    <!-- No workspace open -->
    <template v-if="!workspace">
      <div class="wp-empty-state">
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4">
          <rect x="4" y="10" width="32" height="24" rx="3"/>
          <path d="M4 16h32M12 10V7a2 2 0 012-2h8a2 2 0 012 2v3"/>
        </svg>
        <p class="wp-empty-text">{{ t("workspace.empty") }}</p>
        <div class="wp-empty-actions">
          <button class="bm-btn bm-btn--primary" @click="showCreateForm = true">
            {{ t("workspace.newWorkspace") }}
          </button>
          <button class="bm-btn bm-btn--ghost" @click="openWorkspace">
            {{ t("workspace.openWorkspace") }}
          </button>
        </div>
      </div>
    </template>

    <!-- Workspace loaded -->
    <template v-else>
      <!-- Header -->
      <div class="wp-header">
        <div class="wp-header-left">
          <span class="wp-title">{{ workspace.name }}</span>
          <span class="wp-dir">{{ workspaceDir }}</span>
        </div>
        <div class="wp-header-actions">
          <button
            class="bm-btn bm-btn--ghost wp-btn-sm"
            :disabled="actionLoading === 'fetch'"
            @click="fetchAll"
          >
            {{ actionLoading === "fetch" ? t("workspace.fetchingAll") : t("workspace.fetchAll") }}
          </button>
          <button
            class="bm-btn bm-btn--ghost wp-btn-sm"
            :disabled="actionLoading === 'pull'"
            @click="pullAll"
          >
            {{ actionLoading === "pull" ? t("workspace.pullingAll") : t("workspace.pullAll") }}
          </button>
          <button
            class="bm-btn bm-btn--ghost wp-btn-sm"
            :disabled="actionLoading === 'status'"
            @click="refreshStatus"
          >
            {{ t("workspace.statusAll") }}
          </button>
          <button class="bm-btn bm-btn--ghost wp-btn-sm" @click="openAll" :disabled="!workspace.repos.length">
            {{ t("workspace.openAll") }}
          </button>
        </div>
      </div>

      <!-- Error -->
      <div v-if="error" class="wp-error">{{ error }}</div>

      <!-- Loading -->
      <div v-if="loading" class="wp-loading">{{ t("common.loading") }}</div>

      <!-- Repo list -->
      <ul v-else class="wp-repos">
        <li v-for="(repo, idx) in workspace.repos" :key="repo.path" class="wp-repo-item">
          <div class="wp-repo-left">
            <!-- Repo icon -->
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" class="wp-repo-icon">
              <path d="M2 2h12v12H2zM6 2v12M10 6H6"/>
            </svg>
            <div class="wp-repo-info">
              <button class="wp-repo-name" @click="emit('open-tab', repo.path)">{{ repo.name }}</button>
              <span class="wp-repo-path">{{ repo.path }}</span>
            </div>
          </div>

          <!-- Status badges -->
          <div class="wp-repo-status">
            <template v-if="statusFor(repo.path)">
              <span class="wp-badge wp-badge--branch" :title="statusFor(repo.path)!.branch">
                {{ statusFor(repo.path)!.branch || "—" }}
              </span>
              <span v-if="statusFor(repo.path)!.ahead" class="wp-badge wp-badge--ahead">
                {{ t("workspace.ahead").replace("{0}", String(statusFor(repo.path)!.ahead)) }}
              </span>
              <span v-if="statusFor(repo.path)!.behind" class="wp-badge wp-badge--behind">
                {{ t("workspace.behind").replace("{0}", String(statusFor(repo.path)!.behind)) }}
              </span>
              <span v-if="statusFor(repo.path)!.modified" class="wp-badge wp-badge--modified">
                {{ t("workspace.modified").replace("{0}", String(statusFor(repo.path)!.modified)) }}
              </span>
              <span v-else-if="!statusFor(repo.path)!.error" class="wp-badge wp-badge--clean">
                {{ t("workspace.clean") }}
              </span>
              <span v-if="statusFor(repo.path)!.error" class="wp-badge wp-badge--error" :title="statusFor(repo.path)!.error!">
                ⚠
              </span>
            </template>
            <button class="wp-btn-remove" @click="removeRepo(idx)" :title="t('workspace.removeRepo')">
              ×
            </button>
          </div>
        </li>

        <!-- Add repo row -->
        <li class="wp-add-repo-row">
          <button class="wp-add-repo-btn" @click="showAddRepo = true">
            + {{ t("workspace.addRepo") }}
          </button>
        </li>
      </ul>
    </template>

    <!-- Create workspace modal -->
    <BaseModal v-if="showCreateForm" :title="t('workspace.newWorkspace')" @close="showCreateForm = false">
      <template #title-icon>
        <span class="bm-title-icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10 4v12M4 10h12"/>
          </svg>
        </span>
      </template>
      <div class="wp-form">
        <label class="wp-form-label">{{ t("workspace.workspaceName") }}</label>
        <input
          v-model="createName"
          class="wp-input"
          :placeholder="t('workspace.workspaceNamePlaceholder')"
          autofocus
        />

        <label class="wp-form-label" style="margin-top: 12px;">{{ t("workspace.workspaceDir") }}</label>
        <div class="wp-dir-row">
          <input v-model="createDir" class="wp-input wp-input--flex" :placeholder="t('workspace.workspaceDirHint')" />
          <button class="bm-btn bm-btn--ghost wp-btn-sm" @click="pickCreateDir">…</button>
        </div>
        <p class="wp-form-hint">{{ t("workspace.workspaceDirHint") }}</p>
      </div>

      <template #footer>
        <button class="bm-btn bm-btn--ghost" @click="showCreateForm = false">{{ t("common.cancel") }}</button>
        <button
          class="bm-btn bm-btn--primary"
          :disabled="creating || !createName.trim() || !createDir.trim()"
          @click="createWorkspace"
        >
          {{ creating ? t("workspace.creating") : t("workspace.create") }}
        </button>
      </template>
    </BaseModal>

    <!-- Add repo modal -->
    <BaseModal v-if="showAddRepo" :title="t('workspace.addRepo')" @close="showAddRepo = false">
      <template #title-icon>
        <span class="bm-title-icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="5" cy="5" r="1.5"/><circle cx="5" cy="10" r="1.5"/><circle cx="5" cy="15" r="1.5"/>
            <path d="M8 5h8M8 10h8M8 15h8"/>
          </svg>
        </span>
      </template>
      <div class="wp-form">
        <label class="wp-form-label">{{ t("workspace.repoPath") }}</label>
        <div class="wp-dir-row">
          <input v-model="addRepoPath" class="wp-input wp-input--flex" placeholder="/path/to/repo" />
          <button class="bm-btn bm-btn--ghost wp-btn-sm" @click="pickAddRepoPath">…</button>
        </div>
        <label class="wp-form-label" style="margin-top: 10px;">{{ t("common.optional") }} — name</label>
        <input v-model="addRepoName" class="wp-input" placeholder="repo-name" />
      </div>

      <template #footer>
        <button class="bm-btn bm-btn--ghost" @click="showAddRepo = false">{{ t("common.cancel") }}</button>
        <button
          class="bm-btn bm-btn--primary"
          :disabled="!addRepoPath.trim()"
          @click="addRepo"
        >
          {{ t("workspace.addRepo") }}
        </button>
      </template>
    </BaseModal>

  </div>
  </BaseModal>
</template>

<style scoped>
/* .wp-title-icon removed — use global .bm-title-icon from BaseModal instead */

.wp-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* Empty state */
.wp-empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 32px;
  text-align: center;
}

.wp-empty-text {
  font-size: 13px;
  color: var(--color-text-muted);
  max-width: 240px;
}

.wp-empty-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: center;
}

/* Header */
.wp-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-border);
  gap: 8px;
  flex-wrap: wrap;
}

.wp-header-left {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.wp-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-primary);
}

.wp-dir {
  font-size: 10px;
  color: var(--color-text-muted);
  font-family: var(--font-mono, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 200px;
}

.wp-header-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
}

.wp-btn-sm {
  padding: 4px 10px;
  font-size: 12px;
}

/* Error / loading */
.wp-error {
  padding: 8px 16px;
  background: var(--color-danger-soft, rgba(229,62,62,0.1));
  color: var(--color-danger, #e53e3e);
  font-size: 12px;
}

.wp-loading {
  padding: 24px;
  text-align: center;
  font-size: 12px;
  color: var(--color-text-muted);
}

/* Repo list */
.wp-repos {
  list-style: none;
  margin: 0;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
  flex: 1;
}

.wp-repo-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-radius: 7px;
  border: 1px solid var(--color-border);
  background: var(--color-surface-alt, rgba(255,255,255,0.03));
  transition: background 0.12s;
  gap: 8px;
}

.wp-repo-item:hover {
  background: var(--color-accent-soft, rgba(99,102,241,0.07));
}

.wp-repo-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.wp-repo-icon {
  flex-shrink: 0;
  color: var(--color-text-muted);
}

.wp-repo-info {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.wp-repo-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-accent, #6366f1);
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wp-repo-name:hover {
  text-decoration: underline;
}

.wp-repo-path {
  font-size: 10px;
  color: var(--color-text-muted);
  font-family: var(--font-mono, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 220px;
}

.wp-repo-status {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

/* Badges */
.wp-badge {
  font-size: 10px;
  padding: 2px 5px;
  border-radius: 4px;
  font-weight: 500;
  white-space: nowrap;
  max-width: 90px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.wp-badge--branch {
  background: var(--color-surface-alt, rgba(255,255,255,0.06));
  color: var(--color-text-secondary);
  font-family: var(--font-mono, monospace);
}

.wp-badge--ahead {
  background: rgba(99, 102, 241, 0.15);
  color: #818cf8;
}

.wp-badge--behind {
  background: rgba(251, 191, 36, 0.15);
  color: #f59e0b;
}

.wp-badge--modified {
  background: rgba(251, 113, 133, 0.15);
  color: #f472b6;
}

.wp-badge--clean {
  background: rgba(72, 187, 120, 0.12);
  color: #48bb78;
}

.wp-badge--error {
  background: rgba(229,62,62,0.1);
  color: var(--color-danger, #e53e3e);
}

/* Remove button */
.wp-btn-remove {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--color-text-muted);
  font-size: 16px;
  line-height: 1;
  padding: 0 2px;
  opacity: 0;
  transition: opacity 0.15s, color 0.15s;
}

.wp-repo-item:hover .wp-btn-remove {
  opacity: 1;
}

.wp-btn-remove:hover {
  color: var(--color-danger, #e53e3e);
}

/* Add repo row */
.wp-add-repo-row {
  padding: 4px 0;
}

.wp-add-repo-btn {
  background: none;
  border: 1px dashed var(--color-border);
  border-radius: 7px;
  color: var(--color-text-muted);
  font-size: 12px;
  padding: 7px 10px;
  cursor: pointer;
  width: 100%;
  text-align: left;
  transition: border-color 0.12s, color 0.12s;
}

.wp-add-repo-btn:hover {
  border-color: var(--color-accent, #6366f1);
  color: var(--color-accent, #6366f1);
}

/* Form */
.wp-form {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px 0;
}

.wp-form-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text-secondary);
}

.wp-form-hint {
  font-size: 11px;
  color: var(--color-text-muted);
  margin-top: 2px;
}

.wp-input {
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  color: var(--color-text-primary);
  font-size: 12px;
}

.wp-input--flex {
  flex: 1;
}

.wp-dir-row {
  display: flex;
  gap: 6px;
  align-items: center;
}
</style>
