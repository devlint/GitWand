/**
 * useSettings — Centralized settings reader.
 *
 * SettingsPanel owns the write logic (localStorage + emit for immediate effects).
 * This composable provides a read path for any component that needs settings
 * at action time (switch behavior, notifications gate, default branch sort, etc.)
 *
 * Usage:
 *   const { settings, refreshSettings } = useSettings()
 */

import { ref } from "vue";
import type { DiffMode } from "../utils/diffMode";

// ─── Types ────────────────────────────────────────────────

export type PullMode = "merge" | "rebase";
export type SwitchBehavior = "stash" | "ask" | "refuse";

export interface AppSettings {
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

// ─── Defaults ─────────────────────────────────────────────

export const defaultAppSettings: AppSettings = {
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

const SETTINGS_KEY = "gitwand-settings";

// ─── Load / save helpers ──────────────────────────────────

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...defaultAppSettings, ...JSON.parse(raw) };
  } catch {
    // ignore
  }
  return { ...defaultAppSettings };
}

// ─── Singleton reactive ref ───────────────────────────────
// Shared across all useSettings() calls in the same Vue app instance.

const _settings = ref<AppSettings>(loadSettings());

/** Re-read all settings from localStorage (call after SettingsPanel saves). */
export function refreshSettings(): void {
  _settings.value = loadSettings();
}

// ─── Composable ───────────────────────────────────────────

export function useSettings() {
  return {
    /** Reactive settings ref. Updated by refreshSettings(). */
    settings: _settings,
    /** Re-sync settings from localStorage (call on settings panel close). */
    refreshSettings,
    /** One-shot read without reactivity. Useful in event handlers. */
    loadSettings,
  };
}
