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

import { gitExec, gitFetch } from "../utils/backend";
import { remoteBranchOf, trackingRefOf } from "../utils/refspec";
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
 *   reflog) as a commit made here, or one the branch left through a rewrite
 *   (`leftThroughRewrite`): the remote only holds an older version of local
 *   history. This survives conflicts resolved during the rebase, which
 *   change patches. A tip that only arrived by a pull proves nothing (#239):
 *   a collaborator's commit undone by a reset was a local tip too, and a
 *   force push would drop it.
 * - every commit only the upstream has still exists locally as a
 *   patch-equivalent commit (covers a never-checked-out remote tip). Merge
 *   commits are NOT skipped here: a remote-only merge can carry content of its
 *   own (conflict resolution, an added file) that has no patch-equivalent
 *   locally, and a force push would delete it. Any such merge makes it unsafe.
 *
 * A collaborator's new commit was never a local tip and has no local
 * equivalent, so Sync stays the default whenever pulling is actually needed.
 * The verdict is only positive when a plain push goes to the upstream itself
 * (`@{push}` is `@{upstream}`), since that is the ref the force push replaces.
 *
 * Returns the `@{upstream}` sha the verdict was computed against so callers can
 * tell when it goes stale (the remote-tracking ref moved).
 */
export async function probeLocalRewriteOfUpstream(
  cwd: string,
  branch: string,
): Promise<{ safe: boolean; upstream: string | null }> {
  try {
    const [upstream, reflog, upstreamOnly, refs] = await Promise.all([
      gitExec(cwd, ["rev-parse", "@{upstream}"]),
      gitExec(cwd, ["reflog", "show", "--format=%H%x09%gs", `refs/heads/${branch}`]),
      gitExec(cwd, ["rev-list", "--cherry-pick", "--right-only", "HEAD...@{upstream}"]),
      gitExec(cwd, ["rev-parse", "--symbolic-full-name", "@{upstream}", "@{push}"]),
    ]);
    if (upstream.exitCode !== 0) return { safe: false, upstream: null };
    const tip = upstream.stdout.trim();
    if (!tip) return { safe: false, upstream: null };
    // A push that goes elsewhere than the upstream (a branch tracking
    // origin/main, pushed to origin/<branch>) would not overwrite the commits
    // judged here: never prefer a force push for it.
    const [upRef, pushRef] = refs.stdout.trim().split("\n");
    if (refs.exitCode !== 0 || !upRef || upRef !== pushRef) return { safe: false, upstream: tip };
    if (reflog.exitCode === 0 && leftThroughRewrite(reflog.stdout, tip)) {
      return { safe: true, upstream: tip };
    }
    return { safe: upstreamOnly.exitCode === 0 && upstreamOnly.stdout.trim() === "", upstream: tip };
  } catch {
    return { safe: false, upstream: null };
  }
}

/**
 * True when the branch's reflog (`%H<TAB>%gs`, newest first) shows `tip` as
 * a past value of the branch that was local history:
 *
 * - set by a commit made here (`commit: …`, `commit (amend): …`,
 *   `commit (initial): …`, a cherry-pick): the user's own commit, whatever
 *   happened to it since (undo last commit then a new one, a squash by
 *   `reset --soft`). Not one set by a rebase: a fast-forward rebase onto
 *   the upstream also writes `rebase (finish)`;
 * - or left by a rewrite: a rebase (`rebase (finish): …`, `rebase -i …`,
 *   a restack), a pull that rebased (`pull --rebase (finish): …`) or an
 *   amend.
 *
 * A tip that arrived by a pull, a merge, a reset or a branch creation and
 * was then left by a reset or a plain commit proves nothing (#239): it may
 * be a collaborator's commit undone locally. A merge commit made here does
 * not count either: it holds the commits it merged.
 */
export function leftThroughRewrite(reflog: string, tip: string): boolean {
  const entries = reflog
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const tab = l.indexOf("\t");
      return tab < 0
        ? { hash: l.trim(), subject: "" }
        : { hash: l.slice(0, tab).trim(), subject: l.slice(tab + 1) };
    });
  // A rebase, a pull that rebased (`pull --rebase (finish)`, `pull -q
  // --rebase (finish)`: git writes the user's options; its fast-forward,
  // `pull --rebase: Fast-forward`, is no rewrite), an amend.
  const rewrite = (subject: string) =>
    /^rebase\b/.test(subject) ||
    /^pull\b[^:]*\(finish\)/.test(subject) ||
    subject.startsWith("commit (amend)");
  // Not a rebase's result: a fast-forward `git rebase origin/x` writes
  // `rebase (finish)` too, setting the tip to a collaborator's commit.
  const madeHere = (subject: string) =>
    (/^commit\b/.test(subject) && !subject.startsWith("commit (merge)")) ||
    /^cherry-pick\b/.test(subject);
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].hash !== tip) continue;
    if (madeHere(entries[i].subject) || rewrite(entries[i - 1].subject)) return true;
  }
  return false;
}

/**
 * True when git refused a force push because the remote branch moved past
 * what the lease allows: `(stale info)` for `--force-with-lease`, `(remote ref
 * updated since checkout)` for `--force-if-includes`. git prints both reasons
 * in English whatever the locale.
 */
export function isForcePushRemoteMoved(message: string): boolean {
  return /\(stale info\)|\(remote ref updated since checkout\)/.test(message);
}

