/**
 * v3.14 — Stacked branches: the frontend orchestration (spec §5, §6).
 *
 *   refresh      → merged-parent hints from GitHub (cached 60 s per
 *                  repo+parent, D6), then `stack_status`. A finalized restack
 *                  in the report is handled here (retarget, push offer,
 *                  delete offer), then one more refresh settles the next
 *                  pending record (the backend settles one per call).
 *   bridge       → open PRs whose base is another local branch are offered
 *                  as stack layers (D13: dismissals persisted per repo).
 *   restack flow → fetch (D18) → plan → preview → apply through the host
 *                  (App.vue runs the v3.11 apply with a custom rebase runner).
 *   after        → retarget the child PR (moment 2, GitHub, D19), offer to
 *                  push the moved layers under leases read before the restack
 *                  (D10), offer to delete the merged parent.
 *
 * `createStacks(deps)` is the testable core; `useStacks()` is the
 * module-level singleton bound to the real backend.
 *
 * Only the core (report, context, banner, bridge offers, refresh, stack
 * edits) is in the main chunk. Hints, the restack flow and what follows a
 * restack live in `useStacksFlow.ts`, imported on first use; the `Stacks`
 * methods that need it await that import.
 */
import { computed, ref, type ComputedRef, type Ref } from "vue";
import {
  gitDeleteBranch,
  gitFetch,
  gitPushBranch,
  stackRestackPlan,
  stackSetParent,
  stackStatus,
  stackUnset,
  type FinalizedRestack,
  type MergedParentHint,
  type PendingError,
  type PreviewedRestack,
  type RestackPlan,
  type RestackRefusal,
  type StackLayerStatus,
  type StackReport,
} from "../utils/backend";
import { ghBranchPr, ghPrSetBase } from "../utils/backend-pr";
import type { ApplyOutcome } from "./useApplyFromPreview";
import type { StacksFlow } from "./useStacksFlow";
import { loadSettings, normaliseCwd, saveSettings } from "./useSettings";

export interface StacksDeps {
  status: typeof stackStatus;
  setParent: typeof stackSetParent;
  unset: typeof stackUnset;
  plan: typeof stackRestackPlan;
  fetch: (cwd: string) => Promise<{ success: boolean; message: string }>;
  branchPr: typeof ghBranchPr;
  setPrBase: typeof ghPrSetBase;
  pushBranch: typeof gitPushBranch;
  deleteBranch: (cwd: string, name: string) => Promise<void>;
  /** ForgeName of the active repo; "github" enables hints and the retarget. */
  forge: () => string | null;
  /** settings.defaultBranch */
  trunkSetting: () => string | null;
  dismissed: (cwd: string) => string[];
  dismiss: (cwd: string, branch: string) => void;
  now: () => number;
}

export type RestackPhase =
  | "idle"
  | "fetching"
  | "planning"
  | "refused"
  | "preview"
  | "applying"
  | "residual"
  | "done"
  | "error";

export interface RestackFlow {
  phase: RestackPhase;
  cwd: string | null;
  /** The layer `startRestack` was asked for (the dialog's title before a plan exists). */
  branch: string | null;
  plan: RestackPlan | null;
  refusal: RestackRefusal | null;
  fetchWarning: string | null;
  outcome: ApplyOutcome | null;
  error: string | null;
}

export interface StackBannerModel {
  layer: StackLayerStatus;
  kind: "parent_moved" | "parent_merged" | "parent_behind" | "parent_missing" | "base_lost";
}

export interface AfterRestack {
  /** The repo the restack ran in: show it only while that repo is open. */
  cwd: string;
  finalized: FinalizedRestack;
  retarget: {
    state: "none" | "done" | "failed" | "manual";
    number: number | null;
    base: string | null;
    error: string | null;
  };
  deleteOffer: string | null;
  push: { pushable: { branch: string; lease: string }[]; skipped: PushSkip[]; noLeases: boolean };
}

/**
 * A branch the restack moved that the push offer leaves out, and why:
 * no upstream; its tracking ref is gone; `blocked` by the backend's
 * `push_block` (`detail` holds its words); `not_in_stack`, a non-stack
 * branch `--update-refs` moved too.
 */
