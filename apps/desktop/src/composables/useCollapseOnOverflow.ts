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

/** Sub-pixel rounding makes scrollWidth exceed clientWidth by 1 on a fit. */
const SLACK = 1;

function overflows(el: Element): boolean {
  return el.scrollWidth > el.clientWidth + SLACK;
}

export function useCollapseOnOverflow(target: Ref<HTMLElement | null>, collapsedClass: string) {
  const collapsed = ref<ReadonlySet<string>>(new Set());
  let observer: ResizeObserver | null = null;
  const observed = new WeakSet<Element>();

  function check() {
    const row = target.value;
    if (!row) return;
    const items = Array.from(row.querySelectorAll<HTMLElement>("[data-collapse-key]")).sort(
      (a, b) => Number(a.dataset.collapseOrder) - Number(b.dataset.collapseOrder),
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
    for (const node of [row, ...Array.from(row.children)]) {
      if (observed.has(node)) continue;
      observed.add(node);
      observer.observe(node);
    }
  }

  onMounted(() => {
    if (typeof ResizeObserver === "undefined") return;
    // A collapse resizes the observed children, which re-fires the observer
    // once; the second check reaches the same answer and settles.
    observer = new ResizeObserver(() => check());
    observeAll();
    check();
  });

  onUpdated(observeAll);

  onBeforeUnmount(() => {
    observer?.disconnect();
    observer = null;
  });

  return { collapsed, check };
}
