<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useI18n } from "../composables/useI18n";
import { useTheme } from "../composables/useTheme";
import {
  localeLabels,
  supportedLocales,
  type SupportedLocale,
} from "../locales";

const { t, locale, isAuto, setLocale } = useI18n();
const { theme, setTheme } = useTheme();

export type PullMode = "merge" | "rebase";
export type SwitchBehavior = "stash" | "ask" | "refuse";
export type AIProvider = "none" | "claude" | "openai-compat" | "ollama";

const emit = defineEmits<{
  close: [];
  "update:commitSignature": [enabled: boolean];
  "update:diffMode": [mode: DiffMode];
  "update:pullMode": [mode: PullMode];
  "update:fontSize": [size: number];
  "update:tabSize": [size: number];
}>();

// ─── Settings state (persisted in localStorage) ────────
const SETTINGS_KEY = "gitwand-settings";

import type { DiffMode } from "../utils/diffMode";

interface Settings {
  editor: string;
  gitPath: string;
  defaultBranch: string;
  commitSignature: boolean;
  diffMode: DiffMode;
  pullMode: PullMode;
  switchBehavior: SwitchBehavior;
  fontSize: number;
  tabSize: number;
  notifications: boolean;
  // AI settings
  aiEnabled: boolean;
  aiProvider: AIProvider;
  aiApiKey: string;
  aiApiEndpoint: string;
  aiModel: string;
  aiOllamaUrl: string;
  aiOllamaModel: string;
}

const defaultSettings: Settings = {
  editor: "",
  gitPath: "",
  defaultBranch: "main",
  commitSignature: true,
  diffMode: "inline",
  pullMode: "merge",
  switchBehavior: "ask",
  fontSize: 12,
  tabSize: 4,
  notifications: true,
  // AI defaults
  aiEnabled: false,
  aiProvider: "none",
  aiApiKey: "",
  aiApiEndpoint: "https://api.anthropic.com",
  aiModel: "claude-sonnet-4-20250514",
  aiOllamaUrl: "http://localhost:11434",
  aiOllamaModel: "codellama",
};

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...defaultSettings, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...defaultSettings };
}

function saveSettings(s: Settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch { /* ignore */ }
}

const settings = ref<Settings>(loadSettings());

function updateSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  settings.value[key] = value;
  saveSettings(settings.value);
}

// ─── Tab navigation ──────────────────────────────────────
type SettingsTab = "general" | "git" | "editor" | "ai";
const activeSettingsTab = ref<SettingsTab>("general");

const settingsTabs: { id: SettingsTab; icon: string }[] = [
  { id: "general", icon: "general" },
  { id: "git", icon: "git" },
  { id: "editor", icon: "editor" },
  { id: "ai", icon: "ai" },
];

// ─── Language ──────────────────────────────────────────
const selectedLocale = computed({
  get: () => (isAuto.value ? "auto" : locale.value),
  set: (val: string) => {
    if (val === "auto") {
      setLocale(null);
    } else {
      setLocale(val as SupportedLocale);
    }
  },
});

// ─── Theme ─────────────────────────────────────────────
type ThemeSetting = "dark" | "light" | "system";

const themeSetting = ref<ThemeSetting>(
  (() => {
    try {
      return (localStorage.getItem("gitwand-theme-setting") as ThemeSetting) ?? "system";
    } catch {
      return "system";
    }
  })(),
);

function onThemeChange(val: ThemeSetting) {
  themeSetting.value = val;
  try {
    localStorage.setItem("gitwand-theme-setting", val);
  } catch { /* ignore */ }
  if (val === "system") {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    setTheme(prefersDark ? "dark" : "light");
  } else {
    setTheme(val);
  }
}

function onSignatureChange(e: Event) {
  const checked = (e.target as HTMLInputElement).checked;
  updateSetting("commitSignature", checked);
  emit("update:commitSignature", checked);
}

function onDiffModeChange(val: DiffMode) {
  updateSetting("diffMode", val);
  emit("update:diffMode", val);
}

function onPullModeChange(val: PullMode) {
  updateSetting("pullMode", val);
  emit("update:pullMode", val);
}

function onFontSizeChange(val: number) {
  const clamped = Math.max(10, Math.min(18, val));
  updateSetting("fontSize", clamped);
  emit("update:fontSize", clamped);
}

