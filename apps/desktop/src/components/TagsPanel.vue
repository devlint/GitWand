<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { gitListTags, gitDeleteTag, gitPushTags, gitDeleteRemoteTag, gitRemoteInfo, gitRetagTo, gitForcePushTag, gitUnpushedTags, type GitTag } from "../utils/backend";
import { useI18n } from "../composables/useI18n";
import BaseModal from "./BaseModal.vue";
import AiSparkle from "./AiSparkle.vue";
import { useAIProvider } from "../composables/useAIProvider";
import { useReleaseNotes, latestTag as findLatestTag } from "../composables/useReleaseNotes";

const props = defineProps<{
  cwd: string;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "create-tag"): void;  // ask host to open the tag creation flow
  (e: "refresh"): void;     // ask host to refresh repo data (v2.12 bug fix)
}>();

const { t, locale } = useI18n();
const ai = useAIProvider();

// ─── Release notes (relocated from the Dashboard, v3) ────
// A release = a tag, so the generator lives with Tags now. The automation
// "release notes on tag creation" is unchanged (AutomationsPanel).
const {
  isGenerating: isGeneratingReleaseNotes,
  generate: generateReleaseNotes,
  lastError: releaseNotesError,
} = useReleaseNotes();
const releaseNotesOpen = ref(false);
const releaseNotesFrom = ref("");
const releaseNotesTo = ref("HEAD");
const releaseNotesMarkdown = ref("");
const releaseNotesCopied = ref(false);

async function openReleaseNotes() {
  releaseNotesMarkdown.value = "";
  releaseNotesTo.value = "HEAD";
  releaseNotesCopied.value = false;
  releaseNotesFrom.value = (await findLatestTag(props.cwd)) || "";
  releaseNotesOpen.value = true;
}
function closeReleaseNotes() {
  releaseNotesOpen.value = false;
}
async function runGenerateReleaseNotes() {
  releaseNotesCopied.value = false;
  try {
    releaseNotesMarkdown.value = await generateReleaseNotes(
      props.cwd,
      releaseNotesFrom.value,
      releaseNotesTo.value,
      { locale: locale.value },
    );
  } catch {
    releaseNotesMarkdown.value = "";
  }
}
async function copyReleaseNotes() {
  if (!releaseNotesMarkdown.value) return;
  try {
    await navigator.clipboard.writeText(releaseNotesMarkdown.value);
    releaseNotesCopied.value = true;
    setTimeout(() => { releaseNotesCopied.value = false; }, 1500);
  } catch { /* clipboard perms may be denied */ }
}

