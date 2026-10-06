import { onScopeDispose, ref, watch, type Ref, type WatchSource } from "vue";

/**
 * Hold a layout width steady against transient dips.
 *
 * Returns a ref that follows `raw` upward immediately but only follows it
 * downward once `raw` has held still for `shrinkDelayMs` while `hold` is false.
 * Every change of `raw` (or `hold`) restarts the countdown, and a shrink that
 * comes due adopts the latest raw value, never a stale one.
 *
 * Built for the commit graph's lane column: a periodic refresh or branch switch
 * briefly reloads only the first page of history (fewer lanes) before pagination
 * fills it back in, and a pagination burst can spike then settle — both read as
 * the column twitching. `hold` is the "a page is loading" signal, during which a
 * shrink is never armed.
 */
export function useStickyWidth(
  raw: WatchSource<number>,
  hold: WatchSource<boolean>,
  shrinkDelayMs: number,
): Ref<number> {
  const readRaw = typeof raw === "function" ? raw : () => raw.value;
  const width = ref(readRaw());
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  watch([raw, hold], ([w, holding]) => {
    clearTimer();
    if (w >= width.value) {
      width.value = w;
      return;
    }
    if (holding) return; // re-armed when `hold` drops
    timer = setTimeout(() => {
      timer = null;
      width.value = readRaw();
    }, shrinkDelayMs);
  });

  onScopeDispose(clearTimer);
  return width;
}