function onTabSizeChange(val: number) {
  updateSetting("tabSize", val);
  emit("update:tabSize", val);
}

function onSwitchBehaviorChange(val: SwitchBehavior) {
  updateSetting("switchBehavior", val);
}

function onNotificationsChange(e: Event) {
  const checked = (e.target as HTMLInputElement).checked;
  updateSetting("notifications", checked);
}

// ─── AI Provider ──────────────────────────────────────
function onAIEnabledChange(e: Event) {
  const checked = (e.target as HTMLInputElement).checked;
  updateSetting("aiEnabled", checked);
  if (checked && settings.value.aiProvider === "none") {
    updateSetting("aiProvider", "claude");
  }
}

function onAIProviderChange(val: AIProvider) {
  updateSetting("aiProvider", val);
  // Set sensible defaults per provider
  if (val === "claude") {
    if (!settings.value.aiApiEndpoint || settings.value.aiApiEndpoint === "https://api.openai.com/v1") {
      updateSetting("aiApiEndpoint", "https://api.anthropic.com");
    }
    if (!settings.value.aiModel || settings.value.aiModel.startsWith("gpt-")) {
      updateSetting("aiModel", "claude-sonnet-4-20250514");
    }
  } else if (val === "openai-compat") {
    if (!settings.value.aiApiEndpoint || settings.value.aiApiEndpoint === "https://api.anthropic.com") {
      updateSetting("aiApiEndpoint", "https://api.openai.com/v1");
    }
    if (!settings.value.aiModel || settings.value.aiModel.startsWith("claude-")) {
      updateSetting("aiModel", "gpt-4o");
    }
  }
}

// Ollama detection
const ollamaAvailable = ref(false);
const ollamaModels = ref<string[]>([]);

async function detectOllama() {
  try {
    const url = settings.value.aiOllamaUrl || "http://localhost:11434";
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const data = await res.json();
      ollamaAvailable.value = true;
      if (data.models && Array.isArray(data.models)) {
        ollamaModels.value = data.models.map((m: any) => m.name || m.model).filter(Boolean);
      }
    }
  } catch {
    ollamaAvailable.value = false;
    ollamaModels.value = [];
  }
}

// API key visibility toggle
const showApiKey = ref(false);

const maskedApiKey = computed(() => {
  const key = settings.value.aiApiKey;
  if (!key) return "";
  if (key.length <= 8) return "••••••••";
  return key.slice(0, 4) + "••••" + key.slice(-4);
});

// ─── Claude OAuth-like Connect flow ─────────────────────
const claudeAuthMode = ref<"apikey" | "connect">(
  settings.value.aiApiKey ? "apikey" : "connect",
);
const claudeConnectStep = ref<"idle" | "waiting" | "success" | "error">("idle");
const claudeConnectError = ref<string | null>(null);

function startClaudeConnect() {
  // Open the Anthropic console key creation page
  window.open("https://console.anthropic.com/settings/keys", "_blank");
  claudeConnectStep.value = "waiting";
  claudeConnectError.value = null;
}

function validateAndSaveClaudeKey(key: string) {
  const trimmed = key.trim();
  if (!trimmed) {
    claudeConnectError.value = "Veuillez coller votre clé API";
    claudeConnectStep.value = "error";
    return;
  }
  if (!trimmed.startsWith("sk-ant-")) {
    claudeConnectError.value = "La clé doit commencer par sk-ant-...";
    claudeConnectStep.value = "error";
    return;
  }
  updateSetting("aiApiKey", trimmed);
  claudeConnectStep.value = "success";
  claudeConnectError.value = null;
  // Auto-dismiss after 2s
  setTimeout(() => {
    if (claudeConnectStep.value === "success") {
      claudeConnectStep.value = "idle";
      claudeAuthMode.value = "apikey";
    }
  }, 2000);
}

function disconnectClaude() {
  updateSetting("aiApiKey", "");
  claudeAuthMode.value = "connect";
  claudeConnectStep.value = "idle";
}

const claudeConnectKeyInput = ref("");

onMounted(() => {
  detectOllama();
});

function onKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}
</script>