export interface PushSkip {
  branch: string;
  reason: "no_upstream" | "gone" | "blocked" | "not_in_stack";
  detail: string | null;
}

export interface BridgeOffer {
  branch: string;
  parent: string;
  pr: number;
}

export interface PushResult {
  branch: string;
  ok: boolean;
  message: string;
}

export interface RestackHost {
  apply(
    cwd: string,
    plan: RestackPlan,
    previewed: PreviewedRestack,
    hints: MergedParentHint[],
    estimated: number,
  ): Promise<ApplyOutcome>;
  /** `run` pushes the layers of `after` (the restack offered), whatever the banner shows by then. */
  offerPush(after: AfterRestack, run: () => Promise<PushResult[]>): void;
  notify(message: string): void;
}

export interface StacksContext {
  cwd: string | null;
  /** ForgeName of the repo (`RemoteInfo.provider`); "github" enables hints and the retarget. */
  forge: string | null;
  currentBranch: string | null;
  localBranches: string[];
  prs: { branch: string; base: string; number: number; state: string }[];
}

export interface Stacks {
  report: Ref<StackReport | null>;
  flow: Ref<RestackFlow>;
  after: Ref<AfterRestack | null>;
  /** What App.vue last passed to `setContext`. */
  context: ComputedRef<StacksContext>;
  /**
   * The report's `pending_errors`: pending restack records that could not be
   * settled, one per top. Their chains have no actionable layer, so the
   * banner offers Unstack of that top, never Preview.
   */
  pendingErrors: ComputedRef<PendingError[]>;
  /** `branch`'s stack holds a stuck record: nothing in it can be restacked. */
  isBlocked(branch: string): boolean;
  banner: ComputedRef<StackBannerModel | null>;
  offers: ComputedRef<Map<string, BridgeOffer>>;
  setContext(ctx: StacksContext): void;
  refresh(cwd: string): Promise<void>;
  layerOf(branch: string): StackLayerStatus | null;
  actionableFor(branch: string): StackLayerStatus | null;
  stackOnCandidates(branch: string): string[];
  stackOn(cwd: string, branch: string, parent: string): Promise<void>;
  unstack(cwd: string, branch: string): Promise<void>;
  acceptBridge(cwd: string, offer: BridgeOffer): Promise<void>;
  dismissBridge(cwd: string, branch: string): void;
  startRestack(cwd: string, branch: string): Promise<void>;
  applyRestack(estimated: number): Promise<void>;
  closeRestack(): void;
  later(): void;
  retryRetarget(): Promise<void>;
  deleteMergedParent(): Promise<void>;
  pushMoved(): Promise<PushResult[]>;
  /** The banner's ✕: forget the after-restack block. */
  dismissAfter(): void;
}

const message = (e: unknown) => String((e as { message?: string })?.message ?? e);

/** The flow of a closed (or never opened) restack dialog. */
export const idleFlow = (): RestackFlow => ({
  phase: "idle",
  cwd: null,
  branch: null,
  plan: null,
  refusal: null,
  fetchWarning: null,
  outcome: null,
  error: null,
});

let host: RestackHost | null = null;

/** App.vue registers how a restack is applied, pushed and announced; null unregisters. */
export function registerRestackHost(h: RestackHost | null): void {
  host = h;
}

/** The registered host, if any (useStackActions sends its errors to `notify`). */
export function restackHost(): RestackHost | null {
  return host;
}

/**
 * What `createStacks` shares with the lazily loaded `useStacksFlow`. The
 * mutable fields live in `state` so both modules see the same values.
 */
export interface StacksCore {
  deps: StacksDeps;
  report: Ref<StackReport | null>;
  flow: Ref<RestackFlow>;
  after: Ref<AfterRestack | null>;
  ctx: Ref<StacksContext>;
  state: {
    /** Hints of the last refresh, reused by the plan and the run. */
    lastHints: MergedParentHint[];
    /** The plan of the last applied restack: its `remote_sha`s are the push leases (D10). */
    lastPlan: { cwd: string; plan: RestackPlan } | null;
    /** Invalidates an in-progress `startRestack` / `applyRestack` on close. */
    flowGen: number;
  };
  layerOf(branch: string): StackLayerStatus | null;
  refresh(cwd: string): Promise<void>;
  stackOn(cwd: string, branch: string, parent: string): Promise<void>;
}

