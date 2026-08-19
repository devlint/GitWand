/**
 * editableTarget.ts
 *
 * Task 0 (v3.7.0) — `isEditableTarget` lifted verbatim out of
 * `usePrReviewKeymap.ts` (B1, v3.6.0) so any keymap resolver (PR review,
 * commit review, …) can reuse the same "is the user typing here" guard
 * without depending on the PR-review keymap module. Re-exported from
 * `usePrReviewKeymap.ts` for back-compat — its existing tests import it
 * from there unmodified.
 */

/** True when `el` is a text input, textarea, select, or contenteditable —
 *  the keymap must stay completely inert while the user is typing there. */
export function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  // `isContentEditable` computes inherited editability but jsdom doesn't
  // fully implement it — check the attribute directly too so this guard is
  // reliable in both the browser and the test environment.
  if (el.isContentEditable) return true;
  const attr = el.getAttribute("contenteditable");
  if (attr === "" || attr === "true") return true;
  return false;
}