<template>
  <div class="settings-overlay" @click.self="emit('close')" @keydown="onKeyDown">
    <div class="settings-panel" role="dialog" :aria-label="t('settings.title')">
      <!-- Header -->
      <div class="sp-header">
        <h2 class="sp-title">{{ t('settings.title') }}</h2>
        <button class="sp-close" @click="emit('close')" :aria-label="t('common.close')">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
          </svg>
        </button>
      </div>

      <!-- Tab navigation -->
      <div class="sp-tabs">
        <button
          v-for="tab in settingsTabs"
          :key="tab.id"
          class="sp-tab"
          :class="{ 'sp-tab--active': activeSettingsTab === tab.id }"
          @click="activeSettingsTab = tab.id"
        >
          <!-- General icon -->
          <svg v-if="tab.icon === 'general'" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
            <circle cx="8" cy="8" r="3" /><path d="M8 1v2m0 10v2m-7-7h2m10 0h2m-2.05-4.95-1.41 1.41m-7.08 7.08-1.41 1.41m0-9.9 1.41 1.41m7.08 7.08 1.41 1.41"/>
          </svg>
          <!-- Git icon -->
          <svg v-else-if="tab.icon === 'git'" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
            <circle cx="8" cy="3" r="2"/><circle cx="8" cy="13" r="2"/><path d="M8 5v6"/><circle cx="13" cy="8" r="2"/><path d="M11 8H9.5c-.83 0-1.5-.67-1.5-1.5V5"/>
          </svg>
          <!-- Editor icon -->
          <svg v-else-if="tab.icon === 'editor'" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
            <rect x="2" y="2" width="12" height="12" rx="2"/><path d="M5 6h6M5 8.5h4M5 11h5"/>
          </svg>
          <!-- AI icon -->
          <svg v-else-if="tab.icon === 'ai'" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
            <path d="M8 1v2m0 10v2M1 8h2m10 0h2"/><circle cx="8" cy="8" r="4"/><circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none"/>
          </svg>
          <span>{{ tab.id === 'general' ? 'Général' : tab.id === 'git' ? 'Git' : tab.id === 'editor' ? 'Éditeur' : 'IA' }}</span>
        </button>
      </div>

      <!-- Tab content -->
      <div class="sp-body">

        <!-- ═══ GÉNÉRAL ═══ -->
        <template v-if="activeSettingsTab === 'general'">
          <!-- Language -->
          <div class="sp-row">
            <label class="sp-label" for="setting-lang">{{ t('settings.language') }}</label>
            <select id="setting-lang" class="sp-select" v-model="selectedLocale">
              <option value="auto">{{ t('settings.languageAuto') }}</option>
              <option v-for="loc in supportedLocales" :key="loc" :value="loc">{{ localeLabels[loc] }}</option>
            </select>
          </div>

          <!-- Theme -->
          <div class="sp-row">
            <label class="sp-label" for="setting-theme">{{ t('settings.theme') }}</label>
            <select
              id="setting-theme"
              class="sp-select"
              :value="themeSetting"
              @change="onThemeChange(($event.target as HTMLSelectElement).value as ThemeSetting)"
            >
              <option value="system">{{ t('settings.themeSystem') }}</option>
              <option value="dark">{{ t('settings.themeDark') }}</option>
              <option value="light">{{ t('settings.themeLight') }}</option>
            </select>
          </div>

          <!-- Notifications -->
          <div class="sp-row sp-row--checkbox">
            <label class="sp-checkbox-label" for="setting-notifications">
              <input id="setting-notifications" type="checkbox" class="sp-checkbox" :checked="settings.notifications" @change="onNotificationsChange" />
              <span>{{ t('settings.notifications') }}</span>
            </label>
            <span class="sp-hint">{{ t('settings.notificationsHint') }}</span>
          </div>
        </template>

        <!-- ═══ GIT ═══ -->
        <template v-if="activeSettingsTab === 'git'">
          <!-- Git path -->
          <div class="sp-row">
            <label class="sp-label" for="setting-git">{{ t('settings.gitPath') }}</label>
            <input
              id="setting-git" class="sp-input mono" type="text"
              :value="settings.gitPath"
              @input="updateSetting('gitPath', ($event.target as HTMLInputElement).value)"
              :placeholder="t('settings.gitPathAuto')"
            />
          </div>

          <!-- Default branch -->
          <div class="sp-row">
            <label class="sp-label" for="setting-branch">{{ t('settings.defaultBranch') }}</label>
            <input
              id="setting-branch" class="sp-input mono" type="text"
              :value="settings.defaultBranch"
              @input="updateSetting('defaultBranch', ($event.target as HTMLInputElement).value)"
              placeholder="main"
            />
          </div>

          <!-- Pull mode -->
          <div class="sp-row">
            <label class="sp-label" for="setting-pull-mode">{{ t('settings.pullMode') }}</label>
            <select
              id="setting-pull-mode" class="sp-select"
              :value="settings.pullMode"
              @change="onPullModeChange(($event.target as HTMLSelectElement).value as PullMode)"
            >
              <option value="merge">{{ t('settings.pullMerge') }}</option>
              <option value="rebase">{{ t('settings.pullRebase') }}</option>
            </select>
          </div>

          <!-- Switch behavior -->
          <div class="sp-row">
            <label class="sp-label" for="setting-switch-behavior">{{ t('settings.switchBehavior') }}</label>
            <select
              id="setting-switch-behavior" class="sp-select"
              :value="settings.switchBehavior"
              @change="onSwitchBehaviorChange(($event.target as HTMLSelectElement).value as SwitchBehavior)"
            >
              <option value="stash">{{ t('settings.switchStash') }}</option>
              <option value="ask">{{ t('settings.switchAsk') }}</option>
              <option value="refuse">{{ t('settings.switchRefuse') }}</option>
            </select>
          </div>

          <!-- Commit signature -->
          <div class="sp-row sp-row--checkbox">
            <label class="sp-checkbox-label" for="setting-signature">
              <input id="setting-signature" type="checkbox" class="sp-checkbox" :checked="settings.commitSignature" @change="onSignatureChange" />
              <span>{{ t('settings.commitSignature') }}</span>
            </label>
            <span class="sp-hint">{{ t('settings.commitSignatureHint') }}</span>
          </div>
        </template>

        <!-- ═══ ÉDITEUR ═══ -->
        <template v-if="activeSettingsTab === 'editor'">
          <!-- External editor -->
          <div class="sp-row">
            <label class="sp-label" for="setting-editor">{{ t('settings.editor') }}</label>
            <input
              id="setting-editor" class="sp-input mono" type="text"
              :value="settings.editor"
              @input="updateSetting('editor', ($event.target as HTMLInputElement).value)"
              :placeholder="t('settings.editorPlaceholder')"
            />
          </div>

          <!-- Diff display -->
          <div class="sp-row">
            <label class="sp-label" for="setting-diff-mode">{{ t('settings.diffDisplay') }}</label>
            <select
              id="setting-diff-mode" class="sp-select"
              :value="settings.diffMode"
              @change="onDiffModeChange(($event.target as HTMLSelectElement).value as DiffMode)"
            >
              <option value="inline">{{ t('settings.diffInline') }}</option>
              <option value="side-by-side">{{ t('settings.diffSideBySide') }}</option>
            </select>
          </div>

          <!-- Font size -->
          <div class="sp-row">
            <label class="sp-label" for="setting-font-size">{{ t('settings.fontSize') }}</label>
            <div class="sp-range-row">
              <input
                id="setting-font-size" class="sp-range" type="range"
                min="10" max="18" step="1"
                :value="settings.fontSize"
                @input="onFontSizeChange(Number(($event.target as HTMLInputElement).value))"
              />
              <span class="sp-range-value mono">{{ settings.fontSize }}px</span>
            </div>
          </div>

          <!-- Tab size -->
          <div class="sp-row">
            <label class="sp-label" for="setting-tab-size">{{ t('settings.tabSize') }}</label>
            <select
              id="setting-tab-size" class="sp-select"
              :value="settings.tabSize"
              @change="onTabSizeChange(Number(($event.target as HTMLSelectElement).value))"
            >
              <option :value="2">2 {{ t('settings.spaces') }}</option>
              <option :value="4">4 {{ t('settings.spaces') }}</option>
              <option :value="8">8 {{ t('settings.spaces') }}</option>
            </select>
          </div>
        </template>

        <!-- ═══ INTELLIGENCE ARTIFICIELLE ═══ -->
        <template v-if="activeSettingsTab === 'ai'">
          <!-- Enable AI -->
          <div class="sp-row sp-row--checkbox">
            <label class="sp-checkbox-label" for="setting-ai-enabled">
              <input id="setting-ai-enabled" type="checkbox" class="sp-checkbox" :checked="settings.aiEnabled" @change="onAIEnabledChange" />
              <span>Activer les suggestions IA</span>
            </label>
            <span class="sp-hint">Propose des résolutions intelligentes pour les conflits complexes (confiance &lt; 60%)</span>
          </div>

          <template v-if="settings.aiEnabled">
            <!-- Provider -->
            <div class="sp-row">
              <label class="sp-label" for="setting-ai-provider">Provider</label>
              <select
                id="setting-ai-provider" class="sp-select"
                :value="settings.aiProvider"
                @change="onAIProviderChange(($event.target as HTMLSelectElement).value as AIProvider)"
              >
                <option value="claude">Claude (Anthropic)</option>
                <option value="openai-compat">API compatible OpenAI</option>
                <option value="ollama" :disabled="!ollamaAvailable">
                  Ollama (local){{ ollamaAvailable ? '' : ' — non détecté' }}
                </option>
              </select>
            </div>

            <!-- Claude provider -->
            <template v-if="settings.aiProvider === 'claude'">
              <!-- Auth mode selector -->
              <div class="sp-row">
                <label class="sp-label">Authentification</label>
                <div class="sp-auth-toggle">
                  <button
                    :class="['sp-auth-btn', { 'sp-auth-btn--active': claudeAuthMode === 'connect' }]"
                    @click="claudeAuthMode = 'connect'"
                  >
                    Connecter
                  </button>
                  <button
                    :class="['sp-auth-btn', { 'sp-auth-btn--active': claudeAuthMode === 'apikey' }]"
                    @click="claudeAuthMode = 'apikey'"
                  >
                    Clé API
                  </button>
                </div>
              </div>

              <!-- Connect flow -->
              <template v-if="claudeAuthMode === 'connect'">
                <div v-if="settings.aiApiKey" class="sp-row">
                  <div class="sp-connected-badge">
                    <span class="sp-connected-dot"></span>
                    <span>Connecté — {{ maskedApiKey }}</span>
                    <button class="sp-disconnect-btn" @click="disconnectClaude">Déconnecter</button>
                  </div>
                </div>
                <div v-else class="sp-row">
                  <div class="sp-connect-flow">
                    <!-- Step 1: Start -->
                    <div v-if="claudeConnectStep === 'idle'" class="sp-connect-start">
                      <button class="sp-connect-btn" @click="startClaudeConnect">
                        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5">
                          <path d="M9 1C4.58 1 1 4.58 1 9s3.58 8 8 8 8-3.58 8-8-3.58-8-8-8z"/>
                          <path d="M6 9h6M9 6v6"/>
                        </svg>
                        Connecter avec Claude
                      </button>
                      <span class="sp-hint">Ouvre la console Anthropic pour créer une clé API</span>
                    </div>

                    <!-- Step 2: Waiting for key -->
                    <div v-if="claudeConnectStep === 'waiting'" class="sp-connect-waiting">
                      <p class="sp-connect-instruction">
                        1. Créez ou copiez une clé API depuis la console Anthropic<br />
                        2. Collez-la ci-dessous :
                      </p>
                      <div class="sp-key-row">
                        <input
                          v-model="claudeConnectKeyInput"
                          class="sp-input mono sp-input--key"
                          type="password"
                          placeholder="sk-ant-api03-..."
                          @keydown.enter="validateAndSaveClaudeKey(claudeConnectKeyInput)"
                        />
                        <button
                          class="sp-connect-save-btn"
                          :disabled="!claudeConnectKeyInput.trim()"
                          @click="validateAndSaveClaudeKey(claudeConnectKeyInput)"
                        >
                          Enregistrer
                        </button>
                      </div>
                      <div v-if="claudeConnectError" class="sp-connect-error">{{ claudeConnectError }}</div>
                      <button class="sp-text-btn" @click="claudeConnectStep = 'idle'">Annuler</button>
                    </div>

                    <!-- Step 3: Success -->
                    <div v-if="claudeConnectStep === 'success'" class="sp-connect-success">
                      Connecté avec succès !
                    </div>

                    <!-- Step 3b: Error -->
                    <div v-if="claudeConnectStep === 'error'" class="sp-connect-error-block">
                      <div class="sp-connect-error">{{ claudeConnectError }}</div>
                      <button class="sp-text-btn" @click="claudeConnectStep = 'waiting'">Réessayer</button>
                    </div>
                  </div>
                </div>
              </template>

              <!-- Manual API key mode -->
              <template v-if="claudeAuthMode === 'apikey'">
                <div class="sp-row">
                  <label class="sp-label" for="setting-ai-key">Clé API Anthropic</label>
                  <div class="sp-key-row">
                    <input
                      id="setting-ai-key"
                      class="sp-input mono sp-input--key"
                      :type="showApiKey ? 'text' : 'password'"
                      :value="settings.aiApiKey"
                      @input="updateSetting('aiApiKey', ($event.target as HTMLInputElement).value)"
                      placeholder="sk-ant-api03-..."
                    />
                    <button class="sp-key-toggle" @click="showApiKey = !showApiKey" :title="showApiKey ? 'Masquer' : 'Afficher'">
                      <svg v-if="showApiKey" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
                        <path d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z"/><circle cx="8" cy="8" r="2"/>
                      </svg>
                      <svg v-else width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
                        <path d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z"/><circle cx="8" cy="8" r="2"/><path d="M3 13L13 3" stroke-width="1.5"/>
                      </svg>
                    </button>
                  </div>
                  <span class="sp-hint">Disponible sur <a href="https://console.anthropic.com/settings/keys" target="_blank" class="sp-link">console.anthropic.com</a></span>
                </div>
              </template>

              <div class="sp-row">
                <label class="sp-label" for="setting-ai-model-claude">Modèle</label>
                <select
                  id="setting-ai-model-claude" class="sp-select"
                  :value="settings.aiModel"
                  @change="updateSetting('aiModel', ($event.target as HTMLSelectElement).value)"
                >
                  <option value="claude-sonnet-4-20250514">Claude Sonnet 4 (recommandé)</option>
                  <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5 (rapide)</option>
                  <option value="claude-opus-4-20250514">Claude Opus 4 (premium)</option>
                </select>
              </div>
            </template>

            <!-- OpenAI-compatible provider -->
            <template v-if="settings.aiProvider === 'openai-compat'">
              <div class="sp-row">
                <label class="sp-label" for="setting-ai-endpoint">Endpoint API</label>
                <input
                  id="setting-ai-endpoint" class="sp-input mono" type="text"
                  :value="settings.aiApiEndpoint"
                  @input="updateSetting('aiApiEndpoint', ($event.target as HTMLInputElement).value)"
                  placeholder="https://api.openai.com/v1"
                />
                <span class="sp-hint">Compatible OpenAI, Mistral, Groq, Azure, etc.</span>
              </div>

              <div class="sp-row">
                <label class="sp-label" for="setting-ai-key-compat">Clé API</label>
                <div class="sp-key-row">
                  <input
                    id="setting-ai-key-compat"
                    class="sp-input mono sp-input--key"
                    :type="showApiKey ? 'text' : 'password'"
                    :value="settings.aiApiKey"
                    @input="updateSetting('aiApiKey', ($event.target as HTMLInputElement).value)"
                    placeholder="sk-..."
                  />
                  <button class="sp-key-toggle" @click="showApiKey = !showApiKey" :title="showApiKey ? 'Masquer' : 'Afficher'">
                    <svg v-if="showApiKey" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
                      <path d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z"/><circle cx="8" cy="8" r="2"/>
                    </svg>
                    <svg v-else width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
                      <path d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z"/><circle cx="8" cy="8" r="2"/><path d="M3 13L13 3" stroke-width="1.5"/>
                    </svg>
                  </button>
                </div>
              </div>

              <div class="sp-row">
                <label class="sp-label" for="setting-ai-model-compat">Modèle</label>
                <input
                  id="setting-ai-model-compat" class="sp-input mono" type="text"
                  :value="settings.aiModel"
                  @input="updateSetting('aiModel', ($event.target as HTMLInputElement).value)"
                  placeholder="gpt-4o"
                />
              </div>
            </template>

            <!-- Ollama provider -->
            <template v-if="settings.aiProvider === 'ollama'">
              <div class="sp-row">
                <label class="sp-label" for="setting-ai-ollama-url">URL Ollama</label>
                <div class="sp-key-row">
                  <input
                    id="setting-ai-ollama-url" class="sp-input mono sp-input--key" type="text"
                    :value="settings.aiOllamaUrl"
                    @input="updateSetting('aiOllamaUrl', ($event.target as HTMLInputElement).value)"
                    placeholder="http://localhost:11434"
                  />
                  <button class="sp-key-toggle" @click="detectOllama" title="Tester la connexion">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
                      <path d="M14 8A6 6 0 112 8" /><path d="M14 8l-2-2m2 2l-2 2"/>
                    </svg>
                  </button>
                </div>
                <span class="sp-hint" :class="{ 'sp-hint--ok': ollamaAvailable }">
                  {{ ollamaAvailable ? `Connecté — ${ollamaModels.length} modèle(s) disponible(s)` : 'Non connecté. Installez Ollama sur ollama.com' }}
                </span>
              </div>

              <div class="sp-row" v-if="ollamaAvailable">
                <label class="sp-label" for="setting-ai-ollama-model">Modèle</label>
                <select
                  v-if="ollamaModels.length > 0"
                  id="setting-ai-ollama-model" class="sp-select"
                  :value="settings.aiOllamaModel"
                  @change="updateSetting('aiOllamaModel', ($event.target as HTMLSelectElement).value)"
                >
                  <option v-for="model in ollamaModels" :key="model" :value="model">{{ model }}</option>
                </select>
                <input
                  v-else
                  id="setting-ai-ollama-model" class="sp-input mono" type="text"
                  :value="settings.aiOllamaModel"
                  @input="updateSetting('aiOllamaModel', ($event.target as HTMLInputElement).value)"
                  placeholder="codellama"
                />
              </div>
            </template>

            <!-- AI info box -->
            <div class="sp-info-box">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
                <circle cx="8" cy="8" r="7"/><path d="M8 7v4" stroke-linecap="round"/><circle cx="8" cy="5" r="0.7" fill="currentColor" stroke="none"/>
              </svg>
              <p>L'IA analyse le contexte du conflit (base/ours/theirs, messages de commit, nom de fichier) pour proposer une résolution. Votre code n'est envoyé qu'au provider sélectionné. Aucune suggestion n'est appliquée automatiquement.</p>
            </div>
          </template>
        </template>

      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-overlay {
  position: fixed;
  inset: 0;
  background: var(--color-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  backdrop-filter: blur(4px);
}

.settings-panel {
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  width: min(520px, 90vw);
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  animation: spSlideIn 0.2s ease-out;
}

@keyframes spSlideIn {
  from { opacity: 0; transform: translateY(-10px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

.sp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px 12px;
}

.sp-title {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
}

.sp-close {
  background: none;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
}

.sp-close:hover {
  color: var(--color-text);
  background: rgba(255, 255, 255, 0.06);
}

/* ─── Tab bar ──────────────────────────────────────────── */
.sp-tabs {
  display: flex;
  gap: 0;
  padding: 0 20px;
  border-bottom: 1px solid var(--color-border);
}

.sp-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text-muted);
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  transition: color 0.12s, border-color 0.12s;
  white-space: nowrap;
}

.sp-tab:hover {
  color: var(--color-text);
}

.sp-tab--active {
  color: var(--color-text);
  border-bottom-color: var(--color-accent);
}

.sp-tab svg {
  flex-shrink: 0;
}

/* ─── Body ─────────────────────────────────────────────── */
.sp-body {
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  overflow-y: auto;
  min-height: 180px;
}

.sp-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sp-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.sp-select,
.sp-input {
  padding: 8px 10px;
  font-size: 13px;
  background: var(--color-bg);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  outline: none;
  transition: border-color 0.15s;
}

.sp-select:focus,
.sp-input:focus {
  border-color: var(--color-accent);
}

.sp-select {
  cursor: pointer;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5l3 3 3-3' stroke='%23888' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
  padding-right: 30px;
}

.sp-input::placeholder {
  color: var(--color-text-muted);
}

.sp-row--checkbox {
  gap: 4px;
}

.sp-checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
}

