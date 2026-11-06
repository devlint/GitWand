/**
 * v3.13 — Bringing a task's work back (spec §6.1), in three modes:
 *
 *   merge  (default) `git merge --no-ff` of the task into the target, in the
 *          main checkout: the agent's commits are kept;
 *   rebase `git rebase <target>` in the task worktree, then the target
 *          fast-forwards: linear history;
 *   squash the task's changes staged on the target, uncommitted.
 *
 *   open    → check (read-only): target, refusals, "switch the main
 *             checkout" when it is clean;
 *   start   → prepare: stop the task's processes, commit its outstanding
 *             work, snapshot both sides;
 *   preview → the dialog runs the v3.11 predictor on `previewSpec`;
 *   apply   → the host focuses the checkout and runs the v3.11 apply there;
 *             what the engine leaves stops in `residual`, never aborted;
 *   resume  → once the user finished by hand: the fast-forward (rebase), or
 *             a check that the main checkout is done (merge, squash).
 *
 * Cleanup is offered afterwards, never run (spec §6.1 step 8). One instance
 * per dialog; App.vue registers the host (focus a checkout, run the apply).
 */
import { computed, ref, type ComputedRef, type Ref } from "vue";
import {
  gitSwitchBranch,
  worktreeMergeBackCheck,
  worktreeMergeBackFastForward,
  worktreeMergeBackPrepare,
  type MergeBackCheck,
  type MergeBackPrepared,
  type ProcessInfo,
} from "../utils/backend";
import type { ApplyOutcome } from "./useApplyFromPreview";
import type { PreviewOperation } from "./useMergePreview";

export type MergeBackMode = "merge" | "rebase" | "squash";

export type MergeBackPhase =
  | "idle"
  | "checking"
  | "choose"
  | "preparing"
  | "processes"
  | "preview"
  | "applying"
  | "residual"
  | "finishing"
  | "done"
  | "error";

export interface MergeBackRequest {
  /** Any checkout of the repo. */
  cwd: string;
  /** The task worktree. */
  path: string;
}

export interface MergeBackApply {
  /** The checkout the operation runs in, to focus first. */
  checkout: string;
  operation: PreviewOperation;
  ref: string;
  estimated: number;
  mode: MergeBackMode;
  target: string;
  path: string;
}

export interface MergeBackState {
  phase: MergeBackPhase;
  mode: MergeBackMode;
  check: MergeBackCheck | null;
  survivors: ProcessInfo[];
  outcome: ApplyOutcome | null;
  committedWip: boolean;
  error: string | null;
}

export interface MergeBackDeps {
  check: (cwd: string, path: string, target?: string | null) => Promise<MergeBackCheck>;
  switchBranch: (checkout: string, branch: string) => Promise<void>;
  prepare: (cwd: string, path: string, target: string) => Promise<MergeBackPrepared>;
  apply: (a: MergeBackApply) => Promise<ApplyOutcome>;
  fastForward: (cwd: string, path: string, target: string) => Promise<{ conflicts: boolean }>;
}

export interface WorktreeMergeBack {
  state: Ref<MergeBackState>;
  /** The main checkout is on another branch and clean: it can be switched. */
  canSwitch: ComputedRef<boolean>;
  /** What the predictor runs, in which checkout. */
  previewSpec: ComputedRef<{ cwd: string; ref: string; operation: PreviewOperation } | null>;
  /** Set once done: what the removal dialog should pre-tick. */
  cleanup: ComputedRef<{ deleteBranch: boolean } | null>;
  open(req: MergeBackRequest): Promise<void>;
  setMode(mode: MergeBackMode): void;
  setTarget(target: string): Promise<void>;
  switchMain(): Promise<void>;
  start(): Promise<void>;
  apply(estimated: number): Promise<void>;
  resume(): Promise<void>;
}

const fresh = (): MergeBackState => ({
  phase: "idle",
  mode: "merge",
  check: null,
  survivors: [],
  outcome: null,
  committedWip: false,
  error: null,
});

const message = (e: unknown) => String((e as { message?: string })?.message ?? e);

