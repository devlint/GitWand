/**
 * usePrReviewKeymap.ts
 *
 * Pure GitHub-standard keymap resolver for the PR review Diff tab (B1,
 * v3.6.0). Mirrors `resolveTerminalShortcut` (`useTerminalSessions.ts`):
 * a pure function from a `KeyboardEvent` + focus context to a discriminated
 * action, with no side effects and no Vue state — the host (`PrDetailView.vue`)
 * owns the listener and dispatches.
 */

import { isEditableTarget } from "../utils/editableTarget";

// Task 0 (v3.7.0) — `isEditableTarget` now lives in `utils/editableTarget.ts`
// (no Vue, no PR-review coupling). Re-exported here verbatim — existing
// tests (`usePrReviewKeymap.test.ts`) import it from this module unmodified.
export { isEditableTarget };

export type PrReviewAction =
  | "next-hunk"
  | "prev-hunk"
  | "next-file"
  | "prev-file"
  | "toggle-viewed"
  | "toggle-hide-viewed"
  | "filter-files"
  | "comment-hunk"
  | "help"
  | "next-finding"
  | "prev-finding"
  | "submit-review";

/**
 * Resolve a keydown into a PR-review action, or `null` when the key is
 * unmapped, the panel isn't focused, or an unrelated modifier is held.
 * Never maps `Escape` or `⌘⇧L` — those stay owned by `App.vue`'s global
 * handlers, so returning `null` here lets them bubble untouched.
 */
export function resolvePrReviewShortcut(
  e: KeyboardEvent,
  ctx: { focused: boolean },
): PrReviewAction | null {
  if (!ctx.focused) return null;

  const mod = e.metaKey || e.ctrlKey;

  // ⌘Enter / Ctrl+Enter — submit the pending review (B3). Checked before the
  // general modifier bail below since this is the one mapped combo that
  // requires a modifier.
  if (mod && e.key === "Enter") return "submit-review";

  // Every other action is a bare letter/punctuation key — any other
  // modifier (Ctrl+J, Alt+V, …) is noise, not a shortcut.
  if (mod || e.altKey) return null;

  switch (e.key) {
    case "j": return "next-hunk";
    case "J": return "next-file";
    case "k": return "prev-hunk";
    case "K": return "prev-file";
    case "v": return "toggle-viewed";
    case "V": return "toggle-hide-viewed";
    case "t": return "filter-files";
    case "c": return "comment-hunk";
    case "?": return "help";
    case "n": return "next-finding";
    case "p": return "prev-finding";
    default: return null;
  }
}