.sp-checkbox {
  width: 16px;
  height: 16px;
  accent-color: var(--color-accent);
  cursor: pointer;
}

.sp-hint {
  font-size: 11px;
  color: var(--color-text-muted);
  padding-left: 24px;
}

.sp-hint--ok {
  color: var(--color-success, #22c55e);
}

.sp-link {
  color: var(--color-accent);
  text-decoration: none;
}

.sp-link:hover {
  text-decoration: underline;
}

.sp-range-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.sp-range {
  flex: 1;
  accent-color: var(--color-accent);
  cursor: pointer;
  height: 4px;
}

.sp-range-value {
  font-size: 12px;
  color: var(--color-text-muted);
  min-width: 36px;
  text-align: right;
}

/* ─── API key row ──────────────────────────────────────── */
.sp-key-row {
  display: flex;
  gap: 6px;
}

.sp-input--key {
  flex: 1;
  min-width: 0;
}

.sp-key-toggle {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: color 0.12s, border-color 0.12s;
}

.sp-key-toggle:hover {
  color: var(--color-text);
  border-color: var(--color-accent);
}

/* ─── Info box ─────────────────────────────────────────── */
.sp-info-box {
  display: flex;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 8px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  font-size: 12px;
  line-height: 1.5;
  color: var(--color-text-muted);
}

.sp-info-box svg {
  flex-shrink: 0;
  margin-top: 1px;
}

.sp-info-box p {
  margin: 0;
}

/* ─── Claude Auth flow ────────────────────────────────── */
.sp-auth-toggle {
  display: flex;
  gap: 0;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  overflow: hidden;
}

.sp-auth-btn {
  flex: 1;
  padding: 5px 12px;
  font-size: 12px;
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: all 0.15s;
}

.sp-auth-btn:first-child { border-right: 1px solid var(--color-border); }

.sp-auth-btn--active {
  background: var(--color-accent);
  color: #fff;
  font-weight: 600;
}

.sp-connect-flow {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sp-connect-start {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sp-connect-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-radius: 8px;
  border: 1px solid var(--color-accent);
  background: rgba(203, 166, 247, 0.1);
  color: var(--color-accent);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}

.sp-connect-btn:hover {
  background: rgba(203, 166, 247, 0.2);
}

.sp-connect-waiting {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sp-connect-instruction {
  font-size: 12px;
  color: var(--color-text-muted);
  line-height: 1.6;
  margin: 0;
}

.sp-connect-save-btn {
  padding: 4px 12px;
  border-radius: 4px;
  border: 1px solid transparent;
  background: var(--color-accent);
  color: #1e1e2e;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: filter 0.15s;
}

.sp-connect-save-btn:hover { filter: brightness(1.1); }
.sp-connect-save-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.sp-connect-error {
  font-size: 12px;
  color: var(--color-error, #f38ba8);
}

.sp-connect-error-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sp-connect-success {
  font-size: 13px;
  color: var(--color-success, #a6e3a1);
  font-weight: 600;
  padding: 8px;
  background: rgba(166, 227, 161, 0.1);
  border-radius: 6px;
  text-align: center;
}

.sp-text-btn {
  background: none;
  border: none;
  color: var(--color-text-muted);
  font-size: 11px;
  cursor: pointer;
  text-decoration: underline;
  padding: 0;
  align-self: flex-start;
}

.sp-text-btn:hover { color: var(--color-text); }

.sp-connected-badge {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 6px;
  background: rgba(166, 227, 161, 0.1);
  border: 1px solid rgba(166, 227, 161, 0.3);
  font-size: 12px;
  color: var(--color-success, #a6e3a1);
}

.sp-connected-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-success, #a6e3a1);
  flex-shrink: 0;
}

.sp-disconnect-btn {
  margin-left: auto;
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid rgba(243, 139, 168, 0.4);
  background: transparent;
  color: var(--color-error, #f38ba8);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s;
}

.sp-disconnect-btn:hover {
  background: rgba(243, 139, 168, 0.15);
}
</style>
