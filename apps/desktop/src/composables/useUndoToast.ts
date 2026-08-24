import { ref } from "vue";

/**
 * The single-slot undo offer shown after a destructive operation (v3.8).
 *
 * Single-slot on purpose: two destructive operations in a row must not stack
 * two toasts the user has to dismiss. The newest offer replaces the previous
 * one.
 *
 * The offer carries the id of the snapshot its operation actually created,
 * so the button rewinds THAT point. Falling back to "the most recent
 * restorable point at click time" makes the label and the action disagree:
 * a commit made inside the 8s window is newer, so an offer reading
 * "1 file discarded" would undo the commit instead. Without an id (snapshots
 * off, or the backend took none) the button falls back to ⌘Z's behaviour.
 */

export interface UndoOffer {
  /** Fresh per offer, so the component re-runs its entrance animation even
   *  when the same message is shown twice in a row. */
  id: number;
  message: string;
  /** The point this offer rewinds to, or null to fall back to ⌘Z. */
  snapshotId: string | null;
}

/** How long an offer stays on screen. Long enough to read and react to,
 *  short enough not to linger over the next action. */
const TIMEOUT_MS = 8_000;

const offer = ref<UndoOffer | null>(null);
let counter = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

export function useUndoToast() {
  function dismiss(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    offer.value = null;
  }

  function show(message: string, snapshotId?: string | null): void {
    if (timer !== null) clearTimeout(timer);
    counter += 1;
    offer.value = { id: counter, message, snapshotId: snapshotId ?? null };
    timer = setTimeout(() => {
      offer.value = null;
      timer = null;
    }, TIMEOUT_MS);
  }

  return { offer, show, dismiss };
}
