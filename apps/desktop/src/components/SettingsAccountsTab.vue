<script setup lang="ts">
/**
 * @file SettingsAccountsTab.vue
 *
 * Settings > Accounts tab — v2.10 §4.2.
 */

import { ref, computed } from "vue";
import { useI18n } from "../composables/useI18n";
import { useAccounts } from "../composables/useAccounts";
import { useCredentials } from "../composables/useCredentials";
import type { ForgeName } from "../composables/forge/types";

const { t } = useI18n();
const {
  accounts,
  accountsByForge,
  addAccount,
  removeAccount,
  activeAccount,
  setActiveAccount,
} = useAccounts();

const {
  saving,
  error: credError,
  saveBitbucketCredential,
  removeCredential,
} = useCredentials();

// ─── Add-account form ────────────────────────────────────────────────────────

const showForm = ref(false);
const formForge = ref<ForgeName>("bitbucket");
const formLabel = ref("");
const formUsername = ref("");
const formWorkspace = ref("");
const formToken = ref("");
const formError = ref<string | null>(null);
const formSuccess = ref(false);

function openForm() {
  formForge.value = "bitbucket";
  formLabel.value = "";
  formUsername.value = "";
  formWorkspace.value = "";
  formToken.value = "";
  formError.value = null;
  formSuccess.value = false;
  showForm.value = true;
}

function cancelForm() {
  showForm.value = false;
}

async function submitForm() {
  formError.value = null;
  formSuccess.value = false;

  if (!formLabel.value.trim()) { formError.value = "Label is required."; return; }
  if (!formUsername.value.trim()) { formError.value = "Username is required."; return; }

  let tokenKey = "";

  if (formForge.value === "bitbucket") {
    if (!formWorkspace.value.trim()) { formError.value = "Workspace is required."; return; }
    if (!formToken.value.trim()) { formError.value = "App Password is required."; return; }
    const ok = await saveBitbucketCredential(
      formWorkspace.value.trim(),
      formUsername.value.trim(),
      formToken.value.trim(),
    );
    if (!ok) { formError.value = credError.value ?? "Failed to save credential."; return; }
    tokenKey = `gitwand:bitbucket/${formWorkspace.value.trim()}`;
  }

  addAccount({ forge: formForge.value, label: formLabel.value.trim(), username: formUsername.value.trim(), tokenKey });
  formSuccess.value = true;
  setTimeout(() => { showForm.value = false; formSuccess.value = false; }, 1200);
}

// ─── Remove ──────────────────────────────────────────────────────────────────

async function onRemove(id: string) {
  const acc = accounts.value.find((a) => a.id === id);
  if (!acc) return;
  if (acc.tokenKey) {
    const slash = acc.tokenKey.indexOf("/");
    if (slash !== -1) await removeCredential(acc.tokenKey.slice(0, slash), acc.tokenKey.slice(slash + 1));
  }
  removeAccount(id);
}

// ─── Display ─────────────────────────────────────────────────────────────────

const forgeOrder: ForgeName[] = ["github", "gitlab", "bitbucket"];
const forgeLabel: Record<ForgeName, string> = { github: "GitHub", gitlab: "GitLab", bitbucket: "Bitbucket", unknown: "Unknown" };
const knownForges = computed(() => forgeOrder.filter((f) => (accountsByForge.value[f]?.length ?? 0) > 0));
const totalAccounts = computed(() => accounts.value.length);
</script>

