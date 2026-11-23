/**
 * Branch-row stack actions shared by the Git Tree, BranchSelector and the
 * stack banner (v3.14): one place that resolves the layer to restack and turns
 * a failed action into a toast (the restack host's notify) instead of an
 * unhandled rejection. State and git calls stay in useStacks.
 *
 * It also owns the "Stack on…" request: both branch menus only set
 * `stackOnRequest`, and the single StackOnDialog host (StackOnHost, mounted by
 * App.vue) opens the dialog from it.
 */
import { ref } from "vue";
import { restackHost, useStacks, type BridgeOffer, type Stacks } from "./useStacks";
import { useUndoToast } from "./useUndoToast";

/** Which stack items a local branch's context menu offers. */
export interface StackMenuItems {
  stackOn: boolean;
  unstack: boolean;
  restack: boolean;
}

/**
 * The stack items for local branch `branch`: "Stack on…" unless it is the
 * trunk, "Unstack" when it is a layer, "Restack…" when its chain has an
 * actionable layer.
 */
export function stackMenuFor(
  stacks: Pick<Stacks, "report" | "layerOf" | "actionableFor">,
  branch: string,
): StackMenuItems {
  return {
    stackOn: !!branch && branch !== stacks.report.value?.trunk,
    unstack: !!stacks.layerOf(branch),
    restack: !!stacks.actionableFor(branch),
  };
}

export interface StackOnRequest {
  cwd: string;
  branch: string;
}

/** The pending "Stack on…" request (module state: one dialog for every entry point). */
const stackOnRequest = ref<StackOnRequest | null>(null);

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
    stackOnRequest,
    /** Open the "Stack on…" dialog for `branch` (hosted once, by StackOnHost). */
    requestStackOn: (cwd: string, branch: string) => {
      stackOnRequest.value = { cwd, branch };
    },
    closeStackOn: () => {
      stackOnRequest.value = null;
    },
    /** The stack items of `branch`'s context menu. */
    menuFor: (branch: string) => stackMenuFor(stacks, branch),
    /** Restack the chain `branch` belongs to, from its lowest actionable layer. */
    restackFrom: (cwd: string, branch: string) =>
      guard(async () => {
        const layer = stacks.actionableFor(branch);
        if (layer) await stacks.startRestack(cwd, layer.branch);
      }),
    accept: (cwd: string, offer: BridgeOffer) => guard(() => stacks.acceptBridge(cwd, offer)),
    unstack: (cwd: string, branch: string) => guard(() => stacks.unstack(cwd, branch)),
    /** The after-restack banner's "Delete local …" (compare-and-swap delete of the merged parent). */
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
