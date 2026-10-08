/**
 * useAiTemplates — named AI prompt templates for every AI generator.
 *
 * One template kind per generator:
 *   - "commit"       → commit summary + description (RepoSidebar)
 *   - "pr"           → pull request title + description (PrCreateView)
 *   - "releaseNotes" → release notes (ReleaseNotesModal)
 *
 * A template is a full system prompt (`${lang}` placeholder supported) that
 * replaces the kind's default prompt. Built-in templates (id prefix
 * "__builtin_", including the implicit Default) are read-only: they can be
 * viewed and duplicated, never edited or deleted.
 *
 * User templates are shared across repos; the active one is remembered per
 * repo (cwd). Null / absent / "__builtin_default" = the default prompt.
 */

import { computed, ref } from "vue";
import {
  loadSettings,
  saveSettings,
  settingsRevision,
  type AiPromptPreset,
  type AppSettings,
} from "./useSettings";
import {
  BUILTIN_PRESETS,
  DEFAULT_TEMPLATE_ID,
  DEFAULT_TEMPLATE_PROMPTS,
  isBuiltinTemplateId,
  type AiTemplateKind,
} from "./aiTemplateDefaults";

export type { AiTemplateKind };
export type AiTemplate = AiPromptPreset;

type TemplateListKey = "aiPromptPresets" | "prTemplates" | "releaseNoteTemplates";
type ActiveMapKey = "activePresetIdByRepo" | "activePrTemplateIdByRepo" | "activeReleaseNoteTemplateIdByRepo";

/** Where each kind persists its user templates and its per-repo selection. */
const STORAGE: Record<AiTemplateKind, { list: TemplateListKey; active: ActiveMapKey }> = {
  commit:       { list: "aiPromptPresets",      active: "activePresetIdByRepo" },
  pr:           { list: "prTemplates",          active: "activePrTemplateIdByRepo" },
  releaseNotes: { list: "releaseNoteTemplates", active: "activeReleaseNoteTemplateIdByRepo" },
};

export const AI_TEMPLATE_KINDS: readonly AiTemplateKind[] = ["commit", "pr", "releaseNotes"];

/** Global default output language of each kind (locale code; "" = English). */
const LANG_SETTING: Record<AiTemplateKind, "commitMessageLang" | "prDescriptionLang" | "releaseNotesLang"> = {
  commit:       "commitMessageLang",
  pr:           "prDescriptionLang",
  releaseNotes: "releaseNotesLang",
};

/**
 * Output language of a kind for a repo: the one picked for that repo from the
 * AI button menu, else the global default from Settings → AI Templates, else
 * English.
 */
export function getTemplateLang(kind: AiTemplateKind, cwd?: string): string {
  const s = loadSettings();
  const picked = cwd ? s.aiTemplateLangByRepo?.[cwd]?.[kind] : undefined;
  return picked || s[LANG_SETTING[kind]] || "en";
}

/** Remember the output language of a kind for one repo. */
export function setTemplateLang(kind: AiTemplateKind, cwd: string, lang: string): void {
  const s = loadSettings();
  const byRepo = { ...(s.aiTemplateLangByRepo ?? {}) };
  byRepo[cwd] = { ...(byRepo[cwd] ?? {}), [kind]: lang };
  s.aiTemplateLangByRepo = byRepo;
  saveSettings(s);
}

/**
 * Kind the Settings → AI Templates tab should show next time it opens. Set by
 * a caller right before it opens Settings (e.g. the release notes modal's
 * "Configure templates" shortcut); the tab consumes and clears it.
 */
export const requestedAiTemplateKind = ref<AiTemplateKind | null>(null);

// ─── read ─────────────────────────────────────────────────────────────────────

/** The read-only Default template of a kind (its name is localised by the UI). */
export function defaultTemplate(kind: AiTemplateKind): AiTemplate {
  return { id: DEFAULT_TEMPLATE_ID, name: "Default", systemPrompt: DEFAULT_TEMPLATE_PROMPTS[kind] };
}

/** Read-only templates of a kind, Default first. */
export function builtinTemplates(kind: AiTemplateKind): AiTemplate[] {
  return kind === "commit"
    ? [defaultTemplate(kind), ...BUILTIN_PRESETS]
    : [defaultTemplate(kind)];
}