/** Where a plain push from the checked-out branch goes, and its upstream's remote. */
async function pushRefs(
  cwd: string,
): Promise<{ pushRemote: string; pushRef: string; upstreamRemote: string } | null> {
  const head = await gitExec(cwd, ["symbolic-ref", "-q", "HEAD"]);
  const ref = head.stdout.trim();
  if (head.exitCode !== 0 || !ref.startsWith("refs/heads/")) return null;
  const out = await gitExec(cwd, [
    "for-each-ref",
    "--format=%(refname)%09%(push:remotename)%09%(push)%09%(upstream:remotename)",
    ref,
  ]);
  if (out.exitCode !== 0) return null;
  const line = out.stdout.split("\n").find((l) => l.startsWith(`${ref}\t`));
  if (line === undefined) return null;
  const [, pushRemote = "", pushRef = "", upstreamRemote = ""] = line.split("\t");
  return { pushRemote, pushRef, upstreamRemote };
}

/**
 * Bring the push destination's remote-tracking ref up to date before a force
 * push is judged. The app's own fetch (`gitFetch`, done by the caller) covers
 * the upstream's remote; a destination on another remote (`remote.pushDefault`,
 * `branch.<b>.pushRemote`) is fetched here. Best-effort: offline, the last
 * fetched state is what the user is shown, and the push itself will fail.
 */
export async function fetchPushRemote(cwd: string): Promise<void> {
  try {
    const refs = await pushRefs(cwd);
    if (!refs || !refs.pushRemote || refs.pushRemote === refs.upstreamRemote) return;
    if (refs.pushRemote.startsWith("-")) return;
    // The app's fetch command (repo lock, prune), on that remote.
    await gitFetch(cwd, undefined, refs.pushRemote);
  } catch {
    /* best-effort */
  }
}

/**
 * What a force push would replace, read when the user decides to force push:
 * the tip of the ref the push updates, how many of its commits the local
 * branch does not have, and that branch's name on the remote (`branch`, which
 * can differ from the local name; `null` when the fetch refspecs do not map
 * it back). The push then leases exactly that sha, so it overwrites what the
 * user was shown and nothing that arrived since.
 *
 * The ref is `@{push}` (read as `%(push)`), or, for a publish
 * (`publishBranch`: no upstream yet, the push runs `--set-upstream origin
 * HEAD`), `origin/<branch>`. `null` when there is no such ref (never pushed,
 * not fetched, or `@{push}` unresolvable): the backend then falls back to
 * `--force-if-includes`.
 */
export async function forcePushTarget(
  cwd: string,
  opts: { publishBranch?: string } = {},
): Promise<{ sha: string; behind: number; branch: string | null } | null> {
  try {
    let remote: string;
    let tracking: string;
    if (opts.publishBranch) {
      remote = "origin";
      // Where origin's fetch refspecs put its `refs/heads/<branch>`.
      const fetch = await gitExec(cwd, ["config", "--get-all", "remote.origin.fetch"]);
      const mapped = trackingRefOf(fetch.stdout, opts.publishBranch);
      if (mapped === null) return null;
      tracking = mapped;
    } else {
      const refs = await pushRefs(cwd);
      if (!refs || !refs.pushRef) return null;
      remote = refs.pushRemote;
      tracking = refs.pushRef;
    }
    if (!tracking.startsWith("refs/")) return null;
    const tip = await gitExec(cwd, ["rev-parse", "--verify", "-q", tracking]);
    const sha = tip.stdout.trim();
    if (tip.exitCode !== 0 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) return null;
    const count = await gitExec(cwd, ["rev-list", "--count", `HEAD..${sha}`]);
    const behind = Number.parseInt(count.stdout.trim(), 10);
    if (count.exitCode !== 0 || !Number.isFinite(behind)) return null;
    let branch: string | null = null;
    if (remote && !remote.startsWith("-")) {
      const fetch = await gitExec(cwd, ["config", "--get-all", `remote.${remote}.fetch`]);
      branch = remoteBranchOf(fetch.stdout, tracking);
    }
    return { sha, behind, branch };
  } catch {
    return null;
  }
}

/** git's `! [rejected] … (stale info)` line from a refused push, trimmed. */
export function forcePushRejectionLine(message: string): string {
  const line = message
    .split("\n")
    .map((l) => l.trim())
    .find((l) => isForcePushRemoteMoved(l));
  return line ?? message.trim();
}

export async function isLocalRewriteOfUpstream(cwd: string, branch: string): Promise<boolean> {
  return (await probeLocalRewriteOfUpstream(cwd, branch)).safe;
}

export type AutoForcePushVerdict =
  | { action: "set"; upstream: string }
  | { action: "clear" }
  | { action: "keep" };

/**
 * Re-evaluate the auto-detected "prefer force push" state. `autoSha` is the
 * upstream tip recorded when the preference was auto-set (null when it is off
 * or was chosen explicitly — a reset, a rebase the user ran — which is never
 * revoked here).
 *
 * - probe safe  -> set (records the judged upstream; no-op if already recorded)
 * - probe unsafe, preference was auto -> clear (the remote gained something)
 * - otherwise keep
 */
export async function evaluateAutoForcePush(
  cwd: string,
  branch: string,
  state: { preferred: boolean; autoSha: string | null },
): Promise<AutoForcePushVerdict> {
  if (state.preferred && state.autoSha === null) return { action: "keep" };
  const probe = await probeLocalRewriteOfUpstream(cwd, branch);
  if (probe.safe && probe.upstream) {
    if (state.preferred && state.autoSha === probe.upstream) return { action: "keep" };
    return { action: "set", upstream: probe.upstream };
  }
  return state.preferred ? { action: "clear" } : { action: "keep" };
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
