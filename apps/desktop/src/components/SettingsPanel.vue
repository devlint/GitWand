<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { useI18n } from "../composables/useI18n";
import { useTheme } from "../composables/useTheme";
import BaseModal from "./BaseModal.vue";
import HooksPanel from "./HooksPanel.vue";
import AutomationsPanel from "./AutomationsPanel.vue";
import SettingsAccountsTab from "./SettingsAccountsTab.vue";
import SettingsMcpTab from "./SettingsMcpTab.vue";
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
  detectOpencodeCli,
  type OpencodeCliInfo,
  detectCopilotCli,
  type CopilotCliInfo,
  readGitwandrc,
  writeGitwandrc,
  checkForUpdates,
  fetchBetaUpdate,
  type UpdateInfo,
} from "../utils/backend";

const { t, locale, isAuto, setLocale } = useI18n();
const { theme, setTheme } = useTheme();

const appVersion = __APP_VERSION__;

// ─── Update check ────────────────────────────────────────
type UpdateCheckStatus = "idle" | "checking" | "upToDate";
const updateCheckStatus = ref<UpdateCheckStatus>("idle");
let _upToDateTimer: ReturnType<typeof setTimeout> | null = null;

async function runUpdateCheck() {
  if (updateCheckStatus.value === "checking") return;
  updateCheckStatus.value = "checking";
  try {
    const channel = settings.value.updateChannel ?? "stable";
    const info = channel === "beta"
      ? await fetchBetaUpdate(appVersion)
      : await checkForUpdates();
    if (info) {
      updateCheckStatus.value = "idle";
      emit("openUpdateModal", info);
    } else {
      updateCheckStatus.value = "upToDate";
      if (_upToDateTimer) clearTimeout(_upToDateTimer);
      _upToDateTimer = setTimeout(() => { updateCheckStatus.value = "idle"; }, 4000);
    }
  } catch {
    updateCheckStatus.value = "idle";
  }
}

export type PullMode = "merge" | "rebase";
export type SwitchBehavior = "stash" | "ask" | "refuse";
export type NotificationLevel = "all" | "reviews" | "ci" | "none";
// Single source of truth for the provider union — re-export so other files
// importing from SettingsPanel don't break, but the canonical declaration
// lives in `useAIProvider`.
import {
  type AIProvider,
  CLI_AGENT_PROVIDERS,
  listModelsForProvider,
} from "../composables/useAIProvider";
import { useLogs, type LogEntry } from "../composables/useLogs";
import { useIdentity } from "../composables/useIdentity";
import { useCommitTemplates } from "../composables/useCommitTemplates";
import { useAiPromptPresets, BUILTIN_PRESETS } from "../composables/useAiPromptPresets";
import { useReleaseNoteTemplates } from "../composables/useReleaseNoteTemplates";
import type { IdentityProfile, CommitTemplate, AiPromptPreset, DockEntryId, ReleaseNoteTemplate } from "../composables/useSettings";
import { DEFAULT_DOCK_ORDER, normalizeDockOrder, refreshSettings as refreshSharedSettings } from "../composables/useSettings";
import { gitCommitTemplatePath, openExternalUrl } from "../utils/backend";
export type { AIProvider };

// Re-export for back-compat — earlier callers imported this shape from
// SettingsPanel. The canonical definition lives in `useLogs.ts`.
export type ErrorLogEntry = LogEntry;

const props = defineProps<{
  /** Accumulated error log passed down from App.vue */
  errorLog?: LogEntry[];
  /** Open directly on this tab (e.g. "logs" when clicking the error badge) */
  initialTab?: "general" | "dock" | "dashboard" | "git" | "editor" | "ai" | "automations" | "logs" | "hooks" | "accounts" | "mcp" | "releaseNotes";
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
  openUpdateModal: [info: UpdateInfo];
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
  prAiLanguage: "english" | "ui";
  diffMode: DiffMode;
  pullMode: PullMode;
  switchBehavior: SwitchBehavior;
  fontSize: number;
  tabSize: number;
  notifications: boolean;
  notificationLevel: NotificationLevel;
  notificationsByPeople: boolean;
  blameAlgorithm: BlameAlgorithm;
  // Auto-update channel (v2.0)
  updateChannel: "stable" | "beta";
  // AI settings
  aiEnabled: boolean;
  aiProvider: AIProvider;
  aiApiKey: string;
  aiApiEndpoint: string;
  aiModel: string;
  // Per-provider model selection for CLI agents (v2.17)
  aiModelByProvider: Partial<Record<AIProvider, string>>;
  aiOllamaUrl: string;
  aiOllamaModel: string;
  // Today view — last active surface persisted between openings (v2.9 / Phase 2)
  // Only "inbox" and "team" are live surfaces after Phase 2.
  launchpadActiveTab: "inbox" | "wip" | "prs" | "issues" | "team";
  // Today view — Team tab enable/disable (v2.9). Hides tab + skips fetch.
  launchpadTeamTabEnabled: boolean;
  // Dashboard layout
  dashboardReadmeFirst: boolean;
  dashboardHideContributors: boolean;
  dashboardHideActivity: boolean;
  dashboardHideReadme: boolean;
  // Dock & startup view (v3)
  startupView: "default" | "launchpad" | "dashboard" | "prs" | "graph";
  dockHideLaunchpad: boolean;
  dockHideDashboard: boolean;
  dockHidePrs: boolean;
  dockIconsOnly: boolean;
  dockVertical: boolean;
  dockIdleOpacity: number;
  dockUnlocked: boolean;
  dockPosition: { x: number; y: number } | null;
  dockOrder: DockEntryId[];
  // Automation settings (v2.8)
  automations: {
    autoResolve: { enabled: boolean };
    nightlyPull: { enabled: boolean; hour: number; minute: number };
    releaseNotes: { enabled: boolean };
    aiCommitBatch: { enabled: boolean };
  };
  // v2.12 Branch Management & Identity
  archivedBranches: Record<string, string[]>;
  pinnedBranchesByRepo: Record<string, string[]>;
  inactiveBranchDays: number;
  identities: IdentityProfile[];
  activeIdentityId: string | null;
  identityOverrideByRepo: Record<string, string>;
  commitTemplates: CommitTemplate[];
  // v2.13 AI Prompt Presets
  aiPromptPresets: AiPromptPreset[];
  activePresetIdByRepo: Record<string, string | null>;
  // v3 Release Note Templates
  releaseNoteTemplates: ReleaseNoteTemplate[];
  activeReleaseNoteTemplateIdByRepo: Record<string, string | null>;
  // v3.x terminal
  terminalFontSize: number;
  terminalShell: string;
}

const defaultSettings: Settings = {
  editor: "",
  gitPath: "",
  defaultBranch: "main",
  commitSignature: true,
  commitMessageLang: "",
  prAiLanguage: "english",
  diffMode: "inline",
  pullMode: "merge",
  switchBehavior: "ask",
  fontSize: 12,
  tabSize: 4,
  notifications: true,
  notificationLevel: "all",
  notificationsByPeople: true,
  updateChannel: "stable",
  // AI defaults
  aiEnabled: false,
  aiProvider: "none",
  aiApiKey: "",
  aiApiEndpoint: "https://api.anthropic.com",
  aiModel: "claude-sonnet-4-20250514",
  aiModelByProvider: {},
  aiOllamaUrl: "http://localhost:11434",
  aiOllamaModel: "codellama",
  blameAlgorithm: "histogram",
  launchpadActiveTab: "inbox",
  launchpadTeamTabEnabled: true,
  dashboardReadmeFirst: false,
  dashboardHideContributors: false,
  dashboardHideActivity: false,
  dashboardHideReadme: false,
  startupView: "default",
  dockHideLaunchpad: false,
  dockHideDashboard: false,
  dockHidePrs: false,
  dockIconsOnly: false,
  dockVertical: false,
  dockIdleOpacity: 0.45,
  dockUnlocked: false,
  dockPosition: null,
  dockOrder: [...DEFAULT_DOCK_ORDER],
  automations: {
    autoResolve: { enabled: false },
    nightlyPull: { enabled: false, hour: 8, minute: 0 },
    releaseNotes: { enabled: false },
    aiCommitBatch: { enabled: false },
  },
  // v2.12
  archivedBranches: {},
  pinnedBranchesByRepo: {},
  inactiveBranchDays: 30,
  identities: [],
  activeIdentityId: null,
  identityOverrideByRepo: {},
  commitTemplates: [],
  // v2.13
  aiPromptPresets: [],
  activePresetIdByRepo: {},
  // v3 Release Note Templates
  releaseNoteTemplates: [],
  activeReleaseNoteTemplateIdByRepo: {},
  // v3.x terminal
  terminalFontSize: 13,
  terminalShell: "",
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
  // Keep the shared reactive settings (read by AppDock and friends) in sync so
  // changes like dock order / position apply live, not only on panel close.
  refreshSharedSettings();
}

// ─── Dock order ───────────────────────────────────────────
function dockEntryLabel(id: DockEntryId): string {
  switch (id) {
    case "launchpad": return t("settings.dock.itemToday");
    case "dashboard": return t("settings.dock.itemDashboard");
    case "prs": return t("settings.dock.itemPrs");
    case "graph": return t("settings.dock.itemGitTree");
    case "changes": return t("settings.dock.itemChanges");
  }
}

/** Persisted order, normalised so all five entries are always present. */
const dockOrder = computed<DockEntryId[]>(() => normalizeDockOrder(settings.value.dockOrder));

function moveDockEntry(id: DockEntryId, dir: -1 | 1) {
  const arr = [...dockOrder.value];
  const i = arr.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  updateSetting("dockOrder", arr);
}

function resetDockPosition() {
  updateSetting("dockPosition", null);
}

// ─── Tab navigation ──────────────────────────────────────
type SettingsTab = "general" | "dock" | "dashboard" | "git" | "editor" | "ai" | "automations" | "logs" | "hooks" | "accounts" | "mcp" | "releaseNotes";
const activeSettingsTab = ref<SettingsTab>(props.initialTab ?? "general");

// ─── Logs tab — formatting + clipboard ──────────────────
// Pull the formatter (and markAllRead helper) from the singleton composable
// so the formatting is shared with anything that might want to log to the
// console in the same style.
const {
  formatEntry: formatLogEntry,
  formatTimestamp: formatLogTimestamp,
  markAllRead: markLogsRead,
} = useLogs();

/**
 * Per-level i18n label for the LEVEL chip rendered next to each log line.
 * Falls back to the upper-cased raw level if the locale somehow misses the
 * key (defensive — the keys are present in all 5 locale files).
 */
function logLevelLabel(level: LogEntry["level"]): string {
  switch (level) {
    case "error": return t("settings.logsLevelError");
    case "warn": return t("settings.logsLevelWarn");
    case "info": return t("settings.logsLevelInfo");
    default: return String(level).toUpperCase();
  }
}

// Reset the unread counter when the Logs tab actually becomes visible — both
// when the panel opens directly on it and when the user later switches to it.
watch(activeSettingsTab, (tab) => {
  if (tab === "logs") markLogsRead();
}, { immediate: true });

async function copyAllLogs() {
  const all = (props.errorLog ?? []).map(formatLogEntry).join("\n");
  try {
    await navigator.clipboard.writeText(all);
  } catch {
    // Clipboard API can fail (permissions, non-secure context). Fall back to
    // a hidden textarea + execCommand — best-effort, no error surfaced.
    const ta = document.createElement("textarea");
    ta.value = all;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch { /* give up */ }
    document.body.removeChild(ta);
  }
}

const settingsTabs: { id: SettingsTab; icon: string }[] = [
  { id: "general", icon: "general" },
  { id: "dock", icon: "dock" },
  { id: "dashboard", icon: "dashboard" },
  { id: "git", icon: "git" },
  { id: "editor", icon: "editor" },
  { id: "ai", icon: "ai" },
  { id: "releaseNotes", icon: "releaseNotes" },
  { id: "accounts", icon: "accounts" },
  { id: "mcp", icon: "mcp" },
  { id: "automations", icon: "automations" },
  { id: "hooks", icon: "hooks" },
  { id: "logs", icon: "logs" },
];

// ─── Nav sidebar groups (OpenCode-style left nav) ────────
const settingsNavGroups: Array<{ label: string | null; tabs: SettingsTab[] }> = [
  { label: "Application", tabs: ["general", "dock", "dashboard", "editor"] },
  { label: "Dépôt", tabs: ["git", "hooks", "accounts"] },
  { label: "IA & Agents", tabs: ["ai", "releaseNotes", "mcp", "automations"] },
  { label: "Système", tabs: ["logs"] },
];

function tabLabel(id: SettingsTab): string {
  switch (id) {
    case "general": return t("settings.tabGeneral");
    case "dock": return t("settings.tabDock");
    case "dashboard": return t("settings.tabDashboard");
    case "git": return t("settings.tabGit");
    case "editor": return t("settings.tabEditor");
    case "ai": return t("settings.tabAi");
    case "releaseNotes": return t("settings.tabReleaseNotes");
    case "accounts": return t("settings.tabAccounts");
    case "mcp": return t("settings.tabMcp");
    case "automations": return t("settings.tabAutomations");
    case "hooks": return t("settings.tabHooks");
    case "logs": return t("settings.tabLogs");
  }
}

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

