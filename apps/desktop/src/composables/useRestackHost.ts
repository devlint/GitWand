/**
 * v3.14 — the restack host App.vue registers with `registerRestackHost`:
 * how a restack is applied, how its push is offered, how stack errors are
 * shown. Extracted from App.vue so its behaviour is tested (Task 13 review,
 * M-3); App.vue supplies the rebase runner and its toast.
 */
import { useI18n } from "./useI18n";
import type { LocaleKey } from "../locales";
import type { ApplyOutcome } from "./useApplyFromPreview";
import type { PushSkip, RestackHost } from "./useStacks";
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
      const names = (reason: PushSkip["reason"]) =>
        skipped.filter((x) => x.reason === reason).map((x) => x.branch);
      const lines: string[] = [];
      const group = (reason: PushSkip["reason"], key: LocaleKey) => {
        const n = names(reason);
        if (n.length) lines.push(t(key, n.join(", ")));
      };
      group("no_upstream", "stacks.push.skipped");
      group("gone", "stacks.push.skippedGone");
      for (const x of skipped) if (x.reason === "blocked") lines.push(t("stacks.push.skippedReason", x.detail ?? x.branch));
      group("not_in_stack", "stacks.push.notInStack");
      const skippedDetail = lines.length ? lines.join("\n") : null;
      if (pushable.length === 0) {
        // Nothing can be pushed safely: say what was left out (review M-5).
        deps.toast(t("stacks.dialog.done"), skippedDetail, OFFER_MS, { key: PUSH_KEY });
        return;
      }
      // Sticky: the push is offered nowhere else (GitHub QA, a 10 s offer
      // was gone before the user reached it).
      const offer =
        pushable.length === 1 ? t("stacks.push.offerOne") : t("stacks.push.offer", pushable.length);
      deps.toast(offer, skippedDetail, 0, {
        key: PUSH_KEY,
        action: {
          label: t("stacks.push.action"),
          run: () => {
            // The offer is sticky and may come back after a repo switch.
            if (deps.currentCwd() !== after.cwd) {
              deps.toast(t("common.error"), t("stacks.push.repoChanged", after.cwd), 8000);
              return;
            }
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
