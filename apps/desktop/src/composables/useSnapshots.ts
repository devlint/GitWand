import { ref } from "vue";
import {
  snapshotCreate,
  snapshotList,
  snapshotPrune,
  snapshotRestore,
  type SnapshotMeta,
} from "../utils/backend";

/**
 * Repo snapshots (v3.8 Time Machine).
 *
 * Module-level state, like `useUndoStack`: one repo is active at a time and
 * every consumer (the rewind popover, the Time Machine modal, the undo toast,
 * the global ⌘Z) must see the same list.
 *
 * Capture never throws: a snapshot is a safety net, and failing to lay one
 * down must not block the operation the user asked for. Restore does throw,
 * because there the failure IS the user-facing outcome.
 */

const snapshots = ref<SnapshotMeta[]>([]);
const isLoading = ref(false);
const lastError = ref<string | null>(null);
/** The `pre-restore` snapshot produced by the last restore: the redo target. */
const redoTarget = ref<SnapshotMeta | null>(null);

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function useSnapshots() {
  async function refresh(cwd: string): Promise<void> {
    if (!cwd) return;
    isLoading.value = true;
    try {
      snapshots.value = await snapshotList(cwd);
      lastError.value = null;
    } catch (err) {
      lastError.value = message(err);
    } finally {
      isLoading.value = false;
    }
  }

  async function capture(
    cwd: string,
    kind: SnapshotMeta["kind"],
    label: string,
  ): Promise<SnapshotMeta | null> {
    if (!cwd) return null;
    try {
      const created = await snapshotCreate(cwd, kind, label);
      if (created) {
        // Prepend rather than re-listing: the backend already returned the
        // full record, and a refresh here would sit on the hot path of every
        // destructive operation.
        snapshots.value = [created, ...snapshots.value];
      }
      return created;
    } catch (err) {
      lastError.value = message(err);
      return null;
    }
  }

  async function restore(cwd: string, id: string): Promise<SnapshotMeta> {
    isLoading.value = true;
    try {
      const redo = await snapshotRestore(cwd, id);
      redoTarget.value = redo;
      lastError.value = null;
      await refresh(cwd);
      return redo;
    } catch (err) {
      lastError.value = message(err);
      throw err;
    } finally {
      isLoading.value = false;
    }
  }

  async function prune(cwd: string, maxAgeDays: number, maxCount: number): Promise<number> {
    try {
      const deleted = await snapshotPrune(cwd, maxAgeDays, maxCount);
      if (deleted > 0) await refresh(cwd);
      return deleted;
    } catch (err) {
      lastError.value = message(err);
      return 0;
    }
  }

  return { snapshots, isLoading, lastError, redoTarget, refresh, capture, restore, prune };
}