function onNotificationLevelChange(e: Event) {
  updateSetting("notificationLevel", (e.target as HTMLSelectElement).value as NotificationLevel);
}

function onNotificationsByPeopleChange(e: Event) {
  updateSetting("notificationsByPeople", (e.target as HTMLInputElement).checked);
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
    loadCliModels(val);
  } else if (val === "codex-cli") {
    runCodexCliDetect();
    loadCliModels(val);
  } else if (val === "opencode-cli") {
    runOpencodeCliDetect();
    loadCliModels(val);
  } else if (val === "copilot-cli") {
    runCopilotCliDetect();
    loadCliModels(val);
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
  void openExternalUrl("https://console.anthropic.com/settings/keys");
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

// ─── opencode CLI detection (v2.17) ─────────────────────
const opencodeCliInfo = ref<OpencodeCliInfo | null>(null);
const opencodeCliDetecting = ref(false);

async function runOpencodeCliDetect() {
  opencodeCliDetecting.value = true;
  try {
    opencodeCliInfo.value = await detectOpencodeCli();
  } catch (e) {
    opencodeCliInfo.value = {
      found: false,
      path: "",
      version: "",
      logged_in: false,
      status: "error",
      detail: (e as Error).message,
    };
  } finally {
    opencodeCliDetecting.value = false;
  }
}

// ─── GitHub Copilot CLI detection ───────────────────────
const copilotCliInfo = ref<CopilotCliInfo | null>(null);
const copilotCliDetecting = ref(false);

async function runCopilotCliDetect() {
  copilotCliDetecting.value = true;
  try {
    copilotCliInfo.value = await detectCopilotCli();
  } catch (e) {
    copilotCliInfo.value = {
      found: false,
      path: "",
      version: "",
      logged_in: false,
      status: "error",
      detail: (e as Error).message,
    };
  } finally {
    copilotCliDetecting.value = false;
  }
}

// ─── Per-provider model picker for CLI agents (v2.17) ───
const cliModelOptions = ref<string[]>([]);
const cliModelsLoading = ref(false);
const isCliAgentProvider = computed(() =>
  (CLI_AGENT_PROVIDERS as readonly string[]).includes(settings.value.aiProvider),
);

async function loadCliModels(provider: AIProvider = settings.value.aiProvider) {
  if (!(CLI_AGENT_PROVIDERS as readonly string[]).includes(provider)) {
    cliModelOptions.value = [];
    return;
  }
  cliModelsLoading.value = true;
  try {
    cliModelOptions.value = await listModelsForProvider(provider);
  } catch {
    cliModelOptions.value = [];
  } finally {
    cliModelsLoading.value = false;
  }
}

function currentCliModel(): string {
  return settings.value.aiModelByProvider?.[settings.value.aiProvider] ?? "";
}

function onCliModelChange(val: string) {
  const next = { ...(settings.value.aiModelByProvider ?? {}) };
  next[settings.value.aiProvider] = val;
  updateSetting("aiModelByProvider", next);
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
  | "opencode-cli"
  | "copilot-cli"
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
  runOpencodeCliDetect();
  runCopilotCliDetect();
  // Preload the model list when a CLI agent is already the active provider.
  loadCliModels();
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

// ─── v2.12 Identities ────────────────────────────────────

const { identities, add: addIdentity, update: updateIdentity, remove: removeIdentity, setActive: setActiveIdentity } = useIdentity();

const identityForm = ref<{ label: string; gitName: string; gitEmail: string; gpgKey: string }>({
  label: "", gitName: "", gitEmail: "", gpgKey: "",
});
const editingIdentityId = ref<string | null>(null);
const showIdentityForm = ref(false);

function openAddIdentity() {
  identityForm.value = { label: "", gitName: "", gitEmail: "", gpgKey: "" };
  editingIdentityId.value = null;
  showIdentityForm.value = true;
}

function openEditIdentity(p: IdentityProfile) {
  identityForm.value = { label: p.label, gitName: p.gitName, gitEmail: p.gitEmail, gpgKey: p.gpgKey ?? "" };
  editingIdentityId.value = p.id;
  showIdentityForm.value = true;
}

function saveIdentityForm() {
  const { label, gitName, gitEmail, gpgKey } = identityForm.value;
  if (!label.trim() || !gitName.trim() || !gitEmail.trim()) return;
  if (editingIdentityId.value) {
    updateIdentity(editingIdentityId.value, { label, gitName, gitEmail, gpgKey: gpgKey || undefined });
  } else {
    addIdentity({ label, gitName, gitEmail, gpgKey: gpgKey || undefined });
  }
  showIdentityForm.value = false;
}

function deleteIdentity(id: string) {
  removeIdentity(id);
}

// ─── v2.12 Commit Templates ──────────────────────────────

const { templates, add: addTemplate, update: updateTemplate, remove: removeTemplate, importFromGit } = useCommitTemplates();

const templateForm = ref<{ name: string; subject: string; body: string }>({
  name: "", subject: "", body: "",
});
const editingTemplateId = ref<string | null>(null);
const showTemplateForm = ref(false);
const importingTemplate = ref(false);

function openAddTemplate() {
  templateForm.value = { name: "", subject: "", body: "" };
  editingTemplateId.value = null;
  showTemplateForm.value = true;
}

function openEditTemplate(tmpl: CommitTemplate) {
  templateForm.value = { name: tmpl.name, subject: tmpl.subject, body: tmpl.body };
  editingTemplateId.value = tmpl.id;
  showTemplateForm.value = true;
}

function saveTemplateForm() {
  const { name, subject, body } = templateForm.value;
  if (!name.trim()) return;
  if (editingTemplateId.value) {
    updateTemplate(editingTemplateId.value, { name, subject, body });
  } else {
    addTemplate({ name, subject, body });
  }
  showTemplateForm.value = false;
}

async function doImportFromGitMessage() {
  if (!props.cwd) return;
  importingTemplate.value = true;
  try {
    await importFromGit(props.cwd);
  } catch {
    // silent — template path not configured
  } finally {
    importingTemplate.value = false;
  }
}

// ─── v2.13 AI Prompt Presets ─────────────────────────────

const { userPresets, add: addPreset, update: updatePreset, remove: removePreset } = useAiPromptPresets();

const presetForm = ref<{ name: string; description: string; systemPrompt: string }>({
  name: "", description: "", systemPrompt: "",
});
const editingPresetId = ref<string | null>(null);
const showPresetForm = ref(false);

function openAddPreset() {
  presetForm.value = { name: "", description: "", systemPrompt: "" };
  editingPresetId.value = null;
  showPresetForm.value = true;
}

function openEditPreset(preset: AiPromptPreset) {
  presetForm.value = {
    name: preset.name,
    description: preset.description ?? "",
    systemPrompt: preset.systemPrompt,
  };
  editingPresetId.value = preset.id;
  showPresetForm.value = true;
}

function savePresetForm() {
  const { name, description, systemPrompt } = presetForm.value;
  if (!name.trim() || !systemPrompt.trim()) return;
  if (editingPresetId.value) {
    updatePreset(editingPresetId.value, { name, description: description || undefined, systemPrompt });
  } else {
    addPreset({ name, description: description || undefined, systemPrompt });
  }
  showPresetForm.value = false;
}

// ─── v3 Release Note Templates ─────────────────────────────

const {
  templates: releaseNoteTemplates,
  add: addReleaseNoteTemplate,
  update: updateReleaseNoteTemplate,
  remove: removeReleaseNoteTemplate,
} = useReleaseNoteTemplates();

const releaseNoteTemplateForm = ref<{ name: string; customRules: string }>({
  name: "",
  customRules: "",
});
const editingReleaseNoteTemplateId = ref<string | null>(null);
const showReleaseNoteTemplateForm = ref(false);

function openAddReleaseNoteTemplate() {
  releaseNoteTemplateForm.value = { name: "", customRules: "" };
  editingReleaseNoteTemplateId.value = null;
  showReleaseNoteTemplateForm.value = true;
}

function openEditReleaseNoteTemplate(tpl: ReleaseNoteTemplate) {
  releaseNoteTemplateForm.value = {
    name: tpl.name,
    customRules: tpl.customRules,
  };
  editingReleaseNoteTemplateId.value = tpl.id;
  showReleaseNoteTemplateForm.value = true;
}

function saveReleaseNoteTemplateForm() {
  const { name, customRules } = releaseNoteTemplateForm.value;
  if (!name.trim() || !customRules.trim()) return;
  if (editingReleaseNoteTemplateId.value) {
    updateReleaseNoteTemplate(editingReleaseNoteTemplateId.value, { name, customRules });
  } else {
    addReleaseNoteTemplate({ name, customRules });
  }
  showReleaseNoteTemplateForm.value = false;
  // Sync the local settings state
  const updated = loadSettings();
  settings.value.releaseNoteTemplates = updated.releaseNoteTemplates;
}

function deleteReleaseNoteTemplate(id: string) {
  removeReleaseNoteTemplate(id);
  const updated = loadSettings();
  settings.value.releaseNoteTemplates = updated.releaseNoteTemplates;
  settings.value.activeReleaseNoteTemplateIdByRepo = updated.activeReleaseNoteTemplateIdByRepo;
}

</script>

<template>
  <BaseModal size="xl" :title="t('settings.title')" :bodyFlush="true" :scrollOwn="true" @close="emit('close')">
    <template #title-icon>
      <span class="bm-title-icon" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
          <path d="M2.5 4h11M2.5 8h11M2.5 12h11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
          <circle cx="5.5" cy="4" r="1.5" fill="var(--color-bg-secondary)" stroke="currentColor" stroke-width="1.2"/>
          <circle cx="10.5" cy="8" r="1.5" fill="var(--color-bg-secondary)" stroke="currentColor" stroke-width="1.2"/>
          <circle cx="7" cy="12" r="1.5" fill="var(--color-bg-secondary)" stroke="currentColor" stroke-width="1.2"/>
        </svg>
      </span>
    </template>

    <!-- Two-column layout: left nav + right content -->
    <div class="sp-layout">

      <!-- ── Left nav sidebar ── -->
      <nav class="sp-nav">
        <template v-for="group in settingsNavGroups" :key="group.label ?? group.tabs[0]">
          <div class="sp-nav-group">
            <span v-if="group.label" class="sp-nav-group-label">{{ group.label }}</span>
            <button v-for="tab in settingsTabs.filter(t => (group.tabs as string[]).includes(t.id))" :key="tab.id"
              class="sp-nav-item" :class="{ 'sp-nav-item--active': activeSettingsTab === tab.id }"
              @click="activeSettingsTab = tab.id">
              <svg v-if="tab.icon === 'general'" width="15" height="15" viewBox="0 0 16 16" fill="none"
                stroke="currentColor" stroke-width="1.4">
                <circle cx="8" cy="8" r="3" />
                <path
                  d="M8 1v2m0 10v2m-7-7h2m10 0h2m-2.05-4.95-1.41 1.41m-7.08 7.08-1.41 1.41m0-9.9 1.41 1.41m7.08 7.08 1.41 1.41" />
              </svg>
              <svg v-else-if="tab.icon === 'dock'" width="15" height="15" viewBox="0 0 16 16" fill="none"
                stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
                <rect x="1.75" y="2.5" width="12.5" height="11" rx="2" />
                <rect x="4" y="9.5" width="8" height="2.25" rx="1.1" fill="currentColor" stroke="none" />
              </svg>
              <svg v-else-if="tab.icon === 'dashboard'" width="15" height="15" viewBox="0 0 16 16" fill="none"
                stroke="currentColor" stroke-width="1.4">
                <rect x="2" y="2" width="5" height="5" rx="1" />
                <rect x="9" y="2" width="5" height="5" rx="1" />
                <rect x="2" y="9" width="5" height="5" rx="1" />
                <rect x="9" y="9" width="5" height="5" rx="1" />
              </svg>
              <svg v-else-if="tab.icon === 'git'" width="15" height="15" viewBox="0 0 16 16" fill="none"
                stroke="currentColor" stroke-width="1.4">
                <circle cx="8" cy="3" r="2" />
                <circle cx="8" cy="13" r="2" />
                <path d="M8 5v6" />
                <circle cx="13" cy="8" r="2" />
                <path d="M11 8H9.5c-.83 0-1.5-.67-1.5-1.5V5" />
              </svg>
              <svg v-else-if="tab.icon === 'editor'" width="15" height="15" viewBox="0 0 16 16" fill="none"
                stroke="currentColor" stroke-width="1.4">
                <rect x="2" y="2" width="12" height="12" rx="2" />
                <path d="M5 6h6M5 8.5h4M5 11h5" />
              </svg>
              <svg v-else-if="tab.icon === 'ai'" width="15" height="15" viewBox="0 0 16 16" fill="none"
                stroke="currentColor" stroke-width="1.4">
                <path d="M8 1v2m0 10v2M1 8h2m10 0h2" />
                <circle cx="8" cy="8" r="4" />
                <circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" />
              </svg>
              <svg v-else-if="tab.icon === 'releaseNotes'" width="15" height="15" viewBox="0 0 16 16" fill="none"
                stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 2h7l3 3v9H3z" />
                <path d="M9 2v4h4" />
                <path d="M5.5 8.5h5M5.5 11h3" />
              </svg>
              <svg v-else-if="tab.icon === 'hooks'" width="15" height="15" viewBox="0 0 16 16" fill="none"
                stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 4l2 2-2 2M7 8h6" />
                <path d="M3 12h10" />
              </svg>
              <svg v-else-if="tab.icon === 'automations'" width="15" height="15" viewBox="0 0 16 16" fill="none"
                stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
                <path d="M8 1v2m0 10v2M1 8h2m10 0h2" />
                <path d="M5.5 5.5L4 4M11.5 11.5L10 10M10.5 5.5L12 4M4.5 11.5L3 13" />
                <circle cx="8" cy="8" r="2.5" />
              </svg>
              <svg v-else-if="tab.icon === 'accounts'" width="15" height="15" viewBox="0 0 16 16" fill="none"
                stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="6" cy="5" r="2.5" />
                <path d="M1 14c0-2.76 2.24-5 5-5s5 2.24 5 5" />
                <path d="M13 7v4m-2-2h4" />
              </svg>
              <svg v-else-if="tab.icon === 'mcp'" width="15" height="15" viewBox="0 0 16 16" fill="none"
                stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="8" cy="3" r="1.5" />
                <circle cx="3" cy="11" r="1.5" />
                <circle cx="13" cy="11" r="1.5" />
                <path d="M8 4.5v3L3 9.6M8 7.5l5 2.1" />
              </svg>
              <svg v-else-if="tab.icon === 'logs'" width="15" height="15" viewBox="0 0 16 16" fill="none"
                stroke="currentColor" stroke-width="1.4">
                <path d="M2 4h12M2 8h8M2 12h6" stroke-linecap="round" />
              </svg>
              <span>{{ tabLabel(tab.id) }}</span>
              <span v-if="tab.id === 'logs' && (props.errorLog?.length ?? 0) > 0" class="sp-nav-badge">
                {{ props.errorLog!.length > 99 ? '99+' : props.errorLog!.length }}
              </span>
            </button>
          </div>
        </template>

        <!-- Check for updates — action, not a tab -->
        <div class="sp-nav-group">
          <button class="sp-nav-item sp-nav-action" :class="{ 'sp-nav-action--ok': updateCheckStatus === 'upToDate' }"
            :disabled="updateCheckStatus === 'checking'" @click="runUpdateCheck">
            <!-- Spinner while checking -->
            <svg v-if="updateCheckStatus === 'checking'" class="sp-nav-action-spin" width="15" height="15"
              viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
              <path d="M8 1.5A6.5 6.5 0 1 1 1.5 8" />
            </svg>
            <!-- Check mark when up to date -->
            <svg v-else-if="updateCheckStatus === 'upToDate'" width="15" height="15" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 8.5l3.5 3.5 6.5-7" />
            </svg>
            <!-- Refresh icon (idle) -->
            <svg v-else width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"
              stroke-linecap="round" stroke-linejoin="round">
              <path d="M13.5 8A5.5 5.5 0 1 1 8 2.5" />
              <path d="M11 1v4h4" />
            </svg>
            <span>{{
              updateCheckStatus === 'checking' ? t('common.loading') :
                updateCheckStatus === 'upToDate' ? t('settings.upToDate') :
                  t('settings.checkForUpdates')
            }}</span>
          </button>
        </div>

        <div class="sp-nav-spacer" />
        <div class="sp-nav-footer">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="8" cy="3" r="1.5" />
            <circle cx="3" cy="11" r="1.5" />
            <circle cx="13" cy="11" r="1.5" />
            <path d="M8 4.5v3L3 9.6M8 7.5l5 2.1" />
          </svg>
          <span class="sp-nav-footer-name">GitWand</span>
          <span class="sp-nav-footer-version">v{{ appVersion }}</span>
        </div>
      </nav>

      <!-- ── Right content area ── -->
      <div class="sp-content">

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
            <select id="setting-commit-lang" class="sp-select" :value="settings.commitMessageLang"
              @change="updateSetting('commitMessageLang', ($event.target as HTMLSelectElement).value)">
              <option value="">{{ t('settings.commitMessageLangAuto') }}</option>
              <option v-for="loc in supportedLocales" :key="loc" :value="loc">{{ localeLabels[loc] }}</option>
            </select>
            <span class="sp-hint">{{ t('settings.commitMessageLangHint') }}</span>
          </div>

          <!-- PR AI language -->
          <div class="sp-row">
            <label class="sp-label" for="setting-pr-ai-lang">{{ t('settings.prAiLanguage') }}</label>
            <select id="setting-pr-ai-lang" class="sp-select" :value="settings.prAiLanguage"
              @change="updateSetting('prAiLanguage', ($event.target as HTMLSelectElement).value as 'english' | 'ui')">
              <option value="english">{{ t('settings.prAiLanguageEnglish') }}</option>
              <option value="ui">{{ t('settings.prAiLanguageUi') }}</option>
            </select>
            <span class="sp-hint">{{ t('settings.prAiLanguageHint') }}</span>
          </div>

          <!-- Theme -->
          <div class="sp-row">
            <label class="sp-label" for="setting-theme">{{ t('settings.theme') }}</label>
            <select id="setting-theme" class="sp-select" :value="themeSetting"
              @change="onThemeChange(($event.target as HTMLSelectElement).value as ThemeSetting)">
              <option value="system">{{ t('settings.themeSystem') }}</option>
              <option value="dark">{{ t('settings.themeDark') }}</option>
              <option value="light">{{ t('settings.themeLight') }}</option>
            </select>
          </div>

          <!-- Notifications -->
          <div class="sp-row sp-row--checkbox">
            <label class="sp-checkbox-label" for="setting-notifications">
              <input id="setting-notifications" type="checkbox" class="sp-checkbox" :checked="settings.notifications"
                @change="onNotificationsChange" />
              <span>{{ t('settings.notifications') }}</span>
            </label>
            <span class="sp-hint">{{ t('settings.notificationsHint') }}</span>
          </div>

          <!-- PR activity notification granularity (v2.16) -->
          <div class="sp-row" v-if="settings.notifications">
            <label for="setting-notification-level">{{ t('settings.notificationLevel') }}</label>
            <select id="setting-notification-level" class="sp-select"
              :value="settings.notificationLevel" @change="onNotificationLevelChange">
              <option value="all">{{ t('settings.notificationLevelAll') }}</option>
              <option value="reviews">{{ t('settings.notificationLevelReviews') }}</option>
              <option value="ci">{{ t('settings.notificationLevelCi') }}</option>
              <option value="none">{{ t('settings.notificationLevelNone') }}</option>
            </select>
            <span class="sp-hint">{{ t('settings.notificationLevelHint') }}</span>
          </div>

          <div class="sp-row sp-row--checkbox" v-if="settings.notifications && settings.notificationLevel !== 'none'">
            <label class="sp-checkbox-label" for="setting-notifications-by-people">
              <input id="setting-notifications-by-people" type="checkbox" class="sp-checkbox"
                :checked="settings.notificationsByPeople" @change="onNotificationsByPeopleChange" />
              <span>{{ t('settings.notificationsByPeople') }}</span>
            </label>
            <span class="sp-hint">{{ t('settings.notificationsByPeopleHint') }}</span>
          </div>

          <!-- Auto-update channel (v2.0) -->
          <div class="sp-row">
            <label class="sp-label" for="setting-update-channel">{{ t('settings.updateChannelLabel') }}</label>
            <select id="setting-update-channel" class="sp-select" :value="settings.updateChannel"
              @change="updateSetting('updateChannel', ($event.target as HTMLSelectElement).value as 'stable' | 'beta')">
              <option value="stable">{{ t('settings.updateChannelStable') }}</option>
              <option value="beta">{{ t('settings.updateChannelBeta') }}</option>
            </select>
            <span class="sp-hint">
              {{ settings.updateChannel === 'beta' ? t('settings.updateChannelBetaHint') :
                t('settings.updateChannelStableHint') }}
            </span>
          </div>

          <!-- Launchpad Team tab toggle (v2.9) — inverted boolean: a "Disable"
               checkbox is friendlier when the default is "enabled". -->
          <div class="sp-row sp-row--checkbox">
            <label class="sp-checkbox-label" for="setting-launchpad-team">
              <input id="setting-launchpad-team" type="checkbox" class="sp-checkbox"
                :checked="!settings.launchpadTeamTabEnabled"
                @change="updateSetting('launchpadTeamTabEnabled', !($event.target as HTMLInputElement).checked)" />
              <span>{{ t('settings.launchpad.disableTeamTab.label') }}</span>
            </label>
            <span class="sp-hint">{{ t('settings.launchpad.disableTeamTab.help') }}</span>
          </div>
        </template>

        <!-- ═══ DASHBOARD ═══ -->
        <!-- ═══ DOCK ═══ -->
        <template v-if="activeSettingsTab === 'dock'">
          <!-- Starting view -->
          <div class="sp-row">
            <label class="sp-label" for="setting-startup-view">{{ t('settings.dock.startupView.label') }}</label>
            <select id="setting-startup-view" class="sp-select" :value="settings.startupView"
              @change="updateSetting('startupView', ($event.target as HTMLSelectElement).value as Settings['startupView'])">
              <option value="default">{{ t('settings.dock.startupView.default') }}</option>
              <option value="launchpad">{{ t('settings.dock.itemToday') }}</option>
              <option value="dashboard">{{ t('settings.dock.itemDashboard') }}</option>
              <option value="prs">{{ t('settings.dock.itemPrs') }}</option>
              <option value="graph">{{ t('settings.dock.itemGitTree') }}</option>
            </select>
            <span class="sp-hint">{{ t('settings.dock.startupView.help') }}</span>
          </div>

          <div class="sp-row">
            <span class="sp-label">{{ t('settings.dock.visibility.label') }}</span>
            <span class="sp-hint">{{ t('settings.dock.visibility.help') }}</span>
          </div>

          <!-- Show Today -->
          <div class="sp-row sp-row--checkbox">
            <label class="sp-checkbox-label" for="setting-dock-today">
              <input id="setting-dock-today" type="checkbox" class="sp-checkbox"
                :checked="!settings.dockHideLaunchpad"
                @change="updateSetting('dockHideLaunchpad', !($event.target as HTMLInputElement).checked)" />
              <span>{{ t('settings.dock.showToday') }}</span>
            </label>
          </div>

          <!-- Show Dashboard -->
          <div class="sp-row sp-row--checkbox">
            <label class="sp-checkbox-label" for="setting-dock-dashboard">
              <input id="setting-dock-dashboard" type="checkbox" class="sp-checkbox"
                :checked="!settings.dockHideDashboard"
                @change="updateSetting('dockHideDashboard', !($event.target as HTMLInputElement).checked)" />
              <span>{{ t('settings.dock.showDashboard') }}</span>
            </label>
          </div>

          <!-- Show PRs -->
          <div class="sp-row sp-row--checkbox">
            <label class="sp-checkbox-label" for="setting-dock-prs">
              <input id="setting-dock-prs" type="checkbox" class="sp-checkbox"
                :checked="!settings.dockHidePrs"
                @change="updateSetting('dockHidePrs', !($event.target as HTMLInputElement).checked)" />
              <span>{{ t('settings.dock.showPrs') }}</span>
            </label>
          </div>

          <div class="sp-row sp-row--checkbox">
            <label class="sp-checkbox-label sp-checkbox-label--locked">
              <input type="checkbox" class="sp-checkbox" checked disabled />
              <span>{{ t('settings.dock.gitTreeLocked') }}</span>
            </label>
            <span class="sp-hint">{{ t('settings.dock.lockedHint') }}</span>
          </div>

          <!-- ── Appearance ── -->
          <div class="sp-row">
            <span class="sp-label">{{ t('settings.dock.appearance.label') }}</span>
          </div>

          <!-- Icons only — forced on (and disabled) while the dock is vertical. -->
          <div class="sp-row sp-row--checkbox">
            <label class="sp-checkbox-label" :class="{ 'sp-checkbox-label--locked': settings.dockVertical }"
              for="setting-dock-icons-only">
              <input id="setting-dock-icons-only" type="checkbox" class="sp-checkbox"
                :checked="settings.dockVertical || settings.dockIconsOnly"
                :disabled="settings.dockVertical"
                @change="updateSetting('dockIconsOnly', ($event.target as HTMLInputElement).checked)" />
              <span>{{ t('settings.dock.iconsOnly.label') }}</span>
            </label>
            <span class="sp-hint">{{ settings.dockVertical ? t('settings.dock.iconsOnly.verticalHint') : t('settings.dock.iconsOnly.help') }}</span>
          </div>

          <!-- Idle opacity -->
          <div class="sp-row">
            <label class="sp-label" for="setting-dock-idle-opacity">
              {{ t('settings.dock.idleOpacity.label') }} — {{ Math.round(settings.dockIdleOpacity * 100) }}%
            </label>
            <input id="setting-dock-idle-opacity" type="range" class="sp-range" style="max-width: 300px;"
              min="0.1" max="1" step="0.05" :value="settings.dockIdleOpacity"
              @input="updateSetting('dockIdleOpacity', parseFloat(($event.target as HTMLInputElement).value))" />
            <span class="sp-hint">{{ t('settings.dock.idleOpacity.help') }}</span>
          </div>

          <!-- ── Position ── -->
          <div class="sp-row">
            <span class="sp-label">{{ t('settings.dock.position.label') }}</span>
            <span class="sp-hint">{{ t('settings.dock.position.help') }}</span>
          </div>

          <!-- Unlock position + reset button -->
          <div class="sp-row sp-row--checkbox sp-dock-pos-row">
            <label class="sp-checkbox-label" for="setting-dock-unlocked">
              <input id="setting-dock-unlocked" type="checkbox" class="sp-checkbox"
                :checked="settings.dockUnlocked"
                @change="updateSetting('dockUnlocked', ($event.target as HTMLInputElement).checked)" />
              <span>{{ t('settings.dock.unlock.label') }}</span>
            </label>
            <button type="button" class="btn btn--ghost sp-btn--sm sp-dock-reset"
              :disabled="!settings.dockPosition"
              @click="resetDockPosition">
              {{ t('settings.dock.resetPosition') }}
            </button>
          </div>
          <span class="sp-hint">{{ t('settings.dock.unlock.help') }}</span>

          <!-- Turn to vertical -->
          <div class="sp-row sp-row--checkbox">
            <label class="sp-checkbox-label" for="setting-dock-vertical">
              <input id="setting-dock-vertical" type="checkbox" class="sp-checkbox"
                :checked="settings.dockVertical"
                @change="updateSetting('dockVertical', ($event.target as HTMLInputElement).checked)" />
              <span>{{ t('settings.dock.vertical.label') }}</span>
            </label>
            <span class="sp-hint">{{ t('settings.dock.vertical.help') }}</span>
          </div>

          <!-- ── Dock order ── -->
          <div class="sp-row">
            <span class="sp-label">{{ t('settings.dock.order.label') }}</span>
            <span class="sp-hint">{{ t('settings.dock.order.help') }}</span>
          </div>

          <ul class="sp-dock-order">
            <li v-for="(id, i) in dockOrder" :key="id" class="sp-dock-order-item">
              <span class="sp-dock-order-name">{{ dockEntryLabel(id) }}</span>
              <span class="sp-dock-order-actions">
                <button type="button" class="sp-dock-order-btn" :disabled="i === 0"
                  :aria-label="t('settings.dock.order.moveUp')" :title="t('settings.dock.order.moveUp')"
                  @click="moveDockEntry(id, -1)">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10l4-4 4 4" /></svg>
                </button>
                <button type="button" class="sp-dock-order-btn" :disabled="i === dockOrder.length - 1"
                  :aria-label="t('settings.dock.order.moveDown')" :title="t('settings.dock.order.moveDown')"
                  @click="moveDockEntry(id, 1)">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4" /></svg>
                </button>
              </span>
            </li>
          </ul>
        </template>

        <template v-if="activeSettingsTab === 'dashboard'">
          <!-- README first row -->
          <div class="sp-row sp-row--checkbox">
            <label class="sp-checkbox-label" for="setting-dashboard-readme-first">
              <input id="setting-dashboard-readme-first" type="checkbox" class="sp-checkbox"
                :checked="settings.dashboardReadmeFirst"
                @change="updateSetting('dashboardReadmeFirst', ($event.target as HTMLInputElement).checked)" />
              <span>{{ t('settings.dashboard.readmeFirst.label') }}</span>
            </label>
            <span class="sp-hint">{{ t('settings.dashboard.readmeFirst.help') }}</span>
          </div>

          <!-- Hide contributors row -->
          <div class="sp-row sp-row--checkbox">
            <label class="sp-checkbox-label" for="setting-dashboard-hide-contributors">
              <input id="setting-dashboard-hide-contributors" type="checkbox" class="sp-checkbox"
                :checked="settings.dashboardHideContributors"
                @change="updateSetting('dashboardHideContributors', ($event.target as HTMLInputElement).checked)" />
              <span>{{ t('settings.dashboard.hideContributors.label') }}</span>
            </label>
            <span class="sp-hint">{{ t('settings.dashboard.hideContributors.help') }}</span>
          </div>

          <!-- Hide activity row -->
          <div class="sp-row sp-row--checkbox">
            <label class="sp-checkbox-label" for="setting-dashboard-hide-activity">
              <input id="setting-dashboard-hide-activity" type="checkbox" class="sp-checkbox"
                :checked="settings.dashboardHideActivity"
                @change="updateSetting('dashboardHideActivity', ($event.target as HTMLInputElement).checked)" />
              <span>{{ t('settings.dashboard.hideActivity.label') }}</span>
            </label>
            <span class="sp-hint">{{ t('settings.dashboard.hideActivity.help') }}</span>
          </div>

          <!-- Hide README -->
          <div class="sp-row sp-row--checkbox">
            <label class="sp-checkbox-label" for="setting-dashboard-hide-readme">
              <input id="setting-dashboard-hide-readme" type="checkbox" class="sp-checkbox"
                :checked="settings.dashboardHideReadme"
                @change="updateSetting('dashboardHideReadme', ($event.target as HTMLInputElement).checked)" />
              <span>{{ t('settings.dashboard.hideReadme.label') }}</span>
            </label>
            <span class="sp-hint">{{ t('settings.dashboard.hideReadme.help') }}</span>
          </div>
        </template>

        <!-- ═══ GIT ═══ -->
        <template v-if="activeSettingsTab === 'git'">
          <!-- Git path -->
          <div class="sp-row">
            <label class="sp-label" for="setting-git">{{ t('settings.gitPath') }}</label>
            <input id="setting-git" class="sp-input mono" type="text" :value="settings.gitPath"
              @input="updateSetting('gitPath', ($event.target as HTMLInputElement).value)"
              :placeholder="t('settings.gitPathAuto')" />
          </div>

          <!-- Default branch -->
          <div class="sp-row">
            <label class="sp-label" for="setting-branch">{{ t('settings.defaultBranch') }}</label>
            <input id="setting-branch" class="sp-input mono" type="text" :value="settings.defaultBranch"
              @input="updateSetting('defaultBranch', ($event.target as HTMLInputElement).value)" placeholder="main" />
          </div>

          <!-- Pull mode -->
          <div class="sp-row">
            <label class="sp-label" for="setting-pull-mode">{{ t('settings.pullMode') }}</label>
            <select id="setting-pull-mode" class="sp-select" :value="settings.pullMode"
              @change="onPullModeChange(($event.target as HTMLSelectElement).value as PullMode)">
              <option value="merge">{{ t('settings.pullMerge') }}</option>
              <option value="rebase">{{ t('settings.pullRebase') }}</option>
            </select>
          </div>

          <!-- Switch behavior -->
          <div class="sp-row">
            <label class="sp-label" for="setting-switch-behavior">{{ t('settings.switchBehavior') }}</label>
            <select id="setting-switch-behavior" class="sp-select" :value="settings.switchBehavior"
              @change="onSwitchBehaviorChange(($event.target as HTMLSelectElement).value as SwitchBehavior)">
              <option value="stash">{{ t('settings.switchStash') }}</option>
              <option value="ask">{{ t('settings.switchAsk') }}</option>
              <option value="refuse">{{ t('settings.switchRefuse') }}</option>
            </select>
          </div>

          <!-- Commit signature -->
          <div class="sp-row sp-row--checkbox">
            <label class="sp-checkbox-label" for="setting-signature">
              <input id="setting-signature" type="checkbox" class="sp-checkbox" :checked="settings.commitSignature"
                @change="onSignatureChange" />
              <span>{{ t('settings.commitSignature') }}</span>
            </label>
            <span class="sp-hint">{{ t('settings.commitSignatureHint') }}</span>
          </div>

          <!-- Blame diff algorithm -->
          <div class="sp-row">
            <label class="sp-label" for="setting-blame-algo">{{ t('settings.blameAlgorithm') }}</label>
            <select id="setting-blame-algo" class="sp-select" :value="settings.blameAlgorithm"
              @change="updateSetting('blameAlgorithm', ($event.target as HTMLSelectElement).value as BlameAlgorithm)">
              <option value="histogram">histogram {{ t('settings.blameAlgoRecommended') }}</option>
              <option value="patience">patience</option>
              <option value="minimal">minimal</option>
              <option value="myers">myers</option>
            </select>
            <span class="sp-hint">{{ t('settings.blameAlgorithmHint') }}</span>
          </div>

          <!-- Inactive branch threshold -->
          <div class="sp-row">
            <label class="sp-label" for="setting-inactive-days">{{ t('settings.git.inactiveDays') }}</label>
            <div class="sp-range-row">
              <input id="setting-inactive-days" class="sp-range" type="range" min="0" max="180" step="7"
                :value="settings.inactiveBranchDays"
                @input="updateSetting('inactiveBranchDays', Number(($event.target as HTMLInputElement).value))" />
              <span class="sp-range-value mono">
                {{ settings.inactiveBranchDays === 0 ? t('settings.git.inactiveDaysOff') :
                  `${settings.inactiveBranchDays}j` }}
              </span>
            </div>
            <span class="sp-hint">{{ t('settings.git.inactiveDaysHint') }}</span>
          </div>

          <!-- ── Identités ── -->
          <div class="sp-group">
            <div class="sp-group__head">
              <span class="sp-group__label">{{ t('settings.git.identities') }}</span>
              <button v-if="!showIdentityForm" class="sp-group__action" @click="openAddIdentity">
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5"
                  aria-hidden="true">
                  <path d="M8 3v10M3 8h10" />
                </svg>
                {{ t('settings.git.identityAdd') }}
              </button>
            </div>

            <div class="sp-group__body">
              <div v-if="identities.length === 0 && !showIdentityForm" class="sp-group__empty">
                {{ t('settings.git.identitiesEmpty') }}
              </div>

              <div v-for="p in identities" :key="p.id" class="sp-group__row">
                <div class="sp-group__row-info">
                  <span class="sp-group__row-name">{{ p.label }}</span>
                  <span class="sp-group__row-meta mono">{{ p.gitName }} &lt;{{ p.gitEmail }}&gt;</span>
                </div>
                <div class="sp-group__row-aside">
                  <span v-if="p.gpgKey" class="sp-tag">GPG</span>
                  <button class="sp-ghost-btn" @click="openEditIdentity(p)" :title="t('settings.git.identityEdit')">
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                      stroke-width="1.5">
                      <path d="M11.5 2.5l2 2L5 13H3v-2L11.5 2.5z" />
                    </svg>
                  </button>
                  <button class="sp-ghost-btn sp-ghost-btn--danger" @click="deleteIdentity(p.id)"
                    :title="t('settings.git.identityDelete')">
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                      stroke-width="1.5">
                      <path d="M4 4l8 8M12 4l-8 8" />
                    </svg>
                  </button>
                </div>
              </div>

              <div v-if="showIdentityForm" class="sp-group__form">
                <div class="sp-group__form-grid">
                  <div class="sp-field">
                    <label class="sp-field__label">{{ t('settings.git.identityLabel') }}</label>
                    <input class="sp-input sp-input--sm" v-model="identityForm.label" placeholder="Ex. Perso" />
                  </div>
                  <div class="sp-field">
                    <label class="sp-field__label">{{ t('settings.git.identityName') }}</label>
                    <input class="sp-input sp-input--sm" v-model="identityForm.gitName" placeholder="Jean Dupont" />
                  </div>
                  <div class="sp-field sp-field--wide">
                    <label class="sp-field__label">{{ t('settings.git.identityEmail') }}</label>
                    <input class="sp-input sp-input--sm" v-model="identityForm.gitEmail" placeholder="jean@example.com"
                      type="email" />
                  </div>
                  <div class="sp-field sp-field--wide">
                    <label class="sp-field__label">{{ t('settings.git.identityGpg') }} <span
                        class="sp-field__optional">— optionnel</span></label>
                    <input class="sp-input sp-input--sm mono" v-model="identityForm.gpgKey" placeholder="ABC123…" />
                  </div>
                </div>
                <div class="sp-group__form-footer">
                  <button class="btn btn--ghost sp-btn--sm" @click="showIdentityForm = false">{{ t('common.cancel')
                  }}</button>
                  <button class="btn btn--primary sp-btn--sm" @click="saveIdentityForm">{{ t('common.save') }}</button>
                </div>
              </div>
            </div>
          </div>

          <!-- ── Templates de commit ── -->
          <div class="sp-group">
            <div class="sp-group__head">
              <span class="sp-group__label">{{ t('settings.git.templates') }}</span>
              <div v-if="!showTemplateForm" class="sp-group__actions">
                <button class="sp-group__action" @click="openAddTemplate">
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5"
                    aria-hidden="true">
                    <path d="M8 3v10M3 8h10" />
                  </svg>
                  {{ t('settings.git.templateAdd') }}
                </button>
                <button v-if="props.cwd" class="sp-group__action sp-group__action--muted"
                  @click="doImportFromGitMessage" :disabled="importingTemplate">
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"
                    aria-hidden="true">
                    <path d="M8 2v8M4 7l4 4 4-4" />
                    <path d="M2 13h12" />
                  </svg>
                  {{ importingTemplate ? '…' : t('settings.git.templateImport') }}
                </button>
              </div>
            </div>

            <div class="sp-group__body">
              <div v-if="templates.length === 0 && !showTemplateForm" class="sp-group__empty">
                {{ t('settings.git.templatesEmpty') }}
              </div>

              <div v-for="tmpl in templates" :key="tmpl.id" class="sp-group__row">
                <div class="sp-group__row-info">
                  <span class="sp-group__row-name">{{ tmpl.name }}</span>
                  <span class="sp-group__row-meta mono">{{ tmpl.subject || '—' }}</span>
                </div>
                <div class="sp-group__row-aside">
                  <button class="sp-ghost-btn" @click="openEditTemplate(tmpl)" :title="t('settings.git.identityEdit')">
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                      stroke-width="1.5">
                      <path d="M11.5 2.5l2 2L5 13H3v-2L11.5 2.5z" />
                    </svg>
                  </button>
                  <button class="sp-ghost-btn sp-ghost-btn--danger" @click="removeTemplate(tmpl.id)"
                    :title="t('settings.git.identityDelete')">
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                      stroke-width="1.5">
                      <path d="M4 4l8 8M12 4l-8 8" />
                    </svg>
                  </button>
                </div>
              </div>

              <div v-if="showTemplateForm" class="sp-group__form">
                <div class="sp-group__form-grid">
                  <div class="sp-field sp-field--wide">
                    <label class="sp-field__label">{{ t('settings.git.templateName') }}</label>
                    <input class="sp-input sp-input--sm" v-model="templateForm.name"
                      placeholder="Ex. Conventional commit" />
                  </div>
                  <div class="sp-field sp-field--wide">
                    <label class="sp-field__label">{{ t('settings.git.templateSubject') }}</label>
                    <input class="sp-input sp-input--sm mono" v-model="templateForm.subject"
                      placeholder="feat(${cursor}): " />
                  </div>
                  <div class="sp-field sp-field--wide">
                    <label class="sp-field__label">{{ t('settings.git.templateBody') }} <span
                        class="sp-field__optional">— optionnel</span></label>
                    <textarea class="sp-textarea sp-input--sm mono" v-model="templateForm.body"
                      placeholder="Corps du commit…" rows="3" />
                  </div>
                </div>
                <div class="sp-group__form-footer">
                  <button class="btn btn--ghost sp-btn--sm" @click="showTemplateForm = false">{{ t('common.cancel')
                  }}</button>
                  <button class="btn btn--primary sp-btn--sm" @click="saveTemplateForm">{{ t('common.save') }}</button>
                </div>
              </div>
            </div>
          </div>
        </template>

        <!-- ═══ ÉDITEUR ═══ -->
        <template v-if="activeSettingsTab === 'editor'">
          <!-- External editor -->
          <div class="sp-row">
            <label class="sp-label" for="setting-editor">{{ t('settings.editor') }}</label>
            <input id="setting-editor" class="sp-input mono" type="text" :value="settings.editor"
              @input="updateSetting('editor', ($event.target as HTMLInputElement).value)"
              :placeholder="t('settings.editorPlaceholder')" />
          </div>

          <!-- Diff display -->
          <div class="sp-row">
            <label class="sp-label" for="setting-diff-mode">{{ t('settings.diffDisplay') }}</label>
            <select id="setting-diff-mode" class="sp-select" :value="settings.diffMode"
              @change="onDiffModeChange(($event.target as HTMLSelectElement).value as DiffMode)">
              <option value="inline">{{ t('settings.diffInline') }}</option>
              <option value="side-by-side">{{ t('settings.diffSideBySide') }}</option>
            </select>
          </div>

          <!-- Font size -->
          <div class="sp-row">
            <label class="sp-label" for="setting-font-size">{{ t('settings.fontSize') }}</label>
            <div class="sp-range-row">
              <input id="setting-font-size" class="sp-range" type="range" min="10" max="18" step="1"
                :value="settings.fontSize"
                @input="onFontSizeChange(Number(($event.target as HTMLInputElement).value))" />
              <span class="sp-range-value mono">{{ settings.fontSize }}px</span>
            </div>
          </div>

          <!-- Tab size -->
          <div class="sp-row">
            <label class="sp-label" for="setting-tab-size">{{ t('settings.tabSize') }}</label>
            <select id="setting-tab-size" class="sp-select" :value="settings.tabSize"
              @change="onTabSizeChange(Number(($event.target as HTMLSelectElement).value))">
              <option :value="2">2 {{ t('settings.spaces') }}</option>
              <option :value="4">4 {{ t('settings.spaces') }}</option>
              <option :value="8">8 {{ t('settings.spaces') }}</option>
            </select>
          </div>

          <!-- Terminal font size -->
          <div class="sp-row">
            <label class="sp-label" for="setting-terminal-font-size">{{ t('settings.terminalFontSize') }}</label>
            <div class="sp-range-row">
              <input id="setting-terminal-font-size" class="sp-range" type="range" min="10" max="24" step="1"
                :value="settings.terminalFontSize"
                @input="updateSetting('terminalFontSize', Math.max(10, Math.min(24, Number(($event.target as HTMLInputElement).value))))" />
              <span class="sp-range-value mono">{{ settings.terminalFontSize }}px</span>
            </div>
          </div>

          <!-- Terminal shell override -->
          <div class="sp-row">
            <label class="sp-label" for="setting-terminal-shell">{{ t('settings.terminalShell') }}</label>
            <input id="setting-terminal-shell" class="sp-input mono" type="text" :value="settings.terminalShell"
              @input="updateSetting('terminalShell', ($event.target as HTMLInputElement).value)"
              :placeholder="t('settings.terminalShellHint')" />
          </div>
        </template>

        <!-- ═══ INTELLIGENCE ARTIFICIELLE ═══ -->
        <template v-if="activeSettingsTab === 'ai'">
          <!-- Enable AI -->
          <div class="sp-row sp-row--checkbox">
            <label class="sp-checkbox-label" for="setting-ai-enabled">
              <input id="setting-ai-enabled" type="checkbox" class="sp-checkbox" :checked="settings.aiEnabled"
                @change="onAIEnabledChange" />
              <span>{{ t('settings.aiEnable') }}</span>
            </label>
            <span class="sp-hint">{{ t('settings.aiEnableHint') }}</span>
          </div>

          <template v-if="settings.aiEnabled">
            <!-- Provider -->
            <div class="sp-row">
              <label class="sp-label" for="setting-ai-provider">{{ t('settings.aiProviderLabel') }}</label>
              <select id="setting-ai-provider" class="sp-select" :value="settings.aiProvider"
                @change="onAIProviderChange(($event.target as HTMLSelectElement).value as AIProvider)">
                <option value="claude">{{ t('settings.aiProviderClaude') }}</option>
                <option value="claude-code-cli">
                  {{ t('settings.aiProviderClaudeCli') }}{{ claudeCliInfo && !claudeCliInfo.found ?
                    t('settings.aiProviderClaudeCliNotFound') : '' }}
                </option>
                <option value="codex-cli">
                  {{ t('settings.aiProviderCodexCli') }}{{ codexCliInfo && !codexCliInfo.found ?
                    t('settings.aiProviderCodexCliNotFound') : '' }}
                </option>
                <option value="opencode-cli">
                  {{ t('settings.aiProviderOpencodeCli') }}{{ opencodeCliInfo && !opencodeCliInfo.found ?
                    t('settings.aiProviderOpencodeCliNotFound') : '' }}
                </option>
                <option value="copilot-cli">
                  {{ t('settings.aiProviderCopilotCli') }}{{ copilotCliInfo && !copilotCliInfo.found ?
                    t('settings.aiProviderCopilotCliNotFound') : '' }}
                </option>
                <option value="openai-compat">{{ t('settings.aiProviderOpenAiCompat') }}</option>
                <option value="ollama" :disabled="!ollamaAvailable">
                  {{ t('settings.aiProviderOllama') }}{{ ollamaAvailable ? '' : t('settings.aiProviderOllamaNotFound')
                  }}
                </option>
              </select>
            </div>

            <!-- Per-provider model picker for CLI agents (v2.17). Dynamic
                 enumeration for opencode (`opencode models`); curated aliases
                 for Claude Code; free-text fallback for Codex. -->
            <div v-if="isCliAgentProvider" class="sp-row">
              <label class="sp-label" for="setting-ai-cli-model">{{ t('settings.aiModelLabel') }}</label>
              <select v-if="cliModelOptions.length > 0" id="setting-ai-cli-model" class="sp-select"
                :value="currentCliModel()"
                @change="onCliModelChange(($event.target as HTMLSelectElement).value)">
                <option value="">{{ t('settings.aiModelCliDefault') }}</option>
                <option v-for="m in cliModelOptions" :key="m" :value="m">{{ m }}</option>
              </select>
              <input v-else id="setting-ai-cli-model" class="sp-input mono" type="text"
                :value="currentCliModel()"
                @input="onCliModelChange(($event.target as HTMLInputElement).value)"
                :placeholder="t('settings.aiModelCliPlaceholder')" />
              <span class="sp-hint">
                {{ cliModelsLoading ? t('settings.aiModelCliLoading') : t('settings.aiModelCliHint') }}
                <button v-if="settings.aiProvider === 'opencode-cli'" class="sp-text-btn" @click="loadCliModels()">
                  {{ t('settings.aiModelCliRefresh') }}
                </button>
              </span>
            </div>

            <!-- Claude provider -->
            <template v-if="settings.aiProvider === 'claude'">
              <!-- Auth mode selector -->
              <div class="sp-row">
                <div class="sp-label">{{ t('settings.aiAuthLabel') }}</div>
                <div class="sp-auth-toggle">
                  <button :class="['sp-auth-btn', { 'sp-auth-btn--active': claudeAuthMode === 'connect' }]"
                    @click="claudeAuthMode = 'connect'">
                    {{ t('settings.aiAuthConnect') }}
                  </button>
                  <button :class="['sp-auth-btn', { 'sp-auth-btn--active': claudeAuthMode === 'apikey' }]"
                    @click="claudeAuthMode = 'apikey'">
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
                    <button class="sp-disconnect-btn" @click="disconnectClaude">{{ t('settings.aiAuthDisconnect')
                    }}</button>
                  </div>
                </div>
                <div v-else class="sp-row">
                  <div class="sp-connect-flow">
                    <!-- Step 1: Start -->
                    <div v-if="claudeConnectStep === 'idle'" class="sp-connect-start">
                      <button class="sp-connect-btn" @click="startClaudeConnect">
                        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor"
                          stroke-width="1.5">
                          <path d="M9 1C4.58 1 1 4.58 1 9s3.58 8 8 8 8-3.58 8-8-3.58-8-8-8z" />
                          <path d="M6 9h6M9 6v6" />
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
                        <input v-model="claudeConnectKeyInput" class="sp-input mono sp-input--key" type="password"
                          placeholder="sk-ant-api03-..."
                          @keydown.enter="validateAndSaveClaudeKey(claudeConnectKeyInput)" />
                        <button class="sp-connect-save-btn" :disabled="!claudeConnectKeyInput.trim()"
                          @click="validateAndSaveClaudeKey(claudeConnectKeyInput)">
                          {{ t('settings.aiConnectSave') }}
                        </button>
                      </div>
                      <div v-if="claudeConnectError" class="sp-connect-error">{{ claudeConnectError }}</div>
                      <button class="sp-text-btn" @click="claudeConnectStep = 'idle'">{{ t('settings.aiConnectCancel')
                      }}</button>
                    </div>

                    <!-- Step 3: Success -->
                    <div v-if="claudeConnectStep === 'success'" class="sp-connect-success">
                      {{ t('settings.aiConnectSuccess') }}
                    </div>

                    <!-- Step 3b: Error -->
                    <div v-if="claudeConnectStep === 'error'" class="sp-connect-error-block">
                      <div class="sp-connect-error">{{ claudeConnectError }}</div>
                      <button class="sp-text-btn" @click="claudeConnectStep = 'waiting'">{{ t('settings.aiConnectRetry')
                      }}</button>
                    </div>
                  </div>
                </div>
              </template>

              <!-- Manual API key mode -->
              <template v-if="claudeAuthMode === 'apikey'">
                <div class="sp-row">
                  <label class="sp-label" for="setting-ai-key">{{ t('settings.aiApiKeyLabel') }}</label>
                  <div class="sp-key-row">
                    <input id="setting-ai-key" class="sp-input mono sp-input--key"
                      :type="showApiKey ? 'text' : 'password'" :value="settings.aiApiKey"
                      @input="updateSetting('aiApiKey', ($event.target as HTMLInputElement).value)"
                      placeholder="sk-ant-api03-..." />
                    <button class="sp-key-toggle" @click="showApiKey = !showApiKey"
                      :title="showApiKey ? t('settings.aiHideKey') : t('settings.aiShowKey')">
                      <svg v-if="showApiKey" width="16" height="16" viewBox="0 0 16 16" fill="none"
                        stroke="currentColor" stroke-width="1.3">
                        <path d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" />
                        <circle cx="8" cy="8" r="2" />
                      </svg>
                      <svg v-else width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                        stroke-width="1.3">
                        <path d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" />
                        <circle cx="8" cy="8" r="2" />
                        <path d="M3 13L13 3" stroke-width="1.5" />
                      </svg>
                    </button>
                  </div>
                  <span class="sp-hint">{{ t('settings.aiApiKeyAvailable') }} <a
                      href="https://console.anthropic.com/settings/keys" target="_blank"
                      class="sp-link">console.anthropic.com</a></span>
                </div>
              </template>

              <div class="sp-row">
                <label class="sp-label" for="setting-ai-model-claude">{{ t('settings.aiModelLabel') }}</label>
                <select id="setting-ai-model-claude" class="sp-select" :value="settings.aiModel"
                  @change="updateSetting('aiModel', ($event.target as HTMLSelectElement).value)">
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
                      <button class="sp-disconnect-btn" @click="runClaudeCliDetect">{{ t('settings.aiCliRedetect')
                      }}</button>
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
                      <button class="sp-disconnect-btn" @click="runClaudeCliDetect">{{ t('settings.aiCliRedetect')
                      }}</button>
                    </div>
                    <span class="sp-hint">{{ t('settings.aiCliDetectedHint') }}</span>
                  </template>
                  <template v-else>
                    <div class="sp-connect-error-block">
                      <div class="sp-connect-error">
                        {{ t('settings.aiCliNotAuthenticated') }}
                      </div>
                      <span class="sp-hint">{{ claudeCliInfo.detail || t('settings.aiCliLoginHint') }}</span>
                      <button class="sp-connect-btn" :disabled="claudeCliLoginLoading" @click="runClaudeCliLogin">
                        {{ claudeCliLoginLoading ? t('settings.aiCliLoginWaiting') : t('settings.aiCliLoginButton') }}
                      </button>
                    </div>
                  </template>
                </div>
              </div>

              <div v-if="claudeCliInfo?.logged_in" class="sp-info-box">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
                  <circle cx="8" cy="8" r="7" />
                  <path d="M8 7v4" stroke-linecap="round" />
                  <circle cx="8" cy="5" r="0.7" fill="currentColor" stroke="none" />
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
                      <button class="sp-disconnect-btn" @click="runCodexCliDetect">{{ t('settings.aiCliRedetect')
                      }}</button>
                    </div>
                    <span class="sp-hint">{{ t('settings.aiCodexCliConnectedHint') }}</span>
                  </template>
                  <template v-else-if="codexCliInfo.status === 'detected'">
                    <!-- Detected, auth not verified — see Claude block above. -->
                    <div class="sp-connected-badge">
                      <span class="sp-connected-dot sp-connected-dot--neutral"></span>
                      <span>{{ t('settings.aiCliDetected', codexCliInfo.version || 'codex') }}</span>
                      <button class="sp-disconnect-btn" @click="runCodexCliDetect">{{ t('settings.aiCliRedetect')
                      }}</button>
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
                  <circle cx="8" cy="8" r="7" />
                  <path d="M8 7v4" stroke-linecap="round" />
                  <circle cx="8" cy="5" r="0.7" fill="currentColor" stroke="none" />
                </svg>
                <p>{{ t('settings.aiCodexCliInfoBox') }}</p>
              </div>
            </template>

            <!-- opencode CLI provider (v2.17) — same shape as the Codex block -->
            <template v-if="settings.aiProvider === 'opencode-cli'">
              <div class="sp-row">
                <div class="sp-label">{{ t('settings.aiCliStatus') }}</div>
                <div class="sp-cli-status">
                  <template v-if="opencodeCliDetecting">
                    <span class="sp-hint">{{ t('settings.aiCliDetecting') }}</span>
                  </template>
                  <template v-else-if="!opencodeCliInfo || !opencodeCliInfo.found">
                    <div class="sp-connect-error-block">
                      <div class="sp-connect-error">
                        {{ t('settings.aiCliNotFound') }} <code>opencode</code> {{ t('settings.aiCliNotFoundSuffix') }}
                      </div>
                      <span class="sp-hint">
                        {{ t('settings.aiCliInstallHint') }}
                        <code>npm install -g opencode-ai</code>
                        {{ t('settings.aiCliInstallHintSuffix') }}
                      </span>
                      <button class="sp-text-btn" @click="runOpencodeCliDetect">{{ t('settings.aiCliRedetect') }}</button>
                    </div>
                  </template>
                  <template v-else>
                    <!-- Detected. Auth is provider-scoped inside opencode and
                         verified implicitly on first use; we don't ping. -->
                    <div class="sp-connected-badge">
                      <span class="sp-connected-dot sp-connected-dot--neutral"></span>
                      <span>{{ t('settings.aiCliDetected', opencodeCliInfo.version || 'opencode') }}</span>
                      <button class="sp-disconnect-btn" @click="runOpencodeCliDetect">{{ t('settings.aiCliRedetect')
                      }}</button>
                    </div>
                    <span class="sp-hint">{{ t('settings.aiOpencodeCliDetectedHint') }}</span>
                  </template>
                </div>
              </div>

              <div v-if="opencodeCliInfo?.found" class="sp-info-box">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
                  <circle cx="8" cy="8" r="7" />
                  <path d="M8 7v4" stroke-linecap="round" />
                  <circle cx="8" cy="5" r="0.7" fill="currentColor" stroke="none" />
                </svg>
                <p>{{ t('settings.aiOpencodeCliInfoBox') }}</p>
              </div>
            </template>

            <!-- GitHub Copilot CLI provider — same shape as the opencode block -->
            <template v-if="settings.aiProvider === 'copilot-cli'">
              <div class="sp-row">
                <div class="sp-label">{{ t('settings.aiCliStatus') }}</div>
                <div class="sp-cli-status">
                  <template v-if="copilotCliDetecting">
                    <span class="sp-hint">{{ t('settings.aiCliDetecting') }}</span>
                  </template>
                  <template v-else-if="!copilotCliInfo || !copilotCliInfo.found">
                    <div class="sp-connect-error-block">
                      <div class="sp-connect-error">
                        {{ t('settings.aiCliNotFound') }} <code>copilot</code> {{ t('settings.aiCliNotFoundSuffix') }}
                      </div>
                      <span class="sp-hint">
                        {{ t('settings.aiCliInstallHint') }}
                        <code>npm install -g @github/copilot</code>
                        {{ t('settings.aiCliInstallHintSuffix') }}
                      </span>
                      <button class="sp-text-btn" @click="runCopilotCliDetect">{{ t('settings.aiCliRedetect') }}</button>
                    </div>
                  </template>
                  <template v-else>
                    <!-- Detected. Auth is managed by Copilot itself and
                         verified implicitly on first use; we don't ping. -->
                    <div class="sp-connected-badge">
                      <span class="sp-connected-dot sp-connected-dot--neutral"></span>
                      <span>{{ t('settings.aiCliDetected', copilotCliInfo.version || 'copilot') }}</span>
                      <button class="sp-disconnect-btn sp-disconnect-btn--neutral" @click="runCopilotCliDetect">{{ t('settings.aiCliRedetect')
                      }}</button>
                    </div>
                    <span class="sp-hint">{{ t('settings.aiCopilotCliDetectedHint') }}</span>
                  </template>
                </div>
              </div>

              <div v-if="copilotCliInfo?.found" class="sp-info-box">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
                  <circle cx="8" cy="8" r="7" />
                  <path d="M8 7v4" stroke-linecap="round" />
                  <circle cx="8" cy="5" r="0.7" fill="currentColor" stroke="none" />
                </svg>
                <p>{{ t('settings.aiCopilotCliInfoBox') }}</p>
              </div>
            </template>

            <!-- OpenAI-compatible provider -->
            <template v-if="settings.aiProvider === 'openai-compat'">
              <div class="sp-row">
                <label class="sp-label" for="setting-ai-endpoint">{{ t('settings.aiCompatEndpoint') }}</label>
                <input id="setting-ai-endpoint" class="sp-input mono" type="text" :value="settings.aiApiEndpoint"
                  @input="updateSetting('aiApiEndpoint', ($event.target as HTMLInputElement).value)"
                  placeholder="https://api.openai.com/v1" />
                <span class="sp-hint">{{ t('settings.aiCompatEndpointHint') }}</span>
              </div>

              <div class="sp-row">
                <label class="sp-label" for="setting-ai-key-compat">{{ t('settings.aiCompatApiKey') }}</label>
                <div class="sp-key-row">
                  <input id="setting-ai-key-compat" class="sp-input mono sp-input--key"
                    :type="showApiKey ? 'text' : 'password'" :value="settings.aiApiKey"
                    @input="updateSetting('aiApiKey', ($event.target as HTMLInputElement).value)"
                    placeholder="sk-..." />
                  <button class="sp-key-toggle" @click="showApiKey = !showApiKey"
                    :title="showApiKey ? t('settings.aiHideKey') : t('settings.aiShowKey')">
                    <svg v-if="showApiKey" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                      stroke-width="1.3">
                      <path d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" />
                      <circle cx="8" cy="8" r="2" />
                    </svg>
                    <svg v-else width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                      stroke-width="1.3">
                      <path d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" />
                      <circle cx="8" cy="8" r="2" />
                      <path d="M3 13L13 3" stroke-width="1.5" />
                    </svg>
                  </button>
                </div>
              </div>

              <div class="sp-row">
                <label class="sp-label" for="setting-ai-model-compat">{{ t('settings.aiModelLabel') }}</label>
                <input id="setting-ai-model-compat" class="sp-input mono" type="text" :value="settings.aiModel"
                  @input="updateSetting('aiModel', ($event.target as HTMLInputElement).value)" placeholder="gpt-4o" />
              </div>
            </template>

            <!-- Ollama provider -->
            <template v-if="settings.aiProvider === 'ollama'">
              <div class="sp-row">
                <label class="sp-label" for="setting-ai-ollama-url">{{ t('settings.aiOllamaUrl') }}</label>
                <div class="sp-key-row">
                  <input id="setting-ai-ollama-url" class="sp-input mono sp-input--key" type="text"
                    :value="settings.aiOllamaUrl"
                    @input="updateSetting('aiOllamaUrl', ($event.target as HTMLInputElement).value)"
                    placeholder="http://localhost:11434" />
                  <button class="sp-key-toggle" @click="detectOllama" :title="t('settings.aiOllamaTest')">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                      stroke-width="1.3">
                      <path d="M14 8A6 6 0 112 8" />
                      <path d="M14 8l-2-2m2 2l-2 2" />
                    </svg>
                  </button>
                </div>
                <span class="sp-hint" :class="{ 'sp-hint--ok': ollamaAvailable }">
                  {{ ollamaAvailable ? t('settings.aiOllamaConnected', ollamaModels.length) :
                    t('settings.aiOllamaNotConnected') }}
                </span>
              </div>

              <div class="sp-row" v-if="ollamaAvailable">
                <label class="sp-label" for="setting-ai-ollama-model">{{ t('settings.aiModelLabel') }}</label>
                <select v-if="ollamaModels.length > 0" id="setting-ai-ollama-model" class="sp-select"
                  :value="settings.aiOllamaModel"
                  @change="updateSetting('aiOllamaModel', ($event.target as HTMLSelectElement).value)">
                  <option v-for="model in ollamaModels" :key="model" :value="model">{{ model }}</option>
                </select>
                <input v-else id="setting-ai-ollama-model" class="sp-input mono" type="text"
                  :value="settings.aiOllamaModel"
                  @input="updateSetting('aiOllamaModel', ($event.target as HTMLInputElement).value)"
                  placeholder="codellama" />
              </div>
            </template>

            <!-- ─── Prompt Presets (v2.13) ─────────────────── -->
            <div class="sp-section-divider sp-section-divider--inner"></div>
            <div class="sp-group">
              <div class="sp-group__head">
                <div class="sp-group__head-text">
                  <span class="sp-group__label">{{ t('settings.ai.presets.title') }}</span>
                  <span class="sp-group__sublabel">{{ t('settings.ai.presets.hint') }}</span>
                </div>
                <button v-if="!showPresetForm" class="sp-group__action" @click="openAddPreset">
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5"
                    aria-hidden="true">
                    <path d="M8 3v10M3 8h10" />
                  </svg>
                  {{ t('settings.ai.presets.add') }}
                </button>
              </div>

              <div class="sp-group__body">
                <!-- Built-in presets -->
                <div v-for="preset in BUILTIN_PRESETS" :key="preset.id" class="sp-group__row sp-group__row--muted">
                  <div class="sp-group__row-info">
                    <span class="sp-group__row-name">{{ preset.name }}</span>
                    <span class="sp-group__row-meta">{{ preset.description }}</span>
                  </div>
                  <div class="sp-group__row-aside" style="opacity:1">
                    <span class="sp-tag">{{ t('settings.ai.presets.builtinBadge') }}</span>
                  </div>
                </div>

                <!-- Divider built-in → custom -->
                <div class="sp-group__sep">{{ t('settings.ai.presets.customLabel') }}</div>

                <!-- Custom presets empty -->
                <div v-if="userPresets.length === 0 && !showPresetForm" class="sp-group__empty">
                  {{ t('settings.ai.presets.empty') }}
                </div>

                <!-- Custom preset rows -->
                <div v-for="preset in userPresets" :key="preset.id" class="sp-group__row">
                  <div class="sp-group__row-info">
                    <span class="sp-group__row-name">{{ preset.name }}</span>
                    <span class="sp-group__row-meta">{{ preset.description || '—' }}</span>
                  </div>
                  <div class="sp-group__row-aside">
                    <button class="sp-ghost-btn" @click="openEditPreset(preset)"
                      :title="t('settings.git.identityEdit')">
                      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                        stroke-width="1.5">
                        <path d="M11.5 2.5l2 2L5 13H3v-2L11.5 2.5z" />
                      </svg>
                    </button>
                    <button class="sp-ghost-btn sp-ghost-btn--danger" @click="removePreset(preset.id)"
                      :title="t('settings.git.identityDelete')">
                      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                        stroke-width="1.5">
                        <path d="M4 4l8 8M12 4l-8 8" />
                      </svg>
                    </button>
                  </div>
                </div>

                <!-- Preset add/edit form -->
                <div v-if="showPresetForm" class="sp-group__form">
                  <div class="sp-group__form-grid sp-group__form-grid--1col">
                    <div class="sp-field">
                      <label class="sp-field__label">{{ t('settings.ai.presets.formName') }}</label>
                      <input class="sp-input sp-input--sm" v-model="presetForm.name"
                        :placeholder="t('settings.ai.presets.formName')" />
                    </div>
                    <div class="sp-field">
                      <label class="sp-field__label">{{ t('settings.ai.presets.formDescription') }} <span
                          class="sp-field__optional">— optionnel</span></label>
                      <input class="sp-input sp-input--sm" v-model="presetForm.description"
                        :placeholder="t('settings.ai.presets.formDescription')" />
                    </div>
                    <div class="sp-field">
                      <label class="sp-field__label">Prompt système</label>
                      <textarea class="sp-textarea sp-input--sm mono" v-model="presetForm.systemPrompt"
                        :placeholder="t('settings.ai.presets.formPromptPlaceholder')" rows="6" />
                      <span class="sp-field__hint">{{ t('settings.ai.presets.formLangHint') }}</span>
                    </div>
                  </div>
                  <div class="sp-group__form-footer">
                    <button class="btn btn--ghost sp-btn--sm" @click="showPresetForm = false">{{ t('common.cancel')
                    }}</button>
                    <button class="btn btn--primary sp-btn--sm" @click="savePresetForm"
                      :disabled="!presetForm.name.trim() || !presetForm.systemPrompt.trim()">{{ t('common.save')
                      }}</button>
                  </div>
                </div>
              </div>
            </div>

            <!-- AI info box -->
            <div class="sp-info-box">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
                <circle cx="8" cy="8" r="7" />
                <path d="M8 7v4" stroke-linecap="round" />
                <circle cx="8" cy="5" r="0.7" fill="currentColor" stroke="none" />
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
              <circle cx="8" cy="8" r="7" />
              <path d="M8 7v4" stroke-linecap="round" />
              <circle cx="8" cy="5" r="0.7" fill="currentColor" stroke="none" />
            </svg>
            <p>{{ t('settings.ai.fallback.noRepo.message') }}</p>
          </div>

          <template v-else>
            <!-- Enable toggle + disclaimer -->
            <div class="sp-row sp-row--checkbox">
              <label class="sp-checkbox-label" for="setting-llm-fallback-enabled">
                <input id="setting-llm-fallback-enabled" type="checkbox" class="sp-checkbox"
                  :checked="llmFallback.enabled" :disabled="llmFallbackLoading" @change="onLlmFallbackEnabledChange" />
                <span>{{ t('settings.ai.fallback.enable.label') }}</span>
              </label>
              <span class="sp-hint">{{ t('settings.ai.fallback.enable.help') }}</span>
            </div>

            <div v-if="llmFallback.enabled" class="sp-warning-box">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
                <path d="M8 1.5L1 14h14L8 1.5z" stroke-linejoin="round" />
                <path d="M8 6v4" stroke-linecap="round" />
                <circle cx="8" cy="12" r="0.7" fill="currentColor" stroke="none" />
              </svg>
              <p>{{ t('settings.ai.fallback.warning') }}</p>
            </div>

            <!-- Policy conflict warning -->
            <div v-if="llmFallback.enabled && llmFallbackPolicyConflict" class="sp-info-box sp-info-box--warning">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
                <circle cx="8" cy="8" r="7" />
                <path d="M8 5v4" stroke-linecap="round" />
                <circle cx="8" cy="11.5" r="0.7" fill="currentColor" stroke="none" />
              </svg>
              <p>{{ t('settings.ai.fallback.policyConflict.warning') }}</p>
            </div>

            <template v-if="llmFallback.enabled">
              <!-- Provider -->
              <div class="sp-row">
                <label class="sp-label" for="setting-llm-fallback-provider">{{ t('settings.ai.fallback.provider.label')
                }}</label>
                <select id="setting-llm-fallback-provider" class="sp-select" :value="llmFallback.provider"
                  @change="onLlmFallbackProviderChange(($event.target as HTMLSelectElement).value as LlmFallbackProvider)">
                  <option value="claude">{{ t('settings.aiProviderClaude') }}</option>
                  <option value="claude-code-cli">{{ t('settings.aiProviderClaudeCli') }}</option>
                  <option value="codex-cli">{{ t('settings.aiProviderCodexCli') }}</option>
                  <option value="opencode-cli">{{ t('settings.aiProviderOpencodeCli') }}</option>
                  <option value="copilot-cli">{{ t('settings.aiProviderCopilotCli') }}</option>
                  <option value="openai-compat">{{ t('settings.aiProviderOpenAiCompat') }}</option>
                  <option value="ollama">{{ t('settings.aiProviderOllama') }}</option>
                  <option value="mcp">MCP (Claude Code / Cursor)</option>
                </select>
              </div>

              <!-- Min post-merge score (slider 50-100) -->
              <div class="sp-row">
                <label class="sp-label" for="setting-llm-fallback-min-score">{{ t('settings.ai.fallback.minScore.label')
                }}</label>
                <div class="sp-range-row">
                  <input id="setting-llm-fallback-min-score" type="range" class="sp-range" min="50" max="100" step="1"
                    :value="llmFallback.minPostMergeScore"
                    @input="onLlmFallbackMinScoreChange(Number(($event.target as HTMLInputElement).value))" />
                  <span class="sp-range-value">{{ llmFallback.minPostMergeScore }}</span>
                </div>
                <span class="sp-hint">{{ t('settings.ai.fallback.minScore.help') }}</span>
              </div>

              <!-- Context lines (input number 10-200) -->
              <div class="sp-row">
                <label class="sp-label" for="setting-llm-fallback-context-lines">{{
                  t('settings.ai.fallback.contextLines.label') }}</label>
                <input id="setting-llm-fallback-context-lines" type="number" class="sp-input" min="10" max="200"
                  step="1" :value="llmFallback.contextLines"
                  @input="onLlmFallbackContextLinesChange(Number(($event.target as HTMLInputElement).value))" />
              </div>

              <!-- Min mode -->
              <div class="sp-row">
                <label class="sp-label" for="setting-llm-fallback-min-mode">{{ t('settings.ai.fallback.minMode.label')
                }}</label>
                <select id="setting-llm-fallback-min-mode" class="sp-select" :value="llmFallback.minMode"
                  @change="onLlmFallbackMinModeChange(($event.target as HTMLSelectElement).value as MinMode)">
                  <option value="off">off</option>
                  <option value="balanced">balanced</option>
                  <option value="strict">strict</option>
                </select>
              </div>
            </template>

            <!-- Save button (always visible when a repo is open) -->
            <div class="sp-row">
              <button class="bm-btn bm-btn--primary sp-llm-save-btn" :disabled="llmFallbackSaving || llmFallbackLoading"
                @click="saveLlmFallback">
                {{ llmFallbackSaving ? t('common.loading') : t('settings.ai.fallback.save.button') }}
              </button>
              <span v-if="llmFallbackSaveSuccess" class="sp-hint sp-hint--ok">{{ t('settings.ai.fallback.save.button')
              }} OK</span>
              <span v-if="llmFallbackSaveError" class="sp-connect-error">{{ llmFallbackSaveError }}</span>
            </div>
          </template>
        </template>

        <!-- ═══ RELEASE NOTES ═══ -->
        <template v-if="activeSettingsTab === 'releaseNotes'">
          <div class="sp-group">
            <div class="sp-group__head">
              <div class="sp-group__head-text">
                <span class="sp-group__label">{{ t('settings.ai.releaseNotes.title') }}</span>
                <span class="sp-group__sublabel">
                  {{ t('settings.ai.releaseNotes.hint') }}
                  <span style="display: block; margin-top: 4px; font-style: italic; opacity: 0.85;">
                    {{ t('settings.ai.releaseNotes.sharedNote') }}
                  </span>
                </span>
              </div>
            </div>

            <div class="sp-group__body">
              <!-- Custom templates empty -->
              <div v-if="settings.releaseNoteTemplates.length === 0 && !showReleaseNoteTemplateForm" class="sp-group__empty">
                {{ t('settings.ai.releaseNotes.empty') }}
              </div>

              <!-- Custom template rows -->
              <div v-for="tpl in settings.releaseNoteTemplates" :key="tpl.id" class="sp-group__row">
                <div class="sp-group__row-info">
                  <span class="sp-group__row-name">{{ tpl.name }}</span>
                  <span class="sp-group__row-meta mono" style="font-size: var(--font-size-xs); max-height: 48px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 500px;">
                    {{ tpl.customRules }}
                  </span>
                </div>
                <div class="sp-group__row-aside">
                  <button class="sp-ghost-btn" @click="openEditReleaseNoteTemplate(tpl)"
                    :title="t('settings.git.identityEdit')">
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                      stroke-width="1.5">
                      <path d="M11.5 2.5l2 2L5 13H3v-2L11.5 2.5z" />
                    </svg>
                  </button>
                  <button class="sp-ghost-btn sp-ghost-btn--danger" @click="deleteReleaseNoteTemplate(tpl.id)"
                    :title="t('settings.git.identityDelete')">
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                      stroke-width="1.5">
                      <path d="M4 4l8 8M12 4l-8 8" />
                    </svg>
                  </button>
                </div>
              </div>

              <!-- Template add/edit form -->
              <div v-if="showReleaseNoteTemplateForm" class="sp-group__form">
                <div class="sp-group__form-grid sp-group__form-grid--1col">
                  <div class="sp-field">
                    <label class="sp-field__label">{{ t('settings.ai.releaseNotes.formName') }}</label>
                    <input class="sp-input sp-input--sm" v-model="releaseNoteTemplateForm.name"
                      :placeholder="t('settings.ai.releaseNotes.formName')" />
                  </div>
                  <div class="sp-field">
                    <label class="sp-field__label">{{ t('settings.ai.releaseNotes.formRules') }}</label>
                    <textarea class="sp-textarea sp-input--sm mono" style="min-height: 260px;" v-model="releaseNoteTemplateForm.customRules"
                      :placeholder="t('settings.ai.releaseNotes.formRulesPlaceholder')" rows="12" />
                  </div>
                </div>
                <div class="sp-group__form-footer">
                  <button class="btn btn--ghost sp-btn--sm" @click="showReleaseNoteTemplateForm = false">{{ t('common.cancel')
                  }}</button>
                  <button class="btn btn--primary sp-btn--sm" @click="saveReleaseNoteTemplateForm"
                    :disabled="!releaseNoteTemplateForm.name.trim() || !releaseNoteTemplateForm.customRules.trim()">{{ t('common.save')
                    }}</button>
                </div>
              </div>
            </div>

            <button v-if="!showReleaseNoteTemplateForm" class="btn btn--primary add-btn" @click="openAddReleaseNoteTemplate">
                {{ t('settings.ai.releaseNotes.add') }}
            </button>
          </div>
        </template>

        <!-- ═══ AUTOMATIONS ═══ -->
        <!-- ═══ ACCOUNTS ═══ -->
        <template v-if="activeSettingsTab === 'accounts'">
          <SettingsAccountsTab />
        </template>

        <!-- ═══ MCP ═══ -->
        <template v-if="activeSettingsTab === 'mcp'">
          <SettingsMcpTab :cwd="props.cwd" />
        </template>

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
            <div class="sp-logs-actions">
              <button v-if="(props.errorLog?.length ?? 0) > 0" class="bm-btn bm-btn--ghost" @click="copyAllLogs">
                {{ t('settings.logsCopyAll') }}
              </button>
              <button v-if="(props.errorLog?.length ?? 0) > 0" class="bm-btn bm-btn--ghost" @click="emit('clearLogs')">
                {{ t('settings.logsClear') }}
              </button>
            </div>
          </div>
          <div v-if="!props.errorLog?.length" class="sp-logs-empty">{{ t('settings.logsEmpty') }}</div>
          <ul v-else class="sp-logs-list">
            <!-- Newest entries first — the underlying buffer is append-only,
                 so we reverse a shallow copy at render time. -->
            <li v-for="entry in [...(props.errorLog ?? [])].reverse()"
              :key="entry.id ?? (entry.timestamp + ':' + entry.message)" class="sp-log-entry"
              :class="`sp-log-entry--${entry.level}`">
              <span class="sp-log-line">
                <span class="log-ts">{{ formatLogTimestamp(entry.timestamp) }}</span>
                <span class="log-level" :class="`log-level--${entry.level}`">{{ logLevelLabel(entry.level) }}</span>
                <span class="log-msg">{{ entry.message }}</span>
              </span>
              <div v-if="entry.context" class="sp-log-context">{{ entry.context }}</div>
            </li>
          </ul>
        </template>

      </div><!-- sp-content -->
    </div><!-- sp-layout -->
  </BaseModal>
</template>

<style scoped>
/* .sp-title-icon removed — use global .bm-title-icon from BaseModal instead */

/* ─── Two-column layout ────────────────────────────────── */
.sp-layout {
  display: flex;
  flex-direction: row;
  height: 72vh;
  overflow: hidden;
}

/* ─── Left nav sidebar ─────────────────────────────────── */
.sp-nav {
  width: 196px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--color-border);
  padding: var(--space-4) 0 var(--space-3);
  overflow-y: auto;
  background: var(--color-bg-subtle, var(--color-bg));
}

.sp-nav-group {
  padding: 0 var(--space-3) var(--space-5);
}

.sp-nav-group-label {
  display: block;
  padding: var(--space-2) var(--space-3);
  font-size: 11px;
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-subtle, var(--color-text-muted));
  text-transform: uppercase;
  letter-spacing: 0.07em;
  user-select: none;
}

