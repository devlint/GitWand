/**
 * useAiPromptPresets — named AI system-prompt presets for commit messages (v2.13).
 *
 * Presets let users craft their own system prompts and switch between them
 * from the commit panel without touching Settings each time.
 *
 * Built-in presets (id prefix "__builtin_") are always available and cannot
 * be edited or deleted. User presets are stored in AppSettings.aiPromptPresets.
 *
 * The active preset is remembered per repo (cwd) in AppSettings.activePresetIdByRepo.
 * Null / absent = use the default Conventional Commits prompt.
 */

import { computed } from "vue";
import { loadSettings, saveSettings, settingsRevision, type AiPromptPreset } from "./useSettings";

// ─── Built-in presets ─────────────────────────────────────────────────────────

// Note: there is intentionally no "__builtin_default" preset. The default
// Conventional Commits prompt is already reachable via the "Default" menu entry
// (activate(null) → buildSystemPrompt), so adding it here would duplicate it.
export const BUILTIN_PRESETS: ReadonlyArray<AiPromptPreset> = [
  {
    id: "__builtin_concise",
    name: "Concise",
    description: "One-liner only, no body.",
    systemPrompt: `You are a senior software engineer writing a Git commit message.

Rules:
1. Follow the Conventional Commits spec: "<type>(<optional scope>): <subject>".
2. Subject line MUST be 60 characters or less, imperative mood, no trailing period.
3. Output ONLY the subject line — no body, no blank lines.
4. Write in \${lang}.
5. Never wrap your answer in code fences — output ONLY the raw subject line.`,
  },
  {
    id: "__builtin_detailed",
    name: "Detailed",
    description: "Conventional Commits with a mandatory WHY/WHAT body.",
    systemPrompt: `You are a senior software engineer writing a Git commit message.

Rules:
1. Follow the Conventional Commits spec: "<type>(<optional scope>): <subject>".
2. Subject line MUST be 72 characters or less, imperative mood, no trailing period.
3. ALWAYS add a body (2-5 lines) separated from the subject by a blank line.
   The body MUST explain: (a) WHY the change was made, (b) WHAT it impacts.
4. Write in \${lang}.
5. Do not include trailers.
6. Never wrap your answer in code fences — output ONLY the raw commit message.`,
  },
  {
    id: "__builtin_emoji",
    name: "Emoji",
    description: "Gitmoji-style prefix based on change type.",
    systemPrompt: `You are a senior software engineer writing a Git commit message.

Rules:
1. Start the subject line with a single relevant gitmoji, then a space.
   Examples: ✨ new feature, 🐛 bug fix, ♻️ refactor, 📝 docs, ⚡️ perf, 🔧 config.
2. Subject line MUST be 72 characters or less, imperative mood, no trailing period.
3. After the subject, optionally add a short body (1-3 lines) explaining why.
4. Write in \${lang}.
5. Do not include trailers.
6. Never wrap your answer in code fences — output ONLY the raw commit message.`,
  },
];

// ─── helpers ─────────────────────────────────────────────────────────────────

function uuid(): string {
  return crypto.randomUUID();
}

// ─── read ─────────────────────────────────────────────────────────────────────

export function allPresets(): AiPromptPreset[] {
  return loadSettings().aiPromptPresets;
}

export function findPreset(id: string): AiPromptPreset | undefined {
  if (id.startsWith("__builtin_")) {
    return BUILTIN_PRESETS.find((p) => p.id === id);
  }
  return loadSettings().aiPromptPresets.find((p) => p.id === id);
}

/** Combined list: built-ins first, then user presets. */
export function allPresetsWithBuiltins(): AiPromptPreset[] {
  return [...BUILTIN_PRESETS, ...allPresets()];
}

/** Resolve the active preset for a given repo, or null (= default). */
export function getActivePresetId(cwd: string): string | null {
  return loadSettings().activePresetIdByRepo[cwd] ?? null;
}

export function getActivePreset(cwd: string): AiPromptPreset | null {
  const id = getActivePresetId(cwd);
  if (!id) return null;
  return findPreset(id) ?? null;
}

// ─── write ────────────────────────────────────────────────────────────────────

/** Add a new user preset. Returns the generated id. */
export function addPreset(preset: Omit<AiPromptPreset, "id">): string {
  const id = uuid();
  const s = loadSettings();
  s.aiPromptPresets = [...s.aiPromptPresets, { ...preset, id }];
  saveSettings(s);
  return id;
}

/** Update fields on an existing user preset (built-ins cannot be updated). */
export function updatePreset(id: string, patch: Partial<Omit<AiPromptPreset, "id">>): void {
  if (id.startsWith("__builtin_")) return; // immutable
  const s = loadSettings();
  s.aiPromptPresets = s.aiPromptPresets.map((p) => (p.id === id ? { ...p, ...patch } : p));
  saveSettings(s);
}

/** Remove a user preset by id. Clears repo overrides pointing to it. */
export function removePreset(id: string): void {
  if (id.startsWith("__builtin_")) return; // immutable
  const s = loadSettings();
  s.aiPromptPresets = s.aiPromptPresets.filter((p) => p.id !== id);
  // Clear any repo that was pointing to the deleted preset.
  for (const cwd of Object.keys(s.activePresetIdByRepo)) {
    if (s.activePresetIdByRepo[cwd] === id) {
      delete s.activePresetIdByRepo[cwd];
    }
  }
  saveSettings(s);
}

/** Set the active preset for a given repo. Pass null to reset to default. */
export function setActivePreset(cwd: string, presetId: string | null): void {
  const s = loadSettings();
  if (presetId === null) {
    delete s.activePresetIdByRepo[cwd];
  } else {
    s.activePresetIdByRepo = { ...s.activePresetIdByRepo, [cwd]: presetId };
  }
  saveSettings(s);
}

// ─── composable ──────────────────────────────────────────────────────────────

export function useAiPromptPresets(getCwd?: () => string) {
  // `void settingsRevision.value` registers a reactive dependency on the
  // settings-changed counter. The reads below pull straight from localStorage
  // (via loadSettings), so without this they would never recompute after a
  // saveSettings() — the active-preset checkmark would stay stale until reload.
  const userPresets = computed(() => {
    void settingsRevision.value;
    return allPresets();
  });
  const allWithBuiltins = computed(() => {
    void settingsRevision.value;
    return allPresetsWithBuiltins();
  });

  const activePresetId = computed<string | null>(() => {
    void settingsRevision.value;
    return getCwd ? getActivePresetId(getCwd()) : null;
  });

  const activePreset = computed<AiPromptPreset | null>(() => {
    void settingsRevision.value;
    return getCwd ? getActivePreset(getCwd()) : null;
  });

  function activate(presetId: string | null) {
    if (!getCwd) return;
    setActivePreset(getCwd(), presetId);
  }

  return {
    userPresets,
    allWithBuiltins,
    activePresetId,
    activePreset,
    activate,
    add:    addPreset,
    update: updatePreset,
    remove: removePreset,
  };
}
