/**
 * v3.13 — Removing a worktree, end to end (spec §7.2), whatever asked for
 * it: the worktree manager, an AI task's close, the Git Tree, the cleanup
 * after a merge-back.
 *
 *   check   → guards (`worktree_guard`); untouchable stops here, with
 *             Unlock for a git lock;
 *   confirm → trust prompt when teardown must run, close the worktree's
 *             terminal tabs, stop its processes and snapshot it
 *             (`worktree_remove_prepare`); survivors stop here, with Retry
 *             and Stop all;
 *           → teardown in a read-only terminal tab; a non-zero exit stops
 *             here, with Retry teardown, Open the log and Remove anyway;
 *           → `worktree_remove` (git worktree remove, prune, branch, record).
 *
 * One instance per removal dialog. Opening a terminal tab and closing the
 * worktree's tabs needs the terminal panel, which App.vue owns: it
 * registers them with `registerRemovalHost`.
 */
import { ref, type Ref } from "vue";
import {
  worktreeGuard,
  worktreeRemove,
  worktreeRemovePrepare,
  worktreeUnlock,
  type ProcessInfo,
  type RemoveOptions,
  type RemoveOutcome,
  type RemovePrepared,
  type WorktreeGuard,
} from "../utils/backend";
import { useWorktreeHookTrust, type HookTrustDecision } from "./useWorktreeHookTrust";

export type RemovalPhase =
  | "idle"
  | "checking"
  | "refused"
  | "confirm"
  | "stopping"
  | "processes"
  | "teardown"
  | "teardown-failed"
  | "removing"
  | "done"
  | "error";

export interface RemovalRequest {
  /** The repo key the teardown tab is listed under. */
  repoPath: string;
  /** Any checkout of the repo, outside the worktree being removed. */
  cwd: string;
  path: string;
  name: string;
  /** "Also delete branch", pre-ticked by the caller. */
  deleteBranch: boolean;
}

export interface RemovalState {
  phase: RemovalPhase;
  guard: WorktreeGuard | null;
  survivors: ProcessInfo[];
  teardownCode: number | null;
  /** The teardown tab, for "Open the log". */
  tabId: number | null;
  /** The user chose "Skip hooks this time": teardown did not run. */
  skippedHooks: boolean;
  error: string | null;
  outcome: RemoveOutcome | null;
}

export interface WorktreeRemovalDeps {
  guard: (cwd: string, path: string) => Promise<WorktreeGuard>;
  prepare: (cwd: string, path: string, killForeign: boolean) => Promise<RemovePrepared>;
  remove: (cwd: string, path: string, opts: RemoveOptions) => Promise<RemoveOutcome>;
  unlock: (cwd: string, path: string) => Promise<void>;
  ensureTrusted: (cwd: string) => Promise<HookTrustDecision>;
  /** Opens the teardown tab and resolves with its exit code once it ends. */
  runTeardown: (
    repoPath: string,
    cwd: string,
    path: string,
    name: string,
    hash: string,
  ) => Promise<{ code: number | null; tabId: number }>;
  /** Closes the terminal tabs open in the worktree (spec §8 step 4). */
  disposeTabs: (path: string) => Promise<void>;
}

export interface WorktreeRemoval {
  state: Ref<RemovalState>;
  check(req: RemovalRequest): Promise<void>;
  unlock(): Promise<void>;
  confirm(opts: { confirmNotOwned?: boolean; deleteBranch?: boolean }): Promise<void>;
  /** Survivors: try again. */
  retry(): Promise<void>;
  /** Survivors: stop them too ("Stop all"). */
  stopAll(): Promise<void>;
  retryTeardown(): Promise<void>;
  /** After a failed teardown, once the user confirmed it twice. */
  removeAnyway(): Promise<void>;
}

const fresh = (): RemovalState => ({
  phase: "idle",
  guard: null,
  survivors: [],
  teardownCode: null,
  tabId: null,
  skippedHooks: false,
  error: null,
  outcome: null,
});

const message = (e: unknown) => String((e as { message?: string })?.message ?? e);

