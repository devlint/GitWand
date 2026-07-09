/**
 * useVirtualRows.ts
 *
 * Thin wrapper around `@tanstack/vue-virtual`'s `useVirtualizer`, generalizing
 * the variable-height pattern already used in `CommitLog.vue` (measureElement
 * + a post-declaration `setOptions` watch to avoid a TDZ error when `count`
 * depends on values not yet initialized at the virtualizer's declaration
 * site — see `CommitLog.vue:96-101,466-472`).
 *
 * Consumers own their own row model (`rows: T[]`); this composable only
 * tracks `count` and exposes the virtualizer's items/size/measure helpers.
 */
import { computed, watch, type Ref } from "vue";
import { useVirtualizer } from "@tanstack/vue-virtual";

export interface UseVirtualRowsOptions {
  /** Reactive row count — the virtualizer's `count` option is kept in sync. */
  count: Ref<number>;
  /** Returns the scrollable container element (or null before mount). */
  getScrollElement: () => HTMLElement | null;
  /** Estimated row height before DOM measurement corrects it. */
  estimateSize: (index: number) => number;
  /** Rows rendered outside the visible viewport on each side. Default 8. */
  overscan?: number;
}

export function useVirtualRows(opts: UseVirtualRowsOptions) {
  const virtualizer = useVirtualizer({
    count: opts.count.value,
    getScrollElement: opts.getScrollElement,
    estimateSize: opts.estimateSize,
    // Measure each item's actual DOM height after paint — rows of differing
    // content (multi-line hunks, threads, critique panels) render at their
    // real height instead of the fixed estimate.
    measureElement: (el) => (el as HTMLElement).offsetHeight,
    overscan: opts.overscan ?? 8,
  });

  // Sync `count` after this composable's other reactive dependencies are
  // initialized in the caller — `{ immediate: true }` still fires once on
  // setup, but since `opts.count` is passed in already-constructed (not
  // computed lazily inside here), there is no TDZ risk the way there was
  // for `rows.value.length` in CommitLog.vue's inline declaration.
  watch(
    opts.count,
    (count) => {
      virtualizer.value?.setOptions({
        ...virtualizer.value.options,
        count,
      });
    },
    { immediate: true },
  );

  const virtualItems = computed(() => virtualizer.value?.getVirtualItems() ?? []);
  const totalSize = computed(() => virtualizer.value?.getTotalSize() ?? 0);

  /** Ref callback — attach to each rendered row's root element. */
  function measure(el: Element | null) {
    if (el) virtualizer.value?.measureElement(el);
  }

  return { virtualizer, virtualItems, totalSize, measure };
}
