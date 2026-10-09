/**
 * useCollapseOnOverflow — collapse the items of a flex row one at a time,
 * only as far as needed for the row to fit.
 *
 * Items opt in with `data-collapse-key` (their identity) and
 * `data-collapse-order` (1 collapses first). A fixed CSS breakpoint can't do
 * this: label widths vary by locale (French needs ~70px more than English) and
 * a long branch name eats into the same room.
 *
 * Each check expands every item, then collapses them in order while the row
 * or any direct child still overflows; if even all-collapsed overflows, it
 * switches the row to its wrapped layout (`wrapClass`) and fits again — all
 * synchronously, so no intermediate layout ever paints. `collapsed` and
 * `wrapped` (reactive) hold the last result; bind the classes from them so
 * Vue and the DOM agree.
 *
 * Checks run (on the next frame) on resize of the row, its children and
 * grandchildren (branch name, counts and locale all change their widths).
 * Nodes added later (v-if) are picked up after each render.
 */
import { ref, onMounted, onUpdated, onBeforeUnmount, type Ref } from "vue";

/** Tolerated sub-pixel overshoot on a fit. */
const SLACK = 1;

/**
 * Does an in-flow child stick out past `el`'s content box? Geometry rather than
 * scrollWidth, which would also count an open popover or menu positioned
 * inside `el` and collapse every label while it is open.
 */
function overflows(el: Element): boolean {
  const style = getComputedStyle(el);
  const contentRight =
    el.getBoundingClientRect().right -
    (parseFloat(style.paddingRight) || 0) -
    (parseFloat(style.borderRightWidth) || 0);
  return Array.from(el.children).some((child) => {
    const position = getComputedStyle(child).position;
    if (position === "absolute" || position === "fixed") return false;
    return child.getBoundingClientRect().right > contentRight + SLACK;
  });
}

/** Missing or invalid `data-collapse-order` collapses last, keeping the sort consistent. */
function collapseOrder(el: HTMLElement): number {
  const order = Number(el.dataset.collapseOrder);
  return Number.isFinite(order) ? order : Number.POSITIVE_INFINITY;
}

export interface CollapseOnOverflowOptions {
  /** Class put on each collapsed item. */
  collapsedClass: string;
  /**
   * Class put on the row when collapsing every item still doesn't fit — its
   * CSS should let the row wrap. The items are then measured again in the
   * wrapped layout, where they usually get their labels back.
   */
  wrapClass?: string;
}

export function useCollapseOnOverflow(
  target: Ref<HTMLElement | null>,
  { collapsedClass, wrapClass }: CollapseOnOverflowOptions,
) {
  const collapsed = ref<ReadonlySet<string>>(new Set());
  const wrapped = ref(false);
  let observer: ResizeObserver | null = null;
  let pendingFrame = 0;
  const observed = new Set<Element>();

  function check() {
    const row = target.value;
    if (!row) return;
    const items = Array.from(row.querySelectorAll<HTMLElement>("[data-collapse-key]")).sort(
      (a, b) => collapseOrder(a) - collapseOrder(b),
    );
    const tooWide = () => overflows(row) || Array.from(row.children).some(overflows);

    /** Expand everything, then collapse in order until the row fits. */
    const fit = (wrap: boolean) => {
      if (wrapClass) row.classList.toggle(wrapClass, wrap);
      for (const item of items) item.classList.remove(collapsedClass);
      const keys = new Set<string>();
      for (const item of items) {
        if (!tooWide()) break;
        item.classList.add(collapsedClass);
        keys.add(item.dataset.collapseKey!);
      }
      return keys;
    };

    let keys = fit(false);
    const wrap = !!wrapClass && tooWide();
    if (wrap) keys = fit(true);

    const prev = collapsed.value;
    if (keys.size !== prev.size || [...keys].some((k) => !prev.has(k))) collapsed.value = keys;
    wrapped.value = wrap;
  }

  function observeAll() {
    const row = target.value;
    if (!row || !observer) return;
    // Grandchildren too: a child whose width is fixed by the layout (wrapped
    // actions at flex-basis 100%, a shrunk group) doesn't resize when its
    // content grows — e.g. labels lengthening once a locale chunk loads.
    const children = Array.from(row.children);
    const current = new Set<Element>([
      row,
      ...children,
      ...children.flatMap((child) => Array.from(child.children)),
    ]);
    // Nodes removed by a v-if would otherwise stay observed (and alive).
    for (const node of observed) {
      if (current.has(node)) continue;
      observer.unobserve(node);
      observed.delete(node);
    }
    for (const node of current) {
      if (observed.has(node)) continue;
      observed.add(node);
      observer.observe(node);
    }
  }

  onMounted(() => {
    if (typeof ResizeObserver === "undefined") return;
    // Deferred to the next frame: a check run inside the callback resizes the
    // row (wrap) and sibling children, which the browser can't deliver in the
    // same pass and reports as a "ResizeObserver loop" error. The follow-up
    // notification then finds the same answer and settles.
    observer = new ResizeObserver(() => {
      if (pendingFrame) return;
      pendingFrame = requestAnimationFrame(() => {
        pendingFrame = 0;
        check();
      });
    });
    observeAll();
    check();
  });

  onUpdated(observeAll);

  onBeforeUnmount(() => {
    observer?.disconnect();
    observer = null;
    observed.clear();
    if (pendingFrame) cancelAnimationFrame(pendingFrame);
    pendingFrame = 0;
  });

  return { collapsed, wrapped, check };
}