export function createWorktreeRemoval(deps: WorktreeRemovalDeps): WorktreeRemoval {
  const state = ref<RemovalState>(fresh());
  let req: RemovalRequest | null = null;
  let hash: string | null = null;
  let snapshotId: string | null = null;
  let confirmNotOwned = false;
  let deleteBranch = false;

  function patch(p: Partial<RemovalState>) {
    state.value = { ...state.value, ...p };
  }

  async function step(fn: () => Promise<void>) {
    try {
      await fn();
    } catch (e) {
      patch({ phase: "error", error: message(e) });
    }
  }

  async function check(r: RemovalRequest) {
    req = r;
    state.value = { ...fresh(), phase: "checking" };
    deleteBranch = r.deleteBranch;
    await step(async () => {
      const g = await deps.guard(r.cwd, r.path);
      patch({ guard: g, phase: g.untouchable ? "refused" : "confirm" });
    });
  }

  async function unlock() {
    if (!req || state.value.phase !== "refused") return;
    const r = req;
    await step(async () => {
      await deps.unlock(r.cwd, r.path);
      await check(r);
    });
  }

  /** Asks for trust when teardown must run; false on Cancel. */
  async function decideHooks(): Promise<boolean> {
    if (!req || !state.value.guard?.teardown_required) return true;
    const d = await deps.ensureTrusted(req.cwd);
    if (d.choice === "cancel") return false;
    const runs = d.choice === "run" && !!d.status?.hash && !!d.status.hooks?.teardown;
    hash = runs ? d.status!.hash : null;
    patch({ skippedHooks: d.choice === "skip" });
    return true;
  }

  async function confirm(opts: { confirmNotOwned?: boolean; deleteBranch?: boolean }) {
    if (!req || state.value.phase !== "confirm") return;
    confirmNotOwned = !!opts.confirmNotOwned;
    if (opts.deleteBranch !== undefined) deleteBranch = opts.deleteBranch;
    await step(async () => {
      if (!(await decideHooks())) return;
      await prepare(false);
    });
  }

  async function prepare(killForeign: boolean) {
    const r = req!;
    patch({ phase: "stopping", survivors: [] });
    await deps.disposeTabs(r.path);
    const prepared = await deps.prepare(r.cwd, r.path, killForeign);
    if (prepared.survivors.length > 0) {
      patch({ phase: "processes", survivors: prepared.survivors });
      return;
    }
    snapshotId = prepared.snapshot?.id ?? null;
    await teardown();
  }

  async function teardown() {
    const r = req!;
    if (hash) {
      patch({ phase: "teardown", teardownCode: null });
      const { code, tabId } = await deps.runTeardown(r.repoPath, r.cwd, r.path, r.name, hash);
      patch({ teardownCode: code, tabId });
      if (code !== 0) {
        patch({ phase: "teardown-failed" });
        return;
      }
    }
    await finish(false);
  }

  async function finish(removeAnyway: boolean) {
    const r = req!;
    patch({ phase: "removing" });
    const outcome = await deps.remove(r.cwd, r.path, {
      snapshotId,
      teardownCode: state.value.teardownCode,
      teardownSkipped: state.value.skippedHooks,
      removeAnyway,
      deleteBranch,
      confirmNotOwned,
    });
    patch({ phase: "done", outcome });
  }

  async function retry() {
    if (state.value.phase !== "processes") return;
    await step(() => prepare(false));
  }

  async function stopAll() {
    if (state.value.phase !== "processes") return;
    await step(() => prepare(true));
  }

  async function retryTeardown() {
    if (state.value.phase !== "teardown-failed") return;
    await step(async () => {
      // The hooks may have changed since: ask again, like a setup retry.
      if (!(await decideHooks())) {
        patch({ phase: "teardown-failed" });
        return;
      }
      await teardown();
    });
  }

  async function removeAnyway() {
    if (state.value.phase !== "teardown-failed") return;
    await step(() => finish(true));
  }

  return { state, check, unlock, confirm, retry, stopAll, retryTeardown, removeAnyway };
}

interface RemovalHost {
  runTeardown: WorktreeRemovalDeps["runTeardown"];
  disposeTabs: WorktreeRemovalDeps["disposeTabs"];
}

let host: RemovalHost | null = null;

/** App.vue registers how a teardown tab is opened and a worktree's tabs closed. */
export function registerRemovalHost(h: RemovalHost): void {
  host = h;
}

/** A removal wired to the backend and to App.vue's terminal panel. */
export function useWorktreeRemoval(): WorktreeRemoval {
  return createWorktreeRemoval({
    guard: worktreeGuard,
    prepare: worktreeRemovePrepare,
    remove: worktreeRemove,
    unlock: worktreeUnlock,
    ensureTrusted: (cwd) => useWorktreeHookTrust().ensureTrusted(cwd),
    runTeardown: (...args) => {
      if (!host) return Promise.reject(new Error("No removal host registered"));
      return host.runTeardown(...args);
    },
    disposeTabs: (path) => (host ? host.disposeTabs(path) : Promise.resolve()),
  });
}
