<script setup lang="ts">
/**
 * CloneModal — `git clone <url> <dest>` flow with a single form view.
 *
 * Layout:
 *   URL              [.................................]
 *   Parent folder    [...........................] [Browse]
 *   Will clone into: <parent>/<repo-name>
 *
 * The destination is the full path `<parent>/<repoName>` where `repoName`
 * is derived from the URL (last segment, `.git` stripped). Lets us keep
 * the form short while still being explicit about where files will land.
 *
 * v2.11: real-time progress bar via `clone-progress` Tauri events emitted
 * by the Rust backend as it reads git's stderr line by line.
 */
import { computed, onMounted, onUnmounted, nextTick, ref } from "vue";
import { useI18n } from "../composables/useI18n";
import { gitClone, pickFolder } from "../utils/backend";
import { requireOnline } from "../utils/networkGuard";
import BaseModal from "./BaseModal.vue";

const emit = defineEmits<{
  close: [];
  cloned: [path: string];
}>();

const { t } = useI18n();

const url = ref("");
const parentDir = ref("");
const isCloning = ref(false);
const error = ref<string | null>(null);
const urlInputEl = ref<HTMLInputElement | null>(null);

// ─── Clone progress (v2.11) ──────────────────────────────────
interface CloneProgressEvent {
  stage:   string;   // "init" | "counting" | "compressing" | "receiving" | "resolving" | "done"
  percent: number;
  message: string;
}

const cloneStage   = ref<string>("");
const clonePercent = ref<number>(0);
const cloneMessage = ref<string>("");

// Stage → human-readable label
function stageLabel(stage: string): string {
  switch (stage) {
    case "init":        return "Initialising…";
    case "counting":    return "Counting objects…";
    case "compressing": return "Compressing…";
    case "receiving":   return "Receiving objects…";
    case "resolving":   return "Resolving deltas…";
    case "done":        return "Complete";
    default:            return stage;
  }
}

// Weighted progress across the 4 main stages so the bar moves smoothly:
//   counting:     0 – 15%
//   compressing:  15 – 25%
//   receiving:    25 – 90%
//   resolving:    90 – 100%
const barPercent = computed<number>(() => {
  const p = clonePercent.value / 100;
  switch (cloneStage.value) {
    case "init":        return 2;
    case "counting":    return 2  + p * 13;
    case "compressing": return 15 + p * 10;
    case "receiving":   return 25 + p * 65;
    case "resolving":   return 90 + p * 10;
    case "done":        return 100;
    default:            return clonePercent.value;
  }
});

let _unlisten: (() => void) | null = null;

async function startProgressListener() {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    _unlisten = await listen<CloneProgressEvent>("clone-progress", (ev) => {
      const { stage, percent, message } = ev.payload;
      cloneStage.value   = stage;
      clonePercent.value = percent;
      cloneMessage.value = message;
    });
  } catch {
    // Browser dev mode — no Tauri events available, progress bar hidden
  }
}

function stopProgressListener() {
  _unlisten?.();
  _unlisten = null;
}

onUnmounted(() => stopProgressListener());

/**
 * Derive the bare repo name from the URL — last segment, `.git` stripped.
 * Mirrors the Rust `repo_name_from_url` helper so the displayed destination
 * matches what the backend would produce.
 */
const repoName = computed(() => {
  const trimmed = url.value.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  if (!trimmed) return "";
  const parts = trimmed.split(/[/:]/);
  return parts[parts.length - 1] ?? "";
});

const destination = computed(() => {
  if (!parentDir.value || !repoName.value) return "";
  return `${parentDir.value.replace(/\/+$/, "")}/${repoName.value}`;
});

const canClone = computed(
  () => !isCloning.value && url.value.trim().length > 0 && parentDir.value.length > 0 && repoName.value.length > 0,
);

async function browseForParent() {
  const path = await pickFolder();
  if (path) parentDir.value = path;
}

async function onClone() {
  if (!canClone.value) return;
  if (!(await requireOnline("clone"))) {
    error.value = t("connectivity.offline.disabledOp");
    return;
  }
  error.value = null;
  isCloning.value = true;
  cloneStage.value   = "init";
  clonePercent.value = 0;
  cloneMessage.value = "";

  await startProgressListener();
  try {
    const finalPath = await gitClone(url.value.trim(), destination.value);
    emit("cloned", finalPath);
    emit("close");
  } catch (err: unknown) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    stopProgressListener();
    isCloning.value = false;
  }
}

function onCancel() {
  if (isCloning.value) return; // Avoid closing mid-clone (the process keeps running)
  emit("close");
}

onMounted(() => {
  nextTick(() => urlInputEl.value?.focus());
});
</script>

