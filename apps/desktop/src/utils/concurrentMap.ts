/** Run async `fn` on each item with at most `limit` concurrent in-flight promises. */
export async function concurrentMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  limit: number,
): Promise<R[]> {
  const results: R[] = [];
  const executing = new Set<Promise<void>>();
  for (let i = 0; i < items.length; i++) {
    const p = fn(items[i]).then((r) => { results[i] = r; });
    // `wrapped` (not `p`) is what's actually in `executing` — the finally
    // callback must delete that same reference, or entries never get
    // removed and the concurrency limit silently degrades after the ramp-up.
    let wrapped: Promise<void>;
    wrapped = p.finally(() => executing.delete(wrapped));
    executing.add(wrapped);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  await Promise.allSettled(executing);
  return results;
}

/**
 * Throttle ad-hoc, scattered call sites (not a known-upfront array) to at most
 * `limit` concurrent in-flight invocations. Complementary to `concurrentMap`,
 * which maps over a list; this is a bare semaphore for call sites that don't
 * fit that shape (e.g. conditional calls nested inside a larger per-item
 * pipeline already running under its own `Promise.all`).
 */
export function createSemaphore(limit: number): { run<T>(fn: () => Promise<T>): Promise<T> } {
  let active = 0;
  const queue: Array<() => void> = [];

  function acquire(): Promise<void> {
    if (active < limit) {
      active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => queue.push(resolve));
  }

  function release(): void {
    active--;
    const next = queue.shift();
    if (next) {
      active++;
      next();
    }
  }

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}
