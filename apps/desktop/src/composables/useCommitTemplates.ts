/**
 * useCommitTemplates — named commit message templates (v2.12).
 *
 * Templates are stored in AppSettings.commitTemplates. They can be applied
 * from a picker button in the commit panel, or via the "/" autocomplete in the
 * subject field.
 *
 * The subject field supports a ${cursor} placeholder — when a template is
 * applied, the caller positions the input caret at that offset.
 */

import { computed } from "vue";
import { loadSettings, saveSettings, type CommitTemplate } from "./useSettings";
import { readCommitTemplate } from "../utils/backend";

// ─── helpers ─────────────────────────────────────────────────────────────────

function uuid(): string {
  return crypto.randomUUID();
}

// ─── read ─────────────────────────────────────────────────────────────────────

export function allTemplates(): CommitTemplate[] {
  return loadSettings().commitTemplates;
}

export function findTemplate(id: string): CommitTemplate | undefined {
  return loadSettings().commitTemplates.find((t) => t.id === id);
}

// ─── write ────────────────────────────────────────────────────────────────────

/** Add a new template. Returns the generated id. */
export function addTemplate(template: Omit<CommitTemplate, "id">): string {
  const id = uuid();
  const s = loadSettings();
  s.commitTemplates = [...s.commitTemplates, { ...template, id }];
  saveSettings(s);
  return id;
}

/** Update fields on an existing template. */
export function updateTemplate(id: string, patch: Partial<Omit<CommitTemplate, "id">>): void {
  const s = loadSettings();
  s.commitTemplates = s.commitTemplates.map((t) => (t.id === id ? { ...t, ...patch } : t));
  saveSettings(s);
}

/** Remove a template by id. */
export function removeTemplate(id: string): void {
  const s = loadSettings();
  s.commitTemplates = s.commitTemplates.filter((t) => t.id !== id);
  saveSettings(s);
}

/**
 * Import the repo's git commit.template file as a new GitWand template.
 * The backend resolves the path from git config and reads the file.
 * No-op if commit.template is not configured.
 * Throws if the file cannot be read.
 */
export async function importFromGitMessage(cwd: string): Promise<string | null> {
  const raw = await readCommitTemplate(cwd);
  if (raw === null) return null;

  // Parse: first non-comment, non-empty line = subject; rest = body
  const lines = raw.split("\n").filter((l) => !l.startsWith("#"));
  const nonEmpty = lines.findIndex((l) => l.trim().length > 0);
  const subject = nonEmpty >= 0 ? lines[nonEmpty].trimEnd() : "";
  const body = lines
    .slice(nonEmpty + 1)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const id = addTemplate({
    name: "Importé (.gitmessage)",
    subject,
    body,
  });
  return id;
}

// ─── composable ──────────────────────────────────────────────────────────────

export function useCommitTemplates() {
  const templates = computed(() => allTemplates());

  return {
    templates,
    add:            addTemplate,
    update:         updateTemplate,
    remove:         removeTemplate,
    importFromGit:  importFromGitMessage,
  };
}