// ─── State ──────────────────────────────────────────────
const tags = ref<GitTag[]>([]);
const unpushedTagNames = ref<string[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const remoteName = ref("origin");
const busyTag = ref<string | null>(null);   // name of tag currently being acted on
const busyPushAll = ref(false);
const retagDialog = ref<{
  name: string;
  isAnnotated: boolean;
  ref: string;
  message: string;
  forcePush: boolean;
} | null>(null);

// ─── Load ────────────────────────────────────────────────
async function load() {
  loading.value = true;
  error.value = null;
  try {
    const [tagList, remoteInfo] = await Promise.all([
      gitListTags(props.cwd),
      gitRemoteInfo(props.cwd).catch(() => null),
    ]);
    tags.value = tagList;
    if (remoteInfo?.name) remoteName.value = remoteInfo.name;

    // Load unpushed tags (v2.16)
    if (remoteName.value) {
      unpushedTagNames.value = await gitUnpushedTags(props.cwd, remoteName.value).catch(() => []);
    }
  } catch (err: any) {
    error.value = err?.message ?? String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

// ─── Computed ────────────────────────────────────────────
const hasRemote = computed(() => !!remoteName.value);
const hasUnpushed = computed(() => unpushedTagNames.value.length > 0);

function relativeDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diffDays < 1) return t("date.now");
  if (diffDays < 7) return t("date.daysAgo", diffDays);
  if (diffDays < 30) return t("date.weeksAgo", Math.floor(diffDays / 7));
  if (diffDays < 365) return t("date.monthsAgo", Math.floor(diffDays / 30));
  return t("date.yearsAgo", Math.floor(diffDays / 365));
}

// ─── Actions ─────────────────────────────────────────────
async function askDelete(name: string) {
  // Direct deletion as requested (v2.16)
  // No modal. Always both local & remote (best effort).
  busyTag.value = name;
  error.value = null;
  try {
    // 1. Determine remote
    let rName = remoteName.value || "origin";
    try {
      const info = await gitRemoteInfo(props.cwd);
      if (info.name) rName = info.name;
    } catch { /* ignore */ }

    // 2. Local delete (best effort)
    await gitDeleteTag(props.cwd, name).catch(() => {});

    // 3. Remote delete (best effort)
    await gitDeleteRemoteTag(props.cwd, rName, name).catch(() => {});

    // 4. Reload local UI + tell host to refresh
    await load();
    emit("refresh");
  } catch (err: any) {
    error.value = err?.message ?? String(err);
  } finally {
    busyTag.value = null;
  }
}

async function pushTag(name: string) {
  if (!hasRemote.value) return;
  busyTag.value = name;
  error.value = null;
  try {
    await gitPushTags(props.cwd, remoteName.value, "single", name);
    // Refresh unpushed list (v2.16)
    unpushedTagNames.value = await gitUnpushedTags(props.cwd, remoteName.value).catch(() => []);
    emit("refresh");
  } catch (err: any) {
    error.value = err?.message ?? String(err);
  } finally {
    busyTag.value = null;
  }
}

function openRetagDialog(tag: GitTag) {
  retagDialog.value = {
    name: tag.name,
    isAnnotated: tag.isAnnotated,
    ref: "HEAD",
    message: tag.message ?? "",
    forcePush: hasRemote.value,
  };
}

async function confirmRetag() {
  if (!retagDialog.value) return;
  const { name, isAnnotated, ref, message, forcePush } = retagDialog.value;
  busyTag.value = name;
  error.value = null;
  try {
    await gitRetagTo(props.cwd, name, ref.trim() || "HEAD", isAnnotated ? message : undefined);
    if (forcePush && hasRemote.value) {
      await gitForcePushTag(props.cwd, remoteName.value, name);
    }
    retagDialog.value = null;
    await load();
    emit("refresh");
  } catch (err: any) {
    error.value = err?.message ?? String(err);
  } finally {
    busyTag.value = null;
  }
}

async function pushAllTags() {
  if (!hasRemote.value) return;
  busyPushAll.value = true;
  error.value = null;
  try {
    await gitPushTags(props.cwd, remoteName.value, "all");
    // Refresh unpushed list (v2.16)
    unpushedTagNames.value = await gitUnpushedTags(props.cwd, remoteName.value).catch(() => []);
    emit("refresh");
  } catch (err: any) {
    error.value = err?.message ?? String(err);
  } finally {
    busyPushAll.value = false;
  }
}
</script>

<template>
  <BaseModal
    :title="t('tags.title')"
    :subtitle="t('tags.subtitle', tags.length)"
    size="md"
    @close="emit('close')"
  >
    <!-- Toolbar -->
    <template #toolbar>
      <div class="tp-toolbar">
        <button class="bm-btn bm-btn--ghost tp-btn-sm" @click="emit('create-tag')">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
          </svg>
          {{ t('tags.newTag') }}
        </button>
        <button
          v-if="hasRemote && hasUnpushed"
          class="bm-btn bm-btn--ghost tp-btn-sm"
          :disabled="busyPushAll || tags.length === 0"
          @click="pushAllTags"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 11V3M5 6l3-3 3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M2 13h12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
          </svg>
          {{ busyPushAll ? t('common.loading') : t('tags.pushAll', remoteName) }}
        </button>
        <button
          v-if="ai.isAvailable.value"
          class="bm-btn bm-btn--ghost tp-btn-sm"
          :title="t('dashboard.releaseNotesHint')"
          @click="openReleaseNotes"
        >
          <AiSparkle :size="12" />
          {{ t('dashboard.releaseNotes') }}
        </button>
      </div>
    </template>

    <!-- Error banner -->
    <p v-if="error" class="tp-error">{{ error }}</p>

    <!-- Loading -->
    <div v-if="loading" class="tp-empty">
      <div class="tp-spinner"></div>
      <span>{{ t('common.loading') }}</span>
    </div>

    <!-- Empty state -->
    <div v-else-if="tags.length === 0" class="tp-empty">
      <svg width="32" height="32" viewBox="0 0 16 16" fill="none" aria-hidden="true" class="tp-empty-icon">
        <path d="M2 2h6l6 6-6 6-6-6V2z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
        <circle cx="5.5" cy="5.5" r="1" fill="currentColor"/>
      </svg>
      <p class="tp-empty-text">{{ t('tags.empty') }}</p>
      <button class="bm-btn bm-btn--primary" @click="emit('create-tag')">{{ t('tags.newTag') }}</button>
    </div>

    <!-- Tag list -->
    <ul v-else class="tp-list">
      <li v-for="tag in tags" :key="tag.name" class="tp-item">
        <div class="tp-item-main">
          <div class="tp-item-top">
            <span class="tp-name">{{ tag.name }}</span>
            <span class="tp-badge" :class="tag.isAnnotated ? 'tp-badge--annotated' : 'tp-badge--light'">
              {{ tag.isAnnotated ? t('tags.annotated') : t('tags.lightweight') }}
            </span>
          </div>
          <div class="tp-item-meta">
            <span class="tp-hash mono">{{ tag.hash }}</span>
            <span class="tp-sep">·</span>
            <span class="tp-date">{{ relativeDate(tag.date) }}</span>
            <template v-if="tag.message">
              <span class="tp-sep">·</span>
              <span class="tp-message">{{ tag.message }}</span>
            </template>
          </div>
        </div>
        <div class="tp-item-actions">
          <!-- Retag: move tag to a different ref -->
          <button
            class="tp-action-btn"
            :disabled="busyTag === tag.name"
            v-tooltip="t('tags.retagTitle')"
            @click="openRetagDialog(tag)"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2 8h9M8 5l3 3-3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
              <circle cx="13" cy="8" r="1.5" fill="currentColor" stroke="none"/>
            </svg>
          </button>
          <button
            v-if="hasRemote && unpushedTagNames.includes(tag.name)"
            class="tp-action-btn"
            :disabled="busyTag === tag.name"
            v-tooltip="t('tags.pushTag', remoteName)"
            @click="pushTag(tag.name)"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 11V3M5 6l3-3 3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M2 13h12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
            </svg>
          </button>
          <button
            class="tp-action-btn tp-action-btn--danger"
            :disabled="busyTag === tag.name"
            v-tooltip="t('tags.deleteTag')"
            @click="askDelete(tag.name)"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2 4h12M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1M3 4v9a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
      </li>
    </ul>

    <!-- Retag dialog -->
    <BaseModal
      v-if="retagDialog"
      :title="t('tags.retagTitle')"
      :subtitle="retagDialog.name"
      size="sm"
      @close="retagDialog = null"
    >
      <div class="tp-form">
        <label class="tp-form-label">{{ t('tags.retagRefLabel') }}</label>
        <input
          v-model="retagDialog.ref"
          class="tp-form-input"
          placeholder="HEAD"
          autofocus
          @keydown.enter="confirmRetag"
          @keydown.escape="retagDialog = null"
        />
        <p class="tp-form-hint">{{ t('tags.retagRefHint') }}</p>

        <template v-if="retagDialog.isAnnotated">
          <label class="tp-form-label">{{ t('tags.retagMessageLabel') }}</label>
          <textarea
            v-model="retagDialog.message"
            class="tp-form-textarea"
            rows="3"
          />
        </template>

        <label v-if="hasRemote" class="tp-check-label tp-check-label--warn">
          <input type="checkbox" v-model="retagDialog.forcePush" />
          <span>{{ t('tags.retagForcePush', remoteName) }}</span>
        </label>
      </div>
      <template #footer>
        <button class="bm-btn bm-btn--ghost" @click="retagDialog = null">{{ t('common.cancel') }}</button>
        <button
          class="bm-btn bm-btn--primary"
          :disabled="busyTag === retagDialog.name"
          @click="confirmRetag"
        >
          {{ busyTag === retagDialog.name ? t('common.loading') : t('tags.retagConfirm') }}
        </button>
      </template>
    </BaseModal>

    <!-- Release notes generator (relocated from the Dashboard, v3) -->
    <BaseModal
      v-if="releaseNotesOpen"
      :title="t('dashboard.releaseNotesTitle')"
      size="lg"
      @close="closeReleaseNotes"
    >
      <p class="tp-rn-desc">{{ t('dashboard.releaseNotesDesc') }}</p>
      <div class="tp-rn-refs">
        <label class="tp-rn-field">
          <span>{{ t('dashboard.releaseNotesFrom') }}</span>
          <input v-model="releaseNotesFrom" type="text" class="tp-form-input mono" :placeholder="t('dashboard.releaseNotesFromPlaceholder')" />
        </label>
        <span class="tp-rn-sep">..</span>
        <label class="tp-rn-field">
          <span>{{ t('dashboard.releaseNotesTo') }}</span>
          <input v-model="releaseNotesTo" type="text" class="tp-form-input mono" placeholder="HEAD" />
        </label>
        <button
          class="bm-btn bm-btn--primary tp-btn-sm"
          :disabled="isGeneratingReleaseNotes || !releaseNotesFrom.trim() || !releaseNotesTo.trim()"
          @click="runGenerateReleaseNotes"
        >
          {{ isGeneratingReleaseNotes ? '…' : t('dashboard.releaseNotesGenerate') }}
        </button>
      </div>
      <p v-if="releaseNotesError" class="tp-error">{{ releaseNotesError }}</p>
      <textarea
        v-model="releaseNotesMarkdown"
        class="tp-form-textarea mono"
        rows="14"
        spellcheck="false"
        :placeholder="t('dashboard.releaseNotesPlaceholder')"
      />
      <template #footer>
        <button class="bm-btn bm-btn--ghost" :disabled="!releaseNotesMarkdown" @click="copyReleaseNotes">
          {{ releaseNotesCopied ? t('dashboard.releaseNotesCopied') : t('dashboard.releaseNotesCopy') }}
        </button>
        <button class="bm-btn bm-btn--primary" @click="closeReleaseNotes">{{ t('common.close') }}</button>
      </template>
    </BaseModal>
  </BaseModal>
</template>

<style scoped>
/* ─── Toolbar ───────────────────────────────────────────── */
.tp-toolbar {
  display: flex;
  gap: var(--space-2);
}

/* Standardise les boutons d'action de la barre d'outils sur la
   hauteur 32 px utilisée ailleurs dans l'app (cf. StashManager
   `.sm-btn-sm`). La base `.bm-btn` (padding vertical var(--space-3))
   reste destinée aux footers de modales, plus compacts. */
.tp-btn-sm {
  height: 32px;
  padding: var(--space-2) var(--space-4);
  font-size: var(--font-size-sm);
  line-height: 1;
}


/* ─── Release notes ─────────────────────────────────────── */
.tp-rn-desc { color: var(--color-text-muted); font-size: var(--font-size-sm); margin: 0 0 var(--space-4); }
.tp-rn-refs {
  display: flex;
  align-items: flex-end;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}
.tp-rn-field { display: flex; flex-direction: column; gap: var(--space-1); font-size: var(--font-size-xs); color: var(--color-text-muted); }
.tp-rn-field .tp-form-input { min-width: 140px; }
.tp-rn-sep { padding-bottom: var(--space-3); color: var(--color-text-muted); }

/* ─── List ──────────────────────────────────────────────── */
.tp-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.tp-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-1);
  border-radius: var(--radius-sm);
  transition: background var(--transition-fast);
}