.sp-nav-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: var(--font-weight-medium);
  color: var(--color-text-muted);
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.sp-nav-item:hover {
  background: var(--color-bg-elevated, var(--color-surface));
  color: var(--color-text);
}

.sp-nav-item--active {
  background: var(--color-bg-elevated, var(--color-surface));
  color: var(--color-text);
}

.sp-nav-item svg {
  flex-shrink: 0;
  opacity: 0.75;
}

.sp-nav-item--active svg,
.sp-nav-item:hover svg {
  opacity: 1;
}

.sp-nav-action:hover {
  color: var(--color-accent) !important;
  background: var(--color-accent-soft) !important;
}

.sp-nav-action:hover svg {
  opacity: 1;
  stroke: var(--color-accent);
}

.sp-nav-action--ok,
.sp-nav-action--ok:hover {
  color: var(--color-success) !important;
  background: var(--color-success-soft) !important;
}

.sp-nav-action--ok svg {
  stroke: var(--color-success) !important;
  opacity: 1 !important;
}

.sp-nav-action:disabled {
  opacity: 0.7;
  cursor: default;
}

@keyframes sp-spin {
  to {
    transform: rotate(360deg);
  }
}

.sp-nav-action-spin {
  animation: sp-spin 0.8s linear infinite;
}

