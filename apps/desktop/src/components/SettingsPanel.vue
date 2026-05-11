<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { useI18n } from "../composables/useI18n";
import { useTheme } from "../composables/useTheme";
import BaseModal from "./BaseModal.vue";
import HooksPanel from "./HooksPanel.vue";
import AutomationsPanel from "./AutomationsPanel.vue";
import {
  localeLabels,
  supportedLocales,
  type SupportedLocale,
} from "../locales";
import {
  detectClaudeCli,
  claudeCliLogin,
  type ClaudeCliInfo,
  detectCodexCli,
  type CodexCliInfo,
  readGitwandrc,
  writeGitwandrc,
} from "../utils/backend";

const { t, locale, isAuto, setLocale } = useI18n();
const { theme, setTheme } = useTheme();

export type PullMode = "merge" | "rebase";
export type SwitchBehavior = "stash" | "ask" | "refuse";
// Single source of truth for the provider union — re-export so other files
// importing from SettingsPanel don't break, but the canonical declaration
// lives in `useAIProvider`.
import type { AIProvider } from "../composables/useAIProvider";
export type { AIProvider };

export interface ErrorLogEntry {
  ts: number;
  msg: string;
}

const props = defineProps<{
  /** Accumulated error log passed down from App.vue */
  errorLog?: ErrorLogEntry[];
  /** Open directly on this tab (e.g. "logs" when clicking the error badge) */
  initialTab?: "general" | "git" | "editor" | "ai" | "automations" | "logs" | "hooks";
  /** Current repo path (for Hooks tab) */
  cwd?: string;
}>();

const emit = defineEmits<{
  close: [];
  "update:commitSignature": [enabled: boolean];
  "update:diffMode": [mode: DiffMode];
  "update:pullMode": [mode: PullMode];
  "update:fontSize": [size: number];
  "update:tabSize": [size: number];
  clearLogs: [];
}>();

// ─── Settings state (persisted in localStorage) ────────
const SETTINGS_KEY = "gitwand-settings";

import type { DiffMode } from "../utils/diffMode";
import type { BlameAlgorithm } from "../utils/backend";

interface Settings {
  editor: string;
  gitPath: string;
  defaultBranch: string;
  commitSignature: boolean;
  commitMessageLang: string; // "" = follow UI locale
  diffMode: DiffMode;
  pullMode: PullMode;
  switchBehavior: SwitchBehavior;
  fontSize: number;
  tabSize: number;
  notifications: boolean;
  blameAlgorithm: BlameAlgorithm;
  // Auto-update channel (v2.0)
  updateChannel: "stable" | "beta";
  // AI settings
  aiEnabled: boolean;
  aiProvider: AIProvider;
  aiApiKey: string;
  aiApiEndpoint: string;
  aiModel: string;
  aiOllamaUrl: string;
  aiOllamaModel: string;
  // Automation settings (v2.8)
  automations: {
    autoResolve: { enabled: boolean };
    nightlyPull: { enabled: boolean; hour: number; minute: number };
    releaseNotes: { enabled: boolean };
    aiCommitBatch: { enabled: boolean };
  };
}

