/**
 * usePrReviewKeymap.ts
 *
 * Pure GitHub-standard keymap resolver for the PR review Diff tab (B1,
 * v3.6.0). Mirrors `resolveTerminalShortcut` (`useTerminalSessions.ts`):
 * a pure function from a `KeyboardEvent` + focus context to a discriminated
 * action, with no side effects and no Vue state — the host (`PrDetailView.vue`)
 * owns the listener and dispatches.
 */

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