// ─── The lazily loaded flow module (Task 13 review, I-2) ──

let flowModule: typeof import("./useStacksFlow") | null = null;

/** Loads the restack flow module; once loaded, flow calls start synchronously. */
export async function preloadStacksFlow(): Promise<void> {
  flowModule ??= await import("./useStacksFlow");
}

export function createStacks(deps: StacksDeps): Stacks {
  const report = ref<StackReport | null>(null);
  const flow = ref<RestackFlow>(idleFlow());
  const after = ref<AfterRestack | null>(null);
  const ctx = ref<StacksContext>({ cwd: null, forge: null, currentBranch: null, localBranches: [], prs: [] });
  /** The layer `later()` hid, as it was then. */
  const hidden = ref<{ branch: string; state: string; parent_tip: string | null } | null>(null);
  /** Bumped by `dismissBridge`: `deps.dismissed` is not reactive. */
  const dismissRev = ref(0);
  const state: StacksCore["state"] = { lastHints: [], lastPlan: null, flowGen: 0 };
  /** Per cwd, the last finalization handled: an identical one is not handled twice in a row. */
  const lastFinalized = new Map<string, string>();

  const core: StacksCore = { deps, report, flow, after, ctx, state, layerOf, refresh, stackOn };
  let flowApi: StacksFlow | null = null;

  /** Runs `fn` on this store's flow API, loading the module first if needed. */
  function withFlow<T>(fn: (f: StacksFlow) => Promise<T>): Promise<T> {
    if (!flowApi && flowModule) flowApi = flowModule.createStacksFlow(core);
    if (flowApi) return fn(flowApi);
    return preloadStacksFlow().then(() => {
      flowApi ??= flowModule!.createStacksFlow(core);
      return fn(flowApi);
    });
  }

  // ─── Layers ─────────────────────────────────────────────

  function layerOf(branch: string): StackLayerStatus | null {
    return report.value?.layers.find((l) => l.branch === branch) ?? null;
  }

  /** `branch`'s layer, then its parent's layer, and so on down (cycle-safe). */
  function chainDown(branch: string): StackLayerStatus[] {
    const out: StackLayerStatus[] = [];
    const seen = new Set<string>();
    let l = layerOf(branch);
    while (l && !seen.has(l.branch)) {
      seen.add(l.branch);
      out.push(l);
      l = layerOf(l.parent);
    }
    return out;
  }

  /** Branches below `branch` through stack parents (the last one may not be a layer). */
  function ancestorsOf(branch: string): Set<string> {
    const out = new Set<string>();
    for (const l of chainDown(branch)) out.add(l.parent);
    return out;
  }

  function hasStackedChild(branch: string, except?: string): boolean {
    return (report.value?.layers ?? []).some((l) => l.parent === branch && l.branch !== except);
  }

  function actionableFor(branch: string): StackLayerStatus | null {
    return chainDown(branch).find((l) => l.actionable) ?? null;
  }

  function stackOnCandidates(branch: string): string[] {
    const trunk = report.value?.trunk ?? deps.trunkSetting();
    return ctx.value.localBranches.filter(
      (b) => b !== branch && b !== trunk && !hasStackedChild(b, branch) && !ancestorsOf(b).has(branch),
    );
  }

  const pendingErrors = computed<PendingError[]>(() => report.value?.pending_errors ?? []);

  function isBlocked(branch: string): boolean {
    const top = layerOf(branch)?.top;
    return !!top && pendingErrors.value.some((e) => e.top === top);
  }

  const banner = computed<StackBannerModel | null>(() => {
    const current = ctx.value.currentBranch;
    if (!current) return null;
    let lowest: StackLayerStatus | null = null;
    for (const l of chainDown(current)) if (l.state !== "up_to_date") lowest = l;
    if (!lowest) return null;
    const h = hidden.value;
    if (h && h.branch === lowest.branch && h.state === lowest.state && h.parent_tip === lowest.parent_tip) {
      return null;
    }
    const kind: StackBannerModel["kind"] =
      lowest.state === "out_of_date"
        ? lowest.parent_behind_upstream > 0
          ? "parent_behind"
          : "parent_moved"
        : lowest.state === "up_to_date"
          ? "parent_moved" // unreachable: filtered above
          : lowest.state;
    return { layer: lowest, kind };
  });

  function later(): void {
    const b = banner.value;
    if (b) hidden.value = { branch: b.layer.branch, state: b.layer.state, parent_tip: b.layer.parent_tip };
  }

  const offers = computed(() => {
    void dismissRev.value;
    const out = new Map<string, BridgeOffer>();
    const r = report.value;
    const cwd = ctx.value.cwd;
    if (!r || !r.trunk || !cwd) return out;
    const local = new Set(ctx.value.localBranches);
    const dismissed = new Set(deps.dismissed(cwd));
    // One offer per base (accepting it takes the base): the lowest PR number.
    const bases = new Set<string>();
    const prs = [...ctx.value.prs].sort((a, b) => a.number - b.number);
    for (const pr of prs) {
      if (pr.state.toLowerCase() !== "open") continue;
      if (out.has(pr.branch) || bases.has(pr.base)) continue;
      if (!local.has(pr.branch) || !local.has(pr.base)) continue;
      if (pr.base === r.trunk || pr.base === pr.branch) continue;
      if (layerOf(pr.branch)) continue;
      if (hasStackedChild(pr.base)) continue;
      if (ancestorsOf(pr.base).has(pr.branch)) continue;
      if (dismissed.has(pr.branch)) continue;
      out.set(pr.branch, { branch: pr.branch, parent: pr.base, pr: pr.number });
      bases.add(pr.base);
    }
    return out;
  });

  function setContext(next: StacksContext): void {
    if (next.cwd !== ctx.value.cwd) {
      report.value = null;
      hidden.value = null;
      state.lastHints = [];
    }
    ctx.value = next;
  }

  // ─── Refresh ────────────────────────────────────────────

  /** Merged-parent hints (D6): GitHub only, so other forges never load the flow module. */
  function hintsFor(cwd: string, parents: string[]): Promise<MergedParentHint[]> {
    if (deps.forge() !== "github" || parents.length === 0) return Promise.resolve([]);
    return withFlow((f) => f.hintsFor(cwd, parents));
  }

  /** Distinct stack parents other than the trunk. */
  function parentsIn(r: StackReport | null): string[] {
    if (!r) return [];
    return [...new Set(r.layers.map((l) => l.parent))].filter((p) => p !== r.trunk);
  }

  async function doRefresh(cwd: string): Promise<void> {
    const prev = ctx.value.cwd === cwd ? report.value : null;
    const known = parentsIn(prev);
    let hints = await hintsFor(cwd, known);
    let r = await deps.status(cwd, deps.trunkSetting(), hints);
    // First sight of some parents (repo just opened, new layer): look them
    // up now rather than one refresh late, unless the report settled a
    // restack — the refresh scheduled for it carries the hints.
    if (!r.finalized) {
      const fresh = parentsIn(r).filter((p) => !known.includes(p));
      const extra = await hintsFor(cwd, fresh);
      if (extra.length) {
        hints = [...hints, ...extra];
        r = await deps.status(cwd, deps.trunkSetting(), hints);
      }
    }
    // Repo switched meanwhile: the report is not shown, but a finalization
    // in it is handled all the same (the backend already cleared its record).
    if (ctx.value.cwd === null || ctx.value.cwd === cwd) {
      report.value = r;
      state.lastHints = hints;
    }
    if (!r.finalized) {
      lastFinalized.delete(cwd);
      return;
    }
    const f = r.finalized;
    const key = JSON.stringify([f.moment, f.bottom, f.moved]);
    // The same finalization twice in a row would be a backend that failed to
    // clear its record: do not retarget or offer again, and stop the chain.
    if (lastFinalized.get(cwd) === key) return;
    lastFinalized.set(cwd, key);
    await withFlow((fl) => fl.onFinalized(cwd, f, r.trunk));
    // The backend settles one record per call: look for the next one.
    void refresh(cwd);
  }

  let inFlight: Promise<void> | null = null;
  let queued: { cwd: string; done: Promise<void> } | null = null;

  /** One refresh in flight, at most one queued (the latest cwd wins). Never rejects. */
  function refresh(cwd: string): Promise<void> {
    if (inFlight) {
      if (queued) {
        queued.cwd = cwd;
        return queued.done;
      }
      const q = { cwd, done: Promise.resolve() };
      q.done = inFlight.then(() => {
        queued = null;
        return refresh(q.cwd);
      });
      queued = q;
      return q.done;
    }
    const run = doRefresh(cwd)
      .catch((e) => {
        console.warn("[stacks] refresh failed:", message(e));
      })
      .finally(() => {
        inFlight = null;
      });
    inFlight = run;
    return run;
  }

  // ─── Small synchronous actions ──────────────────────────

  function dismissAfter(): void {
    after.value = null;
  }

  function closeRestack(): void {
    state.flowGen++;
    flow.value = idleFlow();
  }

  // ─── Stack edits ────────────────────────────────────────

  async function stackOn(cwd: string, branch: string, parent: string): Promise<void> {
    await deps.setParent(cwd, branch, parent, deps.trunkSetting());
    await refresh(cwd);
  }

  async function unstack(cwd: string, branch: string): Promise<void> {
    await deps.unset(cwd, branch);
    await refresh(cwd);
  }

  function dismissBridge(cwd: string, branch: string): void {
    deps.dismiss(cwd, branch);
    dismissRev.value++;
  }

  return {
    report,
    flow,
    after,
    context: computed(() => ctx.value),
    pendingErrors,
    isBlocked,
    banner,
    offers,
    setContext,
    refresh,
    layerOf,
    actionableFor,
    stackOnCandidates,
    stackOn,
    unstack,
    acceptBridge: (cwd, offer) => withFlow((f) => f.acceptBridge(cwd, offer)),
    dismissBridge,
    startRestack: (cwd, branch) => withFlow((f) => f.startRestack(cwd, branch)),
    applyRestack: (estimated) => withFlow((f) => f.applyRestack(estimated)),
    closeRestack,
    later,
    retryRetarget: () => withFlow((f) => f.retryRetarget()),
    deleteMergedParent: () => withFlow((f) => f.deleteMergedParent()),
    pushMoved: () => withFlow((f) => f.pushMoved()),
    dismissAfter,
  };
}

