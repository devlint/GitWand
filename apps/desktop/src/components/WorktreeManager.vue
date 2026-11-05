<script setup lang="ts">
import { ref, onMounted, computed, watch } from "vue";
import {
  gitWorktreeList,
  gitWorktreePrune,
  gitWorktreeRepair,
  gitWorktreeStatusAll,
  type WorktreeEntry,
  type WorkspaceRepoStatus,
  worktreeResolveBase,
  openExternalUrl,
  type WorktreeBaseInfo,
  type CreatedWorktree,
} from "../utils/backend";
import { useWorktreeCreation } from "../composables/useWorktreeCreation";
import type { HookTrustDecision } from "../composables/useWorktreeHookTrust";
import { describeBase, slugifyWorktreeName } from "../utils/worktreeBase";
import type { GitBranch } from "../utils/backend";
import { useI18n } from "../composables/useI18n";
import BaseModal from "./BaseModal.vue";
import WorktreeRemoveDialog from "./WorktreeRemoveDialog.vue";

const props = defineProps<{
  cwd: string;
  branches: GitBranch[];
  /** Pre-select this branch in the new-worktree form and open the form automatically. */
  suggestedBranch?: string;
  /** If true, open the quick-create form immediately (e.g. triggered by ⌘⇧N). */
  openQuickCreate?: boolean;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "open-tab", path: string): void;
  (e: "load-branches"): void;
  /** v3.13: created through the worktree service; App runs its setup. */
  (e: "created", payload: { cwd: string; created: CreatedWorktree; decision: HookTrustDecision; open: boolean }): void;
  /** v3.13: focus a worktree's setup tab. */
  (e: "open-setup-log", payload: { repoPath: string; tabId: number }): void;
}>();

const flow = useWorktreeCreation();

// ── v3.13: base and default directory, fetched when a form opens ─────
const baseInfo = ref<WorktreeBaseInfo | null>(null);
let baseLoading = false;
async function loadBaseInfo() {
  if (baseInfo.value || baseLoading) return;
  baseLoading = true;
  try {
    baseInfo.value = await worktreeResolveBase(props.cwd);
  } catch {
    // Creation resolves the base itself; the line just stays "fetching".
  } finally {
    baseLoading = false;
  }
}
const baseLine = computed(() => {
  if (!baseInfo.value) return t("worktree.baseResolving");
  const line = describeBase(baseInfo.value.base);
  return t(line.key, ...line.args);
});

function setupStateFor(path: string) {
  return flow.states.value[path];
}

async function retrySetup(path: string) {
  const name = slugifyWorktreeName(path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "") ?? "";
  try {
    await flow.retrySetup(props.cwd, props.cwd, path, name);
  } catch (err: any) {
    error.value = t("worktree.setupStartFailed", String(err?.message ?? err));
  }
}

function openSetupLog(path: string) {
  const st = setupStateFor(path);
  if (st?.tabId != null) emit("open-setup-log", { repoPath: st.repoPath, tabId: st.tabId });
}

const { t } = useI18n();