const defaultSettings: Settings = {
  editor: "",
  gitPath: "",
  defaultBranch: "main",
  commitSignature: true,
  commitMessageLang: "",
  diffMode: "inline",
  pullMode: "merge",
  switchBehavior: "ask",
  fontSize: 12,
  tabSize: 4,
  notifications: true,
  updateChannel: "stable",
  // AI defaults
  aiEnabled: false,
  aiProvider: "none",
  aiApiKey: "",
  aiApiEndpoint: "https://api.anthropic.com",
  aiModel: "claude-sonnet-4-20250514",
  aiOllamaUrl: "http://localhost:11434",
  aiOllamaModel: "codellama",
  blameAlgorithm: "histogram",
  automations: {
    autoResolve:   { enabled: false },
    nightlyPull:   { enabled: false, hour: 8, minute: 0 },
    releaseNotes:  { enabled: false },
    aiCommitBatch: { enabled: false },
  },
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
type SettingsTab = "general" | "git" | "editor" | "ai" | "automations" | "logs" | "hooks";
const activeSettingsTab = ref<SettingsTab>(props.initialTab ?? "general");

const settingsTabs: { id: SettingsTab; icon: string }[] = [
  { id: "general", icon: "general" },
  { id: "git", icon: "git" },
  { id: "editor", icon: "editor" },
  { id: "ai", icon: "ai" },
  { id: "automations", icon: "automations" },
  { id: "hooks", icon: "hooks" },
  { id: "logs", icon: "logs" },
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
  if (val === "claude-code-cli") {
    // Refresh detection when the user picks this provider.
    runClaudeCliDetect();
  } else if (val === "codex-cli") {
    runCodexCliDetect();
  } else if (val === "claude") {
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
    claudeConnectError.value = t("settings.aiConnectErrorEmpty");
    claudeConnectStep.value = "error";
    return;
  }
  if (!trimmed.startsWith("sk-ant-")) {
    claudeConnectError.value = t("settings.aiConnectErrorPrefix");
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

// ─── Claude Code CLI detection ──────────────────────────
const claudeCliInfo = ref<ClaudeCliInfo | null>(null);
const claudeCliDetecting = ref(false);
const claudeCliLoginLoading = ref(false);

async function runClaudeCliDetect() {
  claudeCliDetecting.value = true;
  try {
    claudeCliInfo.value = await detectClaudeCli();
  } catch (e) {
    claudeCliInfo.value = {
      found: false,
      path: "",
      version: "",
      logged_in: false,
      status: "error",
      detail: (e as Error).message,
    };
  } finally {
    claudeCliDetecting.value = false;
  }
}

// ─── Codex CLI detection (v2.0) ─────────────────────────
// Same shape as the Claude CLI block; no `runCodexCliLogin` because the
// CLI's `codex login` flow is interactive and Laurent's existing
// claudeCliLogin opens a terminal — for Codex, the user authenticates
// once outside GitWand (browser OAuth or env var) and we re-detect on
// demand. Adding a terminal-launch helper is a follow-up if needed.
const codexCliInfo = ref<CodexCliInfo | null>(null);
const codexCliDetecting = ref(false);

async function runCodexCliDetect() {
  codexCliDetecting.value = true;
  try {
    codexCliInfo.value = await detectCodexCli();
  } catch (e) {
    codexCliInfo.value = {
      found: false,
      path: "",
      version: "",
      logged_in: false,
      status: "error",
      detail: (e as Error).message,
    };
  } finally {
    codexCliDetecting.value = false;
  }
}

async function runClaudeCliLogin() {
  claudeCliLoginLoading.value = true;
  try {
    await claudeCliLogin();
    // After launching the terminal, re-poll a few times so the UI flips to
    // "logged in" without the user having to click Detect again.
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      await runClaudeCliDetect();
      if (claudeCliInfo.value?.logged_in) break;
    }
  } catch (e) {
    claudeCliInfo.value = {
      found: claudeCliInfo.value?.found ?? false,
      path: claudeCliInfo.value?.path ?? "",
      version: claudeCliInfo.value?.version ?? "",
      logged_in: false,
      status: "error",
      detail: (e as Error).message,
    };
  } finally {
    claudeCliLoginLoading.value = false;
  }
}

// ─── LLM fallback (v2.5 — .gitwandrc) ───────────────────
//
// Persisted in the repo's `.gitwandrc` (per-repo, not localStorage),
// because the LLM fallback config travels with the repository and is
// also consumed by the CLI / MCP / CI runners. The `endpoint` field
// itself is NOT written to disk — it's injected programmatically by
// useGitWand at call time (cf. PLAN-v2.5-tie-in §2.1).
//
// TDZ caveat: all refs / computeds below MUST be declared BEFORE the
// `watch(..., { immediate: true })` that reloads on `props.cwd` change,
// otherwise the watcher fires during script setup and reads `undefined`.

type LlmFallbackProvider =
  | "claude"
  | "claude-code-cli"
  | "codex-cli"
  | "openai-compat"
  | "ollama"
  | "mcp";

type MinMode = "off" | "balanced" | "strict";

interface LlmFallbackState {
  enabled: boolean;
  provider: LlmFallbackProvider;
  minPostMergeScore: number;
  contextLines: number;
  minMode: MinMode;
}

const DEFAULT_LLM_FALLBACK: LlmFallbackState = {
  enabled: false,
  provider: "claude",
  minPostMergeScore: 80,
  contextLines: 50,
  minMode: "strict",
};

const llmFallback = ref<LlmFallbackState>({ ...DEFAULT_LLM_FALLBACK });
const llmFallbackLoading = ref(false);
const llmFallbackSaving = ref(false);
const llmFallbackSaveError = ref<string | null>(null);
const llmFallbackSaveSuccess = ref(false);
// The full parsed .gitwandrc — needed so that Save round-trips the rest
// of the user's config (policy, structural, refmerge, …) unchanged.
const llmFallbackRcCache = ref<Record<string, unknown>>({});
// Policy read from .gitwandrc (read-only here, edited elsewhere or by hand).
// Used to surface a warning when the active policy will skip the LLM
// fallback (see PLAN-v2.5-tie-in §Risques #4).
const llmFallbackPolicy = ref<string | null>(null);

const llmFallbackHasRepo = computed(() => !!(props.cwd && props.cwd.trim()));

const llmFallbackPolicyConflict = computed(() => {
  const p = llmFallbackPolicy.value;
  return p === "prefer-safety" || p === "strict";
});

async function loadLlmFallback() {
  if (!llmFallbackHasRepo.value) {
    llmFallback.value = { ...DEFAULT_LLM_FALLBACK };
    llmFallbackRcCache.value = {};
    llmFallbackPolicy.value = null;
    return;
  }
  llmFallbackLoading.value = true;
  llmFallbackSaveError.value = null;
  llmFallbackSaveSuccess.value = false;
  try {
    const raw = await readGitwandrc(props.cwd!);
    let parsed: Record<string, unknown> = {};
    if (raw && raw.trim()) {
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // .gitwandrc may be JSONC with comments — best-effort strip
        // single-line comments, then retry once. If that still fails,
        // we surface an error rather than silently overwrite.
        try {
          const stripped = raw
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/(^|[^:])\/\/.*$/gm, "$1");
          parsed = JSON.parse(stripped) as Record<string, unknown>;
        } catch {
          llmFallbackSaveError.value = t("settings.ai.fallback.warning");
          parsed = {};
        }
      }
    }
    llmFallbackRcCache.value = parsed;

    const llm = (parsed.llmFallback ?? {}) as Partial<LlmFallbackState>;
    const merged: LlmFallbackState = {
      enabled: typeof llm.enabled === "boolean" ? llm.enabled : DEFAULT_LLM_FALLBACK.enabled,
      provider: (typeof llm.provider === "string" && llm.provider
        ? (llm.provider as LlmFallbackProvider)
        : DEFAULT_LLM_FALLBACK.provider),
      minPostMergeScore: typeof llm.minPostMergeScore === "number"
        ? Math.max(50, Math.min(100, llm.minPostMergeScore))
        : DEFAULT_LLM_FALLBACK.minPostMergeScore,
      contextLines: typeof llm.contextLines === "number"
        ? Math.max(10, Math.min(200, llm.contextLines))
        : DEFAULT_LLM_FALLBACK.contextLines,
      minMode: (llm.minMode === "off" || llm.minMode === "balanced" || llm.minMode === "strict")
        ? llm.minMode
        : DEFAULT_LLM_FALLBACK.minMode,
    };
    llmFallback.value = merged;

    const policy = parsed.policy;
    llmFallbackPolicy.value = typeof policy === "string" ? policy : null;
  } catch (e) {
    // No .gitwandrc yet (most common case) → keep defaults silently.
    llmFallback.value = { ...DEFAULT_LLM_FALLBACK };
    llmFallbackRcCache.value = {};
    llmFallbackPolicy.value = null;
  } finally {
    llmFallbackLoading.value = false;
  }
}

