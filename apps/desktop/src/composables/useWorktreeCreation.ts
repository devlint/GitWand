/**
 * v3.13 — Creating a worktree, end to end (spec §5): ask for trust in the
 * repository's hooks, create the worktree through the worktree service,
 * then run `setup` in a read-only terminal tab and fetch `url`.
 *
 * Trust is asked **before** anything is created, so Cancel leaves nothing
 * behind. The setup state of each worktree is module-level, keyed by its
 * path, so the AI-task flow (App.vue) and the worktree manager share it.
 * Opening the setup tab needs the terminal panel, which App.vue owns: it
 * registers the runner with `registerSetupRunner`.
 */
import { ref, readonly, type Ref } from "vue";
import {
  snapshotRestoreAsWorktree,
  worktreeCreate,
  worktreeUrl,
  type CreatedWorktree,
  type WorktreeKind,
} from "../utils/backend";
import { useWorktreeHookTrust, type HookTrustDecision } from "./useWorktreeHookTrust";

export type SetupStatus = "running" | "ok" | "failed" | "skipped";

export interface WorktreeSetupState {
  status: SetupStatus;
  /** Setup's exit code; null while running, when skipped, or unknown. */
  code: number | null;
  url: string | null;
  /** The setup tab, to focus it ("Open the log"). */
  tabId: number | null;
  /** The repo key the setup tab is listed under. */
  repoPath: string;
}

export interface CreateRequest {
  name: string;
  base?: string;
  branch?: string;
  path?: string;
  kind: WorktreeKind;
}

/** Opens the setup tab for `path` and resolves with its exit code once it ends. */
export type SetupRunner = (
  repoPath: string,
  cwd: string,
  path: string,
  name: string,
  hash: string,
) => Promise<{ code: number | null; tabId: number }>;

export interface WorktreeCreationDeps {
  ensureTrusted: (cwd: string) => Promise<HookTrustDecision>;
  create: (cwd: string, req: CreateRequest) => Promise<CreatedWorktree>;
  runSetup: SetupRunner;
  url: (cwd: string, path: string, hash: string) => Promise<string | null>;
  /** v3.13 — a removal or merge-back snapshot as a new worktree (spec §9). */
  restore: (cwd: string, id: string, name?: string) => Promise<CreatedWorktree>;
}

export interface WorktreeCreation {
  states: Readonly<Ref<Record<string, WorktreeSetupState>>>;
  /** `null` when the user cancelled at the trust prompt. */
  create(cwd: string, req: CreateRequest): Promise<{ created: CreatedWorktree; decision: HookTrustDecision } | null>;
  /** Like `create`, from a snapshot: trust first, then the restore; `null` on Cancel. */
  restore(cwd: string, id: string, name?: string): Promise<{ created: CreatedWorktree; decision: HookTrustDecision } | null>;
  runSetup(
    repoPath: string,
    cwd: string,
    created: Pick<CreatedWorktree, "path" | "name">,
    decision: HookTrustDecision,
  ): Promise<SetupStatus>;
  /** Asks for trust again (the hooks may have changed), then runs setup. */
  retrySetup(repoPath: string, cwd: string, path: string, name: string): Promise<SetupStatus | null>;
}

export function createWorktreeCreation(deps: WorktreeCreationDeps): WorktreeCreation {
  const states = ref<Record<string, WorktreeSetupState>>({});

  function set(path: string, s: WorktreeSetupState) {
    states.value = { ...states.value, [path]: s };
  }

  async function create(cwd: string, req: CreateRequest) {
    const decision = await deps.ensureTrusted(cwd);
    if (decision.choice === "cancel") return null;
    const created = await deps.create(cwd, req);
    return { created, decision };
  }

  async function restore(cwd: string, id: string, name?: string) {
    const decision = await deps.ensureTrusted(cwd);
    if (decision.choice === "cancel") return null;
    const created = await deps.restore(cwd, id, name);
    return { created, decision };
  }

  async function runSetup(
    repoPath: string,
    cwd: string,
    created: Pick<CreatedWorktree, "path" | "name">,
    decision: HookTrustDecision,
  ): Promise<SetupStatus> {
    const hash = decision.status?.hash ?? null;
    const hooks = decision.status?.hooks;
    if (decision.choice !== "run" || !hash || !hooks?.setup) {
      set(created.path, { status: "skipped", code: null, url: null, tabId: null, repoPath });
      return "skipped";
    }
    set(created.path, { status: "running", code: null, url: null, tabId: null, repoPath });
    let code: number | null = null;
    let tabId: number | null = null;
    try {
      ({ code, tabId } = await deps.runSetup(repoPath, cwd, created.path, created.name, hash));
    } catch (e) {
      console.error("[worktree] setup could not start:", e);
    }
    if (code !== 0) {
      set(created.path, { status: "failed", code, url: null, tabId, repoPath });
      return "failed";
    }
    let url: string | null = null;
    if (hooks.url) {
      try {
        url = await deps.url(cwd, created.path, hash);
      } catch (e) {
        console.error("[worktree] url hook failed:", e);
      }
    }
    set(created.path, { status: "ok", code, url, tabId, repoPath });
    return "ok";
  }

  async function retrySetup(repoPath: string, cwd: string, path: string, name: string) {
    const decision = await deps.ensureTrusted(cwd);
    if (decision.choice === "cancel") return null;
    return runSetup(repoPath, cwd, { path, name }, decision);
  }

  return { states: readonly(states) as Readonly<Ref<Record<string, WorktreeSetupState>>>, create, restore, runSetup, retrySetup };
}

let runner: SetupRunner | null = null;

/** App.vue registers how a setup tab is opened (it owns the terminal panel). */
export function registerSetupRunner(r: SetupRunner): void {
  runner = r;
}

let shared: WorktreeCreation | null = null;

export function useWorktreeCreation(): WorktreeCreation {
  shared ??= createWorktreeCreation({
    ensureTrusted: (cwd) => useWorktreeHookTrust().ensureTrusted(cwd),
    create: (cwd, req) => worktreeCreate(cwd, req),
    runSetup: (...args) => {
      if (!runner) return Promise.reject(new Error("No setup runner registered"));
      return runner(...args);
    },
    url: worktreeUrl,
    restore: snapshotRestoreAsWorktree,
  });
  return shared;
}