<template>
  <div class="sa">

    <!-- ── Empty state ── -->
    <div v-if="totalAccounts === 0 && !showForm" class="sa-empty">
      <svg width="36" height="36" viewBox="0 0 36 36" fill="none" stroke="currentColor" stroke-width="1.4">
        <circle cx="13" cy="11" r="5.5" />
        <path d="M2 32c0-6.07 4.93-11 11-11s11 4.93 11 11" stroke-linecap="round" />
        <path d="M29 16v10m-5-5h10" stroke-linecap="round" />
      </svg>
      <p>{{ t('settings.accountsEmpty') }}</p>
    </div>

    <!-- ── Account list ── -->
    <template v-for="forge in knownForges" :key="forge">
      <div class="sa-group">
        <div class="sa-group-title">{{ forgeLabel[forge] }}</div>
        <div class="sa-list">
          <div v-for="acc in accountsByForge[forge]" :key="acc.id" class="sa-row"
            :class="{ 'sa-row--active': activeAccount(forge)?.id === acc.id }">
            <div class="sa-row-left">
              <span class="sa-name">{{ acc.label }}</span>
              <span class="sa-user">@{{ acc.username }}</span>
            </div>
            <div class="sa-row-right">
              <span v-if="activeAccount(forge)?.id === acc.id" class="sa-badge">
                {{ t('settings.accountsActiveBadge') }}
              </span>
              <button v-else class="sa-link-btn" @click="setActiveAccount(forge, acc.id)">
                {{ t('settings.accountsSetActive') }}
              </button>
              <button class="sa-link-btn sa-link-btn--danger" @click="onRemove(acc.id)">
                {{ t('settings.accountsRemove') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- ── Add form ── -->
    <template v-if="showForm">
      <div class="sa-form">
        <div class="sa-form-title">{{ t('settings.accountsAdd') }}</div>

        <div class="sa-field">
          <label class="sa-label">{{ t('settings.accountsForgeLabel') }}</label>
          <select v-model="formForge" class="sa-select">
            <option value="github">GitHub</option>
            <option value="gitlab">GitLab</option>
            <option value="bitbucket">Bitbucket</option>
          </select>
        </div>

        <div class="sa-field">
          <label class="sa-label">{{ t('settings.accountsLabelLabel') }}</label>
          <input v-model="formLabel" type="text" class="sa-input" placeholder="work, perso, client-x…" />
        </div>

        <div class="sa-field">
          <label class="sa-label">{{ t('settings.accountsUsernameLabel') }}</label>
          <input v-model="formUsername" type="text" class="sa-input" />
        </div>

        <template v-if="formForge === 'bitbucket'">
          <div class="sa-field">
            <label class="sa-label">{{ t('settings.accountsWorkspaceLabel') }}</label>
            <input v-model="formWorkspace" type="text" class="sa-input" placeholder="my-workspace" />
          </div>
          <div class="sa-field">
            <label class="sa-label">{{ t('settings.accountsAppPasswordLabel') }}</label>
            <input v-model="formToken" type="password" class="sa-input" autocomplete="new-password" />
          </div>
        </template>

        <div v-else class="sa-note">
          <template v-if="formForge === 'gitlab'">
            GitLab auth is handled by <code>glab auth login</code> — no token needed here.
          </template>
          <template v-else>
            GitHub auth is handled by <code>gh auth login</code> — no token needed here.
          </template>
        </div>

        <p v-if="formError" class="sa-msg sa-msg--error">{{ formError }}</p>
        <p v-if="formSuccess" class="sa-msg sa-msg--ok">{{ t('settings.accountsSaved') }}</p>

        <div class="sa-form-footer">
          <button class="sa-ghost-btn" :disabled="saving" @click="cancelForm">
            {{ t('settings.accountsCancelBtn') }}
          </button>
          <button class="sa-primary-btn" :disabled="saving" @click="submitForm">
            {{ saving ? '…' : t('settings.accountsSaveBtn') }}
          </button>
        </div>
      </div>
    </template>

    <!-- ── Add button ── -->
    <div v-if="!showForm" class="sa-add">
      <button class="sa-ghost-btn" @click="openForm">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8"
          stroke-linecap="round">
          <path d="M6 1v10M1 6h10" />
        </svg>
        {{ t('settings.accountsAdd') }}
      </button>
    </div>

  </div>
</template>

<style scoped>
/* ── Layout ── */
.sa {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* ── Empty state ── */
.sa-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 36px 0;
  color: var(--color-text-muted, #888);
  font-size: 13px;
  text-align: center;
  opacity: 0.7;
}

/* ── Group (per forge) ── */
.sa-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sa-group-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-muted, #888);
}

/* ── Account rows ── */
.sa-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sa-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-radius: var(--radius-sm, 6px);
  background: var(--color-bg, #1e1e1e);
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.08));
  gap: 12px;
}

.sa-row--active {
  border-color: var(--color-accent, #0a84ff);
}

.sa-row-left {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  flex: 1;
}

.sa-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text, #eee);
}

.sa-user {
  font-size: 12px;
  color: var(--color-text-muted, #888);
}

.sa-row-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.sa-badge {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 2px 7px;
  border-radius: 3px;
  background: var(--color-accent, #0a84ff);
  color: #fff;
}

/* ── Link-style buttons ── */
.sa-link-btn {
  background: none;
  border: none;
  padding: 0;
  font-size: 12px;
  color: var(--color-text-muted, #888);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.sa-link-btn:hover {
  color: var(--color-text, #eee);
}

.sa-link-btn--danger {
  color: var(--color-danger, #e55);
}

.sa-link-btn--danger:hover {
  color: var(--color-danger-light, #f77);
}

/* ── Add-account form ── */
.sa-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
  border-radius: var(--radius-md, 8px);
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.08));
}

.sa-form-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text, #eee);
  margin-bottom: 2px;
}

/* ── Form fields ── */
.sa-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sa-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-muted, #888);
}

.sa-input,
.sa-select {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  font-size: 13px;
  background: var(--color-bg-subtle, rgba(255, 255, 255, 0.04));
  color: var(--color-text, #eee);
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
  border-radius: var(--radius-sm, 5px);
  outline: none;
  transition: border-color 0.15s;
}

.sa-input:focus,
.sa-select:focus {
  border-color: var(--color-accent, #0a84ff);
}

.sa-input::placeholder {
  color: var(--color-text-muted, #666);
}

.sa-select {
  cursor: pointer;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5l3 3 3-3' stroke='%23888' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
  padding-right: 28px;
}

/* ── Note (GitHub/GitLab — no token needed) ── */
.sa-note {
  font-size: 12px;
  color: var(--color-text-muted, #888);
  line-height: 1.5;
}

.sa-note code {
  font-family: monospace;
  font-size: 11px;
  background: rgba(255, 255, 255, 0.07);
  padding: 1px 5px;
  border-radius: 3px;
}

/* ── Messages ── */
.sa-msg {
  font-size: 12px;
  margin: 0;
}

.sa-msg--error {
  color: var(--color-danger, #e55);
}

.sa-msg--ok {
  color: var(--color-success, #4c4);
}

/* ── Form footer ── */
.sa-form-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 2px;
}

/* ── Buttons ── */
.sa-ghost-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 12px;
  border-radius: var(--radius-sm, 5px);
  background: transparent;
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.12));
  color: var(--color-text-muted, #aaa);
  cursor: pointer;
  transition: border-color 0.12s, color 0.12s;
}

.sa-ghost-btn:hover {
  border-color: var(--color-text-muted, #888);
  color: var(--color-text, #eee);
}

.sa-ghost-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.sa-primary-btn {
  padding: 6px 16px;
  font-size: 12px;
  font-weight: 600;
  border-radius: var(--radius-sm, 5px);
  background: var(--color-accent, #0a84ff);
  border: none;
  color: #fff;
  cursor: pointer;
  transition: opacity 0.12s;
}

.sa-primary-btn:hover {
  opacity: 0.88;
}

.sa-primary-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

/* ── Add row ── */
.sa-add {
  display: flex;
}
</style>
