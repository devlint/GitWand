<script setup lang="ts">
import { ref, computed } from "vue";
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
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...defaultSettings, ...JSON.parse(raw) };
  } catch {
    // ignore
  }
  return { ...defaultSettings };
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
};

function saveSettings(s: Settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}

const settings = ref<Settings>(loadSettings());

function updateSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  settings.value[key] = value;
  saveSettings(settings.value);
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
  } catch {
    // ignore
  }
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

      <!-- Settings form -->
      <div class="sp-body">
        <!-- Language -->
        <div class="sp-row">
          <label class="sp-label" for="setting-lang">{{ t('settings.language') }}</label>
          <select
            id="setting-lang"
            class="sp-select"
            v-model="selectedLocale"
          >
            <option value="auto">{{ t('settings.languageAuto') }}</option>
            <option
              v-for="loc in supportedLocales"
              :key="loc"
              :value="loc"
            >
              {{ localeLabels[loc] }}
            </option>
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

        <!-- External editor -->
        <div class="sp-row">
          <label class="sp-label" for="setting-editor">{{ t('settings.editor') }}</label>
          <input
            id="setting-editor"
            class="sp-input mono"
            type="text"
            :value="settings.editor"
            @input="updateSetting('editor', ($event.target as HTMLInputElement).value)"
            :placeholder="t('settings.editorPlaceholder')"
          />
        </div>

        <!-- Git path -->
        <div class="sp-row">
          <label class="sp-label" for="setting-git">{{ t('settings.gitPath') }}</label>
          <input
            id="setting-git"
            class="sp-input mono"
            type="text"
            :value="settings.gitPath"
            @input="updateSetting('gitPath', ($event.target as HTMLInputElement).value)"
            :placeholder="t('settings.gitPathAuto')"
          />
        </div>

        <!-- Default branch -->
        <div class="sp-row">
          <label class="sp-label" for="setting-branch">{{ t('settings.defaultBranch') }}</label>
          <input
            id="setting-branch"
            class="sp-input mono"
            type="text"
            :value="settings.defaultBranch"
            @input="updateSetting('defaultBranch', ($event.target as HTMLInputElement).value)"
            placeholder="main"
          />
        </div>

        <!-- Diff display -->
        <div class="sp-row">
          <label class="sp-label" for="setting-diff-mode">{{ t('settings.diffDisplay') }}</label>
          <select
            id="setting-diff-mode"
            class="sp-select"
            :value="settings.diffMode"
            @change="onDiffModeChange(($event.target as HTMLSelectElement).value as DiffMode)"
          >
            <option value="inline">{{ t('settings.diffInline') }}</option>
            <option value="side-by-side">{{ t('settings.diffSideBySide') }}</option>
          </select>
        </div>

        <!-- Pull mode -->
        <div class="sp-row">
          <label class="sp-label" for="setting-pull-mode">{{ t('settings.pullMode') }}</label>
          <select
            id="setting-pull-mode"
            class="sp-select"
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
            id="setting-switch-behavior"
            class="sp-select"
            :value="settings.switchBehavior"
            @change="onSwitchBehaviorChange(($event.target as HTMLSelectElement).value as SwitchBehavior)"
          >
            <option value="stash">{{ t('settings.switchStash') }}</option>
            <option value="ask">{{ t('settings.switchAsk') }}</option>
            <option value="refuse">{{ t('settings.switchRefuse') }}</option>
          </select>
        </div>

        <!-- Font size -->
        <div class="sp-row">
          <label class="sp-label" for="setting-font-size">{{ t('settings.fontSize') }}</label>
          <div class="sp-range-row">
            <input
              id="setting-font-size"
              class="sp-range"
              type="range"
              min="10"
              max="18"
              step="1"
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
            id="setting-tab-size"
            class="sp-select"
            :value="settings.tabSize"
            @change="onTabSizeChange(Number(($event.target as HTMLSelectElement).value))"
          >
            <option :value="2">2 {{ t('settings.spaces') }}</option>
            <option :value="4">4 {{ t('settings.spaces') }}</option>
            <option :value="8">8 {{ t('settings.spaces') }}</option>
          </select>
        </div>

        <!-- Commit signature -->
        <div class="sp-row sp-row--checkbox">
          <label class="sp-checkbox-label" for="setting-signature">
            <input
              id="setting-signature"
              type="checkbox"
              class="sp-checkbox"
              :checked="settings.commitSignature"
              @change="onSignatureChange"
            />
            <span>{{ t('settings.commitSignature') }}</span>
          </label>
          <span class="sp-hint">{{ t('settings.commitSignatureHint') }}</span>
        </div>

        <!-- Notifications -->
        <div class="sp-row sp-row--checkbox">
          <label class="sp-checkbox-label" for="setting-notifications">
            <input
              id="setting-notifications"
              type="checkbox"
              class="sp-checkbox"
              :checked="settings.notifications"
              @change="onNotificationsChange"
            />
            <span>{{ t('settings.notifications') }}</span>
          </label>
          <span class="sp-hint">{{ t('settings.notificationsHint') }}</span>
        </div>
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
  width: min(480px, 90vw);
  max-height: 80vh;
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
  border-bottom: 1px solid var(--color-border);
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

.sp-body {
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  overflow-y: auto;
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
</style>
