import { ref } from "vue";

/**
 * The single-slot undo offer shown after a destructive operation (v3.8).
 *
 * Single-slot on purpose: two destructive operations in a row must not stack
 * two toasts the user has to dismiss. The newest offer replaces the previous
 * one, and its "Undo" always means "rewind the most recent restorable point",
 * which is exactly what ⌘Z does.
 *
 * It carries no snapshot id for the same reason: the button and the shortcut
 * run one code path (`useTimeMachine().undoLast`), so the toast stays a pure
 * affordance rather than a second restore mechanism with its own state to
 * keep correct.
 */

export interface UndoOffer {
  /** Fresh per offer, so the component re-runs its entrance animation even
   *  when the same message is shown twice in a row. */
  id: number;
  message: string;
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

  function show(message: string): void {
    if (timer !== null) clearTimeout(timer);
    counter += 1;
    offer.value = { id: counter, message };
    timer = setTimeout(() => {
      offer.value = null;
      timer = null;
    }, TIMEOUT_MS);
  }

  return { offer, show, dismiss };
}
