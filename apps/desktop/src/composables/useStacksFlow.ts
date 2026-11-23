/**
 * v3.14 — Stacked branches: the parts of `useStacks` that only run once a
 * stack needs attention, loaded lazily so they stay out of the main chunk
 * (Task 13 review, I-2): merged-parent hints, the restack flow (fetch → plan
 * → preview → apply), and what follows a finalized restack (retarget, push
 * offer, delete offer).
 *
 * `createStacksFlow(core)` works on the state `createStacks` owns; callers
 * keep using the `Stacks` API, whose methods await this module.
 */
import type { FinalizedRestack, MergedParentHint, PreviewedRestack, RestackRefusal } from "../utils/backend";
import type { ApplyOutcome } from "./useApplyFromPreview";
import {
  idleFlow,
  restackHost,
  type AfterRestack,
  type BridgeOffer,
  type PushResult,
  type PushSkip,
  type StacksCore,
} from "./useStacks";

/** How long a merged-PR lookup for one repo+parent is reused (D6). */
const HINT_TTL_MS = 60_000;
const STALE_PREVIEW = "stale preview:";

const message = (e: unknown) => String((e as { message?: string })?.message ?? e);

const synthesizedRefusal = (code: "fetch_failed" | "stale_preview", msg: string): RestackRefusal => ({
  code,
  message: msg,
  branch: null,
  path: null,
  // The fetch error goes into the localized text (M-3).
  detail: code === "fetch_failed" ? msg : null,
});

export type StacksFlow = ReturnType<typeof createStacksFlow>;

