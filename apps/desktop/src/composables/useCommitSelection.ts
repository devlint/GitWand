/**
 * Multi-selection of commits in the Git Tree, for the combined diff (v3.15).
 *
 * The state is module-scoped and keyed by repo path: the graph is unmounted
 * while a full-screen diff is shown, and the selection must survive that.
 * `selected` is in selection order; the graph sorts it by row order.
 */
import { computed, reactive, type ComputedRef, type Ref } from "vue";

export const COMBINE_MAX = 50;

interface SelectionState {
  list: string[];
  anchor: string | null;
}

const states = reactive<Record<string, SelectionState>>({});

function stateFor(path: string): SelectionState {
  return (states[path] ??= { list: [], anchor: null });
}

export function useCommitSelection(repoPath: Ref<string>): {
  selected: ComputedRef<string[]>;
  anchor: ComputedRef<string | null>;
  toggle(hash: string, current: string | null): void;
  range(hash: string, visibleOrder: string[], current?: string | null): void;
  clear(): void;
  canCombine: ComputedRef<boolean>;
} {
  const selected = computed(() => states[repoPath.value]?.list ?? []);
  const anchor = computed(() => states[repoPath.value]?.anchor ?? null);
  const canCombine = computed(
    () => selected.value.length >= 2 && selected.value.length <= COMBINE_MAX,
  );

  /** `current` (the plain-clicked commit) becomes the first member on the first toggle. */
  function toggle(hash: string, current: string | null) {
    const s = stateFor(repoPath.value);
    if (s.list.length === 0 && current) s.list.push(current);
    const i = s.list.indexOf(hash);
    if (i >= 0) {
      s.list.splice(i, 1);
      if (s.anchor === hash) s.anchor = s.list[s.list.length - 1] ?? null;
    } else {
      s.list.push(hash);
      s.anchor = hash;
    }
  }

  /** Select anchor..hash inclusive, in `visibleOrder` (rows the graph currently lists). */
  function range(hash: string, visibleOrder: string[], current: string | null = null) {
    const to = visibleOrder.indexOf(hash);
    if (to < 0) return;
    const s = stateFor(repoPath.value);
    const from = visibleOrder.indexOf(s.anchor ?? current ?? "");
    const [a, b] = from < 0 ? [to, to] : [Math.min(from, to), Math.max(from, to)];
    s.list = visibleOrder.slice(a, b + 1);
    if (s.anchor === null) s.anchor = from < 0 ? hash : visibleOrder[from];
  }

  function clear() {
    const s = states[repoPath.value];
    if (!s) return;
    s.list = [];
    s.anchor = null;
  }

  return { selected, anchor, toggle, range, clear, canCombine };
}
