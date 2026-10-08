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

import { gitExec } from "../utils/backend";
import { loadSettings, normaliseCwd, saveSettings } from "./useSettings";

// ─── decision ────────────────────────────────────────────────────────────────

export type CheckoutPromptKind = "update" | "rewritten" | "genericPull" | "none";

/**
 * Pure decision: which prompt (if any) to show after a branch checkout.
 *
 * - behind-only + upstream + not muted → dedicated "Update branch" prompt
 * - diverged only because the upstream was rewritten (force-push) and the
 *   branch has no commits of its own + not muted → "rewritten" prompt (#223)
 * - any other divergence (ahead > 0 && behind > 0) → generic pull prompt
 * - everything else → nothing
 */
export function computeCheckoutPrompt(input: {
  ahead: number;
  behind: number;
  hasUpstream: boolean;
  /** See `isUpstreamRewriteOnly` — only meaningful when diverged. */
  upstreamRewritten?: boolean;
  /** Lazy so the settings blob is only parsed when the branch is behind-only. */
  isSkipped: () => boolean;
}): CheckoutPromptKind {
  if (!input.hasUpstream || input.behind <= 0) return "none";
  if (input.ahead > 0) {
    if (!input.upstreamRewritten) return "genericPull";
    return input.isSkipped() ? "none" : "rewritten";
  }
  return input.isSkipped() ? "none" : "update";
}

// ─── detection ───────────────────────────────────────────────────────────────

/**
 * True when the current branch diverges from its upstream only because the
 * upstream was rewritten (rebased + force-pushed): every local commit was once
 * on the upstream, so the user has no work of their own on the branch.
 *
 * That is exactly "git's fork-point equals the local tip" — the fork-point is
 * found through the remote-tracking ref's reflog, the same logic
 * `git pull --rebase` uses to drop the old upstream commits. A merge pull would
 * instead merge the old history with its rewrite and conflict for nothing.
 */
export async function isUpstreamRewriteOnly(cwd: string): Promise<boolean> {
  try {
    const [fork, head] = await Promise.all([
      gitExec(cwd, ["merge-base", "--fork-point", "@{upstream}", "HEAD"]),
      gitExec(cwd, ["rev-parse", "HEAD"]),
    ]);
    if (fork.exitCode !== 0 || head.exitCode !== 0) return false;
    const tip = head.stdout.trim();
    return tip !== "" && fork.stdout.trim() === tip;
  } catch {
    return false;
  }
}

/**
 * The mirror case: the branch diverges because the LOCAL side was rewritten
 * (rebased, reordered, squashed — in GitWand or the CLI), so nothing on the
 * remote would be lost and the next push should be a force push, not a pull.
 * Either signal is enough:
 *
 * - the upstream tip was once this branch's own tip (it is in the branch's
 *   reflog): the remote only holds an older version of local history. This
 *   survives conflicts resolved during the rebase, which change patches.
 * - every commit only the upstream has still exists locally as a
 *   patch-equivalent commit (covers a never-checked-out remote tip).
 *
 * A collaborator's new commit was never a local tip and has no local
 * equivalent, so Sync stays the default whenever pulling is actually needed.
 */
export async function isLocalRewriteOfUpstream(cwd: string, branch: string): Promise<boolean> {
  try {
    const [upstream, reflog, upstreamOnly] = await Promise.all([
      gitExec(cwd, ["rev-parse", "@{upstream}"]),
      gitExec(cwd, ["reflog", "show", "--format=%H", `refs/heads/${branch}`]),
      gitExec(cwd, ["rev-list", "--cherry-pick", "--right-only", "--no-merges", "HEAD...@{upstream}"]),
    ]);
    if (upstream.exitCode !== 0) return false;
    const tip = upstream.stdout.trim();
    if (reflog.exitCode === 0 && reflog.stdout.split("\n").some((h) => h.trim() === tip)) return true;
    return upstreamOnly.exitCode === 0 && upstreamOnly.stdout.trim() === "";
  } catch {
    return false;
  }
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