const worktrees = ref<WorktreeEntry[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

// ── Status per worktree ──────────────────────────────────
const statuses = ref<WorkspaceRepoStatus[]>([]);
const statusLoading = ref(false);

function statusFor(path: string): WorkspaceRepoStatus | undefined {
  return statuses.value.find((s) => s.path === path);
}

async function loadStatuses() {
  statusLoading.value = true;
  try {
    statuses.value = await gitWorktreeStatusAll(props.cwd);
  } catch {
    // non-critical — silently ignore
  } finally {
    statusLoading.value = false;
  }
}

// ── New worktree form ────────────────────────────────────
const showForm = ref(false);
const formPath = ref("");
const formBranch = ref("");
const formNewBranch = ref("");
const creating = ref(false);

/** Base directory for worktrees: `worktree.dir`, else the sibling `<repo>.worktrees`. */
const worktreeBaseDir = computed(() => {
  if (baseInfo.value) return baseInfo.value.dir.replace(/\\/g, "/").replace(/\/+$/, "");
  const main = worktrees.value.find((w) => w.is_main);
  const basePath = main ? main.path : props.cwd;
  const normalizedBase = basePath.replace(/\\/g, "/").replace(/\/+$/, "");
  return `${normalizedBase}.worktrees`;
});

/** Derive a worktree path from a branch name. */
function derivePath(name: string): string {
  const slug = name.trim().replace(/[^a-zA-Z0-9/_-]/g, "-").replace(/-+/g, "-").replace(/^[-/]+|[-/]+$/g, "");
  return `${worktreeBaseDir.value}/${slug}`;
}

// ── Quick-create form ────────────────────────────────────
const showQuickCreate = ref(false);
const quickName = ref("");
const quickCreating = ref(false);

/** What quick-create will make: the backend slugs the name the same way. */
const quickSlug = computed(() => slugifyWorktreeName(quickName.value) ?? "");
const quickBranch = computed(() => {
  const name = quickName.value.trim();
  return name.includes("/") ? name : `task/${quickSlug.value}`;
});

async function quickCreate() {
  const name = quickName.value.trim();
  if (!name || !quickSlug.value) return;
  quickCreating.value = true;
  error.value = null;
  try {
    const result = await flow.create(props.cwd, {
      name,
      branch: name.includes("/") ? name : undefined,
      base: baseInfo.value?.base.base_ref,
      kind: "manual",
    });
    if (!result) return; // cancelled at the trust prompt
    quickName.value = "";
    showQuickCreate.value = false;
    await loadWorktrees();
    emit("created", { cwd: props.cwd, created: result.created, decision: result.decision, open: true });
  } catch (err: any) {
    error.value = t("worktree.errorCreate").replace("{0}", String(err?.message ?? err));
  } finally {
    quickCreating.value = false;
  }
}

// ── Prune stale worktrees ────────────────────────────────
const pruning = ref(false);

const hasPrunableWorktrees = computed(() =>
  worktrees.value.some((wt) => wt.is_prunable)
);

async function prune() {
  pruning.value = true;
  error.value = null;
  try {
    await gitWorktreePrune(props.cwd);
    await loadWorktrees();
  } catch (err: any) {
    error.value = t("worktree.errorPrune").replace("{0}", String(err?.message ?? err));
  } finally {
    pruning.value = false;
  }
}

// ── Branch lists for the add form ───────────────────────
const localBranches = computed(() => props.branches.filter((b) => !b.isRemote));
const remoteBranches = computed(() => props.branches.filter((b) => b.isRemote));

/** Set of branch names that already have a worktree. */
const usedBranches = computed(() => {
  const set = new Set<string>();
  for (const wt of worktrees.value) {
    if (wt.branch) set.add(wt.branch);
  }
  return set;
});

function isBranchUsed(name: string): boolean {
  return usedBranches.value.has(name);
}

// ── Remove confirmation ──────────────────────────────────
/** v3.13: the worktree being removed, through the removal dialog. */
const confirmRemovePath = ref<string | null>(null);

// ── Core actions ─────────────────────────────────────────

async function loadWorktrees() {
  loading.value = true;
  error.value = null;
  try {
    worktrees.value = await gitWorktreeList(props.cwd);
  } catch (err: any) {
    error.value = t("worktree.errorList").replace("{0}", String(err?.message ?? err));
  } finally {
    loading.value = false;
  }
}

async function createWorktree() {
  const path = formPath.value.trim();
  const picked = formBranch.value.trim();
  const newBranch = formNewBranch.value.trim();
  if (!path || (!picked && !newBranch)) return;
  creating.value = true;
  error.value = null;
  try {
    // New branch: from the picked base, else the fresh default base.
    // Existing local branch: checked out. Remote branch: a local branch of
    // the same name is created from it (no upstream, spec §5.2).
    const remote = remoteBranches.value.find((b) => b.name === picked);
    const req = newBranch
      ? { branch: newBranch, base: picked || undefined }
      : remote
        ? { branch: picked.split("/").slice(1).join("/"), base: picked }
        : { branch: picked };
    const result = await flow.create(props.cwd, {
      name: path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path,
      path,
      kind: "manual",
      ...req,
    });
    if (!result) return; // cancelled at the trust prompt
    formPath.value = "";
    formBranch.value = "";
    formNewBranch.value = "";
    showForm.value = false;
    await loadWorktrees();
    emit("created", { cwd: props.cwd, created: result.created, decision: result.decision, open: false });
  } catch (err: any) {
    error.value = t("worktree.errorCreate").replace("{0}", String(err?.message ?? err));
  } finally {
    creating.value = false;
  }
}

function requestRemove(path: string) {
  error.value = null;
  confirmRemovePath.value = path;
}

async function onRemoved() {
  confirmRemovePath.value = null;
  await loadWorktrees();
  emit("load-branches");
}

function shortPath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length <= 2 ? path : "…/" + parts.slice(-2).join("/");
}

