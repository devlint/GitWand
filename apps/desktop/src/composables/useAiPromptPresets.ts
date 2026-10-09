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
import { loadSettings, settingsRevision, type AiPromptPreset } from "./useSettings";
import { addTemplate, updateTemplate, removeTemplate, setActiveTemplate, getActiveTemplateId } from "./useAiTemplates";
import { BUILTIN_PRESETS } from "./aiTemplateDefaults";

export { BUILTIN_PRESETS };

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
  return getActiveTemplateId("commit", cwd);
}

export function getActivePreset(cwd: string): AiPromptPreset | null {
  const id = getActivePresetId(cwd);
  if (!id) return null;
  return findPreset(id) ?? null;
}

// ─── write ────────────────────────────────────────────────────────────────────

/** Add a new user preset. Returns the generated id. */
export function addPreset(preset: Omit<AiPromptPreset, "id">): string {
  return addTemplate("commit", preset);
}

/** Update fields on an existing user preset (built-ins cannot be updated). */
export function updatePreset(id: string, patch: Partial<Omit<AiPromptPreset, "id">>): void {
  updateTemplate("commit", id, patch);
}

/** Remove a user preset by id. Clears repo overrides pointing to it. */
export function removePreset(id: string): void {
  removeTemplate("commit", id);
}

/** Set the active preset for a given repo. Pass null to reset to default. */
export function setActivePreset(cwd: string, presetId: string | null): void {
  setActiveTemplate("commit", cwd, presetId);
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
