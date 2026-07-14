/**
 * useBranchUpdatePrompt — post-checkout "Update branch" prompt logic.
 *
 * When the user checks out a local branch that is behind its upstream with no
 * divergent local commits (ahead == 0), GitWand offers a one-click
 * fast-forward. "Continue on local branch" mutes the prompt for that
 * repo+branch pair; the mute is cleared automatically when the branch is
 * successfully pulled/updated by any path.
 *
 * State is persisted in AppSettings.branchUpdatePromptSkips (keyed by cwd)
 * via localStorage — same shape and lifecycle as useArchivedBranches.
 */

import { loadSettings, normaliseCwd, saveSettings } from "./useSettings";

// ─── decision ────────────────────────────────────────────────────────────────

export type CheckoutPromptKind = "update" | "genericPull" | "none";

/**
 * Pure decision: which prompt (if any) to show after a branch checkout.
 *
 * - behind-only + upstream + not muted → dedicated "Update branch" prompt
 * - diverged (ahead > 0 && behind > 0) → existing generic pull prompt
 * - everything else → nothing
 */
export function computeCheckoutPrompt(input: {
  ahead: number;
  behind: number;
  hasUpstream: boolean;
  /** Lazy so the settings blob is only parsed when the branch is behind-only. */
  isSkipped: () => boolean;
}): CheckoutPromptKind {
  if (!input.hasUpstream || input.behind <= 0) return "none";
  if (input.ahead > 0) return "genericPull";
  return input.isSkipped() ? "none" : "update";
}

// ─── persistence ─────────────────────────────────────────────────────────────

/** Mute the "Update branch" prompt for a branch. No-op if already muted. */
export function skipUpdatePrompt(cwd: string, branch: string): void {
  const s = loadSettings();
  const key = normaliseCwd(cwd);
  const list = s.branchUpdatePromptSkips[key] ?? [];
  if (!list.includes(branch)) {
    s.branchUpdatePromptSkips[key] = [...list, branch];
    saveSettings(s);
  }
}

/** Return true if the prompt is muted for the given repo+branch. */
export function isUpdatePromptSkipped(cwd: string, branch: string): boolean {
  return (loadSettings().branchUpdatePromptSkips[normaliseCwd(cwd)] ?? []).includes(branch);
}

/** Un-mute a single branch (e.g. after a successful pull/update). */
export function clearUpdatePromptSkip(cwd: string, branch: string): void {
  const s = loadSettings();
  const key = normaliseCwd(cwd);
  const list = s.branchUpdatePromptSkips[key] ?? [];
  if (list.includes(branch)) {
    s.branchUpdatePromptSkips[key] = list.filter((b) => b !== branch);
    saveSettings(s);
  }
}
