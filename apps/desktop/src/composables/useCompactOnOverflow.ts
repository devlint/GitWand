/**
 * useCompactOnOverflow — switch a flex row to a compact layout only when its
 * content really does not fit at full size.
 *
 * A fixed CSS breakpoint can't know how wide the labels are: French labels
 * need ~70px more than English ones, and a long branch name eats into the same
 * room. Instead, each check drops the compact class, asks whether the row or
 * any direct child overflows, and puts the class back if so — synchronously,
 * so the un-compacted layout never paints.
 *
 * Checks run on resize of the row and of its children (branch name, counts and
 * locale all change their widths). Children added later (v-if) are picked up
 * after each render.
 */
import { ref, onMounted, onUpdated, onBeforeUnmount, type Ref } from "vue";

/** Sub-pixel rounding makes scrollWidth exceed clientWidth by 1 on a fit. */
const SLACK = 1;

function overflows(el: HTMLElement): boolean {
  return el.scrollWidth > el.clientWidth + SLACK;
}

export function useCompactOnOverflow(target: Ref<HTMLElement | null>, className: string) {
  const compact = ref(false);
  let observer: ResizeObserver | null = null;
  const observed = new WeakSet<Element>();

  function check() {
    const el = target.value;
    if (!el) return;
    el.classList.remove(className);
    const tooWide =
      overflows(el) || Array.from(el.children).some((c) => overflows(c as HTMLElement));
    el.classList.toggle(className, tooWide);
    compact.value = tooWide;
  }

  function observeAll() {
    const el = target.value;
    if (!el || !observer) return;
    for (const node of [el, ...Array.from(el.children)]) {
      if (observed.has(node)) continue;
      observed.add(node);
      observer.observe(node);
    }
  }

  onMounted(() => {
    if (typeof ResizeObserver === "undefined") return;
    // A class toggle resizes the observed children, which re-fires the
    // observer once; the second check reaches the same answer and settles.
    observer = new ResizeObserver(() => check());
    observeAll();
    check();
  });

  onUpdated(observeAll);

  onBeforeUnmount(() => {
    observer?.disconnect();
    observer = null;
  });

  return { compact, check };
}
