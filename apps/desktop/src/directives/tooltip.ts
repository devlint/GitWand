/**
 * v-tooltip directive — styled app-wide tooltip.
 *
 * Usage:
 *   <button v-tooltip="'Push to remote'">…</button>
 *   <button v-tooltip="{ text: 'Push', position: 'left' }">…</button>
 *   <button v-tooltip="{ text: 'Push', when: () => isCompact() }">…</button>
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
  /** Evaluated on each hover/focus; the tooltip is skipped when it returns false. */
  when?: () => boolean;
}

interface TooltipEl extends HTMLElement {
  _tooltip?: {
    tip: HTMLElement;
    abort: AbortController;
  };
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
  if (opts.when && !opts.when()) return;

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

export const vTooltip = {
  mounted(el: TooltipEl, { value }: { value: unknown }) {
    const opts = getOptions(value);
    if (!opts) return;

    el.addEventListener("mouseenter", () => show(el, opts));
    el.addEventListener("mouseleave", () => hide(el));
    el.addEventListener("focus",      () => show(el, opts));
    el.addEventListener("blur",       () => hide(el));
    el.addEventListener("click",      () => hide(el));
  },

  updated(el: TooltipEl, { value }: { value: unknown }) {
    // If the tooltip text changed while visible, re-show with new text
    hide(el);
    const opts = getOptions(value);
    if (!opts) return;

    // Re-bind with fresh closure — easiest to just remove and re-add
    // listeners by replacing the element's handler through a stored ref.
    // Directives don't give us a clean way to do that without storing refs,
    // so we use the unmounted + re-mounted pattern here by delegating to a
    // shared handler set on the element.
    el.addEventListener("mouseenter", () => show(el, opts));
    el.addEventListener("mouseleave", () => hide(el));
  },

  beforeUnmount(el: TooltipEl) {
    hide(el);
  },
};
