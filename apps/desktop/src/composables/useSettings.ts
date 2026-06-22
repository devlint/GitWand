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
import type { BlameAlgorithm } from "../utils/backend";
import type { AIProvider } from "./useAIProvider";
import type { SwitchBehavior } from "../utils/branchSwitchDecision";

// ─── Types ────────────────────────────────────────────────

export type PullMode = "merge" | "rebase";
// SwitchBehavior is owned by the pure branch-switch decision helper (lowest
// layer) and re-exported here so settings consumers keep a single source of truth.
export type { SwitchBehavior };
/** Active tab in the Today view — only "inbox" (unified list) and "team" survive Phase 2. */
export type LaunchpadTab = "inbox" | "wip" | "prs" | "issues" | "team";
/** Granularity of PR-activity OS notifications (v2.16). */
export type NotificationLevel = "all" | "reviews" | "ci" | "none";

/** Named committer identity — stored in AppSettings, selected per-commit or per-repo (v2.12). */
export interface IdentityProfile {
  /** UUID v4 — stable key across renames. */
  id: string;
  /** Human label shown in the selector, e.g. "Perso", "Pro", "Client Acme". */
  label: string;
  /** git user.name */
  gitName: string;
  /** git user.email */
  gitEmail: string;
  /** Optional GPG key ID (short, e.g. "A1B2C3D4"). */
  gpgKey?: string;
}

/** Named commit message template (v2.12). */
export interface CommitTemplate {
  /** UUID v4. */
  id: string;
  /** Display name, e.g. "Fix one-liner", "RFC", "ADR". */
  name: string;
  /** Subject line. Use ${cursor} to mark caret position after insertion. */
  subject: string;
  /** Optional body text. */
  body: string;
}

/**
 * Named AI prompt preset for commit message generation (v2.13).
 *
 * When a preset is active, its `systemPrompt` replaces the default
 * Conventional Commits system prompt built by `buildSystemPrompt()`.
 * The language substitution (`${lang}`) is still applied after injection.
 */