// Watch for branch changes to pre-fill the path
watch([formBranch, formNewBranch], ([branch, newBranch]) => {
  const target = newBranch.trim() || branch.trim();
  if (target) {
    formPath.value = derivePath(target);
  }
});

// Fetch the base (and the default dir) once a creation form opens.
watch([showQuickCreate, showForm], ([quick, form]) => {
  if (quick || form) void loadBaseInfo();
});

// Reload statuses whenever worktrees change
watch(worktrees, () => { loadStatuses(); }, { immediate: false });

onMounted(async () => {
  // Répare silencieusement les liens administratifs cassés (idempotent,
  // < 5 ms si tout va bien). Couvre le cas "repo déplacé manuellement".
  try { await gitWorktreeRepair(props.cwd); } catch { /* best-effort */ }
  await loadWorktrees();
  emit("load-branches");
  if (props.suggestedBranch) {
    formBranch.value = props.suggestedBranch;
    showForm.value = true;
  }
  if (props.openQuickCreate) {
    showQuickCreate.value = true;
  }
});
</script>

<template>
  <BaseModal
    :title="t('worktree.title')"
    size="lg"
    scroll-own
    body-flush
    @close="emit('close')"
  >
    <!-- Title icon -->
    <template #title-icon>
      <div class="wt-modal-icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <path d="M17.5 17.5h.01M14 17.5h3.5M17.5 14v3.5" />
        </svg>
      </div>
    </template>

    <!-- Header action buttons -->
    <template #header-actions>
      <button
        type="button"
        class="bm-btn bm-btn--ghost"
        :title="t('worktree.quickCreateTooltip')"
        :class="{ 'bm-btn--active': showQuickCreate }"
        @click="showQuickCreate = !showQuickCreate; showForm = false;"
      >
        ⚡ {{ t("worktree.quickCreate") }}
      </button>
      <button
        type="button"
        class="bm-btn bm-btn--ghost"
        :title="t('worktree.pruneTooltip')"
        :disabled="!hasPrunableWorktrees || pruning"
        @click="prune"
      >
        {{ pruning ? t("worktree.pruning") : t("worktree.prune") }}
      </button>
    </template>

    <!-- Body -->
    <div class="wt-body">

      <!-- ── Quick-create form ───────────────────────────── -->
      <div v-if="showQuickCreate" class="wt-quick-form">
        <div class="wt-quick-form-inner">
          <svg class="wt-quick-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
          </svg>
          <input
            v-model="quickName"
            class="wt-input wt-quick-input"
            :placeholder="t('worktree.quickCreateNamePlaceholder')"
            autofocus
            @keydown.enter="quickCreate"
            @keydown.escape="showQuickCreate = false"
          />
          <button
            class="bm-btn bm-btn--primary"
            :disabled="quickCreating || !quickName.trim()"
            @click="quickCreate"
          >
            {{ quickCreating ? t("worktree.creating") : t("worktree.quickCreateSubmit") }}
          </button>
          <button class="bm-btn bm-btn--ghost" @click="showQuickCreate = false">
            {{ t("common.cancel") }}
          </button>
        </div>
        <p v-if="quickSlug" class="wt-quick-preview">
          → {{ `${worktreeBaseDir}/${quickSlug}` }}
          <span class="wt-quick-branch">({{ quickBranch }})</span>
        </p>
        <p class="wt-quick-preview wt-base-line">{{ baseLine }}</p>
      </div>

      <!-- ── New worktree form ───────────────────────────── -->
      <div v-if="showForm" class="wt-form">
        <div class="wt-form-row">
          <label class="wt-label" for="wt-form-branch">{{ t("worktree.formBranch") }}</label>
          <select id="wt-form-branch" v-model="formBranch" class="wt-select">
            <option value="">{{ formNewBranch.trim() ? t("worktree.formBaseDefault") : t("worktree.formBranchPlaceholder") }}</option>
            <optgroup :label="t('worktree.localBranches')">
              <option v-for="b in localBranches" :key="b.name" :value="b.name" :disabled="isBranchUsed(b.name)">
                {{ b.name }}{{ isBranchUsed(b.name) ? ` ${t("worktree.formBranchAlreadyUsed")}` : "" }}
              </option>
            </optgroup>
            <optgroup v-if="remoteBranches.length" :label="t('worktree.remoteBranches')">
              <option v-for="b in remoteBranches" :key="b.name" :value="b.name" :disabled="isBranchUsed(b.name)">
                {{ b.name }}{{ isBranchUsed(b.name) ? ` ${t("worktree.formBranchAlreadyUsed")}` : "" }}
              </option>
            </optgroup>
          </select>
        </div>
        <div class="wt-form-row">
          <label class="wt-label" for="wt-form-path">{{ t("worktree.formPath") }}</label>
          <input
            id="wt-form-path"
            v-model="formPath"
            class="wt-input"
            :placeholder="t('worktree.formPathPlaceholder')"
            @keydown.enter="createWorktree"
          />
        </div>
        <div class="wt-form-row">
          <label class="wt-label" for="wt-form-new-branch">{{ t("worktree.formNewBranch") }}</label>
          <input
            id="wt-form-new-branch"
            v-model="formNewBranch"
            class="wt-input"
            :placeholder="t('worktree.formNewBranchPlaceholder')"
            @keydown.enter="createWorktree"
          />
        </div>
        <p v-if="!formBranch.trim() && formNewBranch.trim()" class="wt-quick-preview wt-base-line">{{ baseLine }}</p>
        <div class="wt-form-actions">
          <button
            class="bm-btn bm-btn--primary"
            :disabled="creating || !formPath.trim() || (!formBranch.trim() && !formNewBranch.trim())"
            @click="createWorktree"
          >
            {{ creating ? t("worktree.creating") : t("worktree.create") }}
          </button>
          <button class="bm-btn bm-btn--ghost" @click="showForm = false">
            {{ t("common.cancel") }}
          </button>
        </div>
      </div>

      <!-- ── Prunable alert ─────────────────────────────── -->
      <div v-if="hasPrunableWorktrees" class="wt-alert">
        {{ t("worktree.prunableAlert") }}
        <button class="bm-btn bm-btn--ghost bm-btn--sm" :disabled="pruning" @click="prune">
          {{ t("worktree.prune") }}
        </button>
      </div>

      <!-- ── Error ───────────────────────────────────────── -->
      <div v-if="error" class="wt-error">{{ error }}</div>

      <!-- ── Removal (v3.13: guards, processes, snapshot, teardown) ── -->
      <WorktreeRemoveDialog
        v-if="confirmRemovePath"
        :cwd="cwd"
        :repo-path="cwd"
        :path="confirmRemovePath"
        @close="confirmRemovePath = null"
        @done="onRemoved"
        @open-log="(p) => emit('open-setup-log', p)"
      />

      <!-- ── Loading ─────────────────────────────────────── -->
      <div v-if="loading" class="wt-state">{{ t("common.loading") }}</div>

      <!-- ── Empty ───────────────────────────────────────── -->
      <div v-else-if="!loading && worktrees.length === 0" class="wt-state">
        {{ t("worktree.empty") }}
      </div>

      <!-- ── List ───────────────────────────────────────── -->
      <div v-else class="wt-list">
        <!-- Status header (shown while statuses load) -->
        <div v-if="statusLoading" class="wt-status-loading">
          {{ t("worktree.statusTitle") }}…
        </div>

        <div v-for="wt in worktrees" :key="wt.path" class="wt-item" :class="{ 'wt-item--main': wt.is_main }">
          <div class="wt-item-info">
            <div class="wt-item-badges">
              <span v-if="wt.is_main" class="badge badge-main">{{ t("worktree.main") }}</span>
              <span
                v-if="wt.is_locked"
                class="badge badge-locked"
                :title="wt.lock_reason ? `${t('worktree.locked')}: ${wt.lock_reason}` : t('worktree.locked')"
              >🔒 {{ t("worktree.locked") }}</span>
              <span v-if="wt.is_bare" class="badge badge-bare">{{ t("worktree.bare") }}</span>
              <span
                v-if="wt.is_prunable"
                class="badge badge-prunable"
                :title="wt.prunable_reason ?? t('worktree.prunableTooltip')"
              >{{ t("worktree.prunable") }}</span>
            </div>
            <div class="wt-item-branch">
              <svg class="wt-branch-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="5" cy="3" r="1.5" />
                <circle cx="5" cy="13" r="1.5" />
                <circle cx="11" cy="6" r="1.5" />
                <path d="M5 4.5v7M5 4.5C5 7 11 7.5 11 6" />
              </svg>
              {{ wt.branch || t("worktree.detached") }}

              <!-- Status pills -->
              <template v-for="st in [statusFor(wt.path)].filter(Boolean)" :key="wt.path + '-status'">
                <!-- Conflits : priorité visuelle maximale -->
                <span v-if="st!.conflicted > 0" class="wt-status-pill wt-pill-conflict" :title="t('worktree.conflicted')">⚠ {{ st!.conflicted }}</span>
                <!-- Ahead / behind : uniquement si upstream configuré -->
                <template v-if="st!.has_upstream">
                  <span v-if="st!.ahead > 0" class="wt-status-pill wt-pill-ahead">↑{{ st!.ahead }}</span>
                  <span v-if="st!.behind > 0" class="wt-status-pill wt-pill-behind">↓{{ st!.behind }}</span>
                </template>
                <span v-else class="wt-status-pill wt-pill-muted" :title="t('worktree.noUpstream')">{{ t("worktree.noUpstreamShort") }}</span>
                <!-- Fichiers modifiés (hors conflits) -->
                <span v-if="st!.modified > 0" class="wt-status-pill wt-pill-modified">~{{ st!.modified }}</span>
                <!-- Synchro totale -->
                <span v-if="!st!.error && st!.has_upstream && st!.ahead === 0 && st!.behind === 0 && st!.modified === 0 && st!.conflicted === 0" class="wt-status-pill wt-pill-clean">✓</span>
                <span v-if="st!.error" class="wt-status-pill wt-pill-error" :title="st!.error!">⚠</span>
              </template>
            </div>
            <div class="wt-item-path" :title="wt.path">{{ shortPath(wt.path) }}</div>
            <!-- v3.13: setup state and URL from this session -->
            <template v-for="st in [setupStateFor(wt.path)].filter(Boolean)" :key="wt.path + '-setup'">
              <div class="wt-item-setup" :class="`wt-item-setup--${st!.status}`">
                <span v-if="st!.status === 'running'">{{ t("worktree.setupRunning") }}</span>
                <template v-else-if="st!.status === 'failed'">
                  <span class="wt-setup-failed">{{ t("worktree.setupFailed") }}</span>
                  <button class="bm-btn bm-btn--ghost" @click="retrySetup(wt.path)">{{ t("worktree.retrySetup") }}</button>
                  <button v-if="st!.tabId != null" class="bm-btn bm-btn--ghost" @click="openSetupLog(wt.path)">{{ t("worktree.openLog") }}</button>
                  <button class="bm-btn bm-btn--danger" @click="requestRemove(wt.path)">{{ t("worktree.remove") }}</button>
                </template>
                <template v-else-if="st!.url">
                  <span class="wt-item-url" :title="st!.url">{{ st!.url }}</span>
                  <button class="bm-btn bm-btn--ghost" @click="openExternalUrl(st!.url!)">{{ t("worktree.openUrl") }}</button>
                </template>
              </div>
            </template>
            <div v-if="wt.head" class="wt-item-head">{{ wt.head.slice(0, 7) }}</div>
          </div>
          <div class="wt-item-actions">
            <button
              v-if="!wt.is_main"
              class="bm-btn bm-btn--ghost"
              @click="emit('open-tab', wt.path)"
            >
              {{ t("worktree.openInTab") }}
            </button>
            <button
              v-if="!wt.is_main"
              class="bm-btn bm-btn--danger"
              @click="requestRemove(wt.path)"
            >
              {{ t("worktree.remove") }}
            </button>
          </div>
        </div>

        <!-- ── Only-main hint ─────────────────────────── -->
        <div
          v-if="worktrees.length === 1 && worktrees[0].is_main"
          class="wt-only-main-hint"
        >
          {{ t("worktree.onlyMainHint") }}
        </div>
      </div>
    </div>

    <!-- Footer action -->
    <template #footer>
      <button
        type="button"
        class="wt-footer-add-btn"
        @click="showForm = !showForm; showQuickCreate = false;"
      >
        <span class="wt-footer-add-btn__icon">+</span>
        <span>{{ t("worktree.newWorktree") }}</span>
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
/* ── Modal icon ─────────────────────────────────────────── */
.wt-modal-icon {
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
.wt-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* ── Quick-create form ──────────────────────────────────── */
.wt-quick-form {
  padding: var(--space-4) var(--space-7);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-accent-soft);
  flex-shrink: 0;
}

