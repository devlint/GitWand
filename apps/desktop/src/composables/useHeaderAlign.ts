/**
 * useHeaderAlign — vertical position that centers a floating control on the
 * header bar of whatever viewer is mounted inside a container.
 *
 * The Git Tree's WIP diff overlays a close button on the top-right of the
 * file view, but the viewer below it changes (DiffViewer, MergeEditor,
 * FileHistoryViewer, ImageDiffViewer) and each header has its own height —
 * and a banner (e.g. the merge-memory offer) can push it down. A fixed `top`
 * can't line up with all of them, so this measures the live header instead.
 */
import { ref, watch, onUnmounted, type Ref } from "vue";

export function useHeaderAlign(
  container: Ref<HTMLElement | null>,
  headerSelector: string,
  controlHeight: number,
  fallbackTop = 8,
) {
  const top = ref(fallbackTop);

  let headerObserver: ResizeObserver | null = null;
  let treeObserver: MutationObserver | null = null;
  let observedHeader: Element | null = null;

  function measure() {
    const root = container.value;
    const header = root?.querySelector<HTMLElement>(headerSelector) ?? null;
    if (header !== observedHeader) {
      headerObserver?.disconnect();
      observedHeader = header;
      if (header) headerObserver?.observe(header);
    }
    if (!root || !header) {
      top.value = fallbackTop;
      return;
    }
    const offset = header.getBoundingClientRect().top - root.getBoundingClientRect().top;
    top.value = Math.max(0, Math.round(offset + (header.offsetHeight - controlHeight) / 2));
  }

  function teardown() {
    headerObserver?.disconnect();
    treeObserver?.disconnect();
    headerObserver = null;
    treeObserver = null;
    observedHeader = null;
  }

  watch(container, (root) => {
    teardown();
    if (!root) return;
    headerObserver = new ResizeObserver(measure);
    // The viewer is swapped in/out (v-if chain) as the selected file changes;
    // childList on the subtree catches the new header appearing.
    treeObserver = new MutationObserver(measure);
    treeObserver.observe(root, { childList: true, subtree: true });
    measure();
  }, { flush: "post" });

  onUnmounted(teardown);

  return { top };
}
