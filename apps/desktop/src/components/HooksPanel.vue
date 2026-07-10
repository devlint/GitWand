<script setup lang="ts">
import { ref, onMounted, computed, inject } from "vue";
import {
  gitHookList,
  gitHookToggle,
  gitHookCreate,
  gitHookDelete,
  readFile,
  type HookEntry,
} from "../utils/backend";
import { useI18n } from "../composables/useI18n";
import type { LocaleKey } from "../locales/en";
import BaseModal from "./BaseModal.vue";
import { buildSecretsHookScript, isSecretsHookScript } from "../utils/secretsHook";

const props = defineProps<{
  cwd: string;
}>();

const { t } = useI18n();
const askConfirm = inject<(options: { title: string; message: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean }) => Promise<boolean>>("askConfirm");

// ─── State ───────────────────────────────────────────────

const hooks = ref<HookEntry[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

// v3.5.0 — Secrets pre-commit hook installer. The hook script on disk (detected via its marker
// comment) IS the install state — no separate persisted flag.
const secretsHookInstalled = ref(false);
const secretsHookBusy = ref(false);

// New hook form
const showForm = ref(false);
const formName = ref("pre-commit");
const formContent = ref("");
const creating = ref(false);

// Delete confirmation
const confirmDeleteName = ref<string | null>(null);
const deleting = ref(false);

// ─── Hook event descriptions ──────────────────────────────

const HOOK_DESCRIPTIONS: Record<string, string> = {
  "pre-commit": "descPreCommit",
  "commit-msg": "descCommitMsg",
  "prepare-commit-msg": "descPrepareCommitMsg",
  "post-commit": "descPostCommit",
  "pre-push": "descPrePush",
  "pre-rebase": "descPreRebase",
  "post-checkout": "descPostCheckout",
  "post-merge": "descPostMerge",
};

const STANDARD_HOOKS = [
  "pre-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-push",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "pre-receive",
  "update",
  "post-receive",
  "post-update",
  "post-rewrite",
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-auto-gc",
  "sendemail-validate",
];

function hookDesc(name: string): string {
  const key = HOOK_DESCRIPTIONS[name];
  return key ? t(`hooks.${key}` as LocaleKey) : t("hooks.descOther");
}

// ─── Actions ─────────────────────────────────────────────

async function loadHooks() {
  loading.value = true;
  error.value = null;
  try {
    hooks.value = await gitHookList(props.cwd);
  } catch (err: any) {
    error.value = t("hooks.errorList").replace("{0}", String(err?.message ?? err));
  } finally {
    loading.value = false;
  }
}

async function toggleHook(hook: HookEntry) {
  const next = !hook.enabled;
  try {
    await gitHookToggle(props.cwd, hook.name, next);
    hook.enabled = next;
  } catch (err: any) {
    error.value = t("hooks.errorToggle").replace("{0}", String(err?.message ?? err));
  }
}

async function createHook() {
  if (!formName.value.trim() || !formContent.value.trim()) return;
  creating.value = true;
  error.value = null;
  try {
    await gitHookCreate(props.cwd, formName.value.trim(), formContent.value.trim());
    showForm.value = false;
    formContent.value = "";
    await loadHooks();
  } catch (err: any) {
    error.value = t("hooks.errorCreate").replace("{0}", String(err?.message ?? err));
  } finally {
    creating.value = false;
  }
}

async function deleteHook() {
  if (!confirmDeleteName.value) return;
  deleting.value = true;
  try {
    await gitHookDelete(props.cwd, confirmDeleteName.value);
    confirmDeleteName.value = null;
    await loadHooks();
  } catch (err: any) {
    error.value = t("hooks.errorDelete").replace("{0}", String(err?.message ?? err));
  } finally {
    deleting.value = false;
  }
}

async function checkSecretsHook() {
  try {
    const content = await readFile(props.cwd, ".git/hooks/pre-commit");
    secretsHookInstalled.value = isSecretsHookScript(content);
  } catch {
    // No pre-commit hook on disk (or unreadable) — treat as "not installed".
    secretsHookInstalled.value = false;
  }
}

async function installSecretsHook() {
  if (askConfirm) {
    const confirmed = await askConfirm({
      title: t("hooks.secretsInstallConfirmTitle"),
      message: t("hooks.secretsInstallConfirmMessage"),
      confirmLabel: t("hooks.secretsInstall"),
    });
    if (!confirmed) return;
  }
  secretsHookBusy.value = true;
  error.value = null;
  try {
    await gitHookCreate(props.cwd, "pre-commit", buildSecretsHookScript());
    await loadHooks();
    await checkSecretsHook();
  } catch (err: any) {
    error.value = t("hooks.errorSecretsInstall").replace("{0}", String(err?.message ?? err));
  } finally {
    secretsHookBusy.value = false;
  }
}

async function removeSecretsHook() {
  if (askConfirm) {
    const confirmed = await askConfirm({
      title: t("hooks.secretsRemoveConfirmTitle"),
      message: t("hooks.secretsRemoveConfirmMessage"),
      confirmLabel: t("hooks.secretsRemove"),
      danger: true,
    });
    if (!confirmed) return;
  }
  secretsHookBusy.value = true;
  error.value = null;
  try {
    await gitHookDelete(props.cwd, "pre-commit");
    await loadHooks();
    await checkSecretsHook();
  } catch (err: any) {
    error.value = t("hooks.errorSecretsRemove").replace("{0}", String(err?.message ?? err));
  } finally {
    secretsHookBusy.value = false;
  }
}

onMounted(() => {
  loadHooks();
  checkSecretsHook();
});
</script>

<template>
  <div class="hooks-panel">
    <!-- Header -->
    <div class="hp-header">
      <span class="hp-title">{{ t("hooks.title") }}</span>
      <div class="hp-actions">
        <button class="bm-btn bm-btn--ghost hp-btn-sm" @click="loadHooks" :disabled="loading">
          {{ t("hooks.reload") }}
        </button>
        <button class="bm-btn bm-btn--primary hp-btn-sm" @click="showForm = true">
          + {{ t("hooks.newHook") }}
        </button>
      </div>
    </div>

    <!-- Error -->
    <div v-if="error" class="hp-error">{{ error }}</div>

    <!-- Secrets pre-commit hook (v3.5.0) — dedicated section, distinct from the generic hook creator -->
    <div class="hp-secrets">
      <div class="hp-secrets-info">
        <span class="hp-secrets-title">{{ t("hooks.secretsTitle") }}</span>
        <span class="hp-secrets-desc">{{ t("hooks.secretsDescription") }}</span>
      </div>
      <div class="hp-secrets-actions">
        <span class="hp-badge" :class="secretsHookInstalled ? 'hp-badge--on' : 'hp-badge--off'">
          {{ secretsHookInstalled ? t("hooks.secretsInstalled") : t("hooks.secretsNotInstalled") }}
        </span>
        <button
          v-if="!secretsHookInstalled"
          class="bm-btn bm-btn--primary hp-btn-sm"
          :disabled="secretsHookBusy"
          @click="installSecretsHook"
        >
          {{ t("hooks.secretsInstall") }}
        </button>
        <button
          v-else
          class="bm-btn bm-btn--ghost hp-btn-sm hp-secrets-remove"
          :disabled="secretsHookBusy"
          @click="removeSecretsHook"
        >
          {{ t("hooks.secretsRemove") }}
        </button>
      </div>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="hp-loading">{{ t("common.loading") }}</div>

    <!-- Empty -->
    <div v-else-if="!loading && hooks.length === 0" class="hp-empty">
      {{ t("hooks.empty") }}
    </div>

    <!-- Hook list -->
    <ul v-else class="hp-list">
      <li v-for="hook in hooks" :key="hook.name" class="hp-item">
        <div class="hp-item-left">
          <!-- Toggle -->
          <button
            class="hp-toggle"
            :class="{ 'hp-toggle--on': hook.enabled }"
            @click="toggleHook(hook)"
            :title="hook.enabled ? t('hooks.enabled') : t('hooks.disabled')"
          >
            <span class="hp-toggle-thumb" />
          </button>

          <div class="hp-item-info">
            <span class="hp-item-name">{{ hook.name }}</span>
            <span class="hp-item-desc">{{ hookDesc(hook.name) }}</span>
            <span v-if="hook.preview" class="hp-item-preview">{{ hook.preview }}</span>
            <span v-if="!hook.executable && hook.enabled" class="hp-item-warning">
              {{ t("hooks.notExecutable") }}
            </span>
          </div>
        </div>

        <div class="hp-item-right">
          <span class="hp-badge" :class="hook.enabled ? 'hp-badge--on' : 'hp-badge--off'">
            {{ hook.enabled ? t("hooks.enabled") : t("hooks.disabled") }}
          </span>
          <button
            class="bm-btn bm-btn--ghost hp-btn-sm hp-btn-delete"
            @click="confirmDeleteName = hook.name"
          >
            {{ t("hooks.deleteHook") }}
          </button>
        </div>
      </li>
    </ul>

    <!-- New hook modal -->
    <BaseModal v-if="showForm" :title="t('hooks.newHook')" @close="showForm = false">
      <div class="hp-form">
        <label class="hp-form-label">{{ t("hooks.nameLabel") }}</label>
        <select v-model="formName" class="hp-select">
          <option v-for="name in STANDARD_HOOKS" :key="name" :value="name">{{ name }}</option>
        </select>

        <label class="hp-form-label" style="margin-top: 12px;">{{ t("hooks.contentLabel") }}</label>
        <textarea
          v-model="formContent"
          class="hp-textarea"
          :placeholder="t('hooks.contentPlaceholder')"
          rows="8"
          spellcheck="false"
        />
      </div>

      <template #footer>
        <button class="bm-btn bm-btn--ghost" @click="showForm = false">{{ t("common.cancel") }}</button>
        <button
          class="bm-btn bm-btn--primary"
          :disabled="creating || !formName || !formContent.trim()"
          @click="createHook"
        >
          {{ creating ? t("hooks.creating") : t("hooks.create") }}
        </button>
      </template>
    </BaseModal>

    <!-- Delete confirmation modal -->
    <BaseModal
      v-if="confirmDeleteName"
      :title="t('hooks.deleteHook')"
      variant="danger"
      @close="confirmDeleteName = null"
    >
      <p>{{ t("hooks.deleteConfirm").replace("{0}", confirmDeleteName!) }}</p>
      <template #footer>
        <button class="bm-btn bm-btn--ghost" @click="confirmDeleteName = null">{{ t("common.cancel") }}</button>
        <button class="bm-btn bm-btn--danger" :disabled="deleting" @click="deleteHook">
          {{ t("common.delete") }}
        </button>
      </template>
    </BaseModal>
  </div>
</template>

<style scoped>
.hooks-panel {
  padding: 16px;
}

.hp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.hp-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-primary);
}