export function createStacksFlow(c: StacksCore) {
  const { deps, flow, after, state } = c;
  /** `cwd|parent` → the lookup's result (null: no merged PR, or it failed). */
  const hintCache = new Map<string, { at: number; hint: MergedParentHint | null }>();

  // ─── Hints ──────────────────────────────────────────────

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
          hint = pr
            ? {
                branch: parent,
                number: pr.number,
                head_ref_oid: pr.head_ref_oid,
                merge_commit_oid: pr.merge_commit_oid ?? null,
              }
            : null;
        } catch {
          hint = null; // a hint, never a requirement: git's own signals still apply
        }
        hintCache.set(key, { at: deps.now(), hint });
      }
      if (hint) out.push(hint);
    }
    return out;
  }

  // ─── After a restack ────────────────────────────────────

  function pushOffer(cwd: string, fin: FinalizedRestack): AfterRestack["push"] {
    const mem = state.lastPlan;
    if (!mem || mem.cwd !== cwd || mem.plan.bottom !== fin.bottom) {
      return { pushable: [], skipped: [], noLeases: true };
    }
    state.lastPlan = null;
    const pushable: { branch: string; lease: string }[] = [];
    const skipped: PushSkip[] = [];
    const skip = (branch: string, reason: PushSkip["reason"], detail: string | null = null) =>
      skipped.push({ branch, reason, detail });
    for (const b of fin.moved) {
      const m = mem.plan.moving.find((x) => x.branch === b);
      if (m?.push_block) skip(b, "blocked", m.push_block);
      else if (m?.remote_sha) pushable.push({ branch: b, lease: m.remote_sha });
      else if (m?.upstream) skip(b, "gone");
      else skip(b, "no_upstream");
    }
    // Branches outside the stack that `--update-refs` moved: never offered.
    for (const m of mem.plan.moving) if (!m.in_stack) skip(m.branch, "not_in_stack");
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
    // I-1, M-1: the backend offers the delete only when nothing would be lost.
    after.value = { cwd, trunk, finalized: fin, retarget: rt, deleteOffer: fin.delete_offer, push };
    // Something to say about the push: an offer, why there is none, or what
    // will not be pushed (Task 13 review, M-5).
    if (push.pushable.length > 0 || push.noLeases || push.skipped.length > 0) {
      const offered = after.value;
      restackHost()?.offerPush(offered, () => pushFor(offered));
    }
  }

  async function retryRetarget(): Promise<void> {
    const a = after.value;
    if (!a || a.retarget.state !== "failed") return;
    const rt = await retarget(a.cwd, a.finalized, a.trunk ?? deps.trunkSetting());
    if (after.value === a) after.value = { ...a, retarget: rt };
  }

  /**
   * Deletes the merged parent, a compare-and-swap on the tip the backend
   * verified when it offered the delete (`delete_offer`): a commit added
   * since makes it fail and the branch stays. Throws on failure, offer kept.
   */
  async function deleteMergedParent(): Promise<void> {
    const a = after.value;
    if (!a?.deleteOffer) return;
    const cwd = a.cwd;
    await deps.deleteMergedParent(cwd, a.deleteOffer.branch, a.deleteOffer.tip);
    if (after.value === a) after.value = { ...a, deleteOffer: null };
    await c.refresh(cwd);
  }

  function pushMoved(): Promise<PushResult[]> {
    const a = after.value;
    return a ? pushFor(a) : Promise.resolve([]);
  }

  async function pushFor(a: AfterRestack): Promise<PushResult[]> {
    const cwd = a.cwd;
    const results: PushResult[] = [];
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
    const gen = ++state.flowGen;
    flow.value = { ...idleFlow(), phase: "fetching", cwd, branch };
    const merged = c.layerOf(branch)?.state === "parent_merged";
    let fetched: { success: boolean; message: string };
    try {
      fetched = await deps.fetch(cwd);
    } catch (e) {
      fetched = { success: false, message: message(e) };
    }
    if (gen !== state.flowGen) return;
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
      const plan = await deps.plan(cwd, branch, deps.trunkSetting(), state.lastHints);
      if (gen !== state.flowGen) return;
      // D18, fail closed: the cached report may not have known it was moment 2.
      if (!fetched.success && plan.moment === "parent_merged") {
        flow.value = {
          ...flow.value,
          phase: "refused",
          plan,
          refusal: synthesizedRefusal("fetch_failed", fetched.message),
        };
        return;
      }
      flow.value = plan.refusal
        ? { ...flow.value, phase: "refused", plan, refusal: plan.refusal }
        : { ...flow.value, phase: "preview", plan };
    } catch (e) {
      // "restack X first", "X is merged: restack Y instead", a record still
      // being finalized, a missing parent / lost base: plain errors.
      if (gen !== state.flowGen) return;
      flow.value = { ...flow.value, phase: "error", error: message(e) };
    }
  }

  async function applyRestack(estimated: number): Promise<void> {
    const f = flow.value;
    if (f.phase !== "preview" || !f.plan || !f.cwd) return;
    const { cwd, plan } = f;
    const host = restackHost();
    if (!host) {
      flow.value = { ...f, phase: "error", error: "No restack host registered: the restack cannot be applied." };
      return;
    }
    const gen = state.flowGen;
    const previewed: PreviewedRestack = {
      onto_sha: plan.onto_sha,
      upstream_sha: plan.upstream_sha,
      top_sha: plan.top_sha,
      moving: plan.moving.map((m) => m.branch),
    };
    // Kept before the run: the finalization may land in any later refresh.
    state.lastPlan = { cwd, plan };
    flow.value = { ...f, phase: "applying" };
    let outcome: ApplyOutcome;
    try {
      outcome = await host.apply(cwd, plan, previewed, state.lastHints, estimated);
    } catch (e) {
      if (gen === state.flowGen) flow.value = { ...flow.value, phase: "error", error: message(e) };
      return;
    }
    if (gen !== state.flowGen) {
      // Closed meanwhile: nothing to show, but a clean run must still be
      // finalized, without waiting for the watcher.
      if (outcome.stoppedReason === "clean") await c.refresh(cwd);
      return;
    }
    switch (outcome.stoppedReason) {
      case "clean":
        flow.value = { ...flow.value, phase: "done", outcome };
        await c.refresh(cwd);
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

  function acceptBridge(cwd: string, offer: BridgeOffer): Promise<void> {
    return c.stackOn(cwd, offer.branch, offer.parent);
  }

  return {
    hintsFor,
    onFinalized,
    retryRetarget,
    deleteMergedParent,
    pushMoved,
    startRestack,
    applyRestack,
    acceptBridge,
  };
}
