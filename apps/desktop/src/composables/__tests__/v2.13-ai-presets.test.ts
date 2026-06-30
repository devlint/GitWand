/**
 * v2.13 unit tests — useAiPromptPresets (module-level functions).
 *
 * These functions persist state to localStorage via loadSettings/saveSettings.
 * Each test clears localStorage before running so there is no bleed-over.
 */

import { describe, it, expect, beforeEach } from "vitest";

// ─── helpers ──────────────────────────────────────────────────────────────────

function clearSettings() {
  localStorage.clear();
}

const CWD_A = "/repos/alpha";
const CWD_B = "/repos/beta";

// ═══════════════════════════════════════════════════════════════════════════════
// useAiPromptPresets (module-level functions)
// ═══════════════════════════════════════════════════════════════════════════════

describe("useAiPromptPresets (module-level functions)", () => {
  beforeEach(clearSettings);

  // 1. addPreset() creates preset; findPreset() returns it
  it("addPreset() creates preset; findPreset() returns it", async () => {
    const { addPreset, findPreset } = await import("../useAiPromptPresets");
    const id = addPreset({ name: "My Preset", systemPrompt: "You are a helpful assistant." });
    expect(typeof id).toBe("string");
    const found = findPreset(id);
    expect(found?.name).toBe("My Preset");
    expect(found?.systemPrompt).toBe("You are a helpful assistant.");
    expect(found?.id).toBe(id);
  });

  // 2. updatePreset() mutates existing preset
  it("updatePreset() mutates existing preset", async () => {
    const { addPreset, updatePreset, findPreset } = await import("../useAiPromptPresets");
    const id = addPreset({ name: "Draft", systemPrompt: "Old prompt." });
    updatePreset(id, { name: "Updated", systemPrompt: "New prompt." });
    const found = findPreset(id);
    expect(found?.name).toBe("Updated");
    expect(found?.systemPrompt).toBe("New prompt.");
  });

  // 3. removePreset() deletes preset; allPresets() length = 0
  it("removePreset() deletes preset; allPresets() length = 0", async () => {
    const { addPreset, removePreset, allPresets } = await import("../useAiPromptPresets");
    const id = addPreset({ name: "Temporary", systemPrompt: "temp" });
    expect(allPresets().length).toBe(1);
    removePreset(id);
    expect(allPresets().length).toBe(0);
  });

  // 4. updatePreset() on a builtin id is a no-op
  it("updatePreset() on a builtin id is a no-op", async () => {
    const { updatePreset, findPreset, BUILTIN_PRESETS } = await import("../useAiPromptPresets");
    const builtin = BUILTIN_PRESETS[0];
    const originalName = builtin.name;
    const originalPrompt = builtin.systemPrompt;
    updatePreset(builtin.id, { name: "Hacked", systemPrompt: "Evil prompt." });
    const found = findPreset(builtin.id);
    expect(found?.name).toBe(originalName);
    expect(found?.systemPrompt).toBe(originalPrompt);
  });

  // 5. removePreset() on a builtin id is a no-op; builtin still in BUILTIN_PRESETS
  it("removePreset() on a builtin id is a no-op; builtin still in BUILTIN_PRESETS", async () => {
    const { removePreset, BUILTIN_PRESETS } = await import("../useAiPromptPresets");
    const builtinId = BUILTIN_PRESETS[1].id;
    removePreset(builtinId);
    const stillExists = BUILTIN_PRESETS.find((p) => p.id === builtinId);
    expect(stillExists).toBeDefined();
    expect(BUILTIN_PRESETS.length).toBe(3);
  });

  // 6. setActivePreset(cwd, id) + getActivePresetId(cwd) returns the id
  it("setActivePreset() stores id; getActivePresetId() returns it", async () => {
    const { addPreset, setActivePreset, getActivePresetId } = await import("../useAiPromptPresets");
    const id = addPreset({ name: "Work Style", systemPrompt: "Be concise." });
    setActivePreset(CWD_A, id);
    expect(getActivePresetId(CWD_A)).toBe(id);
  });

  // 7. setActivePreset(cwd, null) clears the active preset
  it("setActivePreset(cwd, null) clears the active preset", async () => {
    const { addPreset, setActivePreset, getActivePresetId } = await import("../useAiPromptPresets");
    const id = addPreset({ name: "Temp", systemPrompt: "..." });
    setActivePreset(CWD_A, id);
    expect(getActivePresetId(CWD_A)).toBe(id);
    setActivePreset(CWD_A, null);
    expect(getActivePresetId(CWD_A)).toBeNull();
  });

  // 8. removePreset() clears repo overrides pointing to that preset
  it("removePreset() clears repo overrides pointing to the removed preset", async () => {
    const { addPreset, setActivePreset, removePreset, getActivePresetId } = await import("../useAiPromptPresets");
    const id = addPreset({ name: "Scope", systemPrompt: "scoped prompt" });
    setActivePreset(CWD_A, id);
    setActivePreset(CWD_B, id);
    expect(getActivePresetId(CWD_A)).toBe(id);
    expect(getActivePresetId(CWD_B)).toBe(id);
    removePreset(id);
    expect(getActivePresetId(CWD_A)).toBeNull();
    expect(getActivePresetId(CWD_B)).toBeNull();
  });

  // 9. allPresetsWithBuiltins() includes all 3 builtins + user presets
  it("allPresetsWithBuiltins() includes all 3 builtins + user presets", async () => {
    const { addPreset, allPresetsWithBuiltins, BUILTIN_PRESETS } = await import("../useAiPromptPresets");
    addPreset({ name: "Custom A", systemPrompt: "prompt A" });
    addPreset({ name: "Custom B", systemPrompt: "prompt B" });
    const all = allPresetsWithBuiltins();
    // 4 builtins + 2 user presets
    expect(all.length).toBe(BUILTIN_PRESETS.length + 2);
    // builtins come first
    for (let i = 0; i < BUILTIN_PRESETS.length; i++) {
      expect(all[i].id).toBe(BUILTIN_PRESETS[i].id);
    }
    // user presets come after
    expect(all[BUILTIN_PRESETS.length].name).toBe("Custom A");
    expect(all[BUILTIN_PRESETS.length + 1].name).toBe("Custom B");
  });

  // 10. findPreset() on builtin id returns the builtin
  it("findPreset() on builtin id returns the builtin preset", async () => {
    const { findPreset, BUILTIN_PRESETS } = await import("../useAiPromptPresets");
    for (const builtin of BUILTIN_PRESETS) {
      const found = findPreset(builtin.id);
      expect(found).toBeDefined();
      expect(found?.id).toBe(builtin.id);
      expect(found?.name).toBe(builtin.name);
    }
  });
});
