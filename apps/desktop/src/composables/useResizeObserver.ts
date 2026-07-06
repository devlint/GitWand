import { watch, type Ref } from "vue";

/**
 * Observe an element held behind a `ref` and run `callback` whenever it resizes.
 *
 * The ref is often `null` at mount time because the element lives behind a
 * `v-if` (a markerless/tree conflict body, a not-yet-loaded commit list, …).
 * Watching the ref — rather than a mount-only attach in `onMounted` — re-observes
 * every time the element (re)appears, so the callback keeps firing on resize for
 * the element's whole lifetime. A mount-only attach silently stops working once
 * the guard flips; that bug was fixed independently in both MergeEditor and
 * CommitGraph before this helper existed.
 *
 * `callback` also runs once synchronously on each attach, since a fresh
 * `ResizeObserver` does not deliver a size until the next frame. Teardown (the
 * previous observer when the ref changes, and the final observer on unmount) is
 * handled by the watcher's `onCleanup`.
 */
export function useResizeObserver(
  elRef: Ref<Element | null | undefined>,
  callback: () => void,
): void {
  watch(
    elRef,
    (el, _old, onCleanup) => {
      if (typeof ResizeObserver === "undefined" || !el) return;
      callback();
      const ro = new ResizeObserver(() => callback());
      ro.observe(el);
      onCleanup(() => ro.disconnect());
    },
    { immediate: true, flush: "post" },
  );
}
