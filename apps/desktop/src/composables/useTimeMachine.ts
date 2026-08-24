import { computed, ref } from "vue";
import { useSnapshots } from "./useSnapshots";
import { useUndoStack, type UndoEntry } from "./useUndoStack";
import type { SnapshotMeta } from "../utils/backend";

/**
 * The Time Machine timeline (v3.8) — one chronological view over two
 * sources: GitWand's own snapshots (working tree, index, conflict stages)
 * and git's reflog (ref moves).
 *
 * They overlap: a hard reset writes a reflog line AND a snapshot. The
 * snapshot wins, because it restores strictly more.
 */

export interface TimelineItem {
  /** Stable v-for key, also the restore handle. */
  key: string;
  source: "snapshot" | "reflog";
  kind: string;
  label: string;
  timestampMs: number;
  /** Whether this point can be restored to. */
  restorable: boolean;
  snapshot?: SnapshotMeta;
  reflog?: UndoEntry;
}

/** Reflog op types that `useUndoStack` can actually undo. */
const UNDOABLE_REFLOG = new Set(["commit", "amend", "merge", "cherry-pick", "rebase", "pull"]);

/**
 * Reflog types a snapshot of the same moment supersedes. A discard maps onto
 * "checkout" because `git checkout -- <path>` is what a discard runs.
 */
const SNAPSHOT_SUPERSEDES: Record<string, string> = {
  reset: "reset",
  checkout: "checkout",
  discard: "checkout",
};

/** How close in time a snapshot and a reflog line must be to count as one op. */
const DEDUPE_WINDOW_MS = 2_000;

/**
 * Merge both sources into one newest-first list. Pure, so it can be tested
 * without any backend.
 */
export function toTimeline(snapshots: SnapshotMeta[], reflog: UndoEntry[]): TimelineItem[] {
  const items: TimelineItem[] = [];

  for (const s of snapshots) {
    // `pre-restore` snapshots exist only to make a restore undoable; showing
    // them would double every entry the moment the user rewinds once.
    if (s.kind === "pre-restore") continue;
    items.push({
      key: `snapshot:${s.id}`,
      source: "snapshot",
      kind: s.kind,
      label: s.label,
      timestampMs: s.timestampMs,
      restorable: true,
      snapshot: s,
    });
  }

  for (const r of reflog) {
    // A bare `git update-ref` writes a reflog line with an empty subject, and
    // a row with nothing in it tells the user nothing. GitWand labels its own
    // ref moves (see `restore_snapshot_inner`); this guards the rest.
    if (!r.summary.trim()) continue;
    const covered = items.some(
      (i) =>
        i.source === "snapshot" &&
        SNAPSHOT_SUPERSEDES[i.kind] === r.type &&
        Math.abs(i.timestampMs - r.timestampMs) <= DEDUPE_WINDOW_MS,
    );
    if (covered) continue;
    items.push({
      key: `reflog:${r.hash}`,
      source: "reflog",
      kind: r.type,
      label: r.summary,
      timestampMs: r.timestampMs,
      restorable: UNDOABLE_REFLOG.has(r.type) && !!r.prevHash,
      reflog: r,
    });
  }

  return items.sort(compareNewestFirst);
}

/**
 * Newest first, with a tie-break that matters more than it looks.
 *
 * `git reflog` reports whole seconds, so two commits made in the same second
 * tie on `timestampMs`. Falling back to the key string sorted them
 * alphabetically, which put the OLDER commit first (caught in manual QA).
 * Each source knows its own order, so use it:
 *
 * - reflog vs reflog: the reflog index, where 0 is the most recent entry.
 * - snapshot vs snapshot: the id, which `stamp_ms()` keeps monotonic.
 * - snapshot vs reflog: the snapshot first, since it restores strictly more.
 */
function compareNewestFirst(a: TimelineItem, b: TimelineItem): number {
  if (a.timestampMs !== b.timestampMs) return b.timestampMs - a.timestampMs;
  if (a.reflog && b.reflog) return a.reflog.index - b.reflog.index;
  if (a.snapshot && b.snapshot) return b.snapshot.id.localeCompare(a.snapshot.id);
  return a.source === "snapshot" ? -1 : 1;
}

