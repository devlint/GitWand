/**
 * usePrReviewQueue.ts
 *
 * Bounded, cancellable, visibility-gated execution of the pre-review engine
 * (C3, v3.6.0) over a PR's touched files. Concurrency is 1 by construction
 * (a plain sequential `for`) — each `analyzeOne` call spawns a subprocess,
 * so running several in parallel would fork N CLI processes at once.
 *
 * Visibility gating deliberately does NOT add its own `visibilitychange`
 * listener — the host (`usePrPanel.ts`) already has one driving the 5-min
 * poll; it calls this queue's `resume()` from that same handler instead of
 * wiring a second listener (perf invariant: one listener, not two).
 */
import { ref } from "vue";
import type { GitDiff } from "../utils/backend";
import type { ReviewFinding } from "./usePrPreReview";

export interface RunOptions {
  onFinding: (finding: ReviewFinding) => void;
  signal: AbortSignal;
}

export function usePrReviewQueue() {
  const done = ref(0);
  const total = ref(0);
  const running = ref(false);

  /** Resolvers waiting for `resume()` — one per file currently blocked on
   *  `document.hidden`. Flushed (and cleared) by `resume()`. */
  let resumeResolvers: Array<() => void> = [];

  /** Wake every file paused on `document.hidden`. Safe to call even when
   *  nothing is paused (empty flush). */
  function resume(): void {
    const resolvers = resumeResolvers;
    resumeResolvers = [];
    for (const r of resolvers) r();
  }

  function waitWhileHidden(signal: AbortSignal): Promise<void> {
    if (!document.hidden || signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      resumeResolvers.push(resolve);
      // An abort while paused must also unblock the wait — otherwise a PR
      // switch during a hidden tab would leave the promise dangling forever.
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  /**
   * Sequentially analyze `files` via `analyzeOne`, streaming findings out
   * through `onFinding` as each file completes. Bails immediately once
   * `signal` aborts (PR switch / detail close), and pauses (without
   * consuming CPU) whenever `document.hidden` is true.
   */
  async function run(
    files: GitDiff[],
    analyzeOne: (file: GitDiff) => Promise<ReviewFinding[]>,
    opts: RunOptions,
  ): Promise<void> {
    running.value = true;
    total.value = files.length;
    done.value = 0;
    try {
      for (const file of files) {
        if (opts.signal.aborted) return;
        await waitWhileHidden(opts.signal);
        if (opts.signal.aborted) return;
        const findings = await analyzeOne(file);
        if (opts.signal.aborted) return; // don't paint stale findings post-abort
        for (const finding of findings) opts.onFinding(finding);
        done.value++;
      }
    } finally {
      running.value = false;
    }
  }

  return { done, total, running, run, resume };
}