<template>
  <BaseModal size="md" :title="t('clone.title')" @close="onCancel">
    <template #title-icon>
      <span class="cm-icon" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <path
            d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </span>
    </template>

    <form class="cm-form" @submit.prevent="onClone">
      <div class="cm-field">
        <label class="cm-label" for="cm-url">{{ t("clone.urlLabel") }}</label>
        <input
          id="cm-url"
          ref="urlInputEl"
          v-model="url"
          type="text"
          class="cm-input mono"
          :placeholder="t('clone.urlPlaceholder')"
          autocomplete="off"
          spellcheck="false"
          :disabled="isCloning"
        />
      </div>

      <div class="cm-field">
        <label class="cm-label" for="cm-parent">{{ t("clone.parentLabel") }}</label>
        <div class="cm-parent-row">
          <input
            id="cm-parent"
            v-model="parentDir"
            type="text"
            class="cm-input mono"
            :placeholder="t('clone.parentPlaceholder')"
            autocomplete="off"
            spellcheck="false"
            :disabled="isCloning"
          />
          <button
            type="button"
            class="cm-browse"
            :disabled="isCloning"
            @click="browseForParent"
          >
            {{ t("clone.browse") }}
          </button>
        </div>
      </div>

      <p v-if="destination" class="cm-dest">
        {{ t("clone.willCloneInto") }}
        <span class="mono cm-dest-path">{{ destination }}</span>
      </p>

      <!-- Real-time clone progress bar (v2.11) -->
      <div v-if="isCloning" class="cm-progress" aria-live="polite">
        <div class="cm-progress-header">
          <span class="cm-progress-stage">{{ stageLabel(cloneStage) }}</span>
          <span class="cm-progress-pct muted">{{ Math.round(barPercent) }}%</span>
        </div>
        <div class="cm-progress-track" role="progressbar" :aria-valuenow="Math.round(barPercent)" aria-valuemin="0" aria-valuemax="100">
          <div class="cm-progress-fill" :style="{ width: barPercent + '%' }"></div>
        </div>
        <p v-if="cloneMessage" class="cm-progress-msg muted mono">{{ cloneMessage }}</p>
      </div>

      <p v-if="error" class="cm-error" role="alert">{{ error }}</p>

      <button type="submit" hidden></button>
    </form>

    <template #footer>
      <button
        type="button"
        class="bm-btn bm-btn--ghost"
        :disabled="isCloning"
        @click="onCancel"
      >
        {{ t("common.cancel") }}
      </button>
      <button
        type="button"
        class="bm-btn bm-btn--primary"
        :disabled="!canClone"
        @click="onClone"
      >
        <span v-if="isCloning" class="cm-spinner" aria-hidden="true"></span>
        {{ isCloning ? t("clone.cloning") : t("clone.cloneButton") }}
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.cm-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-pill);
  background: var(--color-accent-soft);
  color: var(--color-accent);
  flex-shrink: 0;
}

.cm-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.cm-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.cm-label {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  line-height: var(--line-height-snug);
}

.cm-input {
  width: 100%;
  padding: var(--space-3) var(--space-5);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  color: var(--color-text);
  font-size: var(--font-size-md);
  outline: none;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}

.cm-input:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-accent-soft);
}

.cm-input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.cm-parent-row {
  display: flex;
  gap: var(--space-3);
}

.cm-parent-row .cm-input {
  flex: 1;
  min-width: 0;
}

.cm-browse {
  padding: var(--space-3) var(--space-5);
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  color: var(--color-text);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: background var(--transition-fast);
  white-space: nowrap;
}

.cm-browse:hover:not(:disabled) {
  background: var(--color-bg-secondary);
}

.cm-browse:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.cm-dest {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  margin: 0;
  line-height: var(--line-height-snug);
}

.cm-dest-path {
  color: var(--color-text);
  word-break: break-all;
}

.cm-error {
  margin: 0;
  padding: var(--space-3) var(--space-4);
  background: var(--color-danger-soft, rgba(220, 38, 38, 0.08));
  border: 1px solid var(--color-danger, #dc2626);
  border-radius: var(--radius-md);
  color: var(--color-danger, #dc2626);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-snug);
  white-space: pre-wrap;
}

.cm-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  margin-right: var(--space-2);
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: cm-spin 0.7s linear infinite;
  vertical-align: -1px;
}

@keyframes cm-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .cm-spinner {
    animation: none;
  }
}

/* ─── Clone progress bar (v2.11) ────────────────────────────── */
.cm-progress {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.cm-progress-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: var(--font-size-sm);
}

.cm-progress-stage {
  font-weight: 500;
  color: var(--color-text);
}

.cm-progress-pct {
  font-size: var(--font-size-xs, 11px);
}

.cm-progress-track {
  height: 6px;
  background: var(--color-bg-tertiary);
  border-radius: 3px;
  overflow: hidden;
}

.cm-progress-fill {
  height: 100%;
  background: var(--color-accent);
  border-radius: 3px;
  transition: width 0.3s ease;
  min-width: 4px;
}

.cm-progress-msg {
  margin: 0;
  font-size: 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
</style>
