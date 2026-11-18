/**
 * @file useLineRange.ts
 *
 * Click / Shift+click ranges of rows within one group (a hunk, or one column
 * of a hunk), shared by the commit diff and the PR diff (#301): a pick starts
 * a range, an extend in the same group grows it from the row first picked,
 * an extend anywhere else starts over there.
 */
import { computed, onMounted, onUnmounted, ref, type ComputedRef } from "vue";
import { isTypingTarget } from "../utils/typingTarget";

export interface LineRange {
  group: string;
  /** The row first picked; extends are measured from it. */
  anchor: number;
  /** The row last picked. */
  focus: number;
  lo: number;
  hi: number;
}

export interface LineRangeApi {
  range: ComputedRef<LineRange | null>;
  pick(group: string, idx: number, extend: boolean): void;
  isIn(group: string, idx: number): boolean;
  clear(): void;
}

/**
 * Shift+press on a line number: keep the browser from extending its own text
 * selection over every row in between (the range is ours).
 */
export function preventShiftSelect(e: MouseEvent): void {
  if (e.shiftKey) e.preventDefault();
}

export function useLineRange(opts?: {
  /**
   * Clear on a press outside `keep` (nor on `scrollEl` itself: a press on
   * its scrollbar is scrolling, nor inside a dialog), and on Escape: the
   * topmost thing first — a menu or modal dialog gets it, a field or the
   * terminal keeps it, an overlay that closes on it (marking it handled)
   * keeps it; otherwise it clears the range. The key always goes on.
   */
  dismiss?: { keep: string; scrollEl?: () => HTMLElement | null };
}): LineRangeApi {
  const state = ref<{ group: string; anchor: number; focus: number } | null>(null);

  const range = computed<LineRange | null>(() => {
    const s = state.value;
    if (!s) return null;
    return { ...s, lo: Math.min(s.anchor, s.focus), hi: Math.max(s.anchor, s.focus) };
  });

  function pick(group: string, idx: number, extend: boolean) {
    const s = state.value;
    state.value = extend && s && s.group === group ? { ...s, focus: idx } : { group, anchor: idx, focus: idx };
  }

  function isIn(group: string, idx: number): boolean {
    const r = range.value;
    return !!r && r.group === group && idx >= r.lo && idx <= r.hi;
  }

  function clear() {
    state.value = null;
  }

  const dismiss = opts?.dismiss;
  if (dismiss) {
    const onMousedown = (e: MouseEvent) => {
      if (!state.value) return;
      const target = e.target as Element | null;
      // Its own controls, and a dialog (the issue form opened from it).
      if (target?.closest?.(dismiss.keep) || target?.closest?.('[aria-modal="true"]')) return;
      if (target && target === dismiss.scrollEl?.()) return;
      clear();
    };
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !state.value || e.defaultPrevented) return;
      if (isTypingTarget(e.target)) return;
      if (document.querySelector('[aria-modal="true"], [role="menu"]')) return;
      // Decided once every listener has seen the key: an overlay that closed
      // on it (and marked it handled) keeps the range; otherwise it clears.
      setTimeout(() => {
        if (!e.defaultPrevented) clear();
      }, 0);
    };    onMounted(() => {
      document.addEventListener("mousedown", onMousedown);
      document.addEventListener("keydown", onKeydown);
    });
    onUnmounted(() => {
      document.removeEventListener("mousedown", onMousedown);
      document.removeEventListener("keydown", onKeydown);
    });
  }

  return { range, pick, isIn, clear };
}