export interface AiPromptPreset {
  /** UUID v4. */
  id: string;
  /** Display name shown in the picker, e.g. "Concis", "Emoji", "RFC". */
  name: string;
  /** Optional short description shown as a hint in the preset list. */
  description?: string;
  /**
   * Full system prompt sent to the LLM.
   * Use `${lang}` as a placeholder — it is replaced at generation time with
   * the resolved language name (e.g. "French", "English").
   */
  systemPrompt: string;
}

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
  /** Granularity of PR-activity OS notifications (v2.16). "none" disables them. */
  notificationLevel: NotificationLevel;
  /** When true, suppress PR-activity events authored by bots (Actions, Dependabot, Renovate). */
  notificationsByPeople: boolean;
  /** Diff algorithm used for git blame. "histogram" gives the best blame results for most codebases. */
  blameAlgorithm: BlameAlgorithm;
  /** Auto-update channel (v2.0). "stable" = Tauri plugin auto-install; "beta" = manual fetch + browser-open. */
  updateChannel: "stable" | "beta";
  /** Language used for AI-generated commit messages. "" = follow UI locale. */
  commitMessageLang: string;
  /**
   * Language for AI-generated PR title/body. "english" (default — PRs are most
   * often written in English) or "ui" to match the app's current locale.
   */
  prAiLanguage: "english" | "ui";
  /** Whether AI features are enabled. */
  aiEnabled: boolean;
  /** Active AI provider. */
  aiProvider: AIProvider;
  /** API key for Claude / OpenAI providers. */
  aiApiKey: string;
  /** API endpoint override (Claude / OpenAI-compatible). */
  aiApiEndpoint: string;
  /** Model name for Claude / OpenAI providers. */
  aiModel: string;
  /**
   * Per-provider model selection for the CLI agents — Claude Code, Codex,
   * opencode (v2.17). Keyed by AIProvider id. Switching providers restores
   * each one's previous choice; empty/absent means "CLI default".
   */
  aiModelByProvider: Partial<Record<AIProvider, string>>;
  /** Ollama base URL. */
  aiOllamaUrl: string;
  /** Ollama model name. */
  aiOllamaModel: string;
  /**
   * Last active tab in Today view — persisted between openings (v2.9).
   * After Phase 2 only "inbox" and "team" are live surfaces; legacy values
   * ("wip"|"prs"|"issues") are migrated to "inbox" at read time.
   */
  launchpadActiveTab: LaunchpadTab;
  /**
   * Whether the Today Team tab is enabled (v2.9). When false, the tab
   * is hidden and the (expensive) team activity fetch — one `gh pr view
   * --json files` per colleague PR, ~10s on a 50-PR workspace — is never
   * triggered. Default: true.
   */
  launchpadTeamTabEnabled: boolean;
  /**
   * Launchpad repo scope (v3): explicit list of repo paths to show. Empty array
   * means "all open repos" (the default). Persisted so the user's filter
   * (e.g. only Dendreo) survives across sessions; stale paths are ignored at
   * read time (intersected with the currently-open tabs).
   */
  launchpadScopePaths: string[];

  // ── Dashboard layout ──────────────────────────────────────

  /** Render the README card above the contributors/activity rows. */
  dashboardReadmeFirst: boolean;
  /** Hide the contributors row on the dashboard. */
  dashboardHideContributors: boolean;
  /** Hide the activity row (heatmap / commits-per-day / recent commits). */
  dashboardHideActivity: boolean;
  /** Hide the README card on the dashboard. */
  dashboardHideReadme: boolean;

  /** Automation settings (v2.8). */
  automations: {
    /** Auto-resolve conflicts the moment MERGE_HEAD appears. */
    autoResolve: { enabled: boolean };
    /** Pull + rebase all repos in workspace at a fixed time each day. */
    nightlyPull: { enabled: boolean; hour: number; minute: number };
    /** Generate release notes when a v* tag is created. */
    releaseNotes: { enabled: boolean };
    /** Suggest an AI commit message when staged files are present at app close. */
    aiCommitBatch: { enabled: boolean };
  };

  // ── v2.12 Branch Management & Identity ────────────────────

  /**
   * Branches archived by the user, keyed by normalised repo path (cwd).
   * Archived branches are hidden from the main branch list and shown in a
   * collapsed "Archivées" section. Never deleted from git — only hidden in GitWand.
   */
  archivedBranches: Record<string, string[]>;

  /**
   * User-chosen pinned branches, keyed by cwd, in display order.
   * Replaces the former auto-computed top-5-by-activity heuristic.
   */
  pinnedBranchesByRepo: Record<string, string[]>;

  /**
   * Number of days without a commit after which a branch receives an "Inactif"
   * badge in the sidebar. 0 = disabled. Default: 30.
   */
  inactiveBranchDays: number;

  /** Named committer identity profiles (v2.12). */
  identities: IdentityProfile[];

  /**
   * ID of the globally active identity profile, or null to use the git
   * global config (user.name / user.email).
   */
  activeIdentityId: string | null;

  /**
   * Per-repo identity override. Keys are normalised cwd paths; values are
   * IdentityProfile.id. Takes precedence over activeIdentityId.
   */
  identityOverrideByRepo: Record<string, string>;

  /** Saved commit message templates (v2.12). */
  commitTemplates: CommitTemplate[];

  // ── v2.13 AI & Review ─────────────────────────────────────

  /**
   * User-defined AI prompt presets for commit message generation (v2.13).
   * The default Conventional Commits prompt is always available implicitly;
   * these extend it with named custom prompts.
   */
  aiPromptPresets: AiPromptPreset[];

  /**
   * ID of the active preset per repo (keyed by cwd). Null / absent means
   * "use the default prompt". Special value "__builtin_*" for built-in presets.
   */
  activePresetIdByRepo: Record<string, string | null>;
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
  notificationLevel: "all",
  notificationsByPeople: true,
  blameAlgorithm: "histogram",
  updateChannel: "stable",
  commitMessageLang: "",
  prAiLanguage: "english",
  aiEnabled: false,
  aiProvider: "none",
  aiApiKey: "",
  aiApiEndpoint: "https://api.anthropic.com",
  aiModel: "claude-sonnet-4-20250514",
  aiModelByProvider: {},
  aiOllamaUrl: "http://localhost:11434",
  aiOllamaModel: "codellama",
  launchpadActiveTab: "inbox",
  launchpadTeamTabEnabled: true,
  launchpadScopePaths: [],
  dashboardReadmeFirst: false,
  dashboardHideContributors: false,
  dashboardHideActivity: false,
  dashboardHideReadme: false,
  automations: {
    autoResolve:    { enabled: false },
    nightlyPull:    { enabled: false, hour: 8, minute: 0 },
    releaseNotes:   { enabled: false },
    aiCommitBatch:  { enabled: false },
  },
  // v2.12
  archivedBranches:       {},
  pinnedBranchesByRepo:   {},
  inactiveBranchDays:     30,
  identities:             [],
  activeIdentityId:       null,
  identityOverrideByRepo: {},
  commitTemplates:        [],
  // v2.13
  aiPromptPresets:        [],
  activePresetIdByRepo:   {},
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

export function saveSettings(s: AppSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
  // Notify reactive readers that persisted settings changed. Composables that
  // read settings directly from localStorage (usePinnedBranches,
  // useArchivedBranches, …) have no other reactive dependency, so without this
  // bump their computeds would stay stale until a full reload.
  settingsRevision.value++;
}

// ─── Singleton reactive ref ───────────────────────────────
// Shared across all useSettings() calls in the same Vue app instance.

const _settings = ref<AppSettings>(loadSettings());

/**
 * Monotonic counter bumped on every saveSettings() / refreshSettings().
 * Read it inside a computed (`settingsRevision.value`) to register a reactive
 * dependency on "settings changed", even when the underlying value is read
 * straight from localStorage rather than the `_settings` ref.
 */
export const settingsRevision = ref(0);

/** Re-read all settings from localStorage (call after SettingsPanel saves). */
export function refreshSettings(): void {
  _settings.value = loadSettings();
  settingsRevision.value++;
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
    /** Persist the current settings object to localStorage. */
    saveSettings,
  };
}
