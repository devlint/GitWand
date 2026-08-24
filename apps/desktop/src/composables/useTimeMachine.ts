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

  return items.sort((a, b) => b.timestampMs - a.timestampMs || a.key.localeCompare(b.key));
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

  /** ⌘Z — restore the most recent restorable point. */
  async function undoLast(cwd: string): Promise<void> {
    const target = timeline.value.find((i) => i.restorable);
    if (!target) return;
    await restore(cwd, target);
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

  return { timeline, isLoading, lastError, canUndo, canRedo, refresh, restore, undoLast, redo };
}