.hp-actions {
  display: flex;
  gap: 8px;
}

.hp-btn-sm {
  padding: 4px 10px;
  font-size: 12px;
}

.hp-btn-delete {
  opacity: 0;
  transition: opacity 0.15s;
  color: var(--color-danger, #e53e3e);
}

.hp-item:hover .hp-btn-delete {
  opacity: 1;
}

.hp-error {
  padding: 8px 12px;
  background: var(--color-danger-soft, rgba(229, 62, 62, 0.1));
  color: var(--color-danger, #e53e3e);
  border-radius: 6px;
  font-size: 12px;
  margin-bottom: 12px;
}

/* Secrets pre-commit hook — dedicated section (v3.5.0) */
.hp-secrets {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px;
  border-radius: 8px;
  background: var(--color-warning-soft, rgba(217, 119, 6, 0.1));
  border: 1px solid var(--color-warning, #d97706);
  margin-bottom: 12px;
}

.hp-secrets-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.hp-secrets-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-primary);
}

.hp-secrets-desc {
  font-size: 11px;
  color: var(--color-text-muted);
}

.hp-secrets-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.hp-secrets-remove {
  color: var(--color-danger, #e53e3e);
}

.hp-loading,
.hp-empty {
  font-size: 12px;
  color: var(--color-text-muted);
  padding: 24px 0;
  text-align: center;
}

.hp-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.hp-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--color-surface-alt, rgba(255, 255, 255, 0.04));
  border: 1px solid var(--color-border);
  transition: background 0.12s;
}

