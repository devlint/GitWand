/**
 * v3.14 — the restack host App.vue registers with `registerRestackHost`:
 * how a restack is applied, how its push is offered, how stack errors are
 * shown. Extracted from App.vue so its behaviour is tested (Task 13 review,
 * M-3); App.vue supplies the rebase runner and its toast.
 */
import { useI18n } from "./useI18n";
import type { ApplyOutcome } from "./useApplyFromPreview";
import type { RestackHost } from "./useStacks";
import type { MergedParentHint, PreviewedRestack, RestackPlan } from "../utils/backend";

export interface RestackToastExtras {
  action?: { label: string; run: () => void };
  key?: string;
}

export interface RestackHostDeps {
  /** The repo open now. */
  currentCwd: () => string | null;
  /** Runs the v3.11 apply with the restack's rebase runner, in the open repo. */
  applyRebase: (
    cwd: string,
    plan: RestackPlan,
    previewed: PreviewedRestack,
    hints: MergedParentHint[],
    estimated: number,
  ) => Promise<ApplyOutcome>;
  /** App.vue's detail toast (`ms = 0`: sticky). */
  toast: (title: string, detail: string | null, ms: number, extras?: RestackToastExtras) => void;
}

const OFFER_MS = 10_000;
const PUSH_KEY = "stack-push";

export function createRestackHost(deps: RestackHostDeps): RestackHost {
  const { t } = useI18n();

  return {
    async apply(cwd, plan, previewed, hints, estimated) {
      // The apply acts on the open repo: never on another one than the plan's.
      if (deps.currentCwd() !== cwd) throw new Error(t("stacks.dialog.repoChanged", cwd));
      return deps.applyRebase(cwd, plan, previewed, hints, estimated);
    },

    // Never pushes by itself: the push runs only from the toast's button (D10).
    offerPush(after, run) {
      const { pushable, skipped, noLeases } = after.push;
      if (noLeases) {
        deps.toast(t("stacks.push.noLeases"), null, OFFER_MS, { key: PUSH_KEY });
        return;
      }
      const skippedDetail = skipped.length ? t("stacks.push.skipped", skipped.join(", ")) : null;
      if (pushable.length === 0) {
        // Nothing can be pushed safely: say what was left out (review M-5).
        deps.toast(t("stacks.dialog.done"), skippedDetail, OFFER_MS, { key: PUSH_KEY });
        return;
      }
      deps.toast(t("stacks.push.offer", pushable.length), skippedDetail, OFFER_MS, {
        key: PUSH_KEY,
        action: {
          label: t("stacks.push.action"),
          run: () => {
            void run().then((results) => {
              const ok = results.filter((r) => r.ok).length;
              const failures = results.filter((r) => !r.ok).map((r) => `${r.branch}: ${r.message}`);
              // A failure stays on screen until dismissed.
              deps.toast(t("stacks.push.done", ok, results.length), failures.join("\n") || null, failures.length ? 0 : 4000);
            });
          },
        },
      });
    },

    notify(message) {
      deps.toast(t("common.error"), message, 8000);
    },
  };
}
