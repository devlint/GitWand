/**
 * v3.13 — Ask before running a repository's worktree commands.
 *
 * A `.gitwandrc` arrives with `git clone`, so its `worktree.setup` /
 * `teardown` / `url` never run until the user has trusted them. The backend
 * reads them from the main worktree and remembers the trusted hash; this
 * composable only drives the question. State is module-level, so the call
 * sites (worktree creation and removal) and the modal mounted once in App.vue
 * share it.
 */
import { ref, readonly, type Ref } from "vue";
import { worktreeHooksTrust, worktreeHooksTrustSet, type HookTrustStatus } from "../utils/backend";

/** `run`: hooks may run. `skip`: proceed without them. `cancel`: abort. */
export type HookTrustChoice = "run" | "skip" | "cancel";

export interface WorktreeHookTrustDeps {
  status: (cwd: string) => Promise<HookTrustStatus>;
  trust: (cwd: string, hash: string) => Promise<void>;
}

export interface WorktreeHookTrust {
  /** Non-null while the question is open. */
  pending: Readonly<Ref<HookTrustStatus | null>>;
  /** Why the last "trust" failed, e.g. the hooks changed in the meantime. */
  error: Readonly<Ref<string | null>>;
  ensureTrusted(cwd: string): Promise<HookTrustChoice>;
  answer(choice: "trust" | "skip" | "cancel"): Promise<void>;
}

export function createWorktreeHookTrust(deps: WorktreeHookTrustDeps): WorktreeHookTrust {
  const pending = ref<HookTrustStatus | null>(null);
  const error = ref<string | null>(null);
  let current: { cwd: string; resolve: (c: HookTrustChoice) => void } | null = null;

  function settle(choice: HookTrustChoice) {
    const c = current;
    current = null;
    pending.value = null;
    error.value = null;
    c?.resolve(choice);
  }

  async function ensureTrusted(cwd: string): Promise<HookTrustChoice> {
    if (current) return "cancel";
    const status = await deps.status(cwd);
    if (status.trusted) return "run";
    if (current) return "cancel";
    return new Promise<HookTrustChoice>((resolve) => {
      current = { cwd, resolve };
      error.value = null;
      pending.value = status;
    });
  }

  async function answer(choice: "trust" | "skip" | "cancel"): Promise<void> {
    if (!current || !pending.value) return;
    if (choice !== "trust") {
      settle(choice);
      return;
    }
    const { cwd } = current;
    const hash = pending.value.hash;
    if (!hash) {
      settle("run");
      return;
    }
    try {
      await deps.trust(cwd, hash);
      settle("run");
    } catch (e) {
      // The hooks changed after the question opened: show the new ones and
      // let the user answer again, never trust what they did not see.
      error.value = e instanceof Error ? e.message : String(e);
      try {
        const fresh = await deps.status(cwd);
        if (fresh.trusted) {
          settle("run");
          return;
        }
        pending.value = fresh;
      } catch (e2) {
        error.value = e2 instanceof Error ? e2.message : String(e2);
      }
    }
  }

  return { pending: readonly(pending), error: readonly(error), ensureTrusted, answer };
}

let shared: WorktreeHookTrust | null = null;

export function useWorktreeHookTrust(): WorktreeHookTrust {
  shared ??= createWorktreeHookTrust({ status: worktreeHooksTrust, trust: worktreeHooksTrustSet });
  return shared;
}