.hp-item:hover {
  background: var(--color-accent-soft, rgba(99, 102, 241, 0.08));
}

.hp-item-left {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.hp-item-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.hp-item-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.hp-item-name {
  font-size: 12px;
  font-weight: 600;
  font-family: var(--font-mono, monospace);
  color: var(--color-text-primary);
}

.hp-item-desc {
  font-size: 11px;
  color: var(--color-text-muted);
}

.hp-item-preview {
  font-size: 11px;
  font-family: var(--font-mono, monospace);
  color: var(--color-text-secondary);
  opacity: 0.7;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 320px;
}

.hp-item-warning {
  font-size: 11px;
  color: var(--color-warning, #d69e2e);
}

/* Toggle switch */
.hp-toggle {
  display: flex;
  align-items: center;
  width: 32px;
  height: 18px;
  border-radius: 9px;
  background: var(--color-border);
  border: none;
  cursor: pointer;
  padding: 2px;
  flex-shrink: 0;
  margin-top: 1px;
  transition: background 0.2s;
}

.hp-toggle--on {
  background: var(--color-accent, #6366f1);
}

.hp-toggle-thumb {
  display: block;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: white;
  transition: transform 0.2s;
}

.hp-toggle--on .hp-toggle-thumb {
  transform: translateX(14px);
}

/* Badge */
.hp-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.hp-badge--on {
  background: rgba(72, 187, 120, 0.15);
  color: #48bb78;
}

.hp-badge--off {
  background: var(--color-surface-alt, rgba(255, 255, 255, 0.06));
  color: var(--color-text-muted);
}

/* Form */
.hp-form {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px 0;
}

.hp-form-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text-secondary);
}

.hp-select {
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  color: var(--color-text-primary);
  font-size: 12px;
  font-family: var(--font-mono, monospace);
}

.hp-textarea {
  padding: 8px;
  border-radius: 6px;
  border: 1px solid var(--color-border);
  background: var(--color-surface-alt, rgba(255, 255, 255, 0.04));
  color: var(--color-text-primary);
  font-size: 12px;
  font-family: var(--font-mono, monospace);
  resize: vertical;
  min-height: 120px;
}
</style>