.sp-nav-badge {
  margin-left: auto;
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

.sp-nav-spacer {
  flex: 1;
}

.sp-nav-footer {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-5);
  font-size: 11px;
  color: var(--color-text-subtle, var(--color-text-muted));
  opacity: 0.7;
  border-top: 1px solid var(--color-border);
  margin-top: var(--space-2);
}

.sp-nav-footer-name {
  font-weight: var(--font-weight-semibold);
}

.sp-nav-footer-version {
  opacity: 0.6;
}

/* ─── Right content area ───────────────────────────────── */
.sp-content {
  flex: 1;
  min-width: 0;
  padding: var(--space-7) var(--space-8);
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  overflow-y: auto;
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

/* Dock — position row: checkbox on the left, reset button pushed to the right. */
.sp-dock-pos-row {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}

.sp-dock-reset {
  flex-shrink: 0;
}

/* Dock — reorderable entry list. */
.sp-dock-order {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.sp-dock-order-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}

.sp-dock-order-name {
  font-size: var(--font-size-md);
  color: var(--color-text);
}

.sp-dock-order-actions {
  display: inline-flex;
  gap: var(--space-1);
}

.sp-dock-order-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-secondary);
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.sp-dock-order-btn:hover:not(:disabled) {
  background: var(--color-bg-hover, rgba(127, 127, 127, 0.12));
  color: var(--color-text);
}

