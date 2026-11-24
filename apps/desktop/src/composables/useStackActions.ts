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
import { defineAsyncComponent, ref, type Component } from "vue";
import { restackHost, useStacks, type BridgeOffer, type Stacks } from "./useStacks";
import { useUndoToast } from "./useUndoToast";

/** Which stack items a local branch's context menu offers. */
export interface StackMenuItems {
  stackOn: boolean;
  unstack: boolean;
  restack: boolean;
}

/**
 * The stack items for local branch `branch`: "Stack on…" when the trunk is
 * known and `branch` is not it, "Unstack" when it is a layer, "Restack…" when its chain has an
 * actionable layer.
 */
export function stackMenuFor(
  stacks: Pick<Stacks, "trunk" | "layerOf" | "actionableFor">,
  branch: string,
): StackMenuItems {
  // No trunk known (no report, no Settings default): fail closed, the
  // branch could be the trunk.
  const trunk = stacks.trunk();
  return {
    stackOn: !!branch && trunk !== null && branch !== trunk,
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

/**
 * The Git Tree menu's three items, bound to the open repository (`currentCwd`):
 * without one they do nothing, so no action ever runs on an empty path.
 */
export function stackMenuHandlers(
  actions: {
    requestStackOn: (cwd: string, branch: string) => void;
    unstack: (cwd: string, branch: string) => unknown;
    restackFrom: (cwd: string, branch: string) => unknown;
  },
  currentCwd: () => string | null,
) {
  const withCwd = (run: (cwd: string, branch: string) => unknown) => (branch: string) => {
    const cwd = currentCwd();
    if (cwd) void run(cwd, branch);
  };
  return {
    stackOn: withCwd(actions.requestStackOn),
    unstack: withCwd(actions.unstack),
    restack: withCwd(actions.restackFrom),
  };
}

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
    /** The open repository changed: a request made in another one is dropped. */
    repoSwitched: (cwd: string | null) => {
      if (stackOnRequest.value && stackOnRequest.value.cwd !== cwd) stackOnRequest.value = null;
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
 * The stack error channel: the restack host's `notify` (App.vue: the detail
 * toast, which wraps long text); the undo toast only when no host is registered.
 */
function notifyStackError(m: string): void {
  const h = restackHost();
  if (h) h.notify(m);
  else useUndoToast().notify(m);
}

export function useStackActions() {
  return createStackActions(useStacks(), notifyStackError);
}

/** Rendered in place of a stack view whose chunk failed to load. */
const NothingView: Component = { render: () => null };

/**
 * A lazy stack view (StackOnHost, StackBranchMenu) whose chunk may fail to
 * load (offline, stale build): `onFail` undoes what asked for it (clears the
 * request or the menu) and the error goes to the stack error channel. The
 * next mount retries the import.
 */
export function lazyStackView(loader: () => Promise<{ default: Component } | Component>, onFail: () => void) {
  return defineAsyncComponent({
    loader: () =>
      loader().catch((e: unknown) => {
        onFail();
        notifyStackError(message(e));
        throw e;
      }),
    errorComponent: NothingView,
  });
}
