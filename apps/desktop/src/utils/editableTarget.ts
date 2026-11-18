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

/** True when `el` is a text input, textarea, select, contenteditable or the
 *  terminal — keymaps and shortcuts must stay inert while the user is typing
 *  there. The one such rule in the app (#301 merged `isTypingTarget` in). */
export function isEditableTarget(el: EventTarget | null): boolean {
  // Duck-typed (not `instanceof HTMLElement`) so plain objects in node tests
  // and elements from other realms are read the same way.
  const e = el as (HTMLElement & { closest?: (s: string) => Element | null }) | null;
  if (!e || typeof e !== "object" || typeof e.tagName !== "string") return false;
  const tag = e.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  // `isContentEditable` computes inherited editability but jsdom doesn't
  // fully implement it — check the attribute directly too so this guard is
  // reliable in both the browser and the test environment.
  if (e.isContentEditable) return true;
  const attr = e.getAttribute?.("contenteditable");
  if (attr === "" || attr === "true") return true;
  // The terminal: its keys go to the shell.
  return !!e.closest?.(".xterm");
}