.sp-dock-order-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
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

.sp-auth-btn:first-child {
  border-right: 1px solid var(--color-border);
}

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

.sp-connect-save-btn:hover {
  filter: brightness(1.1);
}

.sp-connect-save-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

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

.sp-text-btn:hover {
  color: var(--color-text);
}

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

.sp-disconnect-btn--neutral {
  border-color: rgba(255, 255, 255, 0.4);
  color: #ffffff;
}

.sp-disconnect-btn--neutral:hover {
  background: rgba(255, 255, 255, 0.15);
}

/* .sp-tab-badge removed — replaced by .sp-nav-badge in sidebar */

/* ─── Logs tab ─────────────────────────────────────────── */
.sp-logs-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

.sp-logs-actions {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
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
  /* Bounded height — past ~10 lines the list gets unwieldy. */
  max-height: 480px;
  overflow-y: auto;
}

.sp-log-entry {
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  font-size: var(--font-size-sm);
  line-height: 1.5;
  border-left: 3px solid transparent;
}

.sp-log-line {
  font-family: var(--font-family-mono, ui-monospace, monospace);
  font-size: var(--font-size-xs);
  word-break: break-word;
  white-space: pre-wrap;
  display: inline;
  color: var(--color-text);
}

/* Three-span layout: [timestamp] LEVEL message. Each span keeps its own
   colour so the monospace line stays readable while the level chip pops. */
