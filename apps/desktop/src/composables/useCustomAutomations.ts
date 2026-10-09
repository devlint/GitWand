/**
 * useCustomAutomations — per-user automation rules.
 *
 * A rule fires when a conflicted file matches its `trigger` glob pattern.
 * When triggered, GitWand proposes running the user's shell `command` inside
 * the repo, then offers to commit the result with `commitMessage`.
 *
 * Rules are stored in localStorage under "gitwand-custom-automations" as a
 * flat JSON array.  The composable is a singleton so all panels share the
 * same reactive list.
 */

import { ref } from "vue";
import { shellExec, gitStage, gitCommit } from "../utils/backend";
import { resolveIdentity } from "./useIdentity";

// ─── Types ────────────────────────────────────────────────────

export interface CustomAutomationRule {
  id: string;
  /** Human-readable label shown in the UI */
  name: string;
  /**
   * File path pattern that triggers the rule (compared against the
   * conflicted-file path using a simple substring / glob check).
   * Examples: "public/build/manifest.json", "*.lock", "dist/**"
   */
  trigger: string;
  /** Shell command executed in the repo root */
  command: string;
  /** Commit message used after staging the result.
   *  "{trigger}" is replaced with the matched file's path. */
  commitMessage: string;
  enabled: boolean;
}

export interface AutomationRunResult {
  output: string;
  commitHash?: string;
}

// ─── Storage ──────────────────────────────────────────────────

const STORAGE_KEY = "gitwand-custom-automations";

function load(): CustomAutomationRule[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as CustomAutomationRule[]) : [];
  } catch {
    return [];
  }
}

function persist(rules: CustomAutomationRule[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
  } catch { /* ignore */ }
}

// ─── Singleton reactive state ─────────────────────────────────

const _rules = ref<CustomAutomationRule[]>(load());

// ─── Glob/pattern matching ────────────────────────────────────

/**
 * Returns true when `filePath` matches the rule's `trigger`.
 *
 * Matching strategy (simple, no external deps):
 * 1. Exact match or trailing-segment match ("manifest.json" matches any path ending with it)
 * 2. Glob-style "*" wildcard within a segment
 * 3. "**" matches any number of path segments
 */
function matchesTrigger(trigger: string, filePath: string): boolean {
  // Normalise separators
  const t = trigger.replace(/\\/g, "/").trim();
  const f = filePath.replace(/\\/g, "/").trim();
  if (!t) return false;

  // Exact match
  if (t === f) return true;
  // Trailing segment: "manifest.json" → matches "public/build/manifest.json"
  if (!t.includes("/") && (f === t || f.endsWith("/" + t))) return true;
  // Convert simple glob to RegExp
  const re = new RegExp(
    "^" +
      t
        .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape special chars except * ?
        .replace(/\*\*/g, "§DSTAR§")
        .replace(/\*/g, "[^/]*")
        .replace(/§DSTAR§/g, ".*")
        .replace(/\?/g, "[^/]") +
      "$",
  );
  return re.test(f);
}

// ─── Composable ───────────────────────────────────────────────

export function useCustomAutomations() {
  /** Reload from localStorage (e.g. after another tab writes). */
  function refresh(): void {
    _rules.value = load();
  }

  function addRule(rule: Omit<CustomAutomationRule, "id">): CustomAutomationRule {
    const newRule: CustomAutomationRule = {
      ...rule,
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    };
    _rules.value = [..._rules.value, newRule];
    persist(_rules.value);
    return newRule;
  }

  function updateRule(id: string, patch: Partial<Omit<CustomAutomationRule, "id">>): void {
    _rules.value = _rules.value.map(r => (r.id === id ? { ...r, ...patch } : r));
    persist(_rules.value);
  }

  function deleteRule(id: string): void {
    _rules.value = _rules.value.filter(r => r.id !== id);
    persist(_rules.value);
  }

  function toggleRule(id: string, enabled: boolean): void {
    updateRule(id, { enabled });
  }

  /**
   * Find the first enabled rule whose trigger matches `filePath`.
   * Returns null when no rule matches.
   */
  function findMatchingRule(filePath: string): CustomAutomationRule | null {
    return (
      _rules.value.find(r => r.enabled && matchesTrigger(r.trigger, filePath)) ?? null
    );
  }

  /**
   * Execute a rule: run its shell command, stage all changes, commit.
   * Returns the command output and the new commit hash.
   */
  async function executeRule(
    cwd: string,
    rule: CustomAutomationRule,
    matchedFilePath: string,
  ): Promise<AutomationRunResult> {
    const output = await shellExec(cwd, rule.command);

    const message = rule.commitMessage
      .replace("{trigger}", matchedFilePath)
      .replace("{file}", matchedFilePath);

    if (message.trim()) {
      await gitStage(cwd, ["."]);
      const identity = resolveIdentity(cwd);
      const commitHash = await gitCommit(
        cwd,
        message,
        identity ? { name: identity.gitName, email: identity.gitEmail } : null,
      );
      return { output, commitHash };
    }
    return { output };
  }

  return {
    rules: _rules,
    refresh,
    addRule,
    updateRule,
    deleteRule,
    toggleRule,
    findMatchingRule,
    executeRule,
  };
}