.tp-item:hover {
  background: var(--color-bg-tertiary);
}

.tp-item-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.tp-item-top {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.tp-name {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--color-text);
}

.tp-badge {
  font-size: 10px;
  font-weight: var(--font-weight-bold);
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  flex-shrink: 0;
}

.tp-badge--annotated {
  background: var(--color-accent-soft, rgba(124, 58, 237, 0.12));
  color: var(--color-accent);
}

.tp-badge--light {
  background: var(--color-bg-tertiary);
  color: var(--color-text-muted);
}

.tp-item-meta {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.tp-hash {
  color: var(--color-accent);
}

.tp-sep {
  opacity: 0.4;
}

.tp-message {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 200px;
}

/* ─── Actions ───────────────────────────────────────────── */
.tp-item-actions {
  display: flex;
  gap: var(--space-1);
  opacity: 0;
  transition: opacity var(--transition-fast);
}

.tp-item:hover .tp-item-actions {
  opacity: 1;
}

.tp-action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  border: none;
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.tp-action-btn:hover:not(:disabled) {
  background: var(--color-bg);
  color: var(--color-text);
}

.tp-action-btn--danger:hover:not(:disabled) {
  color: var(--color-danger, #ef4444);
}

.tp-action-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ─── Empty / loading ───────────────────────────────────── */
.tp-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  padding: var(--space-10) 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}

.tp-empty-icon {
  opacity: 0.35;
}

.tp-empty-text {
  margin: 0;
}

.tp-spinner {
  width: 20px;
  height: 20px;
  border: 2px solid var(--color-border);
  border-top-color: var(--color-accent);
  border-radius: 50%;
  animation: tp-spin 0.7s linear infinite;
}

@keyframes tp-spin {
  to { transform: rotate(360deg); }
}

/* ─── Error ─────────────────────────────────────────────── */
.tp-error {
  margin: 0 0 var(--space-3);
  padding: var(--space-2) var(--space-3);
  font-size: var(--font-size-sm);
  color: var(--color-danger, #ef4444);
  background: var(--color-danger-soft, rgba(239, 68, 68, 0.06));
  border-radius: var(--radius-sm);
  border-left: 3px solid var(--color-danger, #ef4444);
}

/* ─── Retag / Delete forms ──────────────────────────────── */
.tp-check-label {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.tp-check-label--warn {
  color: var(--color-warning, #f59e0b);
  margin-top: var(--space-3);
}

.tp-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.tp-form-label {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--color-text);
  margin-top: var(--space-2);
}

.tp-form-input,
.tp-form-textarea {
  width: 100%;
  padding: var(--space-3) var(--space-4);
  font-size: var(--font-size-sm);
  font-family: inherit;
  background: var(--color-bg);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  outline: none;
  box-sizing: border-box;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
  resize: vertical;
}

.tp-form-input:focus,
.tp-form-textarea:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-soft);
}

.tp-form-hint {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  margin: 0;
}
</style>