async function saveLlmFallback() {
  if (!llmFallbackHasRepo.value) return;
  llmFallbackSaving.value = true;
  llmFallbackSaveError.value = null;
  llmFallbackSaveSuccess.value = false;
  try {
    // Round-trip the rest of the .gitwandrc untouched; replace only
    // the llmFallback key. Endpoint is never persisted (cf. §1.0).
    const next = {
      ...llmFallbackRcCache.value,
      llmFallback: {
        enabled: llmFallback.value.enabled,
        provider: llmFallback.value.provider,
        minPostMergeScore: llmFallback.value.minPostMergeScore,
        contextLines: llmFallback.value.contextLines,
        minMode: llmFallback.value.minMode,
      },
    };
    await writeGitwandrc(props.cwd!, next);
    llmFallbackRcCache.value = next;
    llmFallbackSaveSuccess.value = true;
    // Auto-dismiss the success message after 2s, same UX as the
    // Claude Connect success badge above.
    setTimeout(() => {
      llmFallbackSaveSuccess.value = false;
    }, 2000);
  } catch (e) {
    llmFallbackSaveError.value = (e as Error).message || String(e);
  } finally {
    llmFallbackSaving.value = false;
  }
}

function onLlmFallbackEnabledChange(e: Event) {
  llmFallback.value.enabled = (e.target as HTMLInputElement).checked;
}

function onLlmFallbackProviderChange(val: LlmFallbackProvider) {
  llmFallback.value.provider = val;
}

function onLlmFallbackMinScoreChange(val: number) {
  llmFallback.value.minPostMergeScore = Math.max(50, Math.min(100, Math.round(val)));
}

function onLlmFallbackContextLinesChange(val: number) {
  llmFallback.value.contextLines = Math.max(10, Math.min(200, Math.round(val)));
}

function onLlmFallbackMinModeChange(val: MinMode) {
  llmFallback.value.minMode = val;
}

onMounted(() => {
  detectOllama();
  // Lazy-detect both CLI providers at mount so the dropdown can grey out
  // missing ones without waiting for the user to pick the option first.
  // Both are fast — just `which` + `--version`.
  runClaudeCliDetect();
  runCodexCliDetect();
});

// Reload `.gitwandrc` when the active repo changes (or on first mount
// if `cwd` is already set). All refs read inside the handler are
// declared above, so this `immediate: true` watcher is TDZ-safe.
watch(
  () => props.cwd,
  () => {
    loadLlmFallback();
  },
  { immediate: true },
);

</script>

