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
 * Changes view/findings aren't active (`ctx.active`), meta/ctrl/alt is
 * held, or the event target is an editable element. Never maps `Escape` or
 * `⌘⇧L` — those stay owned by `App.vue`'s global handlers.
 *
 * Note on Shift: only meta/ctrl/alt are rejected up front. Shift is checked
 * per-key below instead, because "?" requires Shift on every standard
 * keyboard layout (it is Shift+/) — a resolver that bails on ANY held
 * modifier including shiftKey would make the "?" case unreachable in
 * practice. `usePrReviewKeymap.ts` has the same shape for the same reason
 * (it maps J/K/V, whose Shift variants are distinct actions).
 */
export function resolveCommitReviewShortcut(
  e: KeyboardEvent,
  ctx: { active: boolean },
): CommitReviewAction | null {
  if (!ctx.active) return null;
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (isEditableTarget(e.target)) return null;

  switch (e.key) {
    case "n": return e.shiftKey ? null : "next-finding";
    case "p": return e.shiftKey ? null : "prev-finding";
    case "x": return e.shiftKey ? null : "dismiss-finding";
    case "?": return "help";
    default: return null;
  }
}
