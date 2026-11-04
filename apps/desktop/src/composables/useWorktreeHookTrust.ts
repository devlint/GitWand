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

/**
 * The answer, with the exact status it was given for. On `run`, the caller
 * hands `status.hash` to the hook runner, whose backend gate
 * (`assert_hooks_trusted`) re-reads the hooks and refuses if they no longer
 * match: only what the user saw ever runs.
 */
export interface HookTrustDecision {
  choice: HookTrustChoice;
  status: HookTrustStatus | null;
}

export interface WorktreeHookTrustDeps {
  status: (cwd: string) => Promise<HookTrustStatus>;
  trust: (cwd: string, hash: string) => Promise<void>;
}

export interface WorktreeHookTrust {
  /** Non-null while the question is open. */
  pending: Readonly<Ref<HookTrustStatus | null>>;
  /** Why the last "trust" failed, e.g. the hooks changed in the meantime. */
  error: Readonly<Ref<string | null>>;
  /** True while a "trust" is being recorded; answers are ignored meanwhile. */
  busy: Readonly<Ref<boolean>>;
  ensureTrusted(cwd: string): Promise<HookTrustDecision>;
  answer(choice: "trust" | "skip" | "cancel"): Promise<void>;
}

export function createWorktreeHookTrust(deps: WorktreeHookTrustDeps): WorktreeHookTrust {
  const pending = ref<HookTrustStatus | null>(null);
  const error = ref<string | null>(null);
  const busy = ref(false);
  let current: { cwd: string; resolve: (d: HookTrustDecision) => void } | null = null;

  function settle(choice: HookTrustChoice, status: HookTrustStatus | null) {
    const c = current;
    current = null;
    pending.value = null;
    error.value = null;
    c?.resolve({ choice, status });
  }

  async function ensureTrusted(cwd: string): Promise<HookTrustDecision> {
    if (current) return { choice: "cancel", status: null };
    const status = await deps.status(cwd);
    if (status.trusted) return { choice: "run", status };
    if (current) return { choice: "cancel", status: null };
    return new Promise<HookTrustDecision>((resolve) => {
      current = { cwd, resolve };
      error.value = null;
      pending.value = status;
    });
  }

  async function answer(choice: "trust" | "skip" | "cancel"): Promise<void> {
    const req = current;
    const shown = pending.value;
    if (!req || !shown || busy.value) return;
    if (choice !== "trust") {
      settle(choice, shown);
      return;
    }
    if (!shown.hash) {
      settle("run", shown);
      return;
    }
    busy.value = true;
    try {
      await deps.trust(req.cwd, shown.hash);
      if (current === req) settle("run", shown);
    } catch (e) {
      // The hooks changed after the question opened: show the new ones and
      // let the user answer again, never trust what they did not see.
      if (current !== req) return;
      error.value = e instanceof Error ? e.message : String(e);
      try {
        const fresh = await deps.status(req.cwd);
        if (current !== req) return;
        if (fresh.trusted) {
          settle("run", fresh);
          return;
        }
        pending.value = fresh;
      } catch (e2) {
        if (current === req) error.value = e2 instanceof Error ? e2.message : String(e2);
      }
    } finally {
      busy.value = false;
    }
  }

  return {
    pending: readonly(pending),
    error: readonly(error),
    busy: readonly(busy),
    ensureTrusted,
    answer,
  };
}

let shared: WorktreeHookTrust | null = null;

export function useWorktreeHookTrust(): WorktreeHookTrust {
  shared ??= createWorktreeHookTrust({ status: worktreeHooksTrust, trust: worktreeHooksTrustSet });
  return shared;
}
