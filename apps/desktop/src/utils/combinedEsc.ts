/**
 * App's Escape ladder (`onGlobalKeydown`): one Esc closes one thing, the
 * topmost first. The combined diff view is the lowest layer and owns no
 * listener of its own — a document listener would run before App's window
 * one and close the view with the panel above it.
 */
import { isEditableTarget } from "./editableTarget";

export type EscLayer = "commandLog" | "help" | "switchStash" | "stash" | "combined";
const ORDER: EscLayer[] = ["commandLog", "help", "switchStash", "stash", "combined"];

/** The open layer Esc closes, or null. */
export function escLayer(open: Partial<Record<EscLayer, boolean>>): EscLayer | null {
  return ORDER.find((k) => open[k]) ?? null;
}

/** The combined view takes Esc when on screen, not already handled, under no
 *  modal nor open menu (those close on this Esc instead), and not typed in a
 *  field. Any other target takes it — inside the view or not: focus often sits
 *  on the dock button that was just clicked. */
export function combinedEscAllowed(e: KeyboardEvent): boolean {
  if (!document.querySelector(".cmb") || e.defaultPrevented) return false;
  if (document.querySelector('[aria-modal="true"], [role="menu"]')) return false;
  return !isEditableTarget(e.target);
}