// ─── Singleton bound to the real backend ──────────────────

let singleton: Stacks | null = null;

/** Tests only: install a store built with `createStacks` fakes (null resets). */
export function __setStacksForTest(s: Stacks | null): void {
  singleton = s;
}

export function useStacks(): Stacks {
  if (singleton) return singleton;
  let ctxForge: string | null = null;
  const s = createStacks({
    status: stackStatus,
    setParent: stackSetParent,
    unset: stackUnset,
    plan: stackRestackPlan,
    fetch: async (cwd) => {
      const r = await gitFetch(cwd);
      return { success: r.success, message: r.message };
    },
    branchPr: ghBranchPr,
    setPrBase: ghPrSetBase,
    pushBranch: gitPushBranch,
    deleteBranch: (cwd, name) => gitDeleteBranch(cwd, name, true),
    // Supplied by App.vue through setContext; unknown → treated as not GitHub.
    forge: () => ctxForge,
    trunkSetting: () => loadSettings().defaultBranch || null,
    dismissed: (cwd) => loadSettings().stackBridgeDismissals?.[normaliseCwd(cwd)] ?? [],
    dismiss: (cwd, branch) => {
      const settings = loadSettings();
      const key = normaliseCwd(cwd);
      const list = settings.stackBridgeDismissals?.[key] ?? [];
      if (list.includes(branch)) return;
      settings.stackBridgeDismissals = { ...settings.stackBridgeDismissals, [key]: [...list, branch] };
      saveSettings(settings);
    },
    now: () => Date.now(),
  });
  const setContext = s.setContext;
  s.setContext = (ctx) => {
    ctxForge = ctx.forge;
    setContext(ctx);
  };
  singleton = s;
  return s;
}
