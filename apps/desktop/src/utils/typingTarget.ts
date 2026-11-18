/**
 * A text field, an editable element or the terminal: where keys type, so
 * app shortcuts (and Escape) are left to it.
 */
export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as (HTMLElement & { closest?: (s: string) => Element | null }) | null;
  if (!el || typeof el !== "object") return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable === true ||
    !!el.closest?.(".xterm")
  );
}
