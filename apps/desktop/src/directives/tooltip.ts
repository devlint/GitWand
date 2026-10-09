/**
 * v-tooltip directive — styled app-wide tooltip.
 *
 * Usage:
 *   <button v-tooltip="'Push to remote'">…</button>
 *   <button v-tooltip="{ text: 'Push', position: 'left' }">…</button>
 *   <button v-tooltip="{ text: 'Push', when: (el) => isCompact(el) }">…</button>
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
  /**
   * Evaluated on hover/focus, on resize and on update with the anchor element;
   * the tooltip is skipped (or hidden) while it returns false.
   */
  when?: (el: HTMLElement) => boolean;
}

interface TooltipEl extends HTMLElement {
  _tooltip?: {
    tip: HTMLElement;
    abort: AbortController;
    reposition: () => void;
    opts: TooltipOptions;
  };
  /** Current binding value — refreshed by `updated`, read at show time. */
  _tooltipOpts?: TooltipOptions | null;
  /** Scopes the trigger listeners so they are bound once and removed on unmount. */
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
  if (opts.when && !opts.when(el)) return;

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

  // Position after paint so t.width/height are available. A tip hidden
  // before this frame is already fading out: don't bring it back.
  requestAnimationFrame(() => {
    if (el._tooltip?.tip !== tip) return;
    place(tip, el, pos);
    tip.classList.add("gw-tooltip--visible");
  });

  const abort = new AbortController();
  const { signal } = abort;

  // Keep position fresh on scroll / resize
  const reposition = () => place(tip, el, pos);
  window.addEventListener("scroll", reposition, { signal, passive: true, capture: true });
  // A resize can also flip `when` (e.g. a breakpoint brings the label back).
  const onResize = () => {
    const when = (el._tooltipOpts ?? opts).when;
    if (when && !when(el)) hide(el);
    else reposition();
  };
  window.addEventListener("resize", onResize, { signal, passive: true });

  el._tooltip = { tip, abort, reposition, opts };
}

/** Matches the `.gw-tooltip--leaving` opacity transition in main.css. */
const FADE_OUT_MS = 500;

/**
 * Detach the anchor's tooltip and fade it out; the element is removed once the
 * fade is over. A timer rather than `transitionend`, which never fires when
 * reduced motion turns the transition off.
 */
function hide(el: TooltipEl) {
  if (!el._tooltip) return;
  const { tip, abort } = el._tooltip;
  abort.abort();
  delete el._tooltip;
  tip.classList.remove("gw-tooltip--visible");
  tip.classList.add("gw-tooltip--leaving");
  setTimeout(() => tip.remove(), FADE_OUT_MS);
}

/**
 * Icon-only anchors have no text, so without a native `title` they would have
 * no accessible name: mirror the tooltip text into aria-label for them. An
 * anchor with visible text, or an explicit aria-label, is left alone.
 * Re-evaluated on every update: an anchor that gains text later (an avatar
 * falling back to initials) gets its own name back.
 */
function syncAriaLabel(el: TooltipEl) {
  const text = el._tooltipOpts?.text;
  const iconOnly = !el.textContent?.trim();
  if (el._tooltipOwnsLabel) {
    if (text && iconOnly) {
      el.setAttribute("aria-label", text);
    } else {
      el.removeAttribute("aria-label");
      el._tooltipOwnsLabel = false;
    }
    return;
  }
  if (text && iconOnly && !el.hasAttribute("aria-label")) {
    el.setAttribute("aria-label", text);
    el._tooltipOwnsLabel = true;
  }
}

export const vTooltip = {
  mounted(el: TooltipEl, { value }: { value: unknown }) {
    el._tooltipOpts = getOptions(value);
    syncAriaLabel(el);

    // Bound once; handlers read el._tooltipOpts so `updated` never re-binds.
    const listeners = new AbortController();
    const { signal } = listeners;
    const onShow = () => {
      if (el._tooltipOpts) show(el, el._tooltipOpts);
    };
    const onHide = () => hide(el);
    el.addEventListener("mouseenter", onShow, { signal });
    el.addEventListener("mouseleave", onHide, { signal });
    el.addEventListener("focus",      onShow, { signal });
    el.addEventListener("blur",       onHide, { signal });
    el.addEventListener("click",      onHide, { signal });
    el._tooltipListeners = listeners;
  },

  updated(el: TooltipEl, { value }: { value: unknown }) {
    const opts = getOptions(value);
    el._tooltipOpts = opts;
    syncAriaLabel(el);

    // Parent re-renders fire this constantly (often with an identical value):
    // leave a visible tooltip alone unless its content actually changed.
    const visible = el._tooltip;
    if (!visible) return;
    if (!opts || (opts.when && !opts.when(el))) {
      hide(el);
    } else if (visible.opts.position !== opts.position) {
      show(el, opts);
    } else if (visible.tip.textContent !== opts.text) {
      visible.tip.textContent = opts.text;
      visible.reposition();
    }
  },

  beforeUnmount(el: TooltipEl) {
    hide(el);
    el._tooltipListeners?.abort();
    delete el._tooltipListeners;
    delete el._tooltipOpts;
    if (el._tooltipOwnsLabel) el.removeAttribute("aria-label");
    delete el._tooltipOwnsLabel;
  },
};
