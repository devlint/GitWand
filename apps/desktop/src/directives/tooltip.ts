/**
 * v-tooltip directive — styled app-wide tooltip.
 *
 * Usage:
 *   <button v-tooltip="'Push to remote'">…</button>
 *   <button v-tooltip="{ text: 'Push', position: 'left' }">…</button>
 *
 * Positions: "top" (default) | "bottom" | "left" | "right"
 *
 * The tooltip element is appended to document.body so it escapes any
 * overflow:hidden ancestor (modals, scroll containers, etc.).
 * Position is computed from getBoundingClientRect() and updated on
 * scroll/resize via an AbortController-scoped listener.
 */

type TooltipPosition = "top" | "bottom" | "left" | "right";

interface TooltipOptions {
  text: string;
  position?: TooltipPosition;
}

interface TooltipEl extends HTMLElement {
  _tooltip?: {
    tip: HTMLElement;
    abort: AbortController;
  };
  /** Current options, refreshed on every update so listeners never go stale. */
  _tooltipOpts?: TooltipOptions | null;
  /** Aborts the element's own listeners on unmount. */
  _tooltipListeners?: AbortController;
  /** True when the directive set aria-label itself (icon-only anchor). */
  _tooltipOwnsLabel?: boolean;
}

const GAP = 7; // px gap between anchor and tooltip

function getOptions(value: unknown): TooltipOptions | null {
  if (!value) return null;
  if (typeof value === "string") return value.trim() ? { text: value.trim() } : null;
  if (typeof value === "object" && "text" in (value as object)) {
    const o = value as TooltipOptions;
    return o.text?.trim() ? o : null;
  }
  return null;
}

function place(tip: HTMLElement, anchor: HTMLElement, position: TooltipPosition) {
  const a = anchor.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let top = 0;
  let left = 0;

  switch (position) {
    case "bottom":
      top = a.bottom + GAP;
      left = a.left + a.width / 2 - t.width / 2;
      break;
    case "left":
      top = a.top + a.height / 2 - t.height / 2;
      left = a.left - t.width - GAP;
      break;
    case "right":
      top = a.top + a.height / 2 - t.height / 2;
      left = a.right + GAP;
      break;
    default: // top
      top = a.top - t.height - GAP;
      left = a.left + a.width / 2 - t.width / 2;
  }

  // Clamp to viewport with a 4px margin
  left = Math.max(4, Math.min(left, vw - t.width - 4));
  top  = Math.max(4, Math.min(top,  vh - t.height - 4));

  tip.style.top  = `${Math.round(top)}px`;
  tip.style.left = `${Math.round(left)}px`;
}

function show(el: TooltipEl, opts: TooltipOptions) {
  hide(el); // ensure clean state

  const tip = document.createElement("div");
  tip.className = "gw-tooltip";
  tip.textContent = opts.text;
  tip.setAttribute("role", "tooltip");
  document.body.appendChild(tip);

  // Auto-position: below when anchor is in the top half of the viewport,
  // above otherwise. Explicit position= overrides this.
  const autoPos = (): TooltipPosition => {
    const a = el.getBoundingClientRect();
    return a.top < window.innerHeight / 2 ? "bottom" : "top";
  };
  const pos: TooltipPosition = opts.position ?? autoPos();

  // Position after paint so t.width/height are available
  requestAnimationFrame(() => {
    place(tip, el, pos);
    tip.classList.add("gw-tooltip--visible");
  });

  const abort = new AbortController();
  const { signal } = abort;

  // Keep position fresh on scroll / resize
  const reposition = () => place(tip, el, pos);
  window.addEventListener("scroll", reposition, { signal, passive: true, capture: true });
  window.addEventListener("resize", reposition, { signal, passive: true });

  el._tooltip = { tip, abort };
}

function hide(el: TooltipEl) {
  if (!el._tooltip) return;
  const { tip, abort } = el._tooltip;
  abort.abort();
  tip.remove();
  delete el._tooltip;
}

/**
 * Icon-only anchors have no text, so without a native `title` they would have
 * no accessible name: mirror the tooltip text into aria-label for them. An
 * anchor with visible text, or an explicit aria-label, is left alone.
 */
function syncAriaLabel(el: TooltipEl) {
  const text = el._tooltipOpts?.text;
  if (el._tooltipOwnsLabel) {
    if (text) el.setAttribute("aria-label", text);
    else { el.removeAttribute("aria-label"); el._tooltipOwnsLabel = false; }
    return;
  }
  if (text && !el.hasAttribute("aria-label") && !el.textContent?.trim()) {
    el.setAttribute("aria-label", text);
    el._tooltipOwnsLabel = true;
  }
}

export const vTooltip = {
  mounted(el: TooltipEl, { value }: { value: unknown }) {
    el._tooltipOpts = getOptions(value);
    syncAriaLabel(el);

    const listeners = new AbortController();
    const { signal } = listeners;
    const open = () => { if (el._tooltipOpts) show(el, el._tooltipOpts); };
    const close = () => hide(el);
    el.addEventListener("mouseenter", open, { signal });
    el.addEventListener("mouseleave", close, { signal });
    el.addEventListener("focus", open, { signal });
    el.addEventListener("blur", close, { signal });
    el.addEventListener("click", close, { signal });
    el._tooltipListeners = listeners;
  },

  updated(el: TooltipEl, { value, oldValue }: { value: unknown; oldValue: unknown }) {
    el._tooltipOpts = getOptions(value);
    syncAriaLabel(el);
    if (!el._tooltip) return;
    // Visible tooltip: refresh its text, or drop it if the text went away.
    if (!el._tooltipOpts) hide(el);
    else if (value !== oldValue) show(el, el._tooltipOpts);
  },

  beforeUnmount(el: TooltipEl) {
    hide(el);
    el._tooltipListeners?.abort();
  },
};