.log-ts {
  color: var(--color-text-muted);
}

.log-level {
  display: inline-block;
  padding: 0 var(--space-2);
  margin: 0 var(--space-2);
  border-radius: var(--radius-sm);
  font-weight: var(--font-weight-semibold);
  font-size: var(--font-size-xs);
  letter-spacing: 0.02em;
}

.log-level--error {
  color: var(--color-danger, #f38ba8);
  background: var(--color-danger-soft, rgba(243, 139, 168, 0.12));
}

.log-level--warn {
  color: var(--color-warning, #d39e3a);
  background: var(--color-warning-soft, rgba(249, 226, 175, 0.15));
}

.log-level--info {
  color: var(--color-text-muted);
  background: var(--color-bg-tertiary, rgba(127, 127, 127, 0.12));
}

.log-msg {
  color: var(--color-text);
}

.sp-log-context {
  margin-top: var(--space-2);
  padding-left: var(--space-3);
  border-left: 2px solid var(--color-border);
  font-family: var(--font-family-mono, ui-monospace, monospace);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  white-space: pre-wrap;
  word-break: break-word;
}

/* Per-level coloring — left-border accent only. Body text inherits
   --color-text so the message stays legible on both themes. */
.sp-log-entry--error {
  border-left-color: var(--color-danger, #f38ba8);
}

.sp-log-entry--warn {
  border-left-color: var(--color-warning, #f9e2af);
}

.sp-log-entry--info {
  border-left-color: var(--color-info, #89b4fa);
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

/* ── v2.12 section header ── */
.sp-section-header {
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
  margin-top: var(--space-5);
  margin-bottom: var(--space-2);
  padding-bottom: var(--space-1);
  border-bottom: 1px solid var(--color-border);
}

.sp-empty-hint {
  font-size: var(--font-size-sm);
  color: var(--color-text-subtle);
  padding: var(--space-2) 0;
}

/* ── sp-group (identities / templates) ── */
.sp-group {
  margin-top: var(--space-5);
}

.sp-group__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-2);
}

.sp-group__label {
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
}

.sp-group__actions {
  display: flex;
  gap: var(--space-2);
}

.sp-group__action {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-accent);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
  transition: background var(--transition-base);
}

.sp-group__action:hover:not(:disabled) {
  background: var(--color-accent-soft, rgba(var(--color-accent-rgb, 100 100 255) / 0.1));
}

.sp-group__action:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.sp-group__action--muted {
  color: var(--color-text-muted);
}

.sp-group__action--muted:hover:not(:disabled) {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}

.sp-group__body {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
}

/* ── Group rows ── */
.sp-group__row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  background: var(--color-bg);
  border-bottom: 1px solid var(--color-border);
  transition: background var(--transition-base);
}

.sp-group__row:last-child {
  border-bottom: none;
}

.sp-group__row:hover {
  background: var(--color-bg-secondary);
}

.sp-group__row:hover .sp-group__row-aside {
  opacity: 1;
}

.sp-group__row-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.sp-group__row-name {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--color-text);
}

.sp-group__row-meta {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sp-group__row-aside {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex-shrink: 0;
  opacity: 0;
  transition: opacity var(--transition-base);
}

/* ── Empty state ── */
.sp-group__empty {
  padding: var(--space-4) var(--space-3);
  font-size: var(--font-size-sm);
  color: var(--color-text-subtle);
  text-align: center;
  background: var(--color-bg);
}

/* ── Inline form ── */
.sp-group__form {
  padding: var(--space-4);
}

.sp-group__form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3) var(--space-4);
}

