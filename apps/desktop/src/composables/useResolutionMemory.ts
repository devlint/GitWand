/**
 * useResolutionMemory — learned conflict resolution patterns.
 *
 * When a user manually resolves a conflict hunk GitWand can offer to save
 * the resolution strategy for that file.  On future conflicts involving the
 * same file the learned strategy is surfaced as a one-click suggestion.
 *
 * Storage: "gitwand-resolution-memory" in localStorage.
 *
 * Pattern types auto-detected when saving:
 *  - "ours"   / "theirs" — trivial choice
 *  - "both"              — both sides concatenated
 *  - "date-latest"       — both sides look like ISO dates; always take the most recent
 *  - "number-max"        — both sides are numeric; always take the larger
 *  - "custom"            — arbitrary edited content (stored verbatim)
 */

import { ref, computed } from "vue";
import type { ConflictHunk } from "@gitwand/core";

// ─── Types ────────────────────────────────────────────────────

export type ResolutionStrategy =
  | "ours"
  | "theirs"
  | "both"
  | "date-latest"
  | "number-max"
  | "custom";

/**
 * Whether a strategy generalizes across the multiple hunks of a file.
 * `ours`/`theirs`/`both`/`date-latest`/`number-max` derive their result from
 * each hunk's own content (the latter two skip hunks they can't apply to).
 * `custom` stores one verbatim blob tied to a single hunk — bulk-applying it
 * would stamp that same blob into every conflict, so it must never be applied
 * file-wide.
 */
export function isGeneralizableStrategy(strategy: ResolutionStrategy): boolean {
  return strategy !== "custom";
}

export interface ResolutionMemoryEntry {
  id: string;
  /** Relative file path this entry applies to */
  filePath: string;
  /** Strategy to apply */
  strategy: ResolutionStrategy;
  /** For "custom": the resolved content stored verbatim */
  resolvedContent: string | null;
  /** Human label shown in the UI */
  description: string;
  usageCount: number;
  createdAt: string;
  lastUsedAt: string | null;
}

// ─── Date / number detection helpers ─────────────────────────

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/;
const NUMBER_RE = /^-?\d+(\.\d+)?$/;

function isDate(s: string): boolean {
  return ISO_DATE_RE.test(s.trim());
}

function isNumber(s: string): boolean {
  return NUMBER_RE.test(s.trim());
}

function latestDate(a: string, b: string): string {
  return a.trim() >= b.trim() ? a : b;
}

function maxNumber(a: string, b: string): string {
  return parseFloat(a) >= parseFloat(b) ? a : b;
}

/** Guess a learnable pattern from two raw content strings. */
export function detectPattern(
  oursContent: string,
  theirsContent: string,
): ResolutionStrategy | null {
  const o = oursContent.trim();
  const t = theirsContent.trim();
  if (isDate(o) && isDate(t)) return "date-latest";
  if (isNumber(o) && isNumber(t)) return "number-max";
  return null;
}

// ─── Storage ──────────────────────────────────────────────────

const STORAGE_KEY = "gitwand-resolution-memory";

function load(): ResolutionMemoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ResolutionMemoryEntry[]) : [];
  } catch {
    return [];
  }
}

function persist(entries: ResolutionMemoryEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch { /* ignore */ }
}

// ─── Singleton ────────────────────────────────────────────────

const _entries = ref<ResolutionMemoryEntry[]>(load());

// ─── Apply strategy ───────────────────────────────────────────

/**
 * Given a memory entry and the current conflict hunk, compute the resolved
 * content string to use.  Returns null when strategy cannot be applied
 * (e.g. "date-latest" but content is not a date).
 */
export function applyMemory(
  entry: ResolutionMemoryEntry,
  hunk: ConflictHunk,
): string | null {
  const ours = hunk.oursLines.join("\n");
  const theirs = hunk.theirsLines.join("\n");
  switch (entry.strategy) {
    case "ours":
      return ours;
    case "theirs":
      return theirs;
    case "both":
      return ours + "\n" + theirs;
    case "date-latest":
      if (isDate(ours) && isDate(theirs)) return latestDate(ours, theirs);
      return null; // content changed shape, can't apply
    case "number-max":
      if (isNumber(ours) && isNumber(theirs)) return maxNumber(ours, theirs);
      return null;
    case "custom":
      return entry.resolvedContent;
    default:
      return null;
  }
}

// ─── Composable ───────────────────────────────────────────────

export function useResolutionMemory() {
  /** All stored memory entries for the given file, most-used first. */
  function memoriesForFile(filePath: string): ResolutionMemoryEntry[] {
    return _entries.value
      .filter(e => e.filePath === filePath)
      .sort((a, b) => b.usageCount - a.usageCount);
  }

  /** Whether any memory exists for this file. */
  function hasMemory(filePath: string): boolean {
    return _entries.value.some(e => e.filePath === filePath);
  }

  /**
   * Find the most relevant memory entry for a file.
   * Returns null when nothing stored.
   */
  function findMemory(filePath: string): ResolutionMemoryEntry | null {
    return memoriesForFile(filePath)[0] ?? null;
  }

  /**
   * Save a new resolution memory entry.
   * Replaces an existing entry for the same filePath + strategy combination
   * (keeps the list tidy — one entry per file/strategy pair).
   */
  function saveMemory(
    filePath: string,
    strategy: ResolutionStrategy,
    description: string,
    resolvedContent: string | null = null,
  ): ResolutionMemoryEntry {
    const now = new Date().toISOString();
    const existing = _entries.value.find(
      e => e.filePath === filePath && e.strategy === strategy,
    );
    if (existing) {
      const updated: ResolutionMemoryEntry = {
        ...existing,
        description,
        resolvedContent,
        usageCount: existing.usageCount + 1,
        lastUsedAt: now,
      };
      _entries.value = _entries.value.map(e => (e.id === existing.id ? updated : e));
      persist(_entries.value);
      return updated;
    }
    const entry: ResolutionMemoryEntry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      filePath,
      strategy,
      resolvedContent,
      description,
      usageCount: 1,
      createdAt: now,
      lastUsedAt: null,
    };
    _entries.value = [..._entries.value, entry];
    persist(_entries.value);
    return entry;
  }

  /** Mark an entry as used (increments usageCount + updates lastUsedAt). */
  function markUsed(id: string): void {
    _entries.value = _entries.value.map(e =>
      e.id === id
        ? { ...e, usageCount: e.usageCount + 1, lastUsedAt: new Date().toISOString() }
        : e,
    );
    persist(_entries.value);
  }

  function deleteMemory(id: string): void {
    _entries.value = _entries.value.filter(e => e.id !== id);
    persist(_entries.value);
  }

  const allEntries = computed(() => [..._entries.value]);

  return {
    allEntries,
    hasMemory,
    memoriesForFile,
    findMemory,
    saveMemory,
    markUsed,
    deleteMemory,
    detectPattern,
    applyMemory,
  };
}
