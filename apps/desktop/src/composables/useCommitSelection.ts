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
  /** The first toggle since the last plain click (clear / setAnchor) has
   *  seeded the list with the current commit — never again until the next
   *  plain click, so a commit the user removed does not come back. */
  seeded: boolean;
}

const states = reactive<Record<string, SelectionState>>({});

function stateFor(path: string): SelectionState {
  return (states[path] ??= { list: [], anchor: null, seeded: false });
}

export function useCommitSelection(repoPath: Ref<string>): {
  selected: ComputedRef<string[]>;
  anchor: ComputedRef<string | null>;
  toggle(hash: string, current: string | null): void;
  range(hash: string, visibleOrder: string[], current?: string | null): void;
  clear(): void;
  /** Make `hash` the range anchor (the last plain click). */
  setAnchor(hash: string | null): void;
  /** Drop selected hashes that are not in `existing` (they left the loaded log). */
  prune(existing: Iterable<string>): void;
  canCombine: ComputedRef<boolean>;
} {
  const selected = computed(() => states[repoPath.value]?.list ?? []);
  const anchor = computed(() => states[repoPath.value]?.anchor ?? null);
  const canCombine = computed(
    () => selected.value.length >= 2 && selected.value.length <= COMBINE_MAX,
  );

  /** `current` (the plain-clicked commit) becomes the first member on the
   *  first toggle after a plain click. */
  function toggle(hash: string, current: string | null) {
    const s = stateFor(repoPath.value);
    if (!s.seeded && s.list.length === 0 && current) s.list.push(current);
    s.seeded = true;
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
    // A stale anchor (gone from the visible rows) falls back to the current commit.
    let from = visibleOrder.indexOf(s.anchor ?? "");
    if (from < 0) from = visibleOrder.indexOf(current ?? "");
    const [a, b] = from < 0 ? [to, to] : [Math.min(from, to), Math.max(from, to)];
    s.list = visibleOrder.slice(a, b + 1);
    s.seeded = true;
    s.anchor = visibleOrder[from < 0 ? to : from];
  }

  function clear() {
    const s = states[repoPath.value];
    if (!s) return;
    s.list = [];
    s.anchor = null;
    s.seeded = false;
  }

  function setAnchor(hash: string | null) {
    const s = stateFor(repoPath.value);
    s.anchor = hash;
    s.seeded = false;
  }

  function prune(existing: Iterable<string>) {
    const s = states[repoPath.value];
    if (!s) return;
    const keep = new Set(existing);
    const next = s.list.filter((h) => keep.has(h));
    if (next.length !== s.list.length) s.list = next;
    if (s.anchor !== null && !keep.has(s.anchor)) s.anchor = null;
  }

  return { selected, anchor, toggle, range, clear, setAnchor, prune, canCombine };
}