const isLoading = ref(false);
const lastError = ref<string | null>(null);

export function useTimeMachine() {
  const snaps = useSnapshots();
  const undoStack = useUndoStack();

  const timeline = computed(() => toTimeline(snaps.snapshots.value, undoStack.entries.value));

  const canUndo = computed(() => timeline.value.some((i) => i.restorable));
  const canRedo = computed(() => snaps.redoTarget.value !== null);

  async function refresh(cwd: string): Promise<void> {
    if (!cwd) return;
    isLoading.value = true;
    try {
      await Promise.all([snaps.refresh(cwd), undoStack.refresh(cwd)]);
      lastError.value = snaps.lastError.value ?? undoStack.lastError.value;
    } finally {
      isLoading.value = false;
    }
  }

  /** Restore to a specific point. Throws so the caller can surface a modal. */
  async function restore(cwd: string, item: TimelineItem): Promise<void> {
    if (!item.restorable) return;
    if (item.source === "snapshot" && item.snapshot) {
      await snaps.restore(cwd, item.snapshot.id);
    } else if (item.reflog) {
      await undoStack.undo(cwd, item.reflog);
      // The reflog path leaves no snapshot behind, so there is nothing to
      // redo from: clearing this is what keeps ⇧⌘Z honest.
      snaps.redoTarget.value = null;
    }
    await refresh(cwd);
  }

  /**
   * ⌘Z — restore the most recent restorable point. Returns whether it did
   * anything, so the caller can tell "restored" from "nothing to undo".
   *
   * Refreshes FIRST, and that is the whole point: discard / reset / checkout
   * create their snapshot in Rust, never through `capture()`, so the cached
   * list is stale right after the one operation ⌘Z exists to undo. Without
   * this, the shortcut answered "nothing to undo" unless the user had opened
   * the rewind popover at some earlier moment (caught in manual QA).
   */
  async function undoLast(cwd: string): Promise<boolean> {
    if (!cwd) return false;
    await refresh(cwd);
    const target = timeline.value.find((i) => i.restorable);
    if (!target) return false;
    await restore(cwd, target);
    return true;
  }

  /**
   * Restore one specific snapshot by id, for callers that already know which
   * point they mean — the undo toast knows the snapshot its own operation
   * created, and must not drift onto whatever happens to be newest by the
   * time the user clicks.
   *
   * Refuses once HEAD has moved past the snapshot. Restoring rewinds the
   * branch to the HEAD the snapshot recorded, so a commit made afterwards
   * would go with it. The Time Machine can do that: it asks first. A toast
   * cannot — it is one click, no confirmation, and the label only ever
   * promised to undo the small thing it names.
   */
  async function restoreSnapshotById(
    cwd: string,
    id: string,
  ): Promise<"restored" | "moved" | "missing"> {
    if (!cwd || !id) return "missing";
    await refresh(cwd);
    const target = snaps.snapshots.value.find((s) => s.id === id);
    if (!target) return "missing";

    // The reflog's newest entry is where HEAD is now. It carries git's short
    // hash, hence the prefix test against the snapshot's full sha.
    const head = undoStack.entries.value[0];
    if (head && head.hash && !target.headSha.startsWith(head.hash)) return "moved";

    await snaps.restore(cwd, id);
    await refresh(cwd);
    return "restored";
  }

  /** ⇧⌘Z — go back to where the last restore started from. */
  async function redo(cwd: string): Promise<void> {
    const target = snaps.redoTarget.value;
    if (!target) return;
    await snaps.restore(cwd, target.id);
    // `snaps.restore` set a new redoTarget (the pre-restore of this redo),
    // which is exactly the point a second ⇧⌘Z must NOT jump to.
    snaps.redoTarget.value = null;
    await refresh(cwd);
  }

  return {
    timeline,
    isLoading,
    lastError,
    canUndo,
    canRedo,
    refresh,
    restore,
    restoreSnapshotById,
    undoLast,
    redo,
  };
}
