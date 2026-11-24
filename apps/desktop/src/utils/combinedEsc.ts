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

/** The combined view takes Esc only when on screen, from itself or the bare
 *  page, not typed in a field, not already handled, and under no modal. */
export function combinedEscAllowed(e: KeyboardEvent): boolean {
  const v = document.querySelector(".cmb");
  if (!v || e.defaultPrevented || document.querySelector('[aria-modal="true"]')) return false;
  const el = e.target as Element | null;
  if (!el || el.nodeType !== 1 || el === document.body || el === document.documentElement) return true;
  return !isEditableTarget(el) && v.contains(el);
}
