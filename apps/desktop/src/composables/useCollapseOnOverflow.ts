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
 * or any direct child still overflows — synchronously, so no intermediate
 * layout ever paints. `collapsed` (reactive) holds the keys collapsed by the
 * last check; bind the collapsed class from it so Vue and the DOM agree.
 *
 * Checks run on resize of the row and of its children (branch name, counts and
 * locale all change their widths). Children added later (v-if) are picked up
 * after each render.
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

export function useCollapseOnOverflow(target: Ref<HTMLElement | null>, collapsedClass: string) {
  const collapsed = ref<ReadonlySet<string>>(new Set());
  let observer: ResizeObserver | null = null;
  const observed = new Set<Element>();

  function check() {
    const row = target.value;
    if (!row) return;
    const items = Array.from(row.querySelectorAll<HTMLElement>("[data-collapse-key]")).sort(
      (a, b) => collapseOrder(a) - collapseOrder(b),
    );
    const tooWide = () => overflows(row) || Array.from(row.children).some(overflows);

    for (const item of items) item.classList.remove(collapsedClass);
    const keys = new Set<string>();
    for (const item of items) {
      if (!tooWide()) break;
      item.classList.add(collapsedClass);
      keys.add(item.dataset.collapseKey!);
    }

    const prev = collapsed.value;
    if (keys.size !== prev.size || [...keys].some((k) => !prev.has(k))) collapsed.value = keys;
  }

  function observeAll() {
    const row = target.value;
    if (!row || !observer) return;
    const current = new Set<Element>([row, ...Array.from(row.children)]);
    // Children removed by a v-if would otherwise stay observed (and alive).
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
    // A collapse resizes sibling children within the callback; the browser
    // reports those next frame (raising a benign "ResizeObserver loop" error
    // event, unhandled in this app), where the check reaches the same answer
    // and settles.
    observer = new ResizeObserver(() => check());
    observeAll();
    check();
  });

  onUpdated(observeAll);

  onBeforeUnmount(() => {
    observer?.disconnect();
    observer = null;
    observed.clear();
  });

  return { collapsed, check };
}