.wt-quick-form-inner {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.wt-quick-icon {
  color: var(--color-accent);
  flex-shrink: 0;
}

.wt-quick-input {
  flex: 1;
}

.wt-quick-preview {
  margin: var(--space-2) 0 0;
  font-size: var(--font-size-xs);
  font-family: var(--font-mono);
  color: var(--color-text-muted);
}

.wt-quick-branch {
  color: var(--color-accent);
  margin-left: var(--space-2);
}

/* ── Standard new-worktree form ─────────────────────────── */
.wt-form {
  padding: var(--space-5) var(--space-7);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-tertiary);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  flex-shrink: 0;
}

.wt-form-row {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.wt-label {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-muted);
}

.wt-input,
.wt-select {
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

.wt-input:focus,
.wt-select:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-soft);
}

.wt-form-actions {
  display: flex;
  gap: var(--space-3);
}

/* ── Error ──────────────────────────────────────────────── */
.wt-error {
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
.wt-state {
  padding: var(--space-10) var(--space-7);
  font-size: var(--font-size-md);
  color: var(--color-text-muted);
  text-align: center;
}

.wt-status-loading {
  padding: var(--space-2) var(--space-7);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  font-style: italic;
}

.wt-only-main-hint {
  margin-top: var(--space-4);
  padding: var(--space-4) var(--space-5);
  background: var(--color-surface-raised, var(--color-bg-subtle));
  border: 1px dashed var(--color-border-muted, var(--color-border));
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  text-align: center;
  line-height: 1.5;
}

/* ── List ───────────────────────────────────────────────── */
.wt-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-5) var(--space-7) var(--space-6);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.wt-item {
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

.wt-item:hover {
  border-color: var(--color-accent);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
}

.wt-item-info {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.wt-item-badges {
  display: flex;
  gap: var(--space-2);
  margin-bottom: var(--space-1);
}

.badge {
  font-size: 10px;
  font-weight: var(--font-weight-semibold);
  padding: 2px var(--space-3);
  border-radius: var(--radius-pill);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.badge-main   { background: var(--color-accent-soft); color: var(--color-accent); }
.badge-locked { background: var(--color-warning-soft, rgba(234,179,8,0.15)); color: var(--color-warning, #ca8a04); }
.badge-bare   { background: var(--color-bg-tertiary); color: var(--color-text-muted); }

.wt-item-branch {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--color-text);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.wt-branch-icon { color: var(--color-accent); flex-shrink: 0; }

.wt-item-path {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.wt-item-head {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  font-family: var(--font-mono);
}

.wt-item-actions {
  display: flex;
  gap: var(--space-3);
  flex-shrink: 0;
}

/* ── Status pills ───────────────────────────────────────── */
.wt-status-pill {
  display: inline-flex;
  align-items: center;
  font-size: 10px;
  font-weight: var(--font-weight-semibold);
  padding: 1px 5px;
  border-radius: var(--radius-pill);
  letter-spacing: 0.02em;
  line-height: 1.5;
}

.wt-pill-ahead    { background: rgba(99, 102, 241, 0.15); color: #818cf8; }
.wt-pill-behind   { background: rgba(245, 158, 11, 0.15); color: #f59e0b; }
.wt-pill-modified { background: rgba(236, 72, 153, 0.15); color: #ec4899; }
.wt-pill-clean    { background: rgba(72, 187, 120, 0.15); color: #48bb78; }
.wt-pill-muted    { background: var(--color-bg-tertiary); color: var(--color-text-muted); }
.wt-pill-error    { background: var(--color-danger-soft); color: var(--color-danger); cursor: help; }
.wt-pill-conflict { background: var(--color-danger-soft); color: var(--color-danger); font-weight: var(--font-weight-semibold); }

/* ── Active ghost button state ──────────────────────────── */
.bm-btn--active {
  background: var(--color-accent-soft);
  color: var(--color-accent);
  border-color: var(--color-accent);
}

/* ── Prunable alert banner ──────────────────────────────── */
.wt-alert {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-7);
  background: var(--color-warning-soft, rgba(245, 158, 11, 0.1));
  color: var(--color-warning, #f59e0b);
  font-size: var(--font-size-sm);
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

/* ── Prunable badge ─────────────────────────────────────── */
.badge-prunable {
  background: var(--color-danger-soft);
  color: var(--color-danger);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  padding: 1px var(--space-2);
  border-radius: var(--radius-pill);
  cursor: help;
}

/* ── Footer add button ──────────────────────────────────── */
.wt-footer-add-btn {
  width: 100%;
  height: var(--space-10);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  background: var(--color-accent);
  color: var(--color-accent-text);
  border: none;
  border-radius: var(--radius-md);
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
  transition: background var(--transition-base), transform var(--transition-fast);
}

.wt-footer-add-btn:hover {
  background: var(--color-accent-hover);
}

.wt-footer-add-btn:active {
  transform: translateY(1px);
}

.wt-footer-add-btn__icon {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-medium);
  margin-top: -1px;
}
.wt-item-setup {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 4px;
  font-size: 12px;
  color: var(--color-text-muted);
}
.wt-setup-failed {
  color: var(--color-danger, #e5484d);
  font-weight: 600;
}
.wt-item-url {
  font-family: var(--font-mono, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 280px;
}
.wt-base-line {
  opacity: 0.8;
}
</style>
