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
  type PreviewedRestack,
  type RestackPlan,
  type RestackRefusal,
  type StackLayerStatus,
  type StackReport,
} from "../utils/backend";
import { ghBranchPr, ghPrSetBase } from "../utils/backend-pr";
import type { ApplyOutcome } from "./useApplyFromPreview";
import { loadSettings, normaliseCwd, saveSettings } from "./useSettings";
import { usePrCache } from "./usePrCache";

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
  finalized: FinalizedRestack;
  retarget: {
    state: "none" | "done" | "failed" | "manual";
    number: number | null;
    base: string | null;
    error: string | null;
  };
  deleteOffer: string | null;
  push: { pushable: { branch: string; lease: string }[]; skipped: string[]; noLeases: boolean };
}

export interface BridgeOffer {
  branch: string;
  parent: string;
  pr: number;
}

export interface RestackHost {
  apply(
    cwd: string,
    plan: RestackPlan,
    previewed: PreviewedRestack,
    hints: MergedParentHint[],
    estimated: number,
  ): Promise<ApplyOutcome>;
  offerPush(after: AfterRestack, run: () => Promise<void>): void;
  notify(message: string): void;
}

export interface StacksContext {
  cwd: string | null;
  currentBranch: string | null;
  localBranches: string[];
  prs: { branch: string; base: string; number: number; state: string }[];
}

export interface Stacks {
  report: Ref<StackReport | null>;
  flow: Ref<RestackFlow>;
  after: Ref<AfterRestack | null>;
  /**
   * The report's `pending_error`: a pending restack record that could not be
   * settled. Its chain has no actionable layer, so the banner offers Unstack,
   * never Preview.
   */
  pendingError: ComputedRef<string | null>;
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
  pushMoved(): Promise<{ branch: string; ok: boolean; message: string }[]>;
}

/** How long a merged-PR lookup for one repo+parent is reused (D6). */
const HINT_TTL_MS = 60_000;
const STALE_PREVIEW = "stale preview:";

const message = (e: unknown) => String((e as { message?: string })?.message ?? e);

const idle = (): RestackFlow => ({
  phase: "idle",
  cwd: null,
  plan: null,
  refusal: null,
  fetchWarning: null,
  outcome: null,
  error: null,
});

const synthesizedRefusal = (code: "fetch_failed" | "stale_preview", msg: string): RestackRefusal => ({
  code,
  message: msg,
  branch: null,
  path: null,
});

let host: RestackHost | null = null;

/** App.vue registers how a restack is applied, pushed and announced; null unregisters. */
export function registerRestackHost(h: RestackHost | null): void {
  host = h;
}

