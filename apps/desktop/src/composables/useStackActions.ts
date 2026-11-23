/**
 * Branch-row stack actions shared by RepoSidebar and BranchSelector (v3.14):
 * one place that resolves the layer to restack and turns a failed action into
 * a toast (the restack host's notify) instead of an unhandled
 * rejection. State and git calls stay in useStacks.
 */
import { restackHost, useStacks, type BridgeOffer, type Stacks } from "./useStacks";
import { useUndoToast } from "./useUndoToast";

const message = (e: unknown) => String((e as { message?: string })?.message ?? e);

export function createStackActions(stacks: Stacks, notify: (message: string) => void) {
  async function guard(run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (e) {
      notify(message(e));
    }
  }

  return {
    /** Restack the chain `branch` belongs to, from its lowest actionable layer. */
    restackFrom: (cwd: string, branch: string) =>
      guard(async () => {
        const layer = stacks.actionableFor(branch);
        if (layer) await stacks.startRestack(cwd, layer.branch);
      }),
    accept: (cwd: string, offer: BridgeOffer) => guard(() => stacks.acceptBridge(cwd, offer)),
    unstack: (cwd: string, branch: string) => guard(() => stacks.unstack(cwd, branch)),
    /** The after-restack banner's "Delete local …" (force-delete of the merged parent). */
    deleteMergedParent: () => guard(() => stacks.deleteMergedParent()),
    /** The banner's "Preview restack" of `branch` exactly (M-5). */
    preview: (cwd: string, branch: string) => guard(() => stacks.startRestack(cwd, branch)),
    /** The after-restack banner's "Retry retarget" (M-5). */
    retryRetarget: () => guard(() => stacks.retryRetarget()),
  };
}

/**
 * Errors go to the restack host's `notify` (App.vue: the detail toast, which
 * wraps long text); the undo toast only when no host is registered.
 */
export function useStackActions() {
  return createStackActions(useStacks(), (m) => {
    const h = restackHost();
    if (h) h.notify(m);
    else useUndoToast().notify(m);
  });
}
