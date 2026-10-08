/**
 * useAiTemplates — per-kind AI prompt templates (commit / PR / release notes).
 *
 * These functions persist state to localStorage via loadSettings/saveSettings.
 * Each test clears localStorage before running so there is no bleed-over.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  addTemplate,
  builtinTemplates,
  findTemplate,
  getActiveTemplate,
  getActiveTemplateId,
  getTemplateLang,
  removeTemplate,
  setActiveTemplate,
  setTemplateLang,
  updateTemplate,
  userTemplates,
} from "../useAiTemplates";
import {
  applyLang,
  BUILTIN_PRESETS,
  DEFAULT_TEMPLATE_ID,
  DEFAULT_TEMPLATE_PROMPTS,
  LEGACY_RELEASE_NOTES_RULES_HEADER,
} from "../aiTemplateDefaults";
import { loadSettings, saveSettings } from "../useSettings";

const CWD = "/repos/alpha";

beforeEach(() => localStorage.clear());

describe("built-in templates", () => {
  it("every kind exposes its read-only Default first", () => {
    for (const kind of ["commit", "pr", "releaseNotes"] as const) {
      const [first] = builtinTemplates(kind);
      expect(first.id).toBe(DEFAULT_TEMPLATE_ID);
      expect(first.systemPrompt).toBe(DEFAULT_TEMPLATE_PROMPTS[kind]);
    }
  });

  it("commit also lists the built-in presets; other kinds only Default", () => {
    expect(builtinTemplates("commit").map((t) => t.id)).toEqual([
      DEFAULT_TEMPLATE_ID,
      ...BUILTIN_PRESETS.map((p) => p.id),
    ]);
    expect(builtinTemplates("pr")).toHaveLength(1);
    expect(builtinTemplates("releaseNotes")).toHaveLength(1);
  });

  it("cannot be updated or removed", () => {
    updateTemplate("pr", DEFAULT_TEMPLATE_ID, { systemPrompt: "hacked" });
    removeTemplate("pr", DEFAULT_TEMPLATE_ID);
    expect(findTemplate("pr", DEFAULT_TEMPLATE_ID)?.systemPrompt).toBe(DEFAULT_TEMPLATE_PROMPTS.pr);
  });
});

describe("user templates", () => {
  it("are stored per kind", () => {
    const id = addTemplate("pr", { name: "Short PR", systemPrompt: "Be brief in ${lang}." });
    expect(userTemplates("pr").map((t) => t.id)).toEqual([id]);
    expect(userTemplates("commit")).toEqual([]);
    expect(userTemplates("releaseNotes")).toEqual([]);
    // Commit templates keep living where the commit panel's presets always did.
    addTemplate("commit", { name: "Mine", systemPrompt: "x" });
    expect(loadSettings().aiPromptPresets).toHaveLength(1);
  });

  it("update patches only the targeted template", () => {
    const a = addTemplate("releaseNotes", { name: "A", systemPrompt: "a" });
    const b = addTemplate("releaseNotes", { name: "B", systemPrompt: "b" });
    updateTemplate("releaseNotes", a, { systemPrompt: "a2" });
    expect(findTemplate("releaseNotes", a)?.systemPrompt).toBe("a2");
    expect(findTemplate("releaseNotes", b)?.systemPrompt).toBe("b");
  });
});

describe("active template per repo", () => {
  it("null / Default means the default prompt", () => {
    expect(getActiveTemplate("pr", CWD)).toBeNull();
    setActiveTemplate("pr", CWD, DEFAULT_TEMPLATE_ID);
    expect(getActiveTemplateId("pr", CWD)).toBeNull();
    expect(getActiveTemplate("pr", CWD)).toBeNull();
  });

  it("resolves the selected user template", () => {
    const id = addTemplate("pr", { name: "T", systemPrompt: "p" });
    setActiveTemplate("pr", CWD, id);
    expect(getActiveTemplate("pr", CWD)?.systemPrompt).toBe("p");
    // Selections are independent across kinds.
    expect(getActiveTemplateId("releaseNotes", CWD)).toBeNull();
  });

  it("removing a template clears repos pointing to it", () => {
    const id = addTemplate("releaseNotes", { name: "T", systemPrompt: "p" });
    setActiveTemplate("releaseNotes", CWD, id);
    removeTemplate("releaseNotes", id);
    expect(getActiveTemplateId("releaseNotes", CWD)).toBeNull();
  });
});

describe("legacy release note templates", () => {
  it("customRules-only entries become full prompts the model already received", () => {
    localStorage.setItem(
      "gitwand-settings",
      JSON.stringify({
        releaseNoteTemplates: [
          { id: "legacy", name: "Security", customRules: "  Focus on CVEs.  " },
          { id: "empty", name: "Blank", customRules: "" },
        ],
      }),
    );
    const [withRules, blank] = userTemplates("releaseNotes");
    expect(withRules).toEqual({
      id: "legacy",
      name: "Security",
      systemPrompt: `${DEFAULT_TEMPLATE_PROMPTS.releaseNotes}\n\n${LEGACY_RELEASE_NOTES_RULES_HEADER}\nFocus on CVEs.`,
    });
    expect(blank.systemPrompt).toBe(DEFAULT_TEMPLATE_PROMPTS.releaseNotes);
  });
});

describe("applyLang", () => {
  it("substitutes every placeholder", () => {
    expect(applyLang("${lang} and ${lang}", "French")).toBe("French and French");
    expect(applyLang(DEFAULT_TEMPLATE_PROMPTS.pr, "English")).not.toContain("${lang}");
  });
});

describe("output language per repo", () => {
  it("defaults to English, then to the global setting", () => {
    expect(getTemplateLang("pr", CWD)).toBe("en");
    saveSettings({ ...loadSettings(), prDescriptionLang: "fr" });
    expect(getTemplateLang("pr", CWD)).toBe("fr");
  });

  it("a repo's pick wins, only for that repo and that kind", () => {
    saveSettings({ ...loadSettings(), commitMessageLang: "es" });
    setTemplateLang("commit", CWD, "zh-CN");
    expect(getTemplateLang("commit", CWD)).toBe("zh-CN");
    expect(getTemplateLang("commit", "/repos/beta")).toBe("es");
    expect(getTemplateLang("pr", CWD)).toBe("en");
  });
});