export function createStacks(deps: StacksDeps): Stacks {
  const report = ref<StackReport | null>(null);
  const flow = ref<RestackFlow>(idle());
  const after = ref<AfterRestack | null>(null);
  const ctx = ref<StacksContext>({ cwd: null, currentBranch: null, localBranches: [], prs: [] });
  /** The layer `later()` hid, as it was then. */
  const hidden = ref<{ branch: string; state: string; parent_tip: string | null } | null>(null);
  /** Bumped by `dismissBridge`: `deps.dismissed` is not reactive. */
  const dismissRev = ref(0);

  /** `cwd|parent` → the lookup's result (null: no merged PR, or it failed). */
  const hintCache = new Map<string, { at: number; hint: MergedParentHint | null }>();
  /** Hints of the last refresh, reused by the plan and the run. */
  let lastHints: MergedParentHint[] = [];
  /** The plan of the last applied restack: its `remote_sha`s are the push leases (D10). */
  let lastPlan: { cwd: string; plan: RestackPlan } | null = null;
  let afterCwd: string | null = null;
  /** Invalidates an in-progress `startRestack` / `applyRestack` on close. */
  let flowGen = 0;

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

  const pendingError = computed(() => report.value?.pending_error ?? null);

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
    for (const pr of ctx.value.prs) {
      if (pr.state.toLowerCase() !== "open") continue;
      if (out.has(pr.branch)) continue;
      if (!local.has(pr.branch) || !local.has(pr.base)) continue;
      if (pr.base === r.trunk || pr.base === pr.branch) continue;
      if (layerOf(pr.branch)) continue;
      if (hasStackedChild(pr.base)) continue;
      if (ancestorsOf(pr.base).has(pr.branch)) continue;
      if (dismissed.has(pr.branch)) continue;
      out.set(pr.branch, { branch: pr.branch, parent: pr.base, pr: pr.number });
    }
    return out;
  });

  function setContext(next: StacksContext): void {
    if (next.cwd !== ctx.value.cwd) {
      report.value = null;
      hidden.value = null;
      lastHints = [];
    }
    ctx.value = next;
  }

  // ─── Refresh ────────────────────────────────────────────

  async function hintsFor(cwd: string, parents: string[]): Promise<MergedParentHint[]> {
    if (deps.forge() !== "github") return [];
    const out: MergedParentHint[] = [];
    for (const parent of parents) {
      const key = `${cwd}|${parent}`;
      const cached = hintCache.get(key);
      let hint: MergedParentHint | null;
      if (cached && deps.now() - cached.at < HINT_TTL_MS) {
        hint = cached.hint;
      } else {
        try {
          const pr = await deps.branchPr(cwd, parent, "merged");
          hint = pr ? { branch: parent, number: pr.number, head_ref_oid: pr.head_ref_oid } : null;
        } catch {
          hint = null; // a hint, never a requirement: git's own signals still apply
        }
        hintCache.set(key, { at: deps.now(), hint });
      }
      if (hint) out.push(hint);
    }
    return out;
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
      const extra = fresh.length ? await hintsFor(cwd, fresh) : [];
      if (extra.length) {
        hints = [...hints, ...extra];
        r = await deps.status(cwd, deps.trunkSetting(), hints);
      }
    }
    if (ctx.value.cwd !== null && ctx.value.cwd !== cwd) return; // repo switched meanwhile
    report.value = r;
    lastHints = hints;
    if (r.finalized) {
      await onFinalized(cwd, r.finalized, r.trunk);
      // The backend settles one record per call: look for the next one.
      void refresh(cwd);
    }
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

  // ─── After a restack ────────────────────────────────────

  function pushOffer(cwd: string, fin: FinalizedRestack): AfterRestack["push"] {
    const mem = lastPlan;
    if (!mem || mem.cwd !== cwd || mem.plan.bottom !== fin.bottom) {
      return { pushable: [], skipped: [], noLeases: true };
    }
    lastPlan = null;
    const pushable: { branch: string; lease: string }[] = [];
    const skipped: string[] = [];
    for (const b of fin.moved) {
      const lease = mem.plan.moving.find((m) => m.branch === b)?.remote_sha ?? null;
      if (lease) pushable.push({ branch: b, lease });
      else skipped.push(b);
    }
    return { pushable, skipped, noLeases: false };
  }

  async function retarget(cwd: string, fin: FinalizedRestack, trunk: string | null): Promise<AfterRestack["retarget"]> {
    if (fin.moment !== "parent_merged") return { state: "none", number: null, base: null, error: null };
    if (deps.forge() !== "github") return { state: "manual", number: null, base: null, error: null };
    const base = fin.new_parent ?? trunk;
    let number: number | null = null;
    try {
      const pr = await deps.branchPr(cwd, fin.bottom, "open");
      if (!pr) return { state: "none", number: null, base: null, error: null };
      number = pr.number;
      if (!base) throw new Error(`no base to retarget #${pr.number} onto`);
      await deps.setPrBase(cwd, pr.number, base);
      return { state: "done", number, base, error: null };
    } catch (e) {
      return { state: "failed", number, base, error: message(e) };
    }
  }

  async function onFinalized(cwd: string, fin: FinalizedRestack, trunk: string | null): Promise<void> {
    const push = pushOffer(cwd, fin);
    // D19: the retarget comes first, then the push offer.
    const rt = await retarget(cwd, fin, trunk);
    afterCwd = cwd;
    after.value = { finalized: fin, retarget: rt, deleteOffer: fin.merged_parent, push };
    if (push.pushable.length > 0 || push.noLeases) {
      host?.offerPush(after.value, async () => {
        await pushMoved();
      });
    }
  }

  async function retryRetarget(): Promise<void> {
    const a = after.value;
    if (!a || !afterCwd || a.retarget.state !== "failed") return;
    const rt = await retarget(afterCwd, a.finalized, report.value?.trunk ?? deps.trunkSetting());
    if (after.value === a) after.value = { ...a, retarget: rt };
  }

  /** Force-deletes the merged parent (`-D`: it was squash-merged, git cannot tell). Throws on failure. */
  async function deleteMergedParent(): Promise<void> {
    const a = after.value;
    const cwd = afterCwd;
    if (!a?.deleteOffer || !cwd) return;
    await deps.deleteBranch(cwd, a.deleteOffer);
    if (after.value === a) after.value = { ...a, deleteOffer: null };
    await refresh(cwd);
  }

  async function pushMoved(): Promise<{ branch: string; ok: boolean; message: string }[]> {
    const a = after.value;
    const cwd = afterCwd;
    if (!a || !cwd) return [];
    const results: { branch: string; ok: boolean; message: string }[] = [];
    for (const { branch, lease } of a.push.pushable) {
      try {
        const r = await deps.pushBranch(cwd, branch, lease);
        results.push({ branch, ok: r.success, message: r.message });
      } catch (e) {
        results.push({ branch, ok: false, message: message(e) });
      }
    }
    return results;
  }

  // ─── Restack flow ───────────────────────────────────────

  async function startRestack(cwd: string, branch: string): Promise<void> {
    const gen = ++flowGen;
    flow.value = { ...idle(), phase: "fetching", cwd };
    const merged = layerOf(branch)?.state === "parent_merged";
    let fetched: { success: boolean; message: string };
    try {
      fetched = await deps.fetch(cwd);
    } catch (e) {
      fetched = { success: false, message: message(e) };
    }
    if (gen !== flowGen) return;
    if (!fetched.success) {
      // D18: moment 2 restacks onto the remote trunk, which must be fresh.
      if (merged) {
        flow.value = { ...flow.value, phase: "refused", refusal: synthesizedRefusal("fetch_failed", fetched.message) };
        return;
      }
      flow.value = { ...flow.value, fetchWarning: fetched.message };
    }
    flow.value = { ...flow.value, phase: "planning" };
    try {
      const plan = await deps.plan(cwd, branch, deps.trunkSetting(), lastHints);
      if (gen !== flowGen) return;
      flow.value = plan.refusal
        ? { ...flow.value, phase: "refused", plan, refusal: plan.refusal }
        : { ...flow.value, phase: "preview", plan };
    } catch (e) {
      // "restack X first", "X is merged: restack Y instead", a record still
      // being finalized, a missing parent / lost base: plain errors.
      if (gen !== flowGen) return;
      flow.value = { ...flow.value, phase: "error", error: message(e) };
    }
  }

  async function applyRestack(estimated: number): Promise<void> {
    const f = flow.value;
    if (f.phase !== "preview" || !f.plan || !f.cwd) return;
    const { cwd, plan } = f;
    if (!host) {
      flow.value = { ...f, phase: "error", error: "No restack host registered: the restack cannot be applied." };
      return;
    }
    const gen = flowGen;
    const previewed: PreviewedRestack = {
      onto_sha: plan.onto_sha,
      upstream_sha: plan.upstream_sha,
      top_sha: plan.top_sha,
      moving: plan.moving.map((m) => m.branch),
    };
    // Kept before the run: the finalization may land in any later refresh.
    lastPlan = { cwd, plan };
    flow.value = { ...f, phase: "applying" };
    let outcome: ApplyOutcome;
    try {
      outcome = await host.apply(cwd, plan, previewed, lastHints, estimated);
    } catch (e) {
      if (gen === flowGen) flow.value = { ...flow.value, phase: "error", error: message(e) };
      return;
    }
    if (gen !== flowGen) return;
    switch (outcome.stoppedReason) {
      case "clean":
        flow.value = { ...flow.value, phase: "done", outcome };
        await refresh(cwd);
        return;
      case "op-failed": {
        const err = (outcome.operationError ?? "").trim();
        flow.value = err.startsWith(STALE_PREVIEW)
          ? { ...flow.value, phase: "refused", outcome, refusal: synthesizedRefusal("stale_preview", err) }
          : { ...flow.value, phase: "error", outcome, error: err || "restack failed" };
        return;
      }
      default:
        // residual / loop-bound / resolve-failed: the rebase banner takes over.
        flow.value = { ...flow.value, phase: "residual", outcome };
    }
  }

  function closeRestack(): void {
    flowGen++;
    flow.value = idle();
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

  function acceptBridge(cwd: string, offer: BridgeOffer): Promise<void> {
    return stackOn(cwd, offer.branch, offer.parent);
  }

  function dismissBridge(cwd: string, branch: string): void {
    deps.dismiss(cwd, branch);
    dismissRev.value++;
  }

  return {
    report,
    flow,
    after,
    pendingError,
    banner,
    offers,
    setContext,
    refresh,
    layerOf,
    actionableFor,
    stackOnCandidates,
    stackOn,
    unstack,
    acceptBridge,
    dismissBridge,
    startRestack,
    applyRestack,
    closeRestack,
    later,
    retryRetarget,
    deleteMergedParent,
    pushMoved,
  };
}

// ─── Singleton bound to the real backend ──────────────────

let singleton: Stacks | null = null;

export function useStacks(): Stacks {
  if (singleton) return singleton;
  let ctxCwd: string | null = null;
  const prCache = usePrCache();
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
    // The PR panel caches the repo's remote (with its Rust-detected forge).
    // Unknown → treated as not GitHub: no hints, retarget left to the user.
    forge: () => (ctxCwd ? (prCache.getRemote(ctxCwd)?.remote?.provider ?? null) : null),
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
    ctxCwd = ctx.cwd;
    setContext(ctx);
  };
  singleton = s;
  return s;
}