<template>
  <BaseModal
    size="md"
    :title="t('settings.title')"
    @close="emit('close')"
  >
    <template #title-icon>
      <span class="sp-title-icon" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.6" />
          <path
            d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linejoin="round"
          />
        </svg>
      </span>
    </template>

    <template #toolbar>
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
          <!-- Hooks icon -->
          <svg v-else-if="tab.icon === 'hooks'" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
            <path d="M3 4l2 2-2 2M7 8h6" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M3 12h10" stroke-linecap="round"/>
          </svg>
          <!-- Automations icon -->
          <svg v-else-if="tab.icon === 'automations'" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8 1v2m0 10v2M1 8h2m10 0h2"/>
            <path d="M5.5 5.5L4 4M11.5 11.5L10 10M10.5 5.5L12 4M4.5 11.5L3 13"/>
            <circle cx="8" cy="8" r="2.5"/>
          </svg>
          <!-- Logs icon -->
          <svg v-else-if="tab.icon === 'logs'" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
            <path d="M2 4h12M2 8h8M2 12h6" stroke-linecap="round"/>
          </svg>
          <span>{{ tab.id === 'general' ? t('settings.tabGeneral') : tab.id === 'git' ? t('settings.tabGit') : tab.id === 'editor' ? t('settings.tabEditor') : tab.id === 'ai' ? t('settings.tabAi') : tab.id === 'automations' ? t('settings.tabAutomations') : tab.id === 'hooks' ? t('settings.tabHooks') : t('settings.tabLogs') }}</span>
          <!-- Error count badge on Logs tab -->
          <span v-if="tab.id === 'logs' && (props.errorLog?.length ?? 0) > 0" class="sp-tab-badge">
            {{ props.errorLog!.length > 99 ? '99+' : props.errorLog!.length }}
          </span>
        </button>
      </div>
    </template>

    <!-- Tab content -->
    <div class="sp-body">

      <!-- ═══ GÉNÉRAL ═══ -->
        <template v-if="activeSettingsTab === 'general'">
          <!-- Interface language -->
          <div class="sp-row">
            <label class="sp-label" for="setting-lang">{{ t('settings.language') }}</label>
            <select id="setting-lang" class="sp-select" v-model="selectedLocale">
              <option value="auto">{{ t('settings.languageAuto') }}</option>
              <option v-for="loc in supportedLocales" :key="loc" :value="loc">{{ localeLabels[loc] }}</option>
            </select>
          </div>

          <!-- Commit message language -->
          <div class="sp-row">
            <label class="sp-label" for="setting-commit-lang">{{ t('settings.commitMessageLang') }}</label>
            <select
              id="setting-commit-lang" class="sp-select"
              :value="settings.commitMessageLang"
              @change="updateSetting('commitMessageLang', ($event.target as HTMLSelectElement).value)"
            >
              <option value="">{{ t('settings.commitMessageLangAuto') }}</option>
              <option v-for="loc in supportedLocales" :key="loc" :value="loc">{{ localeLabels[loc] }}</option>
            </select>
            <span class="sp-hint">{{ t('settings.commitMessageLangHint') }}</span>
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

          <!-- Auto-update channel (v2.0) -->
          <div class="sp-row">
            <label class="sp-label" for="setting-update-channel">{{ t('settings.updateChannelLabel') }}</label>
            <select
              id="setting-update-channel" class="sp-select"
              :value="settings.updateChannel"
              @change="updateSetting('updateChannel', ($event.target as HTMLSelectElement).value as 'stable' | 'beta')"
            >
              <option value="stable">{{ t('settings.updateChannelStable') }}</option>
              <option value="beta">{{ t('settings.updateChannelBeta') }}</option>
            </select>
            <span class="sp-hint">
              {{ settings.updateChannel === 'beta' ? t('settings.updateChannelBetaHint') : t('settings.updateChannelStableHint') }}
            </span>
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

          <!-- Blame diff algorithm -->
          <div class="sp-row">
            <label class="sp-label" for="setting-blame-algo">{{ t('settings.blameAlgorithm') }}</label>
            <select
              id="setting-blame-algo"
              class="sp-select"
              :value="settings.blameAlgorithm"
              @change="updateSetting('blameAlgorithm', ($event.target as HTMLSelectElement).value as BlameAlgorithm)"
            >
              <option value="histogram">histogram {{ t('settings.blameAlgoRecommended') }}</option>
              <option value="patience">patience</option>
              <option value="minimal">minimal</option>
              <option value="myers">myers</option>
            </select>
            <span class="sp-hint">{{ t('settings.blameAlgorithmHint') }}</span>
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
              <span>{{ t('settings.aiEnable') }}</span>
            </label>
            <span class="sp-hint">{{ t('settings.aiEnableHint') }}</span>
          </div>

          <template v-if="settings.aiEnabled">
            <!-- Provider -->
            <div class="sp-row">
              <label class="sp-label" for="setting-ai-provider">{{ t('settings.aiProviderLabel') }}</label>
              <select
                id="setting-ai-provider" class="sp-select"
                :value="settings.aiProvider"
                @change="onAIProviderChange(($event.target as HTMLSelectElement).value as AIProvider)"
              >
                <option value="claude">{{ t('settings.aiProviderClaude') }}</option>
                <option value="claude-code-cli">
                  {{ t('settings.aiProviderClaudeCli') }}{{ claudeCliInfo && !claudeCliInfo.found ? t('settings.aiProviderClaudeCliNotFound') : '' }}
                </option>
                <option value="codex-cli">
                  {{ t('settings.aiProviderCodexCli') }}{{ codexCliInfo && !codexCliInfo.found ? t('settings.aiProviderCodexCliNotFound') : '' }}
                </option>
                <option value="openai-compat">{{ t('settings.aiProviderOpenAiCompat') }}</option>
                <option value="ollama" :disabled="!ollamaAvailable">
                  {{ t('settings.aiProviderOllama') }}{{ ollamaAvailable ? '' : t('settings.aiProviderOllamaNotFound') }}
                </option>
              </select>
            </div>

            <!-- Claude provider -->
            <template v-if="settings.aiProvider === 'claude'">
              <!-- Auth mode selector -->
              <div class="sp-row">
                <div class="sp-label">{{ t('settings.aiAuthLabel') }}</div>
                <div class="sp-auth-toggle">
                  <button
                    :class="['sp-auth-btn', { 'sp-auth-btn--active': claudeAuthMode === 'connect' }]"
                    @click="claudeAuthMode = 'connect'"
                  >
                    {{ t('settings.aiAuthConnect') }}
                  </button>
                  <button
                    :class="['sp-auth-btn', { 'sp-auth-btn--active': claudeAuthMode === 'apikey' }]"
                    @click="claudeAuthMode = 'apikey'"
                  >
                    {{ t('settings.aiAuthApiKey') }}
                  </button>
                </div>
              </div>

              <!-- Connect flow -->
              <template v-if="claudeAuthMode === 'connect'">
                <div v-if="settings.aiApiKey" class="sp-row">
                  <div class="sp-connected-badge">
                    <span class="sp-connected-dot"></span>
                    <span>{{ t('settings.aiAuthConnected', maskedApiKey) }}</span>
                    <button class="sp-disconnect-btn" @click="disconnectClaude">{{ t('settings.aiAuthDisconnect') }}</button>
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
                        {{ t('settings.aiConnectButton') }}
                      </button>
                      <span class="sp-hint">{{ t('settings.aiConnectHint') }}</span>
                    </div>

                    <!-- Step 2: Waiting for key -->
                    <div v-if="claudeConnectStep === 'waiting'" class="sp-connect-waiting">
                      <p class="sp-connect-instruction">
                        {{ t('settings.aiConnectInstruction1') }}<br />
                        {{ t('settings.aiConnectInstruction2') }}
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
                          {{ t('settings.aiConnectSave') }}
                        </button>
                      </div>
                      <div v-if="claudeConnectError" class="sp-connect-error">{{ claudeConnectError }}</div>
                      <button class="sp-text-btn" @click="claudeConnectStep = 'idle'">{{ t('settings.aiConnectCancel') }}</button>
                    </div>

                    <!-- Step 3: Success -->
                    <div v-if="claudeConnectStep === 'success'" class="sp-connect-success">
                      {{ t('settings.aiConnectSuccess') }}
                    </div>

                    <!-- Step 3b: Error -->
                    <div v-if="claudeConnectStep === 'error'" class="sp-connect-error-block">
                      <div class="sp-connect-error">{{ claudeConnectError }}</div>
                      <button class="sp-text-btn" @click="claudeConnectStep = 'waiting'">{{ t('settings.aiConnectRetry') }}</button>
                    </div>
                  </div>
                </div>
              </template>

              <!-- Manual API key mode -->
              <template v-if="claudeAuthMode === 'apikey'">
                <div class="sp-row">
                  <label class="sp-label" for="setting-ai-key">{{ t('settings.aiApiKeyLabel') }}</label>
                  <div class="sp-key-row">
                    <input
                      id="setting-ai-key"
                      class="sp-input mono sp-input--key"
                      :type="showApiKey ? 'text' : 'password'"
                      :value="settings.aiApiKey"
                      @input="updateSetting('aiApiKey', ($event.target as HTMLInputElement).value)"
                      placeholder="sk-ant-api03-..."
                    />
                    <button class="sp-key-toggle" @click="showApiKey = !showApiKey" :title="showApiKey ? t('settings.aiHideKey') : t('settings.aiShowKey')">
                      <svg v-if="showApiKey" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
                        <path d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z"/><circle cx="8" cy="8" r="2"/>
                      </svg>
                      <svg v-else width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
                        <path d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z"/><circle cx="8" cy="8" r="2"/><path d="M3 13L13 3" stroke-width="1.5"/>
                      </svg>
                    </button>
                  </div>
                  <span class="sp-hint">{{ t('settings.aiApiKeyAvailable') }} <a href="https://console.anthropic.com/settings/keys" target="_blank" class="sp-link">console.anthropic.com</a></span>
                </div>
              </template>

              <div class="sp-row">
                <label class="sp-label" for="setting-ai-model-claude">{{ t('settings.aiModelLabel') }}</label>
                <select
                  id="setting-ai-model-claude" class="sp-select"
                  :value="settings.aiModel"
                  @change="updateSetting('aiModel', ($event.target as HTMLSelectElement).value)"
                >
                  <option value="claude-sonnet-4-20250514">{{ t('settings.aiModelSonnet') }}</option>
                  <option value="claude-haiku-4-5-20251001">{{ t('settings.aiModelHaiku') }}</option>
                  <option value="claude-opus-4-20250514">{{ t('settings.aiModelOpus') }}</option>
                </select>
              </div>
            </template>

            <!-- Claude Code CLI provider (piggyback on user's subscription) -->
            <template v-if="settings.aiProvider === 'claude-code-cli'">
              <div class="sp-row">
                <div class="sp-label">{{ t('settings.aiCliStatus') }}</div>
                <div class="sp-cli-status">
                  <template v-if="claudeCliDetecting">
                    <span class="sp-hint">{{ t('settings.aiCliDetecting') }}</span>
                  </template>
                  <template v-else-if="!claudeCliInfo || !claudeCliInfo.found">
                    <div class="sp-connect-error-block">
                      <div class="sp-connect-error">
                        {{ t('settings.aiCliNotFound') }} <code>claude</code> {{ t('settings.aiCliNotFoundSuffix') }}
                      </div>
                      <span class="sp-hint">
                        {{ t('settings.aiCliInstallHint') }}
                        <code>npm install -g @anthropic-ai/claude-code</code>
                        {{ t('settings.aiCliInstallHintSuffix') }}
                      </span>
                      <button class="sp-text-btn" @click="runClaudeCliDetect">{{ t('settings.aiCliRedetect') }}</button>
                    </div>
                  </template>
                  <template v-else-if="claudeCliInfo.logged_in">
                    <div class="sp-connected-badge">
                      <span class="sp-connected-dot"></span>
                      <span>{{ t('settings.aiCliConnected', claudeCliInfo.version || 'claude') }}</span>
                      <button class="sp-disconnect-btn" @click="runClaudeCliDetect">{{ t('settings.aiCliRedetect') }}</button>
                    </div>
                    <span class="sp-hint">{{ t('settings.aiCliConnectedHint') }}</span>
                  </template>
                  <template v-else-if="claudeCliInfo.status === 'detected'">
                    <!-- R6/#6 — Detected but auth NOT verified. We no
                         longer send an unsolicited `claude -p ping` prompt
                         at panel mount (would bill the user's account for
                         a check they didn't ask for). Auth is verified
                         implicitly on first real use. -->
                    <div class="sp-connected-badge">
                      <span class="sp-connected-dot sp-connected-dot--neutral"></span>
                      <span>{{ t('settings.aiCliDetected', claudeCliInfo.version || 'claude') }}</span>
                      <button class="sp-disconnect-btn" @click="runClaudeCliDetect">{{ t('settings.aiCliRedetect') }}</button>
                    </div>
                    <span class="sp-hint">{{ t('settings.aiCliDetectedHint') }}</span>
                  </template>
                  <template v-else>
                    <div class="sp-connect-error-block">
                      <div class="sp-connect-error">
                        {{ t('settings.aiCliNotAuthenticated') }}
                      </div>
                      <span class="sp-hint">{{ claudeCliInfo.detail || t('settings.aiCliLoginHint') }}</span>
                      <button
                        class="sp-connect-btn"
                        :disabled="claudeCliLoginLoading"
                        @click="runClaudeCliLogin"
                      >
                        {{ claudeCliLoginLoading ? t('settings.aiCliLoginWaiting') : t('settings.aiCliLoginButton') }}
                      </button>
                    </div>
                  </template>
                </div>
              </div>

              <div v-if="claudeCliInfo?.logged_in" class="sp-info-box">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
                  <circle cx="8" cy="8" r="7"/><path d="M8 7v4" stroke-linecap="round"/><circle cx="8" cy="5" r="0.7" fill="currentColor" stroke="none"/>
                </svg>
                <p>{{ t('settings.aiCliInfoBox') }}</p>
              </div>
            </template>

            <!-- Codex CLI provider (v2.0) — same shape as Claude CLI block -->
            <template v-if="settings.aiProvider === 'codex-cli'">
              <div class="sp-row">
                <div class="sp-label">{{ t('settings.aiCliStatus') }}</div>
                <div class="sp-cli-status">
                  <template v-if="codexCliDetecting">
                    <span class="sp-hint">{{ t('settings.aiCliDetecting') }}</span>
                  </template>
                  <template v-else-if="!codexCliInfo || !codexCliInfo.found">
                    <div class="sp-connect-error-block">
                      <div class="sp-connect-error">
                        {{ t('settings.aiCliNotFound') }} <code>codex</code> {{ t('settings.aiCliNotFoundSuffix') }}
                      </div>
                      <span class="sp-hint">
                        {{ t('settings.aiCliInstallHint') }}
                        <code>npm install -g @openai/codex</code>
                        {{ t('settings.aiCliInstallHintSuffix') }}
                      </span>
                      <button class="sp-text-btn" @click="runCodexCliDetect">{{ t('settings.aiCliRedetect') }}</button>
                    </div>
                  </template>
                  <template v-else-if="codexCliInfo.logged_in">
                    <div class="sp-connected-badge">
                      <span class="sp-connected-dot"></span>
                      <span>{{ t('settings.aiCliConnected', codexCliInfo.version || 'codex') }}</span>
                      <button class="sp-disconnect-btn" @click="runCodexCliDetect">{{ t('settings.aiCliRedetect') }}</button>
                    </div>
                    <span class="sp-hint">{{ t('settings.aiCodexCliConnectedHint') }}</span>
                  </template>
                  <template v-else-if="codexCliInfo.status === 'detected'">
                    <!-- Detected, auth not verified — see Claude block above. -->
                    <div class="sp-connected-badge">
                      <span class="sp-connected-dot sp-connected-dot--neutral"></span>
                      <span>{{ t('settings.aiCliDetected', codexCliInfo.version || 'codex') }}</span>
                      <button class="sp-disconnect-btn" @click="runCodexCliDetect">{{ t('settings.aiCliRedetect') }}</button>
                    </div>
                    <span class="sp-hint">{{ t('settings.aiCliDetectedHint') }}</span>
                  </template>
                  <template v-else>
                    <div class="sp-connect-error-block">
                      <div class="sp-connect-error">
                        {{ t('settings.aiCliNotAuthenticated') }}
                      </div>
                      <span class="sp-hint">{{ codexCliInfo.detail || t('settings.aiCodexCliLoginHint') }}</span>
                      <button class="sp-text-btn" @click="runCodexCliDetect">{{ t('settings.aiCliRedetect') }}</button>
                    </div>
                  </template>
                </div>
              </div>

              <div v-if="codexCliInfo?.logged_in" class="sp-info-box">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
                  <circle cx="8" cy="8" r="7"/><path d="M8 7v4" stroke-linecap="round"/><circle cx="8" cy="5" r="0.7" fill="currentColor" stroke="none"/>
                </svg>
                <p>{{ t('settings.aiCodexCliInfoBox') }}</p>
              </div>
            </template>

            <!-- OpenAI-compatible provider -->
            <template v-if="settings.aiProvider === 'openai-compat'">
              <div class="sp-row">
                <label class="sp-label" for="setting-ai-endpoint">{{ t('settings.aiCompatEndpoint') }}</label>
                <input
                  id="setting-ai-endpoint" class="sp-input mono" type="text"
                  :value="settings.aiApiEndpoint"
                  @input="updateSetting('aiApiEndpoint', ($event.target as HTMLInputElement).value)"
                  placeholder="https://api.openai.com/v1"
                />
                <span class="sp-hint">{{ t('settings.aiCompatEndpointHint') }}</span>
              </div>

              <div class="sp-row">
                <label class="sp-label" for="setting-ai-key-compat">{{ t('settings.aiCompatApiKey') }}</label>
                <div class="sp-key-row">
                  <input
                    id="setting-ai-key-compat"
                    class="sp-input mono sp-input--key"
                    :type="showApiKey ? 'text' : 'password'"
                    :value="settings.aiApiKey"
                    @input="updateSetting('aiApiKey', ($event.target as HTMLInputElement).value)"
                    placeholder="sk-..."
                  />
                  <button class="sp-key-toggle" @click="showApiKey = !showApiKey" :title="showApiKey ? t('settings.aiHideKey') : t('settings.aiShowKey')">
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
                <label class="sp-label" for="setting-ai-model-compat">{{ t('settings.aiModelLabel') }}</label>
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
                <label class="sp-label" for="setting-ai-ollama-url">{{ t('settings.aiOllamaUrl') }}</label>
                <div class="sp-key-row">
                  <input
                    id="setting-ai-ollama-url" class="sp-input mono sp-input--key" type="text"
                    :value="settings.aiOllamaUrl"
                    @input="updateSetting('aiOllamaUrl', ($event.target as HTMLInputElement).value)"
                    placeholder="http://localhost:11434"
                  />
                  <button class="sp-key-toggle" @click="detectOllama" :title="t('settings.aiOllamaTest')">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
                      <path d="M14 8A6 6 0 112 8" /><path d="M14 8l-2-2m2 2l-2 2"/>
                    </svg>
                  </button>
                </div>
                <span class="sp-hint" :class="{ 'sp-hint--ok': ollamaAvailable }">
                  {{ ollamaAvailable ? t('settings.aiOllamaConnected', ollamaModels.length) : t('settings.aiOllamaNotConnected') }}
                </span>
              </div>

              <div class="sp-row" v-if="ollamaAvailable">
                <label class="sp-label" for="setting-ai-ollama-model">{{ t('settings.aiModelLabel') }}</label>
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
              <p>{{ t('settings.aiPrivacyNote') }}</p>
            </div>
          </template>

          <!-- ─── AI fallback (v2.5 — .gitwandrc per-repo) ─────── -->
          <div class="sp-section-divider"></div>

          <h3 class="sp-section-title">{{ t('settings.ai.fallback.title') }}</h3>

          <!-- No repo open → disable the entire block with an info message -->
          <div v-if="!llmFallbackHasRepo" class="sp-info-box">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
              <circle cx="8" cy="8" r="7"/><path d="M8 7v4" stroke-linecap="round"/><circle cx="8" cy="5" r="0.7" fill="currentColor" stroke="none"/>
            </svg>
            <p>{{ t('settings.ai.fallback.noRepo.message') }}</p>
          </div>

          <template v-else>
            <!-- Enable toggle + disclaimer -->
            <div class="sp-row sp-row--checkbox">
              <label class="sp-checkbox-label" for="setting-llm-fallback-enabled">
                <input
                  id="setting-llm-fallback-enabled"
                  type="checkbox"
                  class="sp-checkbox"
                  :checked="llmFallback.enabled"
                  :disabled="llmFallbackLoading"
                  @change="onLlmFallbackEnabledChange"
                />
                <span>{{ t('settings.ai.fallback.enable.label') }}</span>
              </label>
              <span class="sp-hint">{{ t('settings.ai.fallback.enable.help') }}</span>
            </div>

            <div v-if="llmFallback.enabled" class="sp-warning-box">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
                <path d="M8 1.5L1 14h14L8 1.5z" stroke-linejoin="round"/>
                <path d="M8 6v4" stroke-linecap="round"/>
                <circle cx="8" cy="12" r="0.7" fill="currentColor" stroke="none"/>
              </svg>
              <p>{{ t('settings.ai.fallback.warning') }}</p>
            </div>

            <!-- Policy conflict warning -->
            <div v-if="llmFallback.enabled && llmFallbackPolicyConflict" class="sp-info-box sp-info-box--warning">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
                <circle cx="8" cy="8" r="7"/><path d="M8 5v4" stroke-linecap="round"/><circle cx="8" cy="11.5" r="0.7" fill="currentColor" stroke="none"/>
              </svg>
              <p>{{ t('settings.ai.fallback.policyConflict.warning') }}</p>
            </div>

            <template v-if="llmFallback.enabled">
              <!-- Provider -->
              <div class="sp-row">
                <label class="sp-label" for="setting-llm-fallback-provider">{{ t('settings.ai.fallback.provider.label') }}</label>
                <select
                  id="setting-llm-fallback-provider"
                  class="sp-select"
                  :value="llmFallback.provider"
                  @change="onLlmFallbackProviderChange(($event.target as HTMLSelectElement).value as LlmFallbackProvider)"
                >
                  <option value="claude">{{ t('settings.aiProviderClaude') }}</option>
                  <option value="claude-code-cli">{{ t('settings.aiProviderClaudeCli') }}</option>
                  <option value="codex-cli">{{ t('settings.aiProviderCodexCli') }}</option>
                  <option value="openai-compat">{{ t('settings.aiProviderOpenAiCompat') }}</option>
                  <option value="ollama">{{ t('settings.aiProviderOllama') }}</option>
                  <option value="mcp">MCP (Claude Code / Cursor)</option>
                </select>
              </div>

              <!-- Min post-merge score (slider 50-100) -->
              <div class="sp-row">
                <label class="sp-label" for="setting-llm-fallback-min-score">{{ t('settings.ai.fallback.minScore.label') }}</label>
                <div class="sp-range-row">
                  <input
                    id="setting-llm-fallback-min-score"
                    type="range"
                    class="sp-range"
                    min="50"
                    max="100"
                    step="1"
                    :value="llmFallback.minPostMergeScore"
                    @input="onLlmFallbackMinScoreChange(Number(($event.target as HTMLInputElement).value))"
                  />
                  <span class="sp-range-value">{{ llmFallback.minPostMergeScore }}</span>
                </div>
                <span class="sp-hint">{{ t('settings.ai.fallback.minScore.help') }}</span>
              </div>

              <!-- Context lines (input number 10-200) -->
              <div class="sp-row">
                <label class="sp-label" for="setting-llm-fallback-context-lines">{{ t('settings.ai.fallback.contextLines.label') }}</label>
                <input
                  id="setting-llm-fallback-context-lines"
                  type="number"
                  class="sp-input"
                  min="10"
                  max="200"
                  step="1"
                  :value="llmFallback.contextLines"
                  @input="onLlmFallbackContextLinesChange(Number(($event.target as HTMLInputElement).value))"
                />
              </div>

              <!-- Min mode -->
              <div class="sp-row">
                <label class="sp-label" for="setting-llm-fallback-min-mode">{{ t('settings.ai.fallback.minMode.label') }}</label>
                <select
                  id="setting-llm-fallback-min-mode"
                  class="sp-select"
                  :value="llmFallback.minMode"
                  @change="onLlmFallbackMinModeChange(($event.target as HTMLSelectElement).value as MinMode)"
                >
                  <option value="off">off</option>
                  <option value="balanced">balanced</option>
                  <option value="strict">strict</option>
                </select>
              </div>
            </template>

            <!-- Save button (always visible when a repo is open) -->
            <div class="sp-row">
              <button
                class="bm-btn bm-btn--primary sp-llm-save-btn"
                :disabled="llmFallbackSaving || llmFallbackLoading"
                @click="saveLlmFallback"
              >
                {{ llmFallbackSaving ? t('common.loading') : t('settings.ai.fallback.save.button') }}
              </button>
              <span v-if="llmFallbackSaveSuccess" class="sp-hint sp-hint--ok">{{ t('settings.ai.fallback.save.button') }} OK</span>
              <span v-if="llmFallbackSaveError" class="sp-connect-error">{{ llmFallbackSaveError }}</span>
            </div>
          </template>
        </template>

        <!-- ═══ AUTOMATIONS ═══ -->
        <template v-if="activeSettingsTab === 'automations'">
          <AutomationsPanel />
        </template>

        <!-- ═══ HOOKS ═══ -->
        <template v-if="activeSettingsTab === 'hooks'">
          <HooksPanel v-if="props.cwd" :cwd="props.cwd" />
          <div v-else class="sp-logs-empty">{{ t('hooks.empty') }}</div>
        </template>

        <!-- ═══ LOGS ═══ -->
        <template v-if="activeSettingsTab === 'logs'">
          <div class="sp-logs-header">
            <h3 class="sp-section-title">{{ t('settings.logsTitle') }}</h3>
            <button v-if="(props.errorLog?.length ?? 0) > 0" class="bm-btn bm-btn--ghost" @click="emit('clearLogs')">
              {{ t('settings.logsClear') }}
            </button>
          </div>
          <div v-if="!props.errorLog?.length" class="sp-logs-empty">{{ t('settings.logsEmpty') }}</div>
          <ul v-else class="sp-logs-list">
            <li v-for="entry in [...(props.errorLog ?? [])].reverse()" :key="entry.ts" class="sp-log-entry">
              <span class="sp-log-time">{{ new Date(entry.ts).toLocaleTimeString() }}</span>
              <span class="sp-log-msg">{{ entry.msg }}</span>
            </li>
          </ul>
        </template>

    </div>
  </BaseModal>
</template>

<style scoped>
.sp-title-icon {
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

/* ─── Tab bar ──────────────────────────────────────────── */
/* Sits inside BaseModal's #toolbar slot. Negative margin cancels the
 * toolbar's own padding so the active-tab underline hugs the toolbar's
 * bottom border, while we restore horizontal padding for the strip. */
.sp-tabs {
  display: flex;
  gap: 0;
  margin: calc(-1 * var(--space-4)) calc(-1 * var(--space-7));
  padding: 0 var(--space-7);
  /* Scrollable when tabs overflow (7+ tabs) */
  overflow-x: auto;
  scrollbar-width: none; /* Firefox */
}
.sp-tabs::-webkit-scrollbar { display: none; } /* Chrome/Safari */

.sp-tab {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-4) var(--space-4);
  font-size: 13px;
  font-weight: var(--font-weight-medium);
  color: var(--color-text-muted);
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  transition: color var(--transition-fast), border-color var(--transition-fast);
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
  padding: var(--space-6) var(--space-7);
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  overflow-y: auto;
  min-height: 180px;
}

.sp-row {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.sp-label {
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.sp-select,
.sp-input {
  padding: var(--space-4) var(--space-3);
  font-size: var(--font-size-md);
  background: var(--color-bg);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  outline: none;
  transition: border-color var(--transition-base);
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
  background-position: right var(--space-3) center;
  padding-right: var(--space-8);
}

.sp-input::placeholder {
  color: var(--color-text-muted);
}

.sp-row--checkbox {
  gap: var(--space-2);
}

.sp-checkbox-label {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  font-size: var(--font-size-md);
  cursor: pointer;
}

.sp-checkbox {
  width: 16px;
  height: 16px;
  accent-color: var(--color-accent);
  cursor: pointer;
}

.sp-hint {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}

.sp-row--checkbox .sp-hint {
  padding-left: var(--space-8);
}

.sp-hint--ok {
  color: var(--color-success);
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
  gap: var(--space-3);
}

.sp-range {
  flex: 1;
  accent-color: var(--color-accent);
  cursor: pointer;
  height: 4px;
}

.sp-range-value {
  font-size: var(--font-size-base);
  color: var(--color-text-muted);
  min-width: 36px;
  text-align: right;
}

/* ─── API key row ──────────────────────────────────────── */
.sp-key-row {
  display: flex;
  gap: var(--space-3);
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
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  cursor: pointer;
  transition: color var(--transition-fast), border-color var(--transition-fast);
}

.sp-key-toggle:hover {
  color: var(--color-text);
  border-color: var(--color-accent);
}

/* ─── Info box ─────────────────────────────────────────── */
.sp-info-box {
  display: flex;
  gap: var(--space-3);
  padding: var(--space-5) var(--space-5);
  border-radius: var(--radius-md);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  font-size: var(--font-size-base);
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
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.sp-auth-btn {
  flex: 1;
  padding: var(--space-1) var(--space-5);
  font-size: var(--font-size-base);
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: all var(--transition-base);
}

.sp-auth-btn:first-child { border-right: 1px solid var(--color-border); }

.sp-auth-btn--active {
  background: var(--color-accent);
  color: var(--color-accent-text);
  font-weight: var(--font-weight-semibold);
}

.sp-connect-flow {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.sp-connect-start {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.sp-connect-btn {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-6);
  border-radius: var(--radius-md);
  border: 1px solid var(--color-accent);
  background: var(--color-accent-soft);
  color: var(--color-accent);
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
  transition: all var(--transition-base);
}

.sp-connect-btn:hover {
  opacity: 0.8;
}

.sp-connect-waiting {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.sp-connect-instruction {
  font-size: var(--font-size-base);
  color: var(--color-text-muted);
  line-height: 1.6;
  margin: 0;
}

.sp-connect-save-btn {
  padding: var(--space-2) var(--space-5);
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  background: var(--color-accent);
  color: var(--color-accent-text);
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
  white-space: nowrap;
  transition: filter var(--transition-base);
}

.sp-connect-save-btn:hover { filter: brightness(1.1); }
.sp-connect-save-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.sp-connect-error {
  font-size: 12px;
  color: var(--color-danger);
}

.sp-connect-error-block {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.sp-connect-success {
  font-size: var(--font-size-md);
  color: var(--color-success);
  font-weight: var(--font-weight-semibold);
  padding: var(--space-4);
  background: var(--color-success-soft);
  border-radius: var(--radius-sm);
  text-align: center;
}

.sp-text-btn {
  background: none;
  border: none;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  cursor: pointer;
  text-decoration: underline;
  padding: 0;
  align-self: flex-start;
}

.sp-text-btn:hover { color: var(--color-text); }

.sp-cli-status {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.sp-cli-status code {
  font-family: var(--font-mono, monospace);
  font-size: 0.9em;
  padding: 0 var(--space-2);
  background: var(--color-bg);
  border-radius: var(--radius-xs);
}

.sp-connected-badge {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-5);
  border-radius: var(--radius-sm);
  background: var(--color-success-soft);
  border: 1px solid var(--color-success);
  font-size: var(--font-size-base);
  color: var(--color-success);
}

.sp-connected-dot {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-pill);
  background: var(--color-success);
  flex-shrink: 0;
}

/* Neutral variant — shown when a CLI is detected but auth wasn't
   verified (we skip the unsolicited ping at panel mount). */
.sp-connected-dot--neutral {
  background: var(--color-text-subtle);
}

.sp-disconnect-btn {
  margin-left: auto;
  padding: var(--space-1) var(--space-4);
  border-radius: var(--radius-sm);
  border: 1px solid rgba(243, 139, 168, 0.4);
  background: transparent;
  color: var(--color-error, #f38ba8);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: all var(--transition-base);
}

.sp-disconnect-btn:hover {
  background: rgba(243, 139, 168, 0.15);
}

/* ─── Tab badge ────────────────────────────────────────── */
.sp-tab-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-pill);
  background: var(--color-error, #f38ba8);
  color: #fff;
  font-size: 10px;
  font-weight: var(--font-weight-semibold);
  line-height: 1;
}

/* ─── Logs tab ─────────────────────────────────────────── */
.sp-logs-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

.sp-logs-empty {
  padding: var(--space-8) 0;
  text-align: center;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}

.sp-logs-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.sp-log-entry {
  display: flex;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  font-size: var(--font-size-sm);
  line-height: 1.5;
}

.sp-log-time {
  color: var(--color-text-muted);
  white-space: nowrap;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.sp-log-msg {
  color: var(--color-error, #f38ba8);
  word-break: break-word;
}

/* ─── v2.5 LLM fallback section ─────────────────────────── */
.sp-section-divider {
  height: 1px;
  background: var(--color-border);
  margin: var(--space-3) 0;
}

.sp-section-title {
  margin: 0;
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text);
}

.sp-warning-box {
  display: flex;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  border-radius: var(--radius-md);
  background: var(--color-danger-soft, rgba(220, 80, 80, 0.08));
  border: 1px solid var(--color-danger, #d65d5d);
  color: var(--color-danger, #d65d5d);
  font-size: var(--font-size-base);
  line-height: 1.5;
}

.sp-warning-box svg {
  flex-shrink: 0;
  margin-top: 1px;
}

.sp-warning-box p {
  margin: 0;
}

.sp-info-box--warning {
  border-color: var(--color-warning, #d39e3a);
  color: var(--color-warning, #d39e3a);
}

.sp-llm-save-btn {
  align-self: flex-start;
}

</style>