.sp-group__form-footer {
  display: flex;
  justify-content: space-between;
  gap: var(--space-2);
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid var(--color-border);
}

/* ── Ghost icon buttons ── */
.sp-ghost-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background var(--transition-base), color var(--transition-base);
}

.sp-ghost-btn:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}

.sp-ghost-btn--danger:hover {
  background: var(--color-danger-soft, rgba(220 80 80 / 0.1));
  color: var(--color-danger);
}

/* ── Tag chip (GPG etc.) ── */
.sp-tag {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  font-size: 10px;
  font-weight: var(--font-weight-semibold);
  letter-spacing: 0.04em;
  border: 1px solid #ffffff;
  border-radius: var(--radius-sm);
  background: #ffffff;
  color: #000000;
  text-shadow: none;
}

/* ── Form fields ── */
.sp-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.sp-field--wide {
  grid-column: span 2;
}

.sp-field__label {
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-muted);
  letter-spacing: 0.02em;
}

.sp-field__optional {
  font-weight: var(--font-weight-normal);
  color: var(--color-text-subtle);
  font-style: italic;
}

/* inputs inside sp-group__form get a slightly stronger border */
.sp-group__form .sp-input {
  border-color: var(--color-border);
  transition: border-color var(--transition-base), box-shadow var(--transition-base);
}

