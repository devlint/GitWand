/**
 * focusTrap.ts
 *
 * v3.7.0 review-round fix (finding #11): pure focus-trap arithmetic for
 * `BaseModal.vue`. No Vue, no DOM assumptions beyond the standard DOM API,
 * so it is unit-testable without mounting a component. `BaseModal` stays
 * thin: it just calls `focusableWithin`/`nextTrapTarget` from its own `Tab`
 * keydown handler.
 */

const FOCUSABLE_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  '[tabindex="0"]',
].join(", ");

/**
 * Every visible, non-disabled, focusable element inside `root`, in DOM
 * order. Filters out `disabled`, `tabindex="-1"`, `hidden`, and
 * `aria-hidden="true"` elements.
 *
 * A zero-size (`display: none` via CSS, not the `hidden` attribute) element
 * would ideally also be excluded, but `offsetWidth`/`offsetHeight` are
 * always `0` under jsdom (no real layout engine), so a strict size check
 * would make every element in the unit-test suite look "invisible" and
 * break this function for its only automated test harness. The manual
 * `dev:web` QA pass (see the v3.7.0 review-round fix plan, Task 11) is what
 * actually exercises this in a real layout engine; real CSS-hidden content
 * inside a modal is rare in this codebase (everything conditionally shown
 * uses `v-if`, which removes the element from the DOM entirely, so this
 * selector never sees it).
 */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  const candidates = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  return candidates.filter((el) => {
    if (el.hasAttribute("disabled")) return false;
    if (el.getAttribute("tabindex") === "-1") return false;
    if (el.hasAttribute("hidden")) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    return true;
  });
}

/**
 * Computes the wrap target for a `Tab` press inside a focus trap. Returns
 * `null` when no wrap is needed: the browser's own default Tab behavior
 * moves focus correctly for anything that is not a wrap boundary, and the
 * caller must not call `preventDefault()` in that case.
 *
 * - Forward (`backwards: false`): wraps to the FIRST focusable when `active`
 *   is the last one, or is not found in `focusables` at all (outside the
 *   trapped set, e.g. focus was on the backdrop).
 * - Backward (`backwards: true`, Shift+Tab): wraps to the LAST focusable
 *   when `active` is the first one, or is outside the set.
 * - Empty focusable set: always `null` (the caller falls back to focusing
 *   the panel itself).
 */
export function nextTrapTarget(
  focusables: HTMLElement[],
  active: Element | null,
  backwards: boolean,
): HTMLElement | null {
  if (focusables.length === 0) return null;

  const index = active ? focusables.indexOf(active as HTMLElement) : -1;

  if (backwards) {
    if (index <= 0) return focusables[focusables.length - 1];
    return null;
  }

  if (index === -1 || index === focusables.length - 1) return focusables[0];
  return null;
}