export function createWorktreeMergeBack(deps: MergeBackDeps): WorktreeMergeBack {
  const state = ref<MergeBackState>(fresh());
  let req: MergeBackRequest | null = null;
  let inFlight = false;

  function patch(p: Partial<MergeBackState>) {
    state.value = { ...state.value, ...p };
  }

  /** One user action at a time; a failure lands on `error`. */
  async function step(fn: () => Promise<void>) {
    if (inFlight) return;
    inFlight = true;
    try {
      await fn();
    } catch (e) {
      patch({ phase: "error", error: message(e) });
    } finally {
      inFlight = false;
    }
  }

  async function recheck(target?: string | null) {
    const r = req!;
    patch({ phase: "checking", error: null });
    const c = await deps.check(r.cwd, r.path, target ?? null);
    patch({ check: c, phase: "choose" });
  }

  const canSwitch = computed(() => {
    const c = state.value.check;
    return c?.refusal?.code === "wrong-branch" && c.main_clean;
  });

  const previewSpec = computed(() => {
    const c = state.value.check;
    if (!c) return null;
    return state.value.mode === "rebase"
      ? { cwd: c.task_path, ref: c.target, operation: "rebase" as const }
      : { cwd: c.main_path, ref: c.task_branch, operation: "merge" as const };
  });

  const cleanup = computed(() =>
    state.value.phase === "done" ? { deleteBranch: state.value.mode !== "squash" } : null,
  );

  async function open(r: MergeBackRequest) {
    req = r;
    state.value = { ...fresh(), phase: "checking" };
    await step(() => recheck(null));
  }

  function setMode(mode: MergeBackMode) {
    if (state.value.phase === "choose") patch({ mode });
  }

  async function setTarget(target: string) {
    if (state.value.phase !== "choose") return;
    await step(() => recheck(target));
  }

  async function switchMain() {
    const c = state.value.check;
    if (!canSwitch.value || !c) return;
    await step(async () => {
      await deps.switchBranch(c.main_path, c.target);
      await recheck(c.target);
    });
  }

  async function start() {
    const c = state.value.check;
    if (!req || !c || c.refusal || !["choose", "processes"].includes(state.value.phase)) return;
    const r = req;
    await step(async () => {
      patch({ phase: "preparing", survivors: [] });
      const p = await deps.prepare(r.cwd, r.path, c.target);
      if (p.survivors.length > 0) {
        patch({ phase: "processes", survivors: p.survivors });
        return;
      }
      patch({ phase: "preview", check: p.check, committedWip: p.committed_wip });
    });
  }

  async function finish() {
    const c = state.value.check!;
    if (state.value.mode === "rebase") {
      patch({ phase: "finishing" });
      await deps.fastForward(req!.cwd, req!.path, c.target);
    }
    patch({ phase: "done", error: null });
  }

  async function apply(estimated: number) {
    const c = state.value.check;
    const spec = previewSpec.value;
    if (!req || !c || !spec || state.value.phase !== "preview") return;
    const r = req;
    await step(async () => {
      patch({ phase: "applying" });
      const out = await deps.apply({
        checkout: spec.cwd,
        operation: spec.operation,
        ref: spec.ref,
        estimated,
        mode: state.value.mode,
        target: c.target,
        path: r.path,
      });
      patch({ outcome: out });
      if (out.stoppedReason === "op-failed") {
        patch({ phase: "error", error: out.operationError ?? "The operation failed." });
        return;
      }
      if (out.stoppedReason !== "clean") {
        patch({ phase: "residual" });
        return;
      }
      await finish();
    });
  }

  async function resume() {
    if (!req || state.value.phase !== "residual") return;
    const r = req;
    await step(async () => {
      try {
        if (state.value.mode === "rebase") {
          await finish();
          return;
        }
        const c = await deps.check(r.cwd, r.path, state.value.check?.target);
        if (c.refusal?.code === "main-in-progress") {
          patch({ phase: "residual", error: c.refusal.message });
          return;
        }
        patch({ phase: "done", error: null });
      } catch (e) {
        // Still the user's to finish: stay where they can try again.
        patch({ phase: "residual", error: message(e) });
      }
    });
  }

  return { state, canSwitch, previewSpec, cleanup, open, setMode, setTarget, switchMain, start, apply, resume };
}

interface MergeBackHost {
  apply: MergeBackDeps["apply"];
  /** Closes the task's terminal tabs before its processes are stopped. */
  disposeTabs?: (path: string) => Promise<void>;
}

let host: MergeBackHost | null = null;

/** App.vue registers how an apply runs (focus the checkout, then the v3.11 apply). */
export function registerMergeBackHost(h: MergeBackHost): void {
  host = h;
}

export function useWorktreeMergeBack(): WorktreeMergeBack {
  return createWorktreeMergeBack({
    check: worktreeMergeBackCheck,
    switchBranch: async (checkout, branch) => {
      await gitSwitchBranch(checkout, branch);
    },
    prepare: async (cwd, path, target) => {
      await host?.disposeTabs?.(path);
      return worktreeMergeBackPrepare(cwd, path, target);
    },
    apply: (a) => {
      if (!host) return Promise.reject(new Error("No merge-back host registered"));
      return host.apply(a);
    },
    fastForward: worktreeMergeBackFastForward,
  });
}
