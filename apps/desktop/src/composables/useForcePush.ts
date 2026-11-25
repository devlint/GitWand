/**
 * The force-push decision: what a force push will overwrite, whether to
 * confirm it, and the lease it pushes with.
 *
 * The remote is fetched and the destination's tip read when the user asks,
 * not taken from the last status refresh: the count the confirmation shows is
 * what the push will overwrite, and the push leases that exact sha, so
 * anything pushed after the decision is refused. A retry after such a
 * refusal fetches again, so it judges the new tip instead of failing on the
 * same stale one.
 */
import { ref, type Ref } from "vue";
import { fetchPushRemote, forcePushTarget } from "./useBranchUpdatePrompt";

/** Trunks a force push always confirms, under their local or remote name. */
export const PROTECTED_TRUNKS = new Set(["main", "master"]);

export interface ForcePushConfirm {
  /** The local branch the decision was made on. */
  branch: string;
  /** Commits only the destination has: what the push overwrites. */
  behind: number;
  protected: boolean;
  /** The protected trunk the push would overwrite (local or remote name). */
  protectedName: string;
  leaseSha: string | null;
  /** The repository the decision was made in (tabs can switch meanwhile). */
  cwd: string;
}

export interface ForcePushDeps {
  folderPath: Ref<string | null | undefined>;
  /** The checked-out branch now ("" when unknown or detached). */
  currentBranch: () => string;
  isPushing: Ref<boolean>;
  /** The push publishes the branch (no upstream: `--set-upstream origin HEAD`). */
  publishing: () => boolean;
  /**
   * A fetch of the default remote that waits behind one already running (the
   * backend's repo lock), rather than being skipped: the tip is judged after
   * it. Failures (offline) are ignored: the push reports them.
   */
  fetch: () => Promise<unknown>;
  /** Push with force and this lease (null: the backend's fallback). */
  push: (leaseSha: string | null) => Promise<unknown>;
}

export function useForcePush(deps: ForcePushDeps) {
  const forcePushConfirm = ref<ForcePushConfirm | null>(null);
  /**
   * Set from the moment a force push is asked for until its push settles (or
   * its confirmation takes over): a second click in that window would push
   * again on a lease the first push spends, and be refused.
   */
  let inFlight = false;

  /** Entry point for every force-push trigger. */
  async function requestForcePush(): Promise<void> {
    const cwd = deps.folderPath.value;
    if (!cwd || inFlight || deps.isPushing.value) return;
    const branch = deps.currentBranch();
    inFlight = true;
    try {
      await deps.fetch().catch(() => null);
      const publishing = deps.publishing();
      if (!publishing) await fetchPushRemote(cwd);
      const target = await forcePushTarget(cwd, publishing ? { publishBranch: branch } : {});
      // The lease is for this repo and this branch only: a switch meanwhile
      // is the user's own action, and drops the request.
      if (deps.folderPath.value !== cwd || deps.currentBranch() !== branch) return;
      // A trunk is protected under its remote name too: `mine` pushed to main.
      const protectedName = [branch, target?.branch ?? ""].find((b) => PROTECTED_TRUNKS.has(b)) ?? "";
      // No readable destination (never pushed): nothing known to overwrite.
      // The upstream's count would describe another ref.
      const behind = target ? target.behind : 0;
      // A lease names the remote branch: without a readable name, none is
      // sent (the backend would refuse it) and the push falls back.
      const leaseSha = target?.branch ? target.sha : null;
      if (protectedName !== "" || behind > 0) {
        forcePushConfirm.value = {
          branch,
          behind,
          protected: protectedName !== "",
          protectedName,
          leaseSha,
          cwd,
        };
        return;
      }
      await deps.push(leaseSha);
    } finally {
      inFlight = false;
    }
  }

  async function confirmForcePush(): Promise<void> {
    const pending = forcePushConfirm.value;
    if (!pending) return;
    // A push is running: keep the confirmation, it can be confirmed after.
    if (inFlight || deps.isPushing.value) return;
    forcePushConfirm.value = null;
    // Switched tab or checked out another branch while it was open: what it
    // showed (and the lease) no longer describes the push.
    if (deps.folderPath.value !== pending.cwd || deps.currentBranch() !== pending.branch) return;
    inFlight = true;
    try {
      await deps.push(pending.leaseSha);
    } finally {
      inFlight = false;
    }
  }

  function cancelForcePush(): void {
    forcePushConfirm.value = null;
  }

  return { forcePushConfirm, requestForcePush, confirmForcePush, cancelForcePush };
}
