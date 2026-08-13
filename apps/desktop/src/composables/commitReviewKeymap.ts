/**
 * commitReviewKeymap.ts
 *
 * Task 2 (v3.7.0) — pure keymap resolver for cycling Commit Review findings
 * in the Changes view. Mirrors `usePrReviewKeymap.ts`'s pattern: a pure
 * function from a `KeyboardEvent` + activity context to a discriminated
 * action, no side effects, no Vue state.
 *
 * Unlike `usePrReviewKeymap` (which relies on its host, the PR Diff tab, to
 * focus-guard before ever calling the resolver), this resolver guards
 * `isEditableTarget` itself (decision D6, v3.7.0 plan): the commit summary
 * input and description textarea live in the *same* view as the findings
 * list, so a bare `n`/`p`/`x` must be inert while the user is typing there
 * — the host cannot assume the keydown never originates from an editable
 * field the way the PR Diff tab's host can.
 */
import { isEditableTarget } from "../utils/editableTarget";

export type CommitReviewAction = "next-finding" | "prev-finding" | "dismiss-finding" | "open-findings" | "help";

/**
 * Resolve a keydown into a Commit Review action, or `null` when: the
 * Changes view/findings aren't active (`ctx.active`), any modifier key is
 * held, or the event target is an editable element. Never maps `Escape` or
 * `⌘⇧L` — those stay owned by `App.vue`'s global handlers.
 */
export function resolveCommitReviewShortcut(
  e: KeyboardEvent,
  ctx: { active: boolean },
): CommitReviewAction | null {
  if (!ctx.active) return null;
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
  if (isEditableTarget(e.target)) return null;

  switch (e.key) {
    case "n": return "next-finding";
    case "p": return "prev-finding";
    case "x": return "dismiss-finding";
    case "?": return "help";
    default: return null;
  }
}