.sp-group__form .sp-input:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-focus-ring);
}

.sp-input--sm {
  width: 100%;
  font-size: var(--font-size-sm);
  padding: var(--space-1) var(--space-2);
  height: 30px;
}

.sp-textarea {
  width: 100%;
  resize: vertical;
  font-size: var(--font-size-sm);
  padding: var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-text);
  outline: none;
  font-family: inherit;
  line-height: 1.5;
}

.sp-textarea:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 2px var(--color-focus-ring);
}

.sp-textarea.mono {
  font-family: monospace;
}

.sp-btn--sm {
  height: 28px;
  padding: 0 var(--space-3);
  font-size: var(--font-size-sm);
}

.add-btn {
  width: 100%;
  margin-top: 10px;
}

/* ── v2.13 / sp-group extensions ─────────────────────── */
.sp-section-divider--inner {
  margin: var(--space-4) 0 var(--space-2);
}

/* Head with stacked label + sublabel */
.sp-group__head-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sp-group__sublabel {
  font-size: var(--font-size-xs);
  color: var(--color-text-subtle);
  font-weight: var(--font-weight-normal);
  text-transform: none;
  letter-spacing: 0;
}

/* Muted row (built-ins) — no hover, slightly dimmed */
.sp-group__row--muted {
  opacity: 0.7;
  pointer-events: none;
}

.sp-group__row--muted .sp-group__row-aside {
  pointer-events: all;
}

/* Separator between built-ins and custom */
.sp-group__sep {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-3);
  height: 28px;
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-subtle);
  background: var(--color-bg-secondary);
  border-top: 1px solid var(--color-border);
  border-bottom: 1px solid var(--color-border);
}

/* 1-column form grid override */
.sp-group__form-grid--1col {
  grid-template-columns: 1fr;
}

/* Hint text below a field */
.sp-field__hint {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  margin-top: 2px;
}
</style>