export function userTemplates(kind: AiTemplateKind, s: AppSettings = loadSettings()): AiTemplate[] {
  return s[STORAGE[kind].list] ?? [];
}

export function findTemplate(kind: AiTemplateKind, id: string): AiTemplate | undefined {
  if (isBuiltinTemplateId(id)) return builtinTemplates(kind).find((t) => t.id === id);
  return userTemplates(kind).find((t) => t.id === id);
}

export function getActiveTemplateId(kind: AiTemplateKind, cwd: string): string | null {
  const id = loadSettings()[STORAGE[kind].active]?.[cwd] ?? null;
  return id === DEFAULT_TEMPLATE_ID ? null : id;
}

/** The template to apply for `cwd`, or null when the default prompt applies. */
export function getActiveTemplate(kind: AiTemplateKind, cwd: string): AiTemplate | null {
  const id = getActiveTemplateId(kind, cwd);
  if (!id) return null;
  return findTemplate(kind, id) ?? null;
}

// ─── write ────────────────────────────────────────────────────────────────────

/** Add a user template. Returns the generated id. */
export function addTemplate(kind: AiTemplateKind, template: Omit<AiTemplate, "id">): string {
  const id = crypto.randomUUID();
  const s = loadSettings();
  s[STORAGE[kind].list] = [...userTemplates(kind, s), { ...template, id }];
  saveSettings(s);
  return id;
}

/** Update a user template (built-ins are immutable). */
export function updateTemplate(
  kind: AiTemplateKind,
  id: string,
  patch: Partial<Omit<AiTemplate, "id">>,
): void {
  if (isBuiltinTemplateId(id)) return;
  const s = loadSettings();
  s[STORAGE[kind].list] = userTemplates(kind, s).map((t) =>
    t.id === id ? { ...t, ...patch } : t,
  );
  saveSettings(s);
}

/** Remove a user template and clear every repo selection pointing to it. */
export function removeTemplate(kind: AiTemplateKind, id: string): void {
  if (isBuiltinTemplateId(id)) return;
  const s = loadSettings();
  s[STORAGE[kind].list] = userTemplates(kind, s).filter((t) => t.id !== id);
  const active = { ...s[STORAGE[kind].active] };
  for (const cwd of Object.keys(active)) {
    if (active[cwd] === id) delete active[cwd];
  }
  s[STORAGE[kind].active] = active;
  saveSettings(s);
}

/** Set the active template for a repo. Null / Default resets to the default prompt. */
export function setActiveTemplate(kind: AiTemplateKind, cwd: string, id: string | null): void {
  const s = loadSettings();
  const active = { ...s[STORAGE[kind].active] };
  if (id === null || id === DEFAULT_TEMPLATE_ID) delete active[cwd];
  else active[cwd] = id;
  s[STORAGE[kind].active] = active;
  saveSettings(s);
}

// ─── composable ──────────────────────────────────────────────────────────────

export function useAiTemplates(kind: AiTemplateKind, getCwd?: () => string) {
  // Reads come straight from localStorage; `settingsRevision` is the reactive
  // dependency that makes them recompute after a saveSettings().
  const templates = computed(() => {
    void settingsRevision.value;
    return userTemplates(kind);
  });

  const activeTemplateId = computed<string | null>(() => {
    void settingsRevision.value;
    return getCwd ? getActiveTemplateId(kind, getCwd()) : null;
  });

  const activeTemplate = computed<AiTemplate | null>(() => {
    void settingsRevision.value;
    return getCwd ? getActiveTemplate(kind, getCwd()) : null;
  });

  const lang = computed(() => {
    void settingsRevision.value;
    return getTemplateLang(kind, getCwd?.());
  });

  function activate(id: string | null) {
    if (!getCwd) return;
    setActiveTemplate(kind, getCwd(), id);
  }

  return {
    templates,
    activeTemplateId,
    activeTemplate,
    activate,
    lang,
    setLang: (code: string) => {
      if (getCwd) setTemplateLang(kind, getCwd(), code);
    },
  };
}
